# 0008 — Hệ thống thiết kế UI: bảng màu, trạng thái và kiểu dáng thống nhất

- **Trạng thái:** Đã làm (2026-10-27)
- **Ngày:** 2026-10-27
- **Liên quan:** [0003](0003-process-mode.md) (chế độ Quy trình), [0005](0005-variable-picker.md) (chip biến),
  [0006](0006-query-pick-nodes.md) (node Query và Chọn bản ghi), tài liệu tham chiếu
  [../ui-design-system.md](../ui-design-system.md) (token, thang đo, bảng trạng thái từng thành phần)

## Vấn đề

Người dùng nhìn màn hình Quy trình để trả lời ba câu hỏi: *bước này là loại gì*, *bước nào đang chọn*, *bước nào có lỗi
hay cảnh báo*. Bảng màu hiện tại làm ba câu hỏi đó lẫn vào nhau.

Kiểm tra `client/css/app.css` (280 dòng) và chụp màn hình sáng/tối × 1440/390 (workflow rỗng, workflow có lỗi + cảnh báo +
bước tắt + bước đang chọn, chi tiết field có lỗi, kết quả xem trước, menu "+", hộp xác nhận Insert vào org production).
Ảnh nằm trong scratchpad của phiên thiết kế (không commit):
`/tmp/claude-0/-home-user-sf-data-generator/fa9ad77c-1d8e-553a-9b3f-45d89b2dd244/scratchpad/ui-design/before/*.png`.
Script chụp là `shots.cjs` cùng thư mục.

### Mức 1: một màu mang hai nghĩa

| # | Vấn đề | Bằng chứng |
| --- | --- | --- |
| 1 | `--node-record` = `--accent` = `#0b6bcb`. Record đang chọn chỉ khác Record thường ở độ dày viền xanh, vì sọc trái cũng xanh. Chấm màu trong inspector của Record trông như "đang hoạt động". | `before/light-1440-issues-selected.png` (thẻ `acc`) |
| 2 | `--node-branch` = `--warn` = `#b26b00`. Sọc Rẽ nhánh giống hệt badge và viền cảnh báo. Thẻ có cảnh báo nằm trong khung Rẽ nhánh thì không biết màu cam là loại hay là trạng thái. | cùng ảnh, khung "Rẽ nhánh" và badge vàng của `task` |
| 3 | `--node-start` = `--ok` = `#1e7f4f`. Thẻ Bắt đầu trông như "thành công". | mọi ảnh |
| 4 | Nhãn cột "Đúng" màu `--ok`, "Sai" màu `--danger`. Chữ "Sai" đỏ đọc như lỗi, dù nhánh Sai hoàn toàn hợp lệ. | `before/light-1440-issues-selected.png` |
| 5 | `--accent-weak` dùng cho 7 việc: chip số liệu, chip tóm tắt kết quả, tab đang mở, hover menu, chớp sáng, điểm thả, nền chip. Chip số liệu (không bấm được) trông như đang chọn. | `before/light-1440-result.png` |
| 6 | Ô `ref` trong bảng kết quả (`acc#1`, `→ acc#1`) màu accent nhưng không bấm được. | `before/light-1440-result.png` |
| 7 | 0006 dự kiến `--node-query: #0f766e` (ΔE 6.2 so với `--ok`, gần như cùng màu xanh lá) và `--node-pick: #b4235a` (hồng sẫm, cùng vùng hue với `--danger`). Nếu làm theo, lỗi số 2–3 sẽ lặp lại. | tính bằng `tokens.mjs` |

### Mức 1: tương phản không đạt WCAG 2.2 AA

| Theme | Cặp | Tỉ lệ | Cần |
| --- | --- | --- | --- |
| Sáng | Chữ trắng trên badge cảnh báo `#b26b00` | 4.20 | 4.5 |
| Sáng | Chữ cảnh báo `.slot-msg` `#b26b00` trên trắng | 4.20 | 4.5 |
| Sáng | Viền ô nhập `#d9dde5` trên trắng (WCAG 1.4.11) | 1.36 | 3 |
| Sáng | `--muted` trên `--accent-weak` (chữ phụ trên hàng menu hover) | 4.27 | 4.5 |
| Tối | Chữ trắng trên nút "▶ Xem trước" `#4ea1f3` | **2.72** | 4.5 |
| Tối | Chữ trắng trên badge lỗi `#f0705a` | 2.93 | 4.5 |
| Tối | Chữ trắng trên badge cảnh báo `#f0b44c` | **1.85** | 4.5 |
| Tối | Viền ô nhập `#343a46` trên `#1d2129` | 1.41 | 3 |
| Tối | Sọc Lặp `#7a4cc2` trên panel (màu loại bước không được đổi cho theme tối) | 2.80 | 3 |

### Mức 2: các trạng thái trông giống nhau

