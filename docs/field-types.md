# Kiểu field

Danh sách đầy đủ và chính xác nhất lấy từ `GET /api/meta` (sinh từ `server/generators/`).
Bảng dưới đây tóm tắt; khi thêm hoặc sửa generator thì cập nhật bảng này.

Option chung (registry tự thêm, generator không cần khai báo):

- `nullRatio` (0–1): tỉ lệ để trống. Không có với `checkbox`, `autonumber`, `masterdetail`.
- `unique`: không lặp giá trị trong một lần chạy (thử tối đa 100 lần rồi báo lỗi). Chỉ có với các kiểu đặt `uniqueable: true`.

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
| `lookup` | Lookup Relationship | `mode` (current, random, fixed), `ref` (Bản ghi cha), `ids`. Bản ghi cha phải ở phía trên (xem [workflow-schema.md](workflow-schema.md#phía-trên-bản-ghi-cha-của-lookup--master-detail)) | `{ "$ref": "acc#3" }` hoặc Id có sẵn |
| `masterdetail` | Master-Detail | như `lookup`; báo lỗi nếu chưa có bản ghi cha | như trên |
| `geolocation` | Geolocation | `latMin`, `latMax`, `lngMin`, `lngMax`, `scale` | `{ latitude, longitude }` (khi insert tách thành `X__Latitude__s` / `X__Longitude__s`) |
| `template` | (ghép giá trị) | `template` với `{{this.F}}`, `{{alias.F}}`, `{{loop.index}}` | chuỗi |
| `constant` | (cố định) | `value` | chuỗi |

Mốc thời gian (`from`/`to` của date/datetime) nhận `YYYY-MM-DD`, ISO đầy đủ, hoặc mốc tương đối:
`today`, `now`, `-1y`, `+30d`, `-6m`, `+2w`, `-12h`. Cả lần chạy dùng chung một mốc "now".

## Hợp đồng generator

```js
export const myType = {
  type: 'mytype',            // khóa dùng trong workflow JSON
  label: 'My Type',          // hiển thị trong UI
  category: 'Text',          // nhóm trong dropdown (Text, Number, Choice, Date/Time, Relationship, Other)
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
| `scope` | `{ current, all, vars }`: bản ghi hiện tại và toàn bộ bản ghi theo alias, biến lặp |
| `fieldName` | Tên field (dùng trong thông báo lỗi) |
| `fieldState` | Object riêng cho từng (bước, field), tồn tại suốt lần chạy (bộ đếm, tập giá trị unique) |

Lỗi do generator `throw` sẽ được executor gắn `nodeId` và `field` để UI chỉ ra đúng field.

Các `kind` của option mà UI dựng được: `string`, `text`, `integer`, `number`, `boolean`, `select` (cần `choices`),
`list`, `numberList`, `time`, `ref` (dropdown alias của bước Record dùng được ở vị trí này; các alias khác nằm trong nhóm "Không dùng được ở vị trí này", bị tắt, kèm lý do).

Thêm kiểu mới: xem skill `.claude/skills/add-field-type/SKILL.md`.
