# Hệ thống thiết kế UI

Nguồn sự thật duy nhất về hình thức của trình soạn: màu, chữ, khoảng cách, bo góc, đổ bóng, icon và trạng thái của từng thành
phần. Các custom property ở đầu `client/css/app.css` phải khớp 1:1 với tài liệu này. Thiết kế và lý do nằm ở
[design/0008-ui-design-system.md](design/0008-ui-design-system.md).

## 1. Nguyên tắc

1. **Một màu, một nghĩa.** Có ba bộ màu. Hai bộ bất kỳ không bao giờ dùng chung một màu:
   | Bộ | Nghĩa | Token | Dùng ở đâu |
   | --- | --- | --- | --- |
   | Tương tác | Bấm được, đang chọn, đang focus | `--color-accent*`, `--color-focus-ring*` | Nút chính, link, vòng chọn, vòng focus, tab đang mở, điểm thả |
   | Trạng thái | Lỗi, cảnh báo, thành công | `--color-danger*`, `--color-warning*`, `--color-success*` | Badge, viền lỗi/cảnh báo, chữ thông báo, hộp cảnh báo. **Luôn có icon kèm theo** |
   | Loại | Loại bước (và nguồn biến) | `--step-<type>*` | Sọc trái 4 px, ô icon, nền thân khung, chip biến. **Không dùng cho trạng thái** |
   Mọi thứ còn lại (nền, panel, viền, chữ, chip số liệu, chip field) dùng màu **trung tính** (`gray`).
2. **Không chỉ dựa vào màu.** Loại bước có icon và nhãn chữ. Lỗi là ⊗ hình tròn, cảnh báo là ▲ tam giác. Bước tắt có viền
   nét đứt và tag "Đã tắt". Mỗi trạng thái khác các trạng thái còn lại ít nhất **hai kênh** (màu, viền, icon, nền, độ đậm).
3. **Hai lớp token.** Chỉ *primitive* chứa giá trị màu thô. Thành phần chỉ dùng token *ngữ nghĩa*. Theme tối là ánh xạ lại
   token ngữ nghĩa. Không thành phần nào tự rẽ nhánh theo theme.
4. **Gọn, rõ hơn trang trí.** Không gradient, không viền màu cho trang trí. Đổ bóng chỉ để phân tầng (thẻ, popup, hộp thoại).
5. **Font hệ thống**, không tải web font. Icon là SVG nội tuyến (mask CSS), không thêm thư viện.

## 2. Token primitive

Chỉ khối này có giá trị màu thô (cùng `--shadow-*` và `--color-backdrop`). Hue được chọn trong không gian OKLCH để các
loại bước cách đều nhau và cách xa màu trạng thái (xem §8).

| Họ | Bậc · giá trị |
| --- | --- |
| gray | 0 `#ffffff` · 25 `#f9fafc` · 50 `#f3f5f8` · 100 `#e8ebf0` · 200 `#d8dde3` · 300 `#bfc5cc` · 350 `#a5abb4` · 400 `#808790` · 500 `#6e757f` · 600 `#545c65` · 700 `#3d434b` · 800 `#292e35` · 850 `#1f2329` · 900 `#161a1f` · 950 `#0f1216` |
| blue (tương tác) | 50 `#f0f6ff` · 100 `#deeafe` · 200 `#c2d9ff` · 400 `#6ea4fe` · 500 `#3a81f6` · 600 `#2067da` · 700 `#1554b8` |
| red (lỗi) | 50 `#fff2f0` · 100 `#fee2de` · 200 `#fec9c2` · 400 `#ff7267` · 500 `#e24942` · 600 `#c52c2a` · 700 `#a61e1e` |
| amber (cảnh báo) | 50 `#fdf3e8` · 200 `#f5d1a5` · 300 `#fbc044` · 400 `#df9201` · 500 `#b67703` · 800 `#5c3a02` |
| green (thành công) | 50 `#edf9ef` · 200 `#b7e5bf` · 400 `#53be70` · 600 `#02853c` · 700 `#016e30` |
| teal (Record) | 50 `#e8faf5` · 100 `#c8f2e9` · 200 `#8be5d3` · 300 `#40d9c1` · 600 `#078e7d` · 700 `#05675a` |
| cyan (Query) | 50 `#e9f8ff` · 100 `#cbeffe` · 200 `#98ddf5` · 300 `#54c1e3` · 600 `#057da0` · 700 `#00617d` |
| olive (Chọn bản ghi) | 50 `#f5f7e8` · 100 `#e8ebc9` · 200 `#c5dc8e` · 300 `#b4d35c` · 600 `#656902` · 700 `#5a5d04` |
| violet (Lặp) | 50 `#f6f3ff` · 100 `#ebe3ff` · 200 `#dec3fe` · 300 `#b484e8` · 600 `#6941a1` · 700 `#663e9e` |
| magenta (Rẽ nhánh) | 50 `#fef1f6` · 100 `#ffddeb` · 200 `#ffbad7` · 300 `#f08dba` · 600 `#b33879` · 700 `#981c62` |

Tên CSS: `--gray-50`, `--blue-600`, `--teal-300`, … Bậc 300/200 của các họ loại bước dành cho theme tối.

## 3. Token ngữ nghĩa

Trong CSS, tên là `--color-<tên>` (trừ nhóm loại bước là `--step-*`). "mix X a%" nghĩa là
`color-mix(in srgb, var(--X) a%, var(--gray-850))` (nền nhạt ở theme tối).

### 3.1 Nền, viền, chữ

| Token | Sáng | Tối | Dùng cho |
| --- | --- | --- | --- |
| `--color-bg` | gray-50 `#f3f5f8` | gray-950 `#0f1216` | Nền trang, vùng canvas Quy trình |
| `--color-canvas-dot` | gray-200 | gray-800 | Chấm lưới canvas |
| `--color-surface` | gray-0 `#ffffff` | gray-900 `#161a1f` | Topbar, palette, inspector, kết quả, thanh lỗi, ô nhập, cột nhánh |
| `--color-surface-raised` | gray-0 `#ffffff` | gray-850 `#1f2329` | Thẻ bước, popup, hộp thoại |
| `--color-surface-sunken` | gray-25 `#f9fafc` | mix gray-950 50% / gray-900 = `#12161a` | Field card, đầu bảng, hàng bảng khi hover |
| `--color-surface-hover` | gray-100 `#e8ebf0` | gray-800 `#292e35` | Hover nút phụ/ghost/hàng menu, chip số liệu |
| `--color-border` | gray-200 `#d8dde3` | gray-800 | Đường chia, viền thẻ, viền panel |
| `--color-border-strong` | gray-300 `#bfc5cc` | gray-700 `#3d434b` | Viền nút phụ, chip field, thẻ khi hover, đường nối "+" |
| `--color-border-control` | gray-400 `#808790` | gray-500 `#6e757f` | Viền ô nhập/select/textarea (≥ 3:1) |
| `--color-text` | gray-900 `#161a1f` | gray-50 `#f3f5f8` | Chữ chính |
| `--color-text-muted` | gray-600 `#545c65` | gray-350 `#a5abb4` | Chữ phụ: tóm tắt thẻ, help, tiêu đề nhóm |
| `--color-text-disabled` | gray-400 | gray-600 | Chữ của control bị vô hiệu (không cần đạt tương phản) |
| `--color-bg-disabled` | gray-100 | gray-800 | Nền control vô hiệu, nền thẻ "Đã tắt" |
| `--color-inverse-bg` / `-text` | gray-850 / gray-50 | gray-100 / gray-900 | Toast |
| `--color-backdrop` | `rgb(8 10 14 / 0.5)` | như sáng | Nền mờ sau hộp thoại |
| `--color-minimap-off` (0014, dự kiến) | gray-400 `#808790` | gray-500 `#6e757f` | Khối bước tắt trên minimap Sơ đồ (3,63 / 3,39 : 1 trên `surface-raised`) |

### 3.2 Tương tác

| Token | Sáng | Tối | Dùng cho |
| --- | --- | --- | --- |
| `--color-accent` | blue-600 `#2067da` | blue-400 `#6ea4fe` | Nền nút chính, vòng chọn thẻ, gạch dưới tab đang mở, viền ô đang focus |
| `--color-accent-hover` | blue-700 `#1554b8` | blue-200 `#c2d9ff` | Nút chính khi hover |
| `--color-accent-subtle` | blue-50 `#f0f6ff` | mix blue-400 13% = `#293445` | Nền thẻ đang chọn, hàng menu đang chọn (bàn phím) |
| `--color-accent-subtle-strong` | blue-100 `#deeafe` | mix blue-400 24% = `#32425c` | Điểm thả đang nhắm, chớp sáng khi nhảy tới bước |
| `--color-accent-text` | blue-700 `#1554b8` | blue-200 | Link, nút link, tab đang mở, "+ Thêm bước đầu tiên" |
| `--color-accent-contrast` | gray-0 | gray-950 | Chữ trên nền accent (tối: chữ tối trên xanh sáng) |
| `--color-focus-ring` | blue-500 `#3a81f6` | blue-400 | Vòng focus bàn phím |
| `--color-focus-ring-inverse` | blue-400 | blue-600 | Vòng focus trên nền `inverse-bg` (nút "Hoàn tác" trong toast). Vòng thường chỉ đạt 2.09:1 trên toast tối |

### 3.3 Trạng thái

