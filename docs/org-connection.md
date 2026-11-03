# Kết nối org

## Lấy thông tin org

App không tự làm OAuth. Việc được chia làm hai phần:

- **sf CLI chỉ dùng để lấy thông tin đăng nhập** (`server/sf/cli.js`):

  | Việc | Lệnh | Hàm |
  | --- | --- | --- |
  | Danh sách org | `sf org list --json` | `listOrgs()` |
  | Access token, instance URL, API version, `orgId` | `sf org display --target-org <alias> --json` | `getConnection()`; cache trong bộ nhớ 10 phút (xóa thì luôn đọc lại, xem [Xóa](#xóa-dữ-liệu-đã-insert)) |

- **Mọi lời gọi API đi qua [jsforce](https://jsforce.github.io/)** (`server/sf/client.js`). Mỗi org có một `jsforce.Connection`,
  được tạo từ `accessToken`, `instanceUrl` và `version` mà CLI trả về, và nhớ định danh org của lần đọc đó (`orgOf`). Mỗi insert
  và mỗi lần xóa bắt đầu bằng `refreshOrg`: đọc lại `sf org display` và dựng lại Connection, nên bản ghi luôn vào đúng org mà
  Lịch sử ghi; không biết `orgId` / username thì không insert. Làm mới token mà ra org khác ⇒ lời gọi lỗi (`ORG_CHANGED`).

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
| `GET /api/orgs/:org/sobjects/:name` | Describe đã map sang field spec (`server/sf/describe-map.js`): `{ sobject, label, nameField, fields }`; `nameField` (0012) là field có `nameField: true` trong describe (`Name`, `Subject`, `CaseNumber`…) hoặc `null` |
| `GET /api/orgs/:org/limits` | Hạn mức 24 giờ (`conn.limits()`, chỉ đọc): `{ api: { max, remaining }, bulkBatches }`; cache 60 giây, quá 3 giây ⇒ 504. Cho hộp xác nhận Insert (chỉ cảnh báo, không chặn) |
| `GET /api/orgs/:org/sobjects/:name/fields` | **Mọi** field (`name`, `label`, `type`, `referenceTo`, `relationshipName`, `filterable`, `sortable`) và `nameField`; thứ tự `Id`, name field, rồi theo nhãn. Cho hộp "Chọn field…" |

### Map describe sang field

- Bỏ qua field không createable, formula, auto number, và các kiểu `id`, `address`, `base64`, ….
- Gợi ý `mode` theo tên: `FirstName`, `LastName`, `*City`, `Name` (Account → company).
- `required` = không nillable và không có giá trị mặc định khi tạo; UI chọn sẵn các field này khi import.
- Lookup: master-detail nhận ra qua `relationshipOrder`. `ref` để trống; UI tự chọn bản ghi cha
  nếu chỉ có một bước Record phía trên khớp `referenceTo`.

### Field mặc định của bước Record ([0012](design/0012-nang-suat-soan-thao.md))

- Không cần org: bước Record mới và việc đổi sObject dùng `meta.recordPresets` của server (Task → `Subject`, Contact →
  `FirstName` + `LastName`…, [workflow-schema.md](workflow-schema.md#bước)); chỉ thay khi danh sách field **chưa bị sửa**
  (bằng preset của sObject cũ hoặc bằng danh sách vừa tự điền).
- Đã chọn org và sObject có trong danh sách sObject tạo được của org: 500 ms sau khi đổi sObject, inspector gọi describe
  (`GET /api/orgs/:org/sobjects/:name`, cache trong phiên); nếu danh sách vẫn là cái vừa tự điền thì thay bằng **mọi field bắt
  buộc tạo được** (cùng hàm với Import: Lookup bắt buộc tự chọn bản ghi cha theo luật Import, kể cả "＋ … có sẵn trong org"
  thêm bước Query), không có field bắt buộc ⇒ `nameField`; toast `Đã đặt field mặc định cho Task theo dev-sb: Subject.` Không có
  bước undo riêng: Ctrl+Z bỏ việc đổi sObject cũng trả lại danh sách field.
- Workflow cũ có `Name` trên sObject `noName` (Task, Contact…): cảnh báo `noNameField` với nút `Đổi thành Subject`.

### Khung "Thiếu field bắt buộc" ([0012](design/0012-nang-suat-soan-thao.md) F2)

Khi một bước Record được chọn, đã chọn org và sObject có trong org: inspector so field bắt buộc của describe (`required`) với
field đã có (không phân biệt hoa thường) và hiện trên danh sách field
`Thiếu 2 field bắt buộc của Opportunity trong dev-sb: StageName, CloseDate.` [Thêm 2 field] [Chọn…] [Bỏ qua]. "Thêm" dùng đúng
hàm của Import (một bước undo); "Chọn…" mở hộp Import với nhóm `Bắt buộc, chưa có (n)` đứng đầu, đã tích; "Bỏ qua" ẩn khung của
bước đó tới khi tải lại trang. Describe lỗi / sObject không có: không hiện gì. Không vào thanh lỗi (validate ở server chạy không
cần org). Cache describe của phiên xóa khi bấm ⟳ danh sách org.

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
  lô và luôn chờ lô đang gửi xong, nên số đã insert là chính xác. Bản ghi đã insert **vẫn ở lại** trong org; thông báo ghi rõ
  đã insert bao nhiêu bản ghi mỗi sObject và chúng xóa được bằng "Xóa dữ liệu này…" hoặc trong [Lịch sử](#lịch-sử-insert).
  Không có "chạy tiếp" một lần đã dừng (0011: thay bằng xóa rồi insert lại).
- **Lượt chạy thử trước khi ghi.** Trước khi gửi lô đầu, server sinh hết một lượt chỉ để đếm (khoảng 1 % thời gian insert);
  lỗi sinh dữ liệu (hết giá trị `unique`, vượt `maxRecords`) dừng lần chạy khi chưa ghi gì.
- **Lỗi gom nhóm.** `errorGroups` đếm đủ theo (sObject, bước, field, mẫu thông báo — Id và giá trị trong ngoặc kép bị che);
  tối đa 100 nhóm, phần còn lại cộng trong `errorGroupsOther`; `errors` chỉ giữ 1 000 lỗi đầu (`errorsTotal` là tổng). `field` = `fields.<Name>` khi Salesforce chỉ đúng một field có trong bước.
- Streaming **không** làm insert nhanh hơn: thời gian nằm ở API (0,5–2 s mỗi lô 200). Bulk API 2.0 (bên dưới) giảm số lời
  gọi cho bản ghi lá; không gửi Collections song song (0011, Đã chốt 5).

Kết quả: `{ inserted, failed, errorsTotal, errors: [{ ref, sobject, nodeId, field?, message, parentRef? }], errorGroups,
errorGroupsOther, ids: { ref: Id }, bySobject, total, notSent, cancelled, stopped }` (chi tiết ở [workflow-schema.md](workflow-schema.md#kết-quả-apirun)).
`insertRecords(client, org, records)` vẫn có cho script: bọc `createInserter`, giữ mọi Id.

### Bulk API 2.0 ([0011](design/0011-thao-tac-du-lieu-org.md))

- **Bước nào.** `planInsert` (`shared/insert-plan.js`, dùng chung với hộp xác nhận) chọn bước Record sinh ≥ `bulkMinRecords`
  (10 000) bản ghi mà alias **không** có Lookup nào trỏ tới (kể cả qua Chọn bản ghi): Bulk trả `successfulResults` không theo
  thứ tự nên không map được Id về `ref`. `target.bulk: "off"` (bỏ chọn checkbox trong hộp xác nhận) tắt cho một lần chạy.
- **Lô thử.** Bản ghi của bước Bulk vẫn đi sObject Collections cho tới khi bước có một lời gọi thành công, nên lỗi cấu hình
  vẫn bị bắt bằng quy tắc "3 lô đầu lỗi 100 %" (có `ref`) và không mở job nào cho bước hỏng.
- **Job.** Sau đó bản ghi sẵn sàng của bước thành dòng CSV (`server/sf/bulk-csv.js`: `$ref` đã thay bằng Id thật; null là ô
  trống, boolean `true`/`false`, cột = hợp các field) gom tới `bulkJobRecords` (10 000) thì thành một job `insert`
  (`lineEnding: LF`, `columnDelimiter: COMMA`). **Một job mỗi lúc**, chạy song song với các lời gọi Collections (job chỉ có bản
  ghi lá nên thứ tự cha trước con giữ nguyên); bộ đệm thứ hai đầy thì chờ job trước xong. Theo dõi bằng `check()` (2 s, nhân
  1,5, tối đa 15 s; không dùng `job.poll()` vì timeout 30 s của jsforce quá ngắn), tối đa `bulkJobTimeoutMs` (30 phút, quá ⇒
  `stopped.reason: "bulkTimeout"`, job ghi lại để lấy Id sau).
- **Kết quả.** Mỗi `sf__Id` thành công được ghi vào Lịch sử (không có `ref`); dòng lỗi phân tích `sf__Error`
  (`CODE:thông báo:Field --`) thành cùng thông báo, nhóm và `field` như SaveResult, `ref` điền khi nội dung dòng khớp đúng một
  dòng đã tải lên. Job `Failed`: mọi bản ghi chưa thành công là lỗi. Hai job liên tiếp của một bước lỗi 100 % ⇒
  `stopped.reason: "bulkFailing"`. Không tạo được job (sObject không hỗ trợ…) ⇒ bước đó gửi bằng Collections, có cảnh báo;
  `REQUEST_LIMIT_EXCEEDED` / lỗi mạng thì mọi bản ghi của job tính là lỗi.
- **Dừng / Dừng ngay.** Dừng không gửi lô hay job mới; job đang tải lên bị hủy ngay (chưa xử lý gì); job đã đóng được **chờ
  xong** rồi lấy kết quả (tiến độ `stopping` với `waitingBulk`). Dừng ngay (`cancel` với `{ "force": true }`) hủy job, chờ
  `Aborted` rồi cố lấy `successfulResults`; không lấy được thì Lịch sử ghi `idsUnknown`. Đóng tab = Dừng.
- **Ước tính.** Bước Collections `ceil(n / 200)` lời gọi; bước Bulk `1 + jobs × 12` (tạo, tải, đóng, ~7 lần theo dõi, 2 lần lấy
  kết quả). 40 000 Account + 160 000 Contact: 393 thay vì 1 000. Thời gian của Bulk chưa đo trên org thật.
- **Rủi ro còn lại:** ô trống trong CSV và kết quả của job đã hủy cần kiểm trên sandbox thật; trigger có thể gây
  `UNABLE_TO_LOCK_ROW` (help của checkbox nói cách tắt).

Bản ghi đọc từ org (bước Query) không bao giờ nằm trong `records` nên không bao giờ bị insert lại. Lookup tới chúng là chuỗi Id
thật, `collectRefs` không coi là phụ thuộc, nên bản ghi con được gửi ngay ở đợt đầu (`insert.js` không phải đổi).

## Lịch sử insert

Mỗi lần insert (kể cả bị Dừng, tự dừng, lỗi) được ghi vào file trên **máy chạy server** (`server/history.js`), không ở trình
duyệt: thư mục `$SFDG_DATA_DIR/history`, không đặt thì Linux `$XDG_DATA_HOME/sf-data-generator/history` (mặc định
`~/.local/share/…`), macOS `~/Library/Application Support/sf-data-generator/history`, Windows `%APPDATA%\sf-data-generator\history`;
thư mục `0700`, file `0600`.

- `<hid>.json` (org, workflow lúc insert, seed, `now`, số đếm theo bước, job Bulk, nhóm lỗi, trạng thái xóa), `<hid>.ids.csv`
  (`sobject,step,ref,id`, chỉ nối thêm), `<hid>.deleted.csv` (`id,outcome`). `hid` khớp `^h\d{8}T\d{6}Z-[0-9a-f]{6}$`;
  không khớp ⇒ 404, không bao giờ thành đường dẫn.
- **Tạo trước lời gọi ghi đầu tiên**; không tạo được (thư mục không ghi được, Lịch sử tắt) ⇒ lần chạy kết thúc với lỗi, chưa
  ghi gì. Id được nối vào file **sau mỗi lời gọi** (và mỗi lần lấy kết quả job) và chờ ghi xong trước lời gọi ghi tiếp theo;
  ghi lỗi ⇒ dừng insert (`stopped.reason: "history"`). Mã job Bulk được ghi trước khi tải CSV lên.
- Lúc khởi động, mục còn `running` thành `interrupted` (`inserted` đếm lại từ file Id).
- Giữ `historyMaxRuns` (100) lần và `historyMaxBytes` (256 MB): khi tạo mục mới chỉ tự dọn mục cũ nhất **không còn gì trong
  org** (đã xóa hết, không có bản ghi, không còn job Bulk chưa đọc), không bao giờ mục đang chạy. Chỉ còn mục có bản ghi mà đã
  đầy ⇒ insert bị từ chối (`HISTORY_FULL`), hộp xác nhận báo trước qua `GET /api/history/status`.
- Một server mỗi thư mục: `history/.lock` giữ pid (server khác đang chạy ⇒ Lịch sử tắt). Thư mục hay file là symlink hoặc
  thuộc user khác thì không dùng (`lstat` + uid).
- **Không bao giờ lưu credential hay dòng Query**: org chỉ là `alias`, `username`, `orgId`, `instanceUrl`, `kind`.
- UI: nút **Lịch sử** ở đầu panel kết quả, link **Tải Id** / **Lịch sử** trong tóm tắt, mục `Lịch sử insert` của menu ⋯
  (≤ 900 px). "Quên lần insert này" chỉ xóa 3 file trên máy (có xác nhận).

## Xóa dữ liệu đã insert

`POST /api/history/:hid/delete` (`server/sf/delete.js`) là cách **duy nhất** app xóa trong org, và chỉ xóa Id có trong
`<hid>.ids.csv` của chính mục đó (không nhận Id hay SOQL từ client, không xóa bản ghi Query, không bao giờ `hardDelete`):

- **Kiểm tra trước** (trước header và lời gọi ghi đầu tiên; đóng tab trong lúc này ⇒ không xóa gì): mục có trong Lịch sử,
  không đang insert, không có lần xóa khác của mục (khóa giữ ngay khi request tới), `confirm.username`
  đúng username lúc insert, `confirm.count` đúng số còn phải xóa, org production (hoặc sf CLI không cho biết loại) thì
  `confirm.typedOrg` phải là alias hoặc username, và `sf org display` **đọc lại** cho alias phải ra cùng `orgId` (thiếu thì cùng
  instance URL + username) như lúc insert; kết nối jsforce được dựng lại từ chính lần đọc này (`client.refreshOrg`).
- **Thứ tự:** bước theo thứ tự ngược bản ghi đầu tiên của bước (con trước cha), trong bước ngược thứ tự insert. Bước còn
  < 10 000 Id (hoặc `bulk: "off"`): `conn.sobject(type).destroy(ids)` 200 Id mỗi lời gọi (sObject Collections `DELETE`,
  `allOrNone` mặc định false). Nhiều hơn: lô thử bằng `destroy`, rồi job Bulk `delete` 10 000 Id mỗi job, một job mỗi lúc.
- `ENTITY_IS_DELETED`, `INVALID_CROSS_REFERENCE_KEY`, `NOT_FOUND` ⇒ "đã không còn" (không phải lỗi). Lỗi khác gom nhóm như insert;
  3 lời gọi đầu của một sObject lỗi 100 % (thường thiếu quyền Delete) ⇒ dừng. `DELETE_FAILED` được thử lại một lần cuối.
- Job Bulk insert chưa lấy kết quả (lần chạy bị gián đoạn, job `Failed` có thể xử lý một phần) được lấy `successfulResults`
  (chỉ đọc) trước khi xóa, **chỉ khi** `check()` cho thấy job đã kết thúc; job chưa xong thì để lại, kết quả nói thử lại sau.
- Bản ghi vào Thùng rác; xóa cha có thể làm Salesforce xóa dây chuyền bản ghi con (hộp xác nhận nói rõ). Dừng / Dừng ngay
  như insert; phần còn lại xóa được bằng "Xóa phần còn lại…".

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
- Ghi vào org chỉ qua `/api/run` với `target.kind === 'org'`, sau hộp xác nhận ở UI; xóa chỉ qua
  `POST /api/history/:hid/delete`. Bảng đủ ([0011](design/0011-thao-tac-du-lieu-org.md) §8):

  | Endpoint | Tác dụng lên org | Chặn |
  | --- | --- | --- |
  | `POST /api/run` với `target.kind === 'org'` | Ghi (Collections, job Bulk `insert`) | `requestGuard`; hộp xác nhận; lượt chạy thử; mục Lịch sử phải tạo được |
  | `POST /api/history/:hid/delete` | Xóa (`destroy`, job Bulk `delete`), chỉ Id trong Lịch sử | `requestGuard`; `confirm` (username, số còn lại; production: tên org gõ tay) do server so lại; `orgId` hiện tại = lúc insert; không đang insert/xóa. Bị từ chối thì 0 lời gọi ghi (test) |
  | `POST /api/runs/:runId/cancel` (`force`) | Dừng; `force` hủy job Bulk | `requestGuard` |
  | `GET /api/orgs/:org/limits` | Chỉ đọc | `requestGuard` |
  | `GET /api/history…`, `POST /api/history/:hid/forget` | Không gọi org (đọc / xóa file) | `requestGuard` (trang khác không đọc được Id) |

- Mã nguồn: chỉ `server/sf/client.js` gọi `create` / `destroy` / `bulk2` của jsforce, và `bulkJob` chỉ nhận `insert` hoặc
  `delete` (khác ⇒ throw trước mọi request); chỉ `server/sf/insert.js` và `server/sf/delete.js` gọi `client.create` /
  `destroy` / `bulkJob` (`test/safety.test.js` quét mã nguồn).

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

Chưa làm: upsert / update theo External Id (cần lưu giá trị cũ để hoàn tác; design riêng, xem 0011).

Lưu ý proxy: jsforce đọc `https_proxy` / `HTTPS_PROXY` khi khởi động và **không** xét `NO_PROXY`. Sau proxy công ty thì cứ đặt
`HTTPS_PROXY` như bình thường.
