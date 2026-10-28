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
| `steps[].type` | có | `record`, `query`, `pick`, `loop`, `branch` |
| `steps[].config` | không | Cấu hình của bước (bảng dưới) |
| `steps[].slots` | không | Chỉ cho loại bước có `slots` trong meta. Object `{ <slot key>: [bước…] }`; thiếu slot nghĩa là dãy rỗng |
| `steps[].disabled` | không | `true`: bỏ qua bước này và mọi bước con khi chạy |

Không còn `nodes`, `edges`, `position` và node `start`: thẻ "Bắt đầu" trên UI chỉ là đầu danh sách, không phải một bước.
Bản cũ của app không đọc được file version 2.

## Bước

| `type` | Bước con (`slots`) | `config` |
| --- | --- | --- |
| `record` | – | `sobject` (API name), `alias`, `count` (mặc định 1), `fields[]` |
| `query` ([0006](design/0006-query-pick-nodes.md)) | – | `mode`: `builder` (`sobject`, `fields[]` chuỗi tên field, `where`, `orderBy` mặc định `Id`, `limit` 1–2000 mặc định 200) hoặc `soql` (`soql`); `alias` (tên pool, bắt buộc) |
| `pick` (0006) | – | `from` (alias của pool phía trên), `alias` (bắt buộc), `mode`: `random` \| `unique` \| `sequential`; `filter`: `none` \| `compare` (`filterField`, `filterOp`, `filterValue` nhận `{{…}}`); `onEmpty`: `skip` \| `error` |
| `loop` | `body` | `mode`: `fixed` (`count`), `range` (`min`, `max`) hoặc `each` ([0010](design/0010-lap-theo-ban-ghi.md): `from` = alias của pool Query/Record/Chọn bản ghi phía trên, `itemAlias` = tên bản ghi đang lặp, bắt buộc); `alias` của biến lặp (mặc định `loop`). Thiếu `count` = 0 lần, thiếu `max` = 1. Khóa của chế độ khác bị bỏ qua (không kiểm tra, không xóa) |
| `branch` | `true` (Đúng), `false` (Sai) | `kind`: `chance` (`probability`) hoặc `compare` (`left`, `op`, `right`) |

Danh mục nằm ở `server/workflow/nodes.js` và được `GET /api/meta` trả về (`nodeTypes[]`): mỗi loại có `label`,
`category` (`data` hoặc `control`, nhãn nhóm trong `stepCategories`), `description`, `slots` (`key`, `label`, và tùy chọn
`empty` = nhãn nút trong ô rỗng, `hint` = dòng gợi ý dưới nút) và `options`. Thứ tự trong `slots` là thứ tự đọc
(Đúng trước Sai). Option có `summary: true` được dùng cho dòng tóm tắt chung trên thẻ của loại bước không có tóm tắt riêng.
`default` của option là giá trị bước dùng khi **thiếu** khóa đó (executor, inspector và thẻ đều theo nó); `initial`, nếu có,
là giá trị của bước mới thêm từ UI (Lặp mới chạy 3 lần, `count` mặc định 0). `needsOrg: true` (Query): thẻ hiện "chưa chọn org"
khi chưa chọn org. `/api/meta` còn có `queryPresets` (giá trị builder theo sObject: `User`, `Product2`, `Pricebook2`,
`PricebookEntry`, `RecordType`, `Case`, `Task`, `Event`).

Từ [0005](design/0005-variable-picker.md), mỗi loại bước còn khai báo cách chạy các slot và biến nó cung cấp; phân tích
phạm vi (`analyzeScope` trong `shared/scope.js`) chỉ đọc hai khóa này, không biết riêng về `loop` hay `branch`:

| Khóa | Giá trị | Ý nghĩa |
| --- | --- | --- |
| `flow.kind` | `sequence`; `loop` (`body`: khóa slot lặp lại); `branch` (`alternatives`: các slot loại trừ nhau) | Cách các slot chạy. Loop có thêm hàm `minIterations(config)` (không gửi qua meta; trình duyệt dùng bản trong `shared/scope.js`) |
| `exposes` | một object như các dòng dưới, hoặc **mảng** các object (0010) | Mỗi phần tử là một nguồn. Phần tử có `when` (`{ key, in }`, như `showIf`) chỉ có hiệu lực khi config khớp. Phần tử đầu có id nguồn = id bước; phần tử sau có id `<id bước>#<key>` (Lặp `each`: `<id>#item`) |
| `exposes.kind` | `record`: `<tên>.<field>` là field của bản ghi hiện tại; `vars`: `<tên>.<key>` là biến rời | Loại nguồn biến |
| `exposes.name` | `{ key, default?, fallback? }` | Tên trong đường dẫn: `config[key]`, rỗng thì `default`, rồi `id` nếu `fallback: "id"` (Record: `alias` hoặc `id`) |
| `exposes.label` | chuỗi, `{ key }` hoặc `{ fromSource }` | Nhãn nhóm trong bảng chọn biến (Record: sObject; Lặp: "Vòng lặp 1–4 lần") |
| `exposes.visibleIn` | `"downstream"` hoặc `{ "inside": "<slot>" }` | Thấy ở mọi bước chạy sau, hoặc chỉ bên trong slot đó (biến lặp; bản ghi đang lặp của 0010) |
| `exposes.members` | `"fields"` (từ `config.fields`), `"select"` (danh sách tên field, cho Query của 0006), mảng cố định, `{ "fromSource": "<option>" }` | Biến con. Member có thể lồng (`members`). `fromSource`: field của pool đó; Chọn bản ghi không kế thừa builtin, bản ghi đang lặp kế thừa builtin cấp bản ghi (`$n`), không kế thừa builtin cấp pool (`level: "pool"`, `$count` của Query) |
| `exposes.builtins` | `[{ key, valueType, label, level? }]`, key bắt đầu bằng `$` | Biến có sẵn, ví dụ `$n` của Record |
| `exposes.current` | `last`, `picked`, `item`, `none` | `none`: không có bản ghi hiện tại (Query, 0006), `{{q.Field}}` là lỗi; `item`: bản ghi đang lặp của Lặp `each` (một bản ghi, không phải pool) |
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
- `loop` với `mode: "each"` ([0010](design/0010-lap-theo-ban-ghi.md)): chụp pool `from` **lúc vòng lặp bắt đầu** (Query: các
  dòng; Record: mọi bản ghi của alias đã sinh từ đầu lần chạy tới lúc đó; Chọn bản ghi: mọi bản ghi đã chọn), rồi chạy
  `slots.body` một lần cho mỗi bản ghi, **theo thứ tự của pool** (Query: `ORDER BY`; Record: `acc#1`, `acc#2`…). Bản ghi thêm
  vào pool trong lúc lặp không được lặp. Trong thân, `<itemAlias>` là chính bản ghi đó (Lookup "Bản ghi hiện tại" ra Id thật
  với dòng Query, `{ "$ref": "acc#3" }` với bản ghi đã sinh; `{{acc.Name}}`, `{{acc.$n}}` của bản ghi đã sinh); nó **không**
  được thêm vào pool nào. `count` = số bản ghi của pool. **Không** dùng `rng` (kể cả khi pool hay thân rỗng). Pool rỗng hoặc
  chưa có: 0 lần lặp và **một** cảnh báo gắn `from` cho mỗi bước (`eachEmpty`). Quá `maxCountPerNode` (100 000) bản ghi trong
  một lượt: lỗi gắn `from`. Pool là `from` của một Lặp `each` thì giữ bản ghi đầy đủ (như Chọn bản ghi). Đổi một Lặp `range`
  sang `each` bỏ một lần rút `rng`, nên dữ liệu phía sau đổi theo (chỉnh workflow, không phải lỗi tất định).