- **Opacity mang bốn nghĩa:** bước tắt (0.55), nút vô hiệu (0.5), chip số liệu cũ (0.45), bước đang kéo (0.4). Bước tắt làm
  mờ luôn badge lỗi bên trong nó.
- **Lỗi và cảnh báo chỉ khác màu.** Badge cùng hình viên thuốc có số; danh sách lỗi dùng cùng ký tự `●`. Ở mô phỏng
  deuteranopia, đỏ `#c2341b` và cam `#b26b00` đều thành màu ô liu.
- **Chọn và focus gần như một:** cả hai là outline 2 px accent, chỉ khác offset 1 px.
- **Hover mọi nút = viền accent**, trông như focus hoặc đang chọn.
- **Nút "Insert vào org" vô hiệu** vẫn là viền đỏ nhạt (opacity), nên vẫn trông như cảnh báo. Ngược lại, nút **xác nhận
  cuối "Insert"** trong hộp thoại chỉ là viền đỏ, cùng độ nổi với "Hủy" (`before/light-1440-insert-dialog.png`).
- **Loại bước chỉ nhận ra bằng sọc 4 px và chữ.** Không có icon. Menu "+" và palette không có dấu hiệu loại nào
  (`before/light-1440-addmenu.png`).

### Mức 3: thiếu nhất quán

- 29 giá trị màu khác nhau viết thẳng trong CSS; 5 cỡ chữ (11 px dùng 10 chỗ, 17 px một chỗ); 6 kiểu bo góc; 4 bóng viết
  tay; 8 giá trị opacity; toast không có `z-index`.
- Badge (nút bấm được) cao khoảng 16 px, dưới vùng bấm 24 px.
- Ghi nhận thêm (ngoài phạm vi màu): danh sách lỗi nổi đè lên thẻ cuối ở màn hình 900 px cao
  (`before/light-1440-issues-selected.png`, thẻ `task`).

## Mục tiêu / Ngoài phạm vi

- Mục tiêu:
  - Mỗi màu một nghĩa. Ba bộ tách biệt: **tương tác** (xanh dương), **trạng thái** (đỏ/hổ phách/xanh lá, luôn kèm icon),
    **loại bước** (5 hue riêng + Bắt đầu trung tính), áp dụng luôn cho Query và Chọn bản ghi (0006) và chip biến (0005).
  - Mỗi loại bước nhận ra **không cần màu**: icon + nhãn.
  - Mỗi trạng thái (chọn, focus, lỗi, cảnh báo, tắt, vô hiệu, cũ, kéo/thả) khác các trạng thái khác ít nhất hai kênh.
  - Nút theo mức quan trọng: chính, phụ, ghost, nguy hiểm (mở xác nhận), nguy hiểm đặc (xác nhận cuối), link.
  - Đạt WCAG 2.2 AA ở cả theme sáng và tối. Có bảng số liệu.
  - Token hai lớp bằng CSS custom property, không thêm dependency, không web font. Có test chặn màu viết thẳng.
- Ngoài phạm vi:
  - Đổi bố cục (vị trí panel, danh sách lỗi đè thẻ, topbar xuống 4 dòng ở 390 px): ghi nhận, để design doc khác.
  - ~~Nút chuyển theme trong UI~~: đã đưa vào phạm vi theo "Đã chốt" mục 2.
  - Thay các ký tự `⋯ ▸ ▾ ⠿ ↶ ↷ ⟳` bằng SVG.
  - Thay đổi workflow JSON hoặc API.

## Luồng người dùng

Thay đổi này chỉ đổi hình thức, không thêm thao tác. Các "luồng" dưới đây là việc *nhận ra* trên màn hình, và cách
thiết kế mới trả lời từng việc.

1. **Biết bước là loại gì.** Nhìn ô icon 24 px ở đầu thẻ (⊞ Record, trụ dữ liệu Query, ◎ Chọn bản ghi, ⟲ Lặp, nhánh
   Rẽ nhánh, ▷ Bắt đầu), sọc trái cùng màu, và nhãn chữ. (0 thao tác)
2. **Biết bước nào đang chọn.** Thẻ đang chọn có vòng xanh 2 px sát thẻ và nền xanh rất nhạt. Màu xanh này không có ở
   loại bước nào. Khi di bằng bàn phím, có thêm vòng focus cách thẻ 3 px. (0)
3. **Tìm bước lỗi.** Thẻ lỗi có viền đỏ dày 2 px và badge đỏ `⊗ 2`. Thẻ chỉ có cảnh báo có viền hổ phách và badge
   `▲ 1` nền vàng chữ tối. Bấm badge để nhảy tới lỗi đầu tiên (như hiện tại). (1)
