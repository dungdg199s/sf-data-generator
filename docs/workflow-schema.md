# Workflow JSON (version 2)

Đây là hợp đồng giữa UI và server. Server validate trong `server/workflow/schema.js`;
khi đổi schema phải cập nhật cả file đó, executor, `shared/`, UI và tài liệu này cùng lúc.
Từ [0003](design/0003-process-mode.md), workflow là **cây các bước** (version 2). Định dạng cũ dạng sơ đồ nối dây
(version 1) vẫn mở và chạy được, xem [Version 1 (cũ) và chuyển đổi](#version-1-cũ-và-chuyển-đổi).

## Cấu trúc

```json
{
  "version": 2,
  "name": "Account + Contact + Task",
  "seed": 42,
  "settings": { "maxRecords": 50000 },
  "steps": [
    {
      "id": "loopAcc",
      "type": "loop",
      "config": { "mode": "fixed", "count": 5, "alias": "i" },
      "slots": {
        "body": [
          {
            "id": "acc",
            "type": "record",
            "config": { "sobject": "Account", "alias": "acc", "count": 1,
              "fields": [{ "name": "Name", "type": "text", "options": { "mode": "company", "unique": true } }] }
          },
          {
            "id": "loopCon",
            "type": "loop",
            "config": { "mode": "range", "min": 1, "max": 4, "alias": "loop2" },
            "slots": {
              "body": [
                {
                  "id": "con",
                  "type": "record",
                  "config": { "sobject": "Contact", "alias": "con",
                    "fields": [
                      { "name": "LastName", "type": "text", "options": { "mode": "lastName" } },
                      { "name": "AccountId", "type": "lookup", "options": { "mode": "current", "ref": "acc" } }
                    ] }
                },
                {
                  "id": "hot",
                  "type": "branch",
                  "config": { "kind": "chance", "probability": 0.3 },
                  "slots": {
                    "true": [
                      {
                        "id": "task",
                        "type": "record",
                        "config": { "sobject": "Task", "alias": "task",
                          "fields": [
                            { "name": "Subject", "type": "template", "options": { "template": "Gọi lại {{con.LastName}}" } },
                            { "name": "WhoId", "type": "lookup", "options": { "mode": "current", "ref": "con" } }
                          ] }
                      }
                    ],
                    "false": []
                  }
                }
              ]
            }
          }
        ]
      }
    }
  ]
}
```

| Khóa | Bắt buộc | Mô tả |
| --- | --- | --- |
| `version` | có | `2` |
| `name` | không | Tên hiển thị |
| `seed` | không | Seed mặc định; tham số `seed` của `/api/run` sẽ ghi đè |
| `settings.maxRecords` | không | Giới hạn bản ghi mỗi lần chạy (trần cứng 200 000) |
| `steps` | có | Dãy bước gốc, chạy từ trên xuống |
| `steps[].id` | có | Duy nhất trong **cả cây**. Là `nodeId` trong lỗi và trong `records[]` |
| `steps[].type` | có | `record`, `loop`, `branch` |
| `steps[].config` | không | Cấu hình của bước (bảng dưới) |
| `steps[].slots` | không | Chỉ cho loại bước có `slots` trong meta. Object `{ <slot key>: [bước…] }`; thiếu slot nghĩa là dãy rỗng |
| `steps[].disabled` | không | `true`: bỏ qua bước này và mọi bước con khi chạy |

Không còn `nodes`, `edges`, `position` và node `start`: thẻ "Bắt đầu" trên UI chỉ là đầu danh sách, không phải một bước.
Bản cũ của app không đọc được file version 2.

## Bước

| `type` | Bước con (`slots`) | `config` |
| --- | --- | --- |
| `record` | – | `sobject` (API name), `alias`, `count` (mặc định 1), `fields[]` |
| `loop` | `body` | `mode`: `fixed` (`count`) hoặc `range` (`min`, `max`); `alias` của biến lặp (mặc định `loop`) |
| `branch` | `true` (Đúng), `false` (Sai) | `kind`: `chance` (`probability`) hoặc `compare` (`left`, `op`, `right`) |

Danh mục nằm ở `server/workflow/nodes.js` và được `GET /api/meta` trả về (`nodeTypes[]`): mỗi loại có `label`,
`category` (`data` hoặc `control`, nhãn nhóm trong `stepCategories`), `description`, `slots` (`key`, `label`, và tùy chọn
`empty` = nhãn nút trong ô rỗng, `hint` = dòng gợi ý dưới nút) và `options`. Thứ tự trong `slots` là thứ tự đọc
(Đúng trước Sai). Option có `summary: true` được dùng cho dòng tóm tắt chung trên thẻ của loại bước không có tóm tắt riêng.

Từ [0005](design/0005-variable-picker.md), mỗi loại bước còn khai báo cách chạy các slot và biến nó cung cấp; phân tích
phạm vi (`analyzeScope` trong `shared/scope.js`) chỉ đọc hai khóa này, không biết riêng về `loop` hay `branch`:

| Khóa | Giá trị | Ý nghĩa |
| --- | --- | --- |
| `flow.kind` | `sequence`; `loop` (`body`: khóa slot lặp lại); `branch` (`alternatives`: các slot loại trừ nhau) | Cách các slot chạy. Loop có thêm hàm `minIterations(config)` (không gửi qua meta; trình duyệt dùng bản trong `shared/scope.js`) |
| `exposes.kind` | `record`: `<tên>.<field>` là field của bản ghi hiện tại; `vars`: `<tên>.<key>` là biến rời | Loại nguồn biến |
| `exposes.name` | `{ key, default?, fallback? }` | Tên trong đường dẫn: `config[key]`, rỗng thì `default`, rồi `id` nếu `fallback: "id"` (Record: `alias` hoặc `id`) |
| `exposes.label` | chuỗi, `{ key }` hoặc `{ fromSource }` | Nhãn nhóm trong bảng chọn biến (Record: sObject; Lặp: "Vòng lặp 1–4 lần") |
| `exposes.visibleIn` | `"downstream"` hoặc `{ "inside": "<slot>" }` | Thấy ở mọi bước chạy sau, hoặc chỉ bên trong slot đó |
| `exposes.members` | `"fields"` (từ `config.fields`), `"select"` (danh sách tên field, cho Query của 0006), mảng cố định, `{ "fromSource": "<option>" }` | Biến con. Member có thể lồng (`members`) |
| `exposes.builtins` | `[{ key, valueType, label }]`, key bắt đầu bằng `$` | Biến có sẵn, ví dụ `$n` của Record |
| `exposes.current` | `last`, `picked`, `none` | `none`: không có bản ghi hiện tại (Query, 0006), `{{q.Field}}` là lỗi |
| `exposes.pool` / `origin` / `lookupParent` / `open` | | Dùng cho Lookup "Ngẫu nhiên"/`pick.from`; `generated` (chưa có Id) hay `org`; có trong ô "Bản ghi cha" không; danh sách field chưa đầy đủ (field lạ chỉ là cảnh báo) |

Option nhận biến khai báo `vars: "template"` (chèn `{{path}}`) hoặc `vars: "path"` (cả ô là một đường dẫn, như `left`).
Option chọn một nguồn có `kind: "ref"` (thêm `accepts`, ví dụ `{ "pool": true }`, nếu không phải mọi bước cha đều hợp).
Validate kiểm tra mọi option có hai khóa này; UI gắn bảng chọn biến theo `vars`.

Field của bước record có dạng `{ "name": "<API name>", "type": "<field type>", "options": { ... } }`;
xem [field-types.md](field-types.md). **Thứ tự field là thứ tự sinh**: `{{this.X}}` và Email theo tên
chỉ thấy các field ở phía trên.

## Ngữ nghĩa khi chạy

- Một dãy bước chạy từ trên xuống. Bước có `disabled: true` bị bỏ qua cùng toàn bộ bước con, và **không** dùng `rng`.
- `record`: mỗi lần chạy qua sinh `count` bản ghi; bản ghi cuối trở thành "bản ghi hiện tại" của alias.
- `loop`: tính số lần N (`range` dùng `rng`, kể cả khi thân rỗng), chạy `slots.body` N lần, rồi đi tiếp bước kế.
  Biến lặp: `{{<alias>.index}}` (từ 1), `{{<alias>.index0}}` (từ 0), `{{<alias>.count}}`. Biến lặp chỉ có hiệu lực trong
  thân; vòng lồng nhau cùng alias thì vòng trong che vòng ngoài (UI tự đặt `loop2`, `loop3`… để tránh).
- `branch`: luôn tính điều kiện (kể cả khi hai nhánh rỗng), chạy `slots.true` hoặc `slots.false`, rồi **đi tiếp bước kế**.
  `chance` chọn nhánh Đúng với xác suất `probability`. `compare` so sánh `left` (một đường dẫn tham chiếu; viết
  `loop.index` hay `{{loop.index}}` đều được) với `right` (giá trị cố định). Nếu cả hai là số thì so theo số, không thì so theo chuỗi.
  Phép so sánh: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `empty`, `notEmpty`, `divisibleBy`.
- Bản ghi đã sinh (`<alias>` hiện tại và danh sách mọi bản ghi của alias) dùng chung cho cả lần chạy; biến lặp theo phạm vi.
- Thứ tự gọi `rng` giống executor version 1, nên workflow v1 chuyển sang v2 sinh đúng dữ liệu cũ với cùng seed, **trừ ở các
  bước bị nhân bản** khi chuyển (xem [Version 1 (cũ) và chuyển đổi](#version-1-cũ-và-chuyển-đổi)): bản sao có trạng thái riêng.
- Giới hạn: `LIMITS` trong `server/workflow/nodes.js` (số bản ghi, số bước đã chạy, `maxDepth = 32` cấp lồng nhau).

### Đường dẫn tham chiếu

| Cú pháp | Giá trị |
| --- | --- |
| `this.Field` | Field đã sinh **phía trên** trong cùng bước (chỉ dùng trong template của bước Record) |
| `this.$n` | Số thứ tự của bản ghi đang sinh: `n` trong `<alias>#n` (đếm theo alias, từ 1) |
| `<alias>.Field` | Field của bản ghi hiện tại của bước record có alias đó. Field kiểu Geolocation có member con: `<alias>.Loc.latitude` |
| `<alias>.$n` | `n` của bản ghi hiện tại của alias đó |
| `<loopAlias>.index` / `.index0` / `.count` | Biến lặp (từ 1 / từ 0 / tổng số lần) |

Template dùng `{{path}}` (regex `\{\{\s*([\w.$]+)\s*\}\}`, khai báo một lần ở `shared/scope.js` và gửi qua
`meta.syntax.templateToken`). Field và biến lặp so khớp **có phân biệt hoa thường**, giống lúc chạy.
Alias của bước record phải là duy nhất trên **cả cây** (kể cả bước đang tắt), không trùng tên biến lặp và không được là `this`.

### Phạm vi biến (`analyzeScope`)

`analyzeScope(workflow, { nodeTypes, fieldTypes })` trong `shared/scope.js` là nguồn sự thật duy nhất cho câu hỏi "biến
này dùng được ở đây không": validate trên server, ô "Bản ghi cha" của Lookup, bảng chọn biến và việc đổi tên trên trình
duyệt đều gọi nó. Kết quả `{ partial, sources, at, refs }`:

- `sources[<id bước>]`: nguồn biến (`kind`, `name`, `label`, `sobject`, `members` kèm `valueType`/`example`, các cờ của `exposes`).
- `at[<id bước>]`: `visible` (gần nhất trước: vòng lặp trong cùng và bước ngay phía trên đứng đầu) và `hidden` kèm `reason`
  và `note` tiếng Việt.
- `refs[]`: mọi tham chiếu trong workflow (`nodeId`, `field`, `option`, `path`, `source`), kèm `code` khi có vấn đề.

Trạng thái của một nguồn tại một bước:

| Trạng thái | Nghĩa | Kết quả validate |
| --- | --- | --- |
| `always` | Nguồn chạy trước, trực tiếp trong một dãy đang bao bước này; biến lặp của vòng lặp bao quanh | Hợp lệ |
| `last` | Nguồn nằm trong thân một Lặp đã chạy xong ở phía trên, và Lặp luôn chạy ≥ 1 lần (`fixed` với `count ≥ 1`, hoặc `range` với `min ≥ 1`). Giá trị là bản ghi của lần lặp cuối (Lookup `random`: một bản ghi bất kỳ đã sinh) | Hợp lệ |
| `maybe` | Nguồn nằm trong một nhánh rẽ, hoặc trong một Lặp có thể chạy 0 lần, ở phía trên | Cảnh báo |
| `after` | Nguồn nằm sau bước này, hoặc chính là bước này | Lỗi |
| `otherBranch` | Nguồn ở nhánh còn lại của một Rẽ nhánh đang bao bước này | Lỗi |
| `outsideLoop` | Biến lặp của một vòng lặp không bao bước này | Lỗi |
| `shadowed` | Biến lặp bị vòng lặp bên trong cùng tên che (tham chiếu trỏ tới vòng trong) | – |
| `disabled` | Nguồn, hoặc một khung bao nó, đang tắt | Lỗi |

Ví dụ: `Lặp{acc}` rồi `con` có `AccountId` = ngẫu nhiên trong các bản ghi của `acc`: `acc` là `last`, hợp lệ.
Bước tắt và bước con của nó không được kiểm tra (nhưng vẫn có `at` và `refs`, để đổi tên vẫn đi theo).

Tham chiếu hỏng là **lỗi** (chặn Xem trước và Insert, HTTP 422 khi chạy), không còn âm thầm ra chuỗi rỗng. `code` của issue:

| `code` | Mức | Khi nào |
| --- | --- | --- |
| `unknownName` | lỗi | Tên không phải alias của bước nào, cũng không phải biến lặp (Lookup: không có bước Record nào có alias đó) |
| `unknownMember` | lỗi | Bước không có field đó; biến lặp không có key đó |
| `wholeRecord` | lỗi | `{{acc}}` không có field |
| `noTraversal` | lỗi | Đi tiếp qua field Lookup (`{{con.AccountId.Name}}`) |
| `after`, `otherBranch`, `outsideLoop`, `disabled` | lỗi | Như bảng trạng thái |
| `thisBelow`, `thisSelf`, `thisUnknown` | lỗi | `this.X` với X nằm dưới field đang sửa, là chính field đó, hoặc không có |
| `thisOutsideRecord` | lỗi | `this` ngoài template của bước Record (ví dụ trong `left`) |
| `selfAlias` | lỗi | Dùng alias của chính bước trong template của nó (phải dùng `this`) |
| `noIdYet` | lỗi | `{{acc.Id}}` với bản ghi được sinh ra (chưa có Id trước khi insert) |
| `noCurrent` | lỗi | Field của nguồn không có bản ghi hiện tại (`current: "none"`, Query của 0006) |
| `maybe` | cảnh báo | Nguồn `maybe` (câu chữ nêu nguyên nhân: nhánh rẽ, hoặc vòng lặp "x" có thể chạy 0 lần; Master-Detail nói thêm cách sửa) |
| `openMember` | cảnh báo | Field lạ của nguồn có `open: true` |
| `unclosed` | cảnh báo | Template có `{{` không thành token, sẽ được giữ nguyên là chữ |
| `wrongSobject` | cảnh báo | Lookup có `referenceTo` (điền khi Import từ org) nhưng bước cha sinh sObject khác |

Câu thông báo đúng như bảng "Thông báo lỗi" của [0005](design/0005-variable-picker.md) (đổi "node" thành "bước").

## Kết quả `/api/run`

```json
{
  "seed": 42,
  "stats": {
    "total": 17,
    "bySobject": { "Account": 5, "Contact": 12 },
    "byStep": {
      "loopAcc": { "runs": 1, "records": 17, "iterations": 5 },
      "acc": { "runs": 5, "records": 5 },
      "hot": { "runs": 12, "records": 4, "true": 4, "false": 8 }
    },
    "durationMs": 4
  },
  "warnings": [{ "message": "...", "nodeId": "x", "field": "slots.body" }],
  "records": [
    { "ref": "acc#1", "sobject": "Account", "alias": "acc", "nodeId": "acc", "fields": { "Name": "Acme Inc" } },
    { "ref": "con#1", "sobject": "Contact", "alias": "con", "nodeId": "con", "fields": { "AccountId": { "$ref": "acc#1" } } }
  ],
  "insert": { "inserted": 17, "failed": 0, "errors": [], "ids": { "acc#1": "001..." } }
}
```

- `stats.byStep[<id>]`: `runs` = số lần chạy qua bước, `records` = số bản ghi sinh ra trong bước (với khung: cả bước con).
  Lặp có thêm `iterations` (tổng số lần lặp), Rẽ nhánh có thêm `true` / `false` (số lần đi mỗi nhánh). Bước tắt và bước
  chưa chạy lần nào không có mục. UI hiện các số này thành chip trên thẻ (`12 bản ghi`, `15 lần lặp`, `Đúng 4 · Sai 8`).
- `insert` chỉ có khi request gửi `target: { "kind": "org", "org": "<alias hoặc username>" }`.

Lỗi validate trả về HTTP 422: `{ "error": "...", "issues": [{ "message", "nodeId", "field" }] }`.
Issue về tham chiếu biến có thêm `code`, `path` (đường dẫn bị lỗi, ví dụ `acc.Nmae`), `option` (khóa option chứa nó, ví dụ
`template`, `left`, `ref`) và có thể có `suggestion: { option, from, to }` (UI hiện nút "Sửa thành {{acc.Name}}").
`POST /api/validate` trả `{ errors, warnings }` cùng dạng; phạm vi biến không gửi kèm vì trình duyệt tự tính bằng `shared/scope.js`.
`nodeId` là id bước. `field` có dạng `alias`, `count`, … cho option của bước; `fields.<Name>` cho field của record;
`slots.<key>` cho một ô bước con (ví dụ `slots.body`: vòng lặp chưa có bước nào). Lỗi không gắn với bước nào thì không
có `nodeId`.

## Version 1 (cũ) và chuyển đổi

Version 1 là **đồ thị**: `nodes[]` (có `position` cho canvas, đúng một node `start`) và
`edges[] = { from, fromPort, to }`. Cổng ra: `start`/`record` → `next`; `loop` → `body`, `done`; `branch` → `true`,
`false`. Mỗi cổng ra nối tối đa một node; một node nhận được nhiều dây (để gộp nhánh).

- **Server** (`POST /api/validate`, `POST /api/run`) vẫn nhận version 1, không thời hạn: workflow được chuyển bằng
  `shared/migrate-v1.js` rồi mới validate/chạy, kèm cảnh báo (không có `nodeId`)
  `Workflow version 1 đã được tự chuyển sang version 2 để chạy. Mở file trong trình soạn rồi bấm Lưu để cập nhật.`
  Mỗi mục trong báo cáo chuyển đổi thành một cảnh báo có `nodeId`. Xem trước luôn chạy được. **Insert** (`target.kind ===
  'org'`) một workflow version 1 mà khi chuyển có bước bị nhân bản hoặc bị cắt (`duplicated`, `truncated`, `tooDeep`) bị
  từ chối với HTTP 422 `{ "error": "Workflow version 1 này phải đổi cấu trúc khi chuyển sang version 2 … bấm Lưu trước khi
  insert. …" }` (không có `issues`): người dùng phải mở file trong trình soạn, xem hộp thoại chuyển đổi rồi lưu bản v2.
- **Trình soạn** chuyển ngay trong trình duyệt khi mở file version 1 hoặc khi autosave cũ (`sfdg.workflow.v1`) còn đó.
  Khóa `sfdg.workflow.v1` không bao giờ bị ghi đè hay xóa; bản mới lưu ở `sfdg.workflow.v2`. Nếu chuyển có thay đổi thì
  có hộp thoại báo cáo với nút **Tải bản gốc (v1)**.

Quy tắc chuyển (`migrateV1(wf, { maxDepth, fieldTypes })` → `{ workflow, report }`; `maxDepth` = `LIMITS.maxDepth`,
`fieldTypes` = `fieldTypes` của `/api/meta`, để biết mặc định của tùy chọn "Giá trị duy nhất"):

1. **Chuẩn hóa node và dây:** nhiều node cùng `id` thì giữ node **sau cùng** (node executor v1 dùng) và ghi vào
   `duplicateIds`; bỏ dây tới/từ node không tồn tại; mỗi cổng giữ dây **sau cùng** (dây executor v1 thực sự chạy);
   cắt dây tạo vòng.
2. **Bước kế:** `start`/`record` → `next`; `loop` → `done`; `branch` → điểm gộp = node đầu tiên trên chuỗi của nhánh
   `true` cũng có trên chuỗi của nhánh `false` (không có thì `null`).
3. **Dựng cây:** `loop` → `slots.body` là chuỗi từ `body`; `branch` → `slots.true` / `slots.false` là chuỗi từ mỗi nhánh tới
   điểm gộp, và điểm gộp thành bước sau khung. Giữ `id`, `config`, `name`, `seed`, `settings`; bỏ `position`. Lặp thiếu
   số lần thì ghi rõ giá trị executor dùng (`count: 0`; chế độ `range`: `min: 1`, `max: 1`). Lồng sâu hơn `maxDepth` thì
   khung ở cấp `maxDepth + 1` để trống, phần bên trong bị bỏ và ghi vào `tooDeep`; validate báo lỗi "lồng nhau quá 32 cấp".
4. **Node được tới từ hai chỗ** (thân Lặp "thoát" ra `done`, nối chéo giữa các nhánh, hai Lặp dùng chung thân): chỗ thứ hai
   nhận một **bản sao** của node và phần đuôi sau nó, id `<id>_2`, alias mới (`con` → `con2`), tham chiếu bên trong bản sao
   đổi theo. Tối đa `2 × số node + 50` bước; phần vượt bị cắt và ghi vào báo cáo.
   Bản sao là bước riêng nên có trạng thái riêng: field "Giá trị duy nhất" và Auto Number đếm riêng ở `c` và `c_2`, nên
   **giá trị duy nhất có thể trùng giữa hai bước**, số tự tăng bắt đầu lại, và (vì số lần thử lại khác) dữ liệu từ đó trở đi
   khác bản cũ với cùng seed. Các field này được ghi vào `uniqueFields` và báo cáo có một dòng riêng, kèm cách sửa.
5. **Node không được nối từ Bắt đầu:** đặt ở cuối `steps`, `disabled: true`.

`report = { duplicated: [{ id, copyId, alias, newAlias, root, uniqueFields? }], disabled: [id], droppedEdges: [{ from, fromPort, to, reason: 'missing' | 'fanout' | 'cycle' }], truncated: [id], duplicateIds: [id], tooDeep: [id] }`.
`root` là `copyId` của bước đầu tiên trong đoạn được sao chép; `describeReport` viết **một dòng cho mỗi đoạn** ("… nhân
thành "c" và "c_2" và N bước phía sau"), cộng một dòng cho mỗi bản sao có `uniqueFields`.
Workflow "có cấu trúc" (gộp sau Rẽ nhánh, gộp lồng nhau, nhánh không nối) chuyển với báo cáo rỗng và sinh bản ghi
**giống hệt từng byte** với cùng seed (`test/migrate.test.js` so với executor v1 được đóng băng trong `test/fixtures/run-v1.js`).
Khi có bước bị nhân bản, dữ liệu giống bản cũ trừ ở các bản sao (như trên) và `nodeId`/`ref` của chúng.
Gọi `migrateV1` với workflow version 2 thì nhận lại nguyên như cũ.
