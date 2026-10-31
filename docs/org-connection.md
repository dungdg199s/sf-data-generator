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
| `GET /api/orgs/:org/sobjects/:name` | Describe đã map sang field spec (`server/sf/describe-map.js`): `{ sobject, label, nameField, fields }`; `nameField` là field có `nameField: true` (tạo được hay không), hoặc `null` |
| `GET /api/orgs/:org/sobjects/:name/fields` | **Mọi** field (`name`, `label`, `type`, `referenceTo`, `relationshipName`, `filterable`, `sortable`) và `nameField`; thứ tự `Id`, name field, rồi theo nhãn. Cho hộp "Chọn field…" |

### Map describe sang field

- Bỏ qua field không createable, formula, auto number, và các kiểu `id`, `address`, `base64`, ….
- Gợi ý `mode` theo tên: `FirstName`, `LastName`, `*City`, `Name` (Account → company).
- `required` = không nillable và không có giá trị mặc định khi tạo; UI chọn sẵn các field này khi import.
- Lookup: master-detail nhận ra qua `relationshipOrder`. `ref` để trống; UI tự chọn bản ghi cha
  nếu chỉ có một bước Record phía trên khớp `referenceTo`.

### Field mặc định của bước Record theo describe (0012 G)

Đổi sObject của bước Record khi danh sách field chưa bị sửa: field đổi ngay theo `meta.recordPresets` (Task → `Subject`), rồi nếu
đã chọn org và sObject có trong danh sách sObject tạo được của org, khoảng 0,5 s sau inspector gọi describe trên:

- sObject **có preset** (`meta.recordPresets`): giữ field của preset và chỉ **thêm** field bắt buộc (`required`) còn thiếu (so tên
  không phân biệt hoa thường), toast `Đã thêm field bắt buộc của Opportunity theo dev-sb: …`. (Describe thật của Task / Event không
  đánh dấu field nào bắt buộc; thay cả danh sách thì Event mất `ActivityDateTime`/`DurationInMinutes` và insert lỗi.)
- sObject **khác**: thay bằng **mọi field bắt buộc** (Lookup tự chọn bản ghi cha như Import; không tự thêm bước Query); không có
  field bắt buộc thì `nameField` nếu nó tạo được. Name field không tạo được (auto-number) và danh sách đang đúng `[Name]` ⇒ danh
  sách thành rỗng, toast nói field tên là auto-number; cảnh báo "Bước chưa có field nào…" hướng dẫn tiếp. Không có gì để đổi thì
  giữ nguyên. Toast `Đã đặt field mặc định cho Invoice__c theo dev-sb: …`.

Chỉ thay khi danh sách vẫn là danh sách vừa tự điền; không có bước hoàn tác riêng (Ctrl+Z bỏ việc đổi sObject cũng trả lại field).
Mỗi bước Record có hẹn giờ describe riêng; focus đang ở trong danh sách field thì được đặt lại đúng chỗ sau khi vẽ lại.

### Field bắt buộc còn thiếu (0012 F2)

Khi một bước Record được chọn, đã chọn org và sObject có trong danh sách sObject tạo được của org, inspector đọc describe trên
(cache theo `org|sObject` trong phiên, describe lỗi không được cache; ⟳ danh sách org xóa cache describe và danh sách sObject) và so field `required` với field bước đã có (không phân biệt hoa
thường). Thiếu ⇒ khung trên tiêu đề "Fields":

```
Thiếu 2 field bắt buộc của Opportunity trong dev-sb: StageName, CloseDate.   [Thêm 2 field] [Chọn…] [Bỏ qua]
```

- **Thêm n field**: thêm đúng các field đó như "Import từ org…" (cùng hàm `addDescribedFields`: kiểu và option theo describe,
  Lookup bắt buộc tự chọn bản ghi cha theo luật của Import, kể cả thêm bước Query "＋ … có sẵn trong org" khi không có bước nào khớp),
  một bước hoàn tác, toast `Đã thêm 2 field: StageName, CloseDate.` (Lookup bắt buộc chưa tự chọn được bản ghi cha thì toast nói
  thêm `Còn phải chọn bản ghi cha cho …`); focus vào ô tên của field mới đầu tiên.
- **Chọn…**: mở hộp Import; field bắt buộc còn thiếu đứng đầu dưới nhóm `Bắt buộc, chưa có (2)` và đã được tích (hộp Import luôn
  nhóm như vậy khi có field bắt buộc còn thiếu).
- **Bỏ qua**: ẩn khung cho bước đó tới khi tải lại trang (không lưu); focus chuyển tới tiêu đề "Fields".
- Describe lỗi, sObject không có trong org, chưa chọn org: không hiện gì (lỗi describe đã có chỗ báo ở ô sObject). Không vào thanh
  lỗi: validate ở server chạy không cần org. Gõ tên field còn thiếu vào danh sách thì khung tự cập nhật.

## Insert

