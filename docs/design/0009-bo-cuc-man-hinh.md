# 0009 — Bố cục màn hình: danh sách lỗi, thanh trên, bottom sheet và panel kết quả

- **Trạng thái:** Đã làm (duyệt 2026-10-27, làm 2026-10-28 sau 0004/0005/0006, xem [Đã làm](#đã-làm))
- **Ngày:** 2026-10-27
- **Liên quan:** [0008](0008-ui-design-system.md) (ghi nhận các lỗi bố cục này và để lại, Đã chốt 6), [0003](0003-process-mode.md)
  (bố cục Quy trình, bottom sheet ≤ 900 px), [0004](0004-streaming-execution.md) (tiến độ và nút Dừng trong panel kết quả),
  [0005](0005-variable-picker.md) (bảng chọn biến dạng popup trong inspector), [0006](0006-query-pick-nodes.md) (bước Query /
  Chọn bản ghi, tab kết quả chỉ đọc), tài liệu tham chiếu [../ui-design-system.md](../ui-design-system.md)

## Vấn đề

Người dùng mở app trên laptop 1280 × 800 hoặc trên điện thoại 390 × 844 và gặp bốn chuyện:

1. **Danh sách lỗi che đúng bước bị lỗi.** Workflow "Account + Contact" thêm bước `opp` (Opportunity) và `task` (thiếu
   sObject). Danh sách lỗi nổi (`.issues`, `position: absolute` góc dưới trái canvas) đè lên thẻ `task`, tức là che chính
   bước mà dòng lỗi đang nói tới, kể cả badge "⊗ 2" trên thẻ. Ở 1024 × 768 nó che cả `opp` lẫn `task`. Phải cuộn canvas
   xuống mới thấy thẻ (khoảng trống `--canvas-tail` 160 px chỉ giúp được khi người dùng biết mà cuộn). Bấm ↑/↓ để đi giữa
   các thẻ dùng `scrollIntoView({ block: 'nearest' })`, nên thẻ được chọn có thể dừng ngay dưới danh sách lỗi.
2. **Thanh trên chiếm chỗ.** Khi đã có org trong sf CLI (nhãn "alias — username" làm ô Org rộng tới 220 px), thanh trên
   xuống **2 hàng ở mọi chiều rộng dưới khoảng 1 460 px**, kể cả 1440, 1366, 1280. Hàng thứ hai chỉ chứa ô chọn giao diện
   (mất 40 px chiều cao chỉ cho một ô ít dùng). Ở 600 px là 3 hàng, 390 px là **5 hàng, cao 209 px = 25 % màn hình**.
3. **Bottom sheet che thẻ đang sửa.** Ở 390 × 844, chạm thẻ `con` thì sheet (60vh) trượt lên và che luôn thẻ đó: thẻ ở
   y = 386, mép sheet ở y = 338. Phần canvas còn thấy được phía trên sheet chỉ **46 px**. Bấm "▶ Xem trước" khi sheet
   đang mở thì panel kết quả mở **phía sau** sheet, nên người dùng không thấy kết quả. Toast "Workflow chưa hợp lệ." nằm đè
   lên nội dung sheet.
4. **Panel kết quả vỡ ở màn hình hẹp.** Ở 390 px, đầu panel cao 119 px: chữ "Kết quả" xuống 2 dòng, "Tải CSV (tab hiện
   tại)" xuống 4 dòng, chip tóm tắt xếp chồng. Trên màn hình ≤ 900 px không có cách nào nạp **Mẫu** (mục Mẫu bị ẩn cùng phần
   mô tả palette).

Số đo (Chromium headless, theme sáng, font hệ thống; script và ảnh đo nằm ở thư mục tạm của phiên thiết kế, không commit):

| Màn hình | Thanh trên | Canvas thấy được | Danh sách lỗi che thẻ (chưa cuộn) | Ảnh |
| --- | --- | --- | --- | --- |
| 1440 × 900, có org | 89 px (2 hàng) | 726 px | không | `1440x900-issues.png`, `1440-valid-preview.png` |
| 1280 × 800 | 89 px | 626 px | `task` | `1280x800-issues.png` |
| 1024 × 768 | 89 px | 594 px | `opp`, `task` | `1024x768-issues.png` |
| 900 × 800 | 89 px | 579 px | `task` | `900x800-issues.png` |
| 600 × 900 | 129 px (3 hàng) | 639 px | `task` | `600x900-issues.png` |
| 390 × 844 | 209 px (5 hàng) | 492 px; 46 px khi mở sheet | `opp` | `390x844-issues.png`, `390-valid-preview-sheet.png` |
| 390 × 844 sau Xem trước | 209 px | 231 px; đầu panel kết quả 119 px | — | `390-valid-preview.png` |

Chiều rộng tự nhiên của các phần tử thanh trên (đo ở 1600 px): tên app 124, ô tên workflow 180, Mới/Mở…/Lưu/↶/↷ 218,
Seed 167, Org khi có org 290 (khi chưa có org 226), Xem trước 112, Insert 128, Giao diện 128, khoảng cách 8 px.

## Mục tiêu / Ngoài phạm vi

- Mục tiêu:
  - Không lớp nổi nào (danh sách lỗi, sheet, toast) che thẻ bước đang được nói tới hay đang được chọn.
  - Thanh trên **1 hàng từ khoảng 1 140 px** khi đã có org (laptop 1280/1366/1440), **2 hàng** ở mọi chiều rộng nhỏ hơn,
    kể cả 360 px. Org, Xem trước, Insert luôn thấy được, không giấu vào menu (0006 viết "Chọn org ở thanh trên").
  - Ở 390 × 844: canvas thấy được ≥ 600 px khi không mở sheet, ≥ 190 px phía trên sheet; đầu panel kết quả 1 hàng.
  - Chừa sẵn chỗ cho 0004 (thanh tiến độ, nút Dừng), 0005 (popup chọn biến trong sheet) và 0006 (thêm 2 mục palette,
    thêm tab kết quả) để các doc đó không phải đổi bố cục lần nữa.
- Ngoài phạm vi:
  - Kéo để đổi chiều cao panel kết quả hay chiều cao sheet (xem "Câu hỏi mở").
  - Đổi các ký tự `⋯ ▸ ▾ ⠿ ↶ ↷ ⟳` thành SVG (0008 còn để lại).
  - Workflow JSON, server, `/api/meta`: không đổi gì.

## Luồng người dùng

**Luồng A — sửa lỗi trên laptop 1280 × 800.** Workflow có bước `task` thiếu sObject.

1. Thanh lỗi nằm **dưới** canvas (không nổi), đầu thanh ghi `2 lỗi`. Thẻ `task` và badge "⊗ 2" thấy đầy đủ. (0)
2. Bấm dòng `[task] Chưa nhập sObject hợp lệ (API name).` hoặc nhấn **F8**: bước `task` được chọn, khung cha tự mở, thẻ cuộn
   vào vùng thấy được, inspector viền đỏ ô sObject. (1)