| Token | Sáng | Tối | Dùng cho |
| --- | --- | --- | --- |
| `--color-danger` | red-600 `#c52c2a` | red-400 `#ff7267` | Viền thẻ/ô lỗi, nền badge lỗi, nền nút xác nhận "Insert" |
| `--color-danger-hover` | red-700 | red-200 | Hover của các thành phần trên |
| `--color-danger-subtle` | red-50 `#fff2f0` | mix red-400 16% = `#433033` | Nền chip/ô lỗi, hover nút danger viền |
| `--color-danger-text` | red-700 `#a61e1e` | red-200 `#fec9c2` | Chữ lỗi, chữ nút danger viền |
| `--color-danger-contrast` | gray-0 | gray-950 | Chữ trên nền danger |
| `--color-warning` | amber-500 `#b67703` | amber-400 `#df9201` | Viền thẻ/ô cảnh báo, icon ▲ |
| `--color-warning-fill` | amber-300 `#fbc044` | amber-300 | Nền badge cảnh báo (chữ tối) |
| `--color-warning-subtle` | amber-50 `#fdf3e8` | mix amber-400 14% = `#3a3323` | Nền hộp cảnh báo (org production) |
| `--color-warning-text` | amber-800 `#5c3a02` | amber-200 `#f5d1a5` | Chữ cảnh báo, icon trong hộp cảnh báo |
| `--color-warning-contrast` | gray-900 | gray-950 | Chữ trên `warning-fill` |
| `--color-success` | green-600 `#02853c` | green-400 `#53be70` | Icon ✓ thành công |
| `--color-success-subtle` | green-50 | mix green-400 14% | Nền thông báo thành công |
| `--color-success-text` | green-700 `#016e30` | green-200 `#b7e5bf` | "insert 17" |
| `--color-success-contrast` | gray-0 | gray-950 | Chữ trên nền success |

Không có màu "info" riêng: thông tin trung tính dùng nền `surface`, icon ⓘ và chữ thường.

### 3.4 Loại bước

Mỗi loại có 4 token. Thành phần không dùng trực tiếp `--step-record`, mà dùng biến cục bộ `--c`, `--c-subtle`,
`--c-strong`, `--c-text`, do một luật `[data-type="<type>"]` duy nhất gán (xem §6.1).

| Loại (`type`) | Nhãn | Icon | Họ | `--step-<type>` (sọc, icon) | `-subtle` (ô icon, thân khung) | `-strong` (viền ô icon, viền cột) | `-text` (chữ màu loại) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `start` | Bắt đầu | ▷ play | gray | `#6e757f` / `#808790` | `#e8ebf0` / `#292e35` | gray-200 / gray-700 | `#3d434b` / `#d8dde3` |
| `record` | Record | ⊞ ô vuông có dấu + | teal | `#078e7d` / `#40d9c1` | `#e8faf5` / mix 10% | `#c8f2e9` / mix 20% | `#05675a` / `#8be5d3` |
| `query` (0006) | Query (đọc org) | trụ dữ liệu + kính lúp | cyan | `#057da0` / `#54c1e3` | `#e9f8ff` / mix 10% | `#cbeffe` / mix 20% | `#00617d` / `#98ddf5` |
| `pick` (0006) | Chọn bản ghi | ◎ hồng tâm | olive | `#656902` / `#b4d35c` | `#f5f7e8` / mix 10% | `#e8ebc9` / mix 20% | `#5a5d04` / `#c5dc8e` |
| `loop` | Lặp | ⟲ hai mũi tên vòng | violet | `#6941a1` / `#b484e8` | `#f6f3ff` / mix 10% | `#ebe3ff` / mix 20% | `#663e9e` / `#dec3fe` |
| `branch` | Rẽ nhánh | nhánh tách đôi | magenta | `#b33879` / `#f08dba` | `#fef1f6` / mix 10% | `#ffddeb` / mix 20% | `#981c62` / `#ffbad7` |

(Giá trị dạng sáng / tối. "mix 10%" = `color-mix(in srgb, var(--<họ>-300) 10%, var(--gray-850))`.)

Bắt đầu là trung tính vì nó không phải loại bước người dùng thêm vào. Loại bước chưa biết (từ workflow cũ hoặc bản
server mới hơn) không có luật `[data-type]` nên rơi về `--c: var(--color-border-strong)`, icon ⓘ.

**Chip biến (0005)** dùng màu theo **nguồn** của biến: `this.*` → màu của chính bước đang sửa (Record), `<alias>.*` → màu
loại của bước có alias đó (Record, Query, Chọn bản ghi), biến lặp → `loop`, `$n` → `start` (trung tính).

## 4. Thang đo

| Nhóm | Token | Giá trị | Dùng cho |
| --- | --- | --- | --- |
| Font | `--font-sans` | `system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif` | Mọi chữ |
| | `--font-mono` | `ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace` | Alias, ref, kbd, chip biến |
| Cỡ chữ (gốc 14 px) | `--text-xs` | 0.857rem = 12 px | Badge, chip, bảng, help, tiêu đề nhóm (chữ HOA) |
| | `--text-sm` | 0.929rem = 13 px | Nhãn form, tóm tắt thẻ, nút nhỏ, thông báo trong ô |
| | `--text-md` | 1rem = 14 px | Chữ thường, nút, tên loại trên thẻ |
| | `--text-lg` | 1.143rem = 16 px | Tiêu đề inspector |
| | `--text-xl` | 1.286rem = 18 px | Tiêu đề hộp thoại |
| Độ đậm | `--weight-regular/medium/semibold` | 400 / 500 / 600 | Chữ / nút, nhãn form / tên loại, tiêu đề, badge |
| Dòng | `--leading-tight/normal` | 1.25 / 1.45 | Tiêu đề / chữ thường |
| Khoảng cách | `--space-0-5/1/2/3/4/6/8` | 2 / 4 / 8 / 12 / 16 / 24 / 32 px | padding, gap, margin. `test/css-tokens.test.js` bắt mọi `padding*`, `margin*`, `gap`, `outline-offset` dùng token này (hoặc `0`, `auto`, `calc(-1 * var(--space-n))`, `--focus-offset*`, `--canvas-tail`). Ngoại lệ duy nhất: `margin: -1px` của `.sr-only` |
| | `--canvas-tail` | 64 px | Khoảng trống dưới dấu + cuối trên canvas ([0009](design/0009-bo-cuc-man-hinh.md): thanh lỗi không còn nổi, nên chỉ cần chỗ thở; trước là 160 px) |
| | `--issues-max-h` | `min(124px, 25vh)` | Chiều cao tối đa danh sách trong thanh lỗi (≈ 4 dòng), cuộn bên trong. Ngoài ra cả thanh (đầu + danh sách) cao tối đa 25 % cột giữa nhưng không thấp hơn đầu thanh (33 px), nên canvas giữ ≥ 75 % cột giữa (trừ phần hàng "Thu gọn/Mở tất cả") khi cột giữa cao từ ~132 px trở lên; thấp hơn nữa thì chỉ còn đầu thanh (`.issues { max-height: 25% }`, sửa sau review 0009) |
| | `--sheet-h` | `min(60dvh, calc(100dvh - 200px))` | Chiều cao bottom sheet (≤ 900 px); phần canvas bị sheet che (đo được, `--sheet-overlap`) là `scroll-padding-bottom` của canvas khi sheet mở. `dvh` để không lệch khi thanh địa chỉ di động co giãn; điện thoại xoay ngang 844 × 390 còn 190 px |
| | `--sheet-h-full` (0014, dự kiến) | `min(90dvh, calc(100dvh - var(--topbar-h, 89px)))` | Nấc **cao** của bottom sheet: không bao giờ che thanh trên (Org, Xem trước, Insert). 390 × 844: 755 px; 844 × 390: 301 px |
| | `--topbar-h`, `--sheet-now` (0014, dự kiến) | đo bằng JS | Chiều cao thanh trên (`main.js`, `ResizeObserver`, đặt trên `:root`); chiều cao sheet đang hiện (toast nằm trên nó) |
| | `--results-h` (0014, dự kiến) | mặc định `38vh`; JS đặt px trên `#results` | Chiều cao panel kết quả khi mở (người dùng kéo, nhớ ở `sfdg.resultsH` dạng tỉ lệ) |
| | `--results-min-h` / `--layout-min-h` (0014, dự kiến) | 160 px / 240 px | Panel kết quả thấp nhất; vùng `main` (palette hẹp + cột giữa) còn ít nhất `min(240px, 50 %)` |
| | `--resize-hit` / `--resize-hit-touch` (0014, dự kiến) | 8 px / 24 px | Vùng bấm tay nắm đổi cao panel (chuột: phủ mép; chạm: hàng trong luồng) |
| | `--grip-w` / `--grip-h` (0014, dự kiến) | 32 px / 4 px | Viên thuốc của tay nắm (panel kết quả, sheet) |
| | `--fade-w` (0014, dự kiến) | `var(--space-6)` = 24 px | Vùng mờ ở mép hàng cuộn ngang; `scroll-padding-inline` của hàng |
| | `--mask-fade-start/end/both` (0014, dự kiến) | `linear-gradient(…, transparent, black var(--fade-w) …)` | Mask mép mờ (trong khối token vì có `black`; không phải màu hiển thị) |
| | `--minimap-w` (0014, dự kiến) | 240 px (721–900 px: 200 px) | Bề rộng minimap Sơ đồ |
| | `--minimap-min-h` / `--minimap-max-h` (0014, dự kiến) | 32 px / 120 px | Chiều cao phần bản đồ của minimap |
| Icon (0014, dự kiến) | `--icon-xs` / `--icon-sm` / `--icon-md` | 12 / 14 / 16 px | Icon cạnh chữ 12 px (chip, nhãn làn, badge) / cạnh chữ 13 px (link, nhãn cột, số đếm thanh lỗi) / trong nút (mặc định `.ico`). Ô icon loại bước: 15 px trong ô 24 px |
| Bo góc | `--radius-sm` | 4 px | Alias trên thẻ, chip biến |
| | `--radius-md` | 6 px | Nút, ô nhập, field card, ô icon, cột nhánh |
| | `--radius-lg` | 10 px | Thẻ bước, khung, popup |
| | `--radius-xl` | 14 px | Hộp thoại, bottom sheet |
| | `--radius-pill` | 999 px | Badge, chip số liệu, chip field, tag "Đã tắt" |
| Kích thước | `--control-h-sm` / `--control-h-md` | 28 / 32 px | Nút nhỏ (view tools, toast) / nút và ô nhập thường |
| | `--hit-min` | 24 px | Vùng bấm nhỏ nhất (chip, badge, link). Màn hình cảm ứng: 44 px |
| | `--stripe-w`, `--ring-w`, `--focus-offset` | 4 / 2 / 2 px | Sọc loại, vòng chọn/focus, khoảng hở focus |
| | `--focus-offset-card` | `ring-w + focus-offset` = 4 px | Khoảng hở focus của thẻ bước: nằm ngoài vòng chọn 2 px, chừa 2 px trống nên focus và chọn không dính vào nhau |
| Đổ bóng | `--shadow-1` | `0 1px 2px rgb(16 24 40 / .08), 0 1px 3px rgb(16 24 40 / .06)` (tối: `0 1px 2px rgb(0 0 0 / .5)`) | Thẻ bước |
| | `--shadow-2` | `0 4px 12px rgb(16 24 40 / .14)` (tối `.55`) | Popup, toast |
| | `--shadow-3` | `0 12px 32px rgb(16 24 40 / .22)` (tối `.65`) | Hộp thoại, bottom sheet, bóng khi kéo |
| Lớp | `--z-sheet/popup/drag/toast` | 30 / 40 / 50 / 60 | Bottom sheet / popup / bóng kéo / toast. `dialog` dùng top layer |
| Chuyển động | `--dur-fast/base`, `--ease-out` | 120 / 200 ms, `cubic-bezier(.2,.8,.2,1)` | Hover, focus / sheet, toast. `prefers-reduced-motion: reduce` → 0 ms, bỏ animation chớp |

