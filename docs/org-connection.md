# Kết nối org

## Lấy thông tin org

App không tự làm OAuth. Việc được chia làm hai phần:

- **sf CLI chỉ dùng để lấy thông tin đăng nhập** (`server/sf/cli.js`):

  | Việc | Lệnh | Hàm |
  | --- | --- | --- |
  | Danh sách org | `sf org list --json` | `listOrgs()` |
  | Access token, instance URL, API version | `sf org display --target-org <alias> --json` | `getConnection()`; cache trong bộ nhớ 10 phút |

- **Mọi lời gọi API đi qua [jsforce](https://jsforce.github.io/)** (`server/sf/client.js`). Mỗi org có một `jsforce.Connection`,
  được tạo từ `accessToken`, `instanceUrl` và `version` mà CLI trả về.

Khi Salesforce trả `INVALID_SESSION_ID` (token hết hạn), jsforce gọi `refreshFn`. Hàm này chạy lại `sf org display`
(CLI tự làm mới token từ thông tin đăng nhập nó đang giữ), rồi jsforce gọi lại request đó. Lỗi từ Salesforce được trả về
UI với HTTP 502 và mã lỗi, ví dụ `Salesforce: NOT_FOUND: ...`.
Nếu máy chưa cài `sf` thì `/api/orgs` trả 503 kèm thông báo; UI vẫn dùng được ở chế độ xem trước.

Đăng nhập org trên máy: `sf org login web --alias <tên>`.

## API

| Endpoint | Mô tả |
| --- | --- |
| `GET /api/orgs` | Org từ sf CLI: `alias`, `username`, `isSandbox`, `isScratch`, `isDefault` |
| `GET /api/orgs/:org/sobjects` | sObject có thể tạo (createable) |
| `GET /api/orgs/:org/sobjects?for=query` | sObject đọc được (`queryable`, bỏ `deprecatedAndHidden`), cho ô sObject của bước Query |
| `GET /api/orgs/:org/sobjects/:name` | Describe đã map sang field spec (`server/sf/describe-map.js`) |
| `GET /api/orgs/:org/sobjects/:name/fields` | **Mọi** field (`name`, `label`, `type`, `referenceTo`, `relationshipName`, `filterable`, `sortable`) và `nameField`; thứ tự `Id`, name field, rồi theo nhãn. Cho hộp "Chọn field…" |

### Map describe sang field

- Bỏ qua field không createable, formula, auto number, và các kiểu `id`, `address`, `base64`, ….
- Gợi ý `mode` theo tên: `FirstName`, `LastName`, `*City`, `Name` (Account → company).
- `required` = không nillable và không có giá trị mặc định khi tạo; UI chọn sẵn các field này khi import.
- Lookup: master-detail nhận ra qua `relationshipOrder`. `ref` để trống; UI tự chọn bản ghi cha
  nếu chỉ có một bước Record phía trên khớp `referenceTo`.

## Insert

`server/sf/insert.js` gọi `conn.sobject(type).create(records, { allOrNone: false })` của jsforce (sObject Collections `POST /composite/sobjects`), mỗi lần tối đa 200 bản ghi:

1. Mỗi đợt (wave) lấy những bản ghi mà mọi `$ref` đã có Id thật.
2. Gom theo sObject, chia lô 200, gửi đi, lưu Id trả về theo `ref`.
3. Bản ghi có cha bị lỗi sẽ bị đánh lỗi luôn, không gửi đi.
4. Lặp lại cho tới khi hết bản ghi. Self-lookup (ví dụ `Account.ParentId`) vẫn chạy được vì cha nằm ở đợt trước.

Kết quả: `{ inserted, failed, errors: [{ ref, sobject, message }], ids: { ref: Id } }`.

Bản ghi đọc từ org (bước Query) không bao giờ nằm trong `records` nên không bao giờ bị insert lại. Lookup tới chúng là chuỗi Id
thật, `collectRefs` không coi là phụ thuộc, nên bản ghi con được gửi ngay ở đợt đầu (`insert.js` không phải đổi).

## Đọc dữ liệu (Query)

Bước Query ([0006](design/0006-query-pick-nodes.md)) đọc bản ghi có sẵn **trước** khi executor chạy (`server/sf/query.js`,
`prefetchQueries`); executor vẫn thuần và chỉ nhận các dòng đã đọc.

- **Chỉ đọc.** `client.query(org, soql, { maxFetch, timeoutMs })` gọi `conn.query(soql, { autoFetch: true, maxFetch })` của
  jsforce: endpoint REST `/query`, tự theo `nextRecordsUrl` (queryMore) tới `maxFetch` dòng (LIMIT của builder, tối đa 2 000).
  Không bao giờ đặt `scanAll` (sẽ thành `queryAll`, trả cả bản ghi đã xóa). SOQL tự viết phải bắt đầu bằng `SELECT`, không có
  `FOR UPDATE / VIEW / REFERENCE`, không có `{{…}}` (kiểm tra ở `shared/soql.js` khi validate). Tối đa 20 bước Query, mỗi
  query 30 giây (`LIMITS` trong `server/workflow/nodes.js`).
- **Org nào.** Xem trước: org đang chọn ở thanh trên (`org` trong request), không chọn thì 5 dòng mẫu (không gọi Salesforce).
  Insert: luôn đọc `target.org`, không bao giờ dùng dòng mẫu. Các query chạy tuần tự theo thứ tự đọc, bỏ bước đang tắt.
- **Cache.** Trong bộ nhớ, khóa `(org, SOQL, maxFetch)`, TTL 10 phút (`queryCacheTtlMs`), tối đa 50 mục. Xem trước rồi insert
  ngay dùng **cùng** các dòng. "⟳ Đọc lại" (Ctrl+Shift+Enter) gửi `refreshQueries: true` để bỏ qua cache. Insert vào một org
  xóa cache của org đó, để lần xem trước sau thấy cả bản ghi vừa tạo.
- **Dấu vân tay.** Mỗi kết quả có `fingerprint` (8 ký tự đầu của SHA-1 các dòng đã bỏ `attributes`, `node:crypto`). Khi insert
  "giống lần xem trước" (cùng workflow, seed và org) UI gửi `expectQueries`; nếu server đọc lại (cache hết hạn, server khởi động
  lại) mà khác thì trả **409** trước khi ghi bất cứ gì, issue gắn bước Query.
- **Lỗi.** `INVALID_TYPE` → ô `sobject`, `INVALID_FIELD` → `fields` / `where` / `orderBy` (theo chỗ có tên field lỗi),
  `MALFORMED_QUERY` và `INVALID_QUERY_FILTER_OPERATOR` → `where` (chế độ SOQL: ô `soql`), quá 30 giây → bước Query: HTTP 422.
  Mã khác (`REQUEST_LIMIT_EXCEEDED`, lỗi mạng…) → 502 `Bước Query "accs": Salesforce: <code>: <thông báo>` kèm
  `issues: [{ nodeId }]`. Org chưa đăng nhập: câu của CLI thêm `Hoặc chọn "— không kết nối —" để xem trước bằng bản ghi mẫu.`
- Đọc từ org production là thao tác chỉ đọc nên không có hộp xác nhận; hộp xác nhận insert liệt kê những gì đã đọc.

Chưa làm (jsforce đã hỗ trợ sẵn, chỉ cần nối vào): Bulk API 2.0 (`conn.bulk2`) cho khối lượng lớn, xóa dữ liệu đã insert (`conn.sobject(type).destroy`),
upsert theo External Id.

Lưu ý proxy: jsforce đọc `https_proxy` / `HTTPS_PROXY` khi khởi động và **không** xét `NO_PROXY`. Sau proxy công ty thì cứ đặt
`HTTPS_PROXY` như bình thường.