4. **Biết bước nào đang tắt.** Thẻ nền xám, viền và sọc nét đứt, tag `⏻ Đã tắt`. Badge lỗi bên trong vẫn rõ. (0)
5. **Thêm bước đúng loại.** Bấm "+" (nút chuyển sang nền xanh khi rê chuột). Menu có ô icon cùng màu với thẻ sẽ được
   tạo. (2: bấm "+", chọn loại)
6. **Insert vào org.** Bấm "⤒ Insert vào org" (viền đỏ). Hộp xác nhận có hộp cảnh báo `▲` nền vàng nhạt nếu org là
   production, nút "Insert" **đỏ đặc** ở bên phải, "Hủy" là nút phụ. (2)
7. **Đọc biến trong ô Mẫu (0005).** Chip `acc · Industry` có viền trái màu Record (teal) và icon Record. Chip
   `loop · index` màu Lặp. Chip lỗi nền đỏ nhạt có ⊗. Chip đang gõ dở có viền nét đứt xám. (0)

## Thiết kế UI

Chi tiết đầy đủ (giá trị token sáng/tối, thang đo, bảng trạng thái từng thành phần, icon, nên/không nên) nằm trong
[../ui-design-system.md](../ui-design-system.md). Phần này tóm tắt các quyết định.

### Bảng màu

| Bộ | Token | Sáng | Tối | Ghi chú |
| --- | --- | --- | --- | --- |
| Tương tác | `--color-accent` | `#2067da` | `#6ea4fe` | Theme tối dùng **chữ tối** trên nút xanh (7.51:1) thay cho chữ trắng (2.72:1) |
| | `--color-focus-ring` | `#3a81f6` | `#6ea4fe` | |
| Trạng thái | `--color-danger` | `#c52c2a` | `#ff7267` | Badge: chữ trắng (sáng) / chữ tối (tối) |
| | `--color-warning` / `-fill` | `#b67703` / `#fbc044` | `#df9201` / `#fbc044` | Badge cảnh báo nền vàng **chữ tối**, nên khác badge lỗi cả màu nền lẫn màu chữ |
| | `--color-success` | `#02853c` | `#53be70` | Chỉ cho kết quả insert thành công |
| Loại bước | `--step-record` | teal `#078e7d` | `#40d9c1` | Record chuyển khỏi màu xanh dương |
| | `--step-query` | cyan `#057da0` | `#54c1e3` | Thay `#0f766e` của 0006 |
| | `--step-pick` | olive `#656902` | `#b4d35c` | Thay `#b4235a` của 0006 |
| | `--step-loop` | violet `#6941a1` | `#b484e8` | Giữ hue tím, thêm biến thể tối |
| | `--step-branch` | magenta `#b33879` | `#f08dba` | Rẽ nhánh chuyển khỏi màu cam cảnh báo |
| | `--step-start` | gray `#6e757f` | `#808790` | Bắt đầu là trung tính, không còn xanh lá |
| Trung tính | gray 0–950 | | | Nền, panel, viền, chữ, chip số liệu, chip field |

Hue chọn trong OKLCH, cách đều quanh vòng màu: đỏ 27°, hổ phách 72°, olive 112°, xanh lá 150°, teal 180°, cyan 226°,
xanh dương 260°, tím 300°, magenta 352°. Loại bước có độ bão hòa vừa (C ≈ 0.11–0.17), trạng thái bão hòa cao hơn và
luôn đi kèm icon. Ở theme sáng, loại bước có độ sáng khác nhau (L 0.47–0.58) để vẫn tách nhau khi mất cảm nhận màu.

### Phân biệt loại bước

- Ô icon 24×24 px (nền `-subtle`, viền trong `-strong`, icon `--step-<type>`) đứng trước tên loại trên thẻ, trong
  palette, menu "+", tiêu đề inspector (thay chấm tròn) và chip biến.
- Sọc trái 4 px và nền thân khung theo màu loại (giữ như 0003).
- Màu loại chỉ xuất hiện ở sọc, ô icon, alias, nền thân khung, nhãn cột nhánh và chip biến. Không bao giờ ở viền
  toàn thẻ, badge hay chữ thông báo (những chỗ đó dành cho trạng thái).
- Cột nhánh: "✓ Đúng" và "✗ Sai", màu chữ Rẽ nhánh (`--step-branch-text`), cột nền `surface` viền `-strong`.

### Trạng thái (tóm tắt, đầy đủ ở ui-design-system §6.4)