## 5. Icon

Lưới 24×24, nét 2 px, đầu tròn, vẽ riêng cho dự án (phong cách giống Lucide). Mỗi icon là một custom property
`--ico-<tên>: url("data:image/svg+xml,…")` trong khối token, hiển thị bằng `mask` nên lấy màu theo `currentColor`.
Icon chỉ để trang trí (`aria-hidden="true"`), nhãn chữ luôn có.

| Tên | Hình | Dùng cho |
| --- | --- | --- |
| `start` | tam giác play | Thẻ Bắt đầu, inspector workflow |
| `record` | ô vuông bo góc có dấu + | Record (tạo bản ghi mới) |
| `query` | trụ dữ liệu + kính lúp | Query (đọc từ org) |
| `pick` | hồng tâm | Chọn bản ghi |
| `loop` | hai mũi tên vòng | Lặp |
| `branch` | nhánh tách đôi | Rẽ nhánh |
| `error` | ⊗ vòng tròn có dấu × | Badge lỗi, chip lỗi, dòng lỗi |
| `warning` | ▲ tam giác có dấu ! | Badge cảnh báo, hộp cảnh báo, dòng cảnh báo |
| `success` | vòng tròn có dấu ✓ | Insert thành công |
| `info` | vòng tròn có chữ i | Thông tin, loại bước chưa biết |
| `off` | biểu tượng nguồn ⏻ | Tag "Đã tắt" |
| `stale` | đồng hồ | (tùy chọn) chip số liệu cũ |
| `theme` | vòng tròn tô nửa | Ô **Giao diện** thu gọn ở thanh trên ([0009](design/0009-bo-cuc-man-hinh.md)) |

**Icon thao tác ([0014](design/0014-hoan-thien-giao-dien.md)).** Thay mọi ký tự dùng làm icon. Hình ghi bằng lệnh SVG
trên lưới 24 (cùng nét 2 px, đầu tròn):

| Tên | Hình | Thay ký tự | Dùng cho |
| --- | --- | --- | --- |
| `more` | 3 chấm ngang | `⋯` | Menu ⋯ thanh trên, menu bước, ⋯ của thanh chọn và của mục thư viện |
| `chevron-right` / `chevron-down` / `chevron-up` / `chevron-left` | `M9 6l6 6-6 6` (xoay theo hướng) | `▸ ▾ ▴ ‹` | Thu gọn/mở khung và chi tiết field (phải = đóng, xuống = mở); nút `Kết quả` (xuống = mở, lên = thu gọn); "Ẩn tùy chọn" field; `Xong` của sheet; nút thư viện cạnh tên, `Bọc` của thanh chọn (xuống = mở menu) |
| `grip` | 6 chấm, 2 cột × 3 hàng | `⠿` | Tay nắm kéo trên thẻ |
| `undo` / `redo` | mũi tên cong trái / phải | `↶ ↷` | Hoàn tác / Làm lại |
| `refresh` | vòng tròn mở có mũi tên | `⟳` | Tải lại danh sách org, "Đọc lại" |
| `download` | mũi tên xuống chạm vạch | `⤓` | "Tải" (điện thoại), `Id` (0011) |
| `insert` | vạch trên, mũi tên lên | `⤒` | "Insert vào org" |
| `run` | tam giác **tô đặc** | `▶` | "Xem trước" (khác `start` viền rỗng) |
| `fit` | 4 góc chéo ra ngoài | `⤢` | Vừa khung (Sơ đồ) |
| `plus` / `minus` | dấu + / − | `+ − ＋` | "+" thêm bước, "Thêm bước đầu tiên", "Thêm field", thu phóng, "Workflow mới" (menu thư viện) |
| `x` | dấu × | `✕ ✗` | Xóa field; nhãn nhánh "Sai" |
| `check` | dấu ✓ | `✓` | Hàng menu chọn một; nhãn nhánh "Đúng" |
| `trash` | thùng rác | `✕` | Xóa bước (đầu inspector) |
| `duplicate` | hai ô chồng | `⧉` | Nhân bản |
| `options` | ba thanh trượt | `⚙` | Tùy chọn field |
| `arrow-up` / `arrow-down` | mũi tên thẳng | `↑ ↓` | Lên / Xuống field |
| `pin` | đinh ghim | `📌` | "giữ seed" |
| `minimap` | khung có ô nhỏ bên trong | — | Bật/tắt minimap Sơ đồ |
| `folder` | thư mục | `⇪` | "Mở file JSON…" (menu thư viện; thêm khi làm 0014, vì menu của 0012 có ký tự này) |
| (có sẵn) `off`, `info`, `error`, `warning` | | `⊘ ◉`, `ⓘ`, `✕` ô Id lỗi, `▲` | Tắt/bật bước (cả hai trạng thái), hộp thông tin, ô Id insert lỗi trong bảng, `Chưa lưu` / `Tab khác đã sửa` và tag `quá giới hạn` |

**Cỡ.** `--icon-xs` 12 px cạnh chữ 12 px (chip, badge, nhãn làn, tag, ô bảng), `--icon-sm` 14 px cạnh chữ 13 px (link ở
tóm tắt kết quả, nhãn cột Đúng/Sai, số đếm thanh lỗi, tab), `--icon-md` 16 px trong nút (mặc định của `.ico`), dòng lỗi và
hộp cảnh báo / thông tin. Ô icon loại bước giữ 15 px trong ô 24 px.

**Cách dùng.** Phần tử `<span class="ico" data-ico="<tên>" aria-hidden="true">` (JS: `ico('<tên>')` trong `dom.js`); mỗi
icon có một luật `.ico[data-ico="<tên>"] { --ico: var(--ico-<tên>); }`, **kể cả icon cũ**: thiếu luật thì `.ico` lấy `--ico`
kế thừa từ `[data-type]` gần nhất và vẽ nhầm icon loại bước. Không đặt `--ico` bằng `style`. Nút chỉ có icon phải có
`aria-label` bằng chữ. **Giữ là chữ:** mũi tên trong câu và tên phím (`Alt+↑`, `↑↓ chọn`), `→ acc#1`, `↓ accs` (tab Query),
`≤ · …`, `{x}`, `＋` trong `<option>` (không chứa được SVG).

## 6. Thành phần

### 6.1 Gán loại bước

```css
[data-type="record"] { --c: var(--step-record); --c-subtle: var(--step-record-subtle);
                       --c-strong: var(--step-record-strong); --c-text: var(--step-record-text); --ico: var(--ico-record); }
```

JS chỉ đặt `data-type="<step.type>"` lên `.step`, `.start-card`, `.palette-item`, `.popup-item` (menu thêm bước), tiêu đề
inspector (`.node-head`) và chip biến, rồi chèn `<span class="ico-tile" aria-hidden="true"><span class="ico"></span></span>`
bằng `icoTile()` (`client/js/dom.js`). Không còn bảng màu `NODE_COLORS` trong JS. Một luật chung `[data-type]` đứng trước
các luật riêng để loại chưa biết rơi về màu trung tính và icon `info`.

### 6.2 Nút

| Biến thể | Class | Dùng cho | Mặc định | Hover | Active | Focus-visible | Vô hiệu |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Chính | `.primary` | Một nút mỗi vùng: "▶ Xem trước" | nền `accent`, chữ `accent-contrast`, đậm 600 | nền `accent-hover` | như hover | vòng `focus-ring` 2 px, hở 2 px | nền `bg-disabled`, chữ `text-disabled`, không viền, `cursor: not-allowed` |
| Phụ (mặc định) | (không) | Mở…, Tải JSON, Hủy, + Thêm field | nền `surface`, viền `border-strong`, chữ `text`, 500 | nền `surface-hover` | nền `border` | như trên | như trên |
| Ghost | `.toolbar button`, `.view-tools button`, `button.icon` trên thẻ | Mới/Mở/Lưu/↶/↷, Thu gọn tất cả, ⋯, ▸ | trong suốt, không viền, chữ `text` (view tools: `text-muted`) | nền `surface-hover`, chữ `text` | nền `border` | như trên | chữ `text-disabled`, nền trong suốt |
| Nguy hiểm (mở xác nhận) | `.danger` | "⤒ Insert vào org" ở topbar | nền `surface`, viền `danger`, chữ `danger-text` | nền `danger-subtle` | như hover | như trên | **mất màu đỏ**: như vô hiệu chung |
| Nguy hiểm (xác nhận cuối) | `.danger.solid` (hoặc `dialog .actions .danger`) | "Insert" trong hộp xác nhận, "Xóa" khung có bước con | nền `danger`, chữ `danger-contrast`, 600 | nền `danger-hover` | như hover | như trên | như vô hiệu chung |
| Link | `.link` | "📌 giữ seed" | chữ `accent-text`, 600, không nền | gạch chân | — | như trên | chữ `text-disabled` |

Cao 32 px (`--control-h-md`), nhỏ 28 px. Padding ngang 12 px (nút ghost của thanh công cụ: 8 px, để thanh trên vừa một
hàng ở 1440 px), nút icon tối thiểu 32×32 px. Hover **không** dùng viền accent
(viền accent dành cho chọn/focus).

