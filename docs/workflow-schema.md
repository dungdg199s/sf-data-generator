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
  `chance` chọn nhánh Đúng với xác suất `probability`. `compare` so sánh `left` (một đường dẫn tham chiếu) với `right`
  (giá trị cố định). Nếu cả hai là số thì so theo số, không thì so theo chuỗi.
  Phép so sánh: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `empty`, `notEmpty`, `divisibleBy`.
- Bản ghi đã sinh (`<alias>` hiện tại và danh sách mọi bản ghi của alias) dùng chung cho cả lần chạy; biến lặp theo phạm vi.
- Thứ tự gọi `rng` giống executor version 1, nên workflow chuyển từ v1 sinh đúng dữ liệu cũ với cùng seed.
- Giới hạn: `LIMITS` trong `server/workflow/nodes.js` (số bản ghi, số bước đã chạy, `maxDepth = 32` cấp lồng nhau).

### Đường dẫn tham chiếu

| Cú pháp | Giá trị |
| --- | --- |
| `this.Field` | Field đã sinh phía trên trong cùng bước (chỉ dùng trong template) |
| `<alias>.Field` | Field của bản ghi hiện tại của bước record có alias đó |
| `<loopAlias>.index` / `.index0` / `.count` | Biến lặp |

Alias của bước record phải là duy nhất trên **cả cây** (kể cả bước đang tắt), không trùng tên biến lặp và không được là `this`.

### "Phía trên": bản ghi cha của Lookup / Master-Detail

Field `lookup` / `masterdetail` với `mode` `current` hoặc `random` cần `ref` là alias của một bước Record **chạy trước**
bước này. Trạng thái của alias tại một bước (tính trong `shared/scope.js`, dùng chung cho validate và dropdown
"Bản ghi cha" trên UI):

| Trạng thái | Nghĩa | Kết quả validate |
| --- | --- | --- |
| `always` | Bước đó đứng trước, trực tiếp trong một dãy đang bao bước này | Hợp lệ |
| `last` | Bước đó nằm trong thân một Lặp đã chạy xong ở phía trên, và Lặp luôn chạy ≥ 1 lần (`fixed` với `count ≥ 1`, hoặc `range` với `min ≥ 1`). Giá trị là bản ghi của lần lặp cuối (`random`: một bản ghi bất kỳ đã sinh) | Hợp lệ |
| `maybe` | Bước đó nằm trong một nhánh rẽ, hoặc trong một Lặp có thể chạy 0 lần, ở phía trên | Cảnh báo (Master-Detail: cảnh báo vì lần chạy có thể báo lỗi) |
| `after` | Bước đó nằm sau bước này, hoặc chính là bước này | Lỗi |
| `otherBranch` | Bước đó ở nhánh còn lại của một Rẽ nhánh đang bao bước này | Lỗi |
| `disabled` | Bước đó, hoặc một khung bao nó, đang tắt | Lỗi |

Ví dụ: `Lặp{acc}` rồi `con` có `AccountId` = ngẫu nhiên trong các bản ghi của `acc`: `acc` là `last`, hợp lệ.
Template `{{alias.X}}` chưa được kiểm tra theo bảng này (xem [0005](design/0005-variable-picker.md)).

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
  Mỗi mục trong báo cáo chuyển đổi thành một cảnh báo có `nodeId`.
- **Trình soạn** chuyển ngay trong trình duyệt khi mở file version 1 hoặc khi autosave cũ (`sfdg.workflow.v1`) còn đó.
  Khóa `sfdg.workflow.v1` không bao giờ bị ghi đè hay xóa; bản mới lưu ở `sfdg.workflow.v2`. Nếu chuyển có thay đổi thì
  có hộp thoại báo cáo với nút **Tải bản gốc (v1)**.

Quy tắc chuyển (`migrateV1(wf)` → `{ workflow, report }`):

1. **Chuẩn hóa dây:** bỏ dây tới/từ node không tồn tại; mỗi cổng giữ dây **sau cùng** (dây executor v1 thực sự chạy);
   cắt dây tạo vòng.
2. **Bước kế:** `start`/`record` → `next`; `loop` → `done`; `branch` → điểm gộp = node đầu tiên trên chuỗi của nhánh
   `true` cũng có trên chuỗi của nhánh `false` (không có thì `null`).
3. **Dựng cây:** `loop` → `slots.body` là chuỗi từ `body`; `branch` → `slots.true` / `slots.false` là chuỗi từ mỗi nhánh tới
   điểm gộp, và điểm gộp thành bước sau khung. Giữ `id`, `config`, `name`, `seed`, `settings`; bỏ `position`.
4. **Node được tới từ hai chỗ** (thân Lặp "thoát" ra `done`, nối chéo giữa các nhánh, hai Lặp dùng chung thân): chỗ thứ hai
   nhận một **bản sao** của node và phần đuôi sau nó, id `<id>_2`, alias mới (`con` → `con2`), tham chiếu bên trong bản sao
   đổi theo. Tối đa `2 × số node + 50` bước; phần vượt bị cắt và ghi vào báo cáo.
5. **Node không được nối từ Bắt đầu:** đặt ở cuối `steps`, `disabled: true`.

`report = { duplicated: [{ id, copyId, alias, newAlias }], disabled: [id], droppedEdges: [{ from, fromPort, to, reason: 'missing' | 'fanout' | 'cycle' }], truncated: [id] }`.
Workflow "có cấu trúc" (gộp sau Rẽ nhánh, gộp lồng nhau, nhánh không nối) chuyển với báo cáo rỗng và sinh bản ghi
**giống hệt từng byte** với cùng seed (`test/migrate.test.js` so với executor v1 được đóng băng trong `test/fixtures/run-v1.js`).
Gọi `migrateV1` với workflow version 2 thì nhận lại nguyên như cũ.