| Trạng thái | Cách thể hiện |
| --- | --- |
| Đang chọn | Vòng `accent` 2 px sát thẻ + nền `accent-subtle` |
| Focus bàn phím | Outline `focus-ring` 2 px, **hở 3 px** |
| Lỗi | Viền `danger` 2 px + badge `⊗ n` nền đỏ |
| Cảnh báo | Viền `warning` 1 px + badge `▲ n` nền vàng chữ tối |
| Đã tắt | Nền `bg-disabled`, viền + sọc nét đứt, tag `⏻ Đã tắt`, chữ muted. Không opacity |
| Control vô hiệu | Nền `bg-disabled`, chữ `text-disabled`, mất màu riêng (nút đỏ hết đỏ), `cursor: not-allowed` |
| Số liệu cũ | Chip viền nét đứt, chữ muted nghiêng |
| Đang kéo / điểm thả | Nguồn opacity 0.5 + nét đứt; điểm thả nét đứt xám, điểm đang nhắm viền liền xanh + nền xanh nhạt |

### Nút theo mức quan trọng

Chính (nền xanh: "▶ Xem trước"), phụ (viền xám: Mở…, Tải JSON, Hủy), ghost (không viền: Mới/Lưu/↶/↷, ⋯ trên thẻ, Thu gọn
tất cả), nguy hiểm viền ("⤒ Insert vào org" ở topbar, mở hộp xác nhận), nguy hiểm đặc ("Insert" trong hộp xác nhận),
link ("📌 giữ seed"). Hover dùng nền trung tính, không dùng viền xanh.

### Chữ, khoảng cách, bo góc, bóng

Font hệ thống. 5 cỡ chữ 12/13/14/16/18 px (bỏ 11 px và 17 px). Khoảng cách theo bội 4 px. Bo góc 4/6/10/14/pill. Ba mức
bóng (thẻ, popup, hộp thoại). Lớp z: sheet 30, popup 40, kéo 50, toast 60. Thời lượng 120/200 ms, tắt khi
`prefers-reduced-motion`.

### Kiểm chứng

- **Tương phản.** Script `tokens.mjs` (scratchpad, cùng thư mục ảnh) dựng token từ OKLCH, tính 77 cặp chữ/nền và
  nét/nền cho cả hai theme. **0 cặp không đạt.** Thấp nhất: sáng `focus-ring`/`bg` 3.40 (cần 3), `border-control`/
  `surface-sunken` 3.48; tối `border-control`/`surface-raised` 3.39. Bảng gom theo nhóm ở ui-design-system §8.1; bảng
  từng loại bước:

  | Loại | Sọc/icon trên thẻ (≥3) sáng / tối | Icon trên ô icon (≥3) | Chữ `-text` trên `surface` (≥4.5) | Chữ `-text` trên `-subtle` | Chữ phụ trên thân khung (≥4.5) |
  | --- | --- | --- | --- | --- | --- |
  | Bắt đầu | 4.65 / 4.35 | 3.89 / 3.77 | 9.99 / 12.79 | 8.36 / 10.00 | 5.68 / 5.91 |
  | Record | 4.06 / 8.95 | 3.75 / 7.29 | 6.79 / 11.86 | 6.28 / 8.72 | 6.27 / 5.56 |
  | Query | 4.72 / 7.60 | 4.35 / 6.27 | 6.99 / 11.65 | 6.43 / 8.67 | 6.25 / 5.63 |
  | Chọn bản ghi | 5.87 / 9.33 | 5.41 / 7.46 | 6.99 / 11.65 | 6.45 / 8.41 | 6.25 / 5.46 |
  | Lặp | 7.31 / 5.57 | 6.68 / 4.76 | 7.64 / 11.10 | 6.98 / 8.57 | 6.20 / 5.84 |
  | Rẽ nhánh | 5.59 / 6.93 | 5.09 / 5.79 | 7.84 / 11.03 | 7.14 / 8.32 | 6.18 / 5.70 |

- **Mù màu.** Mô phỏng Machado 2009 (deuteranopia, protanopia, tritanopia), đo ΔE OKLab giữa mọi cặp loại bước và giữa loại
  bước với accent/trạng thái. Mắt thường: cặp gần nhất là Record/Query 8.7 (sáng) và 9.6 (tối); bảng cũ có ba cặp trùng
  hẳn (ΔE 0). Deuteranopia: Record/Rẽ nhánh còn 3.2–3.4, vì vậy icon + nhãn là bắt buộc. Protanopia tối: Chọn bản
  ghi/badge cảnh báo 2.6, nhưng hai thứ khác hình (sọc trái so với badge ▲ có số). Ảnh: `after/cvd.png`.
- **Mockup.** `mockup.css` (token + thành phần) thay `app.css` khi chụp (Playwright `page.route`), cùng `mock-init.js` gắn
  `data-type` và ô icon vào DOM hiện có. Không sửa `client/`. Ảnh sau:
  `/tmp/claude-0/-home-user-sf-data-generator/fa9ad77c-1d8e-553a-9b3f-45d89b2dd244/scratchpad/ui-design/after/` gồm
  `{light,dark}-{1440,390}-{empty,issues-selected,result,insert-dialog}.png`, `{light,dark}-1440-{details-error,addmenu}.png`,
  và bảng thành phần có cả Query, Chọn bản ghi, chip biến: `components-light.png`, `components-dark.png`.
  `tokens.css` trong cùng thư mục là khối token sẵn để chép vào `app.css`.