### 6.3 Ô nhập, select, textarea

| Trạng thái | Nền | Viền | Khác |
| --- | --- | --- | --- |
| Mặc định | `surface` | 1 px `border-control` | Cao 32 px, placeholder `text-muted` |
| Focus | `surface` | `accent` + vòng `focus-ring` 2 px hở 2 px | — |
| Lỗi (`.invalid`) | `danger-subtle` | `danger` + bóng trong 1 px `danger` | Dòng help đổi thành câu lỗi, màu `danger-text` |
| Vô hiệu | `bg-disabled` | `border` | Chữ `text-disabled` |

Nhãn form: 13 px, 500, màu `text` (không còn màu muted). Help: 12 px `text-muted`.

### 6.4 Thẻ bước (`.step-card`)

Bố cục: `[⠿] [ô icon 24 px] Tên loại · alias · tóm tắt … [chip số liệu] [badge] [Đã tắt] [⋯] [▸]`. Cao tối thiểu 44 px,
bo 10 px, sọc trái 4 px `--c`, nền `surface-raised`, viền 1 px `border`, bóng `shadow-1`. Alias: mono 12 px, chữ
`--c-text` trên nền `--c-subtle`. Tóm tắt: 13 px `text-muted`.

| Trạng thái | Kênh 1 | Kênh 2 | Kênh 3 |
| --- | --- | --- | --- |
| Mặc định | viền `border` | sọc + ô icon màu loại | — |
| Hover | viền `border-strong` | hiện tay nắm ⠿ | — |
| Đang chọn | vòng ngoài 2 px `accent` (box-shadow) | nền `accent-subtle` | tay nắm hiện. Chọn nhiều ([0012](design/0012-nang-suat-soan-thao.md) B): **mọi** thẻ được chọn cùng kiểu này và `aria-selected="true"`; bước chính là điểm Tab (roving tabindex) và có thêm vòng focus khi focus bàn phím; `role="tree"` có `aria-multiselectable="true"` |
| Focus bàn phím | thêm outline 2 px `focus-ring`, **hở 4 px** (`--focus-offset-card`, ngoài vòng chọn sát thẻ) | — | — |
| Lỗi | viền 2 px `danger` (viền + bóng trong) | badge `⊗ n` nền `danger` | sọc loại giữ nguyên |
| Cảnh báo (không có lỗi) | viền 1 px `warning` | badge `▲ n` nền `warning-fill`, chữ tối | — |
| Đang chọn + lỗi | vòng ngoài `accent`, viền trong `danger` | nền `accent-subtle` | badge |
| Đã tắt | nền `bg-disabled`, **viền và sọc nét đứt**, không bóng | tag `⏻ Đã tắt` | tên loại, alias, ô icon chuyển `text-muted`. **Không dùng opacity**, để badge lỗi vẫn đọc được |
| Nguồn đang kéo | opacity 0.5 | viền nét đứt, không bóng | — |
| Chớp khi nhảy tới | nền `accent-subtle-strong` → `surface-raised` trong 0.6 s | — | Giảm chuyển động: giữ nền, không animation |
| Nguồn của chip đang rê / focus (`.is-ref-target`, [0012](design/0012-nang-suat-soan-thao.md) I) | outline 2 px **nét đứt** `accent`, hở 2 px (khác vòng chọn liền nét và vòng focus) | `title` của chip có `Nguồn: Record "acc"` | Không cuộn, không đổi lựa chọn; chip đỏ không tô |

Badge là nút: cao 22 px, rộng tối thiểu 24 px, icon 13 px + số, 12 px, 600. Hover và nhấn (`:active`, kể cả bằng bàn phím) cùng
nền đậm hơn (`danger-hover` / `warning`), không về nền xám của nút thường. Tag "Đã tắt": viền `border-strong`, chữ
`text-muted`, icon `off`.

**Chip số liệu** (`.stat`): nền `surface-hover`, chữ `text`, 12 px, số dạng `tabular-nums`. Cũ (`.stale`): nền trong suốt,
viền nét đứt `border-strong`, chữ `text-muted` nghiêng. Trên thẻ "Đã tắt" (nền `bg-disabled` trùng `surface-hover`) chip có
nền `surface` và viền `border-strong` để không chìm. Không dùng màu accent, vì chip này không bấm được và không phải
trạng thái chọn.

**Chip ước tính** (`.stat.est`, [0012](design/0012-nang-suat-soan-thao.md) H): chỉ trên thẻ Record khi chưa chạy hoặc kết quả đã cũ;
như `.stat` nhưng nền trong suốt, viền 1 px **nét đứt** `border`, chữ `text` (không nghiêng: không phải dữ liệu cũ). `12 bản ghi`
(chắc chắn) hoặc `≈ 12,5 bản ghi`; `title` có khoảng. Thẻ Bắt đầu ghi `≈ 1.250 bản ghi · ≤ 50.000` trong tóm tắt; ước tính vượt
giới hạn thì thêm tag `▲ Ước tính vượt giới hạn` (`.tag-est-over`: viền `warning`, nền `warning-subtle`, chữ `warning-text`).

**Khi đang chạy** ([0012](design/0012-nang-suat-soan-thao.md) D): chip `.stat.live` (như `.stat`, `tabular-nums`, không animation,
không `aria-live` trên thẻ) ghi số của lượt đang chạy; khi insert, thẻ Record ghi `insert 1 200/5 000`. **Tag lỗi insert**
(`.tag-insert-err`, là nút): icon ⊗ + `lỗi 3`, chữ `danger-text`, viền 1 px `danger`, nền `danger-subtle` (khác badge validate nền
đỏ đặc); `aria-label`/`title` `3 bản ghi của bước này insert lỗi. Bấm để xem nhóm lỗi.`; workflow đổi sau đó ⇒ `.stale` (viền nét
đứt, chữ nghiêng). Bấm: tab "Lỗi insert", dòng nhóm đầu của bước có `.current` (nền `accent-subtle`, viền trên/dưới `accent`) và
focus. Khung thu gọn ghi thêm `· lỗi insert 12`. Ở Quy trình tag là nút Tab tới được; ở Sơ đồ tag có `tabindex="-1"` (cây chỉ có
một điểm Tab, như badge) nên **không tới được bằng bàn phím**: đường bàn phím là tab "Lỗi insert" của panel kết quả (dòng nhóm là
`role=button`, Enter / Space chọn bước), và toast cuối lần insert nhắc tab đó.

**Điện thoại (≤ 720 px, [0014](design/0014-hoan-thien-giao-dien.md), dự kiến):** hàng thẻ không bao giờ rộng hơn thẻ; `⋯` và
chevron luôn thấy. Tag `chưa chọn org` ẩn (badge ▲ và thanh lỗi đã nói cùng điều). Thứ tự co: tóm tắt → chip số liệu
(`min-width: 3em`, cắt `…`, `title` đủ câu) → alias (tối đa 72 px). Nhãn loại, badge, nút không co.

### 6.5 Khung (Lặp, Rẽ nhánh) và ô con

| Phần | Quy tắc |
| --- | --- |
| Thân khung (`.step-body`) | Nền `--c-subtle`, viền `border`, sọc trái 4 px `--c`, bo dưới 10 px. Thẻ đầu khung không có bóng (trừ khi đang chọn) |
| Ghi chú thu gọn | Như thân, chữ 13 px `text-muted`: "3 bước bên trong" |
| Cột nhánh (`.columns .slot`) | Nền `surface`, viền 1 px `--c-strong`, bo 6 px |
| Nhãn cột | 13 px, 600, màu `--c-text` (màu Rẽ nhánh), kèm ký hiệu `✓ Đúng` / `✗ Sai`. **Không** dùng xanh lá / đỏ |
| Ô trống | Nút nét đứt, chữ `text-muted`. Hover: viền `accent`, nền `accent-subtle`, chữ `accent-text` |
| Ô có lỗi / cảnh báo (`slot-error/warning`) | Outline 2 px nét đứt `danger` / `warning`, câu thông báo 13 px `danger-text` / `warning-text` trong ô |

### 6.6 Điểm thêm "+" và kéo thả

| Trạng thái | Quy tắc |
| --- | --- |
| Đường nối | 2 px `border-strong` |
| Nút "+" mặc định | Tròn 22 px (vùng bấm 34 px), nền `surface`, viền `border-strong`, chữ `text-muted`, opacity 0.7 |
| Hover / focus | Nền `accent`, chữ `accent-contrast`, opacity 1 (+ vòng focus khi dùng bàn phím) |
| Đang kéo: điểm thả | Thanh nét đứt 2 px `border-strong`, cao 24 px |
| Điểm thả đang nhắm | Viền liền `accent`, nền `accent-subtle-strong` |
| Không thả được | Ẩn (`visibility: hidden`) |

### 6.7 Palette và menu thêm bước

| Thành phần | Mặc định | Hover | Đang chọn (bàn phím) |
| --- | --- | --- | --- |
| Mục palette | Ô icon + tên (14 px, 500) + mô tả (12 px `text-muted`), viền `border`, nền `surface` | viền `--c`, nền `--c-subtle` | vòng focus |
| Mục mẫu | Không ô icon, như mục palette | nền `surface-hover` | vòng focus |
| Hàng menu (`.popup-item`) | Ô icon (nếu là loại bước) + nhãn 500 + mô tả 12 px + kbd mono | nền `surface-hover` (trung tính) | nền `accent-subtle` + vạch trái 2 px `accent` |
| Hàng menu nguy hiểm | chữ `danger-text` | như trên | như trên |
| Tiêu đề nhóm | 12 px HOA, 600, `text-muted`, giãn chữ 0.05em | — | — |

Màn hình hẹp (≤ 900 px): palette là hàng nút ngang gồm ô icon + tên (cuộn ngang khi không đủ chỗ). Mục **Mẫu** không có ở
hàng này mà nằm trong nhóm **Mẫu** của menu **⋯** ở thanh trên.

