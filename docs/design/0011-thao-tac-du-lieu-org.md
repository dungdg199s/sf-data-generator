# 0011 — Thao tác dữ liệu trên org: Bulk API 2.0, lịch sử insert, xóa dữ liệu đã insert

- **Trạng thái:** Đã duyệt (người dùng giao chọn theo phương án đề xuất; xem [Đã chốt](#đã-chốt))
- **Ngày:** 2026-10-28
- **Liên quan:** [0002](0002-jsforce-api.md) (jsforce, sf CLI chỉ lấy token), [0004](0004-streaming-execution.md) (insert theo
  cửa sổ, Dừng, nhóm lỗi; câu hỏi mở 6 và 7), [0006](0006-query-pick-nodes.md) (Query chỉ đọc, cache, dấu vân tay),
  [0008](0008-ui-design-system.md) (token, nút, hộp thoại), [0009](0009-bo-cuc-man-hinh.md) (đầu panel kết quả, thanh trên),
  [org-connection.md](../org-connection.md) (mục "Insert", "An toàn"), [workflow-schema.md](../workflow-schema.md)

## Vấn đề

Ba việc người dùng đang phải làm bằng tay hoặc không làm được:

1. **Insert lớn chậm và tốn lời gọi API.** 40 000 Account × 4 Contact = 200 000 bản ghi cần 1 000 lời gọi sObject
   Collections, ước tính 8–33 phút ([0004 §2](0004-streaming-execution.md#2-số-đo-từ-prototype)). Org Developer Edition chỉ có
   15 000 lời gọi API mỗi 24 giờ, nên ba lần chạy như vậy đã tốn 1/5 hạn mức trong ngày.
2. **Không lấy lại được Id đã insert.** Ở chế độ NDJSON (UI luôn dùng), `insert.ids` chỉ có Id của 200 dòng xem trước mỗi
   sObject. Muốn biết 160 000 Contact vừa tạo là Id nào thì phải tự viết SOQL theo `CreatedDate`, dễ lẫn với dữ liệu của
   người khác trong cùng sandbox.
3. **Không xóa được dữ liệu vừa insert.** Insert nhầm workflow (thiếu field, sai org) hoặc bấm Dừng giữa chừng thì
   "các bản ghi này vẫn còn trong org" (câu của 0004) và người dùng phải sang Data Loader hay Developer Console để dọn. Đây là
   chỗ dễ xóa nhầm dữ liệu thật nhất.

Ngoài ra còn ba câu hỏi chưa có câu trả lời: chạy tiếp một lần insert đã dừng, Update/Upsert theo External Id, gửi song song.

## Mục tiêu / Ngoài phạm vi

- Mục tiêu:
  - **Bulk API 2.0 tự bật** cho bước Record có nhiều bản ghi mà không bước nào cần Id của chúng (bản ghi "lá"), không cần
    cấu hình; tắt được cho một lần chạy ngay trong hộp xác nhận.
  - **Lịch sử insert** trên máy chạy server: mỗi lần insert (kể cả bị dừng, tự dừng, lỗi) ghi org, thời gian, seed, `now`,
    số đếm và **mọi Id đã insert**; tải Id thành CSV.
  - **Xóa dữ liệu của một lần insert**: con trước cha sau, dùng Bulk cho tập lớn, chịu được bản ghi đã bị xóa hay bị sửa,
    luôn qua hộp xác nhận ghi rõ org và số bản ghi, cảnh báo riêng và gõ tên org với production.
  - Quyết định có lý do cho: chạy tiếp, Update/Upsert, gửi song song, nâng `maxRecordsHard`.
- Ngoài phạm vi:
  - Xóa bản ghi không do app insert (bản ghi đọc bằng Query, bản ghi tạo bằng tay). App **chỉ** xóa đúng các Id nó đã ghi
    vào Lịch sử.
  - `hardDelete` (bỏ qua Thùng rác), Update, Upsert, chạy tiếp lần đã dừng, gửi song song nhiều lô sObject Collections.
  - Bulk cho bản ghi có Lookup trỏ tới (bản ghi "cha"): kết quả Bulk không theo thứ tự nên không map được Id về `ref` (xem
    [Phương án](#phương-án-đã-cân-nhắc)).
  - Thay đổi workflow JSON (không có khóa mới).

## Luồng người dùng

### A. Insert lớn (Bulk tự bật) — 2 thao tác, như hiện nay

1. Bấm **⤒ Insert vào org** (1). App tự xem trước nếu cần (0004).
2. Hộp xác nhận có thêm dòng Bulk, số lời gọi API ước tính, hạn mức còn lại của org và dòng Lịch sử. Bấm
   **Insert 200 000 bản ghi** (1).
3. Panel kết quả hiện tiến độ; dòng tóm tắt ghi `Bulk: Contact job 3/16`. Xong thì toast
   `Đã insert 200 000 bản ghi vào dev-sb.` kèm nút **Xóa dữ liệu này…**.

### B. Tải Id vừa insert — 1 thao tác

1. Bấm link **⤓ Id** trong dòng tóm tắt của panel kết quả (1). File `Account_Contact-20261028-1032-ids.csv` có cột
   `sobject,id,ref,step,status`.

### C. Xóa ngay dữ liệu vừa insert (nhầm org, nhầm workflow) — 2 thao tác (production: +1 gõ tên org)

1. Bấm **Xóa dữ liệu này…** trên toast, hoặc link **Lịch sử** trong tóm tắt rồi **Xóa khỏi org…** ở dòng đầu (1).
2. Hộp xác nhận xóa ghi org, số bản ghi theo sObject, thứ tự xóa, chuyện Thùng rác và xóa dây chuyền. Production: gõ tên
   org vào ô (1 lần gõ). Bấm **Xóa 200 000 bản ghi** (1).
3. Panel kết quả hiện tiến độ xóa, có **Dừng**. Xong: toast `Đã xóa 200 000 bản ghi khỏi dev-sb (vào Thùng rác).`

### D. Dọn dữ liệu của một lần insert cũ — 3 thao tác

1. Bấm **Lịch sử** ở đầu panel kết quả (1). Hộp Lịch sử mở, lọc sẵn theo org đang chọn.
2. Bấm **Xóa khỏi org…** ở dòng cần dọn (1), rồi xác nhận (1).

### E. Trường hợp lỗi

- **Dừng khi đang có job Bulk:** Dừng không gửi lô mới; job Bulk đang xử lý được chờ cho xong để số đếm và Id chính xác.
  Tóm tắt: `Đang chờ job Bulk Contact đang chạy xong (6 200/10 000) rồi dừng…`, nút đổi thành **Dừng ngay**. Bấm Dừng ngay
  thì hủy job; Salesforce giữ những bản ghi đã xử lý.
- **Bulk không hỗ trợ sObject** (tạo job bị từ chối): bước đó tự gửi bằng sObject Collections, kết quả có cảnh báo.
- **Alias trỏ sang org khác** so với lúc insert (ví dụ đăng nhập lại `dev-sb` vào sandbox mới refresh): xóa bị từ chối trước
  khi gọi bất cứ API ghi nào.
- **Thiếu quyền Delete:** 3 lời gọi xóa đầu của một sObject đều lỗi 100 % ⇒ tự dừng, câu lỗi nói kiểm tra quyền.
- **Bản ghi đã bị xóa** (bằng tay, hoặc bị xóa dây chuyền khi xóa cha): đếm là "đã không còn", không phải lỗi.
- **Server tắt giữa lúc insert:** khi khởi động lại, lần chạy đó hiện `Bị gián đoạn`; các Id đã ghi vẫn tải và xóa được.
- **Không ghi được Lịch sử** (thư mục không ghi được, đầy đĩa): hộp xác nhận insert báo trước; nếu lỗi ghi xảy ra giữa
  chừng thì insert dừng sau lô đang gửi, để không có bản ghi nào trong org mà app không biết Id.

## Thiết kế UI

Mọi thành phần dùng token và biến thể sẵn có của [ui-design-system.md](../ui-design-system.md) (0008): nút `.danger` (viền)
mở xác nhận, `.danger.solid` là nút xác nhận cuối, `.warn-box` cho production, `.link` cho link trong tóm tắt, bảng theo
§6.10, hộp thoại theo §6.11. Bố cục panel kết quả giữ đúng 0009 §4: một hàng `[Kết quả ▾] [tóm tắt] [nút]`, lúc chạy ô
`[nút]` là **Dừng**.

### 1. Hộp xác nhận Insert (thêm vào hộp của 0004/0006)

```
Insert vào org?
Org: dev-sb (me@example.com)
[warn-box production — giữ nguyên]
Sẽ tạo 200 000 bản ghi: Account 40 000, Contact 160 000.
Giống hệt bản xem trước (seed 42).
[dòng Query của 0006 — giữ nguyên]
[✓] Dùng Bulk API 2.0 cho bước từ 10 000 bản ghi                                     (mới)
    con (Contact) 160 000: 200 bản ghi đầu gửi thử bằng sObject Collections, phần còn lại 16 job Bulk.
Khoảng 393 lời gọi API (sObject Collections 201, Bulk khoảng 192), tính vào giới hạn API 24 giờ của org.   (đổi)
Org còn 14 200/15 000 lời gọi API trong 24 giờ.                                       (mới)
Lần insert được ghi vào Lịch sử trên máy này (danh sách Id) để tải Id hoặc xóa lại sau.  (mới)
Có thể bấm "Dừng" bất cứ lúc nào; bản ghi đã insert không tự xóa nhưng xóa được trong Lịch sử.   (đổi)
                                                        [Hủy]  [Insert 200 000 bản ghi]
```

| Phần | Quy tắc |
| --- | --- |
| Checkbox Bulk | Chỉ hiện khi ít nhất một bước đủ điều kiện (xem [Kế hoạch insert](#1-kế-hoạch-insert-bước-nào-đi-bulk)). Mặc định **bật**. Nhãn `Dùng Bulk API 2.0 cho bước từ 10 000 bản ghi` (số lấy từ `limits.bulkMinRecords` của `/api/meta`). `title`/help dưới: `Nhanh hơn và ít lời gọi API hơn. Chỉ áp cho bước không có Lookup nào trỏ tới, vì Bulk trả Id không theo thứ tự. Bỏ chọn nếu org có trigger hay gặp lỗi khóa bản ghi (UNABLE_TO_LOCK_ROW).` Đổi checkbox thì dòng số lời gọi tính lại ngay. Không nhớ giữa các lần (mỗi lần mở là bật) |
| Dòng bước Bulk | Mỗi bước đủ điều kiện một dòng: `<alias> (<sObject>) <n>: 200 bản ghi đầu gửi thử bằng sObject Collections, phần còn lại <k> job Bulk.` Tối đa 5 dòng, phần còn lại `… và 3 bước khác`. Checkbox tắt thì các dòng này mờ (`text-muted`) |
| Số lời gọi | Tính bằng `planInsert` của `shared/insert-plan.js` (cùng hàm server dùng cho sự kiện `plan`) |
| Hạn mức org | `GET /api/orgs/:org/limits` gọi khi mở hộp (timeout 3 s, cache 60 s). Lỗi hay chậm thì bỏ dòng này, không chặn. Nếu ước tính > còn lại: `.warn-box` `Ước tính cần khoảng 1 000 lời gọi API nhưng org chỉ còn 640 trong 24 giờ. Insert có thể dừng giữa chừng với lỗi REQUEST_LIMIT_EXCEEDED. Bật Bulk API 2.0, giảm số bản ghi hoặc chờ hạn mức hồi lại.` (không khóa nút) |
| Dòng Lịch sử | Khi Lịch sử tắt (`GET /api/history` trả `enabled: false`) thay bằng `.warn-box`: `Không ghi được Lịch sử vào <thư mục>: <lỗi>. Lần insert này sẽ không tải Id hay xóa lại được qua app. Đặt biến môi trường SFDG_DATA_DIR tới một thư mục ghi được rồi khởi động lại server.` |

### 2. Panel kết quả khi insert có Bulk

```
┌ Kết quả ▾ │ Đang insert vào dev-sb: 82 400/200 000 (41 %) · lỗi 3 · Bulk: Contact job 6/16 · còn khoảng 6 phút  Account 40 000/40 000  Contact 42 400/160 000 │ [Dừng] ┐
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

| Giai đoạn | Tóm tắt (`#results-summary`) | Ô nút |
| --- | --- | --- |
| Insert, có job Bulk đang chạy | thêm `· Bulk: <sObject> job <i>/<k>` sau phần lỗi | **Dừng** (`button.danger`, tooltip của 0004) |
| Dừng, đang chờ job Bulk | `Đang chờ job Bulk Contact đang chạy xong (6 200/10 000) rồi dừng…` | **Dừng ngay** (`button.danger`), tooltip `Hủy job Bulk đang chạy. Bản ghi Salesforce đã xử lý vẫn ở lại trong org; app cố lấy Id của chúng để ghi vào Lịch sử.` |
| Đang hủy job | `Đang hủy job Bulk…` | Dừng ngay bị khóa |

Tiến độ của job lấy từ `numberRecordsProcessed`/`numberRecordsFailed` khi theo dõi job, nên thanh `<progress>` vẫn chạy
trong lúc job xử lý. "Còn khoảng" tính như 0004 trên tổng `inserted + failed`.

### 3. Khi insert xong

- Tóm tắt (sau chip sObject, seed, ms): `insert 200 000` (`success-text`), `lỗi 3` (`danger-text`), rồi hai link `.link`:
  **⤓ Id** (tải CSV Id của lần này, `title="Tải mọi Id đã insert của lần chạy này (CSV)"`) và **Lịch sử** (mở hộp Lịch sử,
  mở sẵn chi tiết lần này). Không có Lịch sử (tắt) thì không có hai link.
- Toast: giữ câu của 0004, thêm nút action **Xóa dữ liệu này…** khi `inserted > 0` (mọi kết thúc: xong, Dừng, tự dừng, lỗi).
  Toast có action sống ít nhất 10 s. Bấm nút mở [hộp xác nhận xóa](#5-hộp-xác-nhận-xóa) của lần này.
- Câu Dừng / tự dừng của 0004 đổi đuôi `Các bản ghi này vẫn còn trong org.` thành
  `Các bản ghi này vẫn còn trong org; xóa được bằng nút "Xóa dữ liệu này…" hoặc trong Lịch sử.`
- Câu "Mất kết nối" của 0004 thêm: `Xem Lịch sử để biết chính xác đã insert bao nhiêu khi server chạy xong.` (server vẫn chạy
  tới khi phát hiện client đã rời rồi dừng sau lô đang gửi, và ghi Lịch sử).
- Dừng ngay: `Đã hủy job Bulk Contact. Salesforce đã xử lý 6 200/10 000 bản ghi của job; Id của chúng đã ghi vào Lịch sử.`
  Nếu Salesforce không trả kết quả của job đã hủy: `… Salesforce không trả Id của các bản ghi này, nên app không xóa được
  chúng. Xem job 7504x00000AbCdE trong Setup → Bulk Data Load Jobs.`

### 4. Hộp Lịch sử insert

Mở từ: nút ghost **Lịch sử** ở ô `[nút]` của đầu panel kết quả (bên trái `Tải JSON`; ở ≤ 720 px là nút icon 32 px
`--ico-history`, `aria-label="Lịch sử insert"`, cạnh `⤓ Tải`; ẩn trong lúc chạy vì ô nút là Dừng), link **Lịch sử** trong tóm
tắt, và mục `Lịch sử insert` trong menu ⋯ (≤ 900 px, nhóm Chạy). Không thêm nút vào thanh trên (0009 đã tính bề rộng
thanh trên vừa 1 280 px). Không có phím tắt riêng (không phải việc lặp lại; Ctrl+H trùng phím của trình duyệt).

```
┌ Lịch sử insert ───────────────────────────────────────────────────────────────────────────────── [×] ┐
│ Lưu trên máy này tại ~/.local/share/sf-data-generator/history · giữ 100 lần insert gần nhất            │
│ [✓] Chỉ org đang chọn (dev-sb)                                                                          │
│ Thời gian    Org      Workflow           Bản ghi                Trạng thái                              │
│ 10:32 28/10  dev-sb   Account + Contact  200 000 · lỗi 3        Xong · Còn trong org  [⤓ Id] [Xóa khỏi org…] [⋯] │
│   ▾ Account 40 000 · Contact 160 000 (Bulk, 16 job) · seed 42 · 9 phút 12 giây · 0 nhóm lỗi            │
│ 09:15 28/10  dev-sb   Lead               12 400/50 000          Đã dừng · Đã xóa      [⤓ Id]            [⋯] │
│ 08:02 27/10  uat      Account + Contact  1 200                  Bị gián đoạn · Còn trong org [⤓ Id] [Xóa khỏi org…] [⋯] │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

| Phần | Quy tắc |
| --- | --- |
| Hộp | `<dialog class="history">` theo §6.11, rộng `min(960px, 100vw − 2 × --space-4)`, cao tối đa 80dvh, bảng cuộn bên trong. Esc / × đóng. Focus đầu tiên: checkbox lọc |
| Dòng đầu | `Lưu trên máy này tại <thư mục> · giữ <historyMaxRuns> lần insert gần nhất` (12 px `text-muted`). Lịch sử tắt: `.warn-box` câu như ở hộp xác nhận Insert, bảng trống |
| Lọc | Checkbox `Chỉ org đang chọn (<org>)`, mặc định bật khi đã chọn org; không chọn org thì ẩn và hiện tất cả. Không lưu |
| Bảng | Mới nhất trên cùng. Cột: Thời gian (`HH:mm dd/MM`, `title` đầy đủ), Org (alias, `title` = username · orgId · loại), Workflow (tên lúc insert), Bản ghi (`inserted` hoặc `inserted/total` nếu chưa gửi hết, ` · lỗi n` màu `danger-text`), Trạng thái (hai phần: lần chạy · dữ liệu), nút |
| Trạng thái lần chạy | `Đang insert` (đang chạy), `Xong`, `Đã dừng`, `Tự dừng (lỗi hàng loạt)`, `Lỗi`, `Bị gián đoạn` (`warning-text`, `title="Server dừng giữa lúc insert. Đã ghi được <n> Id; có thể thiếu Id của lô cuối hoặc job Bulk đang chạy."`) |
| Trạng thái dữ liệu | `Còn trong org`, `Đã xóa một phần (còn 600)`, `Đã xóa`, `Không có bản ghi nào trong org` (inserted = 0), `Đang xóa` |
| Nút mỗi dòng | `⤓ Id` (phụ, nhỏ 28 px; ẩn khi inserted = 0), `Xóa khỏi org…` (`.danger` viền; đã xóa một phần thì nhãn `Xóa phần còn lại…`; ẩn khi không còn gì; khóa khi lần chạy đang insert/xóa, `title="Lần insert này đang chạy."`), `⋯` (menu: `Quên lần insert này`) |
| Chi tiết | Bấm dòng hoặc Enter: mở/đóng `▾` chi tiết: số theo sObject (inserted, failed, đã xóa, đã không còn), bước dùng Bulk và mã job, seed, `now`, thời lượng, tối đa 5 nhóm lỗi (như tab "Lỗi insert"), lần xóa gần nhất |
| ≤ 720 px | Hộp toàn màn hình; mỗi lần chạy là hai dòng: `10:32 28/10 · dev-sb · Xong` / `Account + Contact · 200 000` rồi hàng nút |
| Quên | `confirm`-dialog: `Xóa lần insert này khỏi Lịch sử? Chỉ xóa ghi chép trên máy này, không xóa gì trong org. Sau đó sẽ không tải Id hay xóa dữ liệu của lần insert này qua app được nữa.` [Hủy] [Quên lần insert này] (nút phụ, không đỏ: không đụng org). Còn bản ghi trong org thì thêm câu `Lần này còn 200 000 bản ghi trong dev-sb.` |

### 5. Hộp xác nhận xóa

```
Xóa dữ liệu đã insert?
Org: dev-sb (me@example.com) · sandbox
[warn-box nếu production: "Org này là production (không phải sandbox hay scratch org). Gõ tên org để xác nhận: [ dev-prod ]"]
Sẽ xóa 200 000 bản ghi do lần insert lúc 10:32 ngày 28/10/2026 (workflow "Account + Contact") tạo ra:
Contact 160 000, Account 40 000. Xóa bản ghi con trước, bản ghi cha sau.
Chỉ xóa đúng các Id app đã ghi lúc insert, kể cả bản ghi đã bị sửa sau đó. Bản ghi đã bị xóa trước đó được bỏ qua.
Xóa bản ghi cha có thể làm Salesforce tự xóa bản ghi con của nó (ví dụ Contact, Opportunity của Account), kể cả bản ghi con không do app tạo.
Bản ghi bị xóa vào Thùng rác của org (khôi phục được trong 15 ngày nếu Thùng rác chưa đầy).
[✓] Dùng Bulk API 2.0 cho sObject từ 10 000 bản ghi
Khoảng 242 lời gọi API (sObject Collections 2, Bulk khoảng 240), tính vào giới hạn API 24 giờ của org.
Có thể bấm "Dừng" bất cứ lúc nào; bản ghi đã xóa nằm trong Thùng rác.
                                                        [Hủy]  [Xóa 200 000 bản ghi]
```

| Phần | Quy tắc |
| --- | --- |
| Nguồn số liệu | `GET /api/history/:hid` (số còn phải xóa theo sObject, tính từ file Id trừ Id đã xóa / đã không còn). Đây là số gửi lại trong `confirm.count` |
| Loại org | Theo `GET /api/orgs` **lúc mở hộp** (không theo lúc insert). Không tìm thấy org trong sf CLI: hộp hiện `.warn-box` `Org "dev-sb" không còn đăng nhập trong sf CLI. Chạy sf org login web --alias dev-sb rồi mở lại hộp này.` và nút xóa khóa. Không biết loại (lỗi CLI) coi như production |
| Production | Ô nhập trong `.warn-box`, `placeholder` = alias (hoặc username nếu không có alias), `aria-label="Gõ tên org để xác nhận xóa"`. Nút xóa khóa tới khi gõ đúng alias hoặc username (không phân biệt hoa thường, bỏ khoảng trắng hai đầu) |
| Dòng xóa dây chuyền | Chỉ hiện khi lần insert có bước được Lookup trỏ tới (có quan hệ cha con) |
| Checkbox Bulk | Như hộp Insert; ở đây áp cho **mọi** sObject còn ≥ `bulkMinRecords` bản ghi (xóa không cần map Id) |
| Nút | `Hủy` (phụ, **focus mặc định**), `Xóa <n> bản ghi` (`.danger.solid`). Đã xóa một phần: tiêu đề `Xóa phần còn lại?`, câu `Sẽ xóa 600 bản ghi còn lại …` |
| Lần chạy đang insert | Không mở được hộp (nút khóa, xem §4) |

### 6. Panel kết quả khi xóa

Xóa dùng cùng panel và cùng trạng thái "đang chạy" như insert (Xem trước, Insert khóa; Ctrl+Enter → toast
`Đang chạy. Bấm "Dừng" nếu muốn chạy lại.`; `beforeunload` khi đang xóa). Bảng dữ liệu của lần xem trước giữ nguyên.

| Giai đoạn | Tóm tắt |
| --- | --- |
| Đang xóa | `Đang xóa khỏi dev-sb: 12 400/200 000 (6 %) · lỗi 0 · còn khoảng 3 phút` + chip `Contact 12 400/160 000` `Account 0/40 000` |
| Dừng | `Đang dừng sau lô hiện tại…`; có job Bulk thì như §2 (`Dừng ngay`) |
| Xong | toast `Đã xóa 199 400 bản ghi khỏi dev-sb (vào Thùng rác). 600 bản ghi đã không còn trong org.` (vế sau chỉ khi > 0) |
| Có lỗi | toast `Đã xóa 199 000 bản ghi; 400 bản ghi không xóa được. Xem nhóm lỗi trong Lịch sử, sửa rồi bấm "Xóa phần còn lại…".` Tab `⚠ Lỗi xóa (n)` cùng kiểu tab "Lỗi insert" |
| Đã dừng | `Đã dừng. Đã xóa 12 400/200 000 bản ghi khỏi dev-sb; 187 600 bản ghi còn lại xóa được bằng "Xóa phần còn lại…" trong Lịch sử.` |

### 7. Thông báo (đúng câu chữ)

| Khi | HTTP | Câu |
| --- | --- | --- |
| Lần insert không có trong Lịch sử | 404 | `Không tìm thấy lần insert này trong Lịch sử (có thể đã bị dọn vì vượt giới hạn lưu trữ).` |
| `hid` sai định dạng | 404 | như trên |
| Xóa khi lần chạy đang insert | 409 | `Lần insert này đang chạy. Bấm "Dừng", chờ nó dừng rồi mới xóa.` |
| Đang có lần xóa khác của cùng lần insert | 409 | `Đang xóa dữ liệu của lần insert này ở một tab khác. Chờ lần đó xong.` |
| Thiếu `confirm` | 400 | `Thiếu xác nhận (org và số bản ghi). Chỉ xóa được từ hộp xác nhận của app.` |
| `confirm.username` khác Lịch sử | 409 | `Xác nhận ghi org "<username>" nhưng lần insert này thuộc org "<username lúc insert>". Mở lại hộp xác nhận.` |
| `confirm.count` khác số còn lại | 409 | `Số bản ghi còn phải xóa đã đổi (còn 199 400, hộp xác nhận ghi 200 000). Mở lại hộp xác nhận để xem số mới.` |
| Không còn gì để xóa | 409 | `Lần insert này không còn bản ghi nào để xóa.` |
| Production mà `confirm.typedOrg` sai/thiếu | 400 | `Org "dev-prod" là production: gõ đúng tên org trong hộp xác nhận để xóa.` |
| Org không còn đăng nhập | 502 | câu của sf CLI + `Đăng nhập lại: sf org login web --alias dev-sb` |
| Org khác lúc insert | 409 | `Org "dev-sb" bây giờ là org khác (00D…B, me2@example.com) so với lúc insert (00D…A, me@example.com). Không xóa gì. Đăng nhập lại đúng org bằng sf org login web --alias dev-sb rồi thử lại.` |
| Tự dừng xóa (3 lời gọi đầu lỗi 100 %) | `done` | `Đã dừng xóa: 3 lời gọi xóa Contact đầu tiên đều lỗi "INSUFFICIENT_ACCESS_OR_READONLY: …". Kiểm tra quyền Delete của user trên Contact. Chưa xóa bản ghi Contact nào.` |
| Job Bulk insert thất bại (`Failed`) | `done` (nhóm lỗi) | `Job Bulk 7504x… (Contact) thất bại: <errorMessage>. Bản ghi của job này chưa được insert. Bỏ chọn "Dùng Bulk API 2.0" trong hộp xác nhận để gửi bằng sObject Collections.` |
| Hai job Bulk liên tiếp của một bước lỗi 100 % | `done` (`stopped.reason: "bulkFailing"`) | `Đã dừng insert: 2 job Bulk Contact liên tiếp (20 000 bản ghi) đều lỗi "<thông báo đầu>". Sửa bước "con" rồi chạy lại. Đã insert …, xóa được trong Lịch sử.` |
| Job Bulk quá 30 phút | `done` (lỗi) | `Job Bulk 7504x… (Contact) chưa xong sau 30 phút nên app đã ngừng theo dõi và dừng lần chạy. Job có thể vẫn đang chạy trong org: xem Setup → Bulk Data Load Jobs. Lịch sử ghi lại mã job này.` |
| Bulk không hỗ trợ sObject (tạo job lỗi) | cảnh báo trong `done` | `Bước "con": Bulk API 2.0 không nhận Contact__x (<lỗi>), nên đã gửi bằng sObject Collections.` |
| Ghi Lịch sử lỗi lúc bắt đầu | `error`, `insert: null` | `Không ghi được Lịch sử (<lỗi>), nên chưa ghi gì vào org. Kiểm tra quyền ghi thư mục <thư mục> hoặc đặt SFDG_DATA_DIR.` |
| Ghi Lịch sử lỗi giữa chừng | `done` (`stopped.reason: "history"`) | `Không ghi được Id vào Lịch sử (<lỗi>) nên đã dừng insert, để không có bản ghi nào trong org mà app không biết Id. Đã insert 12 400 bản ghi; Id của chúng đã được ghi.` |

## Thiết kế phía server

### 1. Kế hoạch insert: bước nào đi Bulk

Hàm thuần mới `shared/insert-plan.js` (dùng ở server cho sự kiện `plan`, ở client cho hộp xác nhận, nên hai bên không lệch):

```js
export function planInsert({ steps, referenced, bulk = 'auto', limits })
// steps: [{ nodeId, alias, sobject, records }]  — từ stats.byStep của lượt chạy thử / bản xem trước, chỉ bước Record
// referenced: Set<alias>  — poolUsage(...).referenced (shared/scope.js), alias mà Lookup cần Id
// → { steps: [{ nodeId, sobject, mode: 'collections' | 'bulk', probe, jobs }], apiCalls: { collections, bulk, total } }
```

Một bước Record đi Bulk khi **cả ba** đúng:

1. `bulk !== 'off'` (checkbox trong hộp xác nhận, gửi trong `target.bulk`).
2. Alias của bước **không** thuộc `referenced` (không Lookup nào, kể cả qua Chọn bản ghi, cần Id của nó). Lý do: Bulk 2.0
   trả `successfulResults` **không theo thứ tự** của dữ liệu tải lên (jsforce ghi rõ "The order of records returned is not
   guaranteed"), và không có cột nào để map lại về `ref` (CSV không được có cột lạ; field External Id thì đòi org cấu hình).
3. Bước sinh ≥ `LIMITS.bulkMinRecords` (10 000) bản ghi trong lần chạy (số đúng từ lượt chạy thử).

Ước tính số lời gọi: bước collections `ceil(n / 200)`; bước Bulk `1` (lô thử) `+ jobs × 12`, với `jobs = ceil((n − 200) / 10 000)`
và 12 = tạo job 1 + tải CSV 1 + đóng job 1 + theo dõi khoảng 7 lần + lấy kết quả thành công 1 + lỗi 1.

### 2. Inserter với Bulk API 2.0 (`server/sf/insert.js`)

Giữ nguyên cửa sổ 2 000, wave, `keepId`, nhóm lỗi, dừng sớm của 0004. Thêm `createInserter(..., { plan, onInserted, bulk })`:

- **Lô thử bằng sObject Collections.** Bản ghi của bước Bulk vẫn đi đường cũ cho tới khi bước đó có **một lời gọi Collections
  thành công** (thường là 200 bản ghi đầu). Nhờ vậy lỗi cấu hình (thiếu field bắt buộc, validation rule) vẫn bị bắt bằng
  quy tắc "3 lô đầu lỗi 100 %" như hôm nay, lỗi có `ref` chính xác, và không mở job Bulk nào cho một bước hỏng.
- **Bộ đệm job.** Sau đó, trong mỗi wave, bản ghi sẵn sàng (mọi `$ref` đã có Id) của bước Bulk được chuyển thành dòng CSV
  (`toBulkCsv` trong `server/sf/bulk-csv.js`, dùng cùng `toSObject` để thay `$ref` bằng Id thật) và nối vào bộ đệm của bước.
  Bộ đệm đủ `LIMITS.bulkJobRecords` (10 000, khoảng 1,5 MB) thì gửi thành một job. Cuối dòng bản ghi, mọi bộ đệm còn lại
  được gửi (job cuối có thể nhỏ).
- **Một job Bulk cùng lúc, chạy song song với Collections.** Trong lúc job xử lý, inserter tiếp tục các cửa sổ sau (bản
  ghi cha qua Collections). Job tiếp theo chỉ được gửi khi job trước xong; nếu bộ đệm tiếp theo đầy trước đó thì inserter chờ
  (giới hạn bộ nhớ: tối đa 2 bộ đệm, khoảng 3 MB). Bản ghi Bulk là lá nên không bản ghi nào sau đó cần Id của chúng: chạy
  song song không đổi thứ tự cha trước con.
- **Vòng đời job** (qua `client.bulkJob`, xem §6): tạo job (`operation: 'insert'`, `lineEnding: 'LF'`, `columnDelimiter:
  'COMMA'`) → tải CSV → đóng (`UploadComplete`) → theo dõi bằng `check()` với khoảng chờ 2 s, nhân 1,5, tối đa 15 s (không dùng
  `job.poll()` vì timeout mặc định 30 s của jsforce quá ngắn), tối đa `LIMITS.bulkJobTimeoutMs` (30 phút) → `JobComplete`:
  lấy `successfulResults` và `failedResults`.
- **Kết quả.** Mỗi dòng thành công: `sf__Id` được ghi vào Lịch sử (`onInserted`, `ref` để trống) và cộng `inserted`. Mỗi dòng
  lỗi: phân tích `sf__Error` (`STATUS_CODE:thông báo:Field1,Field2 --`) thành cùng dạng thông báo với SaveResult
  (`STATUS_CODE: thông báo [Field]`), cùng khóa nhóm `errorPattern`, cùng quy tắc `field`; `nodeId` biết chắc (mỗi job chỉ
  chứa bản ghi của một bước). `ref` được điền khi nội dung dòng khớp **đúng một** dòng đã tải lên của job (so chuỗi CSV đã
  chuẩn hóa), không thì bỏ trống và lỗi có `bulkJobId`.
- **Job thất bại cả job** (`state: 'Failed'`): mọi bản ghi của job tính là lỗi với câu ở [bảng thông báo](#7-thông-báo-đúng-câu-chữ);
  vẫn lấy `successfulResults` nếu Salesforce trả (job có thể xử lý được một phần).
- **Dừng sớm cho Bulk:** hai job liên tiếp của cùng một bước lỗi 100 % ⇒ `stopped: { reason: 'bulkFailing', sobject, nodeId,
  message, jobs: 2, records }`.
- **Không tạo được job** (`INVALIDENTITY`, `FEATURE_NOT_ENABLED`, sObject không hỗ trợ Bulk…): chưa có gì được ghi, nên bước đó
  chuyển hẳn sang Collections cho phần còn lại và thêm cảnh báo. Lỗi `REQUEST_LIMIT_EXCEEDED` hay lỗi mạng thì không chuyển,
  mà dừng như lỗi lời gọi Collections.
- **Tiến độ:** sự kiện `progress` (phase `insert`) thêm `bulk: { nodeId, sobject, jobId, job: 6, jobs: 16, processed, failed,
  records }`; `inserted` cộng `processed − failed` của job đang chạy (số tạm, đúng lại khi có kết quả).
- **CSV:** cột = hợp các field của bản ghi trong job (sau `toSObject`, kể cả `__Latitude__s`/`__Longitude__s`), giá trị
  `null` là ô trống, boolean `true`/`false`, số như `String(n)`, ngày/giờ đúng chuỗi generator sinh ra, chuỗi có `"`, `,`,
  xuống dòng thì đặt trong ngoặc kép. Không bao giờ có cột ngoài field của bước (Salesforce từ chối cả job).

### 3. Dừng và hủy job

- **Dừng** (`POST /api/runs/:runId/cancel`, đóng tab) giữ nguyên ý nghĩa của 0004 — dừng sau việc đang làm, số đếm chính xác:
  không gửi lô Collections mới, không gửi job mới (bộ đệm chưa gửi tính vào `notSent`); job đang **tải lên** (`Open`) bị hủy
  ngay (chưa có gì được xử lý); job đã đóng (`UploadComplete`/`InProgress`) được **chờ xong** rồi lấy kết quả.
- **Dừng ngay** (`POST /api/runs/:runId/cancel` với body `{ "force": true }`): hủy job đang xử lý (`abort()`), chờ trạng thái
  `Aborted`, rồi **thử** lấy `successfulResults` để ghi Id. Lấy được ⇒ số đếm chính xác. Không lấy được ⇒ Lịch sử ghi job với
  `idsUnknown: true` và `processed` cuối cùng; kết quả có `cancelled: true`, `bulkAborted: { jobId, processed, idsKnown }`.
- Đóng tab trong lúc chờ job: như Dừng (chờ job xong), không bao giờ là Dừng ngay.

### 4. Chi phí API, thời gian và `maxRecordsHard`

Số lời gọi tính bằng công thức ở §1. Thời gian là **ước tính**: Collections theo số đo của 0004 (0,5–2 s mỗi lô 200); Bulk
giả định Salesforce xử lý 300–2 000 bản ghi/giây mỗi job tùy trigger/flow, cộng 10–30 s xếp hàng mỗi job. Chưa đo trên
org thật (test không bao giờ gọi org thật); bước 11 của kế hoạch ghi số đo thật vào "Đã làm" khi người dùng chạy thử trên
sandbox của họ.

| Kịch bản | Chỉ sObject Collections | Có Bulk cho bản ghi lá |
| --- | --- | --- |
| 200 000: 40 000 Account + 160 000 Contact (Lookup tới Account) | 1 000 lời gọi; 8–33 phút | Account 200 lời gọi + Contact 1 + 16 × 12 ≈ **393 lời gọi**; Account 2–7 phút, các job Contact chạy song song với Account: **khoảng 5–15 phút** |
| 200 000 Account không có con | 1 000 lời gọi; 8–33 phút | 1 + 20 × 12 ≈ **241 lời gọi**; khoảng 3–12 phút |
| 1 000 000: 200 000 Account + 800 000 Contact (nếu nâng trần) | 5 000 lời gọi (1/3 hạn mức ngày của Developer Edition); 40–165 phút | ≈ 1 000 + 961 ≈ 1 960 lời gọi; 40–80 phút (Account qua Collections là cổ chai). Bộ nhớ: tập `unique` của 800 000 Email ≈ 130 MB; mỗi lượt sinh ≈ 22 s, chạy hai lượt |
| Xóa 200 000 (Contact 160 000, Account 40 000) | 1 000 lời gọi | Bulk cho cả hai (xóa không cần map Id): 1 + 1 + 20 × 12 ≈ **242 lời gọi** |

Hạn mức Bulk: mỗi 10 000 bản ghi Salesforce tính một "batch" trong hạn mức 15 000 batch/24 giờ (dùng chung Bulk 1.0 và
2.0), nên 200 000 bản ghi chỉ tốn khoảng 20 batch.

**Không nâng `maxRecordsHard` (giữ 200 000).** Với Bulk, số lời gọi không còn là cản trở chính, nhưng: (a) bản ghi cha vẫn đi
Collections nên thời gian vẫn tăng tuyến tính; (b) bộ nhớ tập `unique` (khoảng 165 B/giá trị, Email unique mặc định) lên
hơn 100 MB; (c) hai lượt sinh (chạy thử + insert) mất khoảng 45 s; (d) file Id của một lần chạy 1 triệu bản ghi khoảng
50 MB. Xem lại sau khi có số đo Bulk thật (Câu hỏi mở).

### 5. Lịch sử (`server/history.js`, mới)

**Ở đâu.** File trên máy chạy server, không ở trình duyệt: 200 000 Id ≈ 9 MB vượt `localStorage` (khoảng 5 MB), Lịch sử phải
còn khi đổi trình duyệt hay xóa dữ liệu trang, và quan trọng nhất là **server chỉ xóa Id do chính nó ghi**, không nhận danh
sách Id từ client.

Thư mục dữ liệu (`dataDir`): biến môi trường `SFDG_DATA_DIR` nếu có; không thì Linux `$XDG_DATA_HOME/sf-data-generator` (mặc
định `~/.local/share/sf-data-generator`), macOS `~/Library/Application Support/sf-data-generator`, Windows
`%APPDATA%\sf-data-generator`. Lịch sử nằm ở `<dataDir>/history/`, thư mục tạo với quyền `0700`, file `0600`. Không ghi
được thư mục lúc khởi động ⇒ Lịch sử tắt (`enabled: false`, `reason`), app vẫn chạy (xem trước không cần nó).

```
<dataDir>/history/
  h20261028T103200Z-a1b2c3.json         thông tin lần chạy (ghi lại toàn bộ, ghi file tạm rồi rename)
  h20261028T103200Z-a1b2c3.ids.csv      Id đã insert, chỉ nối thêm:  sobject,step,ref,id
  h20261028T103200Z-a1b2c3.deleted.csv  kết quả xóa, chỉ nối thêm:   id,outcome   (deleted | gone)
```

`<hid>.json`:

```json
{
  "version": 1,
  "id": "h20261028T103200Z-a1b2c3",
  "status": "done",
  "startedAt": "2026-10-28T10:32:00.000Z",
  "finishedAt": "2026-10-28T10:41:12.000Z",
  "org": { "alias": "dev-sb", "username": "me@example.com", "orgId": "00D5g000000AbCdEAK", "instanceUrl": "https://acme--dev.sandbox.my.salesforce.com", "kind": "sandbox" },
  "workflow": { "version": 2, "name": "Account + Contact", "steps": ["…bản chụp workflow lúc insert…"] },
  "seed": 42,
  "now": 1761645120000,
  "bulk": "auto",
  "steps": [
    { "nodeId": "acc", "alias": "acc", "sobject": "Account", "mode": "collections", "total": 40000, "inserted": 40000, "failed": 0 },
    { "nodeId": "con", "alias": "con", "sobject": "Contact", "mode": "bulk", "total": 160000, "inserted": 159997, "failed": 3 }
  ],
  "total": 200000, "inserted": 199997, "failed": 3, "notSent": 0,
  "bulkJobs": [{ "jobId": "7504x00000AbCdE", "nodeId": "con", "records": 10000, "state": "JobComplete", "idsCollected": true }],
  "errorGroups": [{ "sobject": "Contact", "nodeId": "con", "message": "…", "count": 3 }],
  "errorGroupsOther": null,
  "stopped": null,
  "warnings": [],
  "deletion": { "status": "none", "deleted": 0, "gone": 0, "lastAt": null, "errorGroups": [] }
}
```

- `status`: `running` | `done` | `cancelled` | `stopped` | `error` | `interrupted`. Lúc server khởi động, mọi mục `running`
  thành `interrupted`. `steps` theo **thứ tự bản ghi đầu tiên của bước xuất hiện trong lần chạy** (thứ tự xóa ngược lại).
- **Khi nào tạo:** ngay trước sự kiện `plan` (sau lượt chạy thử, trước lời gọi ghi đầu tiên). Tạo lỗi ⇒ lần chạy kết thúc
  với lỗi và `insert: null` (chưa ghi gì). Xem trước không bao giờ tạo mục.
- **Ghi Id:** sau mỗi lời gọi Collections (≤ 200 dòng) và mỗi lần lấy kết quả job Bulk (≤ 10 000 dòng), một lần
  `appendFile` và **chờ xong trước lời gọi ghi tiếp theo**, nên Id của mọi bản ghi đã vào org đều có trên đĩa trừ khi
  server chết ngay giữa lời gọi. Lỗi ghi ⇒ dừng insert (`stopped.reason: 'history'`). `jobId` được ghi vào `bulkJobs` **trước**
  khi tải CSV lên, để một job bị gián đoạn vẫn tra được.
- **Thông tin `.json`** ghi lại sau mỗi job Bulk, khi Dừng, và khi kết thúc; không ghi sau mỗi lời gọi (số đếm thật nằm ở
  file Id).
- **Không bao giờ lưu credential:** chỉ `alias`, `username`, `orgId`, `instanceUrl`, `kind`. Không `accessToken`, refresh
  token, mật khẩu, header `Authorization`, không dòng Query (có thể là dữ liệu thật của org). `cli.getConnection` trả thêm
  `orgId` (`id` của `sf org display`); `kind` lấy từ `cli.listOrgs()` gọi song song với lượt chạy thử (lỗi ⇒ `unknown`).
- **Giới hạn:** `LIMITS.historyMaxRuns` = 100 lần chạy và `LIMITS.historyMaxBytes` = 256 MB tổng. Khi vượt (kiểm tra lúc tạo
  mục mới), dọn theo thứ tự: mục cũ nhất **đã xóa hết hoặc không có bản ghi trong org**, rồi mới tới mục cũ nhất còn bản ghi.
  Không bao giờ dọn mục `running`. Mỗi lần chạy tối đa 200 000 dòng × khoảng 50 B ≈ 10 MB.
- `hid` khớp `^h\d{8}T\d{6}Z-[0-9a-f]{6}$`; mọi đường dẫn dựng từ `hid` đã kiểm (không path traversal). Thời gian dùng
  `Date.now()` của server (không phải executor; quy tắc tất định chỉ áp cho generator và executor), tiêm được cho test.

### 6. Tầng jsforce (`server/sf/client.js`)

Thêm ba hàm, đều đi qua `call()` (lỗi bọc thành 502, `refreshFn` như mọi lời gọi khác):

```js
bulkJob(target, { object, operation })   // operation chỉ nhận 'insert' | 'delete', khác ⇒ throw (không bao giờ 'hardDelete', 'update', 'upsert')
// → { id, open(), upload(csv), close(), check() → { state, numberRecordsProcessed, numberRecordsFailed, errorMessage },
//     abort(), successfulResults() → [{ sf__Id, … }], failedResults() → [{ sf__Id, sf__Error, … }] }   (conn.bulk2.createJob)
destroy(target, sobject, ids)            // conn.sobject(sobject).destroy(ids, { allOrNone: false }), tối đa 200 Id
limits(target)                           // conn.limits() → { DailyApiRequests: { Max, Remaining }, DailyBulkApiBatches: { … } }
```

`client.js` là file **duy nhất** gọi `create` / `destroy` / `bulk2` của jsforce; `insert.js` và `delete.js` là hai file duy
nhất gọi `client.create` / `client.destroy` / `client.bulkJob` (một test quét mã nguồn khóa điều này).

### 7. Xóa (`server/sf/delete.js`, mới)

```js
export async function deleteRun({ client, history, hid, username, bulk, signal, onProgress, onDeleted })
```

1. **Thứ tự:** duyệt `steps` của lần chạy theo thứ tự **ngược**; trong mỗi bước, Id theo thứ tự ngược với lúc insert (đọc file
   Id theo dòng, không nạp hết vào bộ nhớ: gom Id còn phải xóa của từng bước vào mảng chuỗi, ≤ 200 000 × khoảng 20 B). Vì
   bản ghi cha luôn được insert trước con, thứ tự ngược đưa con lên trước. Self-lookup trong một bước cũng được xử lý vì xóa
   ngược trong bước.
2. **Cách gửi:** bước còn < `bulkMinRecords` Id (hoặc `bulk: 'off'`): `client.destroy` 200 Id mỗi lời gọi. Bước còn nhiều hơn:
   lô thử 200 Id bằng `destroy` (bắt lỗi quyền bằng quy tắc 3 lời gọi đầu như insert), rồi job Bulk `operation: 'delete'`
   với CSV một cột `Id`, 10 000 Id mỗi job, một job mỗi lúc, xong job này mới sang job sau. Bước sau chỉ bắt đầu khi bước trước
   xong (con xong mới tới cha).
3. **Kết quả từng Id:** thành công ⇒ `deleted`. Lỗi `ENTITY_IS_DELETED`, `INVALID_CROSS_REFERENCE_KEY`, `NOT_FOUND` (đã xóa
   bằng tay, đã nằm trong Thùng rác, hay bị xóa dây chuyền khi xóa cha) ⇒ `gone`, không tính lỗi. Lỗi khác ⇒ `failed`, gom
   nhóm như insert (`errorPattern`, tối đa 100 nhóm). Mỗi lô kết quả nối vào `<hid>.deleted.csv` và chờ ghi xong trước lời
   gọi tiếp (như insert).
4. **Một lượt thử lại:** sau khi xong mọi bước, các Id lỗi với mã `DELETE_FAILED` (còn bản ghi khác phụ thuộc, ví dụ vòng
   Lookup giữa hai bước) được thử lại một lần theo cùng thứ tự.
5. **Bản ghi đã bị sửa:** vẫn bị xóa (là bản ghi app đã tạo); hộp xác nhận nói rõ. Không SOQL kiểm tra trước (200 000 Id cần
   khoảng 400 query; xem Phương án).
6. **Dừng / Dừng ngay:** như insert (§3); dừng thì Id chưa gửi vẫn "còn trong org" và xóa được bằng "Xóa phần còn lại…".
7. **Không bao giờ** `hardDelete`, không xóa Id nào không có trong `<hid>.ids.csv`, không xóa bản ghi Query.
8. **Job Bulk insert chưa lấy kết quả** (lần chạy `interrupted`, hay `idsCollected: false`): trước khi xóa, server lấy
   `successfulResults` của job đó (chỉ đọc) và nối vào file Id; hộp xác nhận có dòng `Lấy Id của 1 job Bulk chưa lấy kết quả
   (7504x…) trước khi xóa.` (số bản ghi trong hộp là số đã biết; `confirm.count` so trên số đã biết trước khi lấy thêm).

### 8. An toàn: endpoint nào ghi hay xóa, chặn thế nào

| Endpoint | Tác dụng lên org | Chặn |
| --- | --- | --- |
| `POST /api/run` với `target.kind === 'org'` | **Ghi** (insert: Collections và job Bulk `insert`) | `requestGuard` (Host, Origin, `Sec-Fetch-Site`, JSON); hộp xác nhận ở UI; lượt chạy thử trước khi ghi; cần Lịch sử tạo được |
| `POST /api/history/:hid/delete` | **Xóa** (Collections `destroy` và job Bulk `delete`), chỉ Id trong Lịch sử | `requestGuard`; body `confirm` khớp server (`username` của lần insert, `count` = số còn phải xóa; production: `typedOrg` = alias hoặc username); org hiện tại của sf CLI phải cùng `orgId` (hoặc cùng instance URL + username nếu thiếu `orgId`) với lúc insert; không đang insert/xóa cùng mục. Mọi kiểm tra chạy **trước** khi gửi header và trước lời gọi ghi đầu tiên |
| `POST /api/runs/:runId/cancel` (`force`) | Dừng; `force` hủy job Bulk (đổi trạng thái job, không ghi dữ liệu) | `requestGuard` |
| `GET /api/orgs/:org/limits` | Chỉ đọc (`/limits`) | `requestGuard` |
| `GET /api/history`, `GET /api/history/:hid`, `GET /api/history/:hid/ids.csv` | Không gọi org (đọc file) — trừ khi không có | `requestGuard` (trang khác không đọc được danh sách Id) |
| `POST /api/history/:hid/forget` | Không gọi org; xóa 3 file của mục | `requestGuard`; 409 khi mục đang chạy |

Không có endpoint nào nhận danh sách Id hay SOQL để xóa. `target.kind === 'org'` vẫn là cổng duy nhất để insert; `confirm`
là cổng của xóa. curl vẫn gọi được (như mọi API), nhưng phải ghi đúng username và số bản ghi.

## Thay đổi dữ liệu / API

### Workflow JSON

**Không đổi.** File `version: 2` và `version: 1` (chuyển bằng `shared/migrate-v1.js`) chạy như cũ; dữ liệu sinh ra với cùng seed
và `now` không đổi (test vàng của 0004 phải giữ nguyên hash). Bulk là cách gửi, không phải dữ liệu: bật hay tắt Bulk ra cùng
bản ghi.

### `POST /api/run` (dự kiến)

- `target` thêm khóa tùy chọn `bulk: "auto" | "off"` (thiếu ⇒ `"auto"`; giá trị khác ⇒ 400 `target.bulk phải là "auto" hoặc "off".`).
- Sự kiện `plan` thêm `steps: [{ nodeId, sobject, mode, probe, jobs }]` và `apiCalls` theo `planInsert` (số tổng; thêm
  `apiCallsBy: { collections, bulk }`).
- `progress` (`insert`) thêm `bulk` (§2). Mới: `{"type":"progress","phase":"stopping","waitingBulk":{"jobId":"7504x…","sobject":"Contact","processed":6200,"records":10000}}`.
- `done.result.insert` thêm `historyId`, `bulk: [{ nodeId, sobject, jobs, records, inserted, failed }]`, `bulkAborted`
  (khi Dừng ngay), `stopped.reason` có thêm `"bulkFailing"`, `"history"`; `errors[]` có thể có `bulkJobId` và không có `ref`.
- Chế độ JSON một cục cũng ghi Lịch sử và trả `historyId`.

### `POST /api/runs/:runId/cancel` (dự kiến)

Body `{}` như cũ, hoặc `{ "force": true }` (Dừng ngay). Trả `{ "ok": true }`; 404 như cũ.

### Endpoint mới (dự kiến)

| Endpoint | Trả về |
| --- | --- |
| `GET /api/orgs/:org/limits` | `{ "api": { "max": 15000, "remaining": 14200 }, "bulkBatches": { "max": 15000, "remaining": 14980 } }` |
| `GET /api/history` | `{ "enabled": true, "dir": "/home/me/.local/share/sf-data-generator/history", "maxRuns": 100, "runs": [ { id, status, startedAt, finishedAt, org, workflowName, seed, total, inserted, failed, bySobject, deletion: { status, deleted, gone, remaining } } ] }` (mới nhất trước). Lịch sử tắt: `{ "enabled": false, "reason": "EACCES: …", "dir": "…", "runs": [] }` |
| `GET /api/history/:hid` | Toàn bộ `<hid>.json` (bỏ `workflow`, thêm `remaining: { total, bySobject }`, `pendingBulkJobs`) |
| `GET /api/history/:hid/ids.csv[?sobject=Contact]` | CSV `sobject,id,ref,step,status` (`status` = `inserted` \| `deleted` \| `gone`), `Content-Disposition: attachment; filename="<workflow>-<yyyyMMdd-HHmm>-ids.csv"` |
| `POST /api/history/:hid/delete` | Body `{ "confirm": { "username": "me@example.com", "count": 200000, "typedOrg": "dev-prod" }, "bulk": "auto" }`. NDJSON như `/api/run` (`Accept: application/x-ndjson`; không có thì JSON một cục): `start { runId, historyId, total, bySobject }`, `progress { phase: "delete", deleted, gone, failed, total, bySobject, bulk? }`, `done { result: { deleted, gone, failed, errorGroups, errorGroupsOther, bySobject, remaining, cancelled, stopped, bulkAborted } }`, `error`. Lỗi kiểm tra trước: 400/404/409/502 JSON thường (§7 của Thiết kế UI) |
| `POST /api/history/:hid/forget` | `{ "ok": true }`; 404; 409 khi đang chạy |

### `GET /api/meta` (dự kiến)

`limits` thêm `bulkMinRecords: 10000`, `bulkJobRecords: 10000`, `bulkJobTimeoutMs: 1800000`, `historyMaxRuns: 100`,
`historyMaxBytes: 268435456` (trong `LIMITS` của `server/workflow/nodes.js`). Hằng nội bộ (không ra meta): khoảng theo dõi
job 2 s × 1,5 tới 15 s, tối đa 2 bộ đệm Bulk, số lời gọi ước tính mỗi job 12, lô xóa 200, dừng sớm Bulk sau 2 job.

### Tài liệu tham chiếu cần cập nhật khi làm (doc này không sửa)

Theo yêu cầu, lượt thiết kế này chỉ thêm file doc này. Implementer cập nhật khi code xong (bước 11):

- `docs/org-connection.md`: mục "Insert" (Bulk, lô thử, một job cùng lúc, Dừng / Dừng ngay), mục mới "Lịch sử" và "Xóa dữ
  liệu đã insert", bảng API (`/limits`), mục "An toàn" (bảng endpoint ghi/xóa ở §8), bỏ câu "Chưa làm … Bulk API 2.0 … xóa".
- `docs/workflow-schema.md`: `target.bulk`, khóa mới của `plan`/`progress`/`done`, `cancel` có `force`, các endpoint
  `/api/history…`.
- `docs/architecture.md`: sơ đồ (Lịch sử, xóa), bảng server (`server/history.js`, `server/sf/delete.js`,
  `server/sf/bulk-csv.js`), `shared/insert-plan.js`, bảng `LIMITS`, hằng nội bộ, `client/js/history.js`.
- `docs/ui-design-system.md`: §5 icon `--ico-history`; §6.10 link `⤓ Id`/`Lịch sử`, tab "Lỗi xóa"; §6.11 hộp Lịch sử, hộp
  xác nhận xóa (ô gõ tên org).
- `CLAUDE.md` (mức kiến trúc): Lịch sử ở `dataDir`, endpoint xóa và cổng `confirm`, Bulk trong inserter.
- `docs/design/README.md`: thêm dòng 0011 (lượt này không sửa vì một planner khác đang sửa file đó).

## Checklist tiện dụng

- [x] 1. Chạy được ngay với mặc định — Bulk tự bật theo số bản ghi và quan hệ, không có option trong workflow; Lịch sử tự ghi
  vào thư mục mặc định theo hệ điều hành; workflow cũ không đổi.
- [x] 2. Ít thao tác cho việc hay làm — insert vẫn 2 thao tác; tải Id 1; xóa lần vừa insert 2 (từ toast); xóa lần cũ 3.
- [x] 3. Xem trước trước khi ghi — insert giữ xem trước + xác nhận của 0004; xóa có hộp xác nhận ghi org, username, loại org, số
  bản ghi theo sObject, thứ tự, Thùng rác, xóa dây chuyền, số lời gọi API; production phải gõ tên org; server so lại
  username và số bản ghi.
- [x] 4. Lỗi chỉ đúng chỗ và nói cách sửa — lỗi Bulk mang `nodeId`/`field` như lỗi Collections (lô thử giữ `ref` cho lỗi cấu
  hình); lỗi xóa gom nhóm và nói cách sửa (quyền Delete, đăng nhập lại đúng org).
- [x] 5. Không mất công sức — Lịch sử giữ Id ngay cả khi Dừng, mất kết nối hay server tắt; xóa dừng giữa chừng thì "Xóa phần
  còn lại…"; "Quên" có xác nhận và nói rõ hậu quả; dọn Lịch sử ưu tiên mục đã xóa hết.
- [x] 6. Lấy thông tin từ org thay vì bắt gõ — hạn mức API lấy từ `/limits`; loại org và `orgId` lấy từ sf CLI; người dùng không
  gõ Id hay SOQL nào để xóa.
- [x] 7. Một nguồn sự thật — `planInsert` ở `shared/` dùng cho cả hộp xác nhận và sự kiện `plan`; ngưỡng Bulk từ
  `/api/meta`; danh sách Id chỉ ở server.
- [x] 8. Giải thích tại chỗ — help của checkbox Bulk nói khi nào nên tắt; hộp xóa giải thích Thùng rác và xóa dây chuyền;
  `title` cho `Bị gián đoạn`, link `⤓ Id`.
- [x] 9. An toàn khi lỡ tay — xóa chỉ Id app đã ghi, qua một endpoint có `confirm` và kiểm tra `orgId`; không `hardDelete`;
  một job Bulk mỗi lúc; dừng sớm cho Bulk và cho xóa; Lịch sử có trần số lần và dung lượng; `maxRecordsHard` giữ 200 000.

## Phương án đã cân nhắc

**Map Id của Bulk về `ref`**

| Phương án | Ưu | Nhược | Chọn? |
| --- | --- | --- | --- |
| A. Bulk chỉ cho bản ghi lá (không Lookup trỏ tới), lô thử bằng Collections | Không cần map; lỗi cấu hình vẫn có `ref`; trường hợp hay gặp (nhiều con, ít cha) giảm 60 % lời gọi | Bản ghi cha nhiều (200 000 Account có con) vẫn chậm | **Có** |
| B. Bulk cho mọi bước, map bằng nội dung dòng | Nhanh hơn với nhiều cha | Hai dòng giống hệt nhau thì Id có thể tráo; chuỗi Salesforce trả có thể khác chuỗi đã gửi (số, ngày); sai map là sai quan hệ trong org | Không |
| C. Bulk với field External Id để map | Chính xác | Bắt người dùng tạo field trong org (vi phạm nguyên tắc 1) | Không |

**Nơi lưu Lịch sử**

| Phương án | Ưu | Nhược | Chọn? |
| --- | --- | --- | --- |
| A. File ở `dataDir` của server | Không giới hạn 5 MB; server tự ghi Id trong lúc insert (bền khi mất kết nối); xóa chỉ dựa vào dữ liệu server | Một thư mục mới trên đĩa người dùng | **Có** |
| B. `localStorage` / IndexedDB của trình duyệt | Không đụng đĩa ngoài trình duyệt | Phải gửi mọi Id về client (≈ 9 MB/200 000); mất khi đóng tab giữa chừng; server phải tin danh sách Id client gửi lên để xóa | Không |
| C. Ghi vào org (custom object, tag) | Ai cũng thấy | Ghi thêm vào org, cần metadata; ngược nguyên tắc chỉ ghi dữ liệu test | Không |

**Kiểm tra trước khi xóa**

| Phương án | Ưu | Nhược | Chọn? |
| --- | --- | --- | --- |
| A. Không query trước; xóa đúng Id đã ghi, coi "đã bị xóa" là `gone` | Nhanh, ít lời gọi; số trong hộp xác nhận là số đã biết | Bản ghi bị người khác sửa vẫn bị xóa (hộp xác nhận nói rõ) | **Có** |
| B. SOQL `LastModifiedDate` để bỏ qua bản ghi đã bị sửa | Không xóa bản ghi người khác đã dùng | 200 000 Id ≈ 400 query; dữ liệu test thường bị trigger sửa ngay nên gần như mọi bản ghi "đã bị sửa" | Không (Câu hỏi mở) |

**Dừng khi có job Bulk**

| Phương án | Ưu | Nhược | Chọn? |
| --- | --- | --- | --- |
| A. Dừng chờ job xong; "Dừng ngay" hủy job | Số đếm và Id chính xác theo mặc định; hủy là lựa chọn rõ ràng | Dừng có thể chờ tới vài chục giây | **Có** |
| B. Dừng luôn hủy job | Dừng nhanh | Số đếm không chắc, có thể mất Id (không xóa lại được) | Không |

**Chạy tiếp một lần đã dừng**

| Phương án | Ưu | Nhược | Chọn? |
| --- | --- | --- | --- |
| A. Không làm; cách thay thế là "Xóa dữ liệu này…" rồi Insert lại | Đơn giản, không có nguy cơ trùng | Mất thời gian đã insert | **Có** |
| B. Chạy lại cùng seed + `now` + dòng Query, bỏ qua `ref` đã gửi, nạp Id cha từ Lịch sử | Không mất phần đã làm | Phải ghi lại mọi `ref` đã gửi (kể cả bản ghi Bulk, vốn không có `ref`); Query phải ra đúng dòng cũ; trigger đã chạy trên phần cũ; một lỗi nhỏ ⇒ bản ghi trùng trong org | Không |

**Update / Upsert theo External Id**

| Phương án | Ưu | Nhược | Chọn? |
| --- | --- | --- | --- |
| A. Không làm trong doc này | Giữ phạm vi; xóa vẫn hoàn tác được mọi thứ app làm | Chưa sửa được dữ liệu có sẵn | **Có** |
| B. Bước "Cập nhật" trên pool Query, hoặc chế độ upsert của Record | Làm được dữ liệu có sẵn | Sửa bản ghi **có sẵn** không hoàn tác được bằng xóa (cần lưu giá trị cũ); cần UI chọn khóa khớp; rủi ro ghi đè dữ liệu thật cao hơn hẳn | Không (design riêng) |

**Gửi song song**

| Phương án | Ưu | Nhược | Chọn? |
| --- | --- | --- | --- |
| A. Collections tuần tự + tối đa một job Bulk chạy cùng lúc | Thứ tự cha trước con, Dừng chính xác, dừng sớm giữ nguyên; Bulk đã lo phần khối lượng | Bản ghi cha không nhanh hơn | **Có** |
| B. Nhiều lời gọi Collections song song (2–4) | Nhanh hơn 2–4 lần cho bản ghi cha | `UNABLE_TO_LOCK_ROW` khi nhiều con cùng cha; dừng sớm và đếm khi Dừng phức tạp hơn; dễ đụng giới hạn request đồng thời | Không (Câu hỏi mở) |

## Kế hoạch thực hiện

Mỗi bước tự chạy được, có test riêng; không test nào gọi org thật. Bulk và xóa được kiểm bằng jsforce thật chạy với
**Salesforce giả trên localhost** (`test/fake-salesforce.js`, mới; không import jsforce, để `test/jsforce.test.js` vẫn xóa biến
proxy trước khi import). Salesforce giả ghi lại mọi request và có các endpoint: `POST /composite/sobjects`,
`DELETE /composite/sobjects?ids=…&allOrNone=false`, `POST /jobs/ingest`, `PUT /jobs/ingest/:id/batches`,
`PATCH /jobs/ingest/:id` (`UploadComplete`, `Aborted`), `GET /jobs/ingest/:id` (lần lượt `InProgress` rồi `JobComplete`),
`GET /jobs/ingest/:id/successfulResults` (cố ý **đảo thứ tự** dòng), `…/failedResults`, `GET /limits`.

| # | Việc | File | Kiểm tra |
| --- | --- | --- | --- |
| 0 | Salesforce giả dùng chung (đếm request ghi: POST/PUT/PATCH/DELETE) | `test/fake-salesforce.js` (mới) | Dùng ở bước 1, 4, 7 |
| 1 | **jsforce:** `bulkJob` (chỉ `insert`/`delete`), `destroy`, `limits`; `cli.getConnection` trả `orgId` | `server/sf/client.js`, `server/sf/cli.js` | `test/jsforce.test.js`: vòng đời job đủ các request đúng thứ tự và CSV đúng; `bulkJob(..., { operation: 'hardDelete' \| 'update' \| 'upsert' })` throw **trước** khi có request nào; `destroy` gửi `DELETE` với `allOrNone=false` và đúng Id; 401 `INVALID_SESSION_ID` ở `POST /jobs/ingest` ⇒ refresh qua CLI rồi gọi lại; `test/sf.test.js`: `orgId` từ `sf org display` |
| 2 | **Kế hoạch insert:** `planInsert` (điều kiện Bulk, ước tính lời gọi) | `shared/insert-plan.js` (mới) | `test/insert-plan.test.js`: alias có Lookup trỏ tới (kể cả qua Chọn bản ghi) không bao giờ Bulk; dưới 10 000 không Bulk; `bulk: 'off'`; số lời gọi 200 000 = 393 cho mẫu Account+Contact |
| 3 | **CSV Bulk:** `toBulkCsv`, đọc CSV kết quả, phân tích `sf__Error` | `server/sf/bulk-csv.js` (mới) | `test/bulk-csv.test.js`: null, boolean, ngày, xuống dòng, ngoặc kép, geolocation; cột = hợp field; `sf__Error` → cùng thông báo/khóa nhóm như SaveResult |
| 4 | **Inserter có Bulk:** lô thử, bộ đệm, một job cùng lúc, theo dõi có backoff (tiêm `sleep`/`clock`), kết quả không theo thứ tự, job `Failed`, `bulkFailing`, chuyển về Collections khi tạo job lỗi, Dừng chờ job, Dừng ngay hủy job, timeout, `onInserted` | `server/sf/insert.js` | `test/sf.test.js` (client giả): Account 300 + Contact 12 000 ⇒ Account chỉ qua `create`, Contact 200 qua `create` rồi 2 job; CSV Contact chứa đúng Id Account thật; `successfulResults` đảo thứ tự vẫn đếm đúng và mọi `sf__Id` qua `onInserted`; lô thử lỗi 3 lần ⇒ `allFailing`, **không** job nào được tạo; Dừng lúc job `InProgress` ⇒ chờ `JobComplete`, không `abort`; Dừng lúc `Open` ⇒ `abort`, `notSent` đúng; `force` ⇒ `abort` rồi lấy kết quả; `test/jsforce.test.js`: cùng kịch bản qua jsforce thật + Salesforce giả; `test/stream.test.js`: hash vàng không đổi |
| 5 | **Lịch sử:** tạo/nối/kết thúc, `interrupted` khi khởi động, dọn theo giới hạn, kiểm `hid`, quyền file, tắt khi không ghi được | `server/history.js` (mới) | `test/history.test.js` (thư mục tạm): dọn mục đã xóa hết trước; không dọn `running`; `hid` `../x` ⇒ 404; file `0600` (bỏ qua trên Windows); **quét mọi file trong thư mục: không có chuỗi token giả (`SECRET-TOKEN-123`), không có `accessToken`, `Authorization`**; dòng Query giả không xuất hiện |
| 6 | **Nối vào lần chạy:** tạo mục trước `plan`, ghi Id mỗi lời gọi, dừng khi ghi lỗi, `target.bulk`, `plan.steps`, `progress.bulk`, `historyId`; endpoint `/api/history…` (GET, `ids.csv`, `forget`), `/api/orgs/:org/limits`, `cancel` có `force` | `server/run.js`, `server/index.js`, `server/workflow/nodes.js` (`LIMITS`) | `test/run.test.js`: tạo mục lỗi ⇒ `error`, `insert: null`, **0 lời gọi `create`**; ghi Id lỗi giữa chừng ⇒ `stopped.reason: 'history'` sau lô đang gửi; `test/server.test.js`: insert NDJSON ⇒ `ids.csv` có đủ Id (cả Id Bulk), `status` đúng; xem trước không tạo mục; `forget` xóa 3 file; `limits.bulkMinRecords` trong meta; `target.bulk: 'x'` ⇒ 400 |
| 7 | **Xóa:** `deleteRun` (thứ tự ngược, `gone`, thử lại `DELETE_FAILED`, Bulk delete, dừng sớm, Dừng/Dừng ngay, lấy kết quả job chưa lấy) + `POST /api/history/:hid/delete` với mọi kiểm tra trước | `server/sf/delete.js` (mới), `server/index.js` | `test/sf.test.js`: con trước cha; trong bước theo thứ tự ngược; `ENTITY_IS_DELETED` ⇒ `gone`; `INSUFFICIENT_ACCESS` 3 lời gọi ⇒ dừng; `test/server.test.js`: mỗi trường hợp bị từ chối (thiếu `confirm`, sai `username`, sai `count`, production thiếu `typedOrg`, `orgId` khác, đang chạy, không còn gì) trả đúng mã/câu **và Salesforce giả nhận 0 request ghi**; `test/jsforce.test.js`: insert rồi xóa qua jsforce thật: tập Id trong `DELETE`/job `delete` **bằng đúng** tập Id đã insert, không Id lạ, không `hardDelete` |
| 8 | **Khóa an toàn:** request khác trang ⇒ 403 cho `/api/history/:hid/delete`, `ids.csv`, `/limits`; `text/plain` ⇒ 415; test quét mã nguồn: `.bulk2`, `.destroy(`, `.sobject(…).create(` chỉ có trong `server/sf/client.js`; `client.create`/`destroy`/`bulkJob` chỉ được gọi trong `insert.js`/`delete.js` | `test/server.test.js`, `test/safety.test.js` (mới) | Như cột Việc |
| 9 | **UI insert:** checkbox Bulk + dòng bước + số lời gọi (`planInsert`) + hạn mức + dòng Lịch sử trong hộp xác nhận; `target.bulk`; tiến độ Bulk; Dừng ngay; link `⤓ Id` / `Lịch sử`; toast "Xóa dữ liệu này…" | `client/js/main.js`, `client/js/results.js`, `client/js/api.js`, `client/css/app.css` | Smoke luồng 16a (dưới) |
| 10 | **UI Lịch sử và xóa:** hộp Lịch sử, chi tiết, quên, hộp xác nhận xóa (production gõ tên), tiến độ xóa, tab "Lỗi xóa", mục menu ⋯, icon `--ico-history` | `client/js/history.js` (mới), `client/js/main.js`, `client/js/results.js`, `client/js/popup.js`, `client/index.html`, `client/css/app.css` | Smoke luồng 16b–16d; `test/css-tokens.test.js` (token mới có trong bảng) |
| 11 | **Tài liệu:** danh sách ở [Tài liệu tham chiếu cần cập nhật](#tài-liệu-tham-chiếu-cần-cập-nhật-khi-làm-doc-này-không-sửa); mục "Đã làm" của doc này; số đo Bulk thật nếu người dùng chạy trên sandbox của họ (không tự chạy trên org thật) | `docs/…`, `CLAUDE.md`, `.claude/skills/smoke-test/SKILL.md`, `.claude/agents/implementer.md` (hàng "Org writes": `client.js`, `insert.js`, `delete.js`, `history.js`) | `npm test`, smoke `SMOKE OK` |

**Smoke luồng 16** (hàm mới `flowHistory`, context riêng; `/api/orgs`, `/api/run`, `/api/history…`, `/api/orgs/*/limits` giả
lập bằng `page.route`, không server Salesforce):

- 16a. Org `dev-sb [sandbox]`, mẫu "Account + Contact" với `con` 12 000 bản ghi: bấm Insert ⇒ hộp xác nhận có checkbox Bulk đã
  chọn và dòng `con (Contact) 12 000: 200 bản ghi đầu…`; bỏ chọn ⇒ số lời gọi tăng; request gửi `target.bulk: "off"`. Hạn mức
  giả 100 còn lại ⇒ có `.warn-box` hạn mức. Kết quả giả xong ⇒ tóm tắt có link `⤓ Id` và `Lịch sử`; toast có nút
  `Xóa dữ liệu này…`.
- 16b. Bấm `Xóa dữ liệu này…` ⇒ hộp xác nhận xóa, focus ở `Hủy`, nút `Xóa 12 005 bản ghi` (`.danger.solid`); bấm ⇒ request
  `POST /api/history/<hid>/delete` có `confirm.username` và `confirm.count` = 12 005.
- 16c. Org production giả: nút xóa khóa tới khi gõ đúng alias; request có `typedOrg`.
- 16d. Hộp Lịch sử ở 1440 px và 390 px: lọc theo org mặc định bật; dòng `Bị gián đoạn` có `title`; `⋯ → Quên lần insert này`
  hỏi xác nhận; ở 390 px hộp toàn màn hình, `scrollWidth === innerWidth`.

## Rủi ro

- **Ô trống trong CSV Bulk:** khi insert, Salesforce coi ô trống là "không đặt giá trị"; REST bỏ hẳn field `null`. Hai cách
  được kỳ vọng ra cùng kết quả (kể cả giá trị mặc định của field), nhưng cần kiểm trên sandbox thật trước khi coi là chắc.
- **Kết quả của job đã hủy:** chưa chắc Salesforce trả `successfulResults` cho job `Aborted`; thiết kế xử lý cả hai trường hợp
  (`idsUnknown`), cần kiểm trên sandbox thật.
- **Trigger và khóa bản ghi:** Bulk xử lý các khối 10 000 song song phía Salesforce; Contact cùng Account ở hai khối có thể gặp
  `UNABLE_TO_LOCK_ROW`. Bản ghi được sinh theo thứ tự cha nên con cùng cha thường nằm liền nhau; lỗi còn lại được gom nhóm và
  help của checkbox chỉ cách tắt Bulk.
- **Dung lượng đĩa:** tối đa 256 MB cho Lịch sử; dòng đầu hộp Lịch sử nói rõ nơi lưu.
- **Ước tính thời gian** ở §4 chưa đo trên org thật.

## Câu hỏi mở / Việc tiếp theo

- Bulk cho bản ghi cha (map bằng nội dung hoặc External Id), và gửi Collections song song 2–4 lời gọi cho bản ghi cha: cân nhắc
  khi có số đo thật cho thấy bản ghi cha là cổ chai.
- Nâng `maxRecordsHard` sau khi có số đo Bulk và khi tập `unique` có cách lưu gọn hơn.
- Tùy chọn "bỏ qua bản ghi đã bị sửa sau khi insert" (SOQL `LastModifiedDate`) cho lần xóa nhỏ.
- Update / Upsert theo External Id: design riêng, cần lưu giá trị cũ để hoàn tác.
- Gõ tên org cho cả hộp xác nhận **insert** vào production (hiện chỉ có `.warn-box`) để nhất quán với xóa.
- Tải lại dữ liệu đã insert (JSON/CSV) từ Lịch sử: cần lưu dòng Query của lần chạy, đang cố ý không lưu.

## Đã chốt

Người dùng giao chọn theo phương án đề xuất; planner chốt như sau (2026-10-28):

1. **Bulk API 2.0 tự bật**, không có option trong workflow: bước Record ≥ 10 000 bản ghi mà alias không có Lookup nào trỏ tới
   (kể cả qua Chọn bản ghi). Tắt được cho một lần chạy bằng checkbox (mặc định bật) trong hộp xác nhận (`target.bulk`).
2. **Lô thử bằng sObject Collections**: bước Bulk chỉ mở job sau khi có một lời gọi Collections thành công; quy tắc dừng sớm 3
   lô của 0004 giữ nguyên. Job 10 000 bản ghi, **một job cùng lúc**, chạy song song với Collections; hai job liên tiếp lỗi
   100 % ⇒ dừng (`bulkFailing`); không tạo được job ⇒ bước đó về Collections kèm cảnh báo.
3. **Dừng chờ job Bulk đang xử lý xong** (số đếm và Id chính xác); **Dừng ngay** hủy job. Đóng tab = Dừng.
4. **Không nâng `maxRecordsHard`** (200 000); xem lại khi có số đo Bulk thật.
5. **Không gửi Collections song song**; không làm **chạy tiếp** (thay bằng xóa rồi insert lại); không làm **Update/Upsert**
   trong doc này.
6. **Lịch sử là file trên máy chạy server** (`SFDG_DATA_DIR` hoặc thư mục dữ liệu theo hệ điều hành, quyền `0700`/`0600`), ghi
   mọi lần insert (kể cả dừng, lỗi, gián đoạn), Id nối thêm sau **mỗi** lời gọi và chờ ghi xong trước lời gọi tiếp; không
   ghi được ⇒ không bắt đầu hoặc dừng insert. Giữ 100 lần / 256 MB, dọn mục đã xóa hết trước. Không lưu credential hay dòng
   Query.
7. **Xóa chỉ Id trong Lịch sử**, qua đúng một endpoint `POST /api/history/:hid/delete` có `confirm` (username + số bản ghi;
   production thêm tên org gõ tay) do server so lại, cộng kiểm tra `orgId` hiện tại trùng lúc insert. Thứ tự ngược lúc insert
   (con trước cha), Bulk `delete` cho sObject ≥ 10 000 sau lô thử, đã không còn = `gone`, một lượt thử lại `DELETE_FAILED`,
   vào Thùng rác (không bao giờ `hardDelete`), không SOQL kiểm tra trước.
8. **UI:** nút/link Lịch sử ở đầu panel kết quả và menu ⋯ (không thêm vào thanh trên), toast "Xóa dữ liệu này…", hộp Lịch sử
   lọc sẵn theo org đang chọn, hộp xác nhận xóa focus mặc định ở Hủy. Không thêm phím tắt.
9. **`planInsert` ở `shared/`** cho cả hộp xác nhận và sự kiện `plan`; hạn mức API lấy từ `/limits`, chỉ cảnh báo, không chặn.

## Đã làm

(Chưa làm. Cập nhật khi code xong: commit, chỗ khác thiết kế và lý do, số đo Bulk thật nếu có.)