## Thay đổi dữ liệu / API

- Workflow JSON: **không đổi**. Không ảnh hưởng `version: 1`/`2`.
- Endpoint, option schema: không đổi. Màu và icon là chuyện hiển thị nên nằm trong CSS, không đưa vào `GET /api/meta`.
- DOM: `.step`, `.start-card`, `.palette-item`, `.popup-item` (menu thêm bước), tiêu đề inspector và chip biến có thêm
  `data-type="<step.type>"` và một `<span class="ico-tile" aria-hidden="true"><span class="ico"></span></span>`.
  `NODE_COLORS` trong `client/js/store.js` bị bỏ, inline style `--c` bị bỏ. Loại bước chưa có luật CSS rơi về màu trung
  tính và icon ⓘ, nên server thêm loại mới không làm vỡ UI.

## Checklist tiện dụng

- [x] 1. Chạy được ngay với mặc định. Không đổi hành vi; theme theo hệ điều hành như cũ.
- [x] 2. Ít thao tác cho việc hay làm. Không thêm thao tác. Nhận ra loại/chọn/lỗi không cần thao tác nào (luồng 1–4).
- [x] 3. Xem trước trước khi ghi. Nút xác nhận "Insert" thành đỏ đặc, tách khỏi "Hủy". Hộp cảnh báo production có icon ▲
  và đạt tương phản. Nút topbar khi chưa chọn org mất màu đỏ nên không gây báo động giả.
- [x] 4. Lỗi chỉ đúng chỗ và nói cách sửa. Lỗi và cảnh báo khác nhau cả hình icon (⊗/▲), màu nền badge, màu chữ badge và
  độ dày viền. Màu đỏ không còn dùng cho "Sai" và màu cam không còn dùng cho Rẽ nhánh, nên đỏ/vàng luôn nghĩa là có vấn đề.
- [x] 5. Không mất công sức. Không ảnh hưởng autosave/undo.
- [x] 6. Lấy thông tin từ org thay vì bắt gõ. Không liên quan (không có ô nhập mới).
- [x] 7. Một nguồn sự thật. Màu và icon của loại bước chỉ ở `app.css` (`[data-type]`), JS chỉ đặt `step.type`. Bỏ bảng
  `NODE_COLORS` nhân đôi trong JS. `docs/ui-design-system.md` khớp 1:1 với khối token, có test kiểm.
- [x] 8. Giải thích tại chỗ. Badge và tag có `title` bằng chữ; icon chỉ bổ sung, nhãn chữ luôn có.
- [x] 9. An toàn khi lỡ tay. Nút ghi vào org khác hẳn các nút khác; không thêm đường ghi nào.

## Phương án đã cân nhắc

| Phương án | Ưu | Nhược | Chọn? |
| --- | --- | --- | --- |
| **A. Giữ accent xanh dương; Record sang teal, Rẽ nhánh sang magenta, Bắt đầu trung tính; 9 hue cách đều trong OKLCH** | Xanh dương vẫn là "bấm được/đang chọn" như mọi web app; tách hẳn ba bộ màu; đạt AA cả hai theme | Người quen Record màu xanh phải quen màu mới; hue dày nên vài cặp gần nhau khi mù màu (bù bằng icon) | **Có** |
| B. Giữ Record xanh dương, đổi accent sang chàm/tím | Record giữ màu cũ | Accent chàm sát Lặp (tím) và sát Record; xung đột chỉ chuyển chỗ | Không |
| C. Accent đen/trung tính (kiểu Vercel/Linear), loại bước giữ màu | Ít hue hơn, sạch | Vòng chọn/focus đen khó thấy trên nền tối và trên thẻ; link không còn màu quen thuộc | Không |
| D. Loại bước chỉ phân biệt bằng icon, mọi thẻ cùng màu xám | Không bao giờ trùng màu | Mất tín hiệu nhìn lướt cả workflow dài; 0003/0005 đã dựa vào màu loại | Không |
| Icon: **SVG trong custom property, hiển thị bằng `mask`** | Một nơi (CSS), đổi màu theo `currentColor`, không thêm dependency, JS chỉ chèn một span | Cần trình duyệt hỗ trợ `mask` (mọi trình duyệt hiện đại) | **Có** |
| Icon: SVG chèn bằng JS (`icons.js`) | Dễ đọc trong DOM | Định nghĩa nằm ở JS, CSS và JS phải khớp nhau | Không |
| Icon: ký tự Unicode/emoji | Không cần gì thêm | Hiển thị khác nhau theo OS/font, không chỉnh được màu emoji | Không |
| Theme tối: tính lại bằng `color-mix()` từ primitive | Ít primitive, nền nhạt tự theo màu loại | Phụ thuộc `color-mix` (đã dùng trong `app.css` hiện tại) | **Có** |