Popup dùng chung (`client/js/popup.js`, [0009](design/0009-bo-cuc-man-hinh.md)): menu "+", menu bước, menu **⋯**, menu
`⤓ Tải`. Ngoài hàng thường còn hàng chọn một (`role="menuitemradio"`, `aria-checked`, dấu ✓ màu `accent-text`) và hàng ô
nhập (`.popup-field`: nhãn 13 px + ô nhập, ví dụ Seed). ↑/↓ đi qua cả hàng lẫn ô nhập; gõ một chữ cái nhảy tới hàng bắt đầu
bằng chữ đó, trừ khi đang ở trong ô nhập; Esc, Tab và Shift+Tab đóng và trả focus về nút mở (menu ⋯ mở từ chip
`Seed n` thì về chip). ARIA: trong `role="menu"` chỉ có hàng menu và `role="group"` (mỗi tiêu đề nhóm một group, tên là
`aria-label`); tiêu đề popup và tiêu đề nhóm là chữ `aria-hidden`; ô nhập luôn nằm trong một group.

### 6.8 Inspector

| Phần | Quy tắc |
| --- | --- |
| Đầu | Ô icon loại bước (thay chấm tròn) + tiêu đề 16 px 600 + nút ghost (tắt/bật, nhân bản) + nút xóa dạng `.danger` icon |
| Mô tả | 13 px `text-muted` |
| Tiêu đề nhóm (FIELDS (2)) | 12 px HOA 600 `text-muted` |
| Field card | Nền `surface-sunken`, viền `border`, bo 6 px. Nút ↑ ↓ ⚙ × là ghost 28 px. Lỗi: viền 2 px `danger`, câu lỗi 13 px `danger-text` |
| Bottom sheet (≤ 900 px, [0009](design/0009-bo-cuc-man-hinh.md) §3) | Nền `surface`, bo trên 14 px, `shadow-3`, `--z-sheet`, cao `--sheet-h`. Chỉ ở màn hình hẹp: mở khi có bước được chọn (thu hẹp cửa sổ không tự bật sheet). `body.sheet-open` cho canvas `scroll-padding-bottom: var(--sheet-overlap)` và phần đệm cuối cùng chiều cao; `--sheet-overlap` = đáy canvas − đỉnh sheet, `inspector.js` đo lại khi mở sheet, khi đổi kích thước cửa sổ và khi canvas đổi cao (thanh lỗi), nên thẻ đang chọn (kể cả khi tới từ thanh lỗi) nằm trọn giữa palette và mép sheet. Sheet đóng thì `inert`: focus đang trong sheet chuyển về thẻ đang chọn, gõ phím không sửa được form ẩn. Hàng `‹ Xong` (`.sheet-head`) dính trên cùng (`position: sticky`, nền `surface`, đường `border` dưới). Bấm Xem trước / Insert thì sheet đóng (giữ bước đang chọn); chạm lại thẻ đang chọn thì mở lại; chạy lỗi validate thì mở ở bước lỗi. Toast nằm trên mép sheet |
| Sheet hai nấc ([0014](design/0014-hoan-thien-giao-dien.md), dự kiến) | **Vừa** = `--sheet-h`, **cao** = `--sheet-h-full` (chừa thanh trên). Luôn mở ở nấc vừa; F8 / dòng lỗi / chạy lỗi validate về nấc vừa. Tay nắm `.sheet-grip` giữa hàng `‹ Xong`: `<button aria-expanded aria-controls="inspector" aria-label="Mở rộng bảng cấu hình">`, vùng bấm 64 × 44 px, viên thuốc `--grip-w` × `--grip-h` màu `border-control`; chạm / Enter / Space đổi vừa ↔ cao. Kéo ở bất kỳ chỗ nào của `.sheet-head` trừ nút `Xong` (quá 8 px mới là kéo): thả thì vuốt nhanh (> 0,5 px/ms) sang nấc kế, chậm thì về nấc gần nhất; dưới ½ nấc vừa là đóng (như `Xong`). Chuyển nấc `height` `--dur-base`; giảm chuyển động: 0 ms. Ở nấc cao thẻ đang chọn bị che (không đo `--sheet-overlap`); về nấc vừa thì thẻ lại lên mép sheet |
| Popup trong sheet (≤ 720 px) | Bảng chọn biến (0005) rộng `100vw − 2 × space-2`, neo trái 8 px, cao tối đa `min(360px, 45dvh)`, lật lên trên ô nếu dưới không đủ chỗ |

### 6.9 Chip

| Chip | Nền | Viền | Chữ | Lỗi | Khác |
| --- | --- | --- | --- | --- | --- |
| Chip field (`.field-chip`, bấm được) | `surface-raised` | 1 px `border-strong`, pill | 12 px `text` | nền `danger-subtle`, viền `danger`, chữ `danger-text`, icon ⊗ | Cảnh báo: viền `warning`, nền `warning-subtle` |
| Chip biến (0005, `.var-chip`) | `surface-raised` | 1 px `border-strong` + **viền trái 3 px `--c`**, bo 4 px | mono 12 px; phần nguồn (`acc`) màu `--c-text`, 600; có icon nhỏ của loại nguồn | nền `danger-subtle`, viền và viền trái `danger`, icon ⊗ | Chưa khớp nguồn (đang gõ): viền nét đứt `border-control`, chữ `text-muted` nghiêng, không màu loại |
| Chip số liệu / tóm tắt kết quả | `surface-hover` | không | 12 px `text`, `tabular-nums` | — | Cũ: xem 6.4 |

### 6.10 Kết quả, tab, bảng

| Thành phần | Quy tắc |
| --- | --- |
| Đầu panel ([0009](design/0009-bo-cuc-man-hinh.md) §4) | **Một hàng ở mọi chiều rộng**, cao 48 px: `[Kết quả ▾] [tóm tắt (co giãn)] [nút]`. Nút `Kết quả` không xuống dòng, có `aria-expanded` và ▾ (đang mở) / ▴ (đang thu gọn). Ở ≤ 720 px tóm tắt một dòng, cuộn ngang; `Tải JSON` và `Tải CSV (tab hiện tại)` gộp thành nút `⤓ Tải` (`aria-haspopup="menu"`) mở popup hai mục gọi đúng hai nút đó (khóa khi chúng khóa) |
| Tay nắm đổi cao ([0014](design/0014-hoan-thien-giao-dien.md), dự kiến) | `.results-resize` `role="separator"` (`aria-orientation="horizontal"`, `aria-controls="results-body"`, `aria-label="Chiều cao panel kết quả"`, `aria-valuemin/max/now` = % chiều cao dưới thanh trên, `aria-valuetext` "Cao 312 px (37 % màn hình)", `tabindex="0"`), phần tử đầu của `#results`. Chuột: vùng `--resize-hit` phủ mép trên (−4 … +4 px), `z-index: 1`, `cursor: row-resize`. Chạm (`pointer: coarse`): hàng trong luồng cao `--resize-hit-touch`, `.results-head` bỏ padding trên. Viên thuốc `--grip-w` × `--grip-h`. Trạng thái: mặc định viên thuốc `border-control`, mép 1 px `border`; hover viên thuốc `text-muted`, mép 2 px `border-strong`; đang kéo viên thuốc và mép 2 px `accent`, `body.resizing`; focus: vòng `focus-ring` quanh vùng 48 × 16 px. Phím ↑/↓ 16 px, Shift 64 px, Home thấp nhất, End cao nhất, Enter thu gọn/mở; nhấp đúp về 38 %. Kéo quá `--results-min-h` 48 px rồi thả: thu gọn (chiều cao đã nhớ giữ nguyên). Ẩn khi thu gọn hoặc khi khoảng đổi < 24 px (844 × 390) |
| Hàng tab | Không xuống dòng; nhiều tab thì cuộn ngang (`overflow-x: auto`, ẩn thanh cuộn để không ăn vào chiều cao `--tabs-h`); mép còn tab mờ dần (§6.14). Tab đang mở luôn được cuộn vào tầm nhìn |
| Tab | Không viền khung. Mặc định chữ `text-muted`. Đang mở: chữ `accent-text` 600 + gạch dưới 2 px `accent`. Hàng tab có đường `border` bên dưới |
| Tab "Lỗi insert (n)" (`.tab-issues`) | Như tab, thêm icon ▲ màu `warning` (icon SVG thay ký tự ⚠) |
| Bảng | Chữ 12 px, `tabular-nums`, viền `border`, đầu bảng nền `surface-sunken` 600, hàng hover nền `surface-sunken`. Hàng tab và đầu bảng dính khi cuộn; đầu bảng dính ngay dưới hàng tab (`top: var(--tabs-h)`, = 4 + 32 + 1 px, không hở) |
| Ô `ref` (`acc#1`, `→ acc#1`) | Mono, màu `--step-record-text` (là tham chiếu tới bản ghi, không phải link) |
| `null` | `—` màu `text-muted` |
| Kết quả insert | `insert 17` màu `success-text`, `lỗi 2` màu `danger-text` |
| Đang chạy ([0004](design/0004-streaming-execution.md), chỗ chừa của [0009](design/0009-bo-cuc-man-hinh.md) §4) | Tóm tắt thành dòng tiến độ (`Đang insert vào dev: 12 400/200 000 (6 %) · lỗi 3 · còn khoảng 14 phút` + chip `<sObject> đã insert/tổng`). Ô nút tải đổi thành nút **Dừng** (`button.danger` viền đỏ; khóa khi đang dừng). `<progress class="run-progress">` cao 3 px, `position: absolute` sát mép dưới `.results-head` (không thêm hàng): rãnh `border`, phần đã chạy `accent`; không có giá trị thì là thanh chạy qua lại (xem trước) |
| Bảng bị cắt | Câu `Hiển thị 200/160 000 dòng đầu. Tải CSV/JSON để lấy đủ.` (`.hint.table-more`) dưới bảng |
| Tab "Lỗi insert" | Bảng nhóm lỗi (`table.error-groups`): sObject, Bước, Lỗi (`danger-text`, xuống dòng), Số bản ghi (căn phải), Ví dụ. Hàng có bước: `cursor: pointer`, Tab tới được, Enter/bấm chọn bước và field; focus nền `accent-subtle`. Dưới bảng là `<details>` "Chi tiết từng bản ghi" (1 000 dòng đầu) |

### 6.11 Hộp thoại, hộp cảnh báo, toast, danh sách lỗi

