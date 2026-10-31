# 0012 — Năng suất soạn thảo: thư viện workflow, chọn nhiều, copy/paste, sửa nhanh, số liệu trên thẻ

- **Trạng thái:** Đã làm
- **Ngày:** 2026-10-28
- **Liên quan:** [0003](0003-process-mode.md) (cây bước, phím, "Việc tiếp theo": chọn nhiều, copy/paste, ước tính số bản
  ghi, tô thẻ cha, field tên mặc định), [0004](0004-streaming-execution.md) (sự kiện tiến độ, nhóm lỗi insert),
  [0005](0005-variable-picker.md) (`analyzeScope`, dải chip, giá trị mẫu, "Sửa thành …"), [0006](0006-query-pick-nodes.md)
  (Query, lỗi field chưa SELECT, Import từ org, `queryPresets`), [0009](0009-bo-cuc-man-hinh.md) (thanh trên, menu ⋯, bottom
  sheet, mốc 720/900 px), [0010](0010-lap-theo-ban-ghi.md) (Lặp `each`, "Câu hỏi mở": bọc trong Lặp qua từng bản ghi).

Doc này gom chín việc nhỏ, độc lập, cùng mục đích: bớt thao tác lặp lại khi soạn workflow. Mỗi phần (A–I) làm và review
riêng được; thứ tự làm ở [Kế hoạch](#kế-hoạch-thực-hiện), **G (lỗi thật) làm trước**.

| Phần | Việc | Đổi hợp đồng? |
| --- | --- | --- |
| A | Thư viện workflow (nhiều workflow có tên, thay một bản autosave) | Không (chỉ `localStorage`) |
| B | Chọn nhiều bước; bọc / xóa / di chuyển / tắt cả nhóm; Ctrl+C / X / V qua bộ nhớ tạm hệ thống | Không (định dạng bộ nhớ tạm mới, không phải workflow) |
| C | "Bọc trong Lặp qua từng bản ghi" | Không |
| D | Thẻ hiện số liệu trực tiếp khi chạy và badge lỗi insert | Có, chỉ thêm: `byStep` trong `progress` insert và `insert.byStep` |
| E | Giá trị mẫu ngay trong inspector (3 giá trị) | Có, chỉ thêm: `POST /api/field-samples` |
| F | Sửa nhanh: "Thêm Industry vào SELECT"; gợi ý field bắt buộc còn thiếu | Có, chỉ thêm: `fix` trong issue |
| G | Field tên mặc định đúng theo sObject (Task → Subject) — **lỗi** | Có, chỉ thêm: `meta.recordPresets`, `nameField` trong describe, cảnh báo mới |
| H | Ước tính số bản ghi mỗi bước trước khi chạy | Không (hàm thuần mới ở `shared/`) |
| I | Rê/focus chip Lookup hoặc chip biến thì tô thẻ nguồn | Không |

Workflow JSON (`version: 2`) **không đổi**; file `version: 1` vẫn đi qua `shared/migrate-v1.js` như cũ.

## Vấn đề

Người dùng soạn workflow hằng ngày và gặp các chỗ tốn công sau (ví dụ thật từ các mẫu có sẵn):

1. **Chỉ có một workflow.** Autosave là một khóa `sfdg.workflow.v2`. Muốn thử "Lead theo xác suất" mà không mất "Account +
   Contact" thì phải Lưu file, Mới, rồi sau này Mở… lại file. Bấm Mẫu là thay mất workflow đang soạn (chỉ còn Ctrl+Z trong
   phiên đó).
2. **Mỗi lần chỉ thao tác một bước.** Muốn đưa `con` và `task` vào một vòng lặp mới: bọc `con`, rồi kéo `task` vào thân —
   5–6 thao tác. Muốn tắt 4 bước để thử: 4 lần Ctrl+/. Không chép được bước từ workflow này sang workflow khác (chỉ có
   Ctrl+D trong cùng workflow).
3. **Bọc một Contact có sẵn trong "Lặp qua từng bản ghi" của `accs`** phải: Bọc trong Lặp → đổi "Lặp theo" sang "Mỗi bản ghi
   trong pool" → kiểm tra pool tự điền. Menu ⋯ chỉ có "Lặp qua từng bản ghi" (thêm Lặp **rỗng** sau bước, 0010).
4. **Lúc chạy thẻ đứng yên.** Insert 200 000 bản ghi mất nhiều phút; tiến độ chỉ ở đầu panel kết quả, theo sObject. Có
   lỗi insert thì phải mở tab "Lỗi insert" mới biết bước nào; thẻ bước không có dấu gì.
5. **Không thấy giá trị trước khi chạy.** Sửa Picklist có trọng số, khoảng ngày `-1y`…`today`, mẫu `ACC-####` rồi phải
   Ctrl+Enter chạy cả workflow mới biết ra gì; dòng "Lần xem trước" chỉ có một giá trị và cũ đi ngay sau khi sửa.
6. **Biết lỗi nhưng phải tự sửa ở bước khác.** `{{acc.Industry}}` với `acc` chọn từ Query `accs` chưa lấy `Industry`: lỗi nói
   "Thêm Industry vào "Field cần lấy" của bước Query" — phải chọn bước Query, tìm ô, gõ. Record `con` đã có 3 field nhưng
   thiếu `LastName` bắt buộc: chỉ biết khi insert lỗi `REQUIRED_FIELD_MISSING`.
7. **(Lỗi) Record mới cho Task vẫn có field `Name`.** Đổi sObject của bước Record sang `Task` (hay `Contact`, `Case`, `Event`)
   thì field mặc định `Name` vẫn ở đó, insert lỗi `INVALID_FIELD` cho mọi bản ghi. Query đã xử lý trường hợp này
   (`queryPresets` và name field từ describe, 0006); Record thì chưa.
8. **Không biết sẽ sinh bao nhiêu bản ghi** trước khi chạy: Lặp 1–4 × Lặp 3 × Rẽ nhánh 30 % … phải nhẩm. Workflow vượt
   `maxRecords` chỉ báo khi chạy.
9. **Khó thấy chip đang trỏ tới bước nào.** Chip `AccountId · Lookup → acc` hay chip biến `[acc · Industry]` ở inspector: bước
   `acc` nằm đâu trong cây 40 bước?

## Mục tiêu / Ngoài phạm vi

Mục tiêu:

- A: nhiều workflow có tên, tự lưu từng cái; đổi workflow 2 thao tác; Mới / Mở file / Mẫu **không bao giờ** ghi đè workflow
  khác; chuyển autosave cũ vào thư viện không mất dữ liệu; không bao giờ ghi `sfdg.workflow.v1`.
- B: chọn nhiều ở cả Quy trình lẫn Sơ đồ, bằng chuột, bàn phím và cảm ứng; mỗi thao tác nhóm là **một** bước undo;
  copy/paste trong và giữa các workflow (và giữa hai tab) bằng JSON trong bộ nhớ tạm hệ thống, đổi id/alias theo đúng quy
  tắc của `cloneSteps`/`renameAlias`.
- C–I như bảng trên, với mặc định chạy được ngay.