- `branch`: luôn tính điều kiện (kể cả khi hai nhánh rỗng), chạy `slots.true` hoặc `slots.false`, rồi **đi tiếp bước kế**.
  `chance` chọn nhánh Đúng với xác suất `probability`. `compare` so sánh `left` (một đường dẫn tham chiếu; viết
  `loop.index` hay `{{loop.index}}` đều được) với `right` (giá trị cố định). Nếu cả hai là số thì so theo số, không thì so theo chuỗi.
  Phép so sánh: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `empty`, `notEmpty`, `divisibleBy`.
- `query` ([0006](design/0006-query-pick-nodes.md)): executor **không** gọi org. Server đọc mọi bước Query đang bật trước
  (theo thứ tự đọc, tuần tự; xem [org-connection.md](org-connection.md#đọc-dữ-liệu-query)) rồi đưa các dòng vào executor.
  Mỗi lần chạy qua, bước gán pool `<alias>` = các dòng (bản ghi `existing` có `id` thật, `ref` = `accs#1`…), **không** có bản
  ghi hiện tại, không sinh bản ghi, không dùng `rng`. Query nằm trong Lặp vẫn chỉ đọc org một lần (có cảnh báo).
  Chưa chọn org khi xem trước: `min(LIMIT, 5)` dòng mẫu tất định (`Id` = `mẫu:accs#1`, `Name` = `Account mẫu 1`, field khác
  `<field> mẫu 1`, `Owner.Name` thành object lồng) kèm cảnh báo.
- `pick`: ứng viên = pool `from` lúc đó (Query: các dòng; Record: mọi bản ghi đã sinh tới lúc đó; Chọn bản ghi: mọi bản ghi
  đã chọn). Lọc `compare`: vế trái là `filterField` của ứng viên (đường dẫn có dấu chấm), vế phải là `filterValue` thay
  `{{…}}` như template; so sánh như Rẽ nhánh. `random` = `rng.pick`; `unique` = không lặp lại trong lần chạy; `sequential`
  = lần lượt, quay vòng, không dùng `rng` (con trỏ riêng theo giá trị lọc). Bản ghi được chọn (chính object trong pool) thành
  bản ghi hiện tại của `alias` và được thêm vào pool `alias`. Không có gì để chọn: `onEmpty: skip` bỏ qua phần còn lại của
  lượt hiện tại (lên tới thân Lặp gần nhất: sang lần lặp sau; ở gốc: dừng lần chạy) và cuối lần chạy có **một** cảnh báo
  ghi số lần bỏ qua; `error` báo lỗi gắn bước.
- Lookup tới bản ghi `existing` (dòng Query, hoặc bản ghi chọn từ Query) cho ra **chuỗi Id thật**; bản ghi sinh ra vẫn là
  `{ "$ref" }`. Lookup `current` vào alias của Query là lỗi (pool không có bản ghi hiện tại).
- Bản ghi đã sinh (`<alias>` hiện tại và danh sách mọi bản ghi của alias) dùng chung cho cả lần chạy; biến lặp theo phạm vi.
  Từ [0004](design/0004-streaming-execution.md), "danh sách" của một alias Record chỉ là **số đếm** (`alias#1…alias#n`),
  trừ khi một bước đọc cả bản ghi của pool đó (option bước `kind: "ref"` có `accepts.pool`: Chọn bản ghi `from`, Lặp `each`
  `from`). Ý nghĩa
  không đổi: Lookup "Ngẫu nhiên" vẫn chọn đều trong mọi bản ghi đã sinh, với đúng số ngẫu nhiên như trước.
- **Chạy dạng luồng (0004):** executor sinh bản ghi lần lượt (cha luôn trước con); server không giữ hết bản ghi. Cùng
  workflow, `seed`, `now` và cùng dòng Query ⇒ cùng chuỗi bản ghi, từng byte, ở xem trước, insert và tải về.
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
| `<pool>.$count` | Số bản ghi của pool (Query: số dòng đọc được) |
| `<pick>.Field` | Field của bản ghi bước Chọn bản ghi vừa chọn; field quan hệ của Query lồng được: `acc.Owner.Name`. Với bản ghi đọc từ org, tên field **không phân biệt hoa thường** (như Salesforce) |
| `<itemAlias>.Field` | Field của bản ghi đang lặp của Lặp `each` (0010), **chỉ bên trong thân** vòng lặp đó; như `<pick>.Field` (`<itemAlias>.$n` với pool Record) |
| `<loopAlias>.index` / `.index0` / `.count` | Biến lặp (từ 1 / từ 0 / tổng số lần) |

Template dùng `{{path}}` (regex `\{\{\s*([\w.$]+)\s*\}\}`, khai báo một lần ở `shared/scope.js` và gửi qua
`meta.syntax.templateToken`). Field và biến lặp so khớp **có phân biệt hoa thường**, giống lúc chạy.
Alias của Record, Query và Chọn bản ghi, và tên bản ghi đang lặp `itemAlias` của Lặp `each` (mọi khóa config đặt tên một
nguồn `kind: "record"` của `exposes` đang có hiệu lực; server, `shared/` (`stepNames` trong `shared/workflow-tree.js`) và UI
đều đọc từ danh mục) dùng **chung một không gian tên**: duy nhất trên **cả cây** (kể cả bước đang tắt), không trùng tên biến
lặp (kể cả biến lặp của chính vòng đó) và không được là `this`. Query và Chọn bản ghi bắt buộc có alias (Record thiếu alias thì dùng `id`).
Alias của Query là pool nên không có bản ghi hiện tại: chỉ dùng được trong Lookup "Ngẫu nhiên trong pool", `from` của Chọn
bản ghi và `{{accs.$count}}`; `{{accs.Name}}` là lỗi `noCurrent`.

### Phạm vi biến (`analyzeScope`)

`analyzeScope(workflow, { nodeTypes, fieldTypes })` trong `shared/scope.js` là nguồn sự thật duy nhất cho câu hỏi "biến
này dùng được ở đây không": validate trên server, ô "Bản ghi cha" của Lookup, bảng chọn biến và việc đổi tên trên trình
duyệt đều gọi nó. Kết quả `{ partial, sources, at, refs }`:

- `sources[<id nguồn>]`: nguồn biến (`id`, `nodeId` = id bước, `kind`, `name`, `label`, `sobject`, `members` kèm
  `valueType`/`example`, các cờ của `exposes`). Id nguồn là id bước, trừ nguồn phụ: `<id Lặp>#item` (bản ghi đang lặp, 0010).
  `refs[].source` và `refChoices` dùng id nguồn; `sourceStep(scope, id)` trả id bước.
- `at[<id bước>]`: `visible` (gần nhất trước: vòng lặp trong cùng và bước ngay phía trên đứng đầu) và `hidden` kèm `reason`
  và `note` tiếng Việt.
- `refs[]`: mọi tham chiếu trong workflow (`nodeId`, `field`, `option`, `path`, `source`), kèm `code` khi có vấn đề.

Trạng thái của một nguồn tại một bước:

| Trạng thái | Nghĩa | Kết quả validate |
| --- | --- | --- |
| `always` | Nguồn chạy trước, trực tiếp trong một dãy đang bao bước này; biến lặp của vòng lặp bao quanh | Hợp lệ |
| `last` | Nguồn nằm trong thân một Lặp đã chạy xong ở phía trên, và Lặp luôn chạy ≥ 1 lần (`fixed` với `count ≥ 1`, hoặc `range` với `min ≥ 1`). Giá trị là bản ghi của lần lặp cuối (Lookup `random`: một bản ghi bất kỳ đã sinh) | Hợp lệ |
| `maybe` | Nguồn nằm trong một nhánh rẽ, hoặc trong một Lặp có thể chạy 0 lần (kể cả mọi Lặp `each`: pool có thể rỗng), ở phía trên | Cảnh báo |
| `after` | Nguồn nằm sau bước này, hoặc chính là bước này | Lỗi |
| `otherBranch` | Nguồn ở nhánh còn lại của một Rẽ nhánh đang bao bước này | Lỗi |
| `outsideLoop` | Biến lặp, hoặc bản ghi đang lặp (0010), của một vòng lặp không bao bước này | Lỗi |
| `shadowed` | Biến lặp bị vòng lặp bên trong cùng tên che (tham chiếu trỏ tới vòng trong) | – |
| `disabled` | Nguồn, hoặc một khung bao nó, đang tắt | Lỗi |

Ví dụ: `Lặp{acc}` rồi `con` có `AccountId` = ngẫu nhiên trong các bản ghi của `acc`: `acc` là `last`, hợp lệ.
Bước tắt và bước con của nó không được kiểm tra (nhưng vẫn có `at` và `refs`, để đổi tên vẫn đi theo). Option đang ẩn
theo `showIf` (ví dụ `left` khi điều kiện là Xác suất) cũng có trong `refs` với `hidden: true`: không kiểm tra, nhưng đổi
tên vẫn đi theo. Biến lặp và bản ghi đang lặp dùng ngoài vòng lặp của nó luôn là `outsideLoop`, kể cả khi vòng lặp đang
tắt. Bản ghi đang lặp của một Lặp `each` có `from` hỏng vẫn có trong thân (không có field nào bị báo thiếu), để lỗi chỉ hiện
ở `from`. `visible`/`hidden`
của `at` được tính khi đọc lần đầu; phân tích tuyến tính theo kích thước workflow.

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
| `currentOfPool` | lỗi | Lookup "Bản ghi hiện tại" trỏ vào alias của Query (0006) |
| `itemNotPool` | lỗi | `from` của Chọn bản ghi hoặc Lặp `each` là bản ghi đang lặp của một Lặp khác, không phải pool (0010) |
| `randomOfItem` | lỗi | Lookup "Ngẫu nhiên trong pool" trỏ vào bản ghi đang lặp (0010) |
| `eachEmpty` | cảnh báo (khi chạy) | Pool của Lặp `each` không có bản ghi nào; gắn `from` (0010) |

Kiểm tra riêng của Query và Chọn bản ghi (0006, câu chữ theo bảng "Thông báo" của doc đó, "node" đổi thành "bước"):
Query builder (`sobject`, `fields` là API name hoặc `Owner.Name`, `limit` 1–2000, không `{{…}}`, không ORDER BY/LIMIT trong
`where`, không LIMIT trong `orderBy`), SOQL (`notSelect`, `noFrom`, `forClause`, `template` là lỗi; `noOrderBy`, `noId`,
`subquery` là cảnh báo), quá 20 bước Query (lỗi ở bước thứ 21), `queryInLoop` và `poolUnused` (cảnh báo), alias thiếu; Chọn
bản ghi thiếu `from`, thiếu `filterField` khi lọc. `from` không dùng được ở đây dùng mã của phạm vi (`unknownName`, `after`,
`otherBranch`, `disabled`) với câu nói về "pool". Template dùng field mà Query không lấy là lỗi `unknownMember` (0007).

Lặp `each` (0010, câu chữ theo bảng "Thông báo" của doc đó): thiếu `from` (`Chưa chọn pool để lặp…`), `from` không dùng được
(`unknownName`, `after` — `Pool "accs" nằm sau bước Lặp này…`, `otherBranch`, `disabled`, `itemNotPool`; `maybe` là cảnh báo
`… có lúc vòng lặp này không chạy lần nào.`), thiếu `itemAlias` (`Đặt tên cho bản ghi đang lặp…`), `itemAlias` không hợp lệ /
trùng alias khác (câu sẵn có, gắn `itemAlias`), trùng tên biến lặp (`Tên bản ghi đang lặp "loop" trùng tên biến lặp…`).
`count`/`min`/`max` không được kiểm tra khi `each`.

Câu thông báo đúng như bảng "Thông báo lỗi" của [0005](design/0005-variable-picker.md) (đổi "node" thành "bước").

## Kết quả `/api/run`

Request: `{ "workflow": {…}, "seed": 42, "now": 1761552000000, "target": { "kind": "org", "org": "dev-sb" } }`.
`now` (mili giây, tùy chọn; thiếu thì là giờ hiện tại) là "hôm nay" của field ngày tương đối (`today`, `-1y`). **Cùng
`seed` và `now` ⇒ cùng dữ liệu.** `now` không phải số hữu hạn ⇒ 400 `Tham số now không hợp lệ.`

Hai cách nhận kết quả ([0004](design/0004-streaming-execution.md)):

- **JSON một cục** (mặc định, cho script và test): toàn bộ bản ghi và mọi Id đã insert, như dưới đây.
- **NDJSON** khi request có header `Accept: application/x-ndjson` (UI luôn dùng): `Content-Type: application/x-ndjson`, mỗi
  dòng một sự kiện, gửi trong lúc chạy. Lỗi validate (422), `now` sai (400), lỗi đọc trước Query (409/502) vẫn trả JSON
  thường vì được phát hiện **trước** khi gửi header.

```json
{
  "seed": 42,
  "now": 1761552000000,
  "stats": {
    "total": 17,
    "bySobject": { "Account": 5, "Contact": 12 },
    "byStep": {
      "loopAcc": { "runs": 1, "records": 17, "iterations": 5 },
      "acc": { "runs": 5, "records": 5 },
      "hot": { "runs": 12, "records": 4, "true": 4, "false": 8 }
    },
    "durationMs": 4,
    "previewRows": 200,
    "truncated": false
  },
  "warnings": [{ "message": "...", "nodeId": "x", "field": "slots.body" }],
  "records": [
    { "ref": "acc#1", "sobject": "Account", "alias": "acc", "nodeId": "acc", "fields": { "Name": "Acme Inc" } },
    { "ref": "con#1", "sobject": "Contact", "alias": "con", "nodeId": "con", "fields": { "AccountId": { "$ref": "acc#1" } } }
  ],
  "insert": {
    "inserted": 17, "failed": 0, "errorsTotal": 0, "errors": [], "errorGroups": [],
    "ids": { "acc#1": "001..." }, "bySobject": { "Account": { "inserted": 5, "failed": 0 } },
    "total": 17, "notSent": 0, "cancelled": false, "stopped": null
  }
}
```

Các sự kiện NDJSON:

```json
{"type":"start","runId":"r7f3k2a9","seed":42,"now":1761552000000,"warnings":[],"queries":[]}
{"type":"progress","phase":"generate","generated":120000,"bySobject":{"Account":24000,"Contact":96000},"byStep":{…}}
{"type":"plan","total":200000,"bySobject":{"Account":40000,"Contact":160000},"apiCalls":1000}
{"type":"progress","phase":"insert","inserted":12400,"failed":3,"total":200000,"bySobject":{"Account":{"inserted":2480,"failed":0,"total":40000},"Contact":{"inserted":9920,"failed":3,"total":160000}}}
{"type":"done","result":{ …cùng hình dạng như JSON một cục… }}
{"type":"error","error":"Lỗi khi sinh dữ liệu, chưa ghi bản ghi nào vào org: …","issues":[{"message":"…","nodeId":"acc","field":"fields.AccountNumber"}],"insert":null}
```

- `start` luôn là dòng đầu; `runId` dùng cho `POST /api/runs/:runId/cancel`. `queries` như bên dưới (0006).
- `progress` (`generate`) mỗi 1 000 bản ghi, tối đa 4 lần/giây; khi insert, đây là **lượt chạy thử**: sinh hết một lượt
  chỉ để đếm, nên lỗi sinh dữ liệu dừng lần chạy trước khi ghi bản ghi đầu tiên vào org.
- `plan` (chỉ khi insert): tổng chính xác và số lời gọi API ước tính `Σ ceil(n_sObject / 200)`; sau đó là `progress`
  (`insert`) sau các lô, rồi `done`.
- `done.result`: ở chế độ NDJSON, `records` chỉ có **200 bản ghi đầu mỗi sObject** (`stats.previewRows`;
  `stats.truncated: true` nếu bị cắt) và `insert.ids` chỉ có Id của **chính các bản ghi đó** (Id của alias được Lookup trỏ tới
  chỉ được giữ trong lúc insert, không gửi về). `runId` của lần chạy dùng cho `/api/export` (bên dưới). Một lần xem trước bị
  Dừng có `cancelled: true` và số đếm tới lúc dừng.
- `error`: `issues` (có `nodeId`/`field`) cho lỗi sinh dữ liệu; `insert` là `null` nếu chưa ghi gì, còn không là tóm tắt đã
  insert tới lúc lỗi.
- `insert.errors`: tối đa **1 000** lỗi đầu, mỗi lỗi `{ ref, sobject, nodeId, field?, message, parentRef? }` (`field` =
  `fields.<Name>` khi Salesforce chỉ đúng một field có trong bước; bản ghi con của bản ghi cha lỗi có `message: "Bỏ qua vì
  bản ghi cha lỗi."` và `parentRef`). `errorsTotal` đếm đủ. `errorGroups: [{ sobject, nodeId, field?, message, count,
  refs }]` gom theo (sObject, bước, field, **mẫu** thông báo: Id 15/18 ký tự và giá trị trong ngoặc kép bị che, nên "duplicates
  value on record with id: 003…" của 40 000 bản ghi là một nhóm; `message` là thông báo gốc đầu tiên làm ví dụ), `count` đủ,
  `refs` là 3 ref đầu. Tối đa **100** nhóm; phần còn lại cộng trong `errorGroupsOther: { groups, count }` (`null` nếu không có),
  nên dòng `done` luôn nhỏ.
- `insert.cancelled`: dừng bằng tay (Dừng hoặc đóng kết nối) trước khi gửi hết; lô đang gửi luôn được chờ xong nên
  `inserted` chính xác. `insert.stopped: { reason: "allFailing", sobject, nodeId, message, batches, records }`: 3 lô đầu của
  một sObject lỗi 100 % nên app tự dừng. `notSent`: số bản ghi chưa gửi. Bản ghi đã insert **không** tự xóa.

### Chặn yêu cầu từ trang web khác

Mọi `/api/*` từ chối (403) yêu cầu có `Origin` khác địa chỉ của server, có `Sec-Fetch-Site` khác `same-origin`/`none`, hoặc
có `Host` không phải máy này (`127.0.0.1`, `localhost`, `::1`, hoặc `HOST` đã đặt); mọi POST phải là `Content-Type:
application/json` (không thì 415). curl và script không gửi `Origin` nên vẫn dùng được. Xem
[org-connection.md](org-connection.md#an-toàn).

### `POST /api/runs/:runId/cancel`

Dừng lần chạy sau lô đang gửi. Trả `{ "ok": true }`; lần chạy đã xong hoặc không tồn tại ⇒ 404 `Lần chạy này đã kết thúc.`
Đóng kết nối của `/api/run` (đóng tab) cũng dừng lần chạy.

### `POST /api/export`

Body `{ workflow, seed, now, format: "csv" | "json", sobject?, org?, expectQueries?, runId? }`. Server sinh lại lần chạy
(cùng `seed`, `now`, và dòng Query qua cache như `/api/run`) và ghi thẳng ra response (`Content-Disposition: attachment`).
Có `runId` của một lần chạy gần đây (10 lần chạy cuối có Query) thì dùng **đúng các dòng Query lần chạy đó đã dùng**, không
đọc lại org: tải về sau khi insert ra đúng dữ liệu đã insert, kể cả khi Query đọc chính sObject vừa được insert.
`csv`: một sObject (`sobject` bắt buộc, thiếu ⇒ 400 `Chọn sObject cần tải CSV.`), cột `ref` rồi field theo thứ tự trong
workflow, `{ $ref }` ghi thành ref. `json`: mảng bản ghi, mỗi bản ghi một dòng. Thiếu `seed`/`now` ⇒ 400. Dữ liệu Query đã
đổi (fingerprint khác `expectQueries`) ⇒ 409 `Dữ liệu đọc từ org đã đổi so với lần chạy này. Bấm Xem trước lại rồi tải.`

- `stats.byStep[<id>]`: `runs` = số lần chạy qua bước, `records` = số bản ghi sinh ra trong bước (với khung: cả bước con).
  Lặp có thêm `iterations` (tổng số lần lặp; Lặp `each`: tổng số bản ghi đã lặp qua), Rẽ nhánh có thêm `true` / `false` (số lần đi mỗi nhánh). Bước tắt và bước
  chưa chạy lần nào không có mục. UI hiện các số này thành chip trên thẻ (`12 bản ghi`, `15 lần lặp`, `Đúng 4 · Sai 8`).
- `insert` chỉ có khi request gửi `target: { "kind": "org", "org": "<alias hoặc username>" }`. Insert theo cửa sổ 2 000 bản
  ghi, cha luôn trước con (xem [org-connection.md](org-connection.md#insert)).
- `queries` (0006): mỗi bước Query đã đọc `{ nodeId, alias, sobject, soql, org, source: "org" | "cache" | "sample",
  fetchedAt, count, totalSize, truncated, fingerprint, fields, records }`. Các dòng này **không** nằm trong `records`/`stats`
  và không bao giờ được insert. `samples`: bản ghi đầu tiên mỗi bước Chọn bản ghi đã chọn (giá trị mẫu cho bảng chọn biến).
  `stats.byStep` của Query có `rows`, của Chọn bản ghi có `picked` và `skipped`.

Request `/api/run` có thêm: `org` (org để Query đọc khi **xem trước**; bị bỏ qua khi có `target` vì lúc insert Query luôn đọc
`target.org`; không có thì dùng dòng mẫu), `refreshQueries` (`true`: bỏ qua cache, đọc lại org), `expectQueries`
(`{ <nodeId>: fingerprint }` hoặc `{ <nodeId>: { fingerprint, count, fetchedAt } }` của lần xem trước; khác thì **409**
`{ error, issues }` và không ghi gì). Lỗi Salesforce do config Query sai (`INVALID_TYPE`, `INVALID_FIELD`, `MALFORMED_QUERY`,
`INVALID_QUERY_FILTER_OPERATOR`, quá 30 giây) là 422 với issue gắn đúng ô; lỗi Salesforce khác là 502 kèm `issues: [{ nodeId }]`.

Lỗi validate trả về HTTP 422: `{ "error": "...", "issues": [{ "message", "nodeId", "field" }] }`.
Issue về tham chiếu biến có thêm `code`, `path` (đường dẫn bị lỗi, ví dụ `acc.Nmae`), `option` (khóa option chứa nó, ví dụ
`template`, `left`, `ref`) và có thể có `suggestion: { option, from, to }` (UI hiện nút "Sửa thành {{acc.Name}}").
`POST /api/validate` trả `{ errors, warnings, derived }`; phạm vi biến không gửi kèm vì trình duyệt tự tính bằng `shared/scope.js`.
`derived[<id>]` (0006): Query `{ soql, sobject, fields }` (câu SOQL server sẽ chạy), Chọn bản ghi `{ sobject, fields, from }`.
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