3. Gõ `Task`. Thanh lỗi tự cập nhật sau 400 ms (validate như hiện nay); hết lỗi thì thanh biến mất và canvas cao lại. (1)

Tổng 2 thao tác, như hiện nay, nhưng không phải cuộn để thấy thẻ.

**Luồng B — sửa một bước trên điện thoại 390 × 844 rồi xem trước.**

1. Thanh trên 2 hàng (89 px): `[Account + Contact] [↶] [↷] [⋯]` / `[Org dev-sb — admin@… ▾] [▶ Xem trước] [⤒ Insert]`. (0)
2. Chạm thẻ `con`. Sheet trượt lên, canvas tự cuộn để thẻ `con` nằm ngay trên mép sheet (vùng thấy được 198 px). (1)
3. Sửa "Số bản ghi mỗi lần chạy" thành `3`. (1)
4. Chạm **▶ Xem trước** ở thanh trên. Sheet tự đóng (vẫn giữ bước đang chọn), panel kết quả mở và hiện bảng. (1)

Tổng 3 thao tác. Hiện nay bước 4 mở kết quả phía sau sheet, phải chạm thêm "‹ Xong" mới thấy (4 thao tác và dễ tưởng là
không chạy).

**Luồng C — nạp mẫu và đặt seed trên điện thoại.**

1. Chạm **⋯** (1), chạm `Account + Contact` trong nhóm **Mẫu** (1). Hỏi xác nhận như trên màn hình rộng nếu workflow hiện
   tại không rỗng.
2. Chạm **⋯** (1), gõ `42` vào ô **Seed** trong menu (1). Hàng trên hiện chip `Seed 42`; chạm chip mở lại menu với con trỏ
   trong ô Seed.

**Trường hợp lỗi và biên:**

- *Chạy thất bại vì lỗi validate* (server trả `issues`): thanh lỗi **tự mở rộng** nếu đang thu gọn, bước lỗi đầu tiên được
  chọn như hiện nay. Trên điện thoại sheet mở ở bước đó (với thẻ nằm ngay trên sheet).
- *Rất nhiều lỗi* (ví dụ 30 dòng): danh sách cao tối đa `min(124 px, 25vh)` và cuộn bên trong. (Sửa sau review: câu cũ
  "canvas không bao giờ thấp hơn 75 %" sai ở màn hình thấp. Đảm bảo thật: cả thanh (đầu + danh sách) cao tối đa 25 % cột giữa nhưng không thấp hơn đầu thanh (33 px), nên canvas giữ ≥ 75 % cột giữa (trừ phần hàng "Thu gọn/Mở tất cả") khi cột giữa cao từ ~132 px trở lên; thấp hơn nữa thì chỉ còn đầu thanh.)
- *Điện thoại xoay ngang 844 × 390*: sheet cao `min(60dvh, 100dvh − 200px)` = 190 px, vẫn chừa ≥ 60 px canvas (1 thẻ).
- *Đang mở sheet mà có toast* (xóa bước, lỗi chạy): toast hiện **trên** mép sheet, không đè nội dung sheet.
- *Chỉ có cảnh báo*: thanh dùng sọc trái màu cảnh báo (`.only-warnings`), đầu thanh `1 cảnh báo`.

## Thiết kế UI

### 1. Thanh lỗi gắn dưới canvas (thay danh sách lỗi nổi)

`#issues` chuyển từ lớp nổi sang **phần tử trong luồng** của cột giữa: `.view-wrap` là flex dọc
`[.view-tools] [#process (flex 1)] [#issues]`. Canvas co lại đúng bằng chiều cao thanh, nên không thẻ nào bị che. Thanh
rộng bằng cột giữa (không tràn sang palette/inspector).

```
┌ cột giữa ───────────────────────────────────────────────────────────────┐
│ …canvas (cuộn)…                                                          │
│            ┌ Record task  ? × 1 · 1 field                  ⊗2  ⋯  ▸ ┐    │
│            └─────────────────────────────────────────────────────────┘    │
├──────────────────────────────────────────────────────────────────────────┤
│▌ ⊗ 2 lỗi · ▲ 1 cảnh báo      Bấm một dòng để tới bước · F8: lỗi tiếp theo   [Thu gọn ▾] │
│▌ ⊗ [task] Chưa nhập sObject hợp lệ (API name).                           │
│▌ ⊗ [task] Tên field "" không hợp lệ.                                     │
│▌ ▲ [opp] …                                                               │
└──────────────────────────────────────────────────────────────────────────┘
```

| Phần | Quy tắc |
| --- | --- |
| Vỏ (`#issues.issues`) | Nền `surface`, viền trên `border`, sọc trái `--stripe-w` `danger` (hoặc `warning` khi `.only-warnings`), **không** bóng, không bo góc, không `position: absolute`. `hidden` khi không có lỗi và cảnh báo (như hiện nay). `role="region"`, `aria-label="Lỗi và cảnh báo"` |
| Đầu thanh (`.issues-head`) | Cao `--control-h-md` (32 px). Bên trái là số đếm, `aria-live="polite"`: `2 lỗi · 1 cảnh báo` / `2 lỗi` / `1 cảnh báo`, mỗi phần có icon ⊗ hoặc ▲ như dòng lỗi. Giữa: gợi ý `Bấm một dòng để tới bước · F8: lỗi tiếp theo` (12 px `text-muted`, ẩn ở ≤ 720 px). Bên phải: nút ghost `Thu gọn` / `Hiện (3)`, `aria-expanded`, `aria-controls="issues-list"` |
| Đầu thanh khi thu gọn | Sau số đếm là dòng lỗi đầu tiên, một dòng, cắt bằng `…`: `2 lỗi · 1 cảnh báo — [task] Chưa nhập sObject hợp lệ (API name).` Bấm vào câu đó = bấm dòng lỗi đầu (nhảy tới bước) |
| Danh sách (`#issues-list`) | Các nút `.issue.error` / `.issue.warning` như hiện nay (giữ class để smoke cũ chạy). Cao tối đa `--issues-max-h` = `min(124px, 25vh)` (≈ 4 dòng), cuộn bên trong |
| Trạng thái thu gọn | Lưu ở `localStorage['sfdg.issuesCollapsed'] = '1'` (trạng thái UI như `sfdg.collapsed`, không vào undo). Mặc định mở rộng |
| Tự mở rộng | Chỉ khi người dùng bấm Xem trước / Insert và server trả `issues`. Validate nền 400 ms **không** tự mở (tránh nhảy bố cục khi đang gõ) |

Phím tắt mới (thêm vào danh sách "Phím tắt" ở inspector khi chưa chọn bước):

| Phím | Tác dụng |
| --- | --- |
| **F8** | Tới lỗi/cảnh báo tiếp theo (theo thứ tự trong thanh, vòng lại đầu). Không có lỗi thì toast `Không có lỗi hay cảnh báo.` |
| **Shift+F8** | Tới lỗi/cảnh báo trước đó |