Ngoài phạm vi (ghi ở [Câu hỏi mở](#câu-hỏi-mở--việc-tiếp-theo)):

- Lưu thư viện ra file trên đĩa / đồng bộ giữa máy; lịch sử phiên bản của một workflow.
- Kéo thẻ trên Sơ đồ (0003 đợt B vẫn không kéo thẻ); chọn bằng khung chữ nhật (lasso).
- Dán bước dạng v1 (đồ thị) — dùng Thư viện → Mở file để chuyển.
- Sửa nhanh "thêm field vào bước Record" cho lỗi `unknownMember` của bản ghi sinh ra (cần đoán kiểu field).
- `pick.filterValue` đã nhận biến (`vars: 'template'`), không đụng tới.

## Luồng người dùng

### A. Hai workflow song song (2 thao tác mỗi lần đổi)

1. Đang soạn "Account + Contact". Bấm `▾` cạnh ô tên (hoặc Ctrl+O) → popup Thư viện. (1)
2. Bấm `＋ Workflow mới` → workflow trống "Workflow mới" được tạo và mở; "Account + Contact" vẫn trong thư viện. (1)
3. Soạn. Mọi thay đổi tự lưu vào mục của chính nó. (0)
4. Muốn quay lại: `▾` → bấm "Account + Contact" trong danh sách "Gần đây". (2)

Bấm một Mẫu khi workflow đang mở có bước: Mẫu mở thành **mục mới** trong thư viện (không hỏi, không ghi đè). Workflow đang
mở trống và chưa đặt tên thì Mẫu thay vào chỗ đó (không đẻ mục rác).

### B. Bọc hai bước vào một vòng lặp (3 thao tác, trước đây 5–6)

1. Bấm thẻ `con`, Shift+bấm thẻ `task` → hai thẻ cùng được chọn; inspector hiện "2 bước đã chọn". (2)
2. Bấm `Bọc trong Lặp` ở inspector (hoặc ⋯ → Bọc trong Lặp). Một Lặp mới chứa `con`, `task` theo đúng thứ tự, được chọn. (1)

Ctrl+Z một lần là về như cũ.

### B'. Chép bước sang workflow khác (4 thao tác)

1. Chọn `acc` (Shift+↓ để thêm `loopCon` nếu cần), Ctrl+C. Toast `Đã sao chép 2 bước.` (1–2)
2. `▾` → mở workflow khác (2), chọn bước muốn dán sau, Ctrl+V. Toast `Đã dán 2 bước.` (1)

Workflow đích đã có alias `acc`: bản dán thành `acc2`, Lookup bên trong bản dán đi theo, toast nói `Đổi tên alias: acc → acc2.`
Bản dán trỏ tới alias không có ở đích (`{{users.Id}}`): thẻ có badge lỗi như mọi lỗi tham chiếu, toast nói thêm
`1 tham chiếu tới bước không có ở đây (users): xem thanh lỗi (F8).`

### C. Bọc Contact có sẵn trong Lặp qua từng bản ghi (2 thao tác)

1. ⋯ trên thẻ `con` → `Bọc trong Lặp qua từng bản ghi`. (2)
   Lặp `each` mới chứa `con`, `from` = pool gần nhất phía trên dùng được (ưu tiên pool mà các bước được bọc đang trỏ tới),
   `itemAlias` = `acc` (accs → acc). Lookup `AccountId` của `con` đang là "Ngẫu nhiên trong pool accs" thì toast hỏi
   `Đổi Lookup AccountId sang bản ghi đang lặp "acc"?` [Đổi] — một bấm nữa nếu muốn. (0–1)

### D. Theo dõi insert trên thẻ (0 thao tác)

Trong lúc insert, thẻ `con` ghi `insert 1 200/5 000`, thẻ khung Lặp đóng ghi tổng bên trong. Có lỗi thì thẻ có tag
`⊗ lỗi 3`; bấm tag → panel kết quả mở tab "Lỗi insert", dòng nhóm lỗi đầu tiên của bước đó được tô và focus.

### E. Xem giá trị khi sửa option (0 thao tác)

Mở ⚙ của field `Industry` (Picklist), sửa trọng số: 300 ms sau dòng `Ví dụ: "Banking" · "Retail" · "Banking"` cập nhật.

### F. Sửa nhanh (1 thao tác)

- Field `Title` của `con` có lỗi `Template dùng {{acc.Industry}} nhưng Query "accs" không lấy field Industry. …` — dưới câu lỗi có
  nút `Thêm Industry vào SELECT của "accs"`. Bấm: field được thêm vào Query (builder hoặc SOQL tự viết), lỗi hết sau validate.
- Chọn bước Record `con` (Contact, đã có org): khung gợi ý trên danh sách field `Thiếu 1 field bắt buộc của Contact trong
  dev-sb: LastName.` [Thêm 1 field] [Chọn…].

### G. Record Task đúng ngay (0 thao tác thêm)

Đổi sObject của Record mới sang `Task` → danh sách field thành `Subject` (Text, danh sách `Call`, `Send Letter`, …) ngay lập
tức; đã chọn org thì ~0,5 s sau được chỉnh theo describe (mọi field bắt buộc tạo được). Workflow cũ có Task với `Name`: cảnh
báo trên thẻ, nút `Đổi thành Subject`.

### H, I

- H: không chạy gì, thẻ `con` đã ghi `≈ 12 bản ghi`, thẻ Bắt đầu ghi `≈ 17 bản ghi · ≤ 50 000`.
- I: rê chuột (hoặc Tab tới) chip `[acc · Industry]` ở inspector → thẻ `acc` có viền nét đứt màu accent.

## Thiết kế UI

### A. Thư viện workflow

**Thanh trên.** Ô tên workflow có thêm nút `▾` dính bên phải (`#btn-library`, 32 × 32 px, `aria-label="Thư viện workflow"`,
`title="Thư viện workflow (Ctrl+O)"`, `aria-haspopup="menu"`, `aria-expanded`). Nút `Mở…` **rời thanh trên** (vào popup Thư viện),
nên tổng chiều rộng nhóm `.tb-file` giảm khoảng 16 px (−56 px `Mở…`, +40 px `▾` và khoảng cách): mốc 1 hàng của 0009 giữ nguyên.
`Mới` và `Lưu` giữ chỗ. `Lưu` giữ nhãn và Ctrl+S (tải file JSON); `title` đổi thành
`Tải file workflow JSON (Ctrl+S). Thư viện trong trình duyệt tự lưu mọi thay đổi.`

Ở ≤ 720 px: hàng 1 thành `[tên ……][▾][Seed 42][↶][↷][⋯]`; nhóm Workflow của menu ⋯ thành `Mới`, `Thư viện…` (kbd `Ctrl+O`),
`Mở file JSON…`, `Lưu` (kbd `Ctrl+S`).

**Popup Thư viện** (popup chung `popup.js`, neo vào `▾`, tiêu đề `Thư viện`):

```
[Tìm workflow…]                          ← chỉ khi thư viện > 6 mục
＋ Workflow mới
⇪ Mở file JSON…
── Gần đây ──
✓ Account + Contact        4 bước · 10:24
  Lead theo xác suất       2 bước · hôm qua
  Opp có sản phẩm          9 bước · 21/10
  … (tối đa 20 mục mới sửa nhất; còn lại qua ô tìm)
── ──
  Quản lý thư viện…
```

- Hàng workflow là `menuitemradio` (✓ ở mục đang mở). Mô tả: `<n> bước · <giờ hôm nay | hôm qua | dd/mm>`.
- Đang chạy (xem trước hoặc insert): mọi hàng đổi workflow, `＋ Workflow mới`, `Mở file JSON…` bị khóa,
  `title="Đang chạy. Bấm Dừng hoặc chờ chạy xong rồi đổi workflow."`. Nút `Mới` của thanh trên cũng khóa với cùng title.
- Ctrl+O mở popup này ở mọi chỗ (kể cả trong ô nhập; `preventDefault` chặn hộp mở file của trình duyệt).

**Hộp thoại "Quản lý thư viện"** (`#modal`):

```
Thư viện workflow                                                        
Tên                         Bước   Sửa lúc        Dung lượng
[Account + Contact     ]     4     10:24          2 KB     [Mở] [Nhân bản] [Tải JSON] [Xóa]
[Lead theo xác suất    ]     2     hôm qua        1 KB     [Mở] [Nhân bản] [Tải JSON] [Xóa]
Lưu trong trình duyệt này (http://127.0.0.1:3000). Đã dùng 0,4 MB / khoảng 5 MB.
                                              [Tải tất cả (JSON)]  [Đóng]
```

- Ô Tên sửa tại chỗ (đổi khi `change`). Đổi tên mục đang mở cũng đổi ô tên trên thanh trên (một bước undo như gõ ở đó);
  đổi tên mục khác không vào undo.
- `Nhân bản` → mục mới `<tên> (bản sao)`, `(bản sao 2)`… ngay dưới, không mở. `Xóa` → xóa ngay, toast
  `Đã xóa workflow "Lead theo xác suất".` [Hoàn tác] (10 s). Xóa mục đang mở thì mở mục mới sửa gần nhất; không còn mục
  nào thì tạo "Workflow mới" trống.
- Dòng chú thích nói rõ nơi lưu và origin: thư viện của `http://localhost:3000` khác `http://127.0.0.1:3000`.
- ≤ 720 px: hộp thoại rộng hết màn hình, mỗi mục là hai dòng (tên + `4 bước · 10:24 · 2 KB` / hàng nút); nút `Nhân bản`,
  `Tải JSON`, `Xóa` vào một nút `⋯` của mục để vừa 360 px.
- `Tải tất cả (JSON)` → file `sfdg-library-YYYY-MM-DD.json` (xem [định dạng](#định-dạng-file-thư-viện)). `Mở file JSON…` nhận
  file này: mọi workflow thành mục mới (không ghi đè), toast `Đã thêm 12 workflow vào thư viện.`

**Mới / Mở file / Mẫu không còn hỏi `Thay workflow hiện tại?`** vì không ghi đè gì: mỗi lệnh tạo **mục mới** và mở nó. Ngoại
lệ tránh mục rác: workflow đang mở **trống** (0 bước) và tên vẫn là `Workflow mới` thì lệnh dùng lại chính mục đó.

**Đổi workflow** đặt lại undo/redo (Ctrl+Z không bao giờ đưa nội dung workflow A vào B), bỏ lựa chọn, xóa kết quả chạy
(panel về "Chưa chạy.", chip số liệu hết). Danh sách "đã insert với seed này" (cảnh báo trùng seed của hộp xác nhận insert)
**được giữ** và thành một danh sách tối đa 20 mục `{ key: runKey, org }` trong bộ nhớ của tab, nên chép một workflow rồi
insert lại cùng seed vẫn được cảnh báo.

**Hết bộ nhớ (quota).** Mỗi lần lưu bọc `try/catch`. Gặp `QuotaExceededError`: xóa thùng rác (mục vừa xóa, xem dưới) rồi thử
lại; vẫn lỗi thì:

- Ô tên có thêm nút cảnh báo `▲ Chưa lưu` (nền `warning-subtle`, `aria-live="polite"`), bấm vào mở hộp Quản lý thư viện.
- Toast (một lần cho tới khi lưu lại được), 12 s:
  `Bộ nhớ trình duyệt đã đầy nên chưa lưu được thay đổi của "Account + Contact". Xóa bớt workflow trong Thư viện, hoặc bấm Lưu (Ctrl+S) để tải file JSON.` [Mở Thư viện]
- `beforeunload` hỏi trước khi đóng tab khi còn thay đổi chưa lưu.
- Mỗi lần sửa sau đó thử lưu lại; lưu được thì nút biến mất, toast `Đã lưu lại "Account + Contact".`

**Hai tab cùng mở một workflow.** Tab nhận sự kiện `storage` của mục đang mở (do tab khác ghi) thì **tạm dừng tự lưu** của mục
đó và hiện toast không tự tắt:
`"Account + Contact" vừa được sửa ở một tab khác.` [Dùng bản ở tab kia] [Giữ bản của tab này]
— "Dùng bản ở tab kia" nạp bản mới (đặt lại undo); "Giữ bản của tab này" ghi đè bản kia và tự lưu tiếp. Khi đang tạm dừng,
`beforeunload` cũng hỏi. Mục đang mở bị xóa ở tab khác: tab này giữ nội dung và lần lưu kế tiếp thêm lại mục vào thư viện
(toast `"…" đã bị xóa ở tab khác; tab này vẫn giữ và đã lưu lại.`). Mỗi tab nhớ mục đang mở của mình (`sessionStorage`), nên
hai tab mở hai workflow khác nhau không giành nhau.

**Chuyển autosave cũ (lần đầu chạy bản có thư viện).** Không có `sfdg.library`:

1. `sfdg.workflow.v2` hợp lệ → thành mục đầu tiên (giữ tên). Toast `Workflow đang soạn đã được đưa vào Thư viện (nút ▾ cạnh tên).
   Bản lưu cũ vẫn được giữ trong trình duyệt.`
2. Không có v2 nhưng có `sfdg.workflow.v1` → chuyển như hôm nay (`migrateV1`, hộp báo cáo) vào mục đầu tiên.
3. Không có gì → mục "Account + Contact" từ mẫu đầu tiên (như hôm nay mở mẫu đầu).
4. `sfdg.workflow.v2` hỏng → như hôm nay (bản sao `sfdg.workflow.v2.broken`, toast "Tải bản lưu"); thư viện bắt đầu bằng mẫu.

Ghi mục trước, ghi chỉ mục sau; chỉ khi cả hai thành công mới coi là xong. `sfdg.workflow.v2` và `sfdg.workflow.v1` **không bị
ghi, không bị xóa** (v2 thành bản sao lưu đóng băng). Ghi thất bại vì quota: tab chạy chế độ cũ (một autosave
`sfdg.workflow.v2` như hôm nay), nút `▾` khóa với `title="Chưa tạo được Thư viện vì bộ nhớ trình duyệt đầy. Workflow này vẫn được tự lưu như trước."`.

**Mục hỏng** (`sfdg.wf.<id>` không đọc được / `malformedSteps`): vẫn hiện trong danh sách, mô tả `không mở được`; bấm vào thì
toast như autosave hỏng hôm nay kèm [Tải bản lưu], workflow đang mở không đổi.

### B. Chọn nhiều, thao tác nhóm, copy/paste

**Mô hình lựa chọn.** Một bước "chính" (có focus, là bước inspector và các phím một-bước dùng như hôm nay) cộng thêm các bước
khác. Hai loại:

- **Dải liền nhau** (Shift): các bước liền nhau **trong cùng một dãy** (cùng cha, cùng slot). Shift+bấm một thẻ ở dãy khác thì
  cả hai đầu được nâng lên tổ tiên nằm trong **dãy chung gần nhất**: anchor `con` trong thân Lặp `loopCon`, Shift+bấm `opp` ở
  gốc ⇒ chọn `loopCon … opp` ở gốc. Nhờ vậy dải luôn bọc / di chuyển được.
- **Chọn rời** (Ctrl/⌘+bấm): bật/tắt từng thẻ ở bất kỳ đâu. Chọn cả một khung lẫn bước bên trong nó thì bước bên trong được
  bỏ khỏi tập (đã nằm trong khung).

| Thao tác | Dải liền nhau | Chọn rời |
| --- | --- | --- |
| Xóa (Delete), Tắt/Bật (Ctrl+/), Sao chép (Ctrl+C), Cắt (Ctrl+X) | có | có |
| Nhân bản (Ctrl+D) | bản sao cả dải đặt ngay sau dải | mỗi bước một bản sao ngay sau chính nó |
| Lên/Xuống (Alt+↑/↓), kéo ⠿ | cả dải di chuyển như một khối | không: khóa, `title="Chỉ di chuyển được các bước liền nhau trong cùng một dãy."` (kéo ⠿ của một thẻ thì chỉ thẻ đó đi, lựa chọn thu về thẻ đó) |
| Bọc trong Lặp / Lặp qua từng bản ghi / Rẽ nhánh | có | khóa, `title="Chỉ bọc được các bước liền nhau trong cùng một dãy."` |
| Dán (Ctrl+V) | sau bước cuối của lựa chọn (theo thứ tự đọc) | như bên trái |

Tắt/Bật nhóm: còn ít nhất một bước đang bật thì tắt tất cả, không thì bật tất cả. Toast `Đã tắt 3 bước. Bấm Ctrl+/ để bật lại.`
/ `Đã bật lại 3 bước.`

**Chuột (cả hai view).** Bấm = chọn một. Shift+bấm = dải từ anchor (bước chính trước đó). Ctrl/⌘+bấm = bật/tắt. Bấm nền = bỏ
chọn (như hôm nay). Thẻ được chọn đều có kiểu "Đang chọn" của `ui-design-system.md` §6.4; bước chính thêm vòng focus khi có
focus bàn phím.

**Bàn phím (cả hai view, cùng bảng của 0003 §Bàn phím).**

| Phím | Tác dụng |
| --- | --- |
| Shift+↑ / Shift+↓ | Mở rộng / thu hẹp dải về phía trước / sau **trong dãy của anchor** (không vào/ra khung). Ở đầu/cuối dãy: không làm gì |
| Ctrl+A (focus trong cây) | Chọn mọi bước cùng dãy với bước chính |
| Esc | Đang chọn nhiều ⇒ chỉ giữ bước chính; lần nữa ⇒ bỏ chọn (như hôm nay) |
| Ctrl+C / Ctrl+X / Ctrl+V | Sao chép / cắt / dán (xem dưới). Không chặn khi đang gõ trong ô nhập |
| Delete, Ctrl+/, Ctrl+D, Alt+↑/↓, ContextMenu / Shift+F10 | Như hôm nay, áp cho cả lựa chọn |
| ↑ / ↓ / ← / → / Home / End | Như hôm nay; thu lựa chọn về một bước |

ARIA: `role="tree"` của cả hai view có `aria-multiselectable="true"`; mọi thẻ trong lựa chọn `aria-selected="true"`; roving
tabindex vẫn ở bước chính. Vùng `aria-live="polite"` ẩn (`#sel-live`) đọc `Đã chọn 3 bước.` khi số lượng đổi (không đọc khi
về 1).

**Inspector khi chọn nhiều** (≥ 2 bước; màn hình hẹp: trong bottom sheet):

```
3 bước đã chọn
Record "con" · Record "task" · Lặp "loop2"
[Bọc trong Lặp] [Bọc trong Lặp qua từng bản ghi] [Bọc trong Rẽ nhánh]
[Sao chép] [Cắt] [Nhân bản] [Tắt 3 bước] [Xóa 3 bước]
Mẹo: Shift+bấm để chọn dải, Ctrl+bấm để chọn rời, Esc để bỏ.
```

Nút khóa theo bảng trên (cùng `title`). Không có form option chung (sửa hàng loạt option: Câu hỏi mở).

**Menu ⋯ (thẻ một bước, sắp lại thành nhóm** — popup đã hỗ trợ nhóm, nên menu dài hơn vẫn quét được):

| Nhóm | Mục (phím) |
| --- | --- |
| Chỉnh sửa | Sao chép (Ctrl+C) · Cắt (Ctrl+X) · Dán sau bước này (Ctrl+V) · Nhân bản (Ctrl+D) |
| Di chuyển | Lên (Alt+↑) · Xuống (Alt+↓) |
| Bọc | Bọc trong Lặp · **Bọc trong Lặp qua từng bản ghi** (C) · Bọc trong Rẽ nhánh · Lặp qua từng bản ghi (0010, chỉ bước pool) · Bỏ vỏ (khung) |
| Chọn | **Chọn nhiều bước** — chỉ ở ≤ 900 px hoặc `(pointer: coarse)` |
| — | Tắt bước / Bật bước (Ctrl+/) · Xóa (Delete) |

⋯ trên một thẻ **thuộc** lựa chọn nhiều: tiêu đề `3 bước đã chọn`, cùng các mục, áp cho cả lựa chọn (mục khóa theo bảng). ⋯ trên
thẻ **không** thuộc lựa chọn: lựa chọn thu về thẻ đó (như hôm nay `select` trong `openStepMenu`).

**Cảm ứng / màn hình hẹp (≤ 900 px).** Không có Shift/Ctrl, nên có **chế độ chọn**: ⋯ → `Chọn nhiều bước` (thẻ đó là bước đầu
tiên). Trong chế độ chọn:

- `body.select-mode`; bottom sheet đóng; chạm thẻ = bật/tắt thẻ đó (không mở sheet); kéo ⠿ tắt.
- Thanh thao tác dính đáy (`.select-bar`, `role="toolbar"`, `aria-label="Thao tác với các bước đã chọn"`, cao 56 px, chỗ của
  sheet, toast nằm trên nó như với sheet):
  `[3 đã chọn] [Bọc ▾] [Xóa] [⋯] [Xong]` — `Bọc ▾` mở popup 3 kiểu bọc; `⋯` có Sao chép, Cắt, Dán, Nhân bản, Tắt/Bật, Lên,
  Xuống. Tổng ≈ 286 px, vừa 360 px.
- `Xong`, Esc hoặc bỏ chọn hết ⇒ thoát, lựa chọn thu về bước chính, sheet vẫn đóng.

**Sơ đồ.** Cùng chuột/phím. Thẻ bị cull (ngoài khung nhìn) không có DOM; khi được tạo lại nó đọc lựa chọn trong
`decorateCard` nên đúng kiểu. Chỉ bước chính được ghim trong DOM (như hôm nay).

**Copy / cut / paste.**

- Bắt sự kiện `copy` / `cut` / `paste` của `document` (không dùng `navigator.clipboard` cho phím): chạy được cả khi `HOST` là
  địa chỉ LAN (không phải secure context), không hỏi quyền. Chỉ xử lý khi focus **không** ở ô nhập/textarea/contenteditable và
  có bước được chọn (copy/cut) — trong ô nhập, trình duyệt làm như thường.
- Nội dung ghi vào `text/plain` là JSON dễ đọc ([định dạng](#định-dạng-bộ-nhớ-tạm)), nên dán vào chat/editor cũng xem được.
- Mục menu `Sao chép`/`Cắt` gọi `document.execCommand('copy'|'cut')` trong lúc bấm (kích hoạt đúng sự kiện trên). Mục `Dán sau
  bước này` thử `navigator.clipboard.readText()`; bị từ chối thì dùng **bản sao trong bộ nhớ** của tab (lần Sao chép gần nhất);
  không có ⇒ toast `Không đọc được bộ nhớ tạm. Chọn bước rồi bấm Ctrl+V để dán.`
- Vị trí dán = `defaultInsertTarget` (đúng quy tắc của "+" và palette): khung có slot trống ⇒ vào slot trống đầu; không thì
  ngay sau bước chính (chọn nhiều: sau bước cuối theo thứ tự đọc); không chọn gì ⇒ cuối dãy gốc.
- Sau khi dán: chọn **mọi** bước vừa dán (dải liền nhau), cuộn tới bước đầu và nháy.

Đổi tên khi dán (`pasteSteps`, `shared/workflow-tree.js`, dùng lại `cloneSteps`):

| Thứ | Quy tắc | Ví dụ |
| --- | --- | --- |
| id | luôn mới (`nextId`, không trùng `collectIds` của đích) | `acc` → `acc_2` |
| Alias / `itemAlias` định nghĩa trong bản dán | **giữ tên nếu còn trống ở đích**, trùng thì `nextName` (`cloneSteps` với `keepFree: true`). Tham chiếu *bên trong* bản dán đi theo (`renameAlias` giới hạn trong bản dán) | Dán vào workflow trống: giữ `acc`; dán vào chính nó: `acc2` |
| Biến lặp (`alias` của Lặp) | đổi khi che biến của Lặp bao quanh vị trí dán, hoặc trùng alias bản ghi | dán Lặp `loop` vào trong Lặp `loop` ⇒ `loop2`, `{{loop.index}}` bên trong đổi theo |
| Tham chiếu ra ngoài bản dán | giữ nguyên chuỗi. Trong cùng workflow ⇒ trỏ về bước gốc (như Ctrl+D). Đích không có ⇒ lỗi tham chiếu thường của `analyzeScope` (badge, thanh lỗi) | `AccountId → acc` dán vào workflow không có `acc` |
| `disabled` | giữ | |
| Trạng thái thu gọn | không chép (UI) | |

Toast sau khi dán (ghép các phần có): `Đã dán 2 bước.` + ` Đổi tên alias: acc → acc2, con → con2.` + ` 1 tham chiếu tới bước
không có ở đây (users): xem thanh lỗi (F8).` Cắt: `Đã cắt 2 bước. Bấm Ctrl+V để dán.` (một bước undo; dán lại là bước undo khác).

Từ chối dán (toast, workflow không đổi):

| Trường hợp | Câu |
| --- | --- |
| Không phải JSON, hoặc JSON không có bước | `Bộ nhớ tạm không chứa bước nào của SF Data Generator. Chọn bước rồi bấm Ctrl+C để sao chép.` (chỉ khi focus ở cây / thẻ; dán ở chỗ khác thì im lặng) |
| Bước sai dạng (`malformedSteps`) | `Không dán được: <câu của malformedSteps>.` |
| Loại bước không có trong `/api/meta` | `Không dán được: bước loại "foo" không có trong phiên bản này.` |
| Quá 2 000 bước hoặc > 5 MB | `Nội dung dán quá lớn (3 120 bước). Dán tối đa 2 000 bước mỗi lần.` |
| Workflow version 1 | `Đây là workflow version 1. Mở bằng Thư viện → Mở file JSON… để chuyển đổi.` |
| Dán vào trong chính khung đang cắt? | Không xảy ra: cắt xóa trước, dán sau |

Dán **một file workflow v2 đầy đủ** (`{ version: 2, steps }`) cũng được: dán các bước của nó. Vượt `maxDepth` sau khi dán: không
chặn, lỗi validate sẵn có báo đúng bước.

**Undo:** mỗi thao tác nhóm (xóa, tắt, nhân bản, bọc, di chuyển một lần Alt+↑, kéo, cắt, dán) là **một** bước undo. Alt+↑ liên
tiếp cho cùng một dải gộp như hôm nay (`coalesceKey: 'move:<id đầu>…'`). Thay đổi lựa chọn không vào undo. Undo/redo khôi phục
lựa chọn về bước chính nếu nó còn (như `restore` hôm nay); lựa chọn nhiều không được khôi phục.

**Xóa nhóm.** Không có khung nào chứa bước con ⇒ xóa ngay, toast `Đã xóa 3 bước.` [Hoàn tác] (cộng câu "đang được dùng ở N chỗ"
như xóa một bước). Có ⇒ hộp thoại `Xóa 3 bước và 5 bước bên trong?` (`Có thể hoàn tác bằng Ctrl+Z.`) [Hủy] [Xóa tất cả] — không
có "Chỉ xóa vỏ" cho nhóm.

### C. Bọc trong Lặp qua từng bản ghi

Mục `Bọc trong Lặp qua từng bản ghi` (menu ⋯ nhóm Bọc, inspector chọn nhiều, popup `Bọc ▾`) trên một bước hoặc một dải:

1. Tạo Lặp `each` (`newStep('loop', …, around)`, nên biến lặp không che vòng ngoài) thay chỗ dải, dải vào `body`.
2. `from`: trong các pool **dùng được ở vị trí Lặp mới** (`refChoices(…, { pool: true })`, `usable`), chọn pool mà các bước được
   bọc trỏ tới nhiều nhất (Lookup `ref`, `pick.from`, template `{{accs.…}}`); hòa hoặc không có ⇒ pool gần nhất (quy tắc của
   `fillEach`). `itemAlias` = `suggestPickAlias(from)`.
3. Không có pool nào dùng được ⇒ mục **khóa**, `title="Chưa có pool nào phía trên (bước Query, Record hoặc Chọn bản ghi có alias). Thêm một bước như vậy ở phía trên trước."`
4. Một bước undo. Lặp mới được chọn và nháy.
5. Gợi ý nối lại: các field Lookup / Master-Detail trong dải có `ref` = `from` (chế độ Ngẫu nhiên) hoặc = alias của một Chọn bản
   ghi từ `from` ⇒ toast 8 s `Đổi Lookup AccountId (con) sang bản ghi đang lặp "acc"?` [Đổi] (nhiều field: `Đổi 2 Lookup sang bản
   ghi đang lặp "acc"?`). [Đổi] đặt `ref = itemAlias`, `mode = 'current'` (một bước undo riêng). Không tự đổi, vì đổi Lookup là
   đổi dữ liệu sinh ra.

### D. Thẻ khi chạy

Một hàm vẽ chung `paintRunInfo(byStep, { phase, base })` ở mỗi view (`process.js`, `canvas.js`) **chỉ vá** chip `.stat` và tag
lỗi theo `data-id` (không dựng lại DOM, giữ focus và cuộn), gọi mỗi khi có sự kiện `progress` (server đã giới hạn 4 lần/giây).

| Lúc | Chip trên thẻ (`.stat.live`) | Ghi chú |
| --- | --- | --- |
| Xem trước / lượt kiểm tra trước insert | `statChip(step, ev.byStep)` như sau khi xong (`1 200 bản ghi`, `300 lần lặp`, `Đúng 40 · Sai 60`) | `byStep` đã có trong `progress` `generate` (0004), hôm nay UI bỏ qua |
| Insert | Record: `insert 1 200/5 000` (tổng = `stats.byStep[id].records` của bản xem trước được xác nhận). Khung: giữ chip của lượt kiểm tra | cần `byStep` mới của `progress` insert |
| Xong | Như hôm nay (từ `result.stats.byStep`) | |

`.stat.live`: như `.stat`, chữ `tabular-nums`, không animation (tôn trọng giảm chuyển động). Không `aria-live` trên thẻ (tiến độ đã
đọc ở đầu panel kết quả).

**Tag lỗi insert** (`.tag-insert-err`, là nút): `⊗ lỗi 3` (icon ⊗, chữ `danger-text`, viền `danger`, nền `danger-subtle`; khác badge
validate là số trên nền đỏ đặc). `title`/`aria-label`: `3 bản ghi của bước này insert lỗi. Bấm để xem nhóm lỗi.` Số lấy từ
`insert.byStep[id].failed` (đếm đủ, kể cả "Bỏ qua vì bản ghi cha lỗi"), cập nhật trong lúc insert. Bấm: mở panel kết quả, tab
"Lỗi insert", tô (`.current`) và focus dòng nhóm lỗi đầu của bước đó (nhóm vượt 100: chỉ tab). Khung thu gọn: ghi chú
`3 bước bên trong · lỗi insert 12`. Tag giữ tới lần chạy kế tiếp; workflow sửa sau đó thì tag thêm `.stale` (như chip). Thẻ
Sơ đồ: tag ở hàng `dg-tags`.

### E. Giá trị mẫu trong inspector

Thay dòng "Lần xem trước" một giá trị bằng một hàng **3 giá trị**, đặt cuối khối option của field đang mở ⚙ (chỉ field đang mở;
field đóng không gọi gì):

- Field **độc lập** (không tham chiếu bước khác hay biến lặp; kiểu không phải Lookup / Master-Detail): `Ví dụ: "Banking" ·
  "Retail" · "Banking"`, `title="Ba giá trị sinh riêng cho field này (seed 1) để thấy ngay tác dụng của tùy chọn. Xem trước có thể ra giá trị khác."`
  Lấy từ `POST /api/field-samples` (debounce 300 ms sau mỗi lần sửa option của field; lần gọi cũ bị bỏ bằng số thứ tự +
  `AbortController`). Seed = ô Seed nếu là số, không thì `1`; `now` = 00:00 hôm nay giờ máy, nên ví dụ đứng yên khi gõ và chỉ đổi
  theo option.
- Field **phụ thuộc** (Lookup, Master-Detail; template / Lấy từ biến có tham chiếu tới bước khác hay biến lặp; hoặc `{{this.X}}`
  với X phụ thuộc — tính bắc cầu từ `currentScope().refs`): 3 bản ghi đầu của bước trong lần xem trước gần nhất:
  `Lần xem trước: → acc#1 · → acc#2 · → acc#1`; workflow đã đổi ⇒ xám nghiêng, `title="Từ lần xem trước; workflow đã thay đổi sau đó."`
  (quy tắc của 0005). Chưa có lần xem trước: `Bấm Xem trước (Ctrl+Enter) để thấy giá trị: field này lấy dữ liệu từ bước khác.`
- `null` hiện `—`; định dạng giá trị dùng `formatSample` (0005).
- Server báo lỗi (ví dụ giá trị duy nhất cạn): hàng thành chữ `danger-text` `Không tạo được ví dụ: <câu lỗi của server>`.
- Bảng chọn biến giữ dòng "Lần xem trước" của nó (0005), không đổi.

### F. Sửa nhanh

**F1. "Thêm <Field> vào SELECT".** Issue `unknownMember` của nguồn đọc từ org (Query, hoặc Chọn bản ghi / bản ghi đang lặp có gốc
là Query) mang `fix: { kind: 'addSelectField', stepId: '<id Query>', field: 'Industry' }`. Inspector (`fillErrors`) hiện nút link
`Thêm Industry vào SELECT của "accs"` dưới câu lỗi, cạnh nút "Sửa thành …" sẵn có. Bấm (một bước undo, `source:
'inspector-structure'`):

- Builder: thêm vào cuối `fields` nếu chưa có (so không phân biệt hoa thường).
- SOQL tự viết: `addSelectField(soql, field)` (`shared/soql.js`) chèn `, Industry` sau field cuối của danh sách SELECT **cấp
  ngoài** (trước `FROM`). Không phân tích được (subquery trong SELECT, `FIELDS(ALL)`, SOQL lỗi) ⇒ issue không có `fix`, không có
  nút.
- Toast `Đã thêm Industry vào Query "accs". Bấm Xem trước để đọc lại.` (SOQL đổi nên cache không dùng lại, 0006).

Hàng lỗi ở thanh lỗi (0009) không thêm nút (bấm dòng → tới đúng field, nút ở đó).

**F2. Field bắt buộc còn thiếu (Record đã có field).** Khi một bước Record được chọn, đã chọn org và `sobject` hợp lệ, inspector
gọi `api.describe(org, sobject)` (cache theo `org|sobject` trong phiên, xóa khi bấm ⟳ danh sách org) rồi so field bắt buộc
(`required` của `mapDescribe`) với field đã có (không phân biệt hoa thường). Thiếu ⇒ khung `.hint-box` trên tiêu đề "Fields":

```
Thiếu 2 field bắt buộc của Opportunity trong dev-sb: StageName, CloseDate.   [Thêm 2 field] [Chọn…] [Bỏ qua]
```

- `Thêm 2 field`: thêm đúng các field đó với kiểu và option như Import (cùng hàm `fieldsFromDescribe`, kể cả tự chọn bản ghi cha
  cho Lookup bắt buộc theo luật của Import, 0006/0010), một bước undo, toast `Đã thêm 2 field: StageName, CloseDate.`
- `Chọn…`: mở hộp Import sẵn có; các field bắt buộc còn thiếu đứng đầu dưới nhóm `Bắt buộc, chưa có (2)` và được tích sẵn (hộp
  đã tích sẵn field bắt buộc; thêm tiêu đề nhóm).
- `Bỏ qua`: ẩn khung cho bước này trong phiên (không lưu).
- Describe lỗi / sObject không có: không hiện gì (lỗi đã có chỗ báo ở ô sObject).
- Không vào thanh lỗi: validate ở server không có describe (chạy không cần org).

### G. Field tên mặc định theo sObject (lỗi)

**Mặc định từ server.** `meta.recordPresets` (mới, `RECORD_PRESETS` trong `server/workflow/nodes.js`, cạnh `QUERY_PRESETS`) là
danh sách field mặc định của bước Record cho các sObject chuẩn **không** có field `Name` tạo được hoặc có field bắt buộc khác:

| sObject | Field mặc định |
| --- | --- |
| `Account` | `Name` (Text, Tên công ty) — như hôm nay |
| `Contact` | `FirstName` (Text, Tên), `LastName` (Text, Họ) |
| `Lead` | `FirstName`, `LastName`, `Company` (Text, Tên công ty) |
| `Task` | `Subject` (Text, danh sách `Call`, `Send Letter`, `Send Quote`, `Other`) |
| `Event` | `Subject` (như Task), `ActivityDateTime` (DateTime, 0–30 ngày tới), `DurationInMinutes` (Number 30–90) |
| `Case` | `Subject` (Text, từ ngẫu nhiên 3–6 từ) |
| `Opportunity` | `Name` (Text, từ ngẫu nhiên), `StageName` (Text, danh sách `Prospecting`), `CloseDate` (Date, hôm nay → +90 ngày) |

sObject khác (kể cả custom): `Name` (Text, Họ tên) như hôm nay. Mỗi preset có thêm `noName: true` khi sObject không có field
`Name` tạo được (Contact, Lead, Task, Event, Case).

**Khi đổi sObject của bước Record** (inspector `onStepOption`, giống `applyQueryPreset`):

1. Danh sách field **chưa bị sửa** (bằng preset của sObject cũ, hoặc bằng danh sách vừa tự điền cho bước này — nhớ trong bộ nhớ như
   `autoFields` của Query) ⇒ thay ngay bằng preset của sObject mới. Đã sửa ⇒ không đụng.
2. Đã chọn org và sObject có trong danh sách sObject của org ⇒ 500 ms sau gọi describe; nếu danh sách field vẫn là cái vừa tự
   điền, thay bằng: **mọi field bắt buộc tạo được** (`mapDescribe`, như Import, Lookup bắt buộc tự chọn bản ghi cha theo luật Import)
   ; không có field bắt buộc nào ⇒ `nameField` nếu tạo được (`mapDescribe` trả thêm `nameField`); không có cả hai ⇒ giữ preset/`Name`
   của bước 1.
3. Không có bước undo riêng: Ctrl+Z bỏ việc đổi sObject cũng trả lại danh sách field (như Query). Không toast (ô Fields đổi ngay
   dưới mắt); đổi theo describe thì toast `Đã đặt field mặc định cho Task theo dev-sb: Subject.`

Bước Record mới từ palette (`newStep`): field mặc định = preset của `sobject` mặc định (Account ⇒ `Name` công ty, không đổi dữ liệu
mẫu và hash vàng).

**Workflow cũ đã lỡ có `Name` trên sObject `noName`.** Validate thêm **cảnh báo** gắn `fields.Name`:
`Task không ghi được field Name nên insert sẽ lỗi. Đổi thành Subject hoặc xóa field này.` (Contact/Lead: `… Đổi thành LastName …`), kèm
`suggestion`-kiểu sửa nhanh `fix: { kind: 'renameField', stepId, from: 'Name', to: 'Subject' }` ⇒ nút `Đổi thành Subject` (dùng
`renameField`, tham chiếu `{{task.Name}}` đi theo, một bước undo). Cảnh báo không chặn xem trước (xem trước không cần org).

### H. Ước tính số bản ghi

Hàm thuần `estimateSteps(wf, catalog, { queryCounts })` (`shared/estimate.js`, mới) đi cây một lần, trả mỗi bước
`{ records, min, max, exact }` (records = kỳ vọng):

| Bước | Số lần chạy thân / số bản ghi | Chính xác? |
| --- | --- | --- |
| Record | `count` × số lần bước được chạy tới | có, nếu mọi thứ bao ngoài chính xác |
| Lặp `fixed` | `count` | có |
| Lặp `range` | trung bình `(min+max)/2`, khoảng `[min, max]` | không |
| Lặp `each` | số bản ghi ước tính của pool `from` lúc vào vòng (Record: tổng đã ước tính phía trên; Query: số dòng lần đọc gần nhất nếu có, không thì `limit`; Chọn bản ghi: số lần chọn) | theo nguồn; Query chưa đọc ⇒ không |
| Rẽ nhánh `chance` | nhánh Đúng × `probability`, Sai × `1 − probability` | không |
| Rẽ nhánh `compare` | mỗi nhánh 50 % | không |
| Query, Chọn bản ghi | 0 bản ghi sinh ra | — |
| Bước tắt | không ước tính, không chip | — |

Hiện:

- Thẻ Record khi **chưa có kết quả chạy hoặc kết quả đã cũ** (workflow đổi sau lần xem trước): chip `.stat.est`
  `12 bản ghi` (chính xác) hoặc `≈ 12 bản ghi` (không chính xác), `title="Ước tính từ cấu hình, chưa chạy (khoảng 3–48)."`. Có kết
  quả còn mới thì chip thật như hôm nay. Kiểu `.est`: như `.stat` nhưng viền nét đứt `border`, nền trong suốt (khác `.stale`:
  không nghiêng). Khung: không chip ước tính (tránh rối).
- Thẻ Bắt đầu: `≈ 1 250 bản ghi · ≤ 50 000`. Ước tính (kỳ vọng) vượt `maxRecords` ⇒ thêm tag cảnh báo `▲ Ước tính vượt giới hạn`
  `title="Ước tính khoảng 80 000 bản ghi, quá giới hạn 50 000 mỗi lần chạy. Giảm số lần lặp hoặc tăng giới hạn ở bước Bắt đầu."`
- Tính lại một lần mỗi phiên bản workflow (cache như `currentScope`), O(số bước). Số lớn hơn `maxRecordsHard` hiện `> 200 000`.

### I. Tô thẻ nguồn khi rê/focus chip

- Chip biến (`.var-chip`, dải chip 0005) và chip field Lookup / Master-Detail trên thẻ Record (`.field-chip` có `→ acc`): khi
  `pointerenter` hoặc `focus`, tìm bước nguồn qua `currentScope()` (`sourceStep(scope, ref.source)`: alias ⇒ bước Record/Query/Chọn bản
  ghi; biến lặp hay bản ghi đang lặp ⇒ bước Lặp) và thêm `.is-ref-target` vào thẻ đó ở view đang hiện; `pointerleave`/`blur` thì bỏ.
- `.is-ref-target`: outline 2 px **nét đứt** `accent`, hở 2 px (khác vòng chọn liền nét và vòng focus). Không cuộn, không đổi lựa
  chọn. Thẻ nằm ngoài khung nhìn (Quy trình) / bị cull (Sơ đồ): không làm gì thêm; `title` của chip có thêm
  `Nguồn: Record "acc"` để vẫn biết.
- Chip đỏ (nguồn không tồn tại) không tô gì.

## Thay đổi dữ liệu / API

### Workflow JSON

Không đổi. Không khóa mới, không migration. File `version: 2` và `version: 1` mở như cũ.

### `localStorage` / `sessionStorage` (mới)

| Khóa | Nội dung |
| --- | --- |
| `sfdg.library` | `{ "version": 1, "activeId": "w…", "items": [{ "id", "name", "createdAt", "updatedAt", "steps", "bytes" }] }` — chỉ mục; `activeId` là mục mở gần nhất (cho tab mới) |
| `sfdg.wf.<id>` | Workflow v2 của mục (đúng như file JSON) |
| `sfdg.library.trash` | Mục vừa xóa `{ item, workflow }` (một mục; xóa khi quota đầy hoặc xóa mục khác) — cho nút Hoàn tác |
| `sessionStorage['sfdg.activeId']` | Mục đang mở của tab này |
| `sfdg.workflow.v2` | **Không ghi nữa** sau khi chuyển (bản sao lưu đóng băng). Vẫn là autosave khi tab chạy chế độ cũ vì quota |
| `sfdg.workflow.v1`, `sfdg.workflow.v2.broken` | Như hôm nay: không bao giờ ghi đè / xóa |

Tự sửa chỉ mục khi đọc: mục trong chỉ mục mà không có `sfdg.wf.<id>` ⇒ bỏ khỏi chỉ mục; `sfdg.wf.<id>` không có trong chỉ mục ⇒
thêm lại (tên lấy từ `workflow.name`).

#### Định dạng file thư viện

```json
{ "sfdg": "library", "version": 1, "exportedAt": "2026-10-28T10:24:00Z",
  "workflows": [ { "version": 2, "name": "Account + Contact", "steps": [ … ] } ] }
```

#### Định dạng bộ nhớ tạm

```json
{ "sfdg": "steps", "version": 2, "from": "Account + Contact",
  "steps": [ { "id": "acc", "type": "record", "config": { … } }, { "id": "loopCon", "type": "loop", "slots": { "body": [ … ] } } ] }
```

Dán cũng nhận `{ "version": 2, "steps": […] }` (file workflow). Bước theo đúng thứ tự đọc của lựa chọn (chọn rời: thứ tự đọc,
thành một dãy).

### `POST /api/run` — NDJSON và kết quả (chỉ thêm)

- `progress` `phase: "insert"` thêm `byStep: { "<nodeId>": { "inserted": 1200, "failed": 3 } }` (chỉ bước có bản ghi đã gửi;
  `nodeId` của bản ghi, tức bước Record).
- `insert.byStep` trong kết quả, cùng dạng, đếm đủ.
- `createInserter` đếm thêm theo `record.nodeId` cạnh `bySobject` (số bước có hạn, không tăng theo số bản ghi).
- Client cũ bỏ qua khóa lạ, nên tương thích.

### `POST /api/field-samples` (mới)

Request: `{ "sobject": "Account", "fields": [ {name,type,options}, … ], "index": 2, "seed": 1, "now": 1761552000000, "count": 3 }`
— `fields` là các field của bước **tới và gồm** field `index` (để `{{this.FirstName}}`, Email "theo tên" chạy đúng).

Response: `{ "values": ["Banking", "Retail", "Banking"] }`.

- Server sinh `count` (mặc định 3, tối đa 5) bản ghi chỉ gồm các field đó, theo thứ tự, `n` = 1…count, scope rỗng, rng có seed
  (`server/random.js`), `now` truyền vào; template tới bước khác ra chuỗi rỗng (client chỉ gọi cho field độc lập).
- Không I/O, không org. Giới hạn: ≤ 500 field, `count` ≤ 5, body theo `MAX_BODY` sẵn có, cùng `requestGuard`.
- Lỗi: kiểu field lạ / option sai ⇒ 422 `{ error, issues: [{ field: "fields.<Name>", message }] }`; lỗi khi sinh (giá trị duy nhất
  cạn) ⇒ 422 `{ error: "<câu của generator>" }`.

### Issue (chỉ thêm)

- `fix?: { kind: "addSelectField", stepId, field }` trên issue `unknownMember` của nguồn org (F1).
- `fix?: { kind: "renameField", stepId, from, to }` trên cảnh báo mới `code: "noNameField"` (G).
- Issue cũ không đổi; `suggestion` giữ nguyên ý nghĩa.

### `GET /api/meta` (chỉ thêm)

`recordPresets: { "<sObject>": { "fields": [ {name,type,options} ], "noName"?: true } }` (G).

### Describe (chỉ thêm)

`GET /api/orgs/:org/sobjects/:name` (`mapDescribe`) trả thêm `nameField` (tên field có `nameField: true`, hoặc `null`).

### Module dùng chung

- `shared/workflow-tree.js`: `cloneSteps(…, { keepFree })`; mới `normalizeSelection(wf, ids, slotKeys)` (thứ tự đọc, bỏ con của
  khung đã chọn, cho biết có liền nhau không), `rangeBetween(wf, anchorId, id, slotKeys)` (dãy chung gần nhất), `wrapSteps`,
  `removeSteps`, `moveBlock`, `neighbourTargetBlock`, `pasteSteps(wf, target, steps, { catalog, slotKeys })` → `{ ids, renamed }`.
- `shared/soql.js`: `addSelectField(soql, field)` → chuỗi mới hoặc `null`.
- `shared/estimate.js` (mới): `estimateSteps` (H).
- `client/js/library.js` (mới): lưu/đọc thư viện, chuyển autosave, quota, sự kiện `storage`; các hàm thuần (`migrateToLibrary`,
  `repairIndex`, `copyName`) test được trong Node.
- `client/js/clipboard.js` (mới): `toClipboard(steps, name)`, `parseClipboard(text, meta)` thuần (test trong Node).
- `client/js/selection.js` (mới): mô hình lựa chọn (bước chính, anchor, `ids`), dùng chung cho hai view.

### Tài liệu tham chiếu cần cập nhật khi làm (implementer làm cùng code; doc này không sửa)

- `docs/workflow-schema.md`: `byStep` của `progress` insert và `insert.byStep`; `fix` của issue; `POST /api/field-samples`;
  `meta.recordPresets`; định dạng bộ nhớ tạm và file thư viện (mục mới "Định dạng phụ").
- `docs/org-connection.md`: `nameField` của describe; field mặc định của Record theo describe; khung "Thiếu field bắt buộc".
- `docs/architecture.md`: bảng client (`library.js`, `clipboard.js`, `selection.js`, `store.js` khóa mới), `shared/estimate.js`,
  bảng `shared/`.
- `docs/ui-design-system.md`: §6.4 (chọn nhiều, `.is-ref-target`, `.tag-insert-err`, `.stat.live`, `.stat.est`), §6.11 (`.select-bar`),
  §8.3 (phím mới).
- `CLAUDE.md` (dòng Client state: thư viện thay một autosave).
- Inspector, tab "Phím tắt": thêm Shift+bấm / Shift+↑↓, Ctrl+bấm, Ctrl+A, Ctrl+C/X/V, Ctrl+O.

## Checklist tiện dụng

- [x] 1. **Chạy được ngay với mặc định** — G sửa đúng chỗ vi phạm: Record Task/Contact/Case… mới sinh field đúng ngay, có org
  thì đúng theo describe. Ước tính (H) và ví dụ (E) không cần cấu hình gì. Thư viện có sẵn một mục khi mở lần đầu.
- [x] 2. **Ít thao tác** — đổi workflow 2 thao tác; bọc 2 bước 3 thao tác (trước 5–6); bọc trong Lặp qua từng bản ghi 2 thao tác
  (trước 4–5); sửa SELECT 1 thao tác (trước 4–5); thêm field bắt buộc 1 thao tác. Phím: Shift/Ctrl+bấm, Shift+↑↓, Ctrl+A,
  Ctrl+C/X/V, Ctrl+O.
- [x] 3. **Xem trước trước khi ghi** — không thêm đường ghi org nào. Hộp xác nhận insert không đổi; cảnh báo "cùng seed đã insert"
  còn mạnh hơn (giữ qua các workflow trong thư viện). H cảnh báo vượt giới hạn trước khi chạy.
- [x] 4. **Lỗi chỉ đúng chỗ** — lỗi dán gắn bước qua validate sẵn có; cảnh báo `noNameField` gắn `fields.Name` kèm nút sửa; lỗi
  insert lên thẻ đúng bước và nhảy tới nhóm lỗi; mọi câu tiếng Việt nói cách sửa.
- [x] 5. **Không mất công sức** — Mới/Mở/Mẫu không còn ghi đè; mỗi workflow tự lưu; chuyển autosave cũ không xóa gì; quota có
  chỉ báo, toast, `beforeunload`; hai tab không âm thầm ghi đè nhau; xóa workflow có Hoàn tác; thao tác nhóm một bước undo; dán
  đổi alias kéo theo tham chiếu.
- [x] 6. **Lấy từ org** — G và F2 dùng describe; F1 sửa SELECT thay vì bắt gõ.
- [x] 7. **Một nguồn sự thật** — preset Record ở server (`meta.recordPresets`), ví dụ giá trị do generator server sinh, `fix` do
  validate server gắn; lựa chọn, đổi tên khi dán, ước tính dùng `analyzeScope` và danh mục (`slots`, `exposes`), không
  hard-code loại bước. Ngoại lệ có chủ đích: ước tính đọc ý nghĩa `count/min/max/mode/probability` của Lặp và Rẽ nhánh
  (giống `summary.js` hôm nay); ghi ở Câu hỏi mở việc khai báo chúng trong danh mục.
- [x] 8. **Giải thích tại chỗ** — `title` cho mục khóa (vì sao), ước tính (khoảng), ví dụ (seed 1, có thể khác Xem trước), dòng nơi
  lưu thư viện.
- [x] 9. **An toàn khi lỡ tay** — dán tối đa 2 000 bước / 5 MB; `field-samples` ≤ 500 field, ≤ 5 giá trị, không I/O; không đổi
  workflow khi đang chạy; không thêm chỗ server ghi đĩa.

## Phương án đã cân nhắc

| Việc | Phương án | Ưu | Nhược | Chọn? |
| --- | --- | --- | --- | --- |
| A nơi lưu | `localStorage` (chỉ mục + một khóa mỗi workflow) | Không thêm bề mặt ghi ở server (server hôm nay không ghi đĩa, lại cầm quyền org); tức thì; cùng chỗ với autosave cũ nên chuyển dễ | ~5 MB; theo origin (localhost ≠ 127.0.0.1); xóa dữ liệu trình duyệt là mất ⇒ bù bằng "Tải tất cả" | **Có** |
| | File trên đĩa qua server (`~/.sfdg/workflows`, endpoint đọc/ghi) | Bền, dùng git được, không quota | Endpoint ghi đĩa mới (path traversal, quyền), thêm trạng thái server, nhiều việc hơn | Không (Câu hỏi mở) |
| | File System Access API | File thật, không qua server | Chỉ Chromium, hỏi quyền mỗi phiên | Không |
| A một khóa hay nhiều khóa | Một khóa chứa cả thư viện | Ghi nguyên tử | Mỗi lần gõ ghi lại mọi workflow; một workflow hỏng làm hỏng cả thư viện | Không |
| A Mới/Mẫu | Tạo mục mới | Không bao giờ ghi đè, bỏ hộp hỏi | Có thể nhiều mục ⇒ dùng lại mục trống chưa đặt tên | **Có** |
| B lựa chọn | Dải liền nhau + chọn rời, thao tác theo bảng | Bọc/di chuyển luôn hợp lệ; xóa/tắt/chép linh hoạt | Hai loại cần giải thích ⇒ `title` khi khóa | **Có** |
| | Chỉ dải liền nhau | Đơn giản | Không tắt được 3 bước rải rác | Không |
| B bộ nhớ tạm | Sự kiện `copy`/`paste` + `text/plain` JSON | Không hỏi quyền, chạy cả khi không secure context, sang tab/trình duyệt khác được | Menu "Dán" vẫn cần `readText` ⇒ có dự phòng trong bộ nhớ | **Có** |
| | `navigator.clipboard` cho mọi thứ | Một cách | Hỏi quyền đọc; không chạy khi `HOST` là IP LAN | Không |
| | Bộ nhớ tạm trong app (`localStorage`) | Không cần quyền | Không dán sang trình duyệt khác / chat; tốn quota | Không |
| B dán alias | Giữ nếu trống, trùng thì đổi | Dán sang workflow khác giữ đúng tên | Khác Ctrl+D (luôn đổi) — đúng ý: Ctrl+D luôn trùng | **Có** |
| C pool | Pool được tham chiếu nhiều nhất, rồi gần nhất | Đúng ý trong ca hay gặp (Contact đang Lookup `accs`) | — | **Có** |
| C Lookup | Toast hỏi [Đổi] | Không âm thầm đổi dữ liệu | Thêm một bấm | **Có** (tự đổi: Không) |
| D nguồn số liệu | Thêm `byStep` vào `progress` insert | Đếm đủ, rẻ | Đổi hợp đồng (chỉ thêm) | **Có** |
| | Suy từ `errorGroups` lúc xong | Không đổi server | Không có trong lúc chạy; nhóm bị cắt ở 100 | Không |
| E nguồn ví dụ | Endpoint nhỏ cho field độc lập + lần xem trước cho field phụ thuộc | Tức thì khi sửa option; field phụ thuộc vẫn đúng ngữ cảnh | Hai nguồn ⇒ nhãn khác nhau ("Ví dụ" / "Lần xem trước") | **Có** |
| | Chỉ dùng lần xem trước (3 bản ghi đầu) | Không đổi server | Cũ ngay sau khi sửa option, phải Ctrl+Enter | Không |
| | Tự chạy xem trước sau mỗi lần sửa | Giá trị thật | Nặng với workflow lớn, đọc org (Query) | Không |
| | Sinh ở trình duyệt | Không qua mạng | Nhân đôi generator, phá "một nguồn sự thật" | Không |
| F2 | Khung gợi ý trong inspector từ describe | Báo trước khi insert | Gọi describe khi chọn bước (cache) | **Có** |
| | Cảnh báo validate ở server | Lên thanh lỗi | Validate không có org | Không |
| G nguồn mặc định | Preset ở meta + describe khi có org | Không có org vẫn đúng cho object chuẩn; có org thì đúng mọi object | Bảng preset ở server phải giữ | **Có** |
| | Chỉ describe | Không có bảng | Không org thì Task vẫn sai | Không |
| | Bảng trong client | — | Cấm (một nguồn sự thật) | Không |
| H nơi tính | Hàm thuần `shared/`, tính ở trình duyệt | Tức thì, không gọi mạng, test trong Node | Đọc ý nghĩa option Lặp/Rẽ nhánh | **Có** |
| | Endpoint server chạy executor "khô" | Chính xác | Chạy thật, chậm với workflow lớn, cần Query | Không |
| I | Tô thẻ khi rê/focus, không cuộn | Không làm nhảy màn hình | Thẻ ngoài khung nhìn không thấy ⇒ `title` có tên nguồn | **Có** |

## Kế hoạch thực hiện

Mỗi bước một commit, có test hoặc bước smoke. Bảng đồng bộ hợp đồng: `.claude/agents/implementer.md`.

1. **G — field tên mặc định (ưu tiên, lỗi thật).**
   `server/workflow/nodes.js` (`RECORD_PRESETS`), `server/index.js` (`meta.recordPresets`), `server/sf/describe-map.js` (`nameField`
   trong `mapDescribe`), `server/workflow/schema.js` (cảnh báo `noNameField` + `fix`), `client/js/ops.js` (`newStep` dùng preset),
   `client/js/inspector.js` (`applyRecordPreset` cạnh `applyQueryPreset`, `applyFix` cho `fix`).
   Test: `test/server.test.js` (`GET /api/meta has recordPresets; Task has Subject and noName`), `test/sf.test.js` (`mapDescribe
   returns nameField`), `test/workflow.test.js` (`a Task record with a Name field warns with a renameField fix`, không cảnh báo
   với Account/custom), `test/samples.test.js` (mẫu không đổi), hash vàng không đổi. Smoke (luồng mới, xem dưới) bước G.
2. **F1 — "Thêm vào SELECT".** `shared/soql.js` (`addSelectField`), `server/workflow/schema.js` (`fix` trên `unknownMember` nguồn
   org), `client/js/inspector.js` (`fillErrors`/`applyFix`). Test: `test/soql.test.js` (`addSelectField` builder… SOQL thường,
   có WHERE/ORDER BY, đã có field, subquery ⇒ null, `FIELDS(ALL)` ⇒ null), `test/workflow.test.js` (`unknownMember of a Query
   source carries an addSelectField fix`, qua Chọn bản ghi và bản ghi đang lặp ⇒ `stepId` là Query gốc).
3. **C — Bọc trong Lặp qua từng bản ghi** (một bước, trước B). `client/js/ops.js` (`wrapInEach`, chọn pool, toast nối Lookup),
   `client/js/menus.js`. Test: `test/workflow-tree.test.js` không cần (dùng `wrapStep`); smoke bước C.
4. **I — tô thẻ nguồn.** `client/js/var-picker.js` (chip), `client/js/process.js` (`fieldChips`), `client/js/canvas.js`,
   `client/css/app.css` (`.is-ref-target`). Smoke bước I.
5. **H — ước tính.** `shared/estimate.js` (mới), `client/js/store.js` (`currentEstimate()` cache theo revision),
   `client/js/summary.js` (`estimateChip`), hai view, thẻ Bắt đầu, `app.css` (`.stat.est`). Test `test/estimate.test.js` (mới):
   Lặp cố định lồng (`3 × 4 = 12`, chính xác), `range` (trung bình, khoảng, không chính xác), Rẽ nhánh `chance` 0,3, `each` qua pool
   Record (bằng tổng phía trên) và Query (dòng đã đọc / `limit`), bước tắt bị bỏ, vượt `maxRecordsHard`, mẫu "Account + Contact"
   (5 Account, ≈ 12,5 Contact). Smoke bước H.
6. **D — số liệu trực tiếp và lỗi insert trên thẻ.** `server/sf/insert.js` (đếm `byStep`), `server/run.js` (`insertProgress`
   thêm `byStep`), `client/js/main.js` (gọi `paintRunInfo` ở `onEvent`), `process.js`/`canvas.js` (`paintRunInfo`, tag lỗi),
   `client/js/results.js` (`showInsertErrorsFor(nodeId)`), `app.css`. Test: `test/run.test.js` (`insert progress events and the
   result carry byStep counts per record step`, tổng `inserted+failed` theo bước = theo sObject), `test/sf.test.js` (inserter đếm
   bản ghi con bị bỏ vì cha lỗi vào bước con). Smoke bước D (insert giả lập bằng route `/api/run` trả NDJSON có `byStep`, không
   chạm org).
7. **E — giá trị mẫu.** `server/index.js` + hàm `fieldSamples` (mới, `server/workflow/samples.js` dùng `generateValue`, `createRng`),
   `client/js/api.js`, `client/js/inspector.js` (hàng ví dụ, phân loại phụ thuộc bằng `currentScope().refs`). Test
   `test/server.test.js`: `POST /api/field-samples returns 3 deterministic values` (cùng seed ⇒ cùng giá trị), `{{this.FirstName}}`
   dùng field phía trên, kiểu lạ ⇒ 422 có `field`, `count` > 5 bị kẹp, unique cạn ⇒ 422 với câu của generator. Smoke bước E.
8. **B1 — thao tác nhóm ở `shared/`.** `shared/workflow-tree.js` (`normalizeSelection`, `rangeBetween`, `wrapSteps`, `removeSteps`,
   `moveBlock`, `neighbourTargetBlock`, `cloneSteps keepFree`, `pasteSteps`), `client/js/clipboard.js` (thuần). Test
   `test/workflow-tree.test.js`: dải qua hai dãy nâng lên dãy chung; bỏ con của khung đã chọn; bọc dải giữ thứ tự; di chuyển khối
   vào/ra khung bằng `neighbourTargetBlock` (đúng thứ tự đọc, nhảy qua khung thu gọn); `pasteSteps` giữ alias trống / đổi alias
   trùng và tham chiếu bên trong theo / đổi biến lặp che vòng ngoài / id luôn mới; `test/clipboard.test.js` (mới): khứ hồi,
   nhận file v2, từ chối v1, loại lạ, > 2 000 bước, JSON hỏng.
9. **B2 — UI chọn nhiều và copy/paste.** `client/js/selection.js` (mới), `store.js` (`state.selection.ids`, `anchor`), `ops.js`
   (thao tác nhóm), `process.js`/`canvas.js` (chuột, Shift+↑↓, Ctrl+A, `aria-multiselectable`), `main.js` (phím, sự kiện
   copy/cut/paste), `menus.js` (nhóm, menu nhóm), `inspector.js` (panel chọn nhiều), thanh chọn ở màn hình hẹp, `app.css`
   (`.select-bar`). Smoke bước B.
10. **A — thư viện.** `client/js/library.js` (mới), `store.js` (`persist` qua thư viện, `resetHistory`), `main.js` (khởi động,
    Mới/Mở/Mẫu, Ctrl+O, chặn khi chạy, `lastInsert` thành danh sách), `index.html` (`#btn-library`, bỏ `#btn-open` khỏi thanh trên,
    giữ `#file-input`), popup và hộp thoại. Test `test/library.test.js` (mới, các hàm thuần với `localStorage` giả):
    `migrateToLibrary` từ v2 (v2 và v1 không bị ghi/xóa), từ v1, từ không có gì; `repairIndex` (mục mồ côi, chỉ mục thừa);
    `copyName` (`(bản sao)`, `(bản sao 2)`); quota (setItem ném lỗi ⇒ trạng thái chưa lưu, xóa thùng rác rồi thử lại); file thư viện
    khứ hồi. Smoke: sửa luồng 6/7 (xem dưới) và bước A.
11. **Tài liệu:** các file ở [Tài liệu tham chiếu](#tài-liệu-tham-chiếu-cần-cập-nhật-khi-làm-implementer-làm-cùng-code-doc-này-không-sửa),
    "Đã làm" của doc này, chỉ mục `docs/design/README.md` (thêm dòng 0012, trạng thái theo lúc đó), skill `smoke-test`.

**Smoke** (`.claude/skills/smoke-test/smoke.cjs`, ngân sách thời gian: `SMOKE_BUDGET_MS` hoặc 15 s × max(1, 4 / số CPU), xem skill `smoke-test`; lúc viết doc trần là 12 s, hiện ~8 s). Một hàm mới `flowProductivity` chạy song song (context
riêng, không chờ cố định), các bước:

- G: thêm Record, đổi sObject `Task` ⇒ một field `Subject`; mở mẫu có Record Task-với-Name dựng bằng `addInitScript` ⇒ cảnh báo
  `noNameField`, nút `Đổi thành Subject` sửa và cảnh báo hết.
- F1: mẫu "Contact cho Account có sẵn", đặt template `{{acc.Industry}}` ⇒ nút `Thêm Industry vào SELECT của "accs"` ⇒ lỗi hết.
- C: ⋯ trên `con` → Bọc trong Lặp qua từng bản ghi ⇒ Lặp `each` chứa `con`, `from` = `accs`; toast [Đổi] đổi Lookup sang bản ghi đang lặp.
- B: Shift+bấm hai thẻ ⇒ inspector "2 bước đã chọn", `aria-multiselectable`, hai `aria-selected=true`; Bọc trong Lặp ⇒ một
  ↶ trả lại; Ctrl+C rồi Ctrl+V ⇒ 2 bước mới, alias `…2`; Ctrl+/ tắt cả hai; ở 390 px: ⋯ → Chọn nhiều bước ⇒ `.select-bar`, chạm
  thẻ thứ hai ⇒ `2 đã chọn`, Xong thoát.
- H: chip `≈` trên Record trước khi chạy; thẻ Bắt đầu có ước tính.
- I: hover chip `[acc · Industry]` ⇒ thẻ `acc` có `.is-ref-target`, rời chuột thì hết.
- E: mở ⚙ của một Picklist ⇒ hàng `Ví dụ:` có 3 giá trị; đổi option ⇒ hàng đổi (chờ phản hồi `/api/field-samples`, không
  chờ cố định).
- D: route `/api/run` trả NDJSON giả có `progress` insert với `byStep` ⇒ chip `insert …/…` và tag `⊗ lỗi 3`; bấm tag ⇒ tab
  "Lỗi insert", dòng nhóm của bước được tô. (Không gọi org: sf CLI là stub.)
- A: `▾` mở popup; `＋ Workflow mới` ⇒ hai mục; đổi lại mục đầu ⇒ nội dung đúng, Ctrl+Z không làm gì (undo đã đặt lại); Mẫu khi
  đang có bước ⇒ mục mới, mục cũ còn nguyên.

Sửa có chủ đích: **luồng 6** (autosave v1) kiểm mục thư viện được tạo và `sfdg.workflow.v1` không đổi (thay vì kiểm
`sfdg.workflow.v2` được ghi); thêm kiểm: `sfdg.workflow.v2` có sẵn ⇒ thành mục thư viện, khóa v2 không đổi từng byte. **Luồng 7**
(autosave hỏng) giữ nguyên ý: `.broken` còn bản sao. Luồng 8/9 (mở file) đi qua `#file-input` như cũ. Ước tính thêm ~1,5 s cho
luồng mới, chạy song song nên tổng ~9 s, trong ngân sách.

## Đã chốt

Người dùng giao chọn theo phương án đề xuất; planner chốt (2026-10-28):

1. **Thư viện lưu ở `localStorage`**: chỉ mục `sfdg.library` + mỗi workflow một khóa `sfdg.wf.<id>`; tab nhớ mục đang mở trong
   `sessionStorage`. Không lưu file trên đĩa qua server (để sau).
2. **Chuyển autosave**: `sfdg.workflow.v2` (hoặc v1 qua `migrateV1`) thành mục đầu; **không ghi, không xóa** `sfdg.workflow.v2` và
   `sfdg.workflow.v1`; quota khi chuyển ⇒ chạy chế độ một autosave cũ.
3. **Mới / Mở file / Mẫu tạo mục mới**, không hỏi; dùng lại mục đang mở nếu nó trống và tên `Workflow mới`.
4. **Đổi workflow đặt lại undo**, xóa kết quả chạy; danh sách "đã insert với seed này" giữ qua các workflow (≤ 20).
5. **Quota**: thử lại sau khi xóa thùng rác; còn lỗi ⇒ `▲ Chưa lưu`, toast có [Mở Thư viện], `beforeunload`.
6. **Hai tab cùng một workflow**: tạm dừng tự lưu, toast [Dùng bản ở tab kia] / [Giữ bản của tab này].
7. **Xóa workflow**: không hộp hỏi; toast Hoàn tác 10 s nhờ thùng rác một mục.
8. **Thanh trên**: nút `▾` cạnh ô tên (Ctrl+O); `Mở…` vào popup; `Lưu` giữ nhãn và Ctrl+S (tải JSON), `title` mới.
9. **Lựa chọn**: dải liền nhau (Shift, nâng lên dãy chung gần nhất) + chọn rời (Ctrl/⌘); bọc/di chuyển chỉ với dải; lưu là
   `selection.ids` + bước chính (`selection.id` giữ nghĩa cũ).
10. **Phím**: Shift+↑/↓, Ctrl+A (cùng dãy), Esc hai nấc, Ctrl+C/X/V; mọi phím một-bước áp cho cả lựa chọn.
11. **Màn hình hẹp / cảm ứng**: chế độ chọn từ ⋯ → `Chọn nhiều bước`, thanh `.select-bar` thay sheet.
12. **Bộ nhớ tạm**: sự kiện `copy`/`cut`/`paste` với JSON `text/plain` (`"sfdg": "steps"`); menu Dán dùng `readText` rồi bản trong
    bộ nhớ của tab. Dán theo `defaultInsertTarget`; giữ alias nếu trống, trùng thì đổi; id luôn mới; biến lặp che vòng ngoài thì
    đổi; tham chiếu ra ngoài giữ nguyên.
13. **Undo**: mỗi thao tác nhóm, cắt, dán là một bước; lựa chọn không vào undo.
14. **Bọc trong Lặp qua từng bản ghi**: pool được tham chiếu nhiều nhất trong dải, rồi gần nhất; khóa khi không có pool; Lookup
    nối lại qua toast [Đổi], không tự đổi.
15. **Số liệu trực tiếp**: dùng `byStep` sẵn có của `progress` generate; thêm `byStep` vào `progress` insert và `insert.byStep`;
    tag `⊗ lỗi n` mở tab Lỗi insert ở nhóm của bước.
16. **Giá trị mẫu**: endpoint `POST /api/field-samples` cho field độc lập (seed ô Seed hoặc 1, `now` = 00:00 hôm nay), 3 bản ghi
    đầu của lần xem trước cho field phụ thuộc; một hàng thay dòng "Lần xem trước" của field.
17. **Sửa nhanh SELECT**: `fix: addSelectField` gắn ở server, nút ở inspector; SOQL không phân tích được thì không có nút.
18. **Field bắt buộc thiếu**: khung gợi ý trong inspector từ describe (cache phiên), [Thêm n field] [Chọn…] [Bỏ qua]; không vào
    thanh lỗi.
19. **Field tên mặc định (G)**: `meta.recordPresets` ở server cho object chuẩn; có org thì describe (field bắt buộc, rồi
    `nameField`); chỉ thay khi danh sách chưa bị sửa; không bước undo riêng; cảnh báo `noNameField` + nút `Đổi thành …` cho
    workflow cũ. **Làm đầu tiên.**
20. **Ước tính**: `shared/estimate.js`, chip `≈ n bản ghi` trên Record khi chưa có / đã cũ kết quả, tổng và cảnh báo vượt giới hạn
    ở thẻ Bắt đầu; không chip ước tính trên khung.
21. **Tô thẻ nguồn**: hover/focus chip biến và chip Lookup ⇒ `.is-ref-target` (nét đứt accent), không cuộn, `title` có tên nguồn.
22. `pick.filterValue` ngoài phạm vi (đã nhận biến).

## Câu hỏi mở / Việc tiếp theo

Không có câu hỏi chặn việc làm. Để sau:

- Lưu thư viện ra thư mục trên đĩa (endpoint đọc/ghi giới hạn trong một thư mục), đồng bộ giữa máy; lịch sử phiên bản.
- Sửa hàng loạt option cho nhiều bước cùng loại (ví dụ đặt `count` cho 3 Record).
- Kéo thẻ / chọn bằng khung trên Sơ đồ.
- Sửa nhanh "Thêm field Industry vào bước acc" cho bản ghi sinh ra (cần đoán kiểu; có org thì lấy từ describe).
- Khai báo ý nghĩa ước tính trong danh mục (`estimate: { times: 'count' | 'range' | 'pool' }`) để `shared/estimate.js` không đọc
  tên option của Lặp/Rẽ nhánh.
- Gợi ý field bắt buộc cả khi insert lỗi `REQUIRED_FIELD_MISSING` (nút trong tab Lỗi insert).
- Thẻ ngoài khung nhìn khi rê chip (I): mũi tên chỉ hướng ở mép.

## Đã làm

Làm từng phần theo [Kế hoạch](#kế-hoạch-thực-hiện); phần chưa có ở đây là chưa làm.

### G — Field tên mặc định theo sObject (bước 1)

- `server/workflow/nodes.js`: `RECORD_PRESETS` (bảng ở phần G) và `recordPreset(sobject)` (không phân biệt hoa thường);
  `GET /api/meta` trả `recordPresets`. `server/sf/describe-map.js`: `mapDescribe` trả thêm `nameField`.
- `server/workflow/schema.js`: cảnh báo `code: "noNameField"` gắn `fields.Name` của Record trên sObject `noName`, kèm
  `fix: { kind: "renameField", stepId, from, to }`. Bước đã có field `to` thì không có `fix`, câu nói "Xóa field này (bước đã có
  field LastName)." (đổi tên sẽ thành trùng field). Bước tắt không bị kiểm tra.
- `client/js/ops.js`: `recordPresetFields(sobject)`; `newStep('record')` dùng preset (Account vẫn `Name` tên công ty: mẫu và hash
  vàng không đổi). `client/js/inspector.js`: `applyRecordPreset` (trong cùng lần sửa sObject, nên một Ctrl+Z trả cả hai), describe
  sau 500 ms (`scheduleRecordDescribe`, field bắt buộc rồi `nameField`, toast), chỉ vẽ lại khối Fields (`.fields-section`) nên ô
  sObject giữ focus khi gõ. `preselectParent` tách từ hộp Import để dùng chung. Nút sửa nhanh `Đổi thành Subject` (`.quick-fix`):
  dời tham chiếu (`renameField`) rồi đổi tên field; field còn ở option mặc định cũ (`mode: name/company` hoặc rỗng) nhận option của
  preset (Subject: danh sách Call…). Inspector giờ hiện cả **cảnh báo có `fix`** dưới field (`.warn-line`, viền vàng), cảnh báo
  khác vẫn chỉ ở thẻ và thanh lỗi.
- Test: `test/server.test.js` (`GET /api/meta has recordPresets; Task has Subject and noName`, mỗi preset validate sạch),
  `test/sf.test.js` (`mapDescribe returns nameField`), `test/workflow.test.js` (`a Task record with a Name field warns with a
  renameField fix`, `no noNameField warning for Account, Opportunity or a custom sObject`); mẫu và hash vàng không đổi.
  Smoke: luồng mới `flowProductivity` (16), bước G.
- Khác thiết kế: preset có thêm khóa `nameField` (field thay cho `Name`, để server tạo `fix.to` và câu cảnh báo mà không đoán từ
  danh sách field; Contact có `FirstName` đứng trước `LastName`). Field mặc định theo describe không tự thêm bước Query cho Lookup
  bắt buộc chưa có bản ghi cha ("＋ … có sẵn trong org" chỉ có ở hộp Import): `ref` để trống, lỗi "chưa chọn bản ghi cha" chỉ đúng
  field — tự thêm bước sau một độ trễ 0,5 s thì bất ngờ hơn.
- Khác thiết kế (G.2, sau review): sObject có preset **giữ preset** và chỉ thêm field bắt buộc còn thiếu theo describe (không phân
  biệt hoa thường); "mọi field bắt buộc, rồi `nameField`" chỉ áp cho sObject không có preset. Lý do: describe thật của Task/Event
  không đánh dấu field nào bắt buộc, nên Event mất `ActivityDateTime`/`DurationInMinutes` (insert lỗi), Contact/Lead mất `FirstName`.
  Thêm: name field auto-number (không tạo được) của sObject không preset và danh sách đang là `[Name]` ⇒ danh sách rỗng + toast
  (cảnh báo "Bước chưa có field nào…" hướng dẫn tiếp). Hẹn giờ describe theo từng bước; focus trong danh sách field được giữ.
- Khác thiết kế (câu chữ): cảnh báo `noNameField` viết `Task không ghi được field Name nên insert sẽ lỗi. …` (đã sửa ở phần G phía
  trên). Field mặc định của sObject không preset (`Name`, Họ tên) cũng do server phục vụ (`meta.recordDefaultFields`), client không
  giữ bản riêng. Nút `Đổi thành …` không làm gì khi issue đã cũ (field `from` không còn, hoặc đã có field `to`).

### F1 — "Thêm <Field> vào SELECT" (bước 2)

- `shared/soql.js`: `addSelectField(soql, field)` → câu mới (chèn `, Field` sau mục cuối của SELECT ngoài, giữ khoảng trắng trước
  `FROM`), câu cũ nếu đã có field (không phân biệt hoa thường), `null` khi SOQL có lỗi mức error của `checkSoql`, subquery hay
  `FIELDS(…)`/`TYPEOF` trong SELECT, hoặc `field` không phải đường dẫn field.
- `server/workflow/schema.js`: `referenceIssue(ref, scope, step, stepOf)` gắn `fix: { kind: "addSelectField", stepId, field }` lên
  `unknownMember` của nguồn org; `stepId` là Query gốc (`source.root`, nên qua Chọn bản ghi, Chọn bản ghi của Chọn bản ghi và bản
  ghi đang lặp của Lặp `each`). Field qua quan hệ được thêm bằng **cả đường dẫn** của tham chiếu (`Owner.Email`,
  `Owner.Manager.Email`, kể cả khi Query chưa lấy `Owner` nào); `{{acc.Name.Foo}}` trên field thường thì không có `fix`.
- `client/js/inspector.js`: nút `Thêm Industry vào SELECT của "accs"` (`.quick-fix`) dưới câu lỗi, cạnh "Sửa thành …"; bấm sửa bước
  Query (builder: thêm vào cuối `fields`; SOQL: `addSelectField`), một bước hoàn tác (`inspector-structure`), toast
  `Đã thêm Industry vào Query "accs". Bấm Xem trước để đọc lại.` Thanh lỗi không thêm nút (như thiết kế).
- Test: `test/soql.test.js` (`addSelectField` với SOQL thường, có WHERE/ORDER BY/LIMIT và chuỗi chứa `FROM`, semi-join trong WHERE,
  `toLabel`, đã có field, subquery / `FIELDS(ALL)` / `TYPEOF` / SOQL lỗi ⇒ `null`), `test/workflow.test.js` (`unknownMember of a
  Query source carries an addSelectField fix`: qua Chọn bản ghi, bản ghi đang lặp, Chọn bản ghi lồng, `left` của Rẽ nhánh,
  `Owner.Email`, `Owner.Manager.Email`, `Name.Foo` không có `fix`, SOQL sửa được / có subquery, pool Record sinh ra thì không có
  `fix`). Smoke `flowProductivity` bước F1.
- Khác thiết kế: câu lỗi `unknownMember` của nguồn org nay gọi cả đường dẫn field thiếu (`… không lấy field Owner.Email. Thêm
  Owner.Email vào …`) thay vì chỉ cấp đầu bị thiếu (`Owner` hay `Email`), để câu và nút sửa nói cùng một field.

### C — Bọc trong Lặp qua từng bản ghi (bước 3)

- `client/js/ops.js`: `eachWrapPlan(id)` chọn pool và danh sách Lookup nên nối lại; `wrapInEach(id)` tạo Lặp `each`
  (`newStep('loop', …, [bước])`, nên biến lặp không che vòng ngoài) thay chỗ bước, `from` theo kế hoạch, `itemAlias` =
  `suggestPickAlias(from)`; một bước hoàn tác, Lặp mới được chọn và nháy. Toast 8 s `Đổi Lookup AccountId (con) sang bản ghi đang
  lặp "acc2"?` / `Đổi 2 Lookup …` [Đổi] (bước hoàn tác riêng; Lookup đã bị sửa sau khi bọc thì không đổi).
- `client/js/menus.js`: mục `Bọc trong Lặp qua từng bản ghi` ngay sau `Bọc trong Lặp` (menu chưa chia nhóm: việc của B), `title`
  nói pool sẽ dùng; không có pool dùng được ⇒ mục khóa với `title` của thiết kế.
- Test: theo kế hoạch không có test Node (dùng `wrapStep`); smoke `flowProductivity` bước C (mẫu "Contact cho Account có sẵn":
  `con` được bọc trong Lặp `each` qua `accs`, bản ghi `acc2`, [Đổi] đặt `AccountId` = `acc2`, chế độ "Bản ghi hiện tại").
- Khác thiết kế (làm rõ): tham chiếu tới một Chọn bản ghi được tính cho pool mà nó chọn từ đó (đi ngược chuỗi Chọn bản ghi tới pool
  xa nhất còn dùng được), vì lặp qua một bản ghi đã chọn chỉ chạy một lần — đúng ví dụ smoke của thiết kế (`con` trỏ `acc` ⇒
  `from` = `accs`). "Hòa" chọn pool gần nhất **trong các pool hòa**. Bấm [Đổi] có toast xác nhận `Đã đổi 1 Lookup sang bản ghi
  đang lặp "acc2".` Chưa có ở inspector chọn nhiều và popup `Bọc ▾` (thuộc B).

### I — Tô thẻ nguồn khi rê / focus chip (bước 4)

- `client/js/ref-target.js` (mới): `refSourceStep(ref)` (bước nguồn của một tham chiếu `analyzeScope` qua `sourceStep`: alias ⇒
  Record / Query / Chọn bản ghi, biến lặp và bản ghi đang lặp ⇒ Lặp; `null` với chip đỏ `unknownName` và `this.*`),
  `bindRefTarget(chip, id)` (`pointerenter`/`focus` thêm, `pointerleave`/`blur` bỏ), `paintRefTarget()` chỉ vá class trên thẻ của
  hai view, `refTargetId()` (bỏ khi chip đã rời trang do vẽ lại).
- `client/js/var-picker.js`: chip biến gắn `bindRefTarget`; `title` thêm dòng `Nguồn: Chọn bản ghi "acc"`. `client/js/process.js`:
  chip field Lookup / Master-Detail (`→ acc`) cũng vậy, `decorate` giữ class khi vẽ lại. `client/js/canvas.js`: `decorateCard` đặt
  class cho thẻ được tạo lại sau cull (Sơ đồ không có chip field nên chỉ là nơi hiện thẻ nguồn của chip ở inspector).
- `client/css/app.css`: `.step-card.is-ref-target` (outline 2 px nét đứt `accent`, hở 2 px); `docs/ui-design-system.md` §6.4.
- Smoke `flowProductivity` bước I: rê chip `[acc · Industry]` ⇒ thẻ `acc` được tô, rời chuột ⇒ hết; focus chip `AccountId · Lookup →
  acc` trên thẻ `con` ⇒ tô `acc`, `title` có `Nguồn: Chọn bản ghi "acc"`, blur ⇒ hết.
- Khác thiết kế: dòng `Nguồn: …` có trong `title` của mọi chip có nguồn (không chỉ khi thẻ ngoài khung nhìn), vì `title` không
  biết thẻ có đang hiện hay không lúc rê.

### H — Ước tính số bản ghi (bước 5)

- `shared/estimate.js` (mới): `estimateSteps(wf, catalog, { queryCounts })` → `{ byStep, total }`, mỗi bước `{ records, min, max,
  exact }` (khung: tổng bên trong; Lặp thêm `iterations`). Đúng bảng của phần H; option thiếu lấy `default` của danh mục; Query
  SOQL tự viết lấy `LIMIT` cuối câu (không có ⇒ `maxQueryRows`). Pool theo alias: Record và Chọn bản ghi cộng dồn, Query thay.
- `client/js/store.js`: `currentEstimate()` (cache theo phiên bản workflow và kết quả chạy; `queryCounts` từ `result.queries`).
  `client/js/summary.js`: `estimateChip(step)`, `startEstimate()`, `formatEstimate` (`vi-VN`, một chữ số lẻ dưới 100, `> 200.000`).
  Hai view: thẻ Record có `.stat.est` khi chưa có kết quả hoặc kết quả đã cũ (thay chip `.stale` của Record), thẻ Bắt đầu
  `≈ 17,5 bản ghi · ≤ 50.000` và tag `.tag-est-over` khi vượt `maxRecords`. `app.css`, `docs/ui-design-system.md` §6.4.
- Test: `test/estimate.test.js` (Lặp cố định lồng 3 × 4 = 12 chính xác và khớp lần chạy, `range`, Rẽ nhánh `chance` 0,3 và
  `compare`, `each` qua pool Record / Query (dòng đã đọc, `LIMIT` builder và SOQL) / Chọn bản ghi, pool lớn lên trong vòng lặp bao
  ngoài ⇒ không chính xác, bước tắt bị bỏ, vượt `maxRecordsHard`, mẫu "Account + Contact" 5 Account ≈ 12,5 Contact, mặc định
  danh mục). Smoke `flowProductivity` bước H; luồng 15 chờ `.stat:not(.est)` (chip ước tính có sẵn trước khi chạy).
- Khác thiết kế: số dùng định dạng `vi-VN` như phần còn lại của app (`≈ 2.000`, `12,5`), không phải `1 250`. Lặp `each` qua pool
  được sinh trong một vòng lặp cũng bao ngoài Lặp đó dùng cỡ pool tới lúc đó (cận trên, mỗi lần vào thấy một ảnh chụp khác) và
  luôn "không chính xác". Thẻ Bắt đầu luôn hiện ước tính (kể cả khi có kết quả mới), vì đó là số so với giới hạn.

### D — Số liệu trực tiếp và lỗi insert trên thẻ (bước 6)

- `server/sf/insert.js`: `createInserter` đếm `byStep[nodeId] = { inserted, failed }` cạnh `bySobject` (bản ghi con bị bỏ vì cha
  lỗi tính cho bước của bản ghi con; bản ghi không có `nodeId` không được đếm theo bước), có trong `onBatch` và tóm tắt.
  `server/run.js`: `progress` `insert` mang `byStep` (bản sao), `insert.byStep` của kết quả (kể cả `{}` khi Dừng trước khi ghi).
- `client/js/run-cards.js` (mới): `cardChip` (đang chạy: `statChip` của `byStep` lượt sinh; khi insert, Record ghi `insert
  n/tổng` với tổng = `stats.byStep[id].records` của bản xem trước được xác nhận, khung giữ số của bản đó; không chạy: ước tính H
  hoặc kết quả cuối), `paintCardRun` vá chip `.stat` và tag `.tag-insert-err` của một thẻ (dùng lại phần tử), `noteText` cho
  ghi chú khung thu gọn (`· lỗi insert 12`). `client/js/main.js`: `state.runLive` theo `progress`/`plan`, `liveCards()` gọi
  `paintRunInfo()` (`views.js` → `process.js`/`canvas.js`), xóa khi chạy xong. Hai view vẽ chip qua `paintCardRun` trong
  `decorate` (Sơ đồ: thẻ tạo lại sau cull cũng đúng). `client/js/results.js`: `showInsertErrorsFor(nodeId)`, hàng nhóm có
  `data-node`, `.current`. `app.css`; `docs/ui-design-system.md` §6.4; `docs/workflow-schema.md` (`byStep`).
- Test: `test/run.test.js` (`insert progress events and the result carry byStep counts per record step`: mỗi sự kiện tổng theo
  bước = theo sObject, kết quả cuối), `test/sf.test.js` (inserter đếm `byStep`, con bị bỏ vì cha lỗi tính cho bước con, bản ghi
  không có `nodeId`). Hash vàng không đổi. Smoke `flowProductivity` bước D.
- Khác thiết kế: bấm tag khi insert còn chạy chỉ hiện toast `Nhóm lỗi hiện ở tab "Lỗi insert" khi insert xong.` (nhóm lỗi chỉ có
  trong kết quả cuối). Tag trên Sơ đồ có `tabindex="-1"` như badge (một điểm Tab cho cây); ở Quy trình là nút Tab tới được.
  Trên thẻ Record, chip ước tính (H) và chip số liệu là cùng một chỗ (`paintCardRun`), không phải hai phần tử.

### E — Giá trị mẫu trong inspector (bước 7)

- `server/workflow/samples.js` (mới): `fieldSamples(body)` dùng `createRandom` (seed, mặc định 1) và `generateValue`, scope rỗng,
  `now` truyền vào; field phía trên không sinh được ở đây thì bỏ qua (chỉ lỗi của field được hỏi mới báo). `server/index.js`:
  `POST /api/field-samples` (400 khi request sai dạng, 422 với `issues` khi kiểu lạ / chưa tên, 422 với câu của generator khi
  sinh lỗi). `docs/workflow-schema.md`.
- `client/js/field-samples.js` (mới): hàng `.field-samples` cuối khối option của field đang mở; `fieldDepends` phân loại
  (kiểu `valueType: 'reference'` của danh mục, tham chiếu tới bước khác / biến lặp trong `currentScope().refs`, bắc cầu qua
  `{{this.X}}`); field độc lập gọi server (300 ms, số thứ tự + `AbortController`, cache 50 câu trả lời), field phụ thuộc hiện 3
  bản ghi đầu của bước trong lần xem trước (xám nghiêng khi cũ) hoặc lời nhắc Xem trước. Hàng tự làm mới khi workflow đổi
  (kể cả gõ trong option, vốn không vẽ lại inspector) và khi có kết quả mới. `client/js/api.js` (`fieldSamples`),
  `client/js/inspector.js`. Dòng "Lần xem trước" một giá trị của dải chip (`var-picker.js`) bỏ, `previewOf` bỏ; bảng chọn biến
  giữ dòng của nó.
- Test: `test/server.test.js` (`POST /api/field-samples returns 3 deterministic values`, `{{this.FirstName}}` dùng field phía
  trên còn tham chiếu tới bước khác ra rỗng, kiểu lạ ⇒ 422 có `field`, `count` > 5 bị kẹp, hết giá trị duy nhất ⇒ 422 với câu của
  generator, request sai ⇒ 400). Smoke `flowProductivity` bước E.
- Khác thiết kế: request không có `now` bị từ chối (400) thay vì lấy giờ server, để ví dụ luôn tái lập được; `sobject` được nhận
  nhưng chưa dùng. Field phụ thuộc mà lần xem trước không có bản ghi nào của bước hiện `Lần xem trước không sinh bản ghi nào của
  bước này.`

### Sửa sau review (C, H, D, E)

- **Option số có giới hạn thật (E, `/api/run`).** `maxWords`/`minWords` ≤ 1 000, `maxSentences`/`minSentences` ≤ 200,
  `maxParagraphs`/`minParagraphs` ≤ 50 (`server/generators/text.js`); `resolveOptions` kẹp mọi option `integer`/`number` vào
  `min`/`max`, `options: null` coi như `{}`. Hàm chung `optionIssues(field)` (`server/generators/index.js`): validate báo lỗi
  `optionRange` (`fields.<Name>`, `option`), `/api/field-samples` trả 422 `issues: [{ field, option, message }]` cho field được
  hỏi (field phía trên chỉ bị kẹp). Lỗi của generator vẫn là 422 (kèm `issues[].field`); lỗi khác là 500 có log. Mẫu và hash vàng
  không đổi (không mẫu nào dùng giá trị ngoài khoảng). Test: `test/generators.test.js`, `test/server.test.js`;
  `docs/field-types.md`, `docs/workflow-schema.md`.
- **[Đổi] của C an toàn với hoàn tác.** `shared/each-wrap.js` (mới, thuần): `eachWrapPlan(wf, catalog, id, { slotKeys, scope })`
  và `applyEachRewire(wf, rewire, { loopId, itemAlias, slotKeys })`; `client/js/ops.js` chỉ gọi chúng. [Đổi] chỉ đổi khi Lặp mới
  còn, vẫn là "Mỗi bản ghi trong pool" với cùng tên bản ghi, và bước của Lookup còn nằm trong nó (field và `ref` chưa bị sửa);
  không thì không đổi gì, toast `Không đổi được: Lặp qua từng bản ghi đã bị hoàn tác hoặc sửa.` Test `test/each-wrap.test.js`.
- **H dùng đúng luật đọc của server:** `estimate.js` lấy số dòng tối đa bằng `maxFetchFor(config, maxQueryRows)` của
  `shared/soql.js` (bỏ hàm đọc `LIMIT` riêng), nên `LIMIT 5000` được kẹp còn 2 000 như khi đọc thật (test).
- **D nhẹ hơn:** hai view tra bước qua `stepsById()` (Map id → bước, dựng một lần mỗi phiên bản workflow) thay vì `stepById`
  từng thẻ; `resultStale()` chỉ tuần tự hóa workflow một lần mỗi phiên bản / lần chạy (`client/js/run-cards.js`).
- **E:** `title` của hàng ví dụ nói đúng seed đang dùng; hàng (`aria-live`) chỉ ghi lại chữ khi chữ đổi; cache chỉ giữ câu trả lời
  thành công và 422 (lỗi 500 / mất kết nối được hỏi lại). Chú thích `vi-VN` trong `summary.js` sửa theo định dạng thật.
- `docs/ui-design-system.md` §6.4: tag lỗi insert trên Sơ đồ không tới được bằng bàn phím (`tabindex="-1"`); đường bàn phím là
  tab "Lỗi insert".
- **Ngân sách smoke (quyết định của điều phối):** `smoke.cjs` đọc `SMOKE_BUDGET_MS`, mặc định 15 000 × max(1, 4 /
  `os.availableParallelism()`) ms thay cho 12 s cố định; tự kiểm tra tĩnh không có `waitForTimeout(` trong chính file; mọi context
  `reducedMotion: 'reduce'`; luồng 5b mở workflow thứ hai qua `#file-input` thay vì reload; in thời gian từng luồng. Cập nhật skill
  `smoke-test` và câu "12 s" ở 0012, 0013, 0014 (các mục "Đã làm" cũ của 0004/0006/0009/0010 giữ nguyên vì là số đo lịch sử).


### B1 — Thao tác nhóm ở `shared/` (bước 8)

- `shared/workflow-tree.js`: `normalizeSelection(wf, ids, slotKeys)` (thứ tự đọc, bỏ bước nằm trong khung đã chọn, `contiguous`
  + `parentId`/`slot`/`start`/`end` của khối), `rangeBetween` (hai đầu nâng lên dãy chung gần nhất; hai cột của một Rẽ nhánh ⇒
  chính Rẽ nhánh đó), `wrapSteps`, `removeSteps`, `moveBlock` (tọa độ trước khi di chuyển, như `moveStep`),
  `neighbourTargetBlock` (Alt+↑/↓ cho khối, nhảy qua khung thu gọn), `cloneSteps(…, { keepFree })`, `pasteSteps(wf, target,
  steps, { catalog, slotKeys })` → `{ ids, renamed: [{ from, to }], missing }` (`missing`: tên bản dán tham chiếu mà đích không
  có, từ `analyzeScope`, cho câu toast), `countSteps`.
- `shared/each-wrap.js`: `eachWrapPlan` nhận thêm một danh sách id (khối): pool dùng được ở chỗ bước đầu, tham chiếu của mọi bước
  trong khối được đếm.
- `client/js/clipboard.js` (mới, thuần): `toClipboard(steps, name)`, `parseClipboard(text, meta)` → `{ steps, from }` hoặc
  `{ kind, error }` với câu của bảng "Từ chối dán". Import tương đối `../../shared/…` nên chạy cả trong Node lẫn trình duyệt.
- Test: `test/workflow-tree.test.js` (dải qua hai dãy, bỏ con của khung đã chọn, bọc giữ thứ tự, khối vào/ra khung và nhảy khung
  thu gọn, `pasteSteps` giữ alias trống / đổi alias trùng và tham chiếu bên trong theo / đổi biến lặp che vòng ngoài / id luôn
  mới / `missing`), `test/clipboard.test.js` (mới: khứ hồi, nhận file v2, từ chối v1, loại lạ lồng bên trong, sai dạng, > 2 000
  bước, > 5 MB, JSON hỏng / không phải của app), `test/each-wrap.test.js` (khối).
- Làm rõ: biến lặp của bản dán chỉ đổi khi che Lặp bao quanh vị trí dán hoặc trùng alias bản ghi (đúng bảng; trùng biến của một
  Lặp khác không bao quanh thì giữ); tên mới tránh mọi alias và biến lặp đã có. `pasteSteps` trả thêm `missingRefs` (số tham
  chiếu hỏng) để toast nói đúng "1 tham chiếu …".

### B2 — Chọn nhiều, thao tác nhóm, copy/paste ở giao diện (bước 9)

- `client/js/selection.js` (mới): `state.selection = { kind: 'step', id, ids?, anchor? }` (`id` = bước chính như cũ), `selectedIds`,
  `selectionInfo` (= `normalizeSelection`), `clickSelect` (Shift: `rangeBetween`, Ctrl/⌘: bật/tắt; bước trong khung đã chọn đi theo
  khung), `extendBy` (Shift+↑/↓ trong dãy của anchor), `selectAllInSequence` (Ctrl+A), `collapseToPrimary` (Esc nấc 1), chế độ
  chọn (`body.select-mode`), vùng `#sel-live` đọc `Đã chọn 3 bước.`. `store.js`: undo/redo chỉ giữ bước chính.
- `client/js/ops.js`: `deleteSelection` (hộp `Xóa 3 bước và 5 bước bên trong?` khi có khung chứa bước con; không thì xóa ngay +
  toast [Hoàn tác] và câu "đang được dùng ở N chỗ"), `toggleSelectionDisabled`, `duplicateSelection` (khối: một bản sao cả khối
  sau khối, tham chiếu giữa các bước trong khối đi theo; rời: mỗi bước sau chính nó), `wrapSelection`, `wrapSelectionEach`
  (`wrapInEach` nhận khối), `moveSelectionBy` (gộp undo `move:<ids>`), `moveBlockTo` (kéo ⠿ một thẻ của khối đang chọn kéo cả
  khối), copy/cut/paste (`selectionClipboard`, `removeCut`, `clipboardCommand` = `execCommand`, `pasteCommand` = `readText` rồi
  bản trong tab, `pasteText` với các câu toast của thiết kế). Mỗi thao tác một bước undo.
- `client/js/main.js`: phím một-bước áp cho cả lựa chọn, Ctrl+A (focus trong cây), Esc hai nấc; sự kiện `copy`/`cut`/`paste`
  của `document` (bỏ qua khi focus ở ô nhập, khi có hộp thoại, hoặc khi người dùng đang bôi đen chữ trên trang).
- `client/js/menus.js`: menu ⋯ chia nhóm Chỉnh sửa / Di chuyển / Bọc / Chọn, rồi Tắt/Bật và Xóa sau một đường kẻ
  (`popup.js`: mục `{ separator: true }`); trên thẻ thuộc lựa chọn nhiều: tiêu đề `3 bước đã chọn`, mục khóa theo bảng (`title`
  nói vì sao). `wrapItems`/`editItems`/`moveItems`/`offDeleteItems` dùng chung cho menu, inspector và thanh chọn.
- `client/js/inspector.js`: panel `3 bước đã chọn` (danh sách, hàng Bọc, hàng Sao chép / Cắt / Nhân bản / Tắt n bước / Xóa n bước,
  mẹo); tab Phím tắt thêm các phím mới. `client/js/select-bar.js` (mới): `.select-bar` `[n đã chọn] [Bọc ▾] [Xóa] [⋯] [Xong]`
  (≈ 274 px ở 390 px), `Bọc ▾` mở popup 3 kiểu bọc (phần C hoãn lại ở đây), `⋯` có Sao chép, Cắt, Dán, Nhân bản, Tắt/Bật, Lên,
  Xuống. Hai view: Shift/Ctrl+bấm, chạm trong chế độ chọn, Shift+↑/↓, mọi thẻ được chọn có `.selected` + `aria-selected`,
  `aria-multiselectable` trên `role="tree"`. `app.css`: `.select-bar`, `.multi-actions`, `.popup-sep`.
- Smoke: luồng mới `flowLibrary` (17), phần B (chạy song song với các luồng khác thay vì nối vào `flowProductivity`, vốn đã là
  luồng dài nhất).
- Khác thiết kế (làm rõ): dán khi **nhiều** bước được chọn đặt ngay sau bước cuối (không vào slot trống của khung cuối như
  `defaultInsertTarget`); một bước được chọn thì đúng `defaultInsertTarget`. Trong chế độ chọn, chạm thêm thẻ không đổi bước chính
  (Xong về lại thẻ bắt đầu); Ctrl+bấm ở màn hình rộng thì thẻ vừa bấm thành bước chính. Bản dán đổi tên cả biến lặp nên toast
  `Đổi tên alias:` có thể kể cả `loop → loop2`. Menu "Sao chép" khi trình duyệt không cho `execCommand` vẫn giữ bản sao trong tab
  (toast nói rõ chỉ dán được trong tab này).

### A — Thư viện workflow (bước 10)

- `client/js/library.js` (mới, không DOM, storage truyền vào): khóa `sfdg.library` / `sfdg.wf.<id>` / `sfdg.library.trash` /
  `sessionStorage['sfdg.activeId']` đúng bảng; `createLibrary` (`create`, `save` — quota ⇒ xóa thùng rác rồi thử lại một lần,
  trả `readded` khi mục bị tab khác xóa, `rename`, `duplicate` ngay dưới mục gốc, `remove` vào thùng rác, `restoreTrash`, `usage`,
  `exportAll`), `repairIndex`, `copyName`, `parseLibraryFile`, `migrateToLibrary` (v2 hợp lệ ⇒ mục đầu; không có thì v1 qua
  `migrateV1`; không có gì ⇒ mẫu đầu; v2 hỏng ⇒ bản sao `.broken` khi chưa có, thư viện bắt đầu bằng mẫu; quota ⇒ chế độ cũ, không
  để lại chỉ mục dở). Ghi mục trước, chỉ mục sau; v1 và v2 không bao giờ bị ghi hay xóa (v2 chỉ còn được ghi ở chế độ cũ).
- `client/js/library-ui.js` (mới): popup `▾` (`#btn-library`, Ctrl+O kể cả trong ô nhập; ô tìm khi > 6 mục, 20 mục gần đây, mục
  cũ hơn chỉ hiện khi tìm — `popup.js` có `searchOnly`, `searchLabel`), `＋ Workflow mới`, `⇪ Mở file JSON…`, `Quản lý thư viện…`
  (sửa tên tại chỗ — mục đang mở đi qua `updateWorkflow`, một bước undo; Mở / Nhân bản / Tải JSON / Xóa, ≤ 720 px gom vào `⋯`;
  dòng nơi lưu + dung lượng; Tải tất cả). Mới / Mở file / Mẫu = `openAsNew` (mục mới, dùng lại mục trống tên "Workflow mới"); đổi
  workflow = `store.openWorkflow` (đặt lại undo, bỏ chọn, xóa kết quả). Khóa khi đang chạy (`setLibraryLocked`, cả nút Mới).
  Quota: `▲ Chưa lưu` (`#btn-unsaved`), toast 12 s [Mở Thư viện], `beforeunload`, `Đã lưu lại "…"`. Sự kiện `storage` của mục đang
  mở ⇒ tạm dừng tự lưu, toast không tự tắt [Dùng bản ở tab kia] [Giữ bản của tab này] (`dom.toast` nhận nhiều nút, `ms: Infinity`).
  Mục hỏng: mô tả `không mở được`, bấm ⇒ toast [Tải bản lưu].
- `store.js`: `setPersistHandler`, `openWorkflow`; `lastInsert` thành `lastInserts` (≤ 20, giữ qua các workflow). `main.js`: khởi động
  qua `initLibrary`, `#file-input` nhận cả file thư viện (`Đã thêm N workflow vào thư viện.`), menu ⋯ ở ≤ 720 px: Mới, Thư viện…,
  Mở file JSON…, Lưu. `index.html`: `▾` dính ô tên, `Mở…` rời thanh trên, `title` mới của Lưu. Tab Phím tắt: Ctrl+O.
- Test `test/library.test.js` (mới, storage giả có giới hạn): chuyển từ v2 (v2, v1 không đổi từng byte), từ v1, từ không có gì,
  v2 hỏng (`.broken` không bị ghi đè), quota khi chuyển ⇒ chế độ cũ không để lại khóa nào; `repairIndex`; `copyName`; tạo / lưu /
  đổi tên / nhân bản / xóa / hoàn tác, mục bị tab khác xóa được thêm lại; quota (xóa thùng rác rồi thử lại, vẫn đầy ⇒ giữ bản tốt
  cuối); file thư viện khứ hồi.
- Smoke: `flowLibrary` (17) phần A; mọi luồng đọc workflow tự lưu qua `smokeSaved()` (mục đang mở) thay vì `sfdg.workflow.v2`;
  luồng 6 kiểm mục thư viện từ v1 (v1 không đổi, v2 không bị ghi) và thêm kiểm v2 ⇒ mục thư viện, khóa v2 không đổi từng byte;
  luồng 7 giữ nguyên ý; luồng 13 mở workflow lỗi bằng `#file-input` rồi tải lại trang, menu ⋯ có `Thư viện…`, `Mở file JSON…`;
  luồng 14 mở workflow bằng `#file-input` thay vì ghi `sfdg.workflow.v2` rồi tải lại.
- Khác thiết kế: `Hoàn tác` của Xóa còn có ở một dòng ngay trong hộp Quản lý thư viện (10 s), vì hộp là modal nên nút của toast
  phía sau không bấm được. Chế độ cũ (quota khi chuyển) giữ hộp hỏi `Thay workflow hiện tại?` và Ctrl+Z như trước khi có thư viện,
  vì vẫn chỉ có một autosave. Mục hỏng là mục đang mở lúc khởi động: tab mở mục đọc được kế tiếp (hoặc tạo mục mẫu) và báo toast.
  Danh sách "Gần đây" có cả mục đang mở (✓).

### Tài liệu (bước 11)

- `docs/workflow-schema.md`: mục mới "Định dạng phụ" (bộ nhớ tạm của bước, file thư viện, khóa của thư viện trong trình duyệt);
  `byStep`, `fix`, `POST /api/field-samples`, `meta.recordPresets` đã ghi ở các bước trước.
- `docs/architecture.md`: bảng `shared/` (nhóm bước của `workflow-tree.js`), bảng client (`store.js` mới, `selection.js`,
  `select-bar.js`, `clipboard.js`, `library.js`, `library-ui.js`, `menus.js`, `ops.js`).
- `docs/ui-design-system.md`: §6.4 (chọn nhiều), §6.11 (toast hai nút, `.select-bar`, hộp Quản lý thư viện, nút `▾` và `▲ Chưa
  lưu`), §8.3 (phím chọn nhiều, bộ nhớ tạm, Ctrl+O).
- `CLAUDE.md` (Client state: thư viện thay một autosave, lựa chọn nhiều, định dạng bộ nhớ tạm), skill `smoke-test` (luồng 6, 13c,
  13d, 17), chỉ mục `docs/design/README.md`.
- `docs/org-connection.md` không đổi ở bước này: `nameField` và field mặc định theo describe đã ghi ở G; khung "Thiếu field bắt
  buộc" được ghi cùng F2 (dưới).
- Đo smoke cuối (4 CPU, ngân sách 15 s): 3 lần chạy đủ đều `SMOKE OK`, 9,9 s · 9,9 s · 10,2 s (luồng dài nhất `flowProductivity`
  ≈ 9,4–9,8 s; `flowLibrary` 5,6–7,0 s).

### Sửa sau review (B, A)

- **Popup trong hộp thoại modal:** `openPopup` gắn popup vào `dialog[open]` chứa nút neo (không thì `body`), nên nút `⋯` của mục
  trong "Quản lý thư viện" ở ≤ 720 px bấm được (trước đó popup nằm dưới top layer của `showModal`). Smoke 17: Xóa qua `⋯` ở 390 px.
- **Ctrl+O** được xử lý trước lối thoát sớm khi có hộp thoại / popup (mở hoặc đóng popup Thư viện, không bao giờ hộp mở file;
  khi một hộp thoại đang mở thì không làm gì). Gõ-để-nhảy của popup bỏ qua phím có Ctrl / ⌘ / Alt.
- **Thanh chọn** dựng một lần, chỉ vá số đếm và cờ `disabled` (focus không mất); `role="toolbar"` có roving tabindex và
  ← / → / Home / End; chừa `env(safe-area-inset-bottom)` (`test/css-tokens.test.js` cho phép `env(safe-area-inset-*)`).
- **Đổi tên khi dán / Ctrl+D không nối chuỗi:** tên mới không bao giờ trùng một tên gốc trong bản sao (chép `[acc, acc2, →acc,
  →acc2]` vào workflow đã có `acc` ⇒ `acc3`, `acc2`, hai Lookup vẫn tách). Record dán vào trong Lặp có biến trùng alias của nó
  thì đổi tên (`row` ⇒ `row2`). Test cho cả hai.
- **Hai tab / chưa lưu:** khi tạm dừng tự lưu, nút `▲ Tab khác đã sửa` (dùng lại `#btn-unsaved`) mở lại hai lựa chọn; toast xung
  đột nhớ mục của nó (đã đổi workflow thì nút không làm gì, nói rõ). Đổi workflow / Mới / Mở file / Mẫu khi chưa lưu hoặc đang tạm
  dừng thì hỏi `Đổi workflow khi chưa lưu?` [Tải file JSON] [Hủy] [Vẫn đổi]. Mục đang tạm dừng không được dùng lại cho Mới.
  Mở mục khác xóa chỉ báo. Thông báo của chỉ báo đọc qua vùng `#save-status` (`role="status"`), không phải `aria-live` trên nút.
- **Hiệu năng:** `store.stepsById()` (Map id → bước mỗi phiên bản workflow, `run-cards.js` dùng lại) cho `selection.js`; tập id đã
  chọn là `Set` theo đối tượng lựa chọn. `library.js`: `repairIndex` dùng tập khóa của storage và chỉ chạy lúc khởi động, khi tab
  khác đổi một mục (sự kiện `storage`) và khi mở popup / hộp Thư viện — không chạy trong mỗi lần lưu. Cờ `broken` được nhớ trong chỉ
  mục (đặt khi đọc mục thất bại, bỏ khi đọc lại được), nên popup không phân tích mọi mục.
- **Nhỏ:** `restoreTrash` dùng id mới khi khóa cũ đã bị chiếm; `newEntryId` thêm 4 ký tự từ `crypto.getRandomValues`; nhập file thư
  viện chạy `malformedSteps` và toast nói số mục version 1 / hỏng bị bỏ qua; `rename` trả lại nội dung mục khi không ghi được chỉ mục;
  câu "có bản sao trong trình duyệt" chỉ khi bản sao là của autosave này (bản `.broken` cũ hơn được giữ thì nói vậy); thùng rác bị
  xóa khi hết 10 s hoàn tác; dung lượng (`bytes`, dòng "Đã dùng") đếm ký tự, đúng cái quota ~5 triệu ký tự đếm.

### F2 — Field bắt buộc còn thiếu (thêm sau, theo quyết định của điều phối)

Kế hoạch thực hiện chỉ có bước F1; F2 đã được duyệt trong thiết kế nhưng thiếu trong kế hoạch, nên làm riêng sau review.

- `client/js/required-fields.js` (mới, thuần): `missingRequired(fields, described)` (field `required` của describe chưa có trong
  bước, so không phân biệt hoa thường, theo thứ tự describe), `requiredHintText`.
- `client/js/inspector.js`: khung `.hint-box` trên tiêu đề "Fields" của bước Record khi đã chọn org và sObject có trong danh sách
  sObject tạo được (describe cache theo `org|sObject` trong phiên, lỗi ⇒ không hiện gì; ⟳ danh sách org gọi `clearDescribeCache`).
  [Thêm n field] dùng `addDescribedFields` — tách từ nút "Thêm field đã chọn" của Import, nên kiểu, option và luật chọn bản ghi
  cha của Lookup bắt buộc (kể cả thêm bước Query "＋ … có sẵn trong org") giống hệt Import; một bước hoàn tác, toast `Đã thêm 2 field:
  StageName, CloseDate.` [Chọn…] mở hộp Import, hộp nay nhóm field bắt buộc còn thiếu ở đầu dưới `Bắt buộc, chưa có (n)` (đã tích),
  rồi `Các field khác`. [Bỏ qua] ẩn khung cho bước đó trong phiên. Gõ tên field (sửa trong inspector, không vẽ lại) thì khung tự
  cập nhật từ describe đã cache; khung không đổi thì không vẽ lại (giữ focus trên nút). Không vào thanh lỗi.
- `docs/org-connection.md` (mục "Field bắt buộc còn thiếu"), `docs/architecture.md`, `docs/ui-design-system.md` §6.11 (`.hint-box`).
- Test `test/required-fields.test.js` (thứ tự describe, không phân biệt hoa thường, bỏ field không bắt buộc / mục rỗng, câu gợi
  ý). Smoke `flowLibrary` (17) phần F2 với org giả `dev` (route `page.route`, không gọi sf CLI): `Thiếu 1 field bắt buộc của Contact
  trong dev: Region__c.` trên `con`, Chọn… nhóm Region__c đầu hộp Import và đã tích, Thêm 1 field thêm `Region__c` (picklist) và
  khung biến mất, ↶ trả lại cả hai, Bỏ qua giữ khung ẩn khi chọn lại bước.
- Khác thiết kế (làm rõ): [Thêm n field] có thể thêm bước Query "＋ … có sẵn trong org" cho Lookup bắt buộc không có bản ghi cha
  phía trên — đúng "như Import" của thiết kế (là một cú bấm có chủ đích, khác field mặc định tự động của G vốn không thêm bước), và
  toast nói thêm bước đó.

### Sửa sau review lần 2

- **Hỏi "Đổi workflow khi chưa lưu?" từ "Quản lý thư viện":** bấm Mở đóng hộp rồi `confirmLeave` mở lại ngay; Chromium bắn sự kiện
  `close` của lần đóng trước muộn hơn, nên câu hỏi tự trả lời "Hủy" và "Vẫn đổi" không làm gì. `onclose` nay bỏ qua sự kiện cũ
  (`if (!modal.open) resolve(false)`). Smoke 17: tạm dừng tự lưu bằng một sự kiện `storage`, Quản lý → Mở → Vẫn đổi phải đổi workflow.
- **`switchTo`** đọc mục *sau* câu hỏi (tab khác có thể đã sửa / xóa nó trong lúc hỏi), báo mục hỏng ở đó, và kiểm tra lại đang chạy
  (`locked`) và `id === activeId`.
- **Đổi tên khi dán / Ctrl+D không nối chuỗi qua biến lặp:** biến của mọi Lặp trong bản sao (`config.alias || 'loop'`) cũng thuộc
  các tên gốc, nên dán `[Record item, Lặp(item2){ "{{item.Name}} #{{item2}}" }]` vào workflow có `item` ⇒ `item3`, biến `item2` giữ
  nguyên, mẫu đúng. Ctrl+D truyền thêm biến của các Lặp bao quanh (`loopVarsAround`, nay export từ `shared/workflow-tree.js`, như
  dán). Hai test mới trong `test/workflow-tree.test.js`.
- **Xóa khi bộ nhớ đầy:** xóa một workflow xong thì lưu lại ngay (`if (unsaved) persist()`), vì đã có chỗ.
- **⟳** xóa cả danh sách sObject (gợi ý và hộp Import), không chỉ describe; describe lỗi không được cache (lần sau hỏi lại).
- **Hẹn giờ 10 s của thùng rác** (và Hoàn tác) chỉ vẽ lại hộp khi hộp đang hiện Thư viện (`.lib-list`), không vẽ đè câu hỏi khác.
- **Hoàn tác một lần xóa cũ:** thùng rác giữ một mục; `restoreTrash(id)` chỉ trả lại khi thùng rác còn giữ đúng mục đó, không thì
  toast nói thùng rác chỉ giữ lần xóa gần nhất (hoặc đã quá 10 s) và gợi ý Mở file JSON… (trước đó trả lại nhầm workflow xóa sau,
  ví dụ khi tab khác vừa xóa). Test trong `test/library.test.js`.
- **Nhỏ:** thanh chọn chuyển focus sang Xong khi nút đang focus bị tắt (focus rơi về `<body>`); safe-area của thanh chọn không còn bị
  `padding` ghi đè (`padding: 0 var(--space-3) env(safe-area-inset-bottom)`, khoảng đệm và toast cộng thêm safe-area,
  `viewport-fit=cover` trong meta viewport); gợi ý F2 có số thứ tự để chỉ lần describe mới nhất ghi vào khung; `role="status"`
  chuyển từ `.hint-box` sang `.hint-text`; Thêm n field focus ô tên field mới đầu tiên, Bỏ qua focus tiêu đề "Fields"; hộp Import
  ẩn tiêu đề nhóm khi bộ lọc ẩn hết dòng của nhóm, so tên field bằng `trim().toLowerCase()` như `missingRequired`; toast Thêm n field
  nói `Còn phải chọn bản ghi cha cho …` khi Lookup bắt buộc chưa có cha. Smoke 17 thêm: tiêu đề nhóm bị lọc ẩn, focus sau Thêm.