| Thành phần | Quy tắc |
| --- | --- |
| Hộp thoại | Nền `surface-raised`, viền `border`, bo 14 px, padding 24 px, `shadow-3`, backdrop `--color-backdrop`. Tiêu đề 18 px 600. Nút: phụ bên trái, chính/nguy hiểm bên phải |
| Hộp xác nhận Insert | Nút cuối "Insert" là **nguy hiểm đặc** (`.danger.solid`), "Hủy" là nút phụ |
| Hộp cảnh báo (`.warn-box`) | Nền `warning-subtle`, viền 1 px `warning` + viền trái 4 px, icon ▲ màu `warning-text`, chữ `text`, bo 6 px |
| Toast | Nền `inverse-bg`, chữ `inverse-text`, bo 6 px, `shadow-2`, `--z-toast`. Nút trong toast viền `currentColor`, nhấn không đổi nền, vòng focus `focus-ring-inverse`. Có thể có hai nút và không tự tắt (`"…" vừa được sửa ở một tab khác.` [Dùng bản ở tab kia] [Giữ bản của tab này], 0012 A). Hộp thoại đang mở che toast: thao tác cần "Hoàn tác" trong hộp thoại thì hộp có dòng riêng (`.lib-undo`) |
| Khung gợi ý (`.hint-box`, [0012](design/0012-nang-suat-soan-thao.md) F2) | Nền `accent-subtle`, viền 1 px `accent` + viền trái `--stripe-w`, bo 6 px, chữ 13 px `text`; câu bên trái, nút bên phải (xuống dòng khi hẹp): nút chính `Thêm n field`, `Chọn…`, `Bỏ qua`. `role="status"`. Khác `.warn-box`: là gợi ý, không phải lỗi |
| Thanh chọn (`.select-bar`, [0012](design/0012-nang-suat-soan-thao.md) B) | Chỉ trong chế độ chọn (`body.select-mode`, ≤ 900 px hoặc cảm ứng, từ ⋯ → `Chọn nhiều bước`): dính đáy, cao 56 px, chỗ của bottom sheet (sheet đóng), nền `surface`, viền trên `border`, `shadow-3`; `role="toolbar"`, `aria-label="Thao tác với các bước đã chọn"`. `[n đã chọn] [Bọc ▾] [Xóa] [⋯] [Xong]` (≈ 280 px, vừa 360 px); nút cao 32 px. Toast nằm trên thanh; tay nắm ⠿ ẩn (chạm thẻ là chọn / bỏ chọn) |
| Hộp "Quản lý thư viện" ([0012](design/0012-nang-suat-soan-thao.md) A) | Danh sách `.lib-list` (cuộn trong hộp, tối đa 60vh): ô tên sửa tại chỗ, `n bước · giờ · dung lượng` (12 px `text-muted`, `tabular-nums`), [Mở] [Nhân bản] [Tải JSON] [Xóa]; mục đang mở nền `accent-subtle`. ≤ 720 px: hộp rộng hết màn hình, mỗi mục hai dòng, Nhân bản / Tải JSON / Xóa vào nút `⋯` của mục. Dòng chú thích nói origin và dung lượng đã dùng |
| Nút thư viện `▾` và `▲ Chưa lưu` (thanh trên) | `▾` (`#btn-library`, 32 × 32 px) dính bên phải ô tên (bỏ bo góc giữa hai phần), `aria-haspopup="menu"`, `aria-expanded`. `▲ Chưa lưu` chỉ khi bộ nhớ trình duyệt đầy: nền `warning-subtle`, viền `warning`, chữ `warning-text`, bấm mở hộp Quản lý thư viện |
| Thanh lỗi (`#issues.issues`, [0009](design/0009-bo-cuc-man-hinh.md) §1) | **Trong luồng** của cột giữa, ngay dưới canvas (không `position: absolute`, không bóng, không bo góc), nên không bao giờ che thẻ: canvas co lại đúng bằng chiều cao thanh. Cao tối đa 25 % cột giữa (tối thiểu bằng đầu thanh), không tràn xuống dưới đầu panel kết quả. Nền `surface`, viền trên `border`, sọc trái 4 px `danger` (hoặc `warning` khi chỉ có cảnh báo, `.only-warnings`). `role="region"`, `aria-label="Lỗi và cảnh báo"`; ẩn khi không có gì |
| Đầu thanh lỗi (`.issues-head`) | Cao 32 px: số đếm `2 lỗi · 1 cảnh báo` (600, 13 px, icon ⊗ / ▲ từng phần, `aria-live="polite"`, chỉ viết lại khi nhãn đổi để không đọc lại sau mỗi lần validate), gợi ý `Bấm một dòng để tới bước · F8: lỗi tiếp theo` (12 px `text-muted`, ẩn ở ≤ 720 px), nút ghost `Thu gọn` / `Hiện (n)` (`aria-expanded`, `aria-controls="issues-list"`). Thu gọn: sau số đếm là dòng lỗi đầu, một dòng, cắt `…`; bấm vào thì tới bước đó |
| Dòng lỗi (`.issue`) | Icon ⊗ đỏ hoặc ▲ hổ phách (khác **hình**, không chỉ khác màu) + `[alias] câu lỗi`. Danh sách cao tối đa `--issues-max-h`, cuộn bên trong. Dòng vừa tới bằng F8 / bấm: nền `accent-subtle` + vạch trái 2 px `accent` (`.current`) |

### 6.12 Trạng thái rỗng

| Chỗ | Quy tắc |
| --- | --- |
| Workflow rỗng | Thẻ Bắt đầu + nút nét đứt "+ Thêm bước đầu tiên" viền `accent`, chữ `accent-text` |
| Inspector chưa chọn gì | Chữ `text-muted`, căn giữa |
| Kết quả chưa chạy | "Chưa chạy." `text-muted` |

### 6.13 Sơ đồ (`.canvas`, [0003](design/0003-process-mode.md) đợt B)

| Phần | Quy tắc |
| --- | --- |
| Nút chế độ `.view-switch` | Cặp nút liền ở đầu hàng "Thu gọn/Mở tất cả" (không nằm ở thanh trên, để giữ ngân sách chiều rộng của 0009). Nút đang chọn: nền `accent-subtle`, chữ `accent-text`, `aria-pressed="true"` |
| Khung nhìn `.canvas` | Nền `bg` + chấm `canvas-dot` như Quy trình; chấm co giãn và trôi theo pan/zoom. Con trỏ `grab` / `grabbing` |
| Đường nối `.dg-lines` | Một `<path>` SVG, nét `border-strong` 2 px; chấm gộp nhánh `.dg-dots` cùng màu |
| Thẻ `.dg-card` | Dùng chung `.step-card` (§6.4: viền, sọc loại bước, chọn, lỗi, badge, chip, `Đã tắt`), kích thước cố định 210 × 76 px, ba hàng: loại + badge + ⋯; alias + tóm tắt; chip / tag (nhãn loại không bị cắt, kể cả "Query (đọc org)"). Bước tắt: `.is-disabled` (cùng luật với `.step.disabled > .step-card`) |
| Khung `.dg-frame` + đầu khung `.dg-head` | Khung nền `--c-subtle`, sọc trái `--c`; đầu khung là một `.step-card` một hàng rộng cả khung |
| Nhãn làn `.dg-lane-label` | `text-xs`, đậm, màu `--c-text` của loại bước cha; "✓" / "✗" như §6.5 |
| "+" và ô rỗng | Như §6.6 (`.add-btn`, `.slot-empty`, `.add-first`); khi kéo mục palette, "+" gần nhất được tô `accent` |
| Ô con lỗi `.dg-slot` | Viền nét đứt `danger` / `warning` quanh thân khung hoặc làn (cùng `.slot-error` / `.slot-warning`) |
| Thu phóng `.dg-zoom` | Nhóm nút góc trên phải khung nhìn (không bị bottom sheet che): − · 100% · + · ⤢ (· nút minimap, 0014); nền `surface-raised`, bóng 1 |
| Minimap `.dg-minimap` ([0014](design/0014-hoan-thien-giao-dien.md), dự kiến) | Góc **dưới phải** khung nhìn, cách `--space-2`; hộp như `.dg-zoom` (nền `surface-raised`, viền `border`, bo `--radius-md`, bóng 1, padding `--space-1`), rộng `--minimap-w`, phần bản đồ cao `clamp(--minimap-min-h, cao sơ đồ × tỉ lệ, --minimap-max-h)`. Tỉ lệ `max(vừa hộp, 0,05)`: sơ đồ dài hơn thì bản đồ là cửa sổ đi theo khung nhìn, kèm rãnh tổng quan 6 px (`surface-hover`, con trượt `accent` ≥ 6 px). Một `<svg aria-hidden>`, một `<path>` mỗi nhóm (≤ 16): khung `[data-type]` nền `--c-subtle` nét 1 px `--c`; thẻ nền `--c`; bước tắt nền `--color-minimap-off`; lỗi: vòng nét 2 px `danger` bao ngoài khối; đang chọn: khối `accent` trên quầng `surface-raised` 2 px; khung nhìn: chữ nhật rỗng nét 2 px `accent` trên quầng 4 px `surface-raised` (accent chỉ 1,07–1,48 : 1 so với màu loại, quầng giữ ≥ 5,2 : 1), cắt theo cửa sổ để luôn đủ 4 cạnh. `vector-effect: non-scaling-stroke`; không vẽ đường nối. Bấm: căn giữa tới đó; kéo: khung nhìn theo con trỏ (cửa sổ đứng yên tới khi thả); rãnh: đi xa; lăn chuột: không làm gì. Hiện khi bật **và** sơ đồ lớn hơn khung nhìn **và** sheet đóng; không có ở ≤ 720 px và ≤ 900 × 500. Nút `#btn-minimap` (icon `minimap`, `aria-pressed`, `aria-controls`; đang bật nền `accent-subtle`, icon `accent-text`), nhớ `sfdg.minimap`. `showRect` coi minimap là vùng bị che (như thanh thu phóng) |