F8 hoạt động cả khi focus trong ô nhập của inspector (không phải phím gõ chữ). Mục đang tới được tô như `:focus` trong
danh sách (nền `accent-subtle`) để biết đang ở dòng nào.

`--canvas-tail` giảm 160 → **64 px**: không còn lớp nổi để cuộn qua, chỉ cần chỗ thở dưới dấu "+" cuối. Mô tả token đổi
thành "Khoảng trống dưới dấu + cuối trên canvas".

### 2. Thanh trên: hai nhóm, gập đúng chỗ

Thanh trên chia hai nhóm trong `index.html`. Khi không đủ một hàng, **cả nhóm Chạy** xuống hàng hai, nên thứ tự luôn dễ
đoán (không còn cảnh một ô lẻ rơi xuống hàng hai):

- `.tb-file`: tên app, ô tên workflow, Mới · Mở… · Lưu · ↶ · ↷, chip seed (chỉ điện thoại), **⋯** (chỉ ≤ 900 px).
- `.tb-run` (`margin-left: auto`): Seed, Org + ⟳, **▶ Xem trước**, **⤒ Insert vào org**, Giao diện.

| Chiều rộng | Bố cục | Thay đổi so với hiện nay |
| --- | --- | --- |
| ≥ 1 300 px | 1 hàng: `SF Data Generator [tên] Mới Mở… Lưu ↶ ↷ ······ Seed [  ] Org [ ▾] ⟳ [▶ Xem trước] [⤒ Insert vào org] [◐]` | Ô Giao diện thu gọn 128 → 32 px; ô Seed 96 px; `#org-select` tối đa 180 px |
| 1 140–1 299 px | 1 hàng, ẩn chữ "SF Data Generator" (vẫn có trong `<title>`) | |
| 721–1 139 px | 2 hàng: hàng 1 `.tb-file`, hàng 2 `.tb-run` (Seed trái, các nút phải) | |
| ≤ 720 px (điện thoại) | 2 hàng: `[tên ………][Seed 42][↶][↷][⋯]` / `[Org ……… ▾][▶ Xem trước][⤒ Insert]` | Mới/Mở…/Lưu, Seed, ⟳, Giao diện vào menu **⋯**. Ô tên và ô Org co giãn (`flex: 1`, `min-width: 0`). Nút Insert ghi `⤒ Insert`, `title`/`aria-label` giữ nguyên câu đầy đủ (`Sinh dữ liệu và insert vào dev-sb`) |

Tổng chiều rộng ở 1 hàng (có org): 124 + 180 + 218 + 134 + 250 + 112 + 128 + 32 + 7 × 8 + 24 padding ≈ 1 258 px, nên vừa
1 280 px với tên app; bỏ tên app còn ≈ 1 126 px.

**Ô Giao diện thu gọn.** Vẫn là `<select id="theme-select">` (giữ trợ năng, phím, đồng bộ giữa tab trong `theme.js` và các
kiểm tra smoke hiện có). CSS: rộng `--control-h-md`, `appearance: none`, chữ trong suốt, icon `--ico-theme` (nửa vòng tròn)
ở giữa bằng `mask`; `option` đặt lại `color: var(--color-text)` và nền `surface` để danh sách thả xuống đọc được.
`title` đổi theo giá trị: `Giao diện: Theo hệ thống` / `Giao diện: Sáng` / `Giao diện: Tối` (cập nhật trong `theme.js`
ở sự kiện `change` và `storage`). Nhãn `sr-only` "Giao diện" giữ nguyên.

**Menu ⋯** (`#btn-more`, `title="Mẫu và thao tác khác"`, `aria-haspopup="menu"`), dùng popup chung (`.popup`, như menu
"+" và menu bước). Chỉ hiện ở ≤ 900 px. Nội dung theo chiều rộng lúc mở:

| Nhóm | Mục | Hiện khi | Tác dụng |
| --- | --- | --- | --- |
| Workflow | `Mới`, `Mở…`, `Lưu` (kbd `Ctrl+S`) | ≤ 720 px | Gọi đúng nút tương ứng (`#btn-new`, `#btn-open`, `#btn-save`), nên vẫn hỏi xác nhận như cũ |
| Chạy | Ô **Seed** (input, placeholder `ngẫu nhiên`, cùng `title` với ô ở thanh trên) | ≤ 720 px | Đồng bộ hai chiều với `#seed` (một nguồn giá trị là `#seed`). Enter đóng menu |
| Chạy | `Tải lại danh sách org` | ≤ 720 px | Như nút ⟳ |
| Khung | `Thu gọn tất cả`, `Mở tất cả` | ≤ 720 px | Như hai nút `.view-tools` (hàng này ẩn ở ≤ 720 px để lấy lại 30 px) |
| Mẫu | `Account + Contact` (mô tả `5 Account, mỗi Account 1–4 Contact`), `Lead theo xác suất` | ≤ 900 px | Như mục Mẫu ở palette, kể cả hỏi `Thay workflow hiện tại? (Vẫn có thể hoàn tác bằng Ctrl+Z)` |
| Giao diện | `Theo hệ thống`, `Sáng`, `Tối` (dấu ✓ ở mục đang chọn, `role="menuitemradio"`, `aria-checked`) | ≤ 720 px | Đặt `#theme-select.value` rồi phát sự kiện `change` |

**Chip seed (điện thoại).** Chỉ hiện ở ≤ 720 px khi ô Seed có giá trị: nút nhỏ `Seed 42`
(`title="Seed cố định: 42. Chạm để sửa."`). Chạm mở menu ⋯ và focus ô Seed. "📌 giữ seed" ở panel kết quả đặt seed thì chip
hiện ngay. Lý do: seed ẩn trong menu mà vẫn đang có giá trị thì người dùng không hiểu vì sao lần nào cũng ra cùng dữ liệu,
và hộp xác nhận Insert dựa vào seed.

### 3. Bottom sheet (≤ 900 px)

| Quy tắc | Chi tiết |
| --- | --- |
| Chiều cao | `--sheet-h: min(60dvh, calc(100dvh - 200px))` (dùng `dvh` để không lệch khi thanh địa chỉ di động co giãn) |
| Thẻ đang chọn luôn thấy được | `inspector.js` đặt `body.sheet-open` khi sheet mở. Khi đó `.process` có `scroll-padding-bottom: var(--sheet-h)` và phần đệm cuối `.process::after { height: var(--sheet-h) }` (để thẻ cuối vẫn cuộn lên được trên sheet). Ngay sau khi mở sheet, thẻ được chọn gọi `scrollIntoView({ block: 'nearest' })`, nên nó dừng ngay trên mép sheet |
| Đầu sheet dính | Hàng `‹ Xong` (`.sheet-close`) `position: sticky; top: 0`, nền `surface`, nên đóng được sheet mà không phải cuộn ngược lên |
| Chạy thì đóng sheet | Bấm Xem trước / Insert (hoặc Ctrl+Enter) ở ≤ 900 px: sheet đóng như bấm "‹ Xong" (giữ lựa chọn), để thấy panel kết quả. Nếu chạy lỗi validate thì `goToIssue` mở lại sheet ở bước lỗi |
| Toast | `body.sheet-open .toast { bottom: calc(var(--sheet-h) + var(--space-3)) }` |
| Popup trong sheet (menu ⋯ của field, bảng chọn biến 0005) | z-index `--z-popup` (40) > `--z-sheet` (30) như hiện nay. Ở ≤ 720 px popup rộng `calc(100vw - 2 × --space-2)`, neo trái `--space-2`, cao tối đa `min(360px, 45dvh)`, lật lên trên ô nếu dưới không đủ chỗ. 0005 dùng đúng quy tắc này |

