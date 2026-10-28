# 0014 — Hoàn thiện giao diện: icon SVG, đổi cao panel kết quả, sheet hai nấc, dấu hiệu cuộn ngang, minimap, phím chọn biến trên macOS

- **Trạng thái:** Đã duyệt (2026-10-28; người dùng giao chốt theo phương án đề xuất, xem [Đã chốt](#đã-chốt))
- **Ngày:** 2026-10-28
- **Liên quan:** [0008](0008-ui-design-system.md) (token, icon mask, trạng thái; để lại việc đổi ký tự thành SVG),
  [0009](0009-bo-cuc-man-hinh.md) (thanh lỗi, bottom sheet, đầu panel kết quả; "Câu hỏi mở" chuyển sang doc này),
  [0003](0003-process-mode.md) đợt B (chế độ Sơ đồ; "Chưa làm: minimap"), [0005](0005-variable-picker.md) (bảng chọn biến,
  Ctrl+Space), [0011](0011-thao-tac-du-lieu-org.md) và [0012](0012-nang-suat-soan-thao.md) (thêm nút/tab mới: phải theo quy tắc
  icon ở đây), tài liệu tham chiếu [../ui-design-system.md](../ui-design-system.md)

## Vấn đề

Sau 0008 và 0009, màu và bố cục đã ổn, nhưng người dùng vẫn gặp sáu chuyện nhỏ mà cộng lại thì app trông "chưa xong".
Đo bằng Chromium headless, theme sáng và tối, 1440 × 900 và 390 × 844, `/api/orgs` giả lập, không gọi org thật. Ảnh và script
nằm trong thư mục tạm của phiên thiết kế (không commit):
`/tmp/claude-0/-home-user-sf-data-generator/fa9ad77c-1d8e-553a-9b3f-45d89b2dd244/scratchpad/0014/` (`before/*.png`,
`after/*.png`, `shots.cjs`, `mock.cjs`, `contrast.mjs`, `icons.cjs`, `laydims.mjs`).

1. **Icon bằng ký tự: mỗi cái một cỡ, một nét, và có cái không có tên.** Đo bề rộng ký tự trong nút ở 14 px
   (`before/light-1440-preview.png`, `before/light-card-glyphs.png`, `before/light-inspector-glyphs.png`):

   | Ký tự | Chỗ | Rộng × cao (px) | Tên trình đọc màn hình đọc lên |
   | --- | --- | --- | --- |
   | `↶` `↷` | Hoàn tác / Làm lại | 11,7 × 17 | "Hoàn tác" / "Làm lại" (có `aria-label`) |
   | `⟳` | Tải lại danh sách org | 10,9 × 16 | có `aria-label` |
   | `⋯` | Menu bước | 14 × 17 | có `aria-label` |
   | `▸` | Hiện các field | **7** × 17 | có `aria-label` |
   | `⠿` | Tay nắm kéo | 10,3 × 17 (chữ nổi Braille) | ẩn (`aria-hidden`) |
   | `⊘` / `◉` | Tắt / bật bước (inspector) | **19,5** × 17 | **"⊘"** (không có `aria-label`) |
   | `⧉` | Nhân bản (inspector) | 10 × 17 | **"⧉"** |
   | `✕` | Xóa bước (inspector), xóa field | 11,7 × 17 | **"✕"** |
   | `⚙` `↑` `↓` | Tùy chọn / Lên / Xuống field | khác nhau theo font | **"⚙"**, "↑", "↓" |

   Cỡ thật dao động 7–19,5 px trong cùng một hàng nút; `▶` của "Xem trước" là tam giác đặc to, `⤒` của "Insert vào org"
   bé gần như không thấy; nét đậm nhạt theo font từng máy (Segoe UI Symbol, Apple Symbols, DejaVu). Ba nút ở đầu inspector
   và bốn nút của mỗi field card **đọc lên bằng tên ký tự** ("circled division slash"), vì chỉ có `title`. Các ký tự này
   0008 và 0009 đều để lại.
2. **Panel kết quả cao cố định 38vh.** Ở 1440 × 900 panel cao 342 px, canvas còn 471 px; bảng Account 5 dòng chỉ cần
   khoảng 250 px, nên gần 100 px trống trong khi thẻ `con` sát mép dưới canvas (`before/light-1440-preview.png`). Ngược
   lại, xem 200 dòng Contact thì 342 px chỉ đủ 8 dòng. Ở 390 × 844 panel cao 321 px, gần nửa phần dưới thanh trên.
3. **Bottom sheet một nấc 60 %.** Ở 390 × 844 sheet cao 506 px; field card dài (Record 6 field, mở tùy chọn) phải cuộn
   trong một ô 450 px, trong khi phía trên vẫn còn palette và canvas mà lúc đó người dùng không cần
   (`before/light-390-sheet.png`).
4. **Hàng cuộn ngang không cho biết còn mục.** Ở 390 px: palette rộng 628 px trong khung 390 px, tóm tắt kết quả 606 px
   trong 218 px (`before/light-390-preview.png`). Chip `📌 giữ seed` và số ms nằm ngoài màn hình, không có dấu hiệu gì;
   palette chỉ tình cờ cắt ngang chữ "Chọn bản g" ở 390 px, ở chiều rộng khác có thể cắt đúng giữa hai mục. Hàng tab ẩn
   thanh cuộn (0009, để giữ `--tabs-h`), nên khi nhiều sObject thì tab cuối biến mất mà không có dấu hiệu; chuột không có
   cuộn ngang thì không tới được.
5. **Sơ đồ lớn không có định hướng.** Workflow 600 bước (150 Lặp, mỗi Lặp có Record và Rẽ nhánh): ở 100 % chỉ thấy 3 thẻ,
   không biết đang ở đâu trong sơ đồ; nút `⤢` đưa về 10 % (mức nhỏ nhất) mà sơ đồ **vẫn không vừa** và trông như một dải xám
   (`before/light-1440-canvas-100.png`, `before/light-1440-canvas-fit.png`). Đo bằng `layout()`: sơ đồ chạy từ trái sang
   phải nên rất dẹt, 40 bước đã rộng 10 000–11 700 px × 156–298 px (tỉ lệ 39–72 : 1), 1 000 bước rộng 270 000–284 000 px
   (tỉ lệ tới 1 733 : 1) (`laydims.mjs`). Minimap "thu cả sơ đồ vào một ô" không dùng được: ô 240 px thì thẻ còn 0,2 px.
6. **Ctrl+Space không mở được bảng chọn biến trên macOS.** macOS dùng Ctrl+Space để đổi bộ gõ (mặc định khi có từ hai
   nguồn nhập, tức là hầu hết máy gõ tiếng Việt Telex/VNI), nên phím không tới trình duyệt. `{x}` vẫn bấm được, và ô Mẫu
   vẫn có `{{`, nhưng ô đường dẫn (Rẽ nhánh "Giá trị", Lặp `from`) và người dùng chỉ dùng bàn phím thì không có phím nào
   thay thế. Phần "Phím tắt" ở inspector cũng không nhắc phím này.

Ngoài năm việc được giao, đo được thêm một lỗi cùng loại (hiển thị): **ở 390 px thẻ Query tràn 62 px** sau khi xem trước
không chọn org (chip `5 bản ghi mẫu` + badge `▲ 1` + tag `chưa chọn org`), đẩy nút `⋯` ra ngoài màn hình (`scrollWidth`
431 > `clientWidth` 369, `before/light-390-preview.png`). Doc này sửa luôn (mục 7), vì nó cùng hàng nút và cùng smoke.

## Mục tiêu / Ngoài phạm vi

- Mục tiêu:
  - Mọi icon là SVG mask cùng hệ (lưới 24, nét 2 px, đầu tròn), cùng cỡ theo ngữ cảnh (12 / 14 / 16 px), lấy màu
    `currentColor` nên đúng ở cả hai theme. Mọi nút chỉ có icon đều có tên đọc được bằng chữ (`aria-label`). Không còn
    ký tự dùng làm icon trong `client/` (có test chặn).
  - Panel kết quả đổi cao được bằng chuột, chạm và bàn phím; nhớ chiều cao; không bao giờ phá đảm bảo của 0009 (thanh
    lỗi ≤ 25 % cột giữa, thẻ đang chọn không bị che).
  - Bottom sheet hai nấc (vừa ≈ 60 %, cao ≈ 90 %) ở màn hình hẹp, đổi bằng kéo, chạm hoặc phím; luôn mở ở nấc vừa để thẻ
    đang sửa vẫn thấy.
  - Hàng cuộn ngang (palette hẹp, tóm tắt kết quả, hàng tab) cho thấy còn mục ở phía nào, và cuộn được bằng con lăn chuột.
  - Sơ đồ có minimap: biết đang ở đâu, bấm/kéo để tới chỗ khác, chạy mượt với 1 000+ bước, không che thẻ đang chọn.
  - Bảng chọn biến có phím mở chạy được trên macOS, hiện đúng trong tooltip và danh sách phím tắt.
- Ngoài phạm vi:
  - Màu mới, loại bước mới, đổi bố cục ba cột hay thanh trên (0009 giữ nguyên).
  - Đổi nhãn `Ctrl+…` sang `⌘` trên macOS: các phím đó đã nhận cả Cmd lẫn Ctrl (`main.js`: `e.ctrlKey || e.metaKey`), nên
    nhãn "Ctrl" vẫn đúng. Chỉ Ctrl+Space là hỏng.
  - Kéo thẻ trên Sơ đồ, nhớ pan/zoom (0003 đợt B để lại).
  - Workflow JSON, server, `/api/meta`: không đổi.

## Luồng người dùng

**Luồng A — xem 200 dòng Contact trên laptop 1440 × 900.**

1. Ctrl+Enter. Panel kết quả mở ở chiều cao lần trước (lần đầu: 38 % màn hình như hiện nay). (1)
2. Rê chuột lên mép trên panel: con trỏ thành `row-resize`, tay nắm đậm lên. Kéo lên tới khi thấy đủ dòng. (1)
3. Tải lại trang hôm sau: panel mở lại đúng chiều cao đó. (0)

Bằng bàn phím: Tab tới tay nắm (ngay trước nút `Kết quả`), ↑ mỗi lần cao thêm 16 px, Shift+↑ 64 px, End cao nhất, Home
thấp nhất, Enter thu gọn / mở lại. (1 + số lần nhấn)

**Luồng B — sửa Record nhiều field trên điện thoại 390 × 844.**

1. Chạm thẻ `con`. Sheet mở ở nấc vừa (như hiện nay), thẻ `con` nằm ngay trên mép sheet. (1)
2. Vuốt tay nắm ở đầu sheet lên (hoặc chạm nó): sheet lên nấc cao, chỉ chừa thanh trên (Xem trước, Insert vẫn bấm được).
   Sửa field. (1)
3. Chạm **Xem trước**: sheet đóng như 0009, panel kết quả hiện. (1)

Tổng 3 thao tác cho việc trước đây phải cuộn nhiều lần trong ô 450 px. Vuốt xuống từ nấc cao về nấc vừa (thẻ `con` lại
hiện ngay trên mép sheet); vuốt tiếp xuống quá nửa nấc vừa thì đóng như `Xong`.

**Luồng C — tìm chip "giữ seed" trên điện thoại.** Sau Xem trước, mép phải dòng tóm tắt mờ dần: biết còn nội dung. Vuốt
ngang (hoặc lăn chuột trên máy có màn hình hẹp): thấy `giữ seed`; mép trái giờ mờ, mép phải hết mờ. (1)

**Luồng D — đi trong sơ đồ 1 000 bước.**

1. Nhấn M sang Sơ đồ. Góc dưới phải có minimap: một dải các khối màu theo loại bước, khung xanh là phần đang thấy, thanh
   mảnh bên dưới cho biết vị trí trong cả sơ đồ. (1)
2. Bấm vào thanh mảnh ở khoảng 3/4: khung nhìn nhảy tới đó (giữ mức thu phóng). Bấm vào một khối trên minimap: khung nhìn
   căn giữa chỗ đó. Kéo trên minimap: khung nhìn đi theo con trỏ. (1)
3. Thẻ có lỗi hiện viền đỏ trên minimap; bấm vào đó rồi bấm thẻ để chọn. (2)

Không muốn minimap: bấm nút minimap trên thanh thu phóng (nhớ lựa chọn). Bàn phím không cần minimap: ↑/↓, Home/End đi
khắp cây và tự pan, `0` vừa khung (như 0003).

**Luồng E — chèn biến trên MacBook gõ Telex.** Trong ô Mẫu của field Title: ⌥↓ (Option + mũi tên xuống) mở bảng chọn
biến với ô tìm; gõ `indu`, Enter chèn `{{acc.Industry}}`. (2) Tooltip của nút `{x}` ghi `Chèn biến (gõ {{ hoặc ⌥↓)`; danh
sách "Phím tắt" có dòng tương ứng.

**Trường hợp biên:**

- *Màn hình thấp (844 × 390, điện thoại xoay ngang):* không còn chỗ để đổi cao panel kết quả (khoảng đổi < 24 px), nên tay
  nắm ẩn, panel giữ chiều cao hiện nay. Sheet hai nấc vẫn có: vừa 190 px, cao 301 px (390 − thanh trên 89 px).
- *Cửa sổ thu nhỏ sau khi đã kéo panel cao:* chiều cao lưu dạng tỉ lệ, rồi kẹp lại theo giới hạn mới; cột giữa không bao
  giờ thấp hơn `min(240 px, 50 %)`.
- *Đang chạy (0004):* tay nắm vẫn dùng được; thanh tiến độ 3 px ở mép dưới đầu panel không đổi chỗ.
- *Sheet đang ở nấc cao và người dùng nhấn F8 (0009):* bước lỗi được chọn, sheet **về nấc vừa** để thấy thẻ lỗi ngay trên
  mép sheet.
- *Sơ đồ nhỏ, thấy trọn trong khung nhìn:* minimap tự ẩn (không có gì để định hướng); thu phóng lên tới khi sơ đồ tràn
  khung thì minimap hiện lại (mờ dần 200 ms, tắt khi giảm chuyển động).
- *Chế độ chọn nhiều của 0012 (`body.select-mode`, thanh `.select-bar` thay sheet):* sheet đóng, nên không có nấc; minimap
  vẫn theo quy tắc "ẩn khi sheet mở" (thanh chọn nằm ở đáy màn hình, không chồng lên minimap ở ≥ 721 px vì ở đó không
  có thanh chọn).

## Thiết kế UI

### 1. Icon SVG thay ký tự

**Hệ icon.** Giữ nguyên cơ chế của 0008: mỗi icon là custom property `--ico-<tên>` (data URI SVG, lưới 24 × 24, `fill:
none`, nét 2 px, `stroke-linecap/linejoin: round`) trong khối token; phần tử `.ico` vẽ bằng `mask` nên có màu
`currentColor`. Thêm:

- **Thuộc tính `data-ico="<tên>"`** chọn icon: một luật `.ico[data-ico="<tên>"] { --ico: var(--ico-<tên>); }` mỗi icon, viết
  cho **mọi** icon (cả icon cũ `error`, `warning`, `info`, `off`, …). Lý do (bắt được trong mockup): `.ico` không có
  `data-ico` khớp sẽ lấy `--ico` **kế thừa** từ `[data-type]` gần nhất, nên nút "Tắt bước" trong inspector của Record vẽ
  ra icon Record. Không dùng `style="--ico: …"` (index.html cấm style nội tuyến).
- **Hàm `ico(name)`** trong `client/js/dom.js`: trả `<span class="ico" data-ico="name" aria-hidden="true">`. Mọi nơi trong JS
  dùng hàm này; `index.html` viết thẳng thẻ `<span>` đó.
- **Cỡ:** `--icon-xs` 12 px (cạnh chữ 12 px: chip, nhãn làn), `--icon-sm` 14 px (cạnh chữ 13 px: link, nhãn cột, số đếm
  thanh lỗi), `--icon-md` 16 px (trong nút, mặc định của `.ico`). Ô icon loại bước giữ 15 px trong ô 24 px (§6.1 của
  hệ thống). Icon cũ dùng cỡ lẻ chuyển về thang: badge 13 → 12 px, dòng lỗi 15 → 16 px.
- **Khoảng cách icon–chữ:** `--space-1` (nút đã có `gap: var(--space-1)`).

**Bảng thay thế** (24 icon mới; hình vẽ ghi bằng lệnh SVG để người làm mã hóa giống các icon cũ; ảnh:
`after/light-topbar-icons.png`, `after/light-card-icons.png`, `after/light-inspector-icons.png`):

| Ký tự cũ | Icon (`data-ico`) | Hình (SVG, lưới 24) | Ở đâu | Tên đọc lên sau khi đổi |
| --- | --- | --- | --- | --- |
| `⋯` | `more` | 3 chấm `circle r=1` tại x 5/12/19, y 12 | `#btn-more`, `.menu-btn` (Quy trình, Sơ đồ) | không đổi (`aria-label` sẵn có) |
| `▸` / `▾` | `chevron-right` / `chevron-down` | `M9 6l6 6-6 6` / `M6 9l6 6 6-6` | `.toggle` trên thẻ (khung, chi tiết field) | không đổi (`aria-label` sẵn có) |
| `▴` / `▾` | `chevron-up` / `chevron-down` | `M6 15l6-6 6 6` | `.caret` của nút `Kết quả`; nút "Ẩn tùy chọn" của field | "Kết quả" + `aria-expanded` (không đổi) |
| `‹` | `chevron-left` | `M15 6l-6 6 6 6` | `.sheet-close` "‹ Xong" | "Xong" |
| `⠿` | `grip` | 6 chấm `r=1` tại (9/15, 6/12/18) | `.handle` (đã `aria-hidden`) | — |
| `↶` / `↷` | `undo` / `redo` | `M9 14L4 9l5-5` + `M4 9h10.5a5.5 5.5 0 0 1 0 11H11` (redo đối xứng) | thanh trên | không đổi |
| `⟳` | `refresh` | `M21 12a9 9 0 1 1-2.64-6.36L21 8` + `M21 3v5h-5` | `#btn-orgs`, link "⟳ Đọc lại", chữ trong hộp xác nhận Insert | `#btn-orgs` không đổi; link: "Đọc lại" |
| `⤓` | `download` | `M12 3v12` + `M7 10l5 5 5-5` + `M5 21h14` | `#btn-dl-menu` "⤓ Tải"; link `⤓ Id` của 0011 | "Tải" |
| `⤒` | `insert` | `M5 3h14` + `M12 21V9` + `M7 14l5-5 5 5` | `#btn-insert` | "Insert vào org" (không đổi phần chữ) |
| `▶` | `run` | `M7 4.5v15l12-7.5z`, **tô đặc** (`fill='black'`) | `#btn-preview` | "Xem trước" |
| `⤢` | `fit` | `M15 3h6v6` + `M9 21H3v-6` + `M21 3l-7 7` + `M3 21l7-7` | `#btn-zoom-fit` | không đổi |
| `+` / `−` | `plus` / `minus` | `M12 5v14M5 12h14` / `M5 12h14` | `.add-btn`, `#btn-zoom-in/out` | không đổi |
| `✕` (field) | `x` | `M18 6L6 18M6 6l12 12` | nút "Xóa field" | **thêm** `aria-label="Xóa field"` |
| `✕` (đầu inspector) | `trash` | `M4 7h16` + `M10 11v6M14 11v6` + `M6 7l1 13h10l1-13` + `M9 7V4h6v3` | nút xóa bước | **thêm** `aria-label="Xóa bước"` (`title` giữ "Xóa (Delete)") |
| `⊘` / `◉` | `off` (icon có sẵn, cả hai trạng thái) | — | nút tắt/bật bước | **thêm** `aria-label` = "Tắt bước" / "Bật bước" |
| `⧉` | `duplicate` | `rect 8,8 12×12 rx2` + `M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2` | nút nhân bản | **thêm** `aria-label="Nhân bản"` |
| `⚙` | `options` | ba thanh trượt: `M4 6h9M19 6h1M4 12h3M13 12h7M4 18h11` + `circle` r 2,5 tại (16,6), (10,12), (18,18) | "Tùy chọn" của field | **thêm** `aria-label="Tùy chọn"` |
| `↑` / `↓` (field) | `arrow-up` / `arrow-down` | `M12 19V5` + `M6 11l6-6 6 6` (xuống đối xứng) | Lên / Xuống của field | **thêm** `aria-label` "Lên" / "Xuống" |
| `📌` | `pin` | `M12 16v5` + `M9 3h6l-1 6 3 3v2H7v-2l3-3z` | link "giữ seed" | "giữ seed" |
| `✓` | `check` | `M5 12.5l4.5 4.5L19 7` | dấu chọn của hàng menu chọn một (`.pi-check`); nhãn cột/làn "Đúng" | hàng menu: `aria-checked` (không đổi); nhãn: "Đúng" |
| `✗` | `x` | như trên | nhãn cột/làn "Sai" | "Sai" |
| `ⓘ` | `info` (có sẵn) | — | hộp `.info-box` "Chưa chọn org…" | chữ của hộp |
| `✕` (ô Id trong bảng kết quả) | `error` (có sẵn, ⊗) | — | `results.js`, ô Id của bản ghi insert lỗi | thêm chữ ẩn `lỗi` (`.sr-only`) |
| — | `minimap` | `rect 3,5 18×14 rx2` + `rect 11,11 6×5 rx1` | nút bật/tắt minimap (mục 5) | "Bản đồ thu nhỏ" |

**Giữ là chữ** (không phải icon, nên không đổi): mũi tên trong câu chữ và tên phím (`↑ / ↓: chọn bước…`, `Alt+↑`,
`↑↓ chọn · Enter chèn` ở chân bảng chọn biến), mũi tên tham chiếu trong bảng (`→ acc#1`), chữ `↓` trong tên tab Query
(`↓ accs · Account (5)`, nghĩa là "đọc vào", và tab đã có icon Query) và trong tóm tắt `↓ đọc từ dev`, `≤`, `·`, `…`, `{x}` (cú
pháp), `−` / `+` khi là tên phím, và `＋` trong `<option>` của ô Lookup (`<option>` không chứa được SVG).

**Nút có chữ:** icon đứng trước chữ, `aria-hidden`, nên tên đọc lên chỉ còn chữ ("Xem trước", không còn "black
right-pointing triangle Xem trước"). Mọi chuỗi trong JS nhắc tới ký tự cũ đổi theo: `Bấm ▶ Xem trước (Ctrl+Enter)` →
`Bấm Xem trước (Ctrl+Enter)` (inspector, bảng chọn biến), `bấm ⟳ Đọc lại rồi Insert` → `bấm Đọc lại rồi Insert` (hộp xác nhận
Insert, `main.js`; smoke dòng 579 đổi theo).

**Trạng thái icon** (icon không có trạng thái riêng, theo nút chứa nó):

| Trạng thái | Quy tắc |
| --- | --- |
| Mặc định | Màu chữ của nút: `text` (nút phụ, ghost thanh trên), `text-muted` (ghost trên thẻ, view tools, field card), `accent-contrast` (nút chính), `danger-text` (nút nguy hiểm) |
| Hover / nhấn | Như nút (§6.2); ghost trên thẻ đổi `text-muted` → `text` |
| Focus | Vòng focus của nút; icon không đổi |
| Vô hiệu | `text-disabled` (như chữ) |
| Đang mở / đang chọn | Không đổi màu icon; trạng thái nằm ở hình (`chevron-down` khi mở, `chevron-right`/`chevron-up` khi đóng) và `aria-expanded` / `aria-pressed` |

Icon `run` tô đặc để khác icon `start` (nét viền) của thẻ Bắt đầu: hai nghĩa gần nhau ("bắt đầu" / "chạy"), nhưng nút chạy
luôn có chữ "Xem trước" và nằm ở thanh trên, không lẫn với ô icon loại bước.

### 2. Đổi chiều cao panel kết quả

```
┌ cột giữa (canvas) ──────────────────────────────────────────┐
│ …                                                            │
├───────────────────────────── ▬▬▬ ───────────────────────────┤ ← tay nắm (vùng bấm 8 px quanh mép; chạm: hàng 24 px)
│ Kết quả ⌄  [Account: 5] [Contact: 12] 17 bản ghi · seed …  📌 giữ seed     [Tải JSON] [Tải CSV (tab hiện tại)] │
│ Account (5)   Contact (12)                                                 │
```

| Phần | Quy tắc |
| --- | --- |
| Phần tử | `<div class="results-resize" role="separator" aria-orientation="horizontal" aria-controls="results-body" aria-label="Chiều cao panel kết quả" tabindex="0">`, phần tử đầu tiên trong `#results`. Ẩn (`hidden`) khi panel thu gọn, và khi khoảng đổi (max − min) < 24 px |
| Vùng bấm, chuột (`pointer: fine`) | `position: absolute`, cao `--resize-hit` 8 px, nằm giữa mép trên panel (−4 … +4 px), `cursor: row-resize`, `z-index: 1`. Không đẩy nội dung |
| Vùng bấm, chạm (`pointer: coarse`) | Hàng trong luồng cao `--resize-hit-touch` 24 px ở đầu panel; `.results-head` bỏ padding trên (đầu panel 48 → 64 px khi mở; khi thu gọn không có hàng này). Vì sao không phủ lên: ở điện thoại vùng 24 px phủ lên sẽ chồng nút `Kết quả` và dòng lỗi cuối của thanh lỗi |
| Hình tay nắm | Viên thuốc `--grip-w` × `--grip-h` = 32 × 4 px, bo `--radius-pill`, giữa theo chiều ngang |
| Chiều cao | `#results` cao `var(--results-h, 38vh)`; JS đặt `--results-h` (px) trên `#results`. Tối thiểu `--results-min-h` 160 px (đầu panel 48 + hàng tab 37 + đầu bảng + 2 dòng). Tối đa = tổng chiều cao dưới thanh trên − `min(--layout-min-h 240 px, 50 % của nó)`, tức là vùng `main` (palette hẹp + cột giữa) luôn còn ít nhất chừng đó. Mặc định 38 % như hiện nay |
| Kéo | Pointer events (chuột, chạm, bút) với `setPointerCapture`; chiều cao đi theo con trỏ, kẹp trong [min, max], cập nhật một lần mỗi khung hình. `body.resizing` (con trỏ `row-resize` toàn trang, `user-select: none`). Thả khi đã kéo xuống **quá min 48 px** thì panel thu gọn (như bấm `Kết quả`), chiều cao đã lưu giữ nguyên |
| Nhấp đúp | Về mặc định 38 % |
| Bàn phím | ↑ / ↓: cao / thấp thêm 16 px; Shift+↑ / Shift+↓: 64 px; Home: thấp nhất; End: cao nhất; Enter: thu gọn / mở lại (như nút `Kết quả`; focus về nút `Kết quả` khi thu gọn vì tay nắm ẩn) |
| ARIA giá trị | `aria-valuemin` / `aria-valuemax` / `aria-valuenow` = phần trăm của tổng chiều cao dưới thanh trên (làm tròn), `aria-valuetext` = `Cao 312 px (37 % màn hình)` |
| Nhớ | `localStorage['sfdg.resultsH']` = tỉ lệ (0–1, 3 chữ số), ghi khi thả / sau phím (bọc `try/catch` như `sfdg.theme`). Tải lại, đổi kích thước cửa sổ: tính lại px từ tỉ lệ rồi kẹp. Không vào undo |
| Thẻ đang chọn | Quy trình: nếu trước khi kéo thẻ đang chọn thấy trọn, sau khi thả gọi `reveal(sel, { block: 'nearest', focus: false })` (Sơ đồ đã tự làm qua `ResizeObserver`, 0003) |
| Thanh lỗi (0009) | Không đổi luật: thanh lỗi ≤ 25 % cột giữa, tối thiểu bằng đầu thanh. Với cột giữa ≥ 240 px (desktop) thanh lỗi ≤ 60 px, canvas còn ≥ 144 px (≥ 1 thẻ + đường nối), đúng điều kiện "≥ ~132 px" của 0009 |
| Sheet (≤ 900 px) | `--sheet-overlap` đã được đo lại khi canvas đổi cao (`ResizeObserver` của `inspector.js`), không cần thêm gì |

**Trạng thái tay nắm:**

| Trạng thái | Viên thuốc | Đường mép trên panel | Kênh thứ hai |
| --- | --- | --- | --- |
| Mặc định | `border-control` (3,63 / 3,76 : 1 trên `surface`) | 1 px `border` | — |
| Hover | `text-muted` | 2 px `border-strong` | con trỏ `row-resize` |
| Đang kéo | `accent` | 2 px `accent` | `body.resizing`, con trỏ toàn trang |
| Focus bàn phím | `text-muted` + vòng `focus-ring` 2 px hở 2 px quanh vùng 48 × 16 px của tay nắm | 2 px `border-strong` | — |
| Ẩn | thu gọn, hoặc khoảng đổi < 24 px | — | — |

Ảnh: `after/light-1440-preview.png` (panel kéo xuống 240 px, tay nắm hover), `after/light-1440-resize-drag.png` (đang kéo).

### 3. Bottom sheet hai nấc (≤ 900 px)

| Phần | Quy tắc |
| --- | --- |
| Nấc | **Vừa** = `--sheet-h` (như 0009: `min(60dvh, 100dvh − 200px)`). **Cao** = `--sheet-h-full: min(90dvh, calc(100dvh − var(--topbar-h)))`: sheet không bao giờ che thanh trên, nên Xem trước / Insert / Org luôn bấm được. `--topbar-h` do `main.js` đo (`ResizeObserver` trên `.topbar`, đặt trên `:root`), mặc định 89 px |
| Mở | Luôn mở ở nấc **vừa** (thẻ đang sửa nằm trên mép sheet, như 0009). Chọn bước khác trong lúc sheet mở: giữ nấc hiện tại. F8 / bấm dòng lỗi / chạy lỗi validate: về nấc vừa (để thấy thẻ lỗi) |
| Tay nắm | `<button class="sheet-grip" aria-label="Mở rộng bảng cấu hình" aria-expanded="false|true" aria-controls="inspector">` ở giữa hàng `.sheet-head` (hàng dính có nút `Xong`). Vùng bấm 64 × 44 px, viên thuốc 32 × 4 px `border-control` ở giữa. `title`: `Kéo hoặc chạm để đổi chiều cao` |
| Chạm / Enter / Space trên tay nắm | Vừa ↔ cao |
| Kéo | Bắt đầu kéo ở **bất kỳ chỗ nào của `.sheet-head`** trừ nút `Xong` (không kéo trong phần form, để cuộn form không lẫn với kéo sheet). Đi quá 8 px mới tính là kéo (dưới mức đó là chạm). Sheet đi theo ngón tay (chiều cao, không animation). Thả: vận tốc 100 ms cuối > 0,5 px/ms lên → nấc trên; xuống → nấc dưới (từ vừa xuống là đóng); chậm hơn → nấc gần nhất trong {đóng (nếu cao < ½ nấc vừa), vừa, cao} |
| Đóng bằng kéo | Như `Xong` (`closeSheet()`: giữ lựa chọn, focus về thẻ, `inert`) |
| Chuyển nấc | `transition: height var(--dur-base) var(--ease-out)`; giảm chuyển động: 0 ms |
| Ở nấc cao | Thẻ đang chọn bị che (người dùng chọn nấc này để sửa form); `--sheet-overlap` không áp dụng; về nấc vừa thì thẻ được đưa lại lên mép sheet (`reveal(…, { block: 'nearest' })`) |
| Toast | `body.sheet-open .toast { bottom: calc(<chiều cao sheet hiện tại> + --space-3) }`: dùng biến `--sheet-now` (JS đặt khi đổi nấc) |
| Rộng hơn 900 px | Không có sheet, không có tay nắm (như nay) |

Ảnh: `after/light-390-sheet-mid.png`, `after/light-390-sheet-full.png`.

### 4. Dấu hiệu "còn mục" ở hàng cuộn ngang

| Phần | Quy tắc |
| --- | --- |
| Áp dụng | `.palette` (≤ 900 px), `#results-summary` (≤ 720 px), `.tabs` (mọi chiều rộng), và mọi hàng sau này đánh dấu `data-scroll-x` (0011 hộp Lịch sử, 0012 `.select-bar` nếu cần) |
| Theo dõi | `watchOverflow(el)` trong `client/js/dom.js`: tính lại khi cuộn (passive, một lần mỗi khung hình), khi đổi kích thước (`ResizeObserver`) và khi đổi nội dung (`MutationObserver` `childList`/`characterData`, vì tóm tắt đổi liên tục lúc chạy). Đặt `data-overflow="start" | "end" | "both"`, bỏ thuộc tính khi không tràn. Ngưỡng 1 px |
| Hình | Mép phía còn mục **mờ dần** trong `--fade-w` (24 px) bằng `mask-image` (`--mask-fade-start/end/both`). Không thêm phần tử, không đổi bố cục, không đổi màu (mask chỉ làm trong suốt), đúng ở hai theme và trên mọi nền |
| Focus không nằm trong vùng mờ | `scroll-padding-inline: var(--fade-w)` trên hàng, nên Tab tới một tab/mục palette cuộn nó ra khỏi vùng mờ. Tab đang mở được `scrollIntoView({ block: 'nearest', inline: 'nearest' })` khi vẽ lại |
| Con lăn chuột | Khi hàng tràn và cú lăn chủ yếu dọc (`|deltaY| > |deltaX|`): cuộn ngang bằng `deltaY`, `preventDefault` **chỉ khi** hàng còn cuộn được theo hướng đó (tới đầu/cuối thì trả cú lăn cho trang) |
| Chạm, bàn phím | Vuốt ngang (sẵn có); Tab qua các mục (sẵn có) |
| Không có | Nút mũi tên trái/phải: thêm hai vùng bấm vào hàng vốn chật (palette 51 px, đầu panel 48 px) mà con lăn và vuốt đã làm được việc đó |

Ảnh: `after/light-390-preview.png` (palette mờ mép phải sau "Chọn bản ghi", tóm tắt mờ sau "seed").

### 5. Minimap của Sơ đồ

```
┌ khung nhìn Sơ đồ ──────────────────────────────── [− 100% + ⤢ ▣] ┐
│                                                                   │
│        thẻ…                                                       │
│                                          ┌ minimap ────────────┐ │
│                                          │ ▭▭ ▭▭ ┏━━┓▭▭ ▭▭ ▭▭  │ │ ← khối màu loại bước, khung nhìn xanh
│                                          │ ●━━━━━━━━━━━━━━━━━━ │ │ ← rãnh tổng quan (chỉ khi sơ đồ dài hơn minimap)
│                                          └─────────────────────┘ │
└───────────────────────────────────────────────────────────────────┘
```

| Phần | Quy tắc |
| --- | --- |
| Chỗ | `#dg-minimap.dg-minimap`, con của `.canvas-wrap` sau `#canvas` (cùng cấp `.dg-zoom`), góc **dưới phải** cách `--space-2`. Thanh thu phóng ở góc trên phải, nên hai lớp nổi không chồng nhau. Không `z-index` (thứ tự DOM) |
| Hộp | Nền `surface-raised`, viền 1 px `border`, bo `--radius-md`, bóng `--shadow-1`, padding `--space-1` (giống `.dg-zoom`). Rộng `--minimap-w` 240 px (721–900 px: 200 px). Cao phần bản đồ = `clamp(--minimap-min-h 32 px, cao sơ đồ × tỉ lệ, --minimap-max-h 120 px)` |
| Tỉ lệ | `s = max(min(rộng hộp / rộng sơ đồ, cao tối đa / cao sơ đồ), 0,05)`. Sơ đồ đủ nhỏ thì thấy trọn (căn giữa); dài hơn thì minimap là một **cửa sổ** rộng `rộng hộp / s` (≈ 4 640 px sơ đồ, khoảng 17 thẻ, 5 khung nhìn ở 100 %) đi theo khung nhìn (tâm cửa sổ = tâm khung nhìn, kẹp trong sơ đồ). Vì sao 0,05: thẻ 210 × 76 còn 10,5 × 3,8 px, vẫn nhận ra khối và loại; nhỏ hơn thì 1 000 bước chỉ còn một vệt (đo: 0,04 đã khó đọc, `after/light-minimap-zoom.png`) |
| Vẽ | Một `<svg aria-hidden="true">`, `viewBox` = cửa sổ (đơn vị sơ đồ), **một `<path>` cho mỗi nhóm** (không một phần tử mỗi bước): khung theo loại (`.mm-frame[data-type]`: nền `--c-subtle`, nét 1 px `--c`), thẻ theo loại (`.mm-card[data-type]`: nền `--c`), thẻ tắt (`.mm-off`: nền `--color-minimap-off`), vòng lỗi (`.mm-err`: nét 2 px `danger`, rộng hơn thẻ 1,5 px mỗi phía), thẻ đang chọn (nền `accent` trên quầng `surface-raised` 2 px), khung nhìn (`.mm-view`: chữ nhật nét 2 px `accent` trên quầng `surface-raised` 4 px). Nét dùng `vector-effect: non-scaling-stroke`. Không vẽ đường nối (ở tỉ lệ 0,05 chúng mảnh hơn 1 px). Màu qua `[data-type]` như §6.1, nên không có màu viết thẳng và theme tối tự đúng. Tổng ≤ 6 loại × 2 + 4 = 16 `<path>`, không phụ thuộc số bước |
| Khung nhìn | Chữ nhật của phần đang thấy, **cắt theo cửa sổ** để luôn đủ 4 cạnh (sơ đồ dẹt hơn khung nhìn: khung nhìn cao hơn minimap, mockup đầu tiên chỉ còn hai cạnh dọc). Phần sheet che (≤ 900 px) không tính |
| Rãnh tổng quan | Chỉ khi sơ đồ rộng hơn cửa sổ: `.mm-track` cao 6 px dưới bản đồ, nền `surface-hover`, bo pill; con trượt `.mm-thumb` nền `accent`, vị trí/rộng = khung nhìn trên cả bề rộng sơ đồ, rộng tối thiểu 6 px. Vùng bấm của rãnh cao 16 px (đệm trong suốt) |
| Bấm trên bản đồ | Căn giữa khung nhìn vào điểm đó (giữ mức thu phóng), cập nhật phần tử (`cull`) ngay |
| Kéo trên bản đồ | Khung nhìn đi theo con trỏ; trong lúc kéo cửa sổ **đứng yên** (không trượt dưới con trỏ), khung nhìn kẹp trong cửa sổ; thả thì cửa sổ theo khung nhìn. Đi xa: bấm / kéo trên rãnh (khung nhìn theo vị trí trên cả sơ đồ) |
| Con lăn trên minimap | Không làm gì (không pan, không thu phóng): tránh lăn nhầm làm sơ đồ nhảy xa |
| Khi nào hiện | Bật (mặc định bật) **và** không phải điện thoại (≤ 720 px, hoặc ≤ 900 × 500) **và** sheet đóng **và** sơ đồ lớn hơn khung nhìn ở mức thu phóng hiện tại (rộng × zoom > khung nhìn hoặc cao × zoom > khung nhìn). Hiện/ẩn mờ dần `--dur-base` |
| Nút bật/tắt | Nút `icon` thứ năm trên `.dg-zoom`: `<button id="btn-minimap" aria-pressed="true" aria-controls="dg-minimap" aria-label="Bản đồ thu nhỏ" title="Bản đồ thu nhỏ (hiện khi sơ đồ lớn hơn khung nhìn)">` icon `minimap`. Đang bật: nền `accent-subtle`, icon `accent-text` (như nút chế độ xem). Nhớ ở `localStorage['sfdg.minimap']` (`'0'` khi tắt). Ẩn ở điện thoại cùng các nút − / % / + |
| Không che thẻ | `showRect` (canvas.js) coi vùng minimap như vùng thanh thu phóng: thẻ cần hiện mà rơi dưới minimap thì được đưa sang trái hoặc lên trên nó. Hàm `zoomBarRect()` thành `overlayRects()` trả cả hai |
| Trợ năng | `aria-hidden="true"`, không nhận focus: là tiện ích cho chuột/chạm. Bàn phím đã có cách tương đương (0003): ↑/↓/Home/End đi khắp cây và tự pan, `0` vừa khung. Nút bật/tắt có `aria-pressed` |
| Hiệu năng | Dựng lại (đổi workflow, kết quả, thu gọn, lỗi) trong **một rAF riêng sau `render()`**, gộp khi gõ trong inspector (≤ 1 lần / 250 ms). Mỗi khung hình khi pan/zoom chỉ đổi `viewBox`, 4 thuộc tính của khung nhìn và `left/width` của con trượt (O(1)). Mockup chưa tối ưu, 1 000 bước: `layout` 2,8–4,5 ms, dựng đường 11,8–15,2 ms, mỗi khung hình di chuyển 0,03–0,07 ms (`mock-out.json`). Khi làm: chỉ đưa vào đường các khối nằm trong cửa sổ ± một cửa sổ (lọc O(n), chuỗi nhỏ), mục tiêu dựng < 4 ms ở 1 000 bước. 8 000 bước (giới hạn test bố cục của 0003) vẫn O(n) một lần mỗi lần dựng, không phần tử DOM mới |
| Màn hình hẹp | 721–900 px: hộp 200 px, ẩn khi sheet mở (sheet phủ góc dưới). ≤ 720 px và điện thoại xoay ngang: không có minimap (khung nhìn quá nhỏ; chụm để thu phóng, `⤢` vừa khung) |

Ảnh: `after/light-1440-canvas-minimap.png`, `after/dark-1440-canvas-minimap.png` (1 000 bước, đang chọn `a30`: khối xanh có
quầng, 18 lỗi có viền đỏ), `after/light-minimap-zoom.png`, `after/light-1440-canvas-minimap-small.png` (sơ đồ nhỏ thu
phóng 195 %: thấy trọn, không có rãnh).

### 6. Phím mở bảng chọn biến trên macOS

| Quyết định | Chi tiết |
| --- | --- |
| Phím thêm | **Alt+↓** (macOS: **⌥↓**) mở bảng chọn biến ở ô Mẫu và ô đường dẫn, **trên mọi hệ điều hành**. Đây là phím chuẩn "mở danh sách" của combobox (ARIA APG, và của `<select>` trên Windows), nên người dùng trình đọc màn hình đã quen |
| Giữ | Ctrl+Space (Windows/Linux, và Mac đã tắt phím đổi bộ gõ), `{{` trong ô Mẫu, ↓ trong ô đường dẫn, nút `{x}` |
| Không xung đột | Alt+↑/↓ toàn cục (di chuyển bước) chỉ chạy khi **không** gõ trong ô nhập (`main.js` thoát sớm khi `typing`), nên trong ô biến Alt+↓ là của bảng chọn. Trên macOS ⌥↓ trong ô một dòng vốn đưa con trỏ về cuối dòng: chỉ thay ở ô có bảng chọn biến |
| Nhận diện Mac | `client/js/keys.js` (thuần): `isMac(nav)` = `/Mac|iPhone|iPad/` trên `nav.userAgentData?.platform ?? nav.platform`; `pickerKeys(mac)` trả nhãn |
| `title` nút `{x}` | Mẫu: `Chèn biến (gõ {{ hoặc ⌥↓)` trên Mac; `Chèn biến (gõ {{, Alt+↓ hoặc Ctrl+Space)` nơi khác. Đường dẫn: `Chọn biến (↓ hoặc ⌥↓)` / `Chọn biến (↓, Alt+↓ hoặc Ctrl+Space)` |
| `aria-keyshortcuts` | Trên ô nhập: `Alt+ArrowDown Control+Space` (cả hai, mọi nền tảng) |
| Danh sách "Phím tắt" (inspector khi chưa chọn bước; tab "Phím tắt" khi 0012 làm) | Thêm dòng theo nền tảng: `Trong ô Mẫu / ô biến: {{ hoặc ⌥↓ mở bảng chọn biến` (Mac) / `Trong ô Mẫu / ô biến: {{, Alt+↓ hoặc Ctrl+Space mở bảng chọn biến` |
| Nhãn khác | Không đổi (`Ctrl+Enter`, `Ctrl+Z`… chạy được trên Mac bằng cả Ctrl lẫn ⌘) |

### 7. Thẻ không tràn ở điện thoại (bổ sung)

Ở ≤ 720 px, hàng thẻ (Quy trình) không bao giờ rộng hơn thẻ; `⋯` và chevron luôn thấy:

- Tag `chưa chọn org` (`.tag-sample`) ẩn: cùng nội dung đã có ở badge `▲` của thẻ (cảnh báo "Chưa chọn org nên bước Query
  … dùng 5 bản ghi mẫu") và ở thanh lỗi; `title` của thẻ không đổi.
- Thứ tự co: tóm tắt (`.sum`, đã co về 0) → chip số liệu (`.stat`: `min-width: 3em`, cắt `…`, `title` giữ câu đầy đủ) →
  alias (cắt `…`, tối đa 72 px như Sơ đồ). Nhãn loại, badge, `⋯`, chevron **không co**.

### 8. Token mới

Tất cả trong khối token của `app.css` và bảng của `ui-design-system.md` (§3, §4, §5). Không thêm primitive, không thêm
màu thô.

| Token | Giá trị | Dùng cho |
| --- | --- | --- |
| `--ico-<tên>` × 24 | data URI SVG (bảng mục 1) | Icon mới |
| `--icon-xs` / `--icon-sm` / `--icon-md` | 12 / 14 / 16 px | Cỡ icon |
| `--mask-fade-start` / `-end` / `-both` | `linear-gradient(to right, transparent, black var(--fade-w))` (và đối xứng) | Mép mờ hàng cuộn ngang (mask, không phải màu hiển thị; nằm trong khối token vì chứa `black`) |
| `--fade-w` | `var(--space-6)` = 24 px | Bề rộng vùng mờ, `scroll-padding-inline` |
| `--results-h` | `38vh` (JS đặt px trên `#results`) | Chiều cao panel kết quả |
| `--results-min-h` | 160 px | Thấp nhất khi mở |
| `--layout-min-h` | 240 px (thực tế `min(240px, 50 %)`, JS tính) | Vùng `main` còn lại ít nhất |
| `--resize-hit` / `--resize-hit-touch` | 8 / 24 px | Vùng bấm tay nắm (chuột / chạm) |
| `--grip-w` / `--grip-h` | 32 / 4 px | Viên thuốc tay nắm (panel kết quả, sheet) |
| `--sheet-h-full` | `min(90dvh, calc(100dvh - var(--topbar-h, 89px)))` | Nấc cao của sheet |
| `--topbar-h` | đo (JS, `:root`), mặc định 89 px | Chiều cao thanh trên |
| `--sheet-now` | đo (JS) | Chiều cao sheet đang hiện (toast nằm trên) |
| `--minimap-w` | 240 px (721–900 px: 200 px) | Bề rộng minimap |
| `--minimap-min-h` / `--minimap-max-h` | 32 / 120 px | Cao phần bản đồ |
| `--color-minimap-off` | sáng gray-400 `#808790` / tối gray-500 `#6e757f` | Bước tắt trên minimap (≥ 3:1 trên `surface-raised`) |

### 9. ARIA và phím (tóm tắt)

| Thành phần | Vai trò / thuộc tính | Phím |
| --- | --- | --- |
| Icon | `aria-hidden="true"` luôn | — |
| Nút chỉ có icon | `aria-label` bằng chữ (đúng `title` hiện có, bỏ phần phím trong ngoặc) | như nút |
| Tay nắm panel | `role="separator"`, `aria-orientation="horizontal"`, `aria-controls`, `aria-valuemin/max/now/text`, `tabindex="0"` | ↑ ↓ (Shift), Home, End, Enter |
| Tay nắm sheet | `<button>` `aria-expanded`, `aria-controls="inspector"`, nhãn cố định "Mở rộng bảng cấu hình" | Enter / Space |
| Hàng cuộn ngang | Không thêm vai trò; `data-overflow` chỉ là hình | Tab (cuộn vào vùng không mờ) |
| Minimap | `aria-hidden="true"`, không focus; nút bật/tắt `aria-pressed`, `aria-controls` | Thay bằng ↑ ↓ Home End 0 của Sơ đồ |
| Ô biến | `aria-keyshortcuts="Alt+ArrowDown Control+Space"` | Alt+↓ / ⌥↓, Ctrl+Space |

### 10. Màn hình hẹp (tóm tắt)

| Chiều rộng | Icon | Panel kết quả | Sheet | Hàng cuộn | Minimap |
| --- | --- | --- | --- | --- | --- |
| ≥ 901 px | 16 px trong nút | Tay nắm 8 px phủ mép | — | `.tabs` | 240 px, mặc định bật |
| 721–900 px | như trên; nút trên thẻ 32 px (0003) | như trên (`pointer: coarse` thì hàng 24 px) | hai nấc | `.palette`, `.tabs` | 200 px, ẩn khi sheet mở |
| ≤ 720 px, và ≤ 900 × 500 | như trên | Hàng 24 px (chạm); ẩn nếu khoảng đổi < 24 px (844 × 390) | hai nấc (390 × 844: 506 / 755 px; 844 × 390: 190 / 301 px) | `.palette`, `#results-summary`, `.tabs` | không có |

### 11. Kiểm chứng: tương phản và mù màu

Tính bằng `contrast.mjs` từ giá trị thật trong `app.css` (giải `var()` và `color-mix(in srgb)`), cộng token đề xuất.
**24 cặp có ngưỡng mỗi theme (18 cặp trong bảng + 6 loại bước), 0 cặp không đạt**; hai dòng cuối không có ngưỡng, ghi
để giải thích quyết định. Thấp nhất: `minimap-off`/`surface-raised` 3,63 (sáng) / 3,39 (tối),
`border-control`/`surface` (tay nắm) 3,63 / 3,76.

| Chữ/nét | Nền | Dùng cho | Ngưỡng | Sáng | Tối |
| --- | --- | --- | --- | --- | --- |
| `--color-text` | `--color-surface` | Icon nút ghost thanh trên | 3 | 17.48 | 16.00 |
| `--color-text-muted` | `--color-surface-raised` | Icon nút trên thẻ, grip thẻ | 3 | 6.78 | 6.83 |
| `--color-text-muted` | `--color-surface-hover` | Icon nút ghost khi hover | 3 | 5.68 | 5.91 |
| `--color-text-muted` | `--color-accent-subtle` | Icon trên thẻ đang chọn | 3 | 6.24 | 5.45 |
| `--color-text-muted` | `--color-surface-sunken` | Icon nút field card | 3 | 6.50 | 7.85 |
| `--color-danger-text` | `--color-surface` | Icon thùng rác, Insert, Dừng | 3 | 7.43 | 11.94 |
| `--color-accent-contrast` | `--color-accent` | Icon trên nút Xem trước | 3 | 5.23 | 7.51 |
| `--color-accent-text` | `--color-surface` | Icon ghim, Đọc lại | 3 | 7.02 | 12.20 |
| `--color-text-muted` | `--color-bg-disabled` | Icon trên thẻ "Đã tắt" | 3 | 5.68 | 5.91 |
| `--color-border-control` | `--color-surface` | Tay nắm (panel, sheet), mặc định | 3 | 3.63 | 3.76 |
| `--color-text-muted` | `--color-surface` | Tay nắm khi hover | 3 | 6.78 | 7.56 |
| `--color-accent` | `--color-surface` | Tay nắm và mép panel khi kéo | 3 | 5.23 | 6.99 |
| `--color-focus-ring` | `--color-surface` | Vòng focus tay nắm | 3 | 3.72 | 6.99 |
| `--color-accent` | `--color-surface-raised` | Khung nhìn trên minimap | 3 | 5.23 | 6.32 |
| `--color-accent` | `--color-surface-hover` | Con trượt trên rãnh tổng quan | 3 | 4.38 | 5.47 |
| `--color-danger` | `--color-surface-raised` | Vòng lỗi trên minimap | 3 | 5.57 | 5.90 |
| `--color-minimap-off` | `--color-surface-raised` | Bước tắt trên minimap | 3 | 3.63 | 3.39 |
| `--color-text` | `--color-surface-raised` | Icon nút minimap | 3 | 17.48 | 14.45 |
| `--step-*` (6 loại) | `--color-surface-raised` | Khối thẻ trên minimap | 3 | 4.06–7.31 | 4.35–9.33 |
| `--color-border-strong` | `--color-surface-raised` | (không dùng: đường nối, đã bỏ khỏi minimap) | — | 1.74 | 1.58 |
| `--color-accent` | `--step-*` | Khung nhìn đè lên khối thẻ, nếu không có quầng | — | 1.07–1.40 | 1.10–1.48 |

Dòng cuối là lý do có **quầng `surface-raised`** dưới khung nhìn và thẻ đang chọn: accent chỉ đạt 1,07–1,48 : 1 so với
màu loại bước, nên nét xanh nằm thẳng trên khối Query / Lặp sẽ chìm. Có quầng thì nét xanh luôn nằm trên `surface-raised`
(5,23 / 6,32).

Mép mờ của hàng cuộn làm chữ ở 24 px cuối mờ dưới 4,5 : 1. Đó là chỉ báo "còn nữa", không phải nội dung duy nhất: cuộn
tới thì chữ đọc đủ, và focus bàn phím luôn dừng ngoài vùng mờ (`scroll-padding-inline`).

**Mù màu.** Không thêm hue nào. Trên minimap: lỗi khác thẻ thường bằng **hình** (vòng nét bao ngoài, to hơn khối), đang
chọn bằng **quầng + cỡ lớn hơn** (không chỉ bằng xanh, vì ở deuteranopia accent và Lặp chỉ cách ΔE 3,4, 0008 §8.2), khung
nhìn là **chữ nhật rỗng**, bước tắt là khối **xám không có màu loại**. Loại bước trên minimap chỉ dựa vào màu (khối 10 px
không chứa được icon): chấp nhận vì minimap là thông tin phụ, thẻ thật luôn có icon + nhãn. Tay nắm khác trạng thái bằng
màu **và** độ dày đường mép / con trỏ.

## Thay đổi dữ liệu / API

- Workflow JSON (`docs/workflow-schema.md`): **không đổi**. File `version: 2` và `version: 1` không bị ảnh hưởng.
- Endpoint, `/api/meta`, option schema: không đổi.
- `localStorage` (bọc `try/catch` như `sfdg.theme`; trạng thái UI, không vào undo):
  - `sfdg.resultsH`: tỉ lệ chiều cao panel kết quả, ví dụ `"0.412"`. Không có / sai: 38 %.
  - `sfdg.minimap`: `"0"` khi người dùng tắt minimap; không có = bật.
- Module mới ở client: `client/js/sizing.js` (thuần: kẹp chiều cao panel, nấc sheet, bước phím), `client/js/minimap.js`
  (thuần: tỉ lệ, cửa sổ, khung nhìn đã cắt, rãnh, các chuỗi path theo nhóm), `client/js/keys.js` (thuần: nhận diện Mac,
  nhãn phím). Cả ba không import DOM để `node:test` nạp được (như `layout.js`, `issues.js`).

## Checklist tiện dụng

- [x] 1. Chạy được ngay với mặc định — không cấu hình mới: panel 38 % như cũ, sheet mở nấc vừa như cũ, minimap tự hiện khi
  sơ đồ lớn hơn khung nhìn.
- [x] 2. Ít thao tác cho việc hay làm — đổi cao panel 1 thao tác (nhớ luôn); sheet cao 1 chạm; tới phần xa của sơ đồ 1 bấm
  trên minimap thay vì kéo nhiều lần; mở bảng chọn biến trên Mac lại có phím (⌥↓).
- [x] 3. Xem trước trước khi ghi — không đổi luồng Insert; ở nấc sheet cao, Xem trước / Insert vẫn ở thanh trên và vẫn hỏi
  xác nhận.
- [x] 4. Lỗi chỉ đúng chỗ và nói cách sửa — thẻ lỗi có viền đỏ trên minimap; F8 đưa sheet về nấc vừa để thấy thẻ lỗi; đảm bảo
  thanh lỗi của 0009 giữ nguyên khi panel cao tối đa.
- [x] 5. Không mất công sức — không đụng dữ liệu; chiều cao panel và lựa chọn minimap được nhớ; kéo sheet xuống để đóng giữ
  lựa chọn như `Xong`.
- [x] 6. Lấy thông tin từ org thay vì bắt gõ — không áp dụng (không có ô nhập mới).
- [x] 7. Một nguồn sự thật — icon là token, chọn bằng `data-ico`; màu minimap đi qua `[data-type]` duy nhất (§6.1); không
  thêm kiến thức về loại bước ở client; các hàm tính toán thuần có test.
- [x] 8. Giải thích tại chỗ — `title` của tay nắm, nút minimap, `{x}` ghi phím theo nền tảng; dòng mới trong "Phím tắt".
- [x] 9. An toàn khi lỡ tay — panel không thể che hết cột giữa (`min(240 px, 50 %)`); kéo quá tay xuống thì chỉ thu gọn
  (mở lại đúng chiều cao cũ); lăn chuột trên minimap không làm sơ đồ nhảy.

## Phương án đã cân nhắc

**Icon**

| Phương án | Ưu | Nhược | Chọn? |
| --- | --- | --- | --- |
| A. SVG mask token + `data-ico` + `ico()` (mở rộng hệ của 0008) | Cùng nét/cỡ với icon loại bước; màu `currentColor`; không dependency; CSS đổi theme tự đúng | 24 data URI dài trong khối token | **Có** |
| B. SVG sprite `<symbol>` trong `index.html` + `<use>` | Một file, dễ sửa hình | Hai cơ chế icon song song; `<use>` trong JS dài dòng; test token không kiểm được | Không |
| C. Font icon (Lucide font) | Quen thuộc | Thêm file tải (cấm: không web font); ký tự PUA đọc lên vô nghĩa | Không |
| D. Giữ ký tự, đặt `font-family` cố định | Ít sửa | Không có font ký hiệu chung cho mọi máy; vẫn lệch cỡ | Không |

**Panel kết quả**

| Phương án | Ưu | Nhược | Chọn? |
| --- | --- | --- | --- |
| A. Tay nắm `role=separator` ở mép trên, nhớ tỉ lệ, kẹp theo cột giữa | Chuẩn APG (chuột, chạm, phím); không thêm hàng ở desktop | Cần JS kẹp và đo | **Có** |
| B. 3 nấc cố định (thấp / vừa / cao) bằng nút | Dễ test | Không vừa với bảng có số dòng bất kỳ; thêm nút vào đầu panel đã chật (0009, 0011) | Không |
| C. CSS `resize: vertical` | Không JS | Tay nắm ở góc dưới phải (ngược chiều, panel ở đáy), không bàn phím, không nhớ | Không |

**Sheet**

| Phương án | Ưu | Nhược | Chọn? |
| --- | --- | --- | --- |
| A. Hai nấc, kéo ở hàng đầu sheet, chạm/phím trên tay nắm, nấc cao chừa thanh trên | Đủ chỗ sửa form; Xem trước luôn bấm được; kéo không lẫn với cuộn form | Thêm xử lý cử chỉ (thuần hóa phần tính vào `sizing.js` để test) | **Có** |
| B. Kéo tự do (không nấc) | Linh hoạt | Dừng ở chiều cao lửng, thẻ đang sửa nửa thấy nửa không; khó nhớ | Không |
| C. Nấc cao = toàn màn hình | Thêm 89 px | Che Org / Xem trước / Insert; phải đóng sheet mới chạy | Không |

**Dấu hiệu cuộn ngang**

| Phương án | Ưu | Nhược | Chọn? |
| --- | --- | --- | --- |
| A. Mép mờ bằng `mask-image` + con lăn dọc thành ngang + `scroll-padding` | Không thêm vùng bấm, không đổi bố cục, đúng mọi nền và theme | Cần JS nhỏ để biết đầu/cuối | **Có** |
| B. Bóng đổ nền kiểu `background-attachment: local` (chỉ CSS) | Không JS | Không chạy khi mục có nền đặc (mục palette, chip) vì nền mục che bóng | Không |
| C. Nút ‹ › hai đầu | Rõ ràng cho chuột | Chiếm chỗ ở hàng 48–51 px; thêm điểm Tab | Không |
| D. Hiện lại thanh cuộn | Quen thuộc | Ăn vào `--tabs-h` (đầu bảng dính, 0009) và chiều cao palette hẹp | Không |

**Minimap**

| Phương án | Ưu | Nhược | Chọn? |
| --- | --- | --- | --- |
| A. SVG một path mỗi nhóm, tỉ lệ ≥ 0,05 với cửa sổ đi theo + rãnh tổng quan | Đọc được ở sơ đồ dẹt 1 000 bước; DOM cố định ≤ 16 path; màu qua token, theme tự đúng | Cửa sổ không thấy cả sơ đồ cùng lúc (rãnh bù lại) | **Có** |
| B. Thu cả sơ đồ vào hộp (minimap kinh điển) | Đơn giản | Sơ đồ tỉ lệ 40–1 700 : 1 thành một vệt < 1 px | Không |
| C. `<canvas>` 2D | Nhanh với hàng chục nghìn khối | Phải đọc màu token ra giá trị (không đọc được `color-mix` một cách chắc chắn), vẽ lại khi đổi theme, không dùng `[data-type]` | Không |
| D. Không minimap, chỉ thêm "Tới bước đang chọn" | Ít việc | Không giải bài định hướng; 0003 đã hứa minimap | Không |

**Phím chọn biến trên Mac**

| Phương án | Ưu | Nhược | Chọn? |
| --- | --- | --- | --- |
| A. Thêm Alt+↓ / ⌥↓ cho mọi nền tảng, giữ Ctrl+Space | Chuẩn combobox (APG); không đụng phím hệ thống; một phím cho mọi máy | Ghi đè ⌥↓ (về cuối dòng) trong ô biến trên Mac | **Có** |
| B. ⌃⌥Space / ⌘⇧Space | Gần Ctrl+Space | Lạ, khó nhớ; ⌘⇧Space dễ trùng phím toàn cục (Alfred, Raycast) | Không |
| C. ⌘K | Quen trong app web | Trùng phím Chrome/Safari ở vài bản; nghĩa "lệnh" chứ không phải "mở danh sách" | Không |
| D. Chỉ dựa vào `{{` và `{x}` | Không code | Ô đường dẫn không có `{{`; người dùng bàn phím trên Mac không có phím | Không |

## Kế hoạch thực hiện

Không có thay đổi contract (bảng của `.claude/agents/implementer.md`: chỉ hàng UI, Docs, Tests). Mỗi bước tự chạy được,
có kiểm tra riêng. Smoke: thêm vào đúng nhóm luồng đang chạy song song; luồng minimap là **một nhóm mới** (`flowMinimap`)
để không kéo dài `flowCanvas` (đã dài nhất, 0003). Ngân sách smoke 12 s, hiện ~8 s; mục tiêu sau doc này ≤ 9,5 s (đo 3 lần,
ghi vào "Đã làm"). Không `waitForTimeout` cố định.

| # | Việc | File | Kiểm tra |
| --- | --- | --- | --- |
| 1 | **Phím chọn biến.** `keys.js` (`isMac`, `pickerKeys`); `var-picker.js` nhận `e.altKey && e.key === 'ArrowDown'` cùng chỗ Ctrl+Space; `title` của `{x}` và `aria-keyshortcuts` theo `keys.js`; dòng mới trong "Phím tắt" (`inspector.js`) | `client/js/keys.js` (mới), `client/js/var-picker.js`, `client/js/inspector.js` | `test/keys.test.js`: Mac / Windows / iPad / `userAgentData` thiếu; nhãn hai nền tảng. Smoke `flowPicker` (5b): Alt+ArrowDown trong ô Mẫu mở bảng chọn với ô tìm có focus; trong ô đường dẫn cũng mở; `aria-keyshortcuts` có `Alt+ArrowDown` |
| 2 | **Icon.** 24 token `--ico-*`; luật `.ico[data-ico]` cho **mọi** icon (cũ và mới); `--icon-xs/sm/md`, badge 12 px, dòng lỗi 16 px; `ico()` trong `dom.js`; thay ký tự trong `index.html`, `process.js`, `canvas.js`, `inspector.js`, `results.js`, `popup.js` (`.pi-check`), `main.js` (chữ hộp xác nhận); `slot-true/false` và `.info-box` dùng `::before` mask; `aria-label` cho nút chỉ có icon; ô Id lỗi dùng icon `error` + `.sr-only` "lỗi" | `client/css/app.css`, `client/index.html`, `client/js/dom.js`, `client/js/{process,canvas,inspector,results,popup,main}.js` | `test/css-tokens.test.js` thêm: (a) mọi `data-ico="x"` / `ico('x')` trong `client/` có `--ico-x` và luật `.ico[data-ico="x"]`; (b) mọi `--ico-*` có dòng trong bảng §5 của `ui-design-system.md`; (c) không còn ký tự `⋯ ▸ ▾ ▴ ⠿ ↶ ↷ ⟳ ⤓ ⤒ ⤢ ▶ 📌 ⚙ ✕ ⊘ ◉ ⧉ ⓘ ‹ ✓ ✗` trong chuỗi của `client/js/*.js`, `client/index.html` và `content:` của `app.css` (bỏ qua chú thích). Smoke luồng 1: mọi `button` không có chữ đều có `aria-label`; mọi `.ico` có `data-ico` hoặc nằm trong `.ico-tile`; mọi `button > .ico` rộng 16 px; ảnh `smoke-1440.png` sáng và tối (luồng 12). Smoke dòng 579 đổi thành `/Đọc lại/` |
| 3 | **Thẻ không tràn ở điện thoại** (mục 7) | `client/css/app.css` | Smoke 13d ở 390 × 844 sau Xem trước sample "Contact cho Account có sẵn" không org: mọi `.step-card` có `scrollWidth ≤ clientWidth`, `.menu-btn` nằm trọn trong màn hình |
| 4 | **Dấu hiệu cuộn ngang.** `watchOverflow()` trong `dom.js`; gắn cho `.palette`, `#results-summary`, `.tabs` (`main.js`, `results.js`); token mask; `scroll-padding-inline`; con lăn; tab đang mở `scrollIntoView` | `client/js/dom.js`, `client/js/main.js`, `client/js/results.js`, `client/css/app.css` | Smoke 13e ở 390 × 844: `#results-summary` có `data-overflow="end"`, cuộn hết sang phải ⇒ `"start"`; `.palette` `"end"`; ở 1440 `.palette` không có thuộc tính; lăn dọc trên tóm tắt ⇒ `scrollLeft` tăng |
| 5 | **Panel kết quả.** `sizing.js`: `clampResults({ want, total, min, layoutMin })`, `resultsKeyStep(key, shift)`, `shouldCollapse(drag, min)`; `results.js`: tay nắm, pointer, phím, nhấp đúp, `sfdg.resultsH`, ARIA, ẩn khi thu gọn / khoảng < 24 px; `main.js`: đo `--topbar-h`; giữ thẻ đang chọn ở Quy trình | `client/js/sizing.js` (mới), `client/js/results.js`, `client/js/main.js`, `client/js/process.js` (nếu cần hàm reveal), `client/index.html`, `client/css/app.css` | `test/sizing.test.js`: kẹp min/max ở 1440 × 900, 390 × 844, 844 × 390 (khoảng < 24 ⇒ ẩn), `min(240, 50 %)`, thu gọn khi kéo quá 48 px, bước phím. Smoke `flowLayoutWide` 1440 × 900: Tab tới tay nắm, ↑ ×3 ⇒ cao thêm 48 px, Home ⇒ 160 px, End ⇒ `main` còn 240 px và thanh lỗi ≤ 25 % cột giữa; kéo chuột lên 100 px ⇒ cao thêm 100 ± 1; tải lại ⇒ giữ chiều cao; Enter ⇒ thu gọn, focus ở `Kết quả`; thẻ `con` đang chọn vẫn thấy sau End |
| 6 | **Sheet hai nấc.** `sizing.js`: `snapSheet({ height, velocity, mid, full })`; `inspector.js`: `.sheet-grip`, kéo ở `.sheet-head`, `.inspector.full`, `--sheet-now`, về nấc vừa khi F8 / lỗi / mở mới; CSS chuyển nấc + giảm chuyển động | `client/js/sizing.js`, `client/js/inspector.js`, `client/css/app.css` | `test/sizing.test.js`: nấc gần nhất, vuốt nhanh lên/xuống, đóng dưới ½ nấc vừa. Smoke `flowLayoutNarrow` 390 × 844: Enter trên tay nắm ⇒ đỉnh sheet = đáy `.topbar` (± 1), `aria-expanded="true"`; Enter lại ⇒ nấc vừa, thẻ `con` trên mép sheet; kéo chuột (pointer) ở `.sheet-head` lên 200 px ⇒ nấc cao; kéo xuống 400 px ⇒ đóng, inert, focus ở thẻ; toast nằm trên sheet ở nấc cao; 844 × 390: nấc cao 301 px |
| 7 | **Minimap.** `minimap.js`: `minimapModel(lay, view, box)` → `{ scale, window, height, viewRect, track }`, `minimapPaths(lay, { issues, selected })` → nhóm path; `canvas.js`: phần tử, dựng trong rAF sau `render()`, cập nhật O(1) trong `applyTransform`, bấm/kéo/rãnh, `overlayRects()` cho `showRect`, nút `#btn-minimap` + `sfdg.minimap`, ẩn ở điện thoại / sheet mở / sơ đồ vừa khung | `client/js/minimap.js` (mới), `client/js/canvas.js`, `client/index.html`, `client/css/app.css` | `test/minimap.test.js`: sơ đồ nhỏ ⇒ thấy trọn, không rãnh; 1 000 bước ⇒ tỉ lệ 0,05, cửa sổ theo tâm khung nhìn và kẹp hai đầu; khung nhìn cắt đủ 4 cạnh khi cao hơn cửa sổ; con trượt ≥ 6 px; số nhóm path ≤ 16 ở 40, 1 000 và 8 000 bước (không tăng theo n); bước tắt / lỗi / chọn vào đúng nhóm. Smoke `flowMinimap` (mới, song song) 1440 × 900 với 1 000 bước nạp qua `addInitScript`: minimap hiện, ≤ 16 `path`; bấm ở 75 % rãnh ⇒ thẻ quanh vị trí đó có trong DOM; tắt nút ⇒ ẩn, tải lại vẫn tắt; sơ đồ 1 bước ⇒ ẩn; chọn bước rồi `ensureVisible` ⇒ thẻ không giao với minimap; 800 px mở sheet ⇒ ẩn; 390 px ⇒ không có nút minimap; ảnh `smoke-1440-minimap.png` sáng và tối |
| 8 | **Tài liệu.** `ui-design-system.md`: bỏ nhãn "(0014, dự kiến)" ở các mục đã thêm; `architecture.md`: dòng `sizing.js`, `minimap.js`, `keys.js`; `SKILL.md` smoke: luồng mới; README design index; mục "Đã làm" của doc này (số đo smoke 3 lần) | `docs/ui-design-system.md`, `docs/architecture.md`, `.claude/skills/smoke-test/SKILL.md`, `docs/design/README.md`, doc này | `npm test` qua; smoke `SMOKE OK` 3 lần liên tiếp ≤ 12 s |

Ghi chú khi làm:

- Bước 1 và 3 nhỏ, độc lập; bước 2 trước bước 4–7 vì các bước đó dùng `ico()` (nút minimap, tay nắm sheet không có icon
  nhưng `.sheet-close` có).
- Mọi `padding`/`margin`/`gap` mới dùng thang `--space-*` (test 4 px); `top: -4px` của tay nắm và `height` không thuộc luật
  khoảng cách. `z-index` chỉ `1` (tay nắm) — minimap theo thứ tự DOM như `.dg-zoom`.
- Không dùng `:has()` (giữ như 0009). Không thêm dependency.
- 0011 (`⤓ Id`, tab `⚠ Lỗi xóa`, nút Lịch sử icon 32 px) và 0012 (`[▾]` thư viện ở thanh trên) làm sau doc này thì dùng
  `ico('download')`, icon `warning` như `.tab-issues`, `ico('chevron-down')`; làm trước thì bước 2 đổi luôn. Test (c) ở
  bước 2 bắt được cả hai trường hợp.

## Câu hỏi mở

Không còn câu hỏi chặn (đã chốt hết, xem dưới). Để sau, khi có phản hồi dùng thật:

- Minimap trên điện thoại (hiện không có): nếu người dùng mở Sơ đồ trên điện thoại nhiều, cân nhắc một rãnh tổng quan đơn
  giản (không có bản đồ) ở mép dưới khung nhìn.
- Nhớ nấc sheet giữa các lần mở (hiện luôn mở nấc vừa để thẻ đang sửa thấy được).

## Đã chốt

Người dùng giao chọn theo phương án đề xuất; planner chốt như sau (2026-10-28):

1. **Icon:** 24 icon SVG mask mới trong hệ `--ico-*` của 0008, chọn bằng `data-ico` + `ico()`; luật `.ico[data-ico]` cho mọi
   icon (tránh kế thừa `--ico` từ `[data-type]`); cỡ 12 / 14 / 16 px theo token. Nút chỉ có icon có `aria-label` bằng chữ
   (thêm cho 7 nút đang đọc lên tên ký tự); nút có chữ đọc lên chỉ còn chữ. Ký tự trong câu chữ / tên phím giữ nguyên.
   Có test chặn ký tự-icon quay lại.
2. **Xem trước dùng tam giác tô đặc (`run`)**, khác tam giác viền của Bắt đầu. Xóa bước: thùng rác; xóa field: dấu ×; tắt/bật
   bước: icon nguồn ở cả hai trạng thái (nhãn đổi).
3. **Panel kết quả đổi cao** bằng tay nắm `role="separator"` ở mép trên (8 px phủ mép với chuột; hàng 24 px với chạm),
   tối thiểu 160 px, vùng `main` còn `min(240 px, 50 %)`; phím ↑↓ 16 px, Shift 64 px, Home/End, Enter thu gọn; nhấp đúp về
   38 %; kéo quá min 48 px thì thu gọn; nhớ tỉ lệ ở `sfdg.resultsH`; tay nắm ẩn khi khoảng đổi < 24 px.
4. **Sheet hai nấc ở mọi màn hình có sheet (≤ 900 px)**: vừa = `--sheet-h` của 0009, cao = `min(90dvh, 100dvh − thanh trên)`;
   kéo ở hàng đầu sheet, chạm / Enter trên tay nắm; vuốt nhanh sang nấc kế; kéo xuống quá ½ nấc vừa thì đóng như `Xong`;
   luôn mở ở nấc vừa; F8 / lỗi chạy về nấc vừa. Không nhớ nấc.
5. **Dấu hiệu cuộn ngang:** mép mờ 24 px bằng `mask-image`, con lăn dọc cuộn ngang, `scroll-padding-inline`; áp cho palette
   hẹp, tóm tắt kết quả (≤ 720 px), hàng tab; không thêm nút ‹ ›.
6. **Minimap:** góc dưới phải khung nhìn Sơ đồ, SVG ≤ 16 path, tỉ lệ ≥ 0,05 với cửa sổ đi theo + rãnh tổng quan; bấm để
   tới, kéo để dời, rãnh để đi xa, lăn chuột không làm gì; hiện khi sơ đồ lớn hơn khung nhìn; nút bật/tắt trên thanh thu
   phóng, mặc định bật, nhớ ở `sfdg.minimap`; không có ở điện thoại, ẩn khi sheet mở; `showRect` tránh vùng minimap;
   `aria-hidden` vì bàn phím đã có cách tương đương.
7. **Phím chọn biến:** thêm **Alt+↓ (⌥↓)** cho mọi nền tảng, giữ Ctrl+Space; nhãn trong `title`, "Phím tắt" theo nền
   tảng; `aria-keyshortcuts`. Không đổi các nhãn `Ctrl+…` khác.
8. **Thẻ không tràn ở điện thoại:** ẩn tag `chưa chọn org` ở ≤ 720 px (đã có badge cảnh báo), chip số liệu và alias co
   với `…`.
9. **Token mới** như mục 8 của Thiết kế UI, có trong `ui-design-system.md` (đánh dấu "dự kiến" tới khi làm xong).

## Đã làm

(Chưa làm.)