Ba lớp vẽ theo thứ tự DOM (khung, đường nối, thẻ), không có `z-index` trong CSS. Riêng trong lớp khung (`.dg-under`, một
stacking context nhờ `isolation: isolate`), mỗi khung và ô con có `z-index` inline theo cấp lồng (khung `2 × cấp`, ô con
`2 × cấp + 1`) để khung trong luôn nằm trên khung ngoài dù phần tử được tạo theo thứ tự nào (chỉ phần gần khung nhìn được
tạo). Ở ≤ 900 px nút trên thẻ và thanh thu phóng là 32 px; ở điện thoại (≤ 720 px, hoặc ≤ 900 × 500) thanh thu phóng chỉ còn
⤢ (chụm hai ngón để thu phóng).

### 6.14 Hàng cuộn ngang ([0014](design/0014-hoan-thien-giao-dien.md), dự kiến)

| Phần | Quy tắc |
| --- | --- |
| Áp dụng | `.palette` (≤ 900 px), `#results-summary` (≤ 720 px), `.tabs`, và mọi hàng mới có `data-scroll-x` |
| Dấu hiệu | `watchOverflow(el)` (`dom.js`) đặt `data-overflow="start" \| "end" \| "both"` (bỏ khi không tràn; theo cuộn, đổi kích thước, đổi nội dung). CSS: `mask-image: var(--mask-fade-…)`, mép phía còn mục mờ dần trong `--fade-w`. Không thêm phần tử, không đổi màu, đúng ở hai theme |
| Focus | `scroll-padding-inline: var(--fade-w)`: mục được Tab tới dừng ngoài vùng mờ |
| Con lăn | Lăn dọc trên hàng đang tràn thì cuộn ngang; chỉ `preventDefault` khi hàng còn cuộn được theo hướng đó |
| Không dùng | Nút ‹ › hai đầu; hiện lại thanh cuộn (ăn vào `--tabs-h`) |

## 7. Bố cục và tầng nền

| Vùng | Nền | Ranh giới |
| --- | --- | --- |
| Topbar, palette, inspector, kết quả | `surface` | viền `border` |
| Canvas Quy trình / Sơ đồ | `bg` + chấm `canvas-dot` 1 px mỗi 20 px | — |
| Thẻ, popup, hộp thoại | `surface-raised` | viền `border` + bóng 1/2/3 |

Ở theme tối, càng nổi càng sáng: `bg` (950) < `surface` (900) < `surface-raised` (850).

Cột giữa là flex dọc `[Quy trình | Sơ đồ · Thu gọn/Mở tất cả] [canvas (co giãn)] [thanh lỗi]`. Không lớp nổi nào (thanh lỗi, sheet, toast) được
che thẻ đang được nói tới hay đang chọn.

**Mốc chiều rộng** ([0009](design/0009-bo-cuc-man-hinh.md); media query không dùng được biến CSS, nên ghi ở đây):

| Chiều rộng | Thanh trên | Khác |
| --- | --- | --- |
| ≥ 1 300 px | 1 hàng: nhóm `.tb-file` (tên app, tên workflow, Mới · Mở… · Lưu · ↶ · ↷) bên trái, nhóm `.tb-run` (Seed 96 px, Org ≤ 180 px + ⟳, Xem trước, Insert vào org, ô Giao diện 32 px) bên phải | Ba cột palette / canvas / inspector |
| 1 140–1 299 px | 1 hàng, ẩn tên app (vẫn có trong `<title>`) | |
| 901–1 139 px | 2 hàng: `.tb-file` / `.tb-run` (Seed trái, các nút phải). Hai nhóm luôn gập nguyên nhóm | |
| ≤ 900 px | như trên + nút **⋯** (nhóm Mẫu) | Palette thành hàng ngang, inspector thành bottom sheet |
| ≤ 900 px và cao ≤ 500 px (điện thoại xoay ngang) | như trên | Ẩn hàng "Thu gọn/Mở tất cả" (để còn ≥ 60 px canvas trên sheet), hai mục này vào menu ⋯ (nhóm Khung), nút Quy trình / Sơ đồ vào nhóm Chế độ xem |
| ≤ 720 px (điện thoại) | 2 hàng: `[tên][Seed n][↶][↷][⋯]` / `[Org][▶ Xem trước][⤒ Insert]`. Mới/Mở…/Lưu, Seed, ⟳, Quy trình/Sơ đồ, Thu gọn/Mở tất cả, Giao diện vào menu ⋯. Luôn mở ở Quy trình. Org, Xem trước, Insert không bao giờ vào menu | Đầu panel kết quả: tóm tắt cuộn ngang, `⤓ Tải`; popup bảng chọn biến rộng cả màn hình |

## 8. Trợ năng

### 8.1 Tương phản (WCAG 2.2 AA)

Chữ ≥ 4.5:1; nét giao diện (viền ô nhập, vòng focus, sọc, icon, viền lỗi) ≥ 3:1. Tính bằng script trong design doc 0008; `test/css-tokens.test.js` tính lại mọi cặp dưới đây (và 6 cặp mỗi loại bước) từ giá trị thật trong `app.css` (giải `var()` và `color-mix(in srgb)`), nên đổi token mà làm hỏng tương phản thì test đỏ.
**75 cặp mỗi theme (39 cặp trong bảng + 6 cặp × 6 loại bước), 0 cặp không đạt ở cả hai theme.** Thấp nhất: sáng `focus-ring`/`bg` 3.40, `border-control`/`surface-sunken`
3.48; tối `border-control`/`surface-raised` 3.39.

| Chữ/nét | Nền | Dùng cho | Ngưỡng | Sáng | Tối |
| --- | --- | --- | --- | --- | --- |
| `--color-text` | `--color-bg` | Chữ chính | 4.5 | 16.00 | 17.19 |
| `--color-text-muted` | `--color-bg` | Chữ phụ, nhãn, help | 4.5 | 6.21 | 8.12 |
| `--color-text` | `--color-surface` | Chữ chính | 4.5 | 17.48 | 16.00 |
| `--color-text-muted` | `--color-surface` | Chữ phụ | 4.5 | 6.78 | 7.56 |
| `--color-text` | `--color-surface-raised` | Chữ chính trên thẻ | 4.5 | 17.48 | 14.45 |
| `--color-text-muted` | `--color-surface-raised` | Tóm tắt thẻ | 4.5 | 6.78 | 6.83 |
| `--color-text-muted` | `--color-surface-sunken` | Chữ phụ trên field card | 4.5 | 6.50 | 7.86 |
| `--color-text-muted` | `--color-surface-hover` | Chữ phụ khi hover | 4.5 | 5.68 | 5.91 |
| `--color-text` | `--color-accent-subtle` | Chữ trên thẻ đang chọn | 4.5 | 16.09 | 11.50 |
| `--color-text-muted` | `--color-accent-subtle` | Chữ phụ trên thẻ đang chọn | 4.5 | 6.24 | 5.43 |
| `--color-accent-contrast` | `--color-accent` | Nút chính | 4.5 | 5.23 | 7.51 |
| `--color-accent-contrast` | `--color-accent-hover` | Nút chính (hover) | 4.5 | 7.02 | 13.11 |
| `--color-accent-text` | `--color-surface` | Link | 4.5 | 7.02 | 12.20 |
| `--color-accent-text` | `--color-accent-subtle` | Hàng menu đang chọn | 4.5 | 6.46 | 8.77 |
| `--color-accent` | `--color-surface` | Vòng chọn | 3 | 5.23 | 6.99 |
| `--color-accent` | `--color-bg` | Vòng chọn trên canvas | 3 | 4.79 | 7.51 |
| `--color-accent` | `--color-accent-subtle` | Vòng chọn trên nền chọn | 3 | 4.82 | 5.03 |
| `--color-focus-ring` | `--color-surface` | Vòng focus | 3 | 3.72 | 6.99 |
| `--color-focus-ring` | `--color-bg` | Vòng focus trên canvas | 3 | 3.40 | 7.51 |
| `--color-focus-ring` | `--color-accent-subtle` | Vòng focus quanh thẻ đang chọn | 3 | 3.42 | 5.03 |
| `--color-focus-ring-inverse` | `--color-inverse-bg` | Vòng focus nút trong toast | 3 | 6.32 | 4.38 |
| `--color-danger-contrast` | `--color-danger` | Badge lỗi, nút Insert | 4.5 | 5.57 | 7.02 |
| `--color-danger-text` | `--color-surface` | Chữ lỗi | 4.5 | 7.43 | 11.94 |
| `--color-danger-text` | `--color-danger-subtle` | Chữ trên chip lỗi | 4.5 | 6.80 | 8.39 |
| `--color-text` | `--color-danger-subtle` | Chữ chính trên ô lỗi | 4.5 | 15.99 | 11.25 |
| `--color-danger` | `--color-surface` | Viền thẻ lỗi | 3 | 5.57 | 6.54 |
| `--color-danger` | `--color-bg` | Viền ô lỗi trên canvas | 3 | 5.10 | 7.02 |
| `--color-warning-contrast` | `--color-warning-fill` | Badge cảnh báo | 4.5 | 10.59 | 11.38 |
| `--color-warning-text` | `--color-surface` | Chữ cảnh báo | 4.5 | 10.19 | 12.10 |
| `--color-warning-text` | `--color-warning-subtle` | Icon/chữ hộp cảnh báo | 4.5 | 9.30 | 8.67 |
| `--color-text` | `--color-warning-subtle` | Chữ chính hộp cảnh báo | 4.5 | 15.95 | 11.46 |
| `--color-warning` | `--color-surface` | Viền thẻ cảnh báo | 3 | 3.73 | 6.87 |
| `--color-success-text` | `--color-surface` | Chữ thành công | 4.5 | 6.41 | 12.46 |
| `--color-success-contrast` | `--color-success` | Badge thành công | 4.5 | 4.75 | 8.02 |
| `--color-border-control` | `--color-surface` | Viền ô nhập | 3 | 3.63 | 3.76 |
| `--color-border-control` | `--color-surface-raised` | Viền ô nhập trong popup/dialog | 3 | 3.63 | 3.39 |
| `--color-border-control` | `--color-surface-sunken` | Viền ô nhập trong field card | 3 | 3.48 | 3.91 |
| `--color-text-muted` | `--color-bg-disabled` | Chữ trên thẻ "Đã tắt" | 4.5 | 5.68 | 5.91 |
| `--color-inverse-text` | `--color-inverse-bg` | Toast | 4.5 | 14.45 | 14.62 |
| `--step-*` (6 loại) | `--color-surface-raised` | Sọc/icon trên thẻ | 3 | 4.06–7.31 | 4.35–9.33 |
| `--step-*` | `--step-*-subtle` | Icon trên ô icon | 3 | 3.75–6.68 | 3.77–7.46 |
| `--step-*-text` | `--color-surface` | Chữ màu loại (alias, nhãn cột) | 4.5 | 6.79–9.99 | 11.03–12.79 |
| `--step-*-text` | `--step-*-subtle` | Alias trên nền nhạt | 4.5 | 6.28–8.36 | 8.32–10.00 |
| `--color-text` | `--step-*-subtle` | Chữ trong thân khung | 4.5 | 14.62–16.16 | 11.55–12.51 |
| `--color-text-muted` | `--step-*-subtle` | Chữ phụ trong thân khung | 4.5 | 5.68–6.27 | 5.46–5.91 |