### 4. Panel kết quả

| Quy tắc | Chi tiết |
| --- | --- |
| Đầu panel 1 hàng ở mọi chiều rộng | Bố cục `[Kết quả ▾] [tóm tắt (co giãn)] [nút]`. `#btn-results-toggle` `white-space: nowrap`, có `aria-expanded`, thêm ký tự ▾/▴ theo trạng thái |
| Tóm tắt ở ≤ 720 px | Một dòng, `white-space: nowrap; overflow-x: auto` (cuộn ngang, không xuống dòng). Giữ đủ chip sObject, seed, "📌 giữ seed", ms |
| Nút tải ở ≤ 720 px | `Tải JSON` và `Tải CSV (tab hiện tại)` ẩn, thay bằng một nút `⤓ Tải` (`aria-haspopup="menu"`) mở popup 2 mục cùng nhãn cũ, gọi đúng hai nút cũ (khóa khi chúng khóa) |
| Hàng tab | `.tabs { overflow-x: auto }`, tab không xuống dòng. Cần cho 0006 (thêm tab Query chỉ đọc) và workflow nhiều sObject |
| Chừa chỗ cho 0004 | Khi đang chạy, ô `[nút]` đổi thành nút **Dừng** (nút tải vốn bị khóa lúc chạy). Thanh `<progress class="run-progress">` cao 3 px nằm sát mép dưới `.results-head` (`position: absolute`), không thêm hàng. Chip `<sObject> đã insert/tổng` nằm trong tóm tắt, nên ở ≤ 720 px cuộn ngang như mục trên |

Chiều cao panel mở (`38vh`) giữ nguyên.

### 5. Palette và mục Mẫu ở màn hình hẹp

Hàng palette ngang (≤ 900 px) giữ nguyên; khi 0006 thêm Query và Chọn bản ghi (5 mục) thì hàng cuộn ngang như hiện nay.
Mục Mẫu, vốn bị ẩn ở ≤ 900 px, nay ở nhóm **Mẫu** của menu ⋯ (mục 2).

### 6. Tóm tắt chiều cao ở 390 × 844

| Vùng | Hiện nay | Sau 0009 |
| --- | --- | --- |
| Thanh trên | 209 px | 89 px |
| Palette | 51 px | 51 px |
| Thu gọn/Mở tất cả | 30 px | 0 (vào menu ⋯) |
| Đầu panel kết quả (đóng / sau xem trước) | 60 / 119 px | 48 / 48 px |
| Canvas thấy được, không mở sheet | 492 px | ≈ 656 px |
| Canvas thấy được phía trên sheet | 46 px | ≈ 198 px |

## Thay đổi dữ liệu / API

- Workflow JSON: **không đổi**. File `version: 2` và `version: 1` (qua `shared/migrate-v1.js`) không bị ảnh hưởng.
- Endpoint, `/api/meta`, option schema: không đổi.
- `localStorage`: thêm `sfdg.issuesCollapsed` (`'1'` hoặc không có). Đọc/ghi bọc `try/catch` như `sfdg.theme`.
- Token CSS (khối token của `app.css`, và bảng §3 của `ui-design-system.md`):
  - `--canvas-tail`: 160 px → 64 px.
  - Mới: `--issues-max-h: min(124px, 25vh)`, `--sheet-h: min(60dvh, calc(100dvh - 200px))`, `--ico-theme` (SVG mask).
- Mốc chiều rộng (media query, không dùng được biến CSS): **1299 px** (ẩn tên app), **900 px** (bố cục hẹp, đã có),
  **720 px** (thanh trên điện thoại, đầu panel kết quả, menu ⋯ đủ mục). Ghi vào `ui-design-system.md` §7.

## Checklist tiện dụng

- [x] 1. Chạy được ngay với mặc định — không có cấu hình mới; thanh lỗi mặc định mở rộng, các mốc tự áp theo chiều rộng.
- [x] 2. Ít thao tác cho việc hay làm — sửa trên điện thoại rồi xem trước: 4 → 3 thao tác; F8/Shift+F8 đi giữa các lỗi;
  Org, Xem trước, Insert không bao giờ vào menu.
- [x] 3. Xem trước trước khi ghi — hộp xác nhận Insert không đổi. Chip seed ở điện thoại cho biết đang chạy với seed cố định.
- [x] 4. Lỗi chỉ đúng chỗ và nói cách sửa — thanh lỗi không còn che bước lỗi; F8 nhảy tới bước và ô lỗi; chạy lỗi thì thanh
  tự mở rộng.
- [x] 5. Không mất công sức — không đụng tới dữ liệu; Mới/Mẫu trong menu ⋯ vẫn hỏi xác nhận và hoàn tác được.
- [x] 6. Lấy thông tin từ org thay vì bắt gõ — không áp dụng trực tiếp; ô Org luôn ở thanh trên nên các gợi ý "Chọn org ở
  thanh trên" (0006) vẫn đúng ở mọi chiều rộng.
- [x] 7. Một nguồn sự thật — menu ⋯ và nút `⤓ Tải` gọi lại đúng nút có sẵn; ô Seed trong menu chỉ là ô phản chiếu `#seed`;
  không thêm kiến thức về loại bước ở client.
- [x] 8. Giải thích tại chỗ — gợi ý `Bấm một dòng để tới bước · F8: lỗi tiếp theo`; `title` cho ô Giao diện thu gọn, chip
  seed, nút Insert rút gọn.
- [x] 9. An toàn khi lỡ tay — nút Insert ở điện thoại vẫn đỏ, vẫn mở hộp xác nhận ghi rõ org; không đổi giới hạn.

## Phương án đã cân nhắc

**Danh sách lỗi**

| Phương án | Ưu | Nhược | Chọn? |
| --- | --- | --- | --- |
| A. Thanh gắn dưới canvas, trong luồng, thu gọn được | Không bao giờ che thẻ; gần các thẻ; chỉ đổi CSS + một ít JS | Canvas thấp đi tối đa 124 + 32 px khi có lỗi | **Có** |
| B. Giữ lớp nổi, đặt `padding-bottom` canvas bằng chiều cao danh sách (ResizeObserver) | Canvas không thấp đi | Chưa cuộn thì vẫn che; vẫn che dấu "+" cuối và thẻ khi ↑/↓ dùng `nearest` | Không |
| C. Chuyển thành tab "Lỗi (n)" trong panel kết quả | Gom một chỗ với "Lỗi insert" | Ẩn khi panel đóng; xa thẻ; lẫn lỗi cấu hình với dữ liệu kết quả | Không |
| D. Đưa vào inspector khi chưa chọn bước | Không tốn chỗ canvas | Chọn bước nào là mất danh sách; ở điện thoại nằm trong sheet đóng | Không |