## Kế hoạch thực hiện

Không có thay đổi contract (bảng trong `.claude/agents/implementer.md` chỉ chạm hàng UI, Docs, Tests). Làm **sau** khi
đợt sửa review đang làm ở `process.js`, `ops.js`, `main.js`, `summary.js` đã xong, để tránh xung đột.

| # | Bước | File | Kiểm tra |
| --- | --- | --- | --- |
| 1 | **Đưa token vào, ánh xạ biến cũ.** Chép khối token (primitive, ngữ nghĩa sáng/tối, thang đo, icon) lên đầu `app.css`, kết thúc bằng dòng `/* ===== end tokens ===== */`. Tạm giữ tên cũ làm alias: `--bg→--color-bg`, `--panel→--color-surface`, `--text`, `--muted→--color-text-muted`, `--border`, `--accent`, `--accent-weak→--color-accent-subtle`, `--danger`, `--warn→--color-warning`, `--ok→--color-success`, `--grid→--color-canvas-dot`, `--shadow→--shadow-1`, `--node-*→--step-*`. Sửa ngay các cặp tương phản hỏng: chữ trên nút/badge dùng `-contrast`, badge cảnh báo dùng `warning-fill`, viền ô nhập dùng `border-control`. | `client/css/app.css` | `npm test`; `smoke.cjs` qua; chụp sáng/tối so với `after/` |
| 2 | **Gắn `data-type` và ô icon, bỏ `NODE_COLORS`.** Thêm luật `[data-type]` (§6.1). Đặt `data-type` + span icon ở thẻ bước, thẻ Bắt đầu, mục palette, hàng menu "+", tiêu đề inspector. Bỏ inline `--c` và `.dot`. | `client/js/process.js`, `client/js/main.js`, `client/js/inspector.js`, `client/js/store.js`, `client/css/app.css` | `smoke.cjs` thêm kiểm: mỗi `.step` có `data-type` và `.ico-tile`; không còn chuỗi `NODE_COLORS` |
| 3 | **Nút và ô nhập** theo §6.2–6.3: hover nền trung tính, vô hiệu không dùng opacity, `.danger.solid` cho nút "Insert" trong `confirmInsert` (và nút xác nhận xóa khung nếu có). | `client/css/app.css`, `client/js/main.js` (class nút xác nhận) | Chụp hộp xác nhận Insert (mock `/api/orgs`, chặn `/api/run` có `target`) |
| 4 | **Thẻ bước và trạng thái** theo §6.4: chọn/focus/lỗi/cảnh báo/tắt/cũ/kéo, badge có icon ⊗/▲ và cao 22 px, tag "Đã tắt" có icon. | `client/css/app.css` | Workflow kiểm thử có lỗi + cảnh báo + bước tắt (như `shots.cjs`); so ảnh |
| 5 | **Khung, ô con, "+", palette, menu, inspector, chip, kết quả, hộp thoại, toast, danh sách lỗi** theo §6.5–6.12. Nhãn nhánh "✓ Đúng/✗ Sai" bằng CSS `::before`. Ô `ref` dùng `--step-record-text`. Tab dạng gạch dưới. | `client/css/app.css` | Chụp `result`, `addmenu`, 390 px với bottom sheet |
| 6 | **Bỏ giá trị viết thẳng và alias cũ.** Mọi cỡ chữ/khoảng cách/bo góc/bóng/z-index dùng token; xóa alias của bước 1. | `client/css/app.css` | Test bước 7 qua |
| 7 | **Test chặn trôi.** `test/css-tokens.test.js`: (a) sau dòng `end tokens` của `app.css` không có `#hex`, `rgb(`, `hsl(`, tên màu (`white`, `black`…); (b) `client/js/*.js` không có màu viết thẳng; (c) mọi `type` trong `NODE_TYPES` (`server/workflow/nodes.js`) có `--step-<type>`, `-subtle`, `-strong`, `-text` trong cả khối sáng và tối, có `--ico-<type>` và luật `[data-type="<type>"]`; (d) khối sáng và tối định nghĩa cùng tập token ngữ nghĩa; (e) tùy chọn: tính lại tương phản các cặp trong ui-design-system §8.1 từ giá trị trong `app.css` (cần giải `var()` và `color-mix(in srgb)`, chừng 80 dòng). | `test/css-tokens.test.js` (mới) | `node --test test/css-tokens.test.js` |
| 8 | **Smoke và ảnh.** `smoke.cjs` chụp thêm theme tối (`colorScheme: 'dark'`) và lưu `smoke-1440-dark.png`. | `.claude/skills/smoke-test/smoke.cjs`, `.claude/skills/smoke-test/SKILL.md` | `node .claude/skills/smoke-test/smoke.cjs <dir>` |
| 9 | **Tài liệu.** Bỏ dòng "Nháp" ở `docs/ui-design-system.md`. Planner sửa dòng màu trong 0006 (`--node-query`, `--node-pick` → `--step-query`, `--step-pick` theo 0008) và câu "dùng màu `--node-*`" trong 0005; 0003 câu nhãn Đúng/Sai màu `--ok`/`--danger`. Thêm bước "token màu + icon + luật `[data-type]`" vào skill `add-node-type`. Điền "Đã làm". | `docs/…`, `.claude/skills/add-node-type/SKILL.md` | Đọc lại |