Bảng đủ từng loại bước nằm trong 0008 (phần Kiểm chứng).

**Cặp thêm bởi [0014](design/0014-hoan-thien-giao-dien.md) (dự kiến; thêm vào `css-tokens.test.js` khi làm).** 24 cặp có
ngưỡng mỗi theme, 0 không đạt; bảng đủ trong 0014 §11. Thấp nhất:

| Chữ/nét | Nền | Dùng cho | Ngưỡng | Sáng | Tối |
| --- | --- | --- | --- | --- | --- |
| `--color-border-control` | `--color-surface` | Tay nắm panel kết quả / sheet | 3 | 3.63 | 3.76 |
| `--color-minimap-off` | `--color-surface-raised` | Bước tắt trên minimap | 3 | 3.63 | 3.39 |
| `--color-accent` | `--color-surface-hover` | Con trượt rãnh tổng quan | 3 | 4.38 | 5.47 |
| `--color-accent` | `--color-surface-raised` | Khung nhìn minimap (trên quầng) | 3 | 5.23 | 6.32 |
| `--color-danger` | `--color-surface-raised` | Vòng lỗi trên minimap | 3 | 5.57 | 5.90 |

### 8.2 Mù màu

Khoảng cách màu tính bằng ΔE trong OKLab (×100; khoảng 2 là ngưỡng nhận ra khi đặt cạnh nhau, ≥ 8 là dễ phân biệt ở mảng
nhỏ). Mô phỏng theo Machado 2009, mức nặng nhất.

| | Sáng: cặp loại–loại gần nhất | Sáng: loại–trạng thái/accent gần nhất | Tối: loại–loại | Tối: loại–trạng thái/accent |
| --- | --- | --- | --- | --- |
| Mắt thường | Record/Query 8.7 | Record/success 8.8 | Record/Query 9.6 | Query/accent 9.8 |
| Deuteranopia | Record/Rẽ nhánh 3.2 | Chọn/success 5.0 | Record/Rẽ nhánh 3.4 | Lặp/accent 3.4 |
| Protanopia | Record/Query 8.5 | Chọn/lỗi 7.1 | Query/Rẽ nhánh 8.9 | Chọn/warning-fill 2.6 |

(Bảng màu cũ: Record/accent, Rẽ nhánh/cảnh báo, Bắt đầu/thành công đều là **0**, tức trùng hẳn.)

Với người mù màu đỏ–lục, vài cặp chỉ còn khác về độ sáng. Vì vậy loại bước luôn có **icon + nhãn**, lỗi/cảnh báo có
**hình khác nhau** (⊗ tròn, ▲ tam giác) và cách thể hiện khác nhau (badge nền đặc trên thẻ, so với sọc trái của loại).

### 8.3 Khác

- Vùng bấm ≥ 24×24 px (badge 22×24 kèm khoảng cách 4 px; "+" 22 px có vùng bấm 34 px). Nút trên thẻ 32×32 px.
- Theme mặc định theo `prefers-color-scheme`. Ô chọn **Giao diện** cuối thanh trên (`#theme-select`: Theo hệ thống / Sáng / Tối)
  đặt `data-theme="light|dark"` trên `<html>` (Theo hệ thống thì bỏ thuộc tính) và nhớ trong `localStorage['sfdg.theme']`
  (bọc `try/catch`, chế độ riêng tư thì chỉ nhớ tới khi tải lại). `client/js/theme.js` là script thường trong `<head>` nên
  theme áp dụng trước lần vẽ đầu, không nháy màu. Đổi theme ở một tab thì các tab khác đang mở theo luôn (sự kiện `storage`, ô chọn cũng
  cập nhật). Nhãn "Giao diện" chỉ cho trình đọc màn hình. Từ [0009](design/0009-bo-cuc-man-hinh.md) ô chọn vẫn là
  `<select>` (giữ phím, trợ năng) nhưng vẽ thành ô icon 32 px: `appearance: none`, chữ trong suốt, icon `--ico-theme` ở giữa
  (`::after` của nhãn, không nhận chuột); `option` đặt lại màu chữ `text` và nền `surface` để danh sách thả xuống đọc được;
  `title` theo giá trị (`Giao diện: Tối`…). Ở ≤ 720 px ô này vào menu ⋯ (nhóm Giao diện, hàng chọn một).
- Nút `⤒ Insert` ở điện thoại: phần ` vào org` chỉ ẩn bằng mắt (kiểu `.sr-only`), nên tên đọc lên vẫn là "⤒ Insert vào org";
  `title` vẫn là câu đầy đủ `Sinh dữ liệu và insert vào <org>`.
- **Chọn nhiều và bộ nhớ tạm** ([0012](design/0012-nang-suat-soan-thao.md) B): Shift+bấm / Shift+↑ / Shift+↓ (dải trong một dãy),
  Ctrl/⌘+bấm (chọn rời), Ctrl+A khi focus trong cây (cả dãy của bước chính), Esc hai nấc (về bước chính, rồi bỏ chọn); Delete,
  Ctrl+/, Ctrl+D, Alt+↑/↓, ContextMenu áp cho cả lựa chọn. Ctrl+C / Ctrl+X / Ctrl+V qua sự kiện `copy`/`cut`/`paste` (không cần
  quyền, chạy cả khi không phải secure context); trong ô nhập trình duyệt làm như thường. Vùng `#sel-live` (`aria-live="polite"`,
  ẩn) đọc `Đã chọn 3 bước.` khi số lượng đổi (không đọc khi về 1).
- **Ctrl+O** mở popup Thư viện (kể cả trong ô nhập; chặn hộp mở file của trình duyệt).
- **F8 / Shift+F8** tới lỗi hoặc cảnh báo tiếp theo / trước đó (theo thứ tự trong thanh lỗi, vòng lại), kể cả khi focus đang
  trong ô nhập của inspector. Không có gì thì toast `Không có lỗi hay cảnh báo.`
- **Bảng chọn biến** ([0014](design/0014-hoan-thien-giao-dien.md), dự kiến): mở bằng `{{` (ô Mẫu), ↓ (ô đường dẫn), nút
  `{x}`, Ctrl+Space, và **Alt+↓ / ⌥↓ trên mọi nền tảng** (macOS dùng Ctrl+Space để đổi bộ gõ). Ô có
  `aria-keyshortcuts="Alt+ArrowDown Control+Space"`; `title` và danh sách "Phím tắt" ghi phím theo nền tảng (`keys.js`).
- `prefers-reduced-motion: reduce`: thời lượng 0 ms, không animation chớp; sheet đổi nấc và minimap hiện/ẩn không chuyển
  động (0014).
- Icon `aria-hidden`; mọi badge có `title`/`aria-label` bằng chữ ("2 lỗi — bấm để xem").

## 9. Nên / Không nên

| Nên | Không nên |
| --- | --- |
| Dùng `var(--color-danger)` cho viền thẻ lỗi | Dùng màu loại bước để báo trạng thái (ví dụ tô cam Rẽ nhánh khi có cảnh báo) |
| Dùng `--c` / `--c-subtle` trong thành phần có màu theo loại | Viết `var(--step-record)` hay mã hex trong thành phần |
| Hover bằng nền trung tính `surface-hover` | Hover bằng viền accent (dễ nhầm với focus/chọn) |
| Thể hiện "tắt" bằng nét đứt + tag | Dùng `opacity` cho nhiều nghĩa khác nhau (tắt, cũ, vô hiệu, đang kéo) |
| Đặt icon cạnh màu trạng thái | Chỉ đổi màu chấm ● để phân biệt lỗi với cảnh báo |
| Nhãn nhánh "✓ Đúng" / "✗ Sai" màu Rẽ nhánh | Nhãn "Sai" màu đỏ (đọc như lỗi) |
| Một nút `.primary` mỗi vùng | Hai nút chính cạnh nhau |
| Nút xác nhận ghi vào org là `.danger.solid` | Để nút xác nhận cuối giống nút "Hủy" |
| Icon bằng `ico('<tên>')` / `data-ico`, nút chỉ có icon có `aria-label` (0014) | Dùng ký tự (`⋯ ▸ ✕ ⚙ 📌`) làm icon: mỗi máy một cỡ, trình đọc màn hình đọc tên ký tự |
| Báo "còn mục" bằng mép mờ (mask) và cho lăn chuột cuộn ngang (0014) | Cắt mục ở mép màn hình mà không có dấu hiệu, hay thêm nút ‹ › vào hàng đã chật |

## 10. Thêm loại bước hoặc thành phần mới

1. Chọn một hue OKLCH cách các hue đã dùng ≥ 35° và chạy lại kiểm tra tương phản + ΔE (0008). Không lấy hue trùng với
   accent hoặc màu trạng thái.
2. Thêm primitive (bậc 50/100/600/700 cho sáng, 300/200 cho tối), 4 token `--step-<type>*` ở cả hai theme, icon
   `--ico-<type>` và một luật `[data-type="<type>"]`.
3. Cập nhật bảng §3.4, §5 và bảng tương phản.
4. Test `test/css-tokens.test.js` (0008) kiểm: mọi `type` trong `NODE_TYPES` có đủ token, icon và luật `[data-type]`.
