# Kết nối org

## Lấy thông tin org

App không tự làm OAuth. Việc được chia làm hai phần:

- **sf CLI chỉ dùng để lấy thông tin đăng nhập** (`server/sf/cli.js`):

  | Việc | Lệnh | Hàm |
  | --- | --- | --- |
  | Danh sách org | `sf org list --json` | `listOrgs()` |
  | Access token, instance URL, API version, username, org Id (`id`, 0011) | `sf org display --target-org <alias> --json` | `getConnection()`; cache trong bộ nhớ 10 phút (`refresh` đọc lại) |

- **Mọi lời gọi API đi qua [jsforce](https://jsforce.github.io/)** (`server/sf/client.js`). Mỗi org có một `jsforce.Connection`,
  được tạo từ `accessToken`, `instanceUrl` và `version` mà CLI trả về.

Khi Salesforce trả `INVALID_SESSION_ID` (token hết hạn), jsforce gọi `refreshFn`. Hàm này chạy lại `sf org display`
(CLI tự làm mới token từ thông tin đăng nhập nó đang giữ), rồi jsforce gọi lại request đó. Token mới thuộc org Id hoặc username
khác kết nối đang dùng ⇒ bị từ chối (`Org "…" bây giờ là org khác …`), request không được gửi lại (sửa sau review 0011, S1).
Kết nối jsforce được giữ theo **danh tính** (instance URL + username + org Id mà CLI trả), không theo alias: alias trỏ sang
org khác (đăng nhập lại sau khi refresh sandbox) dùng kết nối mới.

**Org thật là ai** (`client.whoami`, S1; sửa sau review lần 2, mục 9): hỏi qua **chính kết nối sẽ ghi**, không chỉ tin CLI:
org Id và user Id **tách từ đường dẫn** của URL `identity` trong REST root (`GET /services/data/vXX.X`; URL đó trỏ tới
login.salesforce.com nên app không bao giờ gọi nó, token không bao giờ nằm trong URL), username bằng một câu
`SELECT Username FROM User WHERE Id = '<userId>'` trên instance (Id đã kiểm định dạng). Insert ghi danh tính này vào Lịch sử;
khác điều CLI nói (hoặc không lấy được) ⇒ lần insert kết thúc lỗi trước mọi lời gọi ghi: `Không xác định được org "dev" (…), nên
chưa ghi gì vào org. Đăng nhập lại: sf org login web --alias dev rồi chạy lại.` (S5). Xóa đọc lại CLI (`refresh`) rồi hỏi identity
trước khi kiểm tra org.

**Kết nối ghi được ghim** (review lần 2, mục 1): `whoami` trả một `session`; inserter và `deleteRun` gửi mọi `create` / `destroy` /
`bulkJob` qua đúng kết nối đó, nên alias có bị trỏ sang org khác giữa chừng thì phần còn lại vẫn vào org đã kiểm (không lời gọi nào
tới org mới). `refreshFn` **từ chối khi không biết org Id** của token mới, hoặc org Id / username khác điều đã kiểm; khi đó phiên
chết hẳn và lần chạy dừng với `stopped.reason: "orgChanged"` (`Org "dev" bây giờ là org khác (…) so với kết nối đang dùng (…).
Không gửi tiếp. Chạy lại thao tác này.`); xóa không ghi Id nào là "đã không còn" vì chuyện này. Lỗi từ Salesforce được trả về
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
| `GET /api/orgs/:org/limits` | Hạn mức 24 giờ của org (0011, chỉ đọc `/limits`): `{ api: { max, remaining }, bulkBatches: { max, remaining } }`; cache 60 s, quá 3 s ⇒ 504 |
| `GET /api/history`, `GET /api/history/:hid`, `GET /api/history/:hid/ids.csv`, `POST /api/history/:hid/forget`, `POST /api/history/:hid/delete` | Lịch sử insert và xóa dữ liệu đã insert (0011), xem [Lịch sử](#lịch-sử-insert-0011) và [Xóa](#xóa-dữ-liệu-đã-insert-0011) |
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
  lô và luôn chờ lô đang gửi xong, nên số đã insert là chính xác. Bản ghi đã insert **vẫn ở lại** trong org; Id của chúng nằm
  trong [Lịch sử](#lịch-sử-insert-0011) và xóa được bằng [Xóa](#xóa-dữ-liệu-đã-insert-0011). Không có "chạy tiếp" một lần đã
  dừng (0011: xóa rồi insert lại).
- **Lượt chạy thử trước khi ghi.** Trước khi gửi lô đầu, server sinh hết một lượt chỉ để đếm (khoảng 1 % thời gian insert);
  lỗi sinh dữ liệu (hết giá trị `unique`, vượt `maxRecords`) dừng lần chạy khi chưa ghi gì.
- **Lỗi gom nhóm.** `errorGroups` đếm đủ theo (sObject, bước, field, mẫu thông báo — Id và giá trị trong ngoặc kép bị che);
  tối đa 100 nhóm, phần còn lại cộng trong `errorGroupsOther`; `errors` chỉ giữ 1 000 lỗi đầu (`errorsTotal` là tổng). `field` = `fields.<Name>` khi Salesforce chỉ đúng một field có trong bước.
- Streaming **không** làm insert nhanh hơn: thời gian nằm ở API (0,5–2 s mỗi lô 200). Bước lớn không có Lookup trỏ tới đi
  Bulk API 2.0 (dưới đây); không gửi Collections song song (0011 "Đã chốt" 5).

Kết quả: `{ inserted, failed, errorsTotal, errors: [{ ref, sobject, nodeId, field?, message, parentRef?, bulkJobId? }], errorGroups,
errorGroupsOther, ids: { ref: Id }, bySobject, byStep, total, notSent, cancelled, stopped, historyId, bulk, bulkJobs,
bulkAborted, bulkUnknown, warnings }` (chi tiết ở [workflow-schema.md](workflow-schema.md#kết-quả-apirun)).
`insertRecords(client, org, records)` vẫn có cho script: bọc `createInserter`, giữ mọi Id.

Bản ghi đọc từ org (bước Query) không bao giờ nằm trong `records` nên không bao giờ bị insert lại. Lookup tới chúng là chuỗi Id
thật, `collectRefs` không coi là phụ thuộc, nên bản ghi con được gửi ngay ở đợt đầu (`insert.js` không phải đổi).

### Bulk API 2.0 ([0011](design/0011-thao-tac-du-lieu-org.md) §1–3)

- **Bước nào đi Bulk** (`planInsert` của `shared/insert-plan.js`, cùng hàm cho sự kiện `plan` và hộp xác nhận): bước Record sinh
  ≥ `LIMITS.bulkMinRecords` (10 000) bản ghi trong lần chạy, alias **không** có Lookup nào trỏ tới (kể cả qua Chọn bản ghi), và
  `target.bulk` khác `"off"`. Bulk trả `successfulResults` không theo thứ tự nên không map được Id về `ref`; bản ghi "cha" luôn
  đi sObject Collections.
- **Lô thử:** bản ghi của bước Bulk vẫn đi Collections cho tới khi bước đó có một lời gọi thành công (thường là 200 bản ghi đầu),
  nên lỗi cấu hình vẫn bị bắt bằng quy tắc 3 lô đầu (không job nào được mở) và có `ref` chính xác.
- **Job:** bản ghi sẵn sàng (Lookup đã có Id thật) thành dòng CSV (`server/sf/bulk-csv.js`: cột = hợp field của bản ghi trong
  job, `null` là ô trống, boolean `true`/`false`, ô có `"` `,` xuống dòng thì đặt trong ngoặc kép; LF) gom thành job 10 000
  dòng (`LIMITS.bulkJobRecords`). **Một job cùng lúc**, chạy song song với các lời gọi Collections của bước khác; bộ đệm đầy
  thì chờ job trước xong. Vòng đời qua `client.bulkJob` (jsforce `conn.bulk2.createJob`, `operation: 'insert'`): mở → tải CSV →
  `UploadComplete` → `check()` mỗi 2 s × 1,5 tới 15 s (`server/sf/bulk-job.js`, không dùng `job.poll()` vì timeout 30 s của
  jsforce), tối đa 30 phút → đọc `successfulResults` / `failedResults` dạng CSV thô (`bulk-csv.js` tự đọc: parser của jsforce
  tách ô ở cả `;`, `|`, tab).
- **Kết quả:** mỗi `sf__Id` thành công được ghi Lịch sử (không có `ref`) và cộng `inserted`; mỗi dòng lỗi phân tích `sf__Error`
  thành cùng dạng SaveResult (cùng câu, cùng nhóm lỗi, cùng `field`), `ref` có khi nội dung dòng khớp đúng một dòng đã tải lên,
  không thì lỗi có `bulkJobId`.
- **Job `Failed`:** mọi dòng không có kết quả tính là lỗi với câu `Job Bulk <id> (<sObject>) thất bại: …`. Hai job liên tiếp
  của một bước lỗi 100 % ⇒ dừng (`stopped.reason: "bulkFailing"`). Không mở được job (`INVALIDENTITY`, `FEATURE_NOT_ENABLED`…)
  ⇒ phần còn lại của bước đi Collections, kèm cảnh báo; `REQUEST_LIMIT_EXCEEDED`, lỗi mạng ⇒ các dòng của job lỗi (không đổi
  đường). Quá 30 phút ⇒ `stopped.reason: "bulkTimeout"` (job có thể vẫn chạy trong org; mã job nằm trong Lịch sử).
- **Dừng** chờ job đang xử lý xong (số đếm và Id chính xác), hủy job còn đang tải lên (`Open`, chưa có gì được xử lý); bộ đệm
  chưa gửi tính vào `notSent`. **Dừng ngay** (`cancel` với `{ "force": true }`) hủy job đang xử lý (`Aborted`) rồi thử đọc kết
  quả; đọc được ⇒ `bulkAborted.idsKnown: true`, không ⇒ `idsKnown: false`, số bản ghi đã xử lý nằm trong `bulkUnknown`. Đóng
  tab = Dừng.
- **Không đọc được kết quả** (lỗi mạng, job hủy chưa có kết quả, job `Failed`): job giữ `idsCollected: false` trong Lịch sử
  (không bao giờ bị coi là "mất Id" vĩnh viễn) và lần xóa sau đọc lại nó trước (S3). Đọc được `successfulResults` mà không đọc được
  `failedResults` ⇒ Id thành công vẫn được ghi, phần còn lại vào `bulkUnknown` kèm cảnh báo. Mọi bản ghi của một job luôn nằm
  đúng một trong `inserted`, `failed`, `notSent`, `bulkUnknown` (N7). `check()` lỗi tạm thời được thử lại 2 lần (1 s, 2 s; N2).
  Job Salesforce mở phải đúng `operation`/`object` đã yêu cầu, không thì bị hủy trước khi tải dữ liệu (N3).
- **Đóng job lỗi** (mất câu trả lời của `close()`, hoặc hủy job bị từ chối): server hỏi lại trạng thái job (`check()`). Job vẫn
  `Open` hoặc đã `Aborted` ⇒ chưa có gì vào org, các dòng tính là lỗi như trước. Trạng thái khác (đã đóng, đang xử lý, xong)
  hoặc không hỏi được ⇒ job ghi `state: "Unknown"`, `idsCollected: false`, các dòng vào `bulkUnknown` (không phải lỗi), lần
  chạy dừng (`stopped.reason: "bulkError"`), và lần xóa sau đọc kết quả của job đó.
- **Không ghi được Id vào Lịch sử** sau một job (đĩa đầy…): job giữ `idsCollected: false` để lần xóa sau đọc lại kết quả của
  nó; lần chạy dừng với `stopped.reason: "history"`.
- **Tiến độ:** `progress` (`insert`) có `bulk: { nodeId, sobject, jobId, job, jobs, processed, failed, records, state }`;
  `inserted` đã cộng `processed − failed` của job đang chạy (số tạm). Đang Dừng mà còn job: `{ "type": "progress", "phase":
  "stopping", "waitingBulk": { jobId, sobject, nodeId, processed, records } }`.

## Lịch sử insert (0011)

`server/history.js`. Mỗi lần insert (kể cả Dừng, tự dừng, lỗi) có một mục trên **máy chạy server**, để tải lại Id và xóa
dữ liệu: server chỉ xóa Id chính nó đã ghi, không bao giờ nhận danh sách Id từ client.

- **Thư mục:** `SFDG_DATA_DIR` nếu có; không thì Linux `$XDG_DATA_HOME/sf-data-generator` (mặc định
  `~/.local/share/sf-data-generator`), macOS `~/Library/Application Support/sf-data-generator`, Windows
  `%APPDATA%\sf-data-generator`; Lịch sử ở `<thư mục>/history/` (quyền `0700`, file `0600`).
- **File:** `<hid>.json` (thông tin lần chạy, ghi lại toàn bộ qua file tạm + `fsync` + rename), `<hid>.ids.csv`
  (`sobject,step,ref,id`, chỉ nối thêm, `fsync` sau mỗi lần nối), `<hid>.deleted.csv` (`id,outcome`, `deleted` | `gone`). `hid` =
  `h<yyyyMMdd>T<HHmmss>Z-<6 hex>`; `hid` sai định dạng ⇒ 404 (không path traversal). File CSV được đọc bằng parser RFC 4180 thật
  (ô trong ngoặc kép giữ nguyên xuống dòng) và **không bao giờ ghi ô có xuống dòng** (ghi như vậy bị từ chối ⇒ insert dừng với
  `stopped.reason: "history"`); id bước chỉ gồm chữ, số, `_`, `-`, không bắt đầu bằng `-`, là chuỗi (sửa sau review B1 và lần 2;
  UI tự sửa id sai khi mở file, nhập file thư viện, dán).
- **Một server mỗi thư mục** (N6; review lần 2, mục 4): `<thư mục>/history/.lock` giữ pid, tạo bằng file tạm có sẵn pid rồi
  `link()` (không bao giờ có khóa rỗng do mình tạo). Khóa có pid còn sống (kể cả pid đã bị chương trình khác dùng lại) hoặc khóa
  rỗng mới hơn 5 giây ⇒ Lịch sử tắt với câu `Một server sf-data-generator khác (pid …) đang dùng thư mục Lịch sử …. Dừng server đó,
  hoặc đặt SFDG_DATA_DIR khác cho server này. Nếu không còn server nào khác, xóa file <thư mục>/history/.lock`, nên insert / xóa /
  quên trả 503. Khóa cũ (pid đã chết, hoặc rỗng quá 5 giây) được đổi tên sang bên, kiểm lại, rồi mới lấy.
- **Dọn sau sự cố** (N5; review lần 2, mục 5): file tạm còn sót bị xóa; file Id không có `.json` chỉ bị xóa khi chỉ có dòng tiêu
  đề, còn có Id thì được giữ và hiện trong danh sách với `status: "corrupt"`; `.json` rỗng hoặc hỏng cũng vậy. Mục có `.json`
  hỏng tính vào giới hạn số lần và chỉ bị dọn (trước mọi mục khác) sau 7 ngày; file Id **không có** `.json` không bao giờ bị dọn
  tự động (không tính vào giới hạn), chỉ "Quên" mới xóa nó. Câu của mục `corrupt` ghi đường dẫn đầy đủ của file và việc cần làm;
  `⤓ Id` (`ids.csv`) và "Quên" dùng được cho mục này, xóa thì không (404: không biết org). Ghi `.json` còn `fsync` thư mục sau
  khi rename (trừ Windows). Ổ không hỗ trợ `link()` (EPERM, ENOSYS, EXDEV…): khóa tạo bằng `open(…, 'wx')` rồi ghi pid; các file
  `.lock.stale-*` còn sót được dọn khi lấy khóa. Khóa bị server khác giữ: câu không kèm lời khuyên `SFDG_DATA_DIR` thừa
  (`locked: true` trong `GET /api/history`).
- **Khi nào ghi:** mục được tạo sau lượt chạy thử, ngay trước sự kiện `plan`. **Lịch sử tắt ⇒ `/api/run` với org trả 503 trước
  khi chạy** (`Không ghi được Lịch sử (…), nên chưa ghi gì vào org. Kiểm tra quyền ghi thư mục … hoặc đặt SFDG_DATA_DIR.`, cả chế
  độ JSON; S7); tạo mục lỗi lúc chạy ⇒ lần chạy kết thúc với `error`, `insert: null`, chưa ghi gì vào org. Id của mỗi lời gọi Collections và mỗi job
  Bulk được nối vào file và **chờ ghi xong trước lời gọi ghi tiếp theo**; ghi lỗi ⇒ dừng (`stopped.reason: "history"`). Mã job
  Bulk được ghi trước khi tải CSV lên. Xem trước không bao giờ tạo mục.
- **Không bao giờ lưu credential:** chỉ `alias`, `username`, `orgId`, `instanceUrl`, `kind` (`sandbox` | `scratch` |
  `production` | `unknown`, theo `sf org list`); không token, không header, không dòng Query.
- **Trạng thái:** `running` | `done` | `cancelled` | `stopped` | `error` | `interrupted` (server tắt giữa lúc insert: lần dùng
  Lịch sử đầu tiên sau khi khởi động đổi `running` thành `interrupted` và đếm lại Id từ file).
- **Giới hạn:** `LIMITS.historyMaxRuns` = 100 lần, `LIMITS.historyMaxBytes` = 256 MB; khi tạo mục mới, dọn **mọi** mục không còn
  bản ghi trong org (đã xóa hết, không insert được gì) trước bất kỳ mục nào còn bản ghi (job Bulk chưa lấy Id cũng tính là còn),
  cũ nhất trước trong mỗi nhóm; không bao giờ dọn mục đang chạy. Sắp phải dọn một mục còn bản ghi ⇒ sự kiện `plan` có
  `warnings: [{ code: "historyPruned", historyId, message }]` (S4).
- **API:** `GET /api/history` (`{ enabled, reason?, dir, maxRuns, runs, prune }`; `prune`: mục lần insert tới sẽ dọn dù còn bản ghi, để hộp xác nhận Insert cảnh báo trước), `GET /api/history/:hid` (bỏ `workflow`, thêm
  `remaining`, `pendingBulkJobs`), `GET /api/history/:hid/ids.csv[?sobject=]` (`sobject,id,ref,step,status`; ô bắt đầu bằng
  `=` `+` `-` `@` được thêm `'` để bảng tính không chạy như công thức, N10), `POST /api/history/:hid/forget` (409 khi đang chạy,
  đang xóa hoặc đang quên ở tab khác; N1). Chi tiết ở [workflow-schema.md](workflow-schema.md#lịch-sử-insert-và-xóa-0011).

## Xóa dữ liệu đã insert (0011)

`POST /api/history/:hid/delete` → `server/sf/delete.js` (`deleteRun`). Chỉ xóa Id có trong `<hid>.ids.csv`, vào Thùng rác
(không bao giờ `hardDelete`).

- **Kiểm tra trước** (mọi kiểm tra chạy trước khi gửi header và trước lời gọi ghi đầu tiên; bị từ chối thì org không nhận request
  ghi nào): Lịch sử ghi được (503); mục có thật; không đang insert, xóa hay quên ở tab khác (409); body có `confirm: { username,
  count }` (400); `confirm.username` = username lúc insert (409); org của alias bây giờ — identity của kết nối sau khi đọc lại
  CLI — cùng `orgId` (thiếu thì cùng instance URL) **và cùng username** với lúc insert, và CLI cùng ý với identity (409; không
  lấy được org ⇒ 502 kèm `sf org login web --alias …`); org production hoặc không biết loại ⇒ `confirm.typedOrg` phải là alias
  hoặc username (không phân biệt hoa thường, bỏ khoảng trắng hai đầu) (400).
- **`confirm.count` giới hạn những gì bị xóa** (S2): job Bulk insert chưa lấy Id (lần chạy `interrupted`, kết quả chưa đọc được)
  được đọc **trước** (chỉ đọc: `check` + `successfulResults`, Id chưa có mới được nối vào file và cộng vào `inserted` của mục),
  rồi mới so số: không còn gì ⇒ 409 `Lần insert này không còn bản ghi nào để xóa.` (kèm tên job còn đang chạy nếu có); khác số
  ⇒ 409 `Số bản ghi cần xóa đã đổi thành N vì vừa lấy được Id từ job Bulk. Xác nhận lại.` (body có `count: N`, `collected`)
  hoặc `Số bản ghi còn phải xóa đã đổi (…)` (`count`), và không xóa gì. `GET /api/history/:hid` có `pendingBulkJobs` để hộp xác
  nhận nói trước.
- **Chỉ Id của chính các bước của lần insert** (B1): dòng của file Id có bước không thuộc mục, hay sObject khác sObject của bước,
  bị bỏ và được báo: `rejected` trong `GET /api/history/:hid` (kèm `rejectedMessage`), trong kết quả xóa (kèm câu `N dòng trong file
  Id không thuộc bước nào của lần insert này (file có thể đã bị sửa), không xóa.` trong `warnings`), và số "còn lại" của danh sách
  cũng chỉ đếm dòng hợp lệ (review lần 2, mục 3). Trước khi gửi một bước, mọi Id của bước phải cùng **tiền tố 3 ký tự** và đúng
  `keyPrefix` của sObject theo describe (đọc qua client); sai ⇒ không gửi Id nào của bước đó, `result.skipped: [{ nodeId, sobject,
  count, reason }]`. Các kiểm tra này bắt file hỏng hoặc lẫn dòng; chúng **không** chống được người cố ý sửa file bằng Id hợp lệ cùng
  sObject: thứ bảo vệ file Lịch sử là quyền `0700`/`0600` của thư mục trên máy chạy server.
- **Thứ tự:** các bước theo thứ tự ngược lúc insert (con trước cha), trong bước Id theo thứ tự ngược.
- **Cách gửi:** bước còn < 10 000 Id (hoặc `bulk: "off"`): `client.destroy` 200 Id mỗi lời gọi (`DELETE /composite/sobjects`).
  Bước lớn hơn: `destroy` tới khi có một lời gọi thành công, rồi job Bulk `operation: 'delete'` (CSV một cột `Id`) 10 000 Id mỗi
  job, một job mỗi lúc; Bulk không mở được job ⇒ phần còn lại bằng `destroy`.
- **Kết quả từng Id:** `deleted`; `gone` khi `ENTITY_IS_DELETED`, `INVALID_CROSS_REFERENCE_KEY`, `NOT_FOUND` (đã xóa bằng tay,
  đã trong Thùng rác, bị xóa dây chuyền) — không phải lỗi; lỗi khác gom nhóm như insert. Mỗi lô kết quả nối vào
  `<hid>.deleted.csv` và chờ ghi xong. Id lỗi `DELETE_FAILED` được thử lại **một** lần sau cùng. 3 lời gọi xóa đầu của một sObject
  đều lỗi 100 % ⇒ dừng (`stopped.reason: "allFailing"`, `stopped.text`: kiểm tra quyền Delete; với `DELETE_FAILED` thì nói còn
  bản ghi liên quan trỏ tới chúng, N8).
- Job Bulk chưa trả Id vì còn đang chạy: `result.pendingBulkJobs: [{ jobId, sobject, state, reason }]` (N4); bản ghi của nó không
  nằm trong lần xóa này. Trước khi đọc Id của một job chờ, Salesforce phải xác nhận job là `insert` đúng sObject của bước (không
  phân biệt hoa thường) và do user của phiên tạo (`createdById` = user Id của `whoami`; review lần 2, mục 7). Job không khớp, hoặc
  job / kết quả đã bị Salesforce xóa (404), được đánh dấu `idsLost: true`: không còn tính là đang chờ, không tính vào "còn lại" hay
  việc dọn, và có câu hướng dẫn (`Id của job … không còn đọc được (Salesforce xóa kết quả sau 7 ngày); tìm bản ghi trong Setup → Bulk
  Data Load Jobs hoặc theo CreatedDate, rồi xóa bằng tay nếu cần.`) trong `lostBulkJobs` của `GET /api/history/:hid` và của kết quả
  xóa (mục 6). Mục biến mất giữa lúc xóa (bị xóa khỏi thư mục) ⇒ dừng sau lời gọi đang gửi, 404 (hoặc sự kiện `error`)
  `Lần insert này không còn trong Lịch sử (…), nên đã dừng xóa. …` và không tạo lại file (N11).
- **Dừng / Dừng ngay** như insert; Id chưa gửi vẫn "còn trong org" và xóa được bằng lần xóa sau ("Xóa phần còn lại…").

## Giao diện của Lịch sử và xóa (0011 bước 9–10)

`client/js/history.js` (hộp Lịch sử, hộp xác nhận xóa, trạng thái Lịch sử), `client/js/main.js` (hộp xác nhận Insert, tiến độ
insert/xóa, toast), `client/js/results.js` (link, nút, tab "Lỗi xóa").

- **Không có Lịch sử thì không insert:** khi đã chọn org, UI đọc `GET /api/history`; `enabled: false` ⇒ nút **Insert** khóa,
  `title` và một toast (một lần) nói thư mục, lỗi và cách sửa (`SFDG_DATA_DIR` rồi khởi động lại server). `/api/run` vẫn tự trả 503;
  UI đọc lại trạng thái khi nhận 503.
- **Hộp xác nhận Insert:** checkbox `Dùng Bulk API 2.0 cho bước từ 10 000 bản ghi` (chỉ khi có bước đủ điều kiện, mặc định bật,
  không nhớ), một dòng mỗi bước Bulk (tối đa 5), số lời gọi từ `planInsert` (đổi checkbox tính lại ngay), `Org còn R/M lời gọi API
  trong 24 giờ.` từ `/api/orgs/:org/limits` (≤ 3 s, cache 60 s; lỗi thì bỏ dòng, ước tính vượt thì `.warn-box`, không khóa nút),
  dòng Lịch sử, `.warn-box` cho mỗi mục `prune`. Focus đầu ở **Hủy**. Gửi `target.bulk`.
- **Khi chạy:** tóm tắt thêm `· Bulk: <sObject> job i/k`; sau Dừng, sự kiện `stopping` đổi nút thành **Dừng ngay** (gửi
  `cancel` với `force`, rồi `Đang hủy job Bulk…`). Lỗi của `cancel` (ví dụ 403 khi server nghe mọi địa chỉ mà mở app bằng tên lạ)
  hiện nguyên câu của server. `plan.warnings` `historyPruned` thành toast.
- **Khi xong:** tóm tắt có link **⤓ Id** (`/api/history/:hid/ids.csv`, tên file do server đặt) và **Lịch sử**; mọi kết thúc có bản
  ghi trong org có toast ≥ 10 s với nút **Xóa dữ liệu này…**. Câu kết thúc theo `stopped.reason` (`allFailing`, `bulkFailing`,
  `history`, `bulkTimeout`, `bulkError`, `orgChanged`…), `bulkAborted`, `bulkUnknown`.
- **Hộp Lịch sử** (nút ghost `Lịch sử` ở đầu panel kết quả — icon 32 px ở ≤ 720 px —, link trong tóm tắt, mục `Lịch sử insert`
  của menu ⋯): lọc theo org đang chọn (mặc định bật), mỗi lần chạy một hàng (≤ 720 px: hai dòng, hộp toàn màn hình), chi tiết khi
  bấm (số theo bước, job Bulk, `pendingBulkJobs` kể cả `idsLost`, `rejected`, lỗi insert, lần xóa gần nhất), `⤓ Id`,
  `Xóa khỏi org…` / `Xóa phần còn lại…` (khóa khi lần đó đang chạy), `⋯ → Quên lần insert này` (hỏi trước; nút phụ). Mục
  `corrupt` hiện câu của server, không có nút.
- **Hủy hoặc Esc khi đang "Đang gửi…"** (server còn kiểm tra org): request bị hủy trước khi có header, server thấy client đã rời và
  không xóa gì (không đọc job Bulk, không đánh dấu mục). Trong lúc một lần xóa đã gửi chưa xong, không mở được hộp xóa khác hay
  chạy Xem trước / Insert; bấm "Xóa…" ở hai dòng liên tiếp thì dòng bấm sau cùng thắng. Server đòi gõ tên org mà hộp chưa có ô
  (loại org đổi): 400 có `needTypedOrg: true, kind`, hộp hiện ô gõ tên.
- **Hộp xác nhận xóa:** số còn phải xóa theo sObject (con trước), loại org theo `GET /api/orgs` lúc mở (org không còn trong sf CLI ⇒
  khóa; CLI lỗi ⇒ coi như production), production / không rõ loại ⇒ ô gõ tên org (alias hoặc username, không phân biệt hoa thường),
  Thùng rác, xóa dây chuyền (khi lần insert có hơn một sObject), job Bulk chưa lấy Id, checkbox Bulk, số lời gọi từ `planDelete`.
  Focus đầu ở **Hủy**, nút `Xóa N bản ghi` là `.danger.solid`. Gửi `confirm: { username, count, typedOrg? }`. Bị từ chối trước khi
  xóa (400/404/409/502/503) ⇒ câu của server trong hộp; 409 có `count` mới ⇒ nút đổi thành số mới và phải bấm lại (không bao giờ tự
  gửi lại).
- **Xóa chạy trong panel kết quả** như insert (Xem trước / Insert khóa, Dừng, Dừng ngay khi có job Bulk, `beforeunload`): `Đang xóa
  khỏi …: n/N (p %) · lỗi k` + chip theo sObject. Xong: toast theo §6 của thiết kế, kèm `collected`, `skipped`, `pendingBulkJobs`,
  câu `warnings` của server; có lỗi thì tab `Lỗi xóa (n)`.

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
  - **Bind mọi địa chỉ** (`HOST=0.0.0.0` hoặc `::`): Host không còn được so với danh sách, nên các yêu cầu ghi/xóa org (`/api/run`
    với `target.kind === 'org'`, `POST /api/history/:hid/delete`, `…/forget`, `POST /api/runs/:runId/cancel` có `force`) chỉ
    nhận `Host` là địa chỉ IP, `localhost` hoặc tên máy (`os.hostname()`); tên miền khác ⇒ 403 `Từ chối ghi hoặc xóa dữ liệu org
    qua địa chỉ "<host>". …` (sửa sau review 0011, S6: tên miền của trang DNS rebinding không bao giờ là IP hay tên máy). Xem
    trước, đọc describe… vẫn như cũ.
- Ghi vào org chỉ qua `/api/run` với `target.kind === 'org'`, sau hộp xác nhận ở UI.
- **Endpoint ghi / xóa** ([0011](design/0011-thao-tac-du-lieu-org.md) §8):

  | Endpoint | Tác dụng lên org | Chặn |
  | --- | --- | --- |
  | `POST /api/run` với `target.kind === 'org'` | Ghi (Collections, job Bulk `insert`) | các kiểm tra trên; lượt chạy thử trước khi ghi; cần tạo được mục Lịch sử |
  | `POST /api/history/:hid/delete` | Xóa (`destroy`, job Bulk `delete`), chỉ Id trong Lịch sử | các kiểm tra trên; `confirm` khớp server; cùng org Id và username; production phải gõ tên org; không đang chạy |
  | `POST /api/runs/:runId/cancel` (`force`) | Dừng; `force` hủy job Bulk | các kiểm tra trên |
  | `GET /api/orgs/:org/limits` | Chỉ đọc | các kiểm tra trên |
  | `GET /api/history…`, `POST /api/history/:hid/forget` | Không gọi org (đọc / xóa file) | các kiểm tra trên (trang khác không đọc được danh sách Id) |

  Không endpoint nào nhận danh sách Id hay SOQL để xóa. Chỉ `server/sf/client.js` gọi `create` / `destroy` / `bulk2` của
  jsforce; chỉ `server/sf/insert.js` và `server/sf/delete.js` gọi `client.create` / `client.destroy` / `client.bulkJob`;
  `client.bulkJob` chỉ nhận `operation` `insert` hoặc `delete` (khác ⇒ throw trước mọi request). `test/safety.test.js` quét mã
  nguồn để khóa các điều này.

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
- **Org nào.** Xem trước: org đang chọn ở thanh trên (`org` trong request), không chọn thì 5 dòng mẫu (không gọi Salesforce;
  field dùng làm số lần lặp hay trọng số có giá trị `1…5`, [0013](design/0013-mo-rong-bien-va-lap.md) F).
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

Chưa làm: upsert / update theo External Id (0011 quyết định không làm trong đợt này).

Lưu ý proxy: jsforce đọc `https_proxy` / `HTTPS_PROXY` khi khởi động và **không** xét `NO_PROXY`. Sau proxy công ty thì cứ đặt
`HTTPS_PROXY` như bình thường.