Ước lượng: bước 1–2 nửa ngày, 3–6 một ngày, 7–9 nửa ngày. Khi làm 0006, node Query/Chọn bản ghi chỉ cần dùng token đã có
(primitive cyan/olive và icon `query`/`pick` đã nằm trong khối token).

## Câu hỏi mở

1. **Record đổi từ xanh dương sang teal.** Đây là thay đổi dễ thấy nhất với người đã quen. Đồng ý, hay muốn giữ Record
   xanh dương và đổi accent (phương án B, có nhược điểm đã nêu)?
2. **Nút chuyển theme sáng/tối trong UI?** CSS đã hỗ trợ `:root[data-theme]`. Nếu muốn, cần một nút ở topbar và lưu vào
   `localStorage` (việc nhỏ, chưa đưa vào kế hoạch).
3. **Thanh công cụ ghost.** Mới/Mở…/Lưu/↶/↷ thành nút không viền để "▶ Xem trước" nổi hơn. Có chấp nhận nút ít "giống nút"
   hơn không?
4. **Màu Chọn bản ghi (olive).** Đây là hue còn trống duy nhất đủ xa các màu khác. Ở theme tối nó hơi gần badge cảnh báo
   khi mù màu đỏ (ΔE 2.6), nhưng khác hình. Có muốn đổi icon/hue khi làm 0006 không?
5. **Cỡ chữ nhỏ nhất 12 px** (thay 11 px) làm chip và badge cao thêm khoảng 2 px. Chấp nhận?
6. Danh sách lỗi nổi đè thẻ cuối: tách thành design doc bố cục riêng?

## Đã chốt (2026-10-27)

Người dùng giao cho chọn theo đề xuất:

1. Record chuyển sang xanh ngọc; màu nhấn giữ xanh dương.
2. Có nút chuyển sáng/tối/theo hệ thống trên thanh trên (dùng `data-theme`, nhớ trong `localStorage`).
3. Mới / Mở… / Lưu / ↶ / ↷ thành nút không viền (ghost) để "Xem trước" nổi bật.
4. Giữ màu ô liu cho Chọn bản ghi; luôn kèm icon và nhãn nên không dựa vào màu.
5. Cỡ chữ nhỏ nhất 12 px.
6. Danh sách lỗi che thẻ cuối: tách design doc bố cục riêng, không làm trong 0008.

Thứ tự: làm 0008 trước 0005, để chip biến của 0005 dùng luôn token mới.

## Đã làm

Làm hết 9 bước của kế hoạch (2026-10-27), không đổi workflow JSON, API hay dependency, không web font.

- **Token và thành phần (bước 1–6).** `client/css/app.css` mở đầu bằng khối token (primitive, ngữ nghĩa sáng, hai khối tối
  giống hệt nhau cho `prefers-color-scheme` và `:root[data-theme="dark"]`, thang đo, icon mask), kết thúc ở
  `/* ===== end tokens ===== */`. Phần dưới chỉ dùng token ngữ nghĩa, theo §6 của `docs/ui-design-system.md`: trạng thái thẻ
  (chọn, focus hở 3 px, lỗi ⊗, cảnh báo ▲ nền vàng chữ tối, tắt bằng nét đứt + tag `⏻ Đã tắt`, số liệu cũ nét đứt nghiêng,
  kéo/thả), nút theo mức (thanh công cụ ghost, hover nền trung tính, vô hiệu không opacity, `.danger.solid` cho "Insert"
  trong hộp xác nhận và "Xóa tất cả" khung có bước con), nhãn "✓ Đúng / ✗ Sai" màu Rẽ nhánh, ô `ref` màu chữ Record, tab gạch
  dưới, danh sách lỗi có icon. Cỡ chữ nhỏ nhất 12 px.
- **`data-type` + ô icon (bước 2).** `.step`, `.start-card`, `.palette-item`, `.popup-item` (menu "+") và `.node-head` của
  inspector có `data-type` và `icoTile()` (helper mới trong `client/js/dom.js`). Bỏ `NODE_COLORS`, inline `--c` và `.dot`.