**Thanh trên**

| Phương án | Ưu | Nhược | Chọn? |
| --- | --- | --- | --- |
| A. Hai nhóm gập theo nhóm, thu gọn ô Giao diện, ẩn tên app < 1 300 px, menu ⋯ cho phần ít dùng ở ≤ 720 px | 1 hàng ở laptop, 2 hàng ở điện thoại; Org/Xem trước/Insert luôn thấy | Thêm một menu và các mốc chiều rộng | **Có** |
| B. Menu hamburger chứa mọi thứ ở màn hình hẹp | Thanh trên 1 hàng | Xem trước và Insert tốn 2 chạm (vi phạm nguyên tắc 2); org bị giấu | Không |
| C. Một hàng cuộn ngang | Không giấu gì | Nút Insert có thể nằm ngoài màn hình; khó phát hiện | Không |
| D. Thanh hành động dưới đáy ở điện thoại | Ngón cái dễ chạm | Tranh chỗ với sheet, panel kết quả và tiến độ 0004 | Không |

**Ô Giao diện**

| Phương án | Ưu | Nhược | Chọn? |
| --- | --- | --- | --- |
| A. Giữ `<select>`, thu gọn bằng CSS thành ô icon 32 px | Không đổi `theme.js` ngoài `title`; smoke hiện có vẫn chạy | Kỹ thuật chữ trong suốt cần kiểm tra danh sách thả xuống đọc được | **Có** |
| B. Nút icon + popup tự viết | Kiểm soát giao diện hoàn toàn | Viết lại `theme.js` và smoke, thêm code trợ năng | Không |

**Bottom sheet**

| Phương án | Ưu | Nhược | Chọn? |
| --- | --- | --- | --- |
| A. Giữ sheet, thêm `scroll-padding`, đầu sheet dính, chạy thì đóng sheet | Nhỏ, chỉ CSS + vài dòng JS | Chiều cao vẫn cố định | **Có** |
| B. Sheet kéo được (2 nấc 60 % / 90 %) | Linh hoạt | Xử lý cử chỉ chạm, khó test | Để sau |
| C. Inspector toàn màn hình ở điện thoại | Nhiều chỗ cho form | Mất ngữ cảnh thẻ đang sửa | Không |

## Kế hoạch thực hiện

Không có thay đổi contract (bảng trong `.claude/agents/implementer.md` chỉ chạm hàng UI, Docs, Tests). Mỗi bước tự chạy
được và có kiểm tra riêng. Smoke đo bằng `getBoundingClientRect`, dùng workflow "Account + Contact" + bước `opp` và `task`
(thiếu sObject, field không tên) như script `shots.mjs`, và `/api/orgs` giả lập một org nhãn dài (`dev-sandbox-very-long —
admin.developer@acme-corporation.com.devsb [sandbox]`), đặt sẵn `localStorage['sfdg.org']`. Không gọi org thật.

| # | Việc | File | Kiểm tra |
| --- | --- | --- | --- |
| 1 | **Tách popup dùng chung.** Chuyển `openPopup`/`closePopup` từ `process.js` sang `client/js/popup.js` (export). Thêm loại mục `{ field: { label, value, placeholder, title, onInput, onEnter } }` (hàng nhãn + input) và `{ checked }` (`role="menuitemradio"`, ✓). Phím gõ chữ để nhảy mục bỏ qua khi focus ở bất kỳ `input` nào (không chỉ ô tìm kiếm) | `client/js/popup.js` (mới), `client/js/process.js` | Smoke luồng 2 (menu "+") và menu bước vẫn qua |
| 2 | **Thanh lỗi.** HTML `#issues` thành `.issues-head` + `#issues-list` (vẫn trong `.view-wrap`, sau `#process`). Chuyển `setIssues`/`goToIssue` sang `client/js/issues.js`; hàm thuần `issueCountsLabel({ errors, warnings })` và `nextIssueIndex(current, length, dir)`. Thu gọn/mở rộng + `sfdg.issuesCollapsed`; tự mở rộng khi `run()` nhận `issues`. F8 / Shift+F8 trong `wireShortcuts`. CSS: bỏ `position: absolute`, bóng, bo góc; `--issues-max-h`; `--canvas-tail` 64 px. Thêm F8 vào danh sách phím tắt của inspector | `client/index.html`, `client/js/issues.js` (mới), `client/js/main.js`, `client/js/inspector.js`, `client/css/app.css` | `test/issues.test.js` (mới): nhãn `2 lỗi · 1 cảnh báo` / `2 lỗi` / `1 cảnh báo`, `nextIssueIndex` vòng lại hai chiều. Smoke luồng 13a ở 1440 × 900, 1280 × 800, 1024 × 768: không `.step-card` nào giao với `#issues`; `#process` đáy ≤ `#issues` đỉnh; F8 chọn `task`, F8 lần nữa chọn lại theo vòng; Thu gọn → `#issues` cao ≤ 40 px và còn sau khi tải lại |
| 3 | **Thanh trên.** HTML hai nhóm `.tb-file` / `.tb-run`, thêm `#btn-more`, `#seed-chip`, nhãn Insert tách `<span class="lbl-long">vào org</span>`. CSS: `.tb-run { margin-left: auto }`, ô Seed 96 px, `#org-select` tối đa 180 px, ô Giao diện thu gọn + `--ico-theme`, mốc 1299 / 720 px. `theme.js` cập nhật `title` của ô chọn | `client/index.html`, `client/css/app.css`, `client/js/theme.js` | Smoke 13b: chiều cao `.topbar` ≤ 50 px ở 1440 và 1280 (có org nhãn dài); ≤ 90 px ở 1024, 768, 390, 360; `scrollWidth === innerWidth` ở 390 và 360; `#org-select`, `#btn-preview`, `#btn-insert` thấy được ở mọi chiều rộng; ô Giao diện rộng 32 px và `option` có màu chữ khác `transparent`; luồng 10 và 12 (theme) vẫn qua |
| 4 | **Menu ⋯ và chip seed.** Dựng mục theo bảng ở §2 lúc mở (đọc `matchMedia('(max-width: 720px)')`), gọi lại nút có sẵn; ô Seed phản chiếu `#seed`; chip `Seed n` cập nhật khi `#seed` đổi (kể cả "📌 giữ seed"). Ẩn `.view-tools` ở ≤ 720 px | `client/js/main.js`, `client/css/app.css` | Smoke 13c ở 390 × 844: menu có `Mới`, `Mở…`, `Lưu`, ô Seed, `Account + Contact`, `Tối`; gõ `42` → `#seed` = `42`, chip `Seed 42` hiện; chọn mẫu → có thẻ `acc`; ở 800 px menu chỉ có nhóm Mẫu |
| 5 | **Bottom sheet.** `--sheet-h`; `body.sheet-open` (toggle trong `inspector.js` cùng chỗ `.open`); `scroll-padding-bottom`, `.process::after`; cuộn thẻ chọn sau khi mở; `.sheet-close` dính; `run()` đóng sheet ở ≤ 900 px; toast trên sheet | `client/js/inspector.js`, `client/js/main.js`, `client/css/app.css` | Smoke 13d ở 390 × 844: chạm `con` → đáy thẻ `con` ≤ đỉnh `#inspector`; vùng canvas trên sheet ≥ 190 px; bấm Xem trước → `.inspector.open` mất, `con` vẫn `.selected`, có `table.data` thấy được; cuộn sheet xuống đáy thì `‹ Xong` vẫn thấy; ở 844 × 390 đỉnh sheet ≥ đáy palette + 60 px; toast khi sheet mở có đáy ≤ đỉnh sheet |
| 6 | **Panel kết quả.** Đầu panel 1 hàng: `nowrap` cho nút Kết quả, `aria-expanded` + ▾/▴; tóm tắt cuộn ngang ở ≤ 720 px; nút `⤓ Tải` + popup; `.tabs { overflow-x: auto }`; chừa ô nút cho Dừng (0004) | `client/index.html`, `client/js/results.js`, `client/css/app.css` | Smoke 13e ở 390 × 844 sau Xem trước: `.results-head` cao ≤ 50 px; `⤓ Tải` mở 2 mục; ở 1440 vẫn thấy hai nút cũ; luồng 3 (đầu bảng dính sát tab) vẫn qua |
| 7 | **Tài liệu và smoke.** Cập nhật `ui-design-system.md` (§3 token `--canvas-tail`, `--issues-max-h`, `--sheet-h`, `--ico-theme`; §6.8 bottom sheet; §6.10 đầu panel kết quả; §6.11 thanh lỗi thay "Danh sách lỗi (`.issues`)"; §7 thêm bảng mốc chiều rộng 1299 / 900 / 720 px; §8.3 ô Giao diện thu gọn và F8). `docs/architecture.md`: dòng `client/js/issues.js`, `client/js/popup.js`. `SKILL.md` của smoke-test mô tả luồng 13. 0004: nút Dừng thay ô nút tải, `<progress>` 3 px ở mép dưới đầu panel. 0005: popup ở ≤ 720 px theo §3. Mục "Đã làm" của doc này | `docs/ui-design-system.md`, `docs/architecture.md`, `docs/design/0004-streaming-execution.md`, `docs/design/0005-variable-picker.md`, `.claude/skills/smoke-test/SKILL.md`, `.claude/skills/smoke-test/smoke.cjs` | `npm test` qua (gồm `css-tokens.test.js`: token mới có trong bảng, khoảng cách vẫn theo thang 4 px; `scroll-padding-bottom` và `height` không thuộc luật khoảng cách); smoke `SMOKE OK`, chụp `smoke-1280-issues.png`, `smoke-390-topbar.png`, `smoke-390-sheet.png` |