`server/sf/insert.js` gọi `conn.sobject(type).create(records, { allOrNone: false })` của jsforce (sObject Collections `POST /composite/sobjects`), mỗi lần tối đa 200 bản ghi.
Từ [0004](design/0004-streaming-execution.md) bản ghi tới theo **dòng** (`server/run.js` đẩy từng bản ghi của executor vào
`createInserter`), không còn mảng toàn bộ bản ghi:

1. Gom một **cửa sổ 2 000 bản ghi** (khoảng 1 MB). Trong cửa sổ, mỗi đợt (wave) lấy những bản ghi mà mọi `$ref` đã có Id
   thật: cha ở cửa sổ trước đã có Id, cha cùng cửa sổ được gửi ở đợt trước.
2. Gom theo sObject, chia lô 200, gửi đi; các SaveResult trả về theo đúng thứ tự nên được map lại vào `ref`.
3. Bản ghi có cha bị lỗi (kể cả cha ở cửa sổ trước) bị đánh lỗi `Bỏ qua vì bản ghi cha lỗi.` (kèm `parentRef`), không gửi đi.
4. Self-lookup (ví dụ `Account.ParentId`) vẫn chạy được vì cha luôn được sinh trước.

Hệ quả và giới hạn:

- **Thứ tự insert xen kẽ theo cửa sổ.** Trước đây mọi Account vào org trước Contact đầu tiên; giờ Account và Contact xen
  kẽ theo từng cửa sổ 2 000 (cha **vẫn luôn** vào trước con). Trigger hoặc flow nào giả định "mọi Account đã có trước Contact
  đầu tiên" sẽ thấy khác. Số lời gọi gần như không đổi (lô vẫn gần đầy 200).
- **Chỉ giữ Id cần thiết.** Sau mỗi cửa sổ chỉ giữ Id (và lỗi) của alias có Lookup trỏ tới (cùng pool phía sau một bước
  Chọn bản ghi) và của các dòng xem trước; khoảng 100 B/bản ghi. Chế độ JSON một cục vẫn trả mọi Id.
- **Dừng sớm khi lỗi hàng loạt.** Nếu 3 lô đầu của một sObject đều lỗi 100 % thì ngừng gửi (`stopped.reason: "allFailing"`):
  thường là thiếu field bắt buộc, validation rule… nên không spam org với hàng trăm lô giống nhau. Lô lỗi sau khi sObject đó đã
  có lô thành công thì không tính (có thể là lỗi theo dữ liệu, ví dụ trùng). `stopped.records` chỉ đếm bản ghi Salesforce đã
  từ chối trong các lô đó, không đếm bản ghi con bị bỏ qua vì cha lỗi.
  **sObject thưa:** "lô" là một lời gọi, không phải 200 bản ghi. Một sObject chỉ có vài bản ghi trong mỗi cửa sổ 2 000 (ví dụ
  một Opportunity cho mỗi 50 Contact) được gửi thành những lô nhỏ, nên 3 lô đầu có thể chỉ là 3–10 bản ghi; nếu cả 3 đều lỗi
  thì lần chạy vẫn dừng (với mọi sObject). Đó là chủ ý: 3 lần lỗi 100 % liên tiếp ngay từ đầu gần như luôn là lỗi cấu hình.
- **Dừng bằng tay.** Nút **Dừng** (`POST /api/runs/:runId/cancel`) hoặc đóng tab / mất kết nối: inserter kiểm tra trước mỗi
  lô và luôn chờ lô đang gửi xong, nên số đã insert là chính xác. Bản ghi đã insert **vẫn ở lại** trong org (chưa có tính
  năng xóa); thông báo ghi rõ đã insert bao nhiêu bản ghi mỗi sObject. Chưa có "chạy tiếp" một lần đã dừng.
- **Lượt chạy thử trước khi ghi.** Trước khi gửi lô đầu, server sinh hết một lượt chỉ để đếm (khoảng 1 % thời gian insert);
  lỗi sinh dữ liệu (hết giá trị `unique`, vượt `maxRecords`) dừng lần chạy khi chưa ghi gì.
- **Lỗi gom nhóm.** `errorGroups` đếm đủ theo (sObject, bước, field, mẫu thông báo — Id và giá trị trong ngoặc kép bị che);
  tối đa 100 nhóm, phần còn lại cộng trong `errorGroupsOther`; `errors` chỉ giữ 1 000 lỗi đầu (`errorsTotal` là tổng). `field` = `fields.<Name>` khi Salesforce chỉ đúng một field có trong bước.
- Streaming **không** làm insert nhanh hơn: thời gian nằm ở API (0,5–2 s mỗi lô 200). Muốn nhanh hơn cần Bulk API 2.0 hoặc
  gửi song song (chưa làm).

