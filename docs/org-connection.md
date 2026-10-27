# Kết nối org

## Lấy thông tin org

App không tự làm OAuth. Server dùng Salesforce CLI (`sf`) đã đăng nhập sẵn trên máy:

| Việc | Lệnh | Nơi gọi |
| --- | --- | --- |
| Danh sách org | `sf org list --json` | `server/sf/cli.js` → `listOrgs()` |
| Access token, instance URL | `sf org display --target-org <alias> --json` | `getConnection()`; cache trong bộ nhớ 10 phút |

Khi REST trả 401, client gọi lại `sf org display` một lần để lấy token mới.
Nếu máy chưa cài `sf` thì `/api/orgs` trả 503 kèm thông báo; UI vẫn dùng được ở chế độ xem trước.

Đăng nhập org trên máy: `sf org login web --alias <tên>`.

## API

| Endpoint | Mô tả |
| --- | --- |
| `GET /api/orgs` | Org từ sf CLI: `alias`, `username`, `isSandbox`, `isScratch`, `isDefault` |
| `GET /api/orgs/:org/sobjects` | sObject có thể tạo (createable) |
| `GET /api/orgs/:org/sobjects/:name` | Describe đã map sang field spec (`server/sf/describe-map.js`) |

### Map describe sang field

- Bỏ qua field không createable, formula, auto number, và các kiểu `id`, `address`, `base64`, ….
- Gợi ý `mode` theo tên: `FirstName`, `LastName`, `*City`, `Name` (Account → company).
- `required` = không nillable và không có giá trị mặc định khi tạo; UI chọn sẵn các field này khi import.
- Lookup: master-detail nhận ra qua `relationshipOrder`. `ref` để trống; UI tự chọn node cha
  nếu chỉ có một node record khớp `referenceTo`.

## Insert

`server/sf/insert.js` dùng sObject Collections (`POST /composite/sobjects`, tối đa 200 bản ghi/lần, `allOrNone: false`):

1. Mỗi đợt (wave) lấy những bản ghi mà mọi `$ref` đã có Id thật.
2. Gom theo sObject, chia lô 200, gửi đi, lưu Id trả về theo `ref`.
3. Bản ghi có cha bị lỗi sẽ bị đánh lỗi luôn, không gửi đi.
4. Lặp lại cho tới khi hết bản ghi. Self-lookup (ví dụ `Account.ParentId`) vẫn chạy được vì cha nằm ở đợt trước.

Kết quả: `{ inserted, failed, errors: [{ ref, sobject, message }], ids: { ref: Id } }`.

Chưa làm: Bulk API 2.0 cho khối lượng lớn, xóa dữ liệu đã insert (rollback), upsert theo External Id.