Ghi chú khi làm:

- Bước 2 trước bước 3–6 vì nó sửa lỗi nặng nhất (che bước lỗi) và độc lập.
- Chiều rộng font khác nhau giữa máy; nếu smoke 13b đỏ ở 1280 trên máy CI, hạ `#org-select` xuống 160 px trước khi đổi mốc.
- Không thêm dependency; không dùng `:has()` (dùng class `sheet-open` cho dễ test và chạy được trên trình duyệt cũ hơn).

## Câu hỏi mở / Việc tiếp theo

- Kéo đổi chiều cao panel kết quả (hiện cố định 38vh; ở 1440 × 900 canvas còn 433 px khi panel mở) và sheet hai nấc
  (60 % / 90 %). Nên làm cùng hoặc sau 0004, khi panel kết quả có thêm tiến độ.
- Dấu hiệu "còn mục" (mờ dần mép phải) cho hàng palette ngang khi 0006 thêm 2 mục.
- Đổi các ký tự `⋯ ▸ ▾ ⠿ ↶ ↷ ⟳ ⤓` thành icon SVG (còn từ 0008).

## Đã chốt

Người dùng giao chọn theo phương án đề xuất; planner chốt như sau (2026-10-27):

1. **Danh sách lỗi thành thanh gắn dưới canvas** (phương án A), thu gọn được, nhớ trạng thái trong
   `sfdg.issuesCollapsed`, mặc định mở rộng, cao tối đa `min(124px, 25vh)`.
2. **Thanh lỗi tự mở rộng chỉ khi chạy thất bại vì lỗi validate**, không tự mở khi validate nền.
3. **Thêm F8 / Shift+F8** để đi giữa các lỗi và cảnh báo.
4. **`--canvas-tail` 160 → 64 px.**
5. **Thanh trên hai nhóm** (`.tb-file`, `.tb-run`) gập theo nhóm; 1 hàng từ ≈ 1 140 px; tên app ẩn dưới 1 300 px; ô Seed
   96 px; `#org-select` tối đa 180 px.
6. **Ô Giao diện giữ `<select>`**, thu gọn bằng CSS thành ô icon 32 px (phương án A), `title` theo giá trị.
7. **Mốc điện thoại 720 px**: thanh trên 2 hàng; Mới/Mở…/Lưu, Seed, ⟳, Thu gọn/Mở tất cả, Giao diện vào menu ⋯; Org,
   Xem trước, Insert luôn ở thanh trên; nhãn rút gọn `⤒ Insert`.
8. **Menu ⋯ hiện ở mọi màn hình ≤ 900 px** và luôn có nhóm **Mẫu** (sửa lỗi không nạp được mẫu trên màn hình hẹp).
9. **Chip `Seed n`** ở điện thoại khi seed có giá trị.
10. **Bottom sheet giữ một nấc**, cao `min(60dvh, 100dvh − 200px)`; thẻ đang chọn luôn cuộn lên trên mép sheet; đầu sheet
    dính; bấm chạy thì đóng sheet (giữ lựa chọn); toast nằm trên sheet.
11. **Đầu panel kết quả luôn 1 hàng**; ở ≤ 720 px tóm tắt cuộn ngang và hai nút tải gộp thành `⤓ Tải`; hàng tab cuộn ngang.
12. **Chỗ cho 0004**: nút Dừng thay ô nút tải lúc chạy, `<progress>` 3 px ở mép dưới đầu panel, không thêm hàng.
    **Chỗ cho 0005**: popup trong sheet theo quy tắc §3. **Chỗ cho 0006**: hàng palette và hàng tab cuộn ngang; ô Org
    không bao giờ bị giấu.
13. Kéo đổi chiều cao panel/sheet **để sau** (Câu hỏi mở).

## Đã làm