- **Nút chuyển giao diện (Đã chốt 2).** Ô chọn Theo hệ thống / Sáng / Tối cuối thanh trên; `client/js/theme.js` (script
  thường trong `<head>`, áp dụng trước lần vẽ đầu) đặt hoặc bỏ `data-theme` trên `<html>` và nhớ trong
  `localStorage['sfdg.theme']` (có `try/catch`).
- **Test (bước 7).** `test/css-tokens.test.js` (9 test): không màu viết thẳng sau dòng `end tokens`; trong khối token chỉ
  primitive, bóng, backdrop và icon có giá trị thô; `client/js/*.js` không đặt màu; sáng/tối cùng tập token; mỗi loại
  (`NODE_TYPES` + `start` + `query`/`pick` dự kiến) có 4 token ở cả hai theme, `--ico-<type>` và luật `[data-type]`; cỡ chữ,
  font, độ đậm, bo góc, z-index dùng token; bảng primitive trong `ui-design-system.md` §2 khớp 1:1 với CSS; và (mục e) tính
  lại tương phản 74 cặp mỗi theme (38 cặp §8.1 + 6 cặp × 6 loại) từ giá trị thật trong CSS.
- **Smoke (bước 8).** `smoke.cjs` kiểm thêm `data-type`/ô icon trên thẻ, palette, menu "+"; không còn `NODE_COLORS`; nút
  chuyển giao diện (Tối, giữ sau tải lại, Theo hệ thống); chạy theme tối và hộp xác nhận Insert cho org production giả lập
  (nút đỏ đặc, hộp cảnh báo; request có `target` bị chặn). Ảnh mới `smoke-1440-dark.png`, `smoke-1440-dark-insert.png`,
  `smoke-390-dark.png`. `SKILL.md` mô tả đủ 12 luồng, gồm các luồng thêm ở đợt sửa review 0003.
- **Tài liệu (bước 9).** Bỏ dòng "Nháp" ở `ui-design-system.md` và bổ sung (nút chuyển giao diện §8.3, `icoTile()` §6.1,
  `.tab-issues`, `.only-warnings`, padding thanh công cụ). Sửa dòng màu ở 0003 (sọc và nhãn Đúng/Sai), 0005 (nhóm và
  `.var-chip`), 0006 (Query/Chọn bản ghi dùng `--step-query`/`--step-pick` có sẵn). Skill `add-node-type` có bước token +
  icon + `[data-type]`.

Khác với kế hoạch:

- Bước 1–6 làm trong một lượt (một commit) nên không có giai đoạn alias tên cũ (`--bg`, `--node-*`…).
- Bỏ 8 primitive không dùng có trong `tokens.css` của phiên thiết kế nhưng không có trong bảng §2 (`blue-800`, `red-800`,
  `amber-100/600/700`, `green-100/500/800`), để CSS khớp 1:1 với tài liệu.
- Để thanh trên vẫn một hàng ở 1440 px khi có thêm ô chọn giao diện: ô tên workflow 220 → 180 px, `#org-select` tối đa
  220 px (nhãn "alias — username" dài), nút ghost thanh công cụ padding 8 px. Ở ≤ 900 px ô chọn giao diện lên cùng hàng
  với Mới/Mở…/Lưu nên thanh trên vẫn 4 hàng như trước.
- Tab "⚠ Lỗi insert" bỏ ký tự ⚠, dùng icon ▲ SVG (`.tab-issues`). Thẻ "Bước lỗi" (mục không phải bước trong file) dùng nền
  `danger-subtle` + viền nét đứt `danger`. Đang kéo: cả thẻ và thân khung mờ 0.5 + nét đứt.

Kiểm chứng: `npm test` 104/104 qua; `node .claude/skills/smoke-test/smoke.cjs` SMOKE OK (~3.5–4.5 s). Tương phản tính từ
CSS cuối: 148 cặp, 0 cặp không đạt; 38 cặp của bảng §8.1 khớp từng số (2 chữ số thập phân). Thấp nhất: sáng
`focus-ring`/`bg` 3.40, tối `border-control`/`surface-raised` 3.39. Ảnh trước/sau của app thật (sáng/tối × 1440/390) nằm ở
scratchpad, không commit: `/tmp/claude-0/-home-user-sf-data-generator/fa9ad77c-1d8e-553a-9b3f-45d89b2dd244/scratchpad/ui-impl/{before,after}/`.

Còn lại (ngoài phạm vi 0008): danh sách lỗi nổi đè thẻ cuối (Đã chốt 6, cần design doc bố cục); thanh trên 4 hàng và thanh
Kết quả xuống dòng ở 390 px; các ký tự `⋯ ▸ ▾ ⠿ ↶ ↷ ⟳` chưa thành SVG; CSS `.var-chip` sẽ làm cùng 0005; Query/Chọn bản ghi
(0006) chỉ cần đặt `data-type`.
