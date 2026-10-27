# Workflow JSON (version 1)

Đây là hợp đồng giữa UI và server. Server validate trong `server/workflow/schema.js`;
khi đổi schema phải cập nhật cả file đó, executor, UI và tài liệu này cùng lúc.

## Cấu trúc

```json
{
  "version": 1,
  "name": "Account + Contact",
  "seed": 42,
  "settings": { "maxRecords": 50000 },
  "nodes": [
    { "id": "start", "type": "start", "position": { "x": 40, "y": 160 }, "config": {} },
    { "id": "loop1", "type": "loop", "config": { "mode": "fixed", "count": 5, "alias": "loop" } },
    {
      "id": "acc",
      "type": "record",
      "config": {
        "sobject": "Account",
        "alias": "acc",
        "count": 1,
        "fields": [
          { "name": "Name", "type": "text", "options": { "mode": "company", "unique": true } }
        ]
      }
    }
  ],
  "edges": [
    { "from": "start", "fromPort": "next", "to": "loop1" },
    { "from": "loop1", "fromPort": "body", "to": "acc" }
  ]
}
```

| Khóa | Bắt buộc | Mô tả |
| --- | --- | --- |
| `version` | có | Luôn là `1` |
| `name` | không | Tên hiển thị |
| `seed` | không | Seed mặc định; tham số `seed` của `/api/run` sẽ ghi đè |
| `settings.maxRecords` | không | Giới hạn bản ghi mỗi lần chạy (trần cứng 200 000) |
| `nodes[].position` | không | Chỉ dùng cho UI, server bỏ qua |
| `edges[].fromPort` | không | Mặc định `next` |

## Node

| `type` | Cổng ra | `config` |
| --- | --- | --- |
| `start` | `next` | – (đúng một node; không có cổng vào) |
| `record` | `next` | `sobject` (API name), `alias`, `count` (mặc định 1), `fields[]` |
| `loop` | `body`, `done` | `mode`: `fixed` (`count`) hoặc `range` (`min`, `max`); `alias` của biến lặp (mặc định `loop`) |
| `branch` | `true`, `false` | `kind`: `chance` (`probability`) hoặc `compare` (`left`, `op`, `right`) |

Field của node record có dạng `{ "name": "<API name>", "type": "<field type>", "options": { ... } }`;
xem [field-types.md](field-types.md). **Thứ tự field là thứ tự sinh**: `{{this.X}}` và Email theo tên
chỉ thấy các field ở phía trên.

## Ngữ nghĩa khi chạy

- Mỗi cổng ra nối **tối đa một** node; một node có thể nhận nhiều cạnh vào (để gộp nhánh).
- Không được tạo vòng bằng cạnh nối. Muốn lặp thì dùng node `loop`.
- `record`: mỗi lần chạy qua sinh `count` bản ghi; bản ghi cuối trở thành "bản ghi hiện tại" của alias.
- `loop`: chạy chuỗi `body` N lần, rồi đi tiếp theo `done`. Biến lặp:
  `{{<alias>.index}}` (từ 1), `{{<alias>.index0}}` (từ 0), `{{<alias>.count}}`. Biến lặp chỉ có hiệu lực trong body;
  vòng lồng nhau cùng alias thì vòng trong che vòng ngoài.
- `branch`: `chance` đi nhánh `true` với xác suất `probability`. `compare` so sánh `left`
  (một đường dẫn tham chiếu) với `right` (giá trị cố định). Nếu cả hai là số thì so theo số, không thì so theo chuỗi.
  Phép so sánh: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `empty`, `notEmpty`, `divisibleBy`.
- Nhánh không nối thì chỉ đơn giản là kết thúc chuỗi đó.

### Đường dẫn tham chiếu

| Cú pháp | Giá trị |
| --- | --- |
| `this.Field` | Field đã sinh phía trên trong cùng node (chỉ dùng trong template) |
| `<alias>.Field` | Field của bản ghi hiện tại của node record có alias đó |
| `<loopAlias>.index` / `.index0` / `.count` | Biến lặp |

Alias của node record phải là duy nhất, không trùng tên biến lặp và không được là `this`.

## Kết quả `/api/run`

```json
{
  "seed": 42,
  "stats": { "total": 17, "bySobject": { "Account": 5, "Contact": 12 }, "durationMs": 4 },
  "warnings": [{ "message": "...", "nodeId": "x" }],
  "records": [
    { "ref": "acc#1", "sobject": "Account", "alias": "acc", "nodeId": "acc", "fields": { "Name": "Acme Inc" } },
    { "ref": "con#1", "sobject": "Contact", "alias": "con", "nodeId": "con", "fields": { "AccountId": { "$ref": "acc#1" } } }
  ],
  "insert": { "inserted": 17, "failed": 0, "errors": [], "ids": { "acc#1": "001..." } }
}
```

`insert` chỉ có khi request gửi `target: { "kind": "org", "org": "<alias hoặc username>" }`.

Lỗi validate trả về HTTP 422: `{ "error": "...", "issues": [{ "message", "nodeId", "field" }] }`.
`field` có dạng `alias`, `count`, … cho option của node, hoặc `fields.<Name>` cho field của record.