Làm sau 0004, 0005 và 0006, nên trước khi sửa đã đo lại DOM hiện tại: nút **Dừng** và `<progress class="run-progress">`
3 px ở mép dưới `.results-head` (0004 đã dùng đúng chỗ chừa của §4) **giữ nguyên**; bảng chọn biến (0005), Query / Chọn bản
ghi (0006, 5 mục palette, tab `↓ alias`), tab "Lỗi insert" gom nhóm và tải qua `/api/export` không đổi.

| Commit | Nội dung |
| --- | --- |
| `71fb3b0` Rework the screen layout… | Bước 1–6: `client/js/popup.js`, `client/js/issues.js`, thanh trên, menu ⋯ và chip Seed, bottom sheet, đầu panel kết quả, `test/issues.test.js` |
| `9d1e9da` Run the smoke flows in parallel… | Smoke luồng 13 (13a–13e) và smoke chạy song song |
| (commit tài liệu) | Bước 7: `ui-design-system.md` (§4 token, §5 icon `theme`, §6.7 popup, §6.8 sheet, §6.10 đầu panel, §6.11 thanh lỗi, §7 bảng mốc, §8.3), `architecture.md`, SKILL smoke, ghi chú ở 0004 / 0005, doc này, README; test token trong `css-tokens.test.js` |

**Số đo sau khi làm** (Chromium headless, theme sáng, `/api/orgs` giả lập nhãn dài
`dev-sandbox-very-long — admin.developer@acme-corporation.com.devsb [sandbox]`):

| Màn hình | Thanh trên | Canvas | Ghi chú |
| --- | --- | --- | --- |
| 1440 × 900, 1280 × 800, 1140 × 800 | 49 px (1 hàng) | — | Thanh lỗi không che thẻ nào (smoke 13a); trước: 89 px, 1280 che `task` |
| 1024 × 768, 900, 768 | 89 px (2 hàng) | — | Trước 1024 che `opp` và `task` |
| 600, 390 × 844, 360 × 740 | 89 px (2 hàng) | 390: 655 px (y 140 → 795), 198 px phía trên sheet | Trước 209 px / 492 px / 46 px |
| 844 × 390 | 89 px | sheet 190 px, đỉnh sheet = đáy palette + 60 px | |
| Đầu panel kết quả | 48 px ở mọi chiều rộng | | Trước 119 px ở 390 |

**Chỗ khác thiết kế / quyết định khi làm:**

1. **Nút `⤒ Insert` ở điện thoại:** phần ` vào org` ẩn kiểu `.sr-only` (vẫn được đọc) thay vì đặt `aria-label`; tên đọc lên
   vẫn là "⤒ Insert vào org", `title` vẫn là câu đầy đủ `Sinh dữ liệu và insert vào <org>`. Nhãn "Org" cũng chỉ ẩn bằng mắt
   ở ≤ 720 px để ô Org rộng hơn.
2. **Mốc 1 139 px là media query** (`.tb-run { flex-basis: 100% }`) chứ không để tự gập, để hàng hai luôn là "Seed trái, các
   nút phải". Từ 1 140 px trở lên vẫn gập nguyên nhóm nếu font máy khác rộng hơn. Không cần hạ `#org-select` xuống 160 px.
3. **Tự mở rộng không ghi nhớ:** chạy lỗi validate thì thanh mở rộng, nhưng `sfdg.issuesCollapsed` giữ nguyên lựa chọn của
   người dùng (tải lại thì vẫn thu gọn). Chỉ bấm `Thu gọn` / `Hiện (n)` mới ghi.
4. **Chạm lại thẻ đang chọn mở lại sheet** (doc chưa nói): sau khi chạy đóng sheet hoặc bấm `‹ Xong`, chạm thẻ đó là sửa
   tiếp được (trước đây phải chọn bước khác rồi chọn lại). `goToIssue` cũng mở lại sheet (cả khi bấm nhóm lỗi insert).
5. **`scroll-padding-bottom` đo được, không phải `var(--sheet-h)`** (sửa sau review, S2): đệm của doc tính từ đáy canvas,
   mà canvas kết thúc trên đầu panel kết quả và thanh lỗi, nên thẻ dừng cao hơn mép sheet, và ở điện thoại có lỗi thì thẻ
   bị đẩy nửa dưới palette. Nay `inspector.js` đo `--sheet-overlap` = đáy canvas − đỉnh sheet (lúc mở sheet, khi đổi kích
   thước, khi canvas đổi cao) và dùng cho cả `scroll-padding-bottom` lẫn phần đệm cuối; thẻ nằm trọn giữa palette và sheet.
6. **Hàng `‹ Xong`** là `.sheet-head` (dính, nền `surface`, đường `border` dưới) bọc nút `.sheet-close` cũ, để phần cuộn không
   lộ ra hai bên nút.
7. **Hàng tab** cuộn ngang với thanh cuộn ẩn (`scrollbar-width: none`): thanh cuộn ngang sẽ ăn vào chiều cao cố định
   `--tabs-h` mà đầu bảng dính dựa vào. Cuộn bằng trackpad / Shift+lăn / chạm.
8. **`issues.js` chỉ import `dom.js`** (bước của thẻ và tên alias do `main.js` truyền vào), nên `test/issues.test.js` nạp được
   module trong Node. Thêm `issueCountParts` (số đếm kèm mức để vẽ icon ⊗ / ▲).
9. **Menu ⋯:** nút mở/đóng theo `aria-expanded`; bấm lại ⋯ thì đóng. Hàng Seed là `.popup-field` (input phản chiếu `#seed`,
   phát sự kiện `input` nên chip cập nhật); "📌 giữ seed" cũng phát `input`. Lúc chạy, nút `⤓ Tải` ẩn cùng hai nút tải (Dừng
   thay chỗ, 0004).
10. **Test token:** `css-tokens.test.js` thêm một test kiểm `--canvas-tail` 64 px, `--issues-max-h`, `--sheet-h`, `--ico-theme`
    có trong CSS và có trong bảng của `ui-design-system.md`. `scroll-padding-bottom`, `top`, `inset` không thuộc luật khoảng
    cách 4 px; mọi `padding`/`margin`/`gap` mới dùng token (kể cả `calc(-1 * var(--space-3))` của `.sheet-head`).
11. **Nhỏ:** ↶ / ↷ / ⟳ / ⋯ có `aria-label`; `#btn-results-toggle` có `aria-controls="results-body"`.

**Smoke:** luồng 13 (13a–13e) như kế hoạch, với `getBoundingClientRect`; luồng 11 chạy chung trang với 13. Thử làm hỏng
có chủ đích (`.issues { position: absolute }`) thì 13a báo đúng như số đo ban đầu: 1280 che `task`, 1024 che `opp`, `task`.
Đồng thời smoke được tăng tốc: sáu nhóm luồng độc lập chạy song song, mỗi nhóm một browser context; trình duyệt khởi động
cùng lúc với server; bỏ `localStorage.clear()` + tải lại (context mới đã trống), `addInitScript` cho dữ liệu cần trước lần
tải đầu, đổi kích thước một trang thay vì mở context mỗi chiều rộng, chờ hiệu ứng bằng `document.getAnimations()` thay vì
`waitForTimeout`. Thời gian từ ~10 s xuống ~5,3–5,5 s (trần 12 s giữ nguyên). Ảnh: `smoke-1280-issues.png`,
`smoke-390-topbar.png`, `smoke-390-sheet.png`.

