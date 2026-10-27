# 0004 — Chạy workflow dạng luồng (streaming): nghiên cứu khả thi và thiết kế

- **Trạng thái:** Nháp
- **Ngày:** 2026-10-27
- **Liên quan:** [0001](0001-workflow-editor-ux.md), [0002](0002-jsforce-api.md), [0003](0003-process-mode.md) (chế độ
  process, JSON v2 dạng cây), [0005](0005-variable-picker.md) (bộ chọn biến, `exposes`),
  [0006](0006-query-pick-nodes.md) (node Query và Chọn bản ghi ngẫu nhiên, mô hình đọc trước),
  [architecture.md](../architecture.md), [workflow-schema.md](../workflow-schema.md), [org-connection.md](../org-connection.md)

## Vấn đề

Người dùng hỏi: node có chạy được bằng Node.js streaming không, tức là mỗi node có input → xử lý → output và dữ liệu
truyền giữa các node dạng stream. Nếu tích hợp hết thì khó, có thể thêm checkbox **"stream mode"** để khi bật thì xử lý
theo từng phần (chunk). Yêu cầu là **nghiên cứu khả thi kỹ trước khi làm**.

Hiện tại người dùng gặp các vấn đề sau với workflow lớn, ví dụ 40 000 Account × 4 Contact = 200 000 bản ghi (số đo ở
[Số đo từ prototype](#2-số-đo-từ-prototype)):

- Bấm **Insert vào org** thì chỉ thấy "Đang sinh và insert vào dev-sb…" trong cả lần chạy. Lần chạy này cần 1 000 lời gọi
  API, ước tính 8–33 phút. Trong lúc đó không biết đã xong bao nhiêu, cũng không dừng được. Đóng tab thì server vẫn insert tiếp.
- Nếu Contact thiếu field bắt buộc, cả 40 000 Account được insert trước. Sau đó 800 lời gọi Contact lỗi hết, nên org bị
  đầy Account rác và tab lỗi có 160 000 dòng giống nhau.
- Server giữ toàn bộ bản ghi (85 MB heap) và dựng một JSON 46 MB, mất 2,6 s chỉ để `JSON.stringify`. Trong 4,2 s sinh dữ
  liệu, event loop bị chặn hẳn, nên `/api/validate` và mọi request khác phải chờ. Trình duyệt mất 1 s để parse, rồi mất
  126 ms mỗi lần bấm tab, dù bảng chỉ hiện 200 dòng.
- Xem trước 200 000 bản ghi cũng chịu đúng các chi phí đó, dù người dùng chỉ nhìn 200 dòng đầu.

## Mục tiêu / Ngoài phạm vi

- Mục tiêu:
  - Kết luận rõ "streaming" nào có ích cho người dùng, kèm số đo, và nói thẳng phần nào không đáng làm.
  - Bộ nhớ server gần như không tăng theo số bản ghi khi xem trước, insert hoặc tải về. Phần còn tăng được nêu rõ.
  - Khi chạy có tiến độ theo sObject và có nút **Dừng**. Lỗi sinh dữ liệu phải hiện ra **trước khi** ghi bản ghi đầu tiên vào org.
  - Lỗi insert hàng loạt thì dừng sớm và gom nhóm, thay vì spam org.
  - Cùng seed thì ra cùng dữ liệu, kể cả giữa lần xem trước và lần insert.
  - Khớp với mô hình "đọc trước rồi chạy executor thuần" của 0006. Nếu sau này có node cần I/O giữa lúc chạy, phải đổi
    được sang async generator mà không thiết kế lại (chi phí đo được là 0–3 %).
- Ngoài phạm vi:
  - Bulk API 2.0. Kết quả của Bulk API 2.0 không được tài liệu cam kết theo thứ tự dòng, nên muốn map về `ref` phải có
    External Id. Việc này cần design riêng.
  - Gửi song song nhiều lô.
  - Nâng `maxRecordsHard` quá 200 000.
  - Xóa dữ liệu đã insert, tải toàn bộ Id đã insert.
  - Chạy tiếp một lần chạy đã dừng.
  - Worker thread.

## Nghiên cứu khả thi

### 1. "Streaming" ở đây có thể là gì

| # | Cách hiểu | Giúp người dùng ở đâu |
| --- | --- | --- |
| (a) | Mỗi node là một object-mode stream (`Readable`/`Transform`/`Writable`, `stream.pipeline`, backpressure), hoặc async iterator nối node với node | Gần như không giúp gì (xem mục 3 và 4) |
| (b) | Executor sinh ra **một dòng bản ghi** (generator). Các sink tiêu thụ dòng đó: xem trước (đếm và giữ N dòng đầu), insert (gom window, rồi lô 200, rồi jsforce), tải file | Bộ nhớ phẳng, event loop không bị chặn, lỗi insert lộ ra sớm, dừng được |
| (c) | Server gửi tiến độ và kết quả cho UI dạng NDJSON trong lúc chạy, thay vì một JSON lớn ở cuối | Thấy tiến độ, có nút Dừng, không phải tải 46 MB |
| (d) | Kết hợp (b) và (c) | Tất cả các lợi ích trên. **Đây là phương án chọn** |

### 2. Số đo từ prototype

Prototype là script dùng một lần, đặt ngoài repo, import thẳng các module của repo. Workflow đo:
`Lặp i (N) → Account (6 field: Name company, AccountNumber pattern unique, Industry picklist, AnnualRevenue, Phone,
Website nullRatio 0.3) → Lặp loop (4) → Contact (6 field: FirstName, LastName, Email fromName, Title template,
AccountId lookup current acc, Birthdate)`. N = 10 000 cho 50k bản ghi, N = 40 000 cho 200k. Đo trên Node v22.22.0;
số tuyệt đối đổi theo máy, nên đọc theo tỉ lệ.

Prototype viết lại executor thành generator (`function*` và `async function*`, đệ quy bằng `yield*`), giữ nguyên thứ tự
duyệt. Với cùng seed và `now` cố định, đầu ra **giống từng byte** `runWorkflow` hiện tại trên hai workflow. Workflow thứ hai
có thêm Opportunity với Lookup `random` tới `acc`, và pool `random` lúc này chỉ giữ số đếm theo alias.

| Đo (200 000 bản ghi; trong ngoặc là 50 000) | Hiện tại: gom hết rồi trả JSON | Dòng bản ghi (b) + sink |
| --- | --- | --- |
| Thời gian sinh | 4,3 s (1,1 s), khoảng 22 µs/bản ghi | Như nhau: generator 4,3 s, async generator 3,8–4,8 s, `Readable.from` + `Writable` 4,2 s |
| Chi phí của async generator đệ quy thật | — | 0–3 %, nằm trong sai số |
| Event loop bị chặn liền một mạch | 4 193 ms (1 315 ms) | ≤ 160 ms (≈ 60 ms) khi nhường event loop mỗi 1 000 bản ghi |
| Trường hợp xấu nhất: không có bản ghi nào cho tới khi chạm `maxSteps` (2 triệu bước) | 571 ms | 571 ms (chấp nhận được; đây cũng là độ trễ tối đa của nút Dừng) |
| Heap sống lúc cao nhất khi sinh + insert (client giả) | 116,7 MB (29,9 MB) | 65,7 MB (16,8 MB) nếu giữ mọi Id. **37,5 MB (9,9 MB)** nếu chỉ giữ Id của alias được Lookup trỏ tới |
| Heap mà mảng `records` giữ lại | 85,5 MB, khoảng 450 B/bản ghi | 0,5 MB |
| Body `/api/run` | 46,3 MB, stringify 2,6 s (11,5 MB, 0,23 s) | **93 KB** (200 dòng đầu mỗi sObject) |
| Peak RSS server (sinh + stringify + Buffer) | 389 MB (160 MB) | 125 MB (79 MB) |
| Trình duyệt: parse / chuẩn bị bảng mỗi lần bấm tab | 1,0 s / 126 ms (0,2 s / 26 ms) | Không đáng kể |
| Tải JSON (pretty) dựng ở client | 65,9 MB, 3,3 s | Server sinh lại từ seed. CSV 160 000 Contact: 13,9 MB trong 5,3 s, RSS 124 MB |
| Số lời gọi API khi insert | 1 000 (đều là lô đầy 200) | 1 000 (1 000/1 000 lô đầy, window 2 000) |

Bộ nhớ còn tăng theo số bản ghi ở chế độ (b) đến từ hai nguồn, cả hai đều do ngữ nghĩa chứ không do cách chạy:

- **Tập giá trị `unique`**, khoảng 165 B/giá trị. Kiểu `email` có `uniqueDefault: true` (`server/generators/text.js`),
  nên 160 000 Email chiếm khoảng 26 MB trong số 37,5 MB ở trên.
- **Map `ref → Id`** của alias có Lookup trỏ tới, khoảng 100 B/bản ghi (40 000 Account ≈ 4 MB). Alias không ai trỏ tới
  thì không cần giữ Id.

Window insert ảnh hưởng tới độ đầy của lô như sau:

| Window | Workflow | Số lời gọi (lý tưởng) | Lô đầy |
| --- | --- | --- | --- |
| 2 000 | Account → Contact, 50k | 250 (250) | 250/250 |
| 2 000 | Account → Contact + Opportunity, 50k | 274 (250), +10 % | 226/274 |
| 500 | Account → Contact + Opportunity, 50k | 471 (250), +88 % | 100/471 |
| 200 | Account → Contact, 50k | 500 (250), +100 % | 0/500 |

Window 2 000 bản ghi (≈ 1 MB) gần như giữ nguyên số lời gọi của cách hiện tại.

Chồng việc sinh lên việc insert có nhanh hơn không? Giả lập 20 000 bản ghi (100 lời gọi):

| Độ trễ mỗi lời gọi | Gom hết rồi insert | Dòng bản ghi + insert | Phần thời gian dành cho sinh |
| --- | --- | --- | --- |
| 100 ms | 10,8 s | 10,6 s | 5 % |
| 500 ms | 50,9 s | 50,8 s | 1,2 % |

Insert thật dùng sObject Collections, giả định 0,5–2 s mỗi lô 200 tùy trigger, flow và validation rule. Như vậy 200 000 bản
ghi ≈ 1 000 lời gọi ≈ 8–33 phút, và phần sinh chỉ chiếm dưới 1 %. **Streaming không làm insert nhanh hơn.** Thứ làm
insert nhanh hơn là Bulk API hoặc gửi song song, cả hai đều ngoài phạm vi.

### 3. Ràng buộc của mô hình hiện tại và cách từng phương án xử lý

| Ràng buộc | (a) Stream theo từng node | (b) Dòng bản ghi + sink |
| --- | --- | --- |
| Executor đồng bộ, duyệt theo chiều sâu, lặp lồng nhau (`runChain` đệ quy) | Phải viết lại thành mạng Transform. Thứ chảy giữa các node là "lượt chạy" mang snapshot của scope, không phải bản ghi. `done` của Lặp phải chờ mọi lượt trong `body` xong, nên cần cơ chế join | Giữ nguyên thuật toán, vẫn đồng bộ (`function*`). `records.push(rec)` thành `yield rec`, đệ quy bằng `yield*` |
| Lookup `{ $ref }` cần Id thật của cha trước khi gửi con | Sink cuối phải tự sắp lại | Executor luôn sinh cha trước con. Window 2 000 rồi wave: cha ở window trước đã có Id, cha cùng window được gửi ở wave trước |
| Lookup `random` chọn trong **mọi** bản ghi đã sinh của alias | "Đã sinh tới lúc này" phụ thuộc buffer và lịch chạy, nên không tất định | Pool của alias Record chỉ cần **số đếm** `n`. `rng.pick(list)` và `alias#(floor(next()·n)+1)` rút cùng một số ngẫu nhiên, đã kiểm chứng giống từng byte. Pool dòng Query của 0006 vẫn là mảng (≤ 2 000 dòng) |
| `unique` và counter (`fieldState`) theo từng (node, field) | State dùng chung giữa các stream chạy xen nhau | Không đổi: state sống trong một lần chạy |
| Tất định theo seed (thứ tự gọi `ctx.rng`) | Thứ tự gọi RNG đổi theo `highWaterMark` và lịch chạy. Muốn tất định thì phải cho mỗi node một RNG riêng, và khi đó **mọi seed người dùng đã ghim sẽ ra dữ liệu khác** | Giữ nguyên thứ tự. Sink không gọi RNG. Chạy lần 2 cùng seed và `now` thì ra chuỗi y hệt |
| `LIMITS` (`maxRecords`, `maxSteps`) | Phải đếm chung qua nhiều stream | Như cũ. Dừng thì driver thôi gọi `next()` |
| Xem trước dạng bảng | — | Sink xem trước giữ 200 dòng đầu mỗi sObject. Bảng hiện cũng chỉ vẽ 200 dòng (`PREVIEW_ROWS`) |
| Lỗi mang `nodeId`/`field` | Lỗi nảy ra bất đồng bộ trong stream nào thì gắn node đó, nhưng khó nói "chưa ghi gì vào org" | Như cũ (`WorkflowError`), gửi qua sự kiện `error`. Lượt chạy thử bắt lỗi trước khi ghi (xem bên dưới) |
| Query (0006) đọc org | Tự nhiên nếu đọc giữa lúc chạy | 0006 đọc **trước** khi chạy (`prefetchQueries`), executor chỉ đọc `opts.queryResults`. Lượt chạy thử và lượt insert dùng chung `queryResults` nên ra chuỗi y hệt. Nếu sau này cần I/O giữa lúc chạy thì đổi sang `async function*`, chi phí đo được 0–3 % |

### 4. Stream theo node có hợp với Lặp/Rẽ nhánh không? Backpressure có ích ở đâu?

Không hợp. Workflow là **luồng điều khiển** (lặp, rẽ nhánh, "bản ghi hiện tại" của alias), không phải **luồng dữ liệu**.
Node sau không nhận bản ghi của node trước làm input. Nó đọc **trạng thái** (`scope.current`, biến lặp) tại đúng thời
điểm chạy. Ví dụ `{{acc.Industry}}` trong Contact phải là Account của **lượt lặp đang chạy**. Ở mô hình stream, Account
node có thể đã sinh trước acc#2…acc#17 vào buffer, nên mỗi lượt phải mang theo một bản chụp scope bất biến. Khi đó ta
thực chất đang tự viết lại executor đệ quy trên nền stream, chỉ thêm chi phí và rủi ro.

Backpressure chỉ có ý nghĩa giữa một bên nhanh và một bên chậm:

- Giữa các node: **không có I/O**. Sinh dữ liệu là việc CPU thuần, khoảng 22 µs/bản ghi, nên không có gì để cân bằng.
  Object-mode stream đo được nhanh ngang vòng `for` (4,2 s so với 4,3 s), nhưng cũng không đem lại gì.
- Giữa dòng bản ghi và org: **có**. Lời gọi API chậm hơn việc sinh khoảng 1 000 lần. Generator theo kiểu kéo cho ta
  backpressure miễn phí: driver chỉ gọi `next()` sau khi `await client.create(...)` xong, nên generator tự dừng và bộ nhớ
  chỉ giữ một window. Không cần đến `stream.Readable`.
- Giữa server và trình duyệt: chỉ có vài sự kiện tiến độ mỗi giây (đã throttle 250 ms). Khi tải file thì xử lý
  `drain` của `res`.

### 5. Kết luận

- **(a) Stream theo từng node: không làm.** Không hợp với luồng điều khiển, phá vỡ tất định theo seed (hoặc làm đổi dữ
  liệu của mọi seed cũ), phải viết lại executor, và không có I/O để chồng lên nhau.
- **Checkbox "stream mode": không cần.** Chạy dạng luồng không có nhược điểm nào để người dùng phải cân nhắc: dữ liệu y
  hệt, tốc độ như nhau, bộ nhớ thấp hơn. Checkbox chỉ bắt người dùng hiểu khái niệm nội bộ và nhân đôi đường code
  (vi phạm nguyên tắc 1 và 7). **Luôn chạy dạng luồng.** Người dùng chỉ thấy kết quả: có tiến độ, có nút Dừng, bảng xem
  trước ghi "Hiển thị 200/160 000 dòng đầu" như hiện nay.
- **Làm (d) = (b) + (c), theo từng phần.** Bên trong là dòng bản ghi từ một generator đồng bộ (`runWorkflow` vẫn đồng
  bộ như cũ), cộng các sink xem trước, insert và tải file, cộng NDJSON tiến độ. Kèm ba điểm an toàn mà streaming đem lại:
  1. **Lượt chạy thử trước khi ghi.** Sinh hết một lượt chỉ để đếm, tốn 4–5 s cho 200k, tức khoảng 1 % thời gian insert.
     Lượt này bắt lỗi `unique`, `maxRecords`, thiếu cha trước khi ghi bản ghi đầu tiên, giữ đúng cam kết hiện tại là
     "sinh xong mới insert", và cho tổng số chính xác để vẽ thanh tiến độ.
  2. **Dừng sớm khi lỗi hàng loạt.**
  3. **Gom nhóm lỗi.**

## Luồng người dùng

**Luồng chính A, insert thẳng không xem trước** (ví dụ mẫu "Account + Contact" sửa thành 40 000 Account):

1. Bấm **⤒ Insert vào org**. Vì chưa có bản xem trước khớp, app **tự chạy xem trước**. Panel kết quả hiện
   "Đang sinh dữ liệu… 120 000 bản ghi" kèm nút **Dừng**, mất khoảng 5 s cho 200k. (1 thao tác)
2. Hộp xác nhận ghi rõ org, `200 000 bản ghi: Account 40 000, Contact 160 000`, khoảng 1 000 lời gọi API, và cảnh báo nếu
   là production. Bấm **Insert 200 000 bản ghi**. (1)
3. Theo dõi thanh tiến độ: `12 400/200 000 (6 %) · còn khoảng 14 phút`, kèm chip theo sObject. (0)
4. Xong: toast `Đã insert 200 000 bản ghi vào dev-sb.` (0)

Tổng cộng **2 thao tác**. Hiện nay cần 4 thao tác (nhập seed, Xem trước, Insert, xác nhận) mới chắc dữ liệu insert giống
dữ liệu đã xem. Nếu không nhập seed, hộp xác nhận hiện nay không nói được sẽ insert bao nhiêu bản ghi.

**Luồng B, xem trước rồi insert:** Ctrl+Enter (1), xem bảng; **Insert** (1) mở xác nhận ngay vì workflow, seed và org khớp
lần xem trước, không chạy lại; xác nhận (1). Điều kiện "cùng org" lấy theo 0006 (`state.lastRunOrg === state.org`). Insert
dùng đúng `seed` và `now` của lần xem trước, nên ra đúng dữ liệu đó, kể cả field ngày tương đối như `today`, `-1y`.

Xem trước tự động ở luồng A gửi kèm org đang chọn, để node Query của 0006 đọc đúng org sẽ insert và có fingerprint cho
bước insert.

**Trường hợp lỗi:**

- *Lỗi khi sinh dữ liệu* (ví dụ hết giá trị `unique`). Ở bước 1 (xem trước tự động) thì không mở hộp xác nhận. Nếu lỗi
  nảy ra ở lượt chạy thử phía server thì dừng và báo `Lỗi khi sinh dữ liệu, chưa ghi bản ghi nào vào org: …`. Badge đỏ
  hiện trên node, inspector nhảy tới node đó như hiện nay.
- *Lỗi insert hàng loạt.* Ba lô Contact đầu tiên lỗi 100 % thì app tự dừng và báo cách sửa. Bấm nhóm lỗi để chọn node
  `con`, viền đỏ ở field `LastName` nếu Salesforce trả tên field. (1)
- *Bấm Dừng.* Lô đang gửi được gửi nốt, sau đó app báo chính xác đã insert bao nhiêu bản ghi của mỗi sObject. (1)
- *Đóng tab hoặc tải lại trang khi đang insert.* Trình duyệt hỏi xác nhận rời trang. Nếu vẫn rời thì server thấy kết nối
  đóng và dừng sau lô hiện tại.
- *Mất kết nối với server giữa chừng.* UI hiện số đã insert theo tiến độ cuối cùng nhận được và khuyên kiểm tra org
  trước khi chạy lại.

## Thiết kế UI

Không thêm option, checkbox hay cài đặt nào. Mọi thay đổi nằm ở panel kết quả, hộp xác nhận và hành vi của nút Insert.

### Panel kết quả khi đang chạy

```
┌ Kết quả ─ Đang insert vào dev-sb: 12 400/200 000 (6 %) · lỗi 3 · còn khoảng 14 phút ──────── [Dừng] ┐
│ [██████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░]                                    │
│ Account 2 480/40 000   Contact 9 920/160 000                                                         │
└───────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

| Giai đoạn | Dòng tóm tắt (`#results-summary`) |
| --- | --- |
| Xem trước | `Đang sinh dữ liệu… 120 000 bản ghi`, kèm chip `Account 24 000` `Contact 96 000` |
| Xem trước tự động trước khi insert | `Đang sinh dữ liệu để xác nhận trước khi insert… 120 000 bản ghi` |
| Lượt chạy thử phía server | `Đang kiểm tra dữ liệu trước khi ghi… 120 000/200 000` |
| Insert | `Đang insert vào <org>: 12 400/200 000 (6 %) · lỗi 3 · còn khoảng 14 phút` + `<progress>` + chip `<sObject> đã insert/tổng` |
| Đang dừng | `Đang dừng sau lô hiện tại…` (nút Dừng bị khóa) |

- Nút **Dừng** nằm ở đầu panel kết quả, chỉ hiện khi đang chạy. Tooltip:
  `Dừng sau lô đang gửi. Bản ghi đã insert vẫn ở lại trong org.`
- Thời gian còn lại tính ở client từ tốc độ của giai đoạn insert. Chỉ hiện sau 3 lô. Dưới 1 phút thì ghi `còn dưới 1 phút`.
- Tiến độ được throttle 250 ms ở server, nên UI không bị giật.
- Khi đang chạy, **Xem trước** và **Insert** bị khóa. Nếu bấm Ctrl+Enter thì hiện toast
  `Đang chạy. Bấm "Dừng" nếu muốn chạy lại.`
- Khi đang insert, gắn `beforeunload` (`event.preventDefault()` và `event.returnValue = ''`), nên trình duyệt hiện hộp
  hỏi rời trang mặc định của nó. Gỡ listener khi lần chạy kết thúc.

### Khi xong

- Xem trước: giữ dòng tóm tắt hiện tại (chip, seed, 📌 giữ seed, ms). Bảng giữ 200 dòng đầu mỗi sObject, lấy con số
  `limits.previewRows` từ `/api/meta`. Câu gợi ý dưới bảng: `Hiển thị 200/160 000 dòng đầu. Tải CSV/JSON để lấy đủ.`
- **Tải JSON** và **Tải CSV (tab hiện tại)** giữ nguyên nhãn. Tooltip mới:
  `Server sinh lại từ seed <seed>, ra đúng dữ liệu đang xem.` Khi đang tải, nút ghi `Đang tạo file…` và bị khóa.
  File dựng từ **bản chụp workflow lúc chạy** cùng `seed` và `now`, nên sửa workflow sau khi chạy không làm file lệch
  khỏi bảng.
- Insert thành công: toast giữ như hiện nay, `Đã insert 200 000 bản ghi.` hoặc
  `Insert 199 400, lỗi 600. Xem tab "Lỗi insert".`
- Dừng bằng tay (toast và dòng tóm tắt):
  `Đã dừng. Đã insert 12 400/200 000 bản ghi vào dev-sb (Account 2 480, Contact 9 920). Các bản ghi này vẫn còn trong org.`
  Nếu dừng trước khi ghi: `Đã dừng. Chưa ghi bản ghi nào vào org.`
- Tự dừng vì lỗi hàng loạt:
  `Đã dừng insert: 3 lô Contact đầu tiên (600 bản ghi) đều lỗi "REQUIRED_FIELD_MISSING: Required fields are missing: [LastName]". Sửa node "con" rồi chạy lại. Đã insert 400 Account, các bản ghi này vẫn còn trong org.`
- Mất kết nối:
  `Mất kết nối với server khi đang insert. Đã insert ít nhất 12 400 bản ghi (theo tiến độ cuối). Kiểm tra org trước khi chạy lại để tránh trùng.`

### Tab "⚠ Lỗi insert (N)": gom nhóm

| sObject | Node | Lỗi | Số bản ghi | Ví dụ |
| --- | --- | --- | --- | --- |
| Contact | con | REQUIRED_FIELD_MISSING: Required fields are missing: [LastName] | 600 | con#1, con#2, con#3 |
| Contact | con | Bỏ qua vì bản ghi cha lỗi. | 12 | con#41, con#42, con#43 |

- Bấm một dòng thì chọn node đó. Nếu nhóm có `field` (Salesforce trả đúng một field và field đó có trong node), viền đỏ
  field `fields.LastName`, giống lỗi validate.
- Đếm theo nhóm luôn đủ. Danh sách lỗi chi tiết từng bản ghi trong response chỉ giữ 1 000 dòng đầu.

### Hộp xác nhận Insert (luôn có số bản ghi)

```
Insert vào org?
Org: dev-sb (me@example.com)
[warn-box nếu production: "Org này không phải sandbox hay scratch org. Kiểm tra kỹ trước khi insert dữ liệu test."]
Sẽ tạo 200 000 bản ghi: Account 40 000, Contact 160 000.
Giống hệt bản xem trước (seed 42).
[nếu có node Query (0006): "Đọc từ org, không ghi: Account 200 (accs, đọc lúc 10:32)." và câu cảnh báo dữ liệu đọc đã đổi của 0006]
Khoảng 1 000 lời gọi API (200 bản ghi mỗi lời gọi), tính vào giới hạn API 24 giờ của org.
Có thể bấm "Dừng" bất cứ lúc nào; bản ghi đã insert không tự xóa.
                                             [Hủy]  [Insert 200 000 bản ghi]
```

Dòng của 0006 giữ đúng câu chữ trong doc 0006. Doc này chỉ thêm dòng số bản ghi theo sObject, dòng số lời gọi API, dòng
Dừng và nhãn nút có số bản ghi.

- Nút xác nhận ghi kèm số bản ghi (`Insert 200 000 bản ghi`) để khó bấm nhầm.
- Số lời gọi API ước tính bằng `Σ ceil(n_sObject / 200)`. Thực tế có thể nhiều hơn khoảng 10 % do window.
- Câu cũ `Chưa có bản xem trước với seed cố định…` bị bỏ, vì giờ luôn có bản xem trước (tự động nếu cần).

## Thiết kế phía server

```
POST /api/run ── validate → 422 · prefetchQueries (0006) → 409/502   ← đều trước khi gửi header, HTTP như cũ
                   │
                   ├─ createRun(workflow, {seed, now, queryResults})
                   ├─ run.records()  generator ĐỒNG BỘ, THUẦN (không I/O, không timer)
                   │     yield { ref, sobject, alias, nodeId, fields } theo đúng thứ tự hiện tại
                   │
server/run.js (driver) ── nhường event loop mỗi 1 000 bản ghi · throttle tiến độ 250 ms · signal
                   ├─ lượt 1: previewSink   đếm total/bySobject + 200 dòng đầu mỗi sObject
                   ├─ lượt 2 (chỉ khi target org, cùng seed + now ⇒ chuỗi y hệt lượt 1):
                   │     createInserter  window 2 000 → wave → lô 200 → client.create (jsforce)
                   └─ emit(event) ──► NDJSON ──► trình duyệt

POST /api/export ── createRun → run.records() → CSV/JSON ghi thẳng ra res (xử lý drain)
```

### Executor (`server/workflow/executor.js`)

```js
export function createRun(workflow, { seed, now, maxRecords, queryResults } = {}) // validate, throw WorkflowError
// → { seed, now, maxRecords, warnings, referencedAliases, columnsBySobject, records }
//   records(): Generator<Record>  mỗi lần gọi là một lần chạy mới (RNG, unique, counter mới)
export function runWorkflow(workflow, opts) // vẫn ĐỒNG BỘ: gom records() như cũ, cho test và chế độ JSON
// → { seed, now, records, warnings, stats }
```

- Giữ nguyên thuật toán duyệt. `runChain` thành `function*` và dùng `yield*` cho body của vòng lặp. Không chạy song song
  nhánh hay lượt lặp nào. Executor vẫn **thuần**: không I/O, không timer. Việc nhường event loop do driver làm.
- `runWorkflow` **vẫn đồng bộ** và giữ hình dạng kết quả, chỉ thêm `now`. Nhờ vậy test hiện có và chữ ký
  `runWorkflow(workflow, { seed, maxRecords, queryResults })` mà 0006 dùng đều không đổi.
- **Dừng:** driver chỉ cần thôi gọi `next()` và gọi `return()` trên generator, nên executor không cần `signal`. Trường hợp
  xấu nhất (không sinh bản ghi nào cho tới `maxSteps`) thì nút Dừng trễ tối đa khoảng 0,6 s (đo được 571 ms).
- **Pool của alias Record** trong `scope.all` đổi từ mảng bản ghi thành đối tượng chỉ đếm
  `{ kind: 'generated', length, refAt(i) }`, với `refAt(i)` = `alias#(i+1)`. Pool dòng Query của 0006 vẫn là mảng dòng.
  Ở `server/generators/reference.js`, chế độ `random` lấy `i = Math.floor(rng.next() * pool.length)` rồi trả
  `{ $ref: pool.refAt(i) }` (pool sinh ra) hoặc Id của dòng thứ `i` (pool Query, theo 0006). Phép rút này giống
  `rng.pick` (đã kiểm chứng). `length = 0` thì không rút số nào, giống `rng.pick([])`. `current` không đổi.
- `referencedAliases`: tập alias Record mà một field `lookup`/`masterdetail` (mode ≠ `fixed`) trỏ tới. Inserter chỉ giữ Id
  của các alias này, cộng Id của các dòng xem trước.
- `columnsBySobject`: cột CSV theo thứ tự node và field trong workflow. Khác hàm `toCsv` hiện tại (thứ tự xuất hiện) ở
  chỗ không phụ thuộc bản ghi.
- Nếu sau này có node cần I/O giữa lúc chạy, đổi `function*` thành `async function*` và các vòng tiêu thụ thành
  `for await`. Prototype đo được chi phí 0–3 % và ra đầu ra giống hệt, nhưng đổi như vậy sẽ làm `runWorkflow` thành
  async, nên chưa làm ở doc này.

### Inserter (`server/sf/insert.js`)

```js
export function createInserter(client, target, { window = 2000, keepId = () => true, signal, onBatch } = {})
// → { push(record): Promise<void>, end(): Promise<InsertSummary> }
export async function insertRecords(client, target, records, opts) // giữ API cũ: bọc createInserter
```

- Gom `window` bản ghi rồi chạy thuật toán wave hiện có trên window đó. `idByRef` và `failedRefs` **dùng chung giữa
  các window**. Con có cha bị lỗi ở window trước vẫn bị đánh "bỏ qua" như hiện nay.
- **Dừng sớm:** nếu 3 lô đầu tiên của một sObject đều thất bại 100 % thì ngừng gửi. Kết quả có
  `stopped: { reason: 'allFailing', sobject, nodeId, message }`. Lô thất bại sau khi sObject đó đã có lô thành công thì
  không tính, vì có thể là lỗi theo dữ liệu (trùng lặp, …).
- **Dừng bằng tay:** kiểm tra `signal` trước mỗi lô. Lô đang gửi luôn được chờ xong, nên số đã insert là chính xác.
- Lỗi từng bản ghi: `{ ref, sobject, nodeId, field?, message }`. `field` = `fields.<Name>` khi Salesforce trả đúng một
  field có trong node. "Bỏ qua vì bản ghi cha X lỗi." đổi thành `message: 'Bỏ qua vì bản ghi cha lỗi.'` kèm `parentRef`,
  để gom nhóm được.
- `errorGroups: [{ sobject, nodeId, field?, message, count, refs: [3 ref đầu] }]` đếm đủ. `errors` chỉ giữ 1 000 dòng đầu,
  kèm `errorsTotal`.

### Driver (`server/run.js`, mới)

```js
export async function executeRun({ run, target, sfClient, signal, emit, collect = false })
```

- `server/index.js` làm validate và `prefetchQueries` (0006) **trước** khi gọi hàm này, rồi tạo `run` với `queryResults`.
  Vì vậy lỗi 422, 409 (dữ liệu Query đã đổi) và 502 vẫn là HTTP status thường, và lượt 1 cùng lượt 2 dùng chung một
  `queryResults`.
- Lượt 1 (xem trước, hoặc chạy thử khi target là org): đếm `total`/`bySobject`, giữ `previewRows` dòng đầu mỗi sObject,
  phát `progress` (phase `generate`). Với `collect: true` (chế độ JSON cũ) thì giữ mọi bản ghi.
- Target org: phát `plan` (tổng chính xác, ước tính số lời gọi), rồi lượt 2 đẩy `run.records()` mới vào inserter và phát
  `progress` (phase `insert`) sau mỗi lô, đã throttle. Xong (kể cả khi dừng giữa chừng) thì gọi
  `queryCache.invalidateOrg(org)` như 0006 yêu cầu.
- Nhường event loop (`await new Promise(setImmediate)`) mỗi 1 000 bản ghi. Khi `signal` bị hủy thì thôi gọi `next()`.
- Sổ đăng ký lần chạy: `Map<runId, AbortController>` trong bộ nhớ, xóa khi chạy xong. `runId` là chuỗi ngẫu nhiên ngắn,
  không lộ gì.
- Các hằng nội bộ (không đưa ra meta): `INSERT_WINDOW = 2000`, `FAIL_FAST_BATCHES = 3`, `MAX_ERRORS_REPORTED = 1000`,
  `PROGRESS_INTERVAL_MS = 250`, `YIELD_EVERY = 1000`.

## Thay đổi dữ liệu / API

### Workflow JSON

**Không đổi**, vẫn `version: 1`. Không cần migration, và file đã lưu chạy y như cũ. Với cùng seed và `now` thì dữ liệu sinh
ra giống hệt bản hiện tại (test golden ở bước 0 của kế hoạch canh việc này).

### `POST /api/run` (dự kiến)

Request thêm khóa tùy chọn `now` (số mili giây). Thiếu thì server dùng giờ hiện tại. Không phải số hữu hạn thì trả 400
`Tham số now không hợp lệ.`

```json
{ "workflow": { "version": 1, "...": "..." }, "seed": 42, "now": 1761552000000, "target": { "kind": "org", "org": "dev-sb" } }
```

- Header **`Accept: application/x-ndjson`** → response là luồng NDJSON (`Content-Type: application/x-ndjson`,
  `Cache-Control: no-cache`, gửi header ngay). Không có header này → JSON một cục như hiện nay (đủ `records`, `ids`,
  `errors`). Chế độ này giữ cho script và test, kết quả thêm `now`.
- Lỗi validate vẫn là **HTTP 422** JSON như cũ, vì được phát hiện trước khi gửi header. Lỗi của bước đọc trước (0006:
  409 khi dữ liệu Query đã đổi, 502 khi Salesforce lỗi) cũng vậy.
- Mỗi dòng là một sự kiện:

```json
{"type":"start","runId":"r7f3k2","seed":42,"now":1761552000000,"warnings":[]}
{"type":"progress","phase":"generate","generated":120000,"bySobject":{"Account":24000,"Contact":96000}}
{"type":"plan","total":200000,"bySobject":{"Account":40000,"Contact":160000},"apiCalls":1000}
{"type":"progress","phase":"insert","inserted":12400,"failed":3,"total":200000,"bySobject":{"Account":{"inserted":2480,"failed":0,"total":40000},"Contact":{"inserted":9920,"failed":3,"total":160000}}}
{"type":"done","result":{"seed":42,"now":1761552000000,"warnings":[],"stats":{"total":200000,"bySobject":{"Account":40000,"Contact":160000},"durationMs":915000,"previewRows":200,"truncated":true},"records":["…200 dòng đầu mỗi sObject…"],"insert":{"inserted":200000,"failed":0,"errorsTotal":0,"errors":[],"errorGroups":[],"ids":{"acc#1":"001…"},"cancelled":false,"stopped":null}}}
{"type":"error","error":"Workflow chưa hợp lệ.","issues":[{"message":"Field AccountNumber: không tạo được giá trị duy nhất…","nodeId":"acc","field":"fields.AccountNumber"}],"insert":null}
```

- `plan` chỉ có khi target là org. Trong lượt chạy thử, client tự hiện `120 000/200 000`, vì tổng đã có từ bản xem trước
  vừa xác nhận. Server không cần thêm tham số.
- `progress` (phase `generate`) và `done.result.stats` có thêm `byStep` theo hình dạng của 0003, khóa theo `node.id`:
  `{ "<nodeId>": { "runs": 5, "records": 5 } }`. Lặp có thêm `iterations`, Rẽ nhánh có thêm `true` và `false`. Ví dụ
  ở trên lược bớt khóa này cho gọn. Có từ v1, nên chip của 0003 dùng được ngay khi lên v2.
- `done.result` có cùng hình dạng với JSON một cục hiện nay, cộng thêm: `now`, `stats.previewRows`, `stats.truncated`,
  `insert.errorsTotal`, `insert.errorGroups`, `insert.cancelled`, `insert.stopped`. Ở chế độ NDJSON, `records` và
  `insert.ids` chỉ chứa các dòng xem trước.
- `error` mang `issues` có `nodeId`/`field` (lỗi sinh dữ liệu), hoặc chỉ `error` (lỗi khác). `insert` là `null` nếu chưa
  ghi gì, còn không thì là tóm tắt đã insert tới lúc lỗi.

### Endpoint mới (dự kiến)

| Endpoint | Mô tả |
| --- | --- |
| `POST /api/runs/:runId/cancel` | Dừng lần chạy. Trả `{ "ok": true }`. Lần chạy đã xong hoặc không tồn tại thì trả 404 `Lần chạy này đã kết thúc.` Đóng kết nối của `/api/run` cũng làm lần chạy dừng sau lô hiện tại |
| `POST /api/export` | Body `{ workflow, seed, now, format: "csv" \| "json", sobject? }`. Sinh lại và ghi thẳng ra response kèm `Content-Disposition: attachment`. `csv` bắt buộc có `sobject`, thiếu thì trả 400 `Chọn sObject cần tải CSV.` `json` là mảng bản ghi, mỗi bản ghi một dòng (46 MB thay vì 66 MB bản pretty). Workflow có node Query (0006): body có thêm `org` và `expectQueries` của lần chạy, server đọc trước qua cache như `/api/run`. Fingerprint khác thì trả 409 `Dữ liệu đọc từ org đã đổi so với lần chạy này. Bấm Xem trước lại rồi tải.` |

### `GET /api/meta` (dự kiến)

`limits.previewRows: 200`. Số này chuyển từ hằng `PREVIEW_ROWS` ở client sang `LIMITS` ở server. Các giới hạn khác
không đổi.

### Tài liệu tham chiếu cần cập nhật khi làm (dự kiến; doc này không sửa)

- `docs/workflow-schema.md`, phần "Kết quả `/api/run`":
  - tham số `now`;
  - chế độ NDJSON và các sự kiện;
  - các khóa mới của kết quả;
  - `/api/export`, `/api/runs/:runId/cancel`;
  - câu "cùng seed và `now` ⇒ cùng dữ liệu".
- `docs/org-connection.md`, mục Insert:
  - window 2 000, wave dùng chung `idByRef`;
  - dừng sớm sau 3 lô lỗi 100 %;
  - Dừng bằng tay hoặc đóng kết nối;
  - `errorGroups`, giới hạn 1 000 lỗi chi tiết;
  - thứ tự insert xen kẽ giữa các sObject theo window.
- `docs/architecture.md`:
  - sơ đồ luồng mới (dòng bản ghi + sink);
  - executor là generator đồng bộ, vẫn thuần;
  - `server/run.js`;
  - `previewRows` trong bảng `LIMITS`.
- `CLAUDE.md` (mục Architecture): executor "yields records from a synchronous generator (`createRun().records()`);
  `server/run.js` drives the preview, insert and export sinks, so memory does not grow with the record count".
- `docs/field-types.md`: Lookup `random` chọn đều trong `alias#1…alias#n`, ý nghĩa không đổi. Ghi chú bộ nhớ của `unique`
  (khoảng 165 B/giá trị).

## Checklist tiện dụng

- [x] 1. Chạy được ngay với mặc định. Không có option hay checkbox mới. Workflow cũ chạy y như cũ. Streaming luôn bật và
  người dùng không cần biết tới nó.
- [x] 2. Ít thao tác cho việc hay làm. Insert có số bản ghi chính xác giảm từ 4 thao tác xuống 2 (xem trước tự động).
  Không có phím tắt mới, vì Dừng không phải thao tác lặp lại.
- [x] 3. Xem trước trước khi ghi. Hộp xác nhận **luôn** có org, số bản ghi theo sObject và số lời gọi API, kèm cảnh báo
  production. Insert dùng đúng `seed` + `now` của bản xem trước. Lượt chạy thử phía server bảo đảm lỗi sinh dữ liệu
  không xảy ra giữa lúc đang ghi.
- [x] 4. Lỗi chỉ đúng chỗ và nói cách sửa. Lỗi sinh dữ liệu vẫn có `nodeId`/`field`. Lỗi insert được gom nhóm, bấm để
  chọn node và field. Thông báo dừng sớm nói phải sửa node nào.
- [x] 5. Không mất công sức. Có `beforeunload` khi đang insert. Dừng thì báo chính xác đã ghi gì. File tải về dựng từ bản
  chụp workflow lúc chạy. Không thể "chạy tiếp" một lần đã dừng (ngoài phạm vi): bản ghi đã ghi vẫn còn và được báo rõ.
- [x] 6. Lấy thông tin từ org thay vì bắt gõ. Không liên quan trực tiếp. `field` của lỗi insert lấy từ `fields` mà
  Salesforce trả về.
- [x] 7. Một nguồn sự thật. `previewRows` chuyển sang `LIMITS` ở server và phục vụ qua `/api/meta`. CSV do server dựng,
  client bỏ `toCsv`.
- [x] 8. Giải thích tại chỗ. Có tooltip cho Dừng và cho nút tải về. Câu gợi ý cho bảng bị cắt. Hộp xác nhận nói rõ bản
  ghi đã insert không tự xóa.
- [x] 9. An toàn khi lỡ tay. `LIMITS` giữ nguyên. Dừng sớm khi lỗi hàng loạt giúp không spam org. Server không bị chặn
  quá 160 ms. Đóng tab là dừng insert.

## Phương án đã cân nhắc

| Phương án | Ưu | Nhược | Chọn? |
| --- | --- | --- | --- |
| Giữ nguyên (gom hết rồi trả JSON) | Không tốn công | 117 MB heap, JSON 46 MB, chặn event loop 4,2 s, insert 8–33 phút không tiến độ và không dừng được, lỗi hàng loạt spam org | Không |
| (a) Stream theo từng node (`Readable`/`Transform`/`Writable`, `pipeline`) | Đúng nghĩa "mỗi node input → xử lý → output" | Không hợp với Lặp/Rẽ nhánh/`current`. Cần join cho `done`. Phá tất định hoặc đổi dữ liệu của mọi seed cũ. Phải viết lại executor. Không có I/O để chồng nên không nhanh hơn | Không |
| Checkbox "stream mode" (bật mới xử lý theo chunk) | Rủi ro cục bộ khi mới làm | Người dùng phải biết khi nào cần bật (vi phạm nguyên tắc 1). Hai đường code, hai bộ test. Không bật thì không có lợi ích nào | Không |
| Tự chuyển sang luồng khi `count > N` hoặc target là org | Người dùng không phải chọn | Vẫn hai đường code. Ngưỡng N tùy ý, hành vi khó đoán | Không |
| **(d) Dòng bản ghi (generator đồng bộ) + sink + NDJSON, luôn bật** | Bộ nhớ phẳng (37,5 MB so với 117 MB), response 93 KB, có tiến độ, có Dừng, có dừng sớm, dữ liệu y hệt. `runWorkflow` giữ nguyên chữ ký nên khớp 0006 | Insert xen kẽ giữa các sObject. Lượt chạy thử tốn thêm khoảng 1 % thời gian | **Có** |
| (d) nhưng executor là `async function*` ngay từ bây giờ | Sẵn cho node có I/O giữa lúc chạy | 0006 đã chọn đọc trước nên chưa cần. `runWorkflow` thành async, phải sửa mọi test và chỗ gọi. Lợi ích chỉ là giả định | Không (đường lui đã ghi ở mục Executor) |
| (d) + Bulk API 2.0 ngay | Insert 200k nhanh hơn, ít lời gọi API | Kết quả không cam kết thứ tự, map `ref` cần External Id. Job bất đồng bộ phải poll. Phạm vi lớn | Không (design sau) |
| Tiến độ bằng SSE (`EventSource`) | Trình duyệt tự kết nối lại | `EventSource` chỉ GET, không gửi được body workflow, nên server phải lưu workflow trước (có trạng thái). Kết nối lại có thể chạy trùng insert | Không, dùng NDJSON qua `fetch` |
| Dừng bằng cách hủy `fetch` (`AbortController`) | Không cần endpoint | Client không nhận được tóm tắt cuối, nên không biết lô đang gửi có vào org không | Không. Dùng `/api/runs/:id/cancel`, và đóng kết nối chỉ là đường dự phòng |
| Tải file: client giữ mọi bản ghi nếu ≤ N | Không cần endpoint | Hai đường code. Vẫn tốn 46 MB khi gần N | Không, dùng `/api/export` sinh lại từ seed |

## Kế hoạch thực hiện

Mỗi bước nhỏ, có test riêng, và `npm test` phải xanh sau mỗi bước.

0. **Test golden trước khi refactor.** Thêm `test/stream.test.js` với test
   `golden: samples and random-lookup workflow give the same records as before streaming`. Test này lấy hash SHA-256 của
   `JSON.stringify(records)` với seed 42 và `NOW` cố định, cho hai mẫu trong `client/js/samples.js` và một workflow có
   Lookup `random`. Hash được ghi lúc code còn chưa đổi. Nếu bước 0 của 0003 (`test/fixtures/run-v1.js`, bản chép đóng
   băng của executor v1) đã có thì so với fixture đó thay cho hash.
1. **Executor generator.** Sửa `server/workflow/executor.js` (`createRun`, `records()` dạng `function*`, `runWorkflow`
   gom từ `records()` và thêm `now`, pool đếm `{ kind: 'generated', length, refAt }`, `referencedAliases`,
   `columnsBySobject`, đếm `byStep`) và `server/generators/reference.js` (chế độ `random` rút chỉ số rồi gọi `refAt`).
   Test hiện có giữ nguyên. Test mới:
   - `byStep counts runs, records, loop iterations and branch sides`;
   - `records() yields the same sequence as runWorkflow`;
   - `records() twice with same seed and now is identical`;
   - `stopping iteration early leaves no state behind` (gọi `return()` giữa chừng, chạy lại vẫn ra cùng chuỗi);
   - `maxRecords error still carries nodeId when streaming`;
   - `random lookup draws are unchanged` (golden).
2. **Inserter theo window.** Sửa `server/sf/insert.js` (`createInserter`, `insertRecords` bọc lại, dừng sớm, `signal`,
   `errorGroups`, `keepId`, `nodeId`/`field` trong lỗi). Test trong `test/sf.test.js`:
   - `windowed insert resolves parents from earlier windows`;
   - `failure cascades across windows`;
   - `window 2000 keeps batches full for nested Account→Contact` (4 000 bản ghi ⇒ 20 lời gọi);
   - `stops after 3 all-failing batches and reports stopped`;
   - `cancel waits for the in-flight batch and reports exact counts`;
   - `keepId limits retained Ids to referenced aliases and preview rows`;
   - `errors are capped at 1000 but groups count everything`.
3. **Driver.** Thêm `server/run.js` (lượt 1/lượt 2, sink xem trước, throttle, nhường event loop, sổ đăng ký `runId`,
   gọi `invalidateOrg` của 0006 nếu đã có) và `test/run.test.js`:
   - `preview emits start, progress, done with first 200 rows per sObject`;
   - `org target: dry pass error emits error and never calls create`;
   - `org target emits plan before insert progress`;
   - `cancel during insert emits done with cancelled true`.
4. **HTTP.** Sửa `server/index.js` (NDJSON theo header `Accept`, `now`, `/api/runs/:id/cancel`, `/api/export`, dừng khi
   kết nối đóng) và `server/workflow/nodes.js` (`LIMITS.previewRows`). Test trong `test/server.test.js`:
   - `POST /api/run with Accept ndjson streams events ending in done`;
   - `invalid workflow still returns 422 before streaming`;
   - `JSON mode keeps full records and adds now`;
   - `cancel unknown run returns 404`;
   - `export csv streams header + one line per record of the sObject`;
   - `export with same seed and now matches the preview rows`.
5. **Client.**
   - `client/js/api.js`: `runStream` đọc NDJSON bằng `res.body.getReader()` + `TextDecoder`; `cancelRun`; `exportFile`
     trả blob.
   - `client/js/results.js`: tiến độ, nút Dừng, bảng nhóm lỗi bấm để chọn node/field, tải về qua `/api/export`, bỏ
     `toCsv` và `PREVIEW_ROWS`.
   - `client/js/main.js`: xem trước tự động trước khi xác nhận, hộp xác nhận mới, `beforeunload`, bản chụp
     `state.resultRun = { workflow, seed, now }`.
   - `client/js/dom.js`: `download` nhận cả Blob.
   - `client/index.html`: nút Dừng, `<progress>`.
   - Mở rộng `.claude/skills/smoke-test/smoke.cjs`: xem trước mẫu vẫn ra bảng; sửa số lần lặp lên 20 000 thì thấy chữ
     `Đang sinh dữ liệu` hoặc bảng có `Hiển thị 200/`; bấm Tải CSV thì nhận file có ≥ 2 dòng.
6. **Tài liệu.** Cập nhật các tài liệu ở mục "Tài liệu tham chiếu cần cập nhật" và phần "Đã làm" của doc này.

## Rủi ro

- **Dữ liệu lệch so với trước khi refactor.** Hiện nay người dùng ghim seed để tái lập dữ liệu. Giảm rủi ro bằng test
  golden ở bước 0, và không gộp việc refactor với thay đổi generator nào khác.
- **Thứ tự insert đổi.** Hiện nay cả 40 000 Account vào org trước. Từ nay Account và Contact xen kẽ theo window 2 000. Cha
  vẫn luôn vào trước con. Trigger hoặc flow nào giả định "mọi Account đã có trước Contact đầu tiên" sẽ thấy khác. Ghi rõ
  điều này trong `org-connection.md`.
- **Dừng giữa chừng để lại dữ liệu dở** (Account không có đủ Contact). Hộp xác nhận và thông báo nói rõ điều này. Tính
  năng xóa dữ liệu đã insert là việc sau.
- **Lượt chạy thử nhân đôi CPU** (4–5 s cho 200k). Chấp nhận được, vì chỉ khoảng 1 % thời gian insert, và đổi lại không
  bao giờ ghi dở vì lỗi sinh dữ liệu.
- **`unique` vẫn tốn bộ nhớ tăng dần** (khoảng 165 B/giá trị; 200k Email ≈ 30 MB). Đây là ngữ nghĩa của "duy nhất trong
  lần chạy", và nằm trong ngân sách hiện tại.
- **Đọc NDJSON ở trình duyệt.** `fetch` + `ReadableStream` có trong mọi trình duyệt hiện đại. Server chỉ bind localhost,
  nên không có proxy nào gom buffer luồng.
- **Bộ nhớ trình duyệt khi tải file lớn.** Blob JSON 46 MB cho 200k. Chấp nhận được với trần 200k.

## Câu hỏi mở

### Cần người dùng quyết định

1. **Không có checkbox "stream mode", luôn chạy dạng luồng.** Khuyến nghị: đồng ý. Nếu vẫn muốn có checkbox thì cần nói
   rõ người dùng sẽ cân nhắc điều gì khi bật hay tắt nó.
2. **Xem trước tự động khi bấm Insert** mà chưa có bản xem trước khớp, để hộp xác nhận luôn có số bản ghi. Với 200k thì
   chờ thêm khoảng 5 s. Khuyến nghị: đồng ý.
3. **Dừng sớm sau 3 lô đầu lỗi 100 %** của một sObject. Có cần cho tắt không? Khuyến nghị: luôn bật, không có option.
4. **Thứ tự insert xen kẽ theo window 2 000** thay vì tất cả sObject cha trước. Khuyến nghị: chấp nhận.
5. **Tải JSON** đổi từ pretty sang một bản ghi một dòng (vẫn là mảng JSON hợp lệ). Khuyến nghị: đồng ý.
6. **Nâng `maxRecordsHard` quá 200 000?** Khuyến nghị: chưa. Để dành cho design Bulk API, vì 1 triệu bản ghi qua sObject
   Collections là 5 000 lời gọi API và hàng giờ chạy.
7. **Có cần tải toàn bộ Id đã insert** (ví dụ để xóa sau) không? Khuyến nghị: làm cùng tính năng xóa, không làm trong doc
   này. NDJSON có thể thêm sự kiện `ids` theo lô, khoảng 8 MB cho 200k.

### Phụ thuộc và giả định với các design song song

- **0006 (Query, Chọn bản ghi ngẫu nhiên)**, theo bản nháp hiện tại, dùng mô hình đọc trước:
  - `prefetchQueries` chạy trước, rồi `runWorkflow(workflow, { seed, maxRecords, queryResults })` vẫn thuần và đồng bộ.
    Doc này **giữ đúng chữ ký đó** và đặt bước đọc trước trước khi gửi header NDJSON.
  - Lượt chạy thử và lượt insert dùng chung một `queryResults`, nên ra chuỗi bản ghi y hệt. Lượt insert không đọc lại org,
    nên không thấy bản ghi do chính nó vừa tạo.
  - `scope.all[alias]` của Query (mảng dòng, ≤ `maxQueryRows` = 2 000) **giữ nguyên**. Chỉ pool của alias **Record** đổi
    thành đối tượng đếm `{ kind: 'generated', length, refAt }`. Cần 0006 xác nhận: Lookup "Ngẫu nhiên trong pool" phân
    biệt hai loại pool bằng `kind` (hoặc `Array.isArray`), và cả hai cùng rút đúng một số `Math.floor(rng.next() * length)`.
  - Node Chọn bản ghi chỉ lấy từ pool Query (`lookupTarget: "org"`), nên không cần giữ bản ghi đã sinh. Nếu sau này muốn
    chọn từ bản ghi **đã sinh** kèm field, executor phải giữ bản ghi của alias đó (biết trước từ workflow), tốn khoảng
    450 B/bản ghi.
  - Hộp xác nhận: dòng "Đọc từ org, không ghi…" và điều kiện "cùng org" của 0006 được giữ nguyên. Doc này chỉ thêm các
    dòng của mình (xem [Hộp xác nhận Insert](#hộp-xác-nhận-insert-luôn-có-số-bản-ghi)).
  - `queryCache.invalidateOrg(org)` được gọi ở cuối driver, kể cả khi dừng giữa chừng.
- **0003 (chế độ process, JSON v2 dạng cây):**
  - Hợp đồng của doc này nằm ở dòng bản ghi, nên không phụ thuộc đồ thị hay cây. Dòng bản ghi theo thứ tự sinh, cha
    trước con, mỗi bản ghi có `nodeId`.
  - 0003 đề xuất làm bước 1–3 của nó (hợp đồng v2, server, executor `runSteps`) trước. Khi đó bước 1 của doc này áp vào
    `runSteps` thay cho `runChain`: đổi thành `function*` và `yield*` cho `slots`. Sink, inserter, NDJSON và UI tiến độ
    giữ nguyên.
  - **Cần 0003 cập nhật:** phần "Phụ thuộc" của 0003 đang ghi theo bản nháp trước của doc này (`async function*`). Từ bản
    này, executor là **`function*` đồng bộ**, vì 0006 đã chọn đọc trước (xem mục Executor).
  - **Nhận đề xuất `byStep` của 0003:** sự kiện `progress` và `stats` cuối có `byStep` đúng hình dạng `stats.byStep` của
    0003 (xem [mục API](#post-apirun-dự-kiến)). `errorGroups[].nodeId` và `stopped.nodeId` để 0003 dựng badge lỗi trên
    thẻ (việc sau của 0003).
  - 0003 để nhánh song song ra ngoài phạm vi, vì executor phải chạy tuần tự để giữ tính tái lập theo seed. Doc này cũng
    dựa trên giả định chạy tuần tự đó.
- **0005 (bộ chọn biến):** Không xung đột, vì `/api/run` chỉ được thêm khóa. Pool của alias Record không còn giữ field
  của từng bản ghi. 0005 đã coi `pool` là thứ chỉ dùng qua Lookup hoặc node Chọn bản ghi (biến có sẵn như `$count`), nên
  đúng với thay đổi này. Nếu 0005 thêm `{{acc.$count}}` cho alias Record thì lấy `pool.length`.

## Đã làm

(Cập nhật khi code xong: commit hoặc PR, chỗ nào khác với thiết kế và vì sao.)
