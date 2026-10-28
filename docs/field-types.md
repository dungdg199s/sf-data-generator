# Kiểu field

Danh sách đầy đủ và chính xác nhất lấy từ `GET /api/meta` (sinh từ `server/generators/`).
Bảng dưới đây tóm tắt; khi thêm hoặc sửa generator thì cập nhật bảng này.

Option chung (registry tự thêm, generator không cần khai báo):

- `nullRatio` (0–1): tỉ lệ để trống. Không có với `checkbox`, `autonumber`, `masterdetail`.
- `unique`: không lặp giá trị trong một lần chạy (thử tối đa 100 lần rồi báo lỗi). Chỉ có với các kiểu đặt `uniqueable: true`.
  Tập giá trị đã dùng nằm trong bộ nhớ suốt lần chạy (khoảng 165 B/giá trị; 200 000 Email ≈ 30 MB): đây là phần bộ nhớ còn
  tăng theo số bản ghi khi chạy dạng luồng ([0004](design/0004-streaming-execution.md)).
  Tập giá trị đã dùng (và bộ đếm của `autonumber`) tính **theo từng bước**: hai bước khác nhau, kể cả bản sao `c_2` do
  chuyển workflow v1 tạo ra, có thể sinh trùng giá trị của nhau.

| `type` | Salesforce | Option riêng | Giá trị sinh ra |
| --- | --- | --- | --- |
| `text` | Text | `mode` (words, name, firstName, lastName, company, city, pattern, list), `minWords`, `maxWords`, `pattern`, `values`, `prefix`, `suffix`, `maxLength` | chuỗi |
| `textarea` | Text Area | `minSentences`, `maxSentences`, `maxLength` (≤255) | chuỗi |
| `longtextarea` | Text Area (Long) | `minParagraphs`, `maxParagraphs`, `maxLength` | chuỗi có `\n\n` |
| `richtextarea` | Text Area (Rich) | như trên | HTML `<p>` (không cắt giữa thẻ) |
| `encryptedtext` | Text (Encrypted) | `pattern`, `maxLength` (≤175) | chuỗi |
| `email` | Email | `mode` (fromName, random), `domains`; mặc định `unique` | `first.last12@example.com` |
| `phone` | Phone | `format` (`#` là chữ số) | chuỗi |
| `url` | URL | `withPath` | `https://...` |
| `autonumber` | Auto Number | `displayFormat` (`A-{0000}`), `startingNumber` | chuỗi; thường không insert được (field read-only) |
| `number` | Number | `min`, `max`, `scale` | số |
| `currency` | Currency | `min`, `max`, `scale` | số |
| `percent` | Percent | `min`, `max`, `scale` | số |
| `checkbox` | Checkbox | `trueProbability` | boolean, không bao giờ null |
| `picklist` | Picklist | `values`, `weights` | một giá trị |
| `multipicklist` | Picklist (Multi-Select) | `values`, `minSelected`, `maxSelected` | `A;B` |
| `date` | Date | `from`, `to` | `YYYY-MM-DD` |
| `datetime` | Date/Time | `from`, `to` | ISO 8601 UTC |
| `time` | Time | `from`, `to` (HH:MM), `stepMinutes` | `HH:MM:00.000Z` |
| `lookup` | Lookup Relationship | `mode`: `current` "Bản ghi hiện tại của alias", `random` "Ngẫu nhiên trong pool (đã sinh hoặc đọc từ org)", `fixed` "Id nhập tay"; `ref` "Bản ghi cha / pool (alias)": alias của bước Record, Query hoặc Chọn bản ghi ở phía trên ([0006](design/0006-query-pick-nodes.md); `current` không dùng được với Query vì pool không có bản ghi hiện tại); `ids`; `referenceTo` (sObject mà field trỏ tới, điền khi Import từ org; lọc danh sách Bản ghi cha và cảnh báo khi chọn bước sinh sObject khác). Bản ghi cha phải ở phía trên (xem [workflow-schema.md](workflow-schema.md#phạm-vi-biến-analyzescope)) | `{ "$ref": "acc#3" }` với bản ghi được sinh; **chuỗi Id thật** với bản ghi đọc từ org (Query, hoặc Chọn bản ghi từ Query); Id nhập tay với `fixed`. `random` chọn đều trong `alias#1…alias#n` (mọi bản ghi đã sinh tới lúc đó); từ 0004 pool chỉ đếm, ý nghĩa và dữ liệu không đổi. Bản ghi đang lặp của Lặp `each` ([0010](design/0010-lap-theo-ban-ghi.md)) dùng được với `current` (chỉ bên trong vòng lặp), **không** với `random` (một bản ghi, không phải pool: chọn pool gốc) |
| `masterdetail` | Master-Detail | như `lookup`; báo lỗi nếu chưa có bản ghi cha | như trên |
| `geolocation` | Geolocation | `latMin`, `latMax`, `lngMin`, `lngMax`, `scale` | `{ latitude, longitude }` (khi insert tách thành `X__Latitude__s` / `X__Longitude__s`) |
| `template` | (ghép giá trị) | `template` (`vars: 'template'`, có bảng chọn biến) với `{{this.F}}`, `{{alias.F}}`, `{{loop.index}}`, `{{this.$n}}`, `{{alias.$n}}`. Mặc định `{{this.$n}}` (ra `1`, `2`, `3`…). Tham chiếu hỏng hoặc ngoài phạm vi là lỗi validate | chuỗi |
| `copy` | Lấy từ biến (giữ kiểu) | `path` (`vars: 'path'`, mặc định `this.$n`): một biến, ví dụ `pbe.UnitPrice`. Khác Template (luôn ra chuỗi), giá trị giữ nguyên kiểu: số, đúng/sai, Id (0007: "giữ kiểu số khi lấy từ tham chiếu"). Biến phải là **một giá trị**: trỏ vào cả bản ghi hay một đối tượng có field con (`pbe.Product2`, Geolocation) là lỗi `wholeRecord`; giá trị Lookup (`{ $ref }`) được chép nguyên | giá trị của biến (null nếu không có) |
| `constant` | (cố định) | `value` (không nhận biến; muốn ghép biến thì dùng Template) | chuỗi |

Mốc thời gian (`from`/`to` của date/datetime) nhận `YYYY-MM-DD`, ISO đầy đủ, hoặc mốc tương đối:
`today`, `now`, `-1y`, `+30d`, `-6m`, `+2w`, `-12h`. Cả lần chạy dùng chung một mốc "now".

## Hợp đồng generator

```js
export const myType = {
  type: 'mytype',            // khóa dùng trong workflow JSON
  label: 'My Type',          // hiển thị trong UI
  category: 'Text',          // nhóm trong dropdown (Text, Number, Choice, Date/Time, Relationship, Other)
  valueType: 'string',       // kiểu giá trị (bảng chọn biến): string (mặc định), number, boolean, date, datetime, time, reference, object, any
  members: undefined,        // chỉ với valueType 'object': [{ key, valueType, label }], ví dụ latitude/longitude của geolocation
  sfTypes: ['string'],       // các kiểu `describe` của Salesforce mà kiểu này tương ứng (tham khảo)
  nullable: true,            // false ⇒ không có option nullRatio
  uniqueable: false,         // true ⇒ có option unique
  uniqueDefault: false,
  options: [opt('key', 'Nhãn', 'integer', 10, { min: 1, help: '...', showIf: { key: 'mode', in: ['x'] } })],
  generate(o, ctx) { ... }   // o: option đã gộp default + ép kiểu
};
```

`ctx` gồm:

| Khóa | Ý nghĩa |
| --- | --- |
| `rng` | PRNG có seed (`int`, `float`, `bool`, `pick`, `weighted`, `sample`, `digits`). **Chỉ dùng `rng`, không dùng `Math.random`**, nếu không seed sẽ mất tác dụng |
| `now` | Mốc thời gian chung của lần chạy (ms) |
| `record` | Các field đã sinh phía trên trong cùng bản ghi |
| `scope` | `{ current, all, vars }`: bản ghi hiện tại, pool theo alias, biến lặp. Pool của alias Record thường chỉ **đếm** ([0004](design/0004-streaming-execution.md)): `{ kind: 'generated', length, refAt(i) }` với `refAt(i)` = `alias#(i+1)`; chỉ pool mà một bước đọc cả bản ghi (Chọn bản ghi `from`) mới là mảng bản ghi. Generator chọn trong pool phải xử lý cả hai dạng và rút đúng một số `Math.floor(rng.next() * length)` như `rng.pick` |
| `fieldName` | Tên field (dùng trong thông báo lỗi) |
| `fieldState` | Object riêng cho từng (bước, field), tồn tại suốt lần chạy (bộ đếm, tập giá trị unique) |
| `n` | Số thứ tự của bản ghi đang sinh (`n` trong `alias#n`), cho `{{this.$n}}` |

Lỗi do generator `throw` sẽ được executor gắn `nodeId` và `field` để UI chỉ ra đúng field.

Các `kind` của option mà UI dựng được: `string`, `text`, `integer`, `number`, `boolean`, `select` (cần `choices`),
`list`, `numberList`, `time`, `ref` (dropdown dựng từ `refChoices` của `shared/scope.js`: bước dùng được ở vị trí này, gần
nhất trước, kèm `bản ghi cuối` / `có thể trống`; các bước khác nằm trong nhóm "Không dùng được ở đây", bị tắt, kèm lý do).
Khóa thêm của option ([0005](design/0005-variable-picker.md)):

- `vars: 'template' | 'path'`: option nhận biến. UI gắn bảng chọn biến (nút `{x}`, gõ `{{`, Ctrl+Space) và dải chip;
  validate kiểm tra mọi tham chiếu trong option đó.
- `accepts` (chỉ với `kind: 'ref'`, không bắt buộc): lọc nguồn theo cờ của `exposes`, ví dụ `{ "pool": true }`. Mặc định
  là mọi nguồn có `lookupParent: true`. `placeholder` / `empty` (không bắt buộc): chữ của dòng trống khi có / chưa có
  nguồn nào (Chọn bản ghi: `— chọn pool —` / `— chưa có pool nào —`).
- `suggest` ([0006](design/0006-query-pick-nodes.md)): trợ giúp lấy **từ org** (khác `vars` là biến trong workflow); khi chưa
  chọn org thì không có gợi ý, nút bị khóa với title `Chọn org ở thanh trên trước`.
  `{ kind: 'sobject', purpose: 'query' | 'create' }` → datalist sObject (`GET /api/orgs/:org/sobjects?for=query` hoặc danh
  sách createable); `{ kind: 'fields', sobjectKey }` → nút "Chọn field…" (`GET /api/orgs/:org/sobjects/:name/fields`);
  `{ kind: 'poolFields', poolKey }` → datalist field của pool (từ `members` của nguồn trong `analyzeScope`).
- `initial` (option của bước): giá trị khi thêm bước mới từ UI; `default` là giá trị khi thiếu khóa (xem
  [workflow-schema.md](workflow-schema.md#bước)). `rows` / `monospace` cho `kind: 'text'` (ô SOQL).

`GET /api/meta` trả thêm `syntax: { templateToken, valueTypes: [{ value, label }] }` (nhãn tiếng Việt của `valueType`).

Thêm kiểu mới: xem skill `.claude/skills/add-field-type/SKILL.md`.