**Test:** thêm `test/issues.test.js` (4: nhãn `2 lỗi · 1 cảnh báo` / `2 lỗi` / `1 cảnh báo`, F8 và Shift+F8 vòng lại, danh sách
đổi / rỗng) và 1 test token trong `test/css-tokens.test.js`. **Không sửa test cũ nào.** Tổng **229** test, đều qua.

**Chưa làm / để sau:** như "Câu hỏi mở" (kéo đổi chiều cao panel / sheet hai nấc, dấu hiệu "còn mục" ở palette ngang, icon
SVG cho các ký tự `⋯ ▸ ▾ ⠿ ↶ ↷ ⟳ ⤓`).

### Sửa sau review (2026-10-28)

Mỗi mục có bước smoke **đỏ khi bỏ phần sửa** (đã thử bằng cách đảo từng phần sửa rồi chạy smoke), trừ S3/S4b là sửa ở
chính smoke.

1. **(B1) Gõ phím sửa form ẩn sau khi sheet đóng.** Ctrl+Enter trong một ô của sheet (hoặc "‹ Xong" bằng bàn phím) đóng sheet
   nhưng focus ở lại ô alias, gõ tiếp là đổi alias mà không thấy. `setSheetOpen(false)`: focus đang trong sheet chuyển về
   thẻ đang chọn (không có thì Xem trước); sheet đóng ở màn hình hẹp là `inert` (tính lại khi qua mốc 900 px). Smoke 13d:
   "‹ Xong" bằng phím ⇒ đóng, inert, focus ở thẻ `con`; Ctrl+Enter trong ô alias rồi gõ "ZZ" ⇒ alias không đổi.
2. **(S1) Màn hình thấp: thanh lỗi tràn dưới đầu panel kết quả**, ở 844 × 390 chỉ còn ~68 px canvas. `.issues { flex: 0 1
   auto; max-height: 25%; min-height: <đầu thanh> }`, danh sách `min-height: 0`. Ở 844 × 390 thêm: ẩn hàng "Thu gọn/Mở tất
   cả" khi ≤ 900 px và cao ≤ 500 px (hai mục vào menu ⋯, nhóm Khung), để sheet chừa ≥ 60 px canvas (trước đó chỉ 28 px:
   một thẻ 44 px không vừa). Câu "canvas không bao giờ thấp hơn 75 %" (doc này §Trường hợp biên, `ui-design-system.md`)
   sửa thành đảm bảo thật. Smoke 13a thêm 844 × 390 (≤ 25 % cột giữa, không dưới đầu panel); 13d kiểm 60 px và mục menu.
3. **(S2) Điện thoại có lỗi: tới một lỗi thì thẻ nằm nửa dưới palette.** Xem chỗ khác thiết kế 5 (`--sheet-overlap`). Smoke:
   chạm dòng lỗi ở 390 × 844 (`task`) và 844 × 390 (`opp`) ⇒ thẻ nằm trọn giữa palette và sheet.
4. **(S3) Smoke để lại server khi bị Ctrl+C/kill, và có thể thử nhầm server cũ khi trùng cổng.** Server chạy ngay trong
   tiến trình smoke (`createApp` + `allowedHostsFor`, cổng 0), sf CLI là stub trả 503 (smoke kiểm thông báo `smoke:` lúc đầu),
   nên không thể chạm org thật; đóng server trước `browser.close()`.
5. **(S4a) Phản hồi `/api/validate` cũ ghi đè lỗi mới** (và là nguyên nhân smoke đỏ "no warning on the Query card" khi máy
   bận). `validateNow` đánh số mỗi lần gọi, chỉ nhận phản hồi mới nhất; `acceptResult`/`runFailed` cũng tăng số. Thêm: cảnh
   báo chỉ lần chạy biết (Query dùng bản ghi mẫu vì chưa chọn org) được giữ khi validate lại **đúng workflow đã chạy**
   (trước đây lần validate kế tiếp xóa nó), và nếu workflow đổi trong lúc chạy thì validate lại. Smoke 5c: giữ phản hồi
   validate đầu tiên tới sau bản xem trước ⇒ cảnh báo còn; sửa tên rồi đặt lại ⇒ cảnh báo còn.
6. **(S4b) Kiểm tra Dừng dựa vào trễ cố định 200 ms.** Request `/api/run` và thân phản hồi giờ bị giữ bằng promise, chỉ thả
   sau khi bấm Dừng. Chạy dưới tải (2 tiến trình `for(;;){}` chiếm CPU): **6/6 lần `SMOKE OK`, 6,9–8,1 s** (trước khi sửa:
   2/6 OK, lỗi "no warning on the Query card" / cảnh báo bị phản hồi cũ xóa). Không tải: 5 lần liên tiếp 5,0–5,8 s.
7. **(S5) Số đếm `aria-live` đọc lại sau mỗi lần validate.** Chỉ viết lại khi nhãn đổi. Smoke 13a: sửa tên workflow (nhãn vẫn
   `2 lỗi · 1 cảnh báo`) ⇒ 0 thay đổi DOM ở `#issues-count`.
8. **(S6) Tab / Shift+Tab trong popup ném focus ra hai đầu trang.** Tab đóng popup và trả focus về nút mở. Smoke 13c.
9. **(N1) ARIA của popup:** `role="menu"` chỉ chứa hàng menu và `role="group"` có `aria-label` cho mỗi nhóm; tiêu đề popup và
   tiêu đề nhóm `aria-hidden`; ô Seed (và ô tìm của menu "+") nằm trong group. Smoke 13c kiểm không có chữ/ô nhập nào nằm
   trực tiếp trong menu.
10. **(N2)** Menu ⋯ mở từ chip `Seed n` neo vào chip: Esc / Tab trả focus về chip. Smoke 13c.
11. **(N3)** Smoke 13d so bảng kết quả với **đỉnh sheet** (không chỉ đáy màn hình).
12. **(N4)** Smoke 13a kiểm tên app ẩn đúng khi < 1 300 px (ở 844, 1024, 1280; hiện ở 1440).
13. **(N5)** `setSheetOpen` chỉ mở sheet ở màn hình hẹp; qua mốc 900 px thì sheet đóng (không tự bật khi thu hẹp cửa sổ).
    Smoke 13a: chọn bước ở 1440 rồi thu về 800 px ⇒ sheet không mở, inert; về 1440 ⇒ hết inert.

Tổng sau sửa: **229** test (`npm test`), đều qua; không thêm test đơn vị (mọi sửa là hành vi giao diện, có bước smoke).
Smoke `SMOKE OK` 5 lần liên tiếp không tải.
