# 0003 — Chế độ Quy trình (giống Power Automate) và mô hình workflow dạng cây

- **Trạng thái:** Đã duyệt (2026-10-27, xem [0007](0007-tong-hop-0003-0006.md)). Đợt A đã làm; đợt B (Sơ đồ) chờ quyết định sau khi dùng thử.
- **Ngày:** 2026-10-27
- **Liên quan:** [0001](0001-workflow-editor-ux.md), [workflow-schema.md](../workflow-schema.md), [architecture.md](../architecture.md).
  Viết song song với 0004 (chạy dạng stream), 0005 (chọn biến / "dynamic content"), 0006 (node Query, Pick random record).
  Xem phần [Phụ thuộc với 0004–0006](#phụ-thuộc-và-giả-định-về-00040006).

## Vấn đề

Người dùng muốn mô tả "5 Account, mỗi Account 1–4 Contact, 30% Contact có Task". Trên canvas hiện tại họ phải hiểu cổng
và dây nối, và gặp các chỗ khó sau (đã kiểm tra trên code hiện tại):

- **Không thấy được phạm vi.** Thân vòng lặp là "chuỗi đi từ cổng `lặp` tới khi hết dây", nên nhìn sơ đồ không biết bước nào
  nằm trong vòng lặp. Nối nhầm `acc → X` thay vì `Lặp (xong) → X` thì X chạy trong mỗi vòng mà không có cảnh báo nào.
- **Chèn hoặc xóa ở giữa phải tự nối lại dây.** Chọn A (đã nối tới B) rồi bấm Record thì node mới **không được nối**,
  vì cổng của A đã có dây (`addNode` trong `canvas.js`). Xóa một node ở giữa thì phần sau bị đứt, chỉ còn cảnh báo
  "Node chưa được nối từ Bắt đầu".
- **Quy tắc "phía trước" chặn một mẫu rất hay dùng.** Workflow `Lặp 10 → Account`, `xong → Contact × 50` với
  `AccountId` = *ngẫu nhiên trong các bản ghi đã sinh* của `acc` bị báo lỗi
  `Field "AccountId": node "acc" phải nằm phía trước node này trong workflow.`, dù khi chạy thì Account đã có trước.
  Lý do: validate dò theo dây, mà thân vòng lặp không có dây nối sang cổng `xong`.

Người dùng đã quen Power Automate: danh sách thẻ từ trên xuống, nút "+" giữa các bước, "Apply to each" là một khung chứa
các bước con, "Condition" có hai cột "If yes" / "If no". Họ muốn có chế độ này, và **nếu không làm tốt được cả hai chế độ
thì ưu tiên chế độ Quy trình**.

## Mục tiêu / Ngoài phạm vi

- Mục tiêu:
  - Chế độ **Quy trình** là chế độ mặc định: thẻ bước xếp dọc, "+" giữa các bước, Lặp và Rẽ nhánh là khung lồng nhau,
    thu gọn/mở, kéo thả và phím tắt để di chuyển, badge lỗi trên thẻ.
  - Không còn trạng thái "vẽ được mà không chạy đúng": không có node lơ lửng, không có dây chéo, không có vòng.
  - Mở được mọi workflow đã lưu (`localStorage` và file `.json` version 1), không mất công sức.
  - Chế độ **Sơ đồ** (thay canvas hiện tại): cùng dữ liệu, tự sắp xếp, zoom/pan, thêm bước bằng "+" trên đường nối.
  - Có chỗ sẵn cho 0005 (chọn biến trong thẻ) và 0006 (loại bước mới) mà không phải sửa view.
- Ngoài phạm vi:
  - Nhánh song song (Power Automate "Add a parallel branch"): executor chạy tuần tự để giữ tính tái lập theo seed.
  - Sửa cấu hình ngay trong thẻ (inline). Bản này sửa ở panel phải, xem [Câu hỏi mở](#câu-hỏi-mở).
  - Chọn nhiều bước, copy/paste bước giữa các workflow, ước tính số bản ghi trước khi chạy.
  - Vẽ dây tự do và đặt vị trí node bằng tay trên Sơ đồ.

## Phân tích mô hình: đồ thị hay cây

### Mô hình hiện tại và mô hình mà chế độ Quy trình cần

Hiện tại (v1) workflow là **đồ thị**: `nodes` + `edges`, mỗi cổng ra tối đa một dây, cổng vào nhận nhiều dây (để gộp
nhánh), không có vòng. Thứ tự chạy được suy ra từ dây: Lặp chạy chuỗi `body` tới khi hết dây rồi đi theo `done`; Rẽ nhánh
đi một trong hai cổng.

Chế độ Quy trình tự nhiên là **cây phạm vi**: một dãy bước; bước Lặp chứa một dãy con (thân); bước Rẽ nhánh chứa hai dãy
con (Đúng, Sai); chạy xong khung thì đi tiếp bước kế dưới. Một đồ thị v1 hiển thị được dạng cây khi và chỉ khi nó
"có cấu trúc": mỗi Rẽ nhánh có một điểm gộp chung cho cả hai nhánh (hoặc cả hai cùng kết thúc), và không node nào được tới
từ hai chỗ mà không qua điểm gộp đó.

### Các dạng đồ thị v1 mà cây không biểu diễn được

Thuật toán chuyển (mục [Chuyển v1 → v2](#chuyển-v1--v2-migration)) đã được chạy thử trên các trường hợp dưới đây với
executor thật. Hai mẫu có sẵn, gộp nhánh sau Rẽ nhánh, gộp lồng nhau và Lặp trong nhánh rồi gộp đều ra **bản ghi giống hệt
từng byte** với cùng seed.

| # | Dạng | Ví dụ (v1) | Cây biểu diễn được? | Xử lý khi chuyển |
| --- | --- | --- | --- | --- |
| 1 | Gộp sau Rẽ nhánh | `b.true → A → X`, `b.false → X` | **Được**: X là bước sau khung Rẽ nhánh | Giữ nguyên ngữ nghĩa |
| 2 | Gộp lồng nhau | `b1.false → b2`, `b2.true → C → J`, `b2.false → J`, `b1.true → A → J` | **Được** | Giữ nguyên |
| 3 | Nhánh không nối | `b.false` không có dây | **Được**: nhánh Sai rỗng | Giữ nguyên |
| 4 | Thân Lặp "thoát" ra ngoài | `l.body → A → C`, `l.done → C` | Không: C vừa trong thân vừa sau vòng | Nhân bản C (và phần đuôi sau C) |
| 5 | Nối chéo giữa các nhánh | `b1.true → A → X`, `b1.false → b2`, `b2.true → X`, `b2.false → Z` | Không: X ở hai nhánh khác cấp | Nhân bản X |
| 6 | Hai vòng lặp dùng chung thân | `l1.body → A`, `l2.body → A` | Không | Nhân bản A |
| 7 | Node lơ lửng | node không được nối từ Bắt đầu (hiện là cảnh báo "sẽ không chạy") | Không có chỗ | Đặt ở cuối, **tắt** (`disabled`) |
| 8 | Trạng thái lỗi đã autosave | vòng bằng dây; một cổng hai dây; dây tới node không tồn tại | Không | Cắt dây gây vòng; giữ dây mà executor v1 thực sự chạy (dây sau cùng); bỏ dây hỏng. Ghi vào báo cáo |

Dạng 4–6 chỉ tạo được bằng cách nối dây tay trên canvas, và dạng 4 thường là **nối nhầm**. Dự án vừa được dựng (3 commit)
nên gần như chưa có workflow nào như vậy. Dù vậy vẫn phải mở được chúng mà không mất node nào.

### Các phương án

**(a) Cây là mô hình chuẩn (workflow JSON v2); Sơ đồ là bản vẽ tự sắp xếp của cây, chỉ sửa có giới hạn.**

- Chế độ Quy trình hiển thị và sửa **đúng** dữ liệu được lưu, không có trạng thái nào không vẽ được.
- Mọi thao tác (chèn, di chuyển, xóa, bọc) là thao tác trên mảng, viết một lần và test được bằng `node:test`.
- Validate đơn giản hơn và **đúng hơn**: "phía trước" = chạy trước theo thứ tự trên-xuống, nên mẫu "Lặp Account rồi
  Contact ngẫu nhiên" hết bị báo lỗi. Cả nhóm lỗi về dây (vòng, cổng hai dây, node lơ lửng, thiếu Bắt đầu) biến mất.
- 0005 cần biết "tại bước này có những biến nào". Bản nháp 0005 phải dựng phân tích luồng dữ liệu trên đồ thị: ngữ cảnh
  vòng lặp, thứ tự topo, phép gộp ở điểm kết thúc, trần 1 000 ngữ cảnh. Trên cây, việc đó chỉ là một lần duyệt từ trên xuống.
- Giá phải trả: đổi định dạng file (cần migration); Sơ đồ mất kéo dây và đặt vị trí tự do; server, executor, gần như mọi
  file client đều phải sửa.

**(b) Giữ đồ thị là mô hình chuẩn; Quy trình chỉ hiển thị đồ thị "có cấu trúc", còn lại thì báo "Mở ở Sơ đồ để sửa".**

- Không đổi định dạng, không đổi server.
- Mỗi thao tác trên Quy trình phải dịch thành phẫu thuật dây. Ví dụ "chèn sau khung Rẽ nhánh" = nối lại đuôi của mọi nhánh
  (kể cả nhánh rỗng, nhánh lồng) vào bước mới. Lỗi ở lớp dịch là mất dữ liệu.
- Canvas vẫn tạo được dạng 4–7 bất cứ lúc nào, nên Quy trình (chế độ được ưu tiên) có thể bị khóa giữa chừng.
- Lỗi "phía trước" vẫn còn, vì validate vẫn dò theo dây.

**(b2) Cây trong client, nhưng vẫn lưu và gửi đồ thị v1.** Client chuyển cây ↔ đồ thị mỗi lần sửa, server giữ nguyên.
Không phải bump version, nhưng file lưu ra là dây nối vô nghĩa với người đọc (vị trí rác). Lỗi "phía trước" vẫn còn,
và 0004/0005 vẫn phải suy luận trên đồ thị. Thực chất đây là (a) cộng thêm một lớp dịch.

**(c) Chỉ còn chế độ Quy trình, bỏ canvas.** Ít việc nhất, nhưng mất góc nhìn tổng quan zoom/pan mà người dùng muốn giữ.

### Khuyến nghị: (a), làm theo hai đợt

1. **Đợt A** (bằng (c) cộng migration): định dạng v2, server, executor, chế độ Quy trình. Canvas cũ bị ẩn trong đợt này.
2. **Đợt B**: chế độ Sơ đồ vẽ lại từ cây (tự sắp xếp, "+" trên đường nối, chọn, xóa, nhân bản).

Lý do chọn:

- Người dùng ưu tiên Quy trình. Chỉ (a) làm cho Quy trình luôn dùng được.
- Power Automate cũng làm như vậy: Condition và Apply to each là phạm vi chứa danh sách hành động con. Designer mới vẽ
  các phạm vi đó tự sắp xếp, cấu hình ở panel bên cạnh, không có dây tự do.
- (a) sửa được lỗi "phía trước" và cho 0005 một nền đơn giản.
- Rủi ro chính là migration. Rủi ro này đo được: chuyển rồi chạy phải ra cùng bản ghi với executor v1. Nó cũng không làm mất
  gì, vì bản gốc luôn được giữ lại.

Đây là **đổi hướng dự án**: workflow không còn là đồ thị tự do. Cần người dùng duyệt (xem [Câu hỏi mở](#câu-hỏi-mở), câu 1).

## Luồng người dùng

### Luồng chính: "5 Account, mỗi Account 1–4 Contact, 30% Contact có Task"

Bắt đầu từ workflow trống, org đã chọn ở thanh trên. Chế độ Quy trình hiện thẻ **Bắt đầu** và nút lớn **+ Thêm bước đầu tiên**.

1. Bấm **+ Thêm bước đầu tiên** → chọn **Lặp** trong menu. Bước Lặp được thêm và chọn; inspector hiện "Số lần lặp: 3". (2)
2. Gõ `5` vào "Số lần lặp". (1)
3. Bấm **Record** ở cột trái. Bước Lặp đang chọn có thân rỗng nên Record vào **trong thân**: Account, alias `acc`, field `Name`. (1)
4. Bấm **Lặp** ở cột trái. Bước này vào ngay sau `acc`, vẫn trong thân, biến lặp tự đặt `loop2` để không che vòng ngoài.
   Đổi "Số lần" thành *Ngẫu nhiên trong khoảng* và "Nhiều nhất" thành `4` ("Ít nhất" mặc định 1). (3)
5. Bấm **Record**: bước vào thân vòng trong. Gõ `Contact` vào sObject, alias tự đổi thành `con`. (2)
6. **Import từ org…** → field bắt buộc đã được chọn sẵn. `AccountId` tự chọn bản ghi cha `acc`, vì đó là bước Account duy
   nhất ở phía trên → **Thêm field đã chọn**. (2)
7. Bấm **Rẽ nhánh**: bước vào sau `con`. Đổi "Xác suất" thành `0.3`. (2)
8. Bấm **Record**: Rẽ nhánh đang chọn có nhánh Đúng rỗng nên Record vào **nhánh Đúng**. Gõ `Task` vào sObject, rồi
   **Import từ org…**: `WhoId` tự chọn `con`. (4)
9. **Ctrl+Enter** để xem trước. Các thẻ hiện số liệu, ví dụ `5 bản ghi`, `12 bản ghi`, `Đúng 4 · Sai 8`, nên thấy ngay
   khoảng 30% Contact có Task. Bấm **📌 giữ seed** → **Insert vào org** → hộp xác nhận ghi rõ org, số bản ghi theo sObject,
   và cảnh báo nếu là production → **Insert**. (4)

Tổng cộng **21 thao tác**. Phần dựng khung (bước 1, 3, 4, 5, 7, 8) chỉ là bấm cột trái, giống canvas hiện tại, nhưng không phải
chọn đúng node làm "neo" và không phải nghĩ tới cổng. Thay vì bước 1–8, người dùng mới có thể bấm mẫu "Account + Contact" ở cột trái (1).

### So sánh số thao tác với canvas hiện tại

| Việc | Canvas v1 | Quy trình |
| --- | --- | --- |
| Thêm bước nối tiếp bước đang chọn | 1 (cột trái) | 1 (cột trái) hoặc 2 (+ → loại) |
| Chèn bước vào giữa A → B | 3: node mới **không tự nối**, phải kéo 2 dây | 2: bấm "+" giữa A và B → chọn loại |
| Thêm bước sau một vòng lặp | 2: chọn Lặp → cột trái (vào cổng `xong`) | 2: "+" dưới khung Lặp → loại |
| Di chuyển một bước sang chỗ khác | 3–4 lần kéo dây | 1 lần kéo thả, hoặc Alt+↑/↓ |
| Đưa bước có sẵn vào trong vòng lặp mới | khoảng 5 (thêm Lặp, nối lại 3 dây) | 2: ⋯ → **Bọc trong Lặp** |
| Xóa bước ở giữa chuỗi | 2 (Delete, nối lại dây); quên nối thì phần sau âm thầm không chạy | 1 (Delete), chuỗi tự liền |

### Luồng phụ và trường hợp lỗi

- **Mở workflow cũ.** Khi tải trang mà autosave còn là version 1, hoặc khi mở file `.json` version 1, client chuyển sang
  version 2 ngay trong trình duyệt.
  - Nếu chuyển không đổi gì: toast `Đã chuyển "<tên>" sang định dạng mới (version 2). Bấm Lưu để cập nhật file.`
  - Nếu có nhân bản, tắt bước hay bỏ dây: hiện hộp thoại báo cáo (mục [Chuyển workflow cũ](#chuyển-workflow-cũ)).
- **Kéo `acc` xuống dưới `con`.** Thẻ `con` có badge đỏ, chip `AccountId` viền đỏ, và lỗi:
  `Field "AccountId": bước "acc" nằm sau bước này nên chưa có bản ghi khi chạy tới đây. Kéo bước "acc" lên phía trên hoặc chọn bản ghi cha khác.`
  Ctrl+Z đưa về chỗ cũ.
- **Xóa khung Lặp đang có bước bên trong.** Hộp thoại có nút "Chỉ xóa vỏ, giữ 3 bước" (mục [Xóa](#xóa-nhân-bản-tắt-bọc)).
- **Lặp chưa có bước con.** Không chặn chạy. Trong khung có dòng cảnh báo vàng
  `Vòng lặp chưa có bước nào. Bấm "+ Thêm bước vào vòng lặp".`
- **Xem trước khi có lỗi.** Giống hiện tại: bước lỗi đầu tiên được chọn. Thêm: các khung đang thu gọn chứa bước đó tự mở
  và danh sách cuộn tới thẻ đó.

## Thiết kế UI

### Bố cục và chuyển chế độ

```
┌ Topbar: tên · Mới/Mở/Lưu/↶/↷ · [Quy trình | Sơ đồ] ······· Seed · Org ⟳ · ▶ Xem trước · ⤒ Insert ┐
├ Thêm bước ┬──────────── Vùng xem (cuộn dọc) ─────────────────┬── Inspector ───────────────┤
│ Record    │  ┌ Bắt đầu · Account + Contact · ≤ 50 000 bản ghi ┐│ cấu hình bước đang chọn    │
│ Lặp       │  └─────────────────────┬──────────────────────────┘│ (form dựng từ /api/meta)   │
│ Rẽ nhánh  │                       (+)                          │                            │
│ Mẫu…      │  ┌ Lặp  i · 5 lần ─────────────────────── ⋯ ▾ ┐    │                            │
│           │  │ ┌ Record  acc · Account × 1 · 5 field ⋯ ▸┐ │    │                            │
│           │  │ └──────────────────┬───────────────────────┘ │    │                            │
│           │  │                   (+)                         │    │                            │
│           │  └───────────────────────────────────────────────┘    │                            │
│           │  [● 1 lỗi · 2 cảnh báo] (góc dưới trái, như hiện tại) │                            │
├───────────┴────────────────────────────────────────────────────┴────────────────────────────┤
│ Kết quả (không đổi)                                                                         │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

- Nút chuyển chế độ là một cặp nút liền nhau **Quy trình | Sơ đồ** ở thanh trên, `title="Đổi chế độ xem (M)"`.
  Mặc định là **Quy trình**. Lựa chọn được nhớ trong `localStorage['sfdg.view']`. Đợt A chưa có nút này.
- **Giữ lựa chọn khi đổi chế độ.** `state.selection` dùng chung. Chế độ mới cuộn hoặc pan tới bước đang chọn
  (`scrollIntoView({ block: 'center' })` ở Quy trình, `ensureVisible` ở Sơ đồ). Nếu bước nằm trong khung đang thu gọn thì
  mở các khung tổ tiên. Đổi chế độ không tạo bước undo và không đổi dữ liệu.
- Cột trái đổi tiêu đề thành **Thêm bước**, hint: `Bấm để thêm sau bước đang chọn (hoặc vào nhánh còn trống của nó). Kéo vào một dấu + để đặt đúng chỗ.`
- Hộp lỗi góc dưới trái giữ nguyên, dùng chung cho cả hai chế độ.

### Thẻ bước

Mỗi bước là một thẻ rộng tối đa 560 px, căn giữa, viền trái 4 px theo màu loại bước (`--step-<type>` qua luật `[data-type]`, xem [0008](0008-ui-design-system.md)). Hàng đầu thẻ:

```
[⠿] Record  acc   Account × 1 · 5 field ………  [12 bản ghi] [2] [Đã tắt] [⋯] [▸]
```

| Phần | Nội dung |
| --- | --- |
| `⠿` tay kéo | Hiện khi rê chuột, luôn hiện trên màn hình cảm ứng; kéo để di chuyển |
| Nhãn loại | `label` từ meta (`Record`, `Lặp`, `Rẽ nhánh`, loại mới của 0006) |
| Alias | Alias của Record hoặc biến lặp, font monospace, màu nhạt |
| Tóm tắt | Như `nodeSummary` hiện tại; loại bước mới dùng tóm tắt chung từ option có `summary: true` |
| Chip số liệu | Chỉ có sau khi xem trước: Record `12 bản ghi`, Lặp `15 lần lặp`, Rẽ nhánh `Đúng 4 · Sai 8`. Workflow đổi sau lần chạy thì chip mờ đi, `title="Số liệu của lần xem trước gần nhất; workflow đã đổi sau đó."` |
| Badge | Đỏ = số lỗi, vàng = số cảnh báo (như canvas). Viền thẻ đỏ hoặc vàng theo |
| `Đã tắt` | Bước có `disabled: true`; cả thẻ mờ 55% |
| `⋯` | Menu bước (bên dưới) |
| `▾` / `▸` | Khung: thu gọn/mở thân. Bước thường: hiện/ẩn chi tiết |

- Bấm vào thẻ thì **chọn** bước, inspector hiện cấu hình. Bấm nền trống thì bỏ chọn.
- Bước đang chọn có viền xanh 2 px, giống canvas.
- **Chi tiết của Record** (bấm `▸`) là danh sách chip field, ví dụ `Name · Text`, `AccountId · Lookup → acc`, tối đa 12 chip
  rồi `+3 field`. Bấm chip thì chọn bước và mở sẵn phần tùy chọn của field đó trong inspector. Chip có lỗi
  (`field = fields.<Name>`) thì viền đỏ. Mặc định bước thường hiện một dòng, khung thì mở.
- Thẻ **Bắt đầu** ở đầu danh sách không phải là một bước: không kéo được, không có menu. Thẻ hiện tên workflow và
  `≤ <maxRecords> bản ghi`. Bấm vào thì chọn `{ kind: 'workflow' }`, và inspector hiện phần cài đặt workflow cùng gợi ý,
  tức nội dung đang hiện khi chưa chọn gì.

### Khung Lặp và Rẽ nhánh

```
┌─[⠿] Lặp  i · 5 lần ──────────────────────────────── [⋯][▾]┐
│  ┌ Record  acc · Account × 1 · 5 field ─────────── [⋯][▸]┐ │
│  └───────────────────────┬────────────────────────────────┘ │
│                         (+)                                  │
│  ┌─ Lặp  loop2 · 1–4 lần ─────────────────────────── [⋯][▾]┐│
│  │  ┌ Record  con · Contact × 1 · 6 field ─────────── [▸]┐ ││
│  │  └───────────────────────┬─────────────────────────────┘ ││
│  │                         (+)                              ││
│  │  ┌─ Rẽ nhánh · 30% đi nhánh đúng ──────────────── [⋯][▾]┐││
│  │  │ ┌ Đúng ─────────────────┐ ┌ Sai ─────────────────┐   │││
│  │  │ │ ┌ Record task … ┐     │ │  [+ Thêm bước]       │   │││
│  │  │ │ └──────┬────────┘     │ │  Để trống: không làm │   │││
│  │  │ │       (+)             │ │  gì                  │   │││
│  │  │ └───────────────────────┘ └──────────────────────┘   │││
│  │  └──────────────────────────────────────────────────────┘││
│  │                         (+)                              ││
│  └──────────────────────────────────────────────────────────┘│
│                         (+)                                  │
└──────────────────────────────────────────────────────────────┘
                          (+)
```

- Khung có cùng hàng đầu như thẻ thường. Thân có nền nhạt theo màu loại bước
  (`color-mix(in srgb, var(--c) 6%, var(--panel))`), viền trái 4 px, lề trong 12 px.
- **Lặp** có một ô con (slot `body`), không có nhãn. Ô rỗng hiện nút `+ Thêm bước vào vòng lặp`.
- **Rẽ nhánh** có hai cột cạnh nhau. Nhãn cột lấy từ meta: **✓ Đúng** và **✗ Sai**, cùng màu chữ Rẽ nhánh `--step-branch-text` (theo [0008](0008-ui-design-system.md): xanh lá/đỏ chỉ dành cho trạng thái, "Sai" không phải lỗi).
  Cột rỗng hiện nút `+ Thêm bước`; riêng cột Sai có thêm dòng nhỏ `Để trống: không làm gì`.
  Cột dùng `grid-template-columns: repeat(auto-fit, minmax(280px, 1fr))`, nên khi khung hẹp hơn khoảng 590 px thì hai cột
  tự xếp chồng (Đúng trên, Sai dưới). Rẽ nhánh lồng nhau nhiều cấp không làm vỡ bố cục.
- Sau khung là đường nối và "+" của bước kế tiếp. Bước đó chạy sau khi xong vòng lặp, hoặc sau nhánh nào đã chạy.
- **Khung thu gọn** chỉ còn hàng đầu, kèm dòng `3 bước bên trong`. Nếu bên trong có lỗi thì ghi thêm `· 1 lỗi`
  (hoặc `· 2 cảnh báo`) và badge của khung đếm cả lỗi của bước con. Bấm badge thì mở khung và chọn bước lỗi đầu tiên.
- Nút **Thu gọn tất cả** / **Mở tất cả** nằm ở góc trên phải vùng xem.
- Trạng thái thu gọn là trạng thái UI, không nằm trong workflow JSON và không tạo bước undo. Nó được lưu trong
  `localStorage['sfdg.collapsed']` (mảng id, tối đa 500, bỏ id không còn tồn tại).

### Thêm bước

Có bốn cách. Cả bốn đều chọn bước mới, cuộn tới nó và nháy nền xanh nhạt 600 ms:

1. **Nút "+"** trên đường nối giữa hai bước, ở cuối mỗi dãy, và nút lớn trong ô rỗng.
   Nút tròn 20 px (vùng bấm 32 px), luôn hiện mờ và rõ lên khi rê chuột, `title="Thêm bước ở đây (/)"`.
   `aria-label` nói rõ vị trí, ví dụ `Thêm bước sau "acc"`, `Thêm bước vào nhánh Đúng`.
   Bấm thì mở menu nhỏ ngay cạnh nút:

   ```
   ┌ Thêm bước ─────────────────────────────────┐
   │ DỮ LIỆU                                     │
   │   Record     Sinh bản ghi cho một sObject   │
   │ ĐIỀU KHIỂN                                  │
   │   Lặp        Chạy các bước bên trong N lần  │
   │   Rẽ nhánh   Chạy nhánh Đúng hoặc Sai       │
   └─────────────────────────────────────────────┘
   ```

   Danh sách loại bước, nhóm (`category`) và mô tả đều lấy từ `/api/meta`. Khi có hơn 6 loại thì có ô `Tìm loại bước…`
   ở đầu menu. Điều khiển bằng ↑/↓ và Enter, gõ chữ đầu để nhảy, Esc để đóng.
2. **Cột trái**: bấm một loại bước để chèn theo **quy tắc chèn mặc định** dưới đây (1 thao tác).
3. **Phím `/`**: mở menu "+" tại vị trí theo quy tắc chèn mặc định.
4. **Kéo** một mục từ cột trái thả vào một dấu "+". Khi kéo, mọi "+" phình thành vạch thả nét đứt cao 24 px.

**Quy tắc chèn mặc định**, giữ đúng tinh thần "cổng ra còn trống đầu tiên" của 0001:

| Đang chọn | Bước mới vào |
| --- | --- |
| Không gì, hoặc thẻ Bắt đầu | Cuối dãy gốc |
| Một khung còn ô con rỗng | Ô rỗng đầu tiên theo thứ tự khai báo (thân Lặp; Đúng trước Sai) |
| Một bước thường, hoặc khung đã đầy | Ngay sau bước đó, trong cùng dãy |

**Mặc định của bước mới:**

- Record giống hiện tại: Account, alias gợi ý, field `Name`.
- Lặp: `fixed`, 3 lần. Biến lặp là `loop`; nếu vòng ngoài đã dùng `loop` thì đặt `loop2`, `loop3`, … để không che biến
  của vòng ngoài.
- Rẽ nhánh: `chance`, 0.5, hai nhánh rỗng.
- Bước mới chạy được ngay: ô con rỗng chỉ là cảnh báo, không chặn xem trước.

### Di chuyển

- **Kéo thả** bằng tay kéo `⠿`, dùng pointer events. Nhích quá 4 px là bắt đầu kéo; trên cảm ứng thì giữ 300 ms.
  Một bản mờ của thẻ đi theo con trỏ, các vạch thả hiện ra và vạch gần nhất được tô xanh. Gần mép trên/dưới 40 px thì
  tự cuộn. Esc để hủy.
  Kéo một khung là kéo cả thân. Không thả được vào trong chính khung đang kéo (vạch thả bên trong bị ẩn).
- **Alt+↑ / Alt+↓** đưa bước tới vị trí chèn liền trước/sau theo **thứ tự đọc**: từ trên xuống, nhánh Đúng trước nhánh Sai.
  Bước có thể đi vào hoặc ra khỏi khung: Alt+↓ khi bước kế là một khung đang mở thì bước vào đầu thân khung đó; Alt+↓ khi
  bước là bước cuối của ô thì ra ngay sau khung cha. Khung đang thu gọn được nhảy qua như một bước thường.
  Các lần bấm liên tiếp cho cùng một bước gộp thành một bước undo (`coalesceKey: 'move:<id>'`, 800 ms như hiện tại).
- Menu `⋯` → **Lên** / **Xuống**, cho người dùng cảm ứng.

### Xóa, nhân bản, tắt, bọc

Menu `⋯` của một bước:

| Mục | Phím | Tác dụng |
| --- | --- | --- |
| Nhân bản | Ctrl+D | Chèn bản sao ngay sau bước. Bản sao có id mới; mọi alias **định nghĩa bên trong bản sao** được đặt tên mới (`acc` → `acc2`) và tham chiếu tới chúng *bên trong bản sao* đổi theo. Ví dụ nhân bản khung `Lặp{acc, con→acc}` ra `Lặp{acc2, con2→acc2}` |
| Lên / Xuống | Alt+↑ / Alt+↓ | Như mục Di chuyển |
| Bọc trong Lặp | – | Thay bước bằng một Lặp mặc định có bước đó trong thân; chọn Lặp mới |
| Bọc trong Rẽ nhánh | – | Thay bước bằng một Rẽ nhánh mặc định có bước đó trong nhánh Đúng |
| Bỏ vỏ (giữ các bước bên trong) | – | Chỉ có ở khung. Đưa các bước con ra đúng chỗ của khung rồi bỏ khung. Bị tắt khi Rẽ nhánh có **cả hai** nhánh không rỗng, `title="Chỉ bỏ vỏ được khi một nhánh trống."` |
| Tắt bước / Bật bước | Ctrl+/ | Đặt hoặc bỏ `disabled`. Bước tắt (và cả thân của nó) không chạy |
| Xóa | Delete | Xem dưới đây |

- **Xóa bước thường:** xóa ngay, hiện toast `Đã xóa bước Record "acc".` kèm nút **Hoàn tác** (gọi `undo()`).
  Nếu có field khác tham chiếu tới alias đó thì toast ghi thêm `2 field đang tham chiếu "acc" sẽ báo lỗi.`
- **Xóa khung có bước con:** hiện hộp thoại

  ```
  Xóa Lặp "i" và 3 bước bên trong?
  Có thể hoàn tác bằng Ctrl+Z.
                     [Hủy] [Chỉ xóa vỏ, giữ 3 bước] [Xóa tất cả]
  ```

  Nút giữa giống **Bỏ vỏ**. Nó bị ẩn khi Rẽ nhánh có cả hai nhánh không rỗng. Xóa khung rỗng thì không hỏi.
- Sau khi xóa, lựa chọn chuyển sang bước kế, nếu không có thì bước trước, nếu không có thì khung cha. Nhờ vậy có thể
  bấm Delete liên tục.

### Lỗi và cảnh báo

| `issue.field` | Hiển thị |
| --- | --- |
| không có `nodeId` | Chỉ trong hộp lỗi, kèm badge trên thẻ Bắt đầu |
| không có `field` | Badge và viền trên thẻ |
| khóa option (`count`, `alias`, …) | Badge trên thẻ, ô nhập viền đỏ trong inspector (như hiện tại) |
| `fields.<Name>` | Badge, chip field viền đỏ trong chi tiết thẻ, field card đỏ trong inspector (như hiện tại) |
| `slots.<key>` (mới) | Ô con đó viền nét đứt đỏ hoặc vàng; câu thông báo hiện ngay trong ô, dưới nút "+" |

- Bấm một dòng trong hộp lỗi thì: chọn bước, mở mọi khung tổ tiên, cuộn tới thẻ, và inspector tô field.
- Lỗi của bước con được cộng vào badge của khung **chỉ khi khung thu gọn**. Khi khung mở thì badge nằm ở chính bước con,
  để không đếm hai lần.
- Bước đang tắt không báo lỗi cấu hình của chính nó (nó không chạy), xem [Validate](#validate-v2-dự-kiến).

### Inspector hay sửa trong thẻ

- **Inspector (panel phải) là nơi duy nhất sửa cấu hình**, ở cả hai chế độ. Form vẫn dựng từ meta (`forms.js`).
  Thẻ chỉ hiện tóm tắt và chi tiết chỉ đọc.
  Lý do: trình soạn field (danh sách field, Import từ org, tùy chọn từng kiểu) quá lớn để nhét vào thẻ. Hai chỗ sửa cùng
  một giá trị cũng gây rối. Power Automate bản mới cũng dùng panel bên cạnh.
- Phần còn lại của inspector giữ nguyên: nhân bản, xóa, form option, trình soạn field, Import từ org.
  Bỏ phần "Cạnh nối" vì không còn cạnh.
- Thêm cho inspector:
  - Dropdown **Bản ghi cha** (`kind: 'ref'`) chỉ cho chọn alias **dùng được ở vị trí này**, theo kết quả phân tích phạm vi
    `scope.at[stepId]` của 0005. Các alias khác nằm trong nhóm `Không dùng được ở vị trí này` và bị tắt, có `title` nói
    lý do (nằm phía dưới / ở nhánh khác / đang tắt).
  - Import từ org tự chọn bản ghi cha chỉ trong các alias dùng được (0005 cũng đề xuất như vậy).
  - Esc trong một ô nhập của inspector thì rời ô và đưa focus về thẻ đang chọn, để tiếp tục dùng phím mũi tên.
- Chỗ cho 0005: bộ chọn biến (`client/js/var-picker.js` của 0005) được `forms.js` gắn vào mọi option có `vars`, nên tự có
  trong inspector ở cả hai chế độ. Nếu sau này sửa trong thẻ thì thẻ chỉ cần gọi `renderOptions` với ctx
  `{ nodeId, fieldIndex }` như 0005 yêu cầu.

### Bàn phím

Vùng Quy trình là một `role="tree"`, mỗi bước là `role="treeitem"` có `aria-level`, `aria-expanded` (khung) và
`aria-selected`. Dùng roving tabindex: Tab vào cây thì tới bước đang chọn, Tab tiếp thì sang inspector.

| Phím | Tác dụng |
| --- | --- |
| ↑ / ↓ | Chọn bước trước / sau theo thứ tự hiển thị (bỏ qua bước trong khung thu gọn). ↑ ở bước đầu thì chọn thẻ Bắt đầu |
| ← | Khung đang mở: thu gọn. Bước thường hoặc khung đã thu gọn: chọn khung cha |
| → | Khung thu gọn: mở. Khung đang mở: chọn bước con đầu tiên |
| Home / End | Bước đầu / bước cuối đang hiển thị |
| Enter | Focus ô nhập đầu tiên của inspector |
| Esc | Trong inspector: quay về thẻ. Trong cây: bỏ chọn |
| / | Mở menu thêm bước theo quy tắc chèn mặc định |
| Alt+↑ / Alt+↓ | Di chuyển bước |
| Ctrl+D | Nhân bản |
| Ctrl+/ | Tắt / bật bước |
| Delete, Backspace | Xóa (khung có bước con thì hỏi) |
| M | Đổi chế độ Quy trình / Sơ đồ (đợt B) |
| Ctrl+Z, Ctrl+Shift+Z, Ctrl+S, Ctrl+Enter | Như hiện tại |

Như hiện tại, khi đang gõ trong ô nhập thì phím tắt để lại cho ô nhập, trừ Ctrl+Enter, Ctrl+S và Esc.
Không dùng Ctrl+M, Ctrl+Shift+M, Alt+số hay Alt+chữ vì chúng trùng phím của trình duyệt hoặc hệ điều hành.

Tab "Phím tắt" ở inspector (khi chưa chọn gì) cập nhật theo bảng này. Gợi ý "Chọn node Bắt đầu, bấm Record…" đổi thành
`Bấm "+ Thêm bước đầu tiên" hoặc Record ở cột trái.`

### Màn hình hẹp (≤ 900 px)

- Cột trái thành dải ngang như hiện tại.
- Vùng Quy trình rộng hết màn hình, thụt lề mỗi cấp 8 px (thay vì 12 px).
- Inspector thành **bottom sheet**: ẩn khi chưa chọn gì. Chạm vào thẻ thì sheet trượt lên cao 60vh, đầu sheet có nút
  **‹ Xong** để đóng sheet mà vẫn giữ lựa chọn. Chỉ cần CSS và đổi một class (`.inspector.open`).
- Rẽ nhánh tự xếp chồng hai nhánh (quy tắc `auto-fit` ở trên).
- Tay kéo `⠿` luôn hiện, giữ 300 ms để kéo. Menu `⋯` có Lên/Xuống. Vùng bấm của "+" và `⋯` tối thiểu 32 × 32 px.

### Chế độ Sơ đồ (đợt B)

- Thay `canvas.js` hiện tại. Vẫn pan/zoom/fit, các nút − ⤢ +, nền lưới. Dữ liệu là cây, bố cục **tự tính** bằng hàm thuần
  `layout(steps)` trong `client/js/layout.js`:
  - Dãy bước đi từ trái sang phải, mỗi thẻ 210 px, cách nhau 60 px.
  - Lặp là một khung bao quanh thân, có nhãn ở góc trên trái.
  - Rẽ nhánh là thẻ tách thành hai làn, Đúng ở trên và Sai ở dưới, rồi gộp lại ở một chấm tròn.
- Sửa có giới hạn: bấm để chọn (dùng chung inspector), Delete, Ctrl+D, Ctrl+/, "+" ở giữa mỗi đường nối (cùng menu với
  Quy trình), kéo mục từ cột trái thả lên đường nối.
- **Không** kéo dây, **không** đặt vị trí tự do. `position` không còn trong JSON.
- Kéo thẻ để di chuyển trên Sơ đồ để sau. Người dùng có thể đổi sang Quy trình (M) để làm việc đó.

### Chuyển workflow cũ

Khi chuyển có thay đổi, hiện hộp thoại:

```
Đã chuyển workflow sang dạng Quy trình

Workflow này lưu ở định dạng cũ (version 1, dạng sơ đồ nối dây). Ứng dụng đã chuyển nó sang
version 2 (các bước lồng nhau). Với cùng seed, dữ liệu sinh ra giống bản cũ, trừ ở các bước được
nhân bản: bản sao sinh giá trị riêng nên giá trị duy nhất, số tự tăng và dữ liệu phía sau có thể khác. Các điểm cần kiểm tra:

• Bước Record "con" được nối tới từ 2 chỗ nên đã được nhân thành "con" và "con2". Kiểm tra các field tham chiếu tới "con".
• 3 node chưa được nối từ Bắt đầu đã được đặt ở cuối và đang tắt: "o1", "o2", Lặp "loop". Bật lại (Ctrl+/) nếu cần.
• Bỏ dây "b" → "a" vì dây này tạo vòng lặp.
• Cổng "đúng" của Rẽ nhánh có 2 dây. Giữ dây tới "x" (dây mà bản cũ thực sự chạy); "y" được đặt ở cuối và đang tắt.
• Bỏ dây tới node không tồn tại "zz".

Bản gốc vẫn được giữ.                          [Tải bản gốc (v1)]  [Đồng ý]
```

- **Tải bản gốc (v1)** tải về JSON gốc đúng như lúc đọc vào.
- Với autosave, khóa cũ `sfdg.workflow.v1` **không bị xóa hay ghi đè**. Bản mới lưu ở `sfdg.workflow.v2`.
  Nếu migration có lỗi thì bản cũ vẫn còn nguyên.
- Toast khi chuyển không đổi gì:
  - autosave: `Đã chuyển workflow đang soạn sang định dạng mới. Bản cũ vẫn được giữ trong trình duyệt.`
  - file: `Đã chuyển "<tên>" sang định dạng mới (version 2). Bấm Lưu để cập nhật file.`
- File có version lạ: `Không mở được file: workflow version 3 chưa được hỗ trợ. Hãy cập nhật ứng dụng.`

## Thay đổi dữ liệu / API

### Workflow JSON version 2 (dự kiến)

Trước (v1, rút gọn):

```json
{
  "version": 1,
  "nodes": [
    { "id": "start", "type": "start", "position": { "x": 40, "y": 160 }, "config": {} },
    { "id": "loopAcc", "type": "loop", "position": { "x": 300, "y": 160 }, "config": { "count": 5, "alias": "i" } },
    { "id": "acc", "type": "record", "position": { "x": 580, "y": 100 }, "config": { "sobject": "Account", "alias": "acc", "fields": [] } },
    { "id": "hot", "type": "branch", "position": { "x": 860, "y": 100 }, "config": { "kind": "chance", "probability": 0.3 } },
    { "id": "task", "type": "record", "position": { "x": 1140, "y": 40 }, "config": { "sobject": "Task", "alias": "task", "fields": [] } }
  ],
  "edges": [
    { "from": "start", "fromPort": "next", "to": "loopAcc" },
    { "from": "loopAcc", "fromPort": "body", "to": "acc" },
    { "from": "acc", "fromPort": "next", "to": "hot" },
    { "from": "hot", "fromPort": "true", "to": "task" }
  ]
}
```

Sau (v2), workflow của luồng chính:

```json
{
  "version": 2,
  "name": "Account + Contact + Task",
  "seed": 42,
  "settings": { "maxRecords": 50000 },
  "steps": [
    {
      "id": "loopAcc",
      "type": "loop",
      "config": { "mode": "fixed", "count": 5, "alias": "i" },
      "slots": {
        "body": [
          {
            "id": "acc",
            "type": "record",
            "config": { "sobject": "Account", "alias": "acc", "count": 1,
              "fields": [{ "name": "Name", "type": "text", "options": { "mode": "company", "unique": true } }] }
          },
          {
            "id": "loopCon",
            "type": "loop",
            "config": { "mode": "range", "min": 1, "max": 4, "alias": "loop2" },
            "slots": {
              "body": [
                {
                  "id": "con",
                  "type": "record",
                  "config": { "sobject": "Contact", "alias": "con",
                    "fields": [
                      { "name": "LastName", "type": "text", "options": { "mode": "lastName" } },
                      { "name": "AccountId", "type": "lookup", "options": { "mode": "current", "ref": "acc" } }
                    ] }
                },
                {
                  "id": "hot",
                  "type": "branch",
                  "config": { "kind": "chance", "probability": 0.3 },
                  "slots": {
                    "true": [
                      {
                        "id": "task",
                        "type": "record",
                        "config": { "sobject": "Task", "alias": "task",
                          "fields": [
                            { "name": "Subject", "type": "template", "options": { "template": "Gọi lại {{con.LastName}}" } },
                            { "name": "WhoId", "type": "lookup", "options": { "mode": "current", "ref": "con" } }
                          ] }
                      }
                    ],
                    "false": []
                  }
                }
              ]
            }
          }
        ]
      }
    }
  ]
}
```

| Khóa | Bắt buộc | Mô tả |
| --- | --- | --- |
| `version` | có | `2` |
| `steps` | có | Dãy bước gốc, chạy từ trên xuống |
| `steps[].id` | có | Duy nhất trong **cả cây**. Vẫn là `nodeId` trong lỗi và trong `records[]` |
| `steps[].type` | có | `record`, `loop`, `branch` (thêm loại của 0006) |
| `steps[].config` | không | Như v1 |
| `steps[].slots` | không | Chỉ cho loại bước có `slots` trong meta. Object `{ <slot key>: [bước…] }`; thiếu slot nghĩa là dãy rỗng |
| `steps[].disabled` | không | `true`: bỏ qua bước này và mọi bước con khi chạy |
| Bỏ | – | `nodes`, `edges`, `position`, node `start` |

**Không tương thích ngược ở mức file:** bản cũ của app không đọc được file v2. **Tương thích xuôi:** bản mới đọc được mọi
file v1 (client chuyển đổi), và server vẫn nhận v1 qua API (mục [API](#api-dự-kiến)).

### Ngữ nghĩa khi chạy (dự kiến)

- Dãy bước chạy từ trên xuống. Bước có `disabled: true` bị bỏ qua cùng toàn bộ thân, và **không** dùng `rng`.
- `record`: như v1.
- `loop`: chạy `slots.body` N lần rồi đi tiếp bước kế. N được tính bằng `rng.int` **kể cả khi thân rỗng**, như v1, để
  workflow chuyển từ v1 ra đúng dữ liệu cũ với cùng seed. Biến lặp có phạm vi như v1.
- `branch`: luôn tính điều kiện (kể cả khi hai nhánh rỗng, như v1), chạy `slots.true` hoặc `slots.false`, rồi
  **đi tiếp bước kế**. Đây là khác biệt về cách hiểu so với v1 ("nhánh không nối thì kết thúc chuỗi"). Migration giữ đúng
  hành vi cũ vì nó chỉ đặt bước ra sau khung khi bước đó là điểm gộp của **cả hai** nhánh.
- **"Phía trước"** (cho lookup và bộ chọn biến). Dùng đúng bảng trạng thái của 0005 (`ok`, `last`, `maybe`, ẩn
  `notBefore`), chỉ thêm `disabled`. Trên cây, các trạng thái này tính được bằng một lần duyệt. Bước D dùng được tại
  bước S nếu D đứng trước S theo thứ tự đọc (trên xuống, Đúng trước Sai) **và** D không nằm ở nhánh còn lại của một
  Rẽ nhánh đang bao S.
  - `ok`: D là phần tử trực tiếp của một dãy đang bao S và đứng trước S.
  - `last`: D nằm trong thân một Lặp đã chạy xong ở phía trên, và mọi Lặp trên đường đi chắc chắn chạy ít nhất một lần
    (`fixed` với `count ≥ 1`, hoặc `range` với `min ≥ 1`). Giá trị là bản ghi của lần lặp cuối.
  - `maybe`: D nằm trong một nhánh rẽ, hoặc trong một Lặp có thể chạy 0 lần, ở phía trên S.
  - ẩn `notBefore`: D nằm sau S, là chính S, hoặc nằm ở nhánh còn lại.
  - `disabled` (mới): D, hoặc một khung bao D, đang tắt.
  - Ví dụ `Lặp{acc}` rồi `con → acc (random)`: `acc` là `last`, nên hết lỗi.
  - Trạng thái `maybe` của biến lặp mà 0005 mô tả ("node chạy cả trong lẫn ngoài body") không thể xảy ra trên cây.
- `stats.byStep` (mới) trong kết quả `/api/run`, dùng cho chip số liệu:
  `{ "<stepId>": { "runs": 5, "records": 5 } }`. Lặp có thêm `iterations`, Rẽ nhánh có thêm `true` và `false`
  (số lần đi mỗi nhánh).

### Danh mục loại bước trong `/api/meta` (dự kiến, `server/workflow/nodes.js`)

```js
{ type: 'record', label: 'Record', category: 'data',
  description: 'Sinh bản ghi cho một sObject. Mỗi lần chạy qua bước này sinh "Số bản ghi" bản ghi.',
  slots: [], options: [ /* như cũ */ ] },
{ type: 'loop', label: 'Lặp', category: 'control',
  description: 'Chạy các bước bên trong N lần, rồi đi tiếp xuống bước sau.',
  slots: [{ key: 'body', label: '', empty: 'Thêm bước vào vòng lặp' }], options: [ /* như cũ */ ] },
{ type: 'branch', label: 'Rẽ nhánh', category: 'control',
  description: 'Chạy nhánh Đúng hoặc Sai tùy điều kiện, rồi đi tiếp xuống bước sau.',
  slots: [{ key: 'true', label: 'Đúng' }, { key: 'false', label: 'Sai', hint: 'Để trống: không làm gì' }],
  options: [ /* như cũ */ ] },
```

- `slots[].empty` là nhãn nút trong ô rỗng (mặc định `Thêm bước`). `slots[].hint` là dòng nhỏ dưới nút đó. Thứ tự trong
  mảng `slots` là thứ tự đọc (Đúng trước Sai), và là thứ tự mà quy tắc chèn mặc định dùng.
- Bỏ `start`, `inputs`, `outputs` (cổng).
- Hợp đồng `flow` / `exposes` của 0005 giữ nguyên ý nghĩa, chỉ đổi phần nói về cổng:
  - `flow` của `record`/`query`/`pick` là `{ "kind": "sequence" }`, bỏ `next`.
  - `flow` của `loop` là `{ "kind": "loop", "body": "body" }`, bỏ `after`, vì "sau vòng lặp" là bước kế trong dãy.
  - `flow` của `branch` là `{ "kind": "branch", "alternatives": ["true", "false"] }`. Ở v2, đây là **key slot**, không
    phải tên cổng.
  - `exposes.visibleIn: { "port": "body" }` đổi thành `{ "slot": "body" }`.
  - `slots` (0003) lo phần hiển thị (key, nhãn, thứ tự); `flow` (0005) lo cách các slot chạy.
- `category`: `data` hoặc `control`. Menu "+" và cột trái nhóm theo `category`, nhãn nhóm `Dữ liệu` / `Điều khiển`.
- Option có `summary: true` được dùng cho tóm tắt chung trên thẻ của loại bước mới. Record, Lặp và Rẽ nhánh vẫn giữ câu
  tóm tắt riêng (chuyển từ `canvas.js` sang `client/js/summary.js`).
- `LIMITS.maxDepth = 32`: số cấp lồng tối đa.
- Generator `lookup` / `masterdetail` (`server/generators/reference.js`): nhãn `Node cha (alias)` đổi thành
  `Bản ghi cha (alias)`, `help` đổi thành `Alias của một bước Record ở phía trên.`
- Option `alias` của Lặp: default vẫn là `loop`. Phần gợi ý `loop2` chỉ là việc của client khi chèn.

### Validate v2 (dự kiến)

File: `server/workflow/schema.js`.

Không còn (dạng cây không cho phép tạo ra):
- `Workflow cần một node Bắt đầu.`, `Chỉ được có một node Bắt đầu.`
- `Cạnh nối tới node không tồn tại…`, `Node không có cổng ra…`, `Không thể nối vào node…`
- `Node không thể nối vào chính nó.`, `Cổng "…" chỉ được nối tới một node.`
- `Workflow có vòng lặp bằng cạnh nối…`, `Node chưa được nối từ Bắt đầu nên sẽ không chạy.`

Mới hoặc đổi (`nodeId` luôn là id bước; cột `field` là giá trị của `issue.field`):

| Mức | `field` | Thông báo |
| --- | --- | --- |
| lỗi | – | `Không hỗ trợ workflow version ${v}. Version hiện tại là 2.` |
| lỗi | – | `Thiếu danh sách "steps".` |
| lỗi | – | `Có bước không có id.` |
| lỗi | – | `Trùng id bước "${id}".` |
| lỗi | – | `Loại bước "${type}" không tồn tại.` |
| lỗi | `slots` | `Bước ${label} không chứa bước con. Xóa "slots" khỏi bước này.` |
| lỗi | `slots.${key}` | `Bước ${label} không có nhánh "${key}".` |
| lỗi | `slots.${key}` | `"slots.${key}" phải là một danh sách bước.` |
| lỗi | – | `Workflow lồng nhau quá 32 cấp. Bỏ bớt Lặp/Rẽ nhánh lồng nhau.` |
| cảnh báo | `slots.body` | `Vòng lặp chưa có bước nào. Bấm "+ Thêm bước vào vòng lặp".` (thay `Nhánh "lặp" chưa nối tới node nào.`) |
| cảnh báo | `slots.true` | `Cả hai nhánh đều trống nên bước này không làm gì. Thêm bước vào nhánh Đúng hoặc xóa bước này.` |
| lỗi | `fields.X` | `Field "X": không có bước Record nào có alias "acc".` |
| lỗi | `fields.X` | `Field "X": bước "acc" nằm sau bước này nên chưa có bản ghi khi chạy tới đây. Kéo bước "acc" lên phía trên hoặc chọn bản ghi cha khác.` (thay câu "phải nằm phía trước"; áp dụng cả khi tham chiếu chính mình) |
| lỗi | `fields.X` | `Field "X": bước "con" nằm ở nhánh còn lại của bước Rẽ nhánh phía trên nên không chạy cùng lượt với bước này. Đưa "con" ra trước bước Rẽ nhánh hoặc chọn bản ghi cha khác.` |
| lỗi | `fields.X` | `Field "X": bước "acc" đang tắt. Bật lại bước đó (Ctrl+/) hoặc chọn bản ghi cha khác.` |
| cảnh báo | `fields.X` | Lookup: `Field "X": bước "acc" nằm trong một nhánh rẽ hoặc vòng lặp có thể không chạy, nên có lúc field này sẽ trống.` |
| cảnh báo | `fields.X` | Master-Detail: `Field "X": bước "acc" nằm trong một nhánh rẽ hoặc vòng lặp có thể không chạy, nên có lúc chưa có bản ghi cha và lần chạy sẽ báo lỗi. Đưa "acc" ra ngoài để nó luôn chạy trước.` |

Năm dòng `fields.X` cuối là **đề xuất cho các mã của 0005**:

- Câu `notBefore` hiện tại của 0005 (`… phải nằm phía trước node này trong workflow (hiện nó chạy sau hoặc ở nhánh khác).`)
  được tách làm hai câu, vì trên cây biết chính xác lý do.
- Thêm mã `disabled`.
- Đổi chữ "node" thành "bước" (câu hỏi 5).
- Câu `maybe` dùng cho Lookup `ref`. Câu `maybe` cho biến trong template vẫn theo 0005.
- Nếu 0005 chưa làm thì 0003 chỉ cần phần phân tích cho Lookup `ref`, viết đúng theo hợp đồng trạng thái ở trên.

Các quy tắc khác:

- Bước đang tắt và bước con của nó: **không** kiểm tra cấu hình. Alias vẫn phải duy nhất trên toàn cây, kể cả bước tắt,
  để bật lại không gây trùng.
- Quy tắc alias, biến lặp và option như v1.

### API (dự kiến)

- `POST /api/validate` và `POST /api/run` nhận cả v1 lẫn v2.
  - v1 được chuyển bằng `shared/migrate-v1.js` trước khi validate/chạy, và có thêm cảnh báo (không có `nodeId`):
    `Workflow version 1 đã được tự chuyển sang version 2 để chạy. Mở file trong trình soạn rồi bấm Lưu để cập nhật.`
  - Mỗi mục trong báo cáo migration thành một cảnh báo có `nodeId`.
  - Nhờ vậy lệnh `curl` trong tài liệu và script của người dùng vẫn chạy được.
- Kết quả `/api/run` có thêm `stats.byStep`. Các khóa khác giữ nguyên, kể cả `records[].nodeId`.
- Server phục vụ thêm thư mục tĩnh `/shared/` từ `shared/`, cùng cách chặn path traversal như `client/`.
- Không có endpoint mới.

### Module dùng chung (`shared/`)

Client và server đều là ES module, nên logic cây viết **một lần** và chạy ở cả hai phía (nguyên tắc 7). Module là hàm
thuần, không DOM, không I/O, và nhận thứ tự slot qua tham số `slotKeys(type)` (server lấy từ `nodeTypeMap`, client lấy từ `state.meta`).

`shared/workflow-tree.js`:

| Hàm | Dùng cho |
| --- | --- |
| `walkSteps(steps, visit, slotKeys)` | Duyệt theo thứ tự đọc, có `depth` và đường dẫn |
| `findStep(wf, id)` → `{ step, parentId, slot, index, depth, ancestors }` | Mọi thao tác |
| `insertStep(wf, target, step)`, `moveStep(wf, id, target)` | Thêm, kéo thả, Alt+↑/↓. `target = { parentId: null \| id, slot: null \| key, index }` |
| `removeStep(wf, id, { keepChildren })` | Xóa, Bỏ vỏ |
| `wrapStep(wf, id, container)` | Bọc trong Lặp / Rẽ nhánh |
| `cloneSteps(steps, takenAliases)` | Ctrl+D và migration (id mới, alias mới bên trong bản sao, tham chiếu nội bộ đổi theo) |
| `renameAlias(wf, from, to)` | Đổi alias (chuyển từ `inspector.js`) |
| `defaultInsertTarget(wf, selectedId, slotKeys)` | Quy tắc chèn mặc định |
| `neighbourTarget(wf, id, dir, collapsed, slotKeys)` | Alt+↑/↓ |
| `toFlowGraph(wf, slotKeys)` → `{ nodes, edges }` | Chỉ cần nếu `scope.js` của 0005 đã viết trên đồ thị trước: đổi cây về đồ thị để phân tích. Mỗi bước nối sang bước kế; đuôi của mọi nhánh (kể cả nhánh rỗng, nhánh lồng) nối sang bước sau khung. Đây là `buildFlow(v2)` mà 0005 yêu cầu |

`shared/migrate-v1.js` chứa `migrateV1(wf)` → `{ workflow, report }`.

Phân tích phạm vi (`analyzeScope`, `scope.at`) **thuộc 0005**, đặt ở `server/workflow/scope.js` và trả về qua
`/api/validate`. Nếu 0003 làm trước thì 0005 viết thẳng trên cây; nếu 0005 làm trước thì 0003 thêm `toFlowGraph`.
Như vậy chỉ có một bản phân tích phạm vi.

### Chuyển v1 → v2 (migration)

Đã chạy thử nguyên mẫu (ngoài repo) với executor thật. Thuật toán:

1. **Chuẩn hóa dây.**
   - Bỏ dây tới hoặc từ node không tồn tại.
   - Mỗi cổng chỉ giữ dây **sau cùng** trong `edges`, vì executor v1 ghi đè rồi chạy theo dây đó.
   - DFS để tìm và cắt dây tạo vòng.
   - Mỗi thay đổi được ghi vào `report.droppedEdges`.
2. **Bước kế (continuation)** của một node:
   - `start` và `record`: `next`.
   - `loop`: `done`.
   - `branch`: điểm gộp `join(b)` = node đầu tiên trên chuỗi tiếp nối của nhánh `true` mà cũng có trên chuỗi tiếp nối
     của nhánh `false`, hoặc `null`. Có memo. Vì đồ thị không có vòng nên điểm chung đầu tiên là như nhau khi đi từ hai phía.
3. **Dựng cây.** `build(entry, stop)` đi theo bước kế từ `entry` tới `stop` (hoặc hết):
   - Bỏ qua `start`.
   - `loop` thì `slots.body = build(body, null)`.
   - `branch` thì `j = join(b)`, `slots.true = build(true, j)`, `slots.false = build(false, j)`.
   - Giữ nguyên `id` và `config`, bỏ `position`.
4. **Gặp node đã đặt rồi** (dạng 4–6): đặt một bản sao bằng `cloneSteps`. Bản sao lấy id `<id>_2` và alias mới
   (`con` → `con2`); phần đuôi phía sau cũng là bản sao. Ghi vào `report.duplicated`.
   Nếu số bước vượt `2 × số node ban đầu + 50` thì ngừng nhân bản. Các chỗ còn lại bị cắt và ghi vào báo cáo, để workflow
   hiểm hóc không làm treo trình duyệt.
5. **Node lơ lửng.** Lấy các gốc (node chưa đặt và không có dây vào từ node chưa đặt), `build` từng gốc, thêm vào cuối
   `steps` với `disabled: true`. Ghi vào `report.disabled`.
6. Giữ `name`, `seed`, `settings`. Gọi `migrateV1` với workflow v2 thì trả về nguyên như cũ.

`report = { duplicated: [{ id, copyId, alias, newAlias }], disabled: [id], droppedEdges: [{ from, fromPort, to, reason: 'missing' | 'fanout' | 'cycle' }], truncated: [id] }`
(sau review có thêm `root`, `uniqueFields`, `duplicateIds`, `tooDeep`: xem `docs/workflow-schema.md`).

Kết quả chạy thử nguyên mẫu (seed 7, cùng `now`):

| Trường hợp | Kết quả |
| --- | --- |
| Mẫu "Account + Contact", mẫu "Lead theo xác suất" | Bản ghi **giống hệt** v1 |
| Gộp sau Rẽ nhánh trong Lặp; gộp lồng nhau; Lặp trong nhánh rồi gộp | Giống hệt v1 |
| Thân Lặp thoát ra ngoài (dạng 4) | Phát hiện, nhân bản C. Nội dung bản ghi giống v1, chỉ khác `nodeId` (và `ref` khi đổi alias), **nếu C không có field "Giá trị duy nhất" hay Auto Number**. Có thì bản sao đếm riêng: giá trị duy nhất có thể trùng giữa `c` và `c_2` và dữ liệu sau đó khác v1 (báo cáo có dòng riêng, xem "Đã làm") |
| Nối chéo (dạng 5) | X ở nhánh Đúng, bản sao `x_2` ở nhánh Đúng của `b2` |
| Node lơ lửng; vòng bằng dây | Đặt cuối và tắt; cắt dây `b → a` |

### `localStorage` (dự kiến)

| Khóa | Nội dung |
| --- | --- |
| `sfdg.workflow.v2` | Autosave mới |
| `sfdg.workflow.v1` | Autosave cũ. Chỉ đọc, giữ làm bản sao lưu, không ghi đè |
| `sfdg.view` | `process` (mặc định) hoặc `canvas` |
| `sfdg.collapsed` | Mảng id bước đang thu gọn |

### Thay đổi cần làm ở tài liệu tham chiếu (dự kiến, implementer làm cùng code)

- `docs/workflow-schema.md`:
  - Đổi tiêu đề thành "Workflow JSON (version 2)". Thay ví dụ và bảng khóa bằng phần [Workflow JSON version 2](#workflow-json-version-2-dự-kiến).
  - Bảng Node: cột "Cổng ra" đổi thành "Bước con (`slots`)", bỏ dòng `start`.
  - "Ngữ nghĩa khi chạy": thay ba ý "Mỗi cổng ra nối tối đa một node…", "Không được tạo vòng…" và "Nhánh không nối thì…"
    bằng ngữ nghĩa dãy / thân Lặp / Rẽ nhánh đi tiếp / `disabled`.
  - "Đường dẫn tham chiếu": thêm định nghĩa "phía trước" theo trạng thái `ok` / `last` / `maybe` / `disabled`.
  - Quy ước `field`: thêm `slots.<key>`. Kết quả: thêm `stats.byStep`.
  - Thêm mục "Version 1 (cũ) và chuyển đổi" tóm tắt định dạng v1 và quy tắc migration.
- `docs/architecture.md`:
  - Sơ đồ: "Canvas node + Inspector" đổi thành "Quy trình / Sơ đồ + Inspector".
  - Bước 2: "dựng workflow trên canvas" đổi thành "dựng các bước ở chế độ Quy trình hoặc Sơ đồ".
  - Thêm dòng `shared/` (logic cây và migration, dùng ở cả client lẫn server).
  - Thêm quyết định "Cây bước là mô hình chuẩn ([0003](design/0003-process-mode.md))". Thêm `maxDepth` vào bảng `LIMITS`.
  - Bảng Client: thêm `process.js`, `ops.js`, `summary.js`, `layout.js`; `canvas.js` đổi thành "Sơ đồ tự sắp xếp";
    `store.js` thêm chế độ xem và trạng thái thu gọn.
- `docs/field-types.md`:
  - Dòng `lookup` thêm "bản ghi cha phải ở phía trên (xem workflow-schema.md)".
  - Kind `ref`: "dropdown alias của bước Record dùng được ở vị trí này".
- `docs/org-connection.md` dòng "UI tự chọn node cha…" đổi thành "UI tự chọn bản ghi cha nếu chỉ có một bước Record
  phía trên khớp `referenceTo`".
- `docs/design/README.md`: thêm dòng 0003 (Nháp).
- Ngoài `docs/`, implementer sửa cùng đợt:
  - `CLAUDE.md`: các ý về executor, hợp đồng JSON ("ports" đổi thành "slots"), `shared/`, chế độ xem.
  - `.claude/agents/implementer.md`: bảng lớp, thêm dòng `shared/` và đổi `nodeSummary` sang `client/js/summary.js`.
  - `.claude/skills/add-node-type/SKILL.md`: `slots`/`category` thay cho `inputs`/`outputs`, `version: 2`.
  - `.claude/skills/smoke-test/`: selector và ví dụ `curl` v2.
  - `.claude/skills/design-doc/SKILL.md` và `.claude/agents/planner.md`: "saved `version: 1`" đổi thành
    "saved `version: 1`/`2`".

## Checklist tiện dụng

- [x] 1. **Chạy được ngay với mặc định.** Bước mới có default như hiện tại. Ô con rỗng chỉ là cảnh báo. Workflow trống có
  "+ Thêm bước đầu tiên" và mẫu ở cột trái. Biến lặp mặc định không che vòng ngoài.
- [x] 2. **Ít thao tác.** Cột trái vẫn 1 cú bấm với quy tắc chèn mặc định, "+" là 2 cú bấm, `/` cho bàn phím. Chèn giữa,
  di chuyển, bọc và xóa ít thao tác hơn hẳn canvas (bảng so sánh). Luồng chính 21 thao tác, không phải nối dây.
- [x] 3. **Xem trước trước khi ghi.** Luồng insert không đổi. Thêm chip số liệu theo bước (`Đúng 4 · Sai 8`) để kiểm tra
  tỉ lệ trước khi insert.
- [x] 4. **Lỗi chỉ đúng chỗ.** Lỗi gắn với bước, field, và giờ cả ô con (`slots.<key>`). Khung thu gọn cộng dồn lỗi; bấm thì
  mở và nhảy tới. Các câu lỗi mới đều nói cách sửa.
- [x] 5. **Không mất công sức.** Bản v1 luôn được giữ, có nút "Tải bản gốc (v1)". Mọi thao tác có undo, toast xóa có nút
  Hoàn tác, xóa khung có lựa chọn giữ bước con. Nhân bản đổi alias và tham chiếu nội bộ.
- [x] 6. **Lấy thông tin từ org.** Import không đổi. Tự chọn bản ghi cha giờ chỉ xét bước dùng được ở vị trí đó, nên đoán
  đúng hơn.
- [x] 7. **Một nguồn sự thật.** `slots`, `category`, `summary` khai báo ở server. Logic cây và migration ở `shared/`, dùng
  chung cho client và server.
- [x] 8. **Giải thích tại chỗ.** Ô rỗng có câu hướng dẫn, nhánh Sai có "Để trống: không làm gì", thẻ có tag "Đã tắt",
  hộp thoại migration giải thích từng thay đổi.
- [x] 9. **An toàn khi lỡ tay.** Thêm `LIMITS.maxDepth = 32` và giới hạn nhân bản khi migration. `LIMITS` cũ giữ nguyên.
  Luồng ghi vào org không đổi.

## Phương án đã cân nhắc

| Phương án | Ưu | Nhược | Chọn? |
| --- | --- | --- | --- |
| (a) Cây v2 là chuẩn; Sơ đồ tự sắp xếp, sửa có giới hạn | Quy trình luôn đúng; thao tác đơn giản, test được; sửa lỗi "phía trước"; nền tốt cho 0005 | Đổi định dạng file; mất kéo dây tự do; sửa nhiều file | **Có** (đợt A rồi đợt B) |
| (b) Đồ thị là chuẩn, Quy trình chỉ cho đồ thị có cấu trúc | Không đổi định dạng và server | Lớp dịch thao tác phức tạp, dễ mất dữ liệu; Quy trình có thể bị khóa; lỗi "phía trước" còn nguyên | Không |
| (b2) Cây trong client, vẫn lưu và gửi v1 | Server không đổi, không bump version | File khó đọc; vẫn phải suy luận trên đồ thị ở server, 0004 và 0005 | Không |
| (c) Chỉ Quy trình, bỏ canvas | Ít việc nhất | Mất góc nhìn tổng quan | Là đợt A của (a) |
| Migration ở server qua `POST /api/migrate` | Không cần thư mục `shared/` | Thêm một lượt gọi mạng khi mở file; logic cây vẫn phải có ở client | Không: dùng `shared/` |
| Cho phép trùng alias ở hai nhánh loại trừ nhau | Migration giữ được cả `ref` như cũ | Phức tạp hóa validate và bộ chọn biến | Không (để ngỏ) |
| Sửa cấu hình ngay trong thẻ | Ít di chuyển mắt | Hai chỗ sửa một giá trị; trình soạn field quá lớn cho thẻ | Không (để ngỏ, xem câu 3) |

## Kế hoạch thực hiện

Bước 3–5 nên vào **cùng một PR**: sau bước 3, meta không còn `outputs`/`inputs`, nên canvas cũ sẽ hỏng.
Ước lượng tính theo ngày công của người đã quen code. Tổng khoảng **8–10 ngày**; đợt A (bước 0–5 và 7) khoảng 6–8 ngày.
Khối lượng ước khoảng +2 000 / −700 dòng, trong khi codebase hiện khoảng 3 000 dòng.

| # | Việc | File | Kiểm tra | Ước lượng | Rủi ro |
| --- | --- | --- | --- | --- | --- |
| 0 | Đóng băng executor v1 để so sánh | `test/fixtures/run-v1.js` (chép logic `runChain` hiện tại, không validate) | Test "run-v1 khớp runWorkflow hiện tại trên 2 mẫu", chạy **trước** khi sửa executor | 0.25 | Thấp |
| 1 | Logic cây dùng chung + route tĩnh `/shared/` | `shared/workflow-tree.js`, `server/index.js` | `test/workflow-tree.test.js`: chèn/di chuyển/xóa/bọc/bỏ vỏ/nhân bản (đổi alias nội bộ)/`renameAlias`/`defaultInsertTarget`/`neighbourTarget` vào-ra khung; `toFlowGraph` nếu 0005 đã có. `test/server.test.js`: `/shared/workflow-tree.js` trả 200, traversal bị chặn | 1 | Thấp |
| 2 | Migration | `shared/migrate-v1.js` | `test/migrate.test.js`: (i) 2 mẫu và các ca có cấu trúc chạy bằng `run-v1` và executor v2 cho bản ghi giống hệt; (ii) dạng 4–6 nhân bản đúng và báo cáo đúng; (iii) node lơ lửng bị tắt ở cuối; (iv) vòng, cổng hai dây, dây hỏng; (v) giới hạn nhân bản; (vi) v2 vào thì ra nguyên | 1 | **Trung bình**: thuật toán điểm gộp |
| 3 | Server theo hợp đồng v2 | `server/workflow/nodes.js` (`slots`, `category`, `summary`, bỏ `start`/`inputs`/`outputs`, `maxDepth`), `schema.js` (validate cây, câu lỗi mới; quy tắc "phía trước" qua `scope.js` của 0005, hoặc bản tối thiểu cho Lookup `ref` nếu 0005 chưa có), `executor.js` (`runSteps` đệ quy, `disabled`, `stats.byStep`), `server/index.js` (nhận v1), `server/generators/reference.js` (nhãn "Bản ghi cha") | `test/workflow.test.js` viết lại bằng helper v2 (`loop(id, cfg, body)`, `branch(id, cfg, yes, no)`) và thêm ca: đi tiếp sau Rẽ nhánh; `Lặp{acc}` rồi `con → acc random` hợp lệ; tham chiếu nhánh khác thì lỗi; `maybe` thì cảnh báo; bước tắt bị bỏ qua và tham chiếu tới nó thì lỗi; quá 32 cấp; lỗi `slots.x` có `field`. `test/server.test.js`: danh sách meta là `record, loop, branch`; `/api/run` với v1 chạy được và có cảnh báo chuyển đổi; có `stats.byStep` | 1 | Trung bình |
| 4 | Lõi client | `client/js/store.js` (v2 rỗng, khóa mới, `selection` loại `step`/`workflow`, `collapsed`, `view`, `runKey` theo `steps`), `client/js/ops.js` (mới: bọc hàm `shared/` vào `updateWorkflow`/`select`, toast Hoàn tác), `client/js/summary.js` (mới: `nodeSummary` + tóm tắt chung + chip số liệu), `main.js` (migrate khi boot và mở file, hộp thoại báo cáo, phím tắt mới), `inspector.js` (bỏ `renderEdge`, chọn workflow, `ref` theo `scope.at`, Import tự chọn cha, Esc về thẻ), `forms.js` (`ref` có nhóm tắt), `dom.js` (toast có nút), `samples.js` (viết lại v2), `index.html` (ẩn canvas) | `npm test`; mở trang với `localStorage` có mẫu v1 thì thấy toast chuyển đổi, `sfdg.workflow.v1` còn nguyên; mở file v1 có node lơ lửng thì thấy hộp thoại báo cáo | 1–1.5 | Trung bình: nhiều chỗ chạm, dễ hỏng giữ focus |
| 5 | Chế độ Quy trình | `client/js/process.js` (mới), `client/css/app.css`, `client/index.html` | `smoke.cjs` cập nhật: chờ `.step-card`; nạp mẫu; bấm "+" trong thân Lặp → Record; Alt+↑; Delete rồi Ctrl+Z; Ctrl+Enter thì có `table.data` và chip `bản ghi`; không lỗi trang; vẫn dưới 10 s. Chụp màn hình rộng 1440 và hẹp 390 | 2–3 | Trung bình: kéo thả, bàn phím |
| 6 | Chế độ Sơ đồ (đợt B) | `client/js/layout.js` (mới, hàm thuần), `client/js/canvas.js` (viết lại), `index.html` (nút Quy trình/Sơ đồ, phím M) | `test/layout.test.js` (node:test import thẳng `client/js/layout.js`): kích thước dãy, Lặp, Rẽ nhánh lồng nhau, không chồng thẻ. Smoke: chọn bước, đổi sang Sơ đồ, bước vẫn được chọn và nằm trong khung nhìn | 1.5 | Trung bình |
| 7 | Tài liệu và file agent | Danh sách ở mục [Thay đổi cần làm ở tài liệu tham chiếu](#thay-đổi-cần-làm-ở-tài-liệu-tham-chiếu-dự-kiến-implementer-làm-cùng-code), phần "Đã làm" của doc này | Reviewer đối chiếu tài liệu với code | 0.5 | Thấp |

Rủi ro chính và cách giảm:

- **Migration sai thì mất dữ liệu.** Bản v1 không bao giờ bị ghi đè, có nút tải bản gốc, và test so sánh với `run-v1`.
- **Xung đột với 0004–0006**, vì cùng sửa `nodes.js`, `schema.js`, `executor.js`. Nên làm hợp đồng v2 (bước 1–3) trước,
  hoặc thống nhất thứ tự (câu hỏi 6).
- **Mất kéo dây tự do.** Người dùng nào thích canvas sẽ thấy bị giới hạn. Phần bù là "+" và kéo thả trên Sơ đồ.
- **Re-render làm mất focus hoặc vị trí cuộn.** Giữ quy ước `source`: view Quy trình bỏ qua sự kiện do chính nó phát
  (`'process-drag'`). Khi chỉ đổi lựa chọn hay lỗi thì chỉ cập nhật class và badge, không dựng lại DOM. Giữ `scrollTop`
  khi dựng lại.

## Câu hỏi mở

Quyết định cần người dùng chốt:

1. **Duyệt hướng (a):** workflow thành cây (JSON v2), bỏ kéo dây và vị trí tự do. Đây là đổi hướng dự án.
2. **Có làm Sơ đồ (đợt B) không?** Đề xuất: có, nhưng sau khi dùng thử Quy trình. Nếu Quy trình cộng "Thu gọn tất cả" là
   đủ nhìn tổng quan thì bỏ (tức phương án (c)).
3. **Sửa ngay trong thẻ?** Đề xuất: chưa, chỉ sửa ở panel phải. Nếu cần sau này thì thêm cờ option `inline: true` ở server
   để thẻ dựng vài ô sửa nhanh (số lần lặp, xác suất, sObject) bằng chính `forms.js`.
4. **"Tắt bước" (`disabled`, Ctrl+/) thành tính năng chung?** Migration cần nó cho node lơ lửng. Đề xuất: có, vì nó cũng tiện
  để tạm bỏ Task mà không xóa.
5. **Gọi là "bước" thay vì "node" trên UI?** Đề xuất: có, trong mọi câu chữ mới và sửa. Code giữ `nodeId`/`type`.
6. **Thứ tự với 0004–0006.** Bản nháp 0005 và 0006 đều giữ `version: 1` và viết trên đồ thị (0005: `scope.js` theo
   `flow`; 0006: pre-fetch "mỗi node Query đến được từ Bắt đầu"). Đề xuất: làm bước 1–3 của 0003 trước, rồi
   0004/0005/0006 viết trên v2. Như vậy `scope.js` duyệt cây (đơn giản hơn nhiều), và không phải viết `toFlowGraph`.
   Nếu 0005 hoặc 0006 vào trước thì ở bước 3, phần schema/executor của chúng phải chuyển sang cây, và bước 1 thêm `toFlowGraph`.
7. **Server nhận v1 tới bao giờ?** Đề xuất: mãi mãi, vì chỉ là một lời gọi `migrateV1`.
8. Giữ nhãn **"Rẽ nhánh"** hay đổi thành **"Điều kiện"** như Power Automate? Đề xuất: giữ "Rẽ nhánh", vì `label` đã nằm ở
   server và đổi lúc nào cũng được.

### Phụ thuộc và giả định về 0004–0006

- **0004 (stream)**, đã đối chiếu với bản nháp `0004-streaming-execution.md`:
  - 0004 giữ thuật toán duyệt và `version: 1`. Bản cuối của 0004 đổi `runChain` thành **generator đồng bộ** (`function*`)
    với `yield*` cho thân vòng lặp; `runWorkflow` vẫn đồng bộ. 0004 cũng bỏ checkbox "stream mode" (luôn chạy dạng luồng).
    Như vậy không có ngữ nghĩa luồng dữ liệu nào xung đột với cây. (Cập nhật khi tổng hợp, xem [0007](0007-tong-hop-0003-0006.md).)
  - Trên v2, phần đó chỉ là `function* runSteps(steps, scope)` lặp qua mảng, `yield*` cho `slots`. Hai design cùng
    viết lại `executor.js`, nên làm lần lượt (câu hỏi 6). Ai làm sau thì chuyển phần kia sang.
  - Đề xuất 0004 thêm `byStep` (cùng hình dạng `stats.byStep` ở trên) vào sự kiện `progress` và vào `stats` cuối, để chip
    số liệu trên thẻ cập nhật trực tiếp khi chạy. `errorGroups[].nodeId` và `stopped.nodeId` của 0004 có thể hiện thành
    badge `3 lỗi insert` trên thẻ (việc sau).
  - Determinism: thứ tự gọi `rng` của v2 giữ như mục [Ngữ nghĩa khi chạy](#ngữ-nghĩa-khi-chạy-dự-kiến). 0004 cũng giữ
    nguyên thứ tự đó.
- **0005 (chọn biến)**, đã đối chiếu với bản nháp `0005-variable-picker.md`:
  - 0005 dùng khóa mới `exposes` + `flow`, không dùng `outputs`, nên không trùng tên. Ở v2, `flow` bỏ `next`/`after`,
    `alternatives`/`body` là key slot, và `exposes.visibleIn: { port }` đổi thành `{ slot }` (mục Danh mục loại bước).
  - Phân tích phạm vi là `analyzeScope` / `scope.at` của 0005, ở server. 0003 không làm bản thứ hai. Trạng thái
    `ok`/`last`/`maybe`/`notBefore` giữ nguyên, 0003 chỉ thêm `disabled`.
  - 0005 cần `node.id` ổn định giữa hai chế độ và giữa v1/v2. Đã đáp ứng: migration giữ id, chỉ bản sao mới có id `_2`.
  - Thẻ dùng `renderOptions` với ctx `{ nodeId, fieldIndex }` nếu sau này sửa inline. Bản này sửa trong inspector, nên
    bộ chọn đã có sẵn.
  - Hai bên trùng một đề xuất: tự đặt biến lặp `loop2`, … (câu hỏi 6 của 0005). Nên làm một lần trong `ops.js`.
  - Câu lỗi `notBefore`: đề xuất tách làm hai câu, thêm `disabled`, và dùng chữ "bước" (mục Validate v2).
  - Giá trị mẫu của 0005 cần "bản ghi đầu tiên của mỗi node". Việc này không đổi với 0003.
- **0006 (Query `query`, Chọn bản ghi `pick`)**, đã đối chiếu với bản nháp `0006-query-pick-nodes.md`:
  - Hai loại này là bước thường: v2 thêm `slots: []`, `category: 'data'`. 0006 đã nhận cờ `needsOrg: true`, nên thẻ hiện
    `Chưa chọn org: dùng bản ghi mẫu`. View Quy trình và Sơ đồ không phải sửa gì.
  - Tóm tắt trên thẻ: 0006 sẽ viết vào `client/js/summary.js` (thay `nodeSummary` trong `canvas.js`), hoặc đánh dấu option
    `summary: true`.
  - Pre-fetch ở v2: mọi bước `query` **không tắt**, theo thứ tự đọc, thay cho "đến được từ Bắt đầu".
  - "Import từ org" chèn Query "ngay sau Bắt đầu": ở v2 là `insertStep(wf, { parentId: null, slot: null, index: 0 }, …)`.
    Câu "Nên đặt Query ngay sau Bắt đầu" vẫn đúng, vì thẻ Bắt đầu vẫn hiện ở đầu cả hai chế độ.
  - Kiểm tra "Pool không ở phía trước" dùng chung phân tích phạm vi (như 0005 đề xuất).
  - Nếu cần "mỗi bản ghi của truy vấn" thì nên là một `mode` mới của Lặp (ví dụ `each` với `source: <alias>`), không phải
    loại khung mới. Dù vậy view vẫn hỗ trợ khung bất kỳ có `slots` khai báo trong meta: 1 slot là thân, từ 2 slot là các cột.
  - Kết quả `/api/run` của 0006 có thêm `queries[]`. Chip số liệu của thẻ Query có thể hiện `200 bản ghi đọc từ org`.

### Việc tiếp theo (không làm trong bản này)

- Chọn nhiều bước liền nhau (Shift+bấm) để bọc, xóa hoặc kéo cùng lúc. Copy/paste bước (Ctrl+C/Ctrl+V).
- Kéo thẻ để di chuyển trên Sơ đồ; minimap.
- Ước tính số bản ghi theo bước trước khi chạy (từ số lần lặp trung bình và xác suất).
- Rê chuột lên chip `AccountId → acc` thì tô thẻ `acc`.
- Khi đổi sObject mà đã chọn org, thay field mặc định `Name` bằng name field thật (Task không có `Name` mà có `Subject`).
  Hiện Record Task mới vẫn mang field `Name` và insert sẽ lỗi.
- Loại khung nhiều nhánh (kiểu Switch) có số slot theo cấu hình: cần `slots` động trong meta.
- Cho phép trùng alias ở các nhánh loại trừ nhau, để bước sau Rẽ nhánh tham chiếu "bản ghi vừa tạo ở nhánh nào cũng được".

## Đã làm

### Đợt A (bước 0–5 và 7), 2026-10-27

| Bước | Đã làm | File chính |
| --- | --- | --- |
| 0 | Executor v1 đóng băng, cùng bản v1 của hai mẫu và vài đồ thị có cấu trúc. Test viết và chạy qua **trước** khi sửa executor | `test/fixtures/run-v1.js`, `test/fixtures/v1-samples.js`, `test/fixtures/v1-cases.js`, `test/run-v1.test.js` |
| 1 | Logic cây dùng chung và route tĩnh `/shared/` (chặn traversal) | `shared/workflow-tree.js`, `server/index.js`, `test/workflow-tree.test.js`, `test/server.test.js` |
| 2 | Migration v1 → v2 theo đúng thuật toán ở trên, kèm `describeReport()` (câu tiếng Việt cho hộp thoại và cảnh báo server) | `shared/migrate-v1.js`, `test/migrate.test.js` |
| 3 | Hợp đồng v2 ở server: `slots`/`category` thay `inputs`/`outputs`, bỏ `start`, `maxDepth`; validate cây với các câu lỗi mới; `runSteps` đệ quy, `disabled`, `stats.byStep`; nhận v1 kèm cảnh báo; nhãn "Bản ghi cha" | `server/workflow/{nodes,schema,executor}.js`, `shared/scope.js`, `server/generators/reference.js`, `test/workflow.test.js`, `test/scope.test.js` |
| 4–5 | Client: store v2 (khóa `sfdg.workflow.v2`, `sfdg.collapsed`), `ops.js`, `summary.js`, chế độ Quy trình, hộp thoại chuyển đổi, phím tắt mới, inspector (bottom sheet trên màn hình hẹp), mẫu v2. `canvas.js` bị xóa | `client/js/{process,ops,summary,store,main,inspector,forms,dom,samples}.js`, `client/index.html`, `client/css/app.css`, `test/samples.test.js`, `.claude/skills/smoke-test/smoke.cjs` |
| 7 | Tài liệu tham chiếu | `docs/workflow-schema.md` (v2 + mục version 1), `docs/architecture.md`, `docs/field-types.md`, `docs/org-connection.md`, `README.md` |

Kiểm tra: `npm test` (mọi test qua, kể cả so sánh từng byte giữa `run-v1` và executor v2 trên hai mẫu và năm đồ thị có
cấu trúc, với ba seed). Smoke test (`node .claude/skills/smoke-test/smoke.cjs`) chạy luồng của bước 5 và thêm: autosave
v1 được chuyển (toast, khóa `sfdg.workflow.v1` còn nguyên), mở file v1 có node lơ lửng thì có hộp thoại báo cáo và
nút "Tải bản gốc (v1)", màn hình 390 px không tràn ngang và mở được bottom sheet.

Lỗi đã xác nhận trong [0007](0007-tong-hop-0003-0006.md) được sửa luôn: `Lặp{acc}` rồi Contact có Lookup ngẫu nhiên tới
`acc` giờ hợp lệ (`last`); `renameAlias` escape alias trước khi tạo regex; đổi tên biến lặp chỉ đổi tham chiếu trong thân
vòng lặp đó.

Khác với thiết kế (và lý do):

- **Phân tích phạm vi** nằm ở `shared/scope.js` (0005 đề xuất chỗ này khi 0003 làm trước), chỉ cho Lookup `ref`:
  `analyzeRecordScope`, `refState`, `recordChoices`. Tên trạng thái theo 0005 (`always` thay cho `ok`; `after` /
  `otherBranch` thay cho `notBefore`). Mọi câu hỏi "alias này dùng được ở đây không" (validate, dropdown, Import) đều đi qua
  module này, để `analyzeScope` của 0005 thay thế một chỗ.
- `stats.byStep.records` có ở mọi bước (với khung là số bản ghi sinh trong khung). `iterations` của Lặp là tổng N, kể cả
  khi thân rỗng.
- `/api/meta` có thêm `stepCategories` (nhãn nhóm `Dữ liệu` / `Điều khiển`), để client không hard-code nhãn.
- `moveStep` nhận vị trí đích theo cây **trước khi** di chuyển (đúng thứ người dùng thấy khi thả); `neighbourTarget` trả
  về cùng hệ tọa độ.
- Nhân bản (Ctrl+D) dùng cùng quy tắc id với migration (`<id>_2`), không dùng id ngẫu nhiên.
- `canvas.js` bị xóa thay vì ẩn (đợt B viết lại từ đầu). Chưa có nút Quy trình | Sơ đồ, phím M, `sfdg.view`.
- `updateWorkflow` không tạo bước undo và không phát sự kiện khi thao tác không đổi gì (ví dụ di chuyển vào đúng chỗ cũ).
- Thêm: phím ContextMenu / Shift+F10 mở menu `⋯` của bước đang chọn.
- Test tương đương của bước 2 (cần executor cây) nằm trong commit của bước 3; bước 4 và 5 chung một commit vì view mới
  và lõi client phụ thuộc nhau.

### Sửa sau review đợt A, 2026-10-27

| Mục | Đã làm | File chính |
| --- | --- | --- |
| S1 | Bản sao do migration tạo có trạng thái riêng (`fieldStates` theo id bước): field "Giá trị duy nhất" / Auto Number có thể trùng giữa `c` và `c_2`, và dữ liệu sau đó khác v1. Không đổi hợp đồng: `report.duplicated[].uniqueFields` + một dòng báo cáo riêng kèm cách sửa (Tiền tố/Hậu tố); sửa câu "sinh đúng dữ liệu cũ" ở tài liệu, bảng trên và hộp thoại chuyển đổi | `shared/migrate-v1.js`, `client/js/main.js`, `docs/workflow-schema.md`, `docs/field-types.md`, `test/migrate.test.js` (Tên, unique, pool nhỏ: thấy trùng thật) |
| S2 | `/api/run` với v1 và `target.kind === 'org'`: nếu chuyển đổi có `duplicated`/`truncated`/`tooDeep` thì 422 kèm câu hướng dẫn mở trình soạn và Lưu; xem trước vẫn chạy, có cảnh báo | `server/workflow/schema.js` (`insertBlockedReason`, `prepareWorkflow().migration`), `server/index.js`, `test/server.test.js` |
| S4 | Quy trình: `stale` tính một lần mỗi lần render; sửa từ inspector (`source: 'inspector'`) gộp render bằng `requestAnimationFrame` | `client/js/process.js` |
| S5 | Bước không phải object hiện thẻ "Bước lỗi" thay vì làm hỏng view; mở file v2 kiểm tra cấu trúc (`malformedSteps`) trước `replaceWorkflow`; lần render đầu có try/catch: autosave hỏng thì mở mẫu, **không ghi đè** `sfdg.workflow.v2`, sao lưu sang `sfdg.workflow.v2.broken`, toast có nút "Tải bản lưu" | `shared/workflow-tree.js`, `client/js/{process,main,store,inspector}.js`, smoke test |
| N1 | Tóm tắt Lặp dùng đúng giá trị dự phòng của executor (`count ?? 0`, `min ?? 1`, `max ?? 1`); migration ghi rõ các giá trị này vào `config` khi thiếu | `client/js/summary.js`, `shared/migrate-v1.js` |
| N2 | "Hoàn tác" ở toast xóa / bỏ vỏ chỉ hoàn tác đúng thao tác đó: có thay đổi khác (sửa, undo, redo) thì nút biến mất (`workflowRevision()`) | `client/js/{ops,store,dom}.js`, smoke test |
| N3 | "Bọc trong Lặp" không đặt tên biến trùng biến của vòng lặp bên trong phần được bọc (hay alias Record) | `client/js/ops.js` |
| N4 | Báo cáo nhân bản: một dòng cho mỗi đoạn sao chép ("… và N bước phía sau"), `report.duplicated[].root` | `shared/migrate-v1.js`, `test/migrate.test.js` |
| N5 | Lồng sâu: điểm gộp tính lặp (không đệ quy) theo thứ tự topo ngược; `build` dừng ở cấp `maxDepth + 1`, ghi `report.tooDeep`, validate báo lỗi "lồng nhau quá 32 cấp" thay vì `RangeError` | `shared/migrate-v1.js`, `server/workflow/schema.js`, `test/migrate.test.js` (5000 Lặp / Rẽ nhánh lồng nhau; 3000 Rẽ nhánh nối tiếp vẫn nguyên) |
| N6 | Trùng id node v1: giữ node sau cùng như executor v1, ghi `report.duplicateIds` | `shared/migrate-v1.js`, `test/migrate.test.js` |
| N7 | Đổi alias / biến lặp khi đang gõ: tham chiếu chỉ đi theo tên hợp lệ, không trùng; ô trống hay trùng alias khác giữa chừng thì tham chiếu đứng yên ở tên tốt gần nhất (`setStepAlias`, `renameAlias` bỏ qua tên rỗng/không hợp lệ) | `shared/workflow-tree.js`, `client/js/inspector.js`, `test/workflow-tree.test.js`, smoke test |

`migrateV1` nhận thêm `{ maxDepth, fieldTypes }` (server: `LIMITS.maxDepth` và `describeGenerators()`, client: `/api/meta`).

Chưa làm trong đợt A: chế độ Sơ đồ và nút đổi chế độ (đợt B); ô tìm kiếm trong menu "+" chỉ hiện khi có hơn 6 loại bước
(hiện có 3). `CLAUDE.md`, `.claude/agents/*.md` và `.claude/skills/*/SKILL.md` chưa sửa theo danh sách ở mục
[Thay đổi cần làm ở tài liệu tham chiếu](#thay-đổi-cần-làm-ở-tài-liệu-tham-chiếu-dự-kiến-implementer-làm-cùng-code):
đây là file cấu hình của agent, cần người dùng tự duyệt và áp dụng.