Kết quả: `{ inserted, failed, errorsTotal, errors: [{ ref, sobject, nodeId, field?, message, parentRef? }], errorGroups,
errorGroupsOther, ids: { ref: Id }, bySobject, total, notSent, cancelled, stopped }` (chi tiết ở [workflow-schema.md](workflow-schema.md#kết-quả-apirun)).
`insertRecords(client, org, records)` vẫn có cho script: bọc `createInserter`, giữ mọi Id.

Bản ghi đọc từ org (bước Query) không bao giờ nằm trong `records` nên không bao giờ bị insert lại. Lookup tới chúng là chuỗi Id
thật, `collectRefs` không coi là phụ thuộc, nên bản ghi con được gửi ngay ở đợt đầu (`insert.js` không phải đổi).

## An toàn

Server hành động bằng quyền sf CLI của máy, nên phải chặn mọi thứ ngoài giao diện của chính nó:

- Mặc định chỉ bind `127.0.0.1` (đổi bằng `HOST`).
- **Chặn yêu cầu từ trang web khác** (CSRF, DNS rebinding) cho mọi `/api/*` — kể cả `GET /api/orgs…` (danh sách org,
  describe) và `/api/validate`, `/api/run`, `/api/runs/:id/cancel`, `/api/export`:
  - `Host` phải là máy này: `127.0.0.1`, `localhost`, `::1` hoặc giá trị `HOST` (bind `0.0.0.0`/`::` thì không kiểm tra Host).
    Trang dùng DNS rebinding gửi tên miền của nó nên bị từ chối.
  - `Origin` (nếu có) phải đúng `http://<Host>`; `Sec-Fetch-Site` (nếu có) phải là `same-origin` hoặc `none`.
    Sai ⇒ 403 `Từ chối yêu cầu từ trang web khác. Chỉ giao diện của app (cùng địa chỉ) mới được gọi API này.`
  - POST phải có `Content-Type: application/json` ⇒ không thì 415. Một trang khác chỉ gửi được `text/plain`, form hay
    multipart mà không qua CORS preflight, và server không trả header CORS nào, nên preflight cũng thất bại.
  - curl và script không gửi `Origin`/`Sec-Fetch-Site` nên vẫn gọi được (`-H 'Content-Type: application/json'`).
- Ghi vào org chỉ qua `/api/run` với `target.kind === 'org'`, sau hộp xác nhận ở UI.

## Đọc dữ liệu (Query)

Bước Query ([0006](design/0006-query-pick-nodes.md)) đọc bản ghi có sẵn **trước** khi executor chạy (`server/sf/query.js`,
`prefetchQueries`); executor vẫn thuần và chỉ nhận các dòng đã đọc.

- **Chỉ đọc.** `client.query(org, soql, { maxFetch, timeoutMs })` gọi `conn.query(soql, { autoFetch: true, maxFetch })` của
  jsforce: endpoint REST `/query`, tự theo `nextRecordsUrl` (queryMore) tới `maxFetch` dòng (LIMIT của builder, tối đa 2 000).
  Không bao giờ đặt `scanAll` (sẽ thành `queryAll`, trả cả bản ghi đã xóa). SOQL tự viết phải bắt đầu bằng `SELECT`; ở **bất
  kỳ đâu** ngoài chuỗi ký tự (kể cả trong ngoặc và subquery), cả ở SOQL tự viết lẫn ô WHERE / ORDER BY của builder, không được
  có `FOR UPDATE / VIEW / REFERENCE`, không có từ `UPDATE` (`UPDATE VIEWSTAT`, `UPDATE TRACKING` ghi số liệu vào org), không có
  dấu `;`, không có `{{…}}`; ô WHERE / ORDER BY phải đủ cặp ngoặc (kiểm tra ở `shared/soql.js` khi validate, và kiểm lại
  ngay trước khi gọi Salesforce). `LIMIT 0` không gọi Salesforce. Tối đa 20 bước Query, mỗi query 30 giây, cả lần đọc trước
  tối đa 120 giây (`queryTotalMs`; quá thì dừng với lỗi gắn bước Query kế tiếp, chưa ghi gì) — `LIMITS` trong
  `server/workflow/nodes.js`. Timeout không hủy được jsforce: trang đang tải có thể vẫn về và bị bỏ.
- **Tên field không phân biệt hoa thường** (như Salesforce): các dòng được đổi khóa theo cách viết trong SELECT
  (`SELECT id, name` → `{ id, name }`), và tham chiếu tới bản ghi đọc từ org (`{{acc.Name}}`, ô lọc của Chọn bản ghi) bỏ qua
  hoa thường.
- **Org nào.** Xem trước: org đang chọn ở thanh trên (`org` trong request), không chọn thì 5 dòng mẫu (không gọi Salesforce).
  Insert: luôn đọc `target.org`, không bao giờ dùng dòng mẫu. Các query chạy tuần tự theo thứ tự đọc, bỏ bước đang tắt.
- **Cache.** Trong bộ nhớ, khóa `(org, SOQL, maxFetch)` với org là **instance URL + username** lấy từ sf CLI (hai alias của
  cùng org dùng chung, alias trỏ sang org khác thì không dùng lại), TTL 10 phút (`queryCacheTtlMs`), tối đa 50 mục. Xem trước rồi insert
  ngay dùng **cùng** các dòng (nên trong 10 phút insert không phát hiện được thay đổi trong org; hộp xác nhận nói rõ điều này). "⟳ Đọc lại" (Ctrl+Shift+Enter) gửi `refreshQueries: true` để bỏ qua cache. Insert vào một org
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
