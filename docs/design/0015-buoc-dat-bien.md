# 0015 — Bước Đặt biến (`set`)

- **Trạng thái:** Đã duyệt (2026-11-02, người điều phối duyệt thay người dùng theo ủy quyền; các quyết định ở [Đã chốt](#đã-chốt-2026-11-02))
- **Ngày:** 2026-11-02
- **Liên quan:** [0005](0005-variable-picker.md) (`analyzeScope`, bảng chọn biến, "Ý tưởng để sau"),
  [0006](0006-query-pick-nodes.md) ("Các node khác": Đặt biến), [0010](0010-lap-theo-ban-ghi.md) (Lặp `each`),
  [0013](0013-mo-rong-bien-va-lap.md) (option `vars: 'number'`, `run.*`, mục 18 "Hàm trong template"),
  [workflow-schema.md](../workflow-schema.md), backlog "Hàm trong template; bước Đặt biến" ở [README](README.md#việc-còn-lại)

## Vấn đề

Người dùng có biến của bản ghi (`{{acc.Name}}`), biến lặp (`{{loop.index}}`) và biến lần chạy (`{{run.today}}`), nhưng không tự
đặt được một giá trị có tên để dùng lại:

1. **Một giá trị dùng ở nhiều nơi.** Mã lô `TEST-{{run.today}}` phải gõ lại trong `Name` của Account, `LastName` của Contact,
   `Subject` của Task, `Description` của Opportunity… Muốn đổi thành `UAT-…` thì sửa ở 4–8 chỗ, sót một chỗ là lô dữ liệu không xóa
   được bằng một bộ lọc.
2. **Một con số điều khiển nhiều vòng lặp.** "Mỗi Account 5 Contact, mỗi Contact 5 Task" dùng 5 ở hai bước Lặp; muốn thử 2 hay 20
   phải sửa cả hai. 0013 B cho ô "Số lần lặp" nhận `{{…}}` nhưng không có biến nào để giữ con số đó.
3. **Cộng dồn qua vòng lặp.** "Tạo 3 Opportunity cho mỗi Account, rồi một bản ghi tổng kết `Description = Tổng {{…}}`" cần tổng
   `Amount`. Biến lặp mất khi vòng lặp kết thúc, `{{opp.Amount}}` chỉ là bản ghi cuối.
4. **Giữ lại một giá trị trước khi nó đổi.** Trong Lặp `each`, `{{acc.Name}}` của vòng ngoài vẫn đọc được, nhưng bản ghi hiện tại của
   một alias đổi sau mỗi Record/Chọn bản ghi; muốn "tên Account đầu tiên được sinh" thì không có chỗ giữ.

0006 xếp Đặt biến là "Chưa xếp lịch"; 0013 hoãn nó cùng "hàm trong template" vì hiểu là cần đổi ngữ pháp token. Doc này tách hai
việc: bước Đặt biến **không** đổi ngữ pháp (`{{var.<tên>}}` là đường dẫn hai đoạn như `{{run.seed}}`), còn hàm trong template vẫn hoãn.

## Mục tiêu / Ngoài phạm vi

- Mục tiêu:
  - Loại bước mới `set` ("Đặt biến"), không có slot: gán cho biến `<tên>` một giá trị (chữ, số, hoặc template có `{{…}}` sẵn có),
    kiểu **Chữ** hoặc **Số**; hoặc **Cộng thêm** một số vào biến số.
  - Đọc biến bằng `{{var.<tên>}}` ở mọi ô nhận biến: template, ô biến (`left` của Rẽ nhánh, "Lấy từ biến (giữ kiểu)"), ô số
    `vars: 'number'` (`count`/`min`/`max` của Lặp).
  - Phạm vi rõ ràng, do `analyzeScope` tính (`always`/`last`/`maybe`, `after`/`otherBranch`/`disabled`); bảng chọn biến có nhóm
    "Biến"; đổi tên biến kéo theo chỗ dùng.
  - Không đổi dữ liệu của workflow cũ: không rút `rng`, hash vàng của `test/stream.test.js` giữ nguyên.
- Ngoài phạm vi (lý do ở [Đã chốt](#đã-chốt-2026-11-02)):
  - Hàm và phép tính trong template (`{{var.a + 1}}`, `{{acc.Name | upper}}`): vẫn **Hoãn**, cần design riêng (đổi
    `TEMPLATE_TOKEN_SOURCE`).
  - Kiểu Ngày / Ngày giờ / Đúng-sai cho biến; giá trị ngẫu nhiên (biến lấy từ generator); biến danh sách.
  - Biến chỉ sống trong thân một vòng lặp (phạm vi lexical); biến dùng chung giữa các workflow (cấp thư viện).
  - "Tách thành biến" từ ô template (chọn chữ → tạo bước Đặt biến): ghi ở Câu hỏi mở.
- Không tăng `version` của workflow JSON; chỉ thêm một loại bước.

## Luồng người dùng

Số trong ngoặc là số thao tác (bấm, chọn, hoặc một lần gõ).

### Luồng chính: mã lô dùng chung

Đang có: Record `acc` (Account) → Lặp 3 lần → Record `con` (Contact).

1. Bấm "+" ở đầu quy trình (ngay dưới Bắt đầu), chọn **Đặt biến** trong nhóm Điều khiển (2). Bước mới có tên `bien1`, Kiểu Chữ,
   Giá trị trống; inspector mở, con trỏ ở ô **Tên biến** (tên được chọn sẵn để gõ đè).
2. Gõ `lo` (1). Thẻ đổi thành `var.lo = (trống)`.
3. Tab sang ô **Giá trị**, gõ `TEST-{{run.t` rồi Enter để nhận gợi ý `run.today` (1). Thẻ: `var.lo = TEST-{{run.today}}`.
4. Chọn Record `acc`, ở field `Name` (kiểu Template) gõ `{{lo`, bảng chọn mở nhóm **Biến**, Enter chọn `var.lo` (2). Gõ tiếp
   ` {{this.$n}}`. Làm tương tự ở `con.LastName` (2).
5. Ctrl+Enter xem trước (1): `Name` = `TEST-2026-11-02 1`… Thẻ Đặt biến có chip `đặt 1 lần · = "TEST-2026-11-02"`.

Tổng: 7 thao tác cho bước biến và chỗ dùng đầu tiên (+2 cho mỗi chỗ dùng sau). Đổi lô sang `UAT-…`: sửa **một** ô.

### Luồng phụ: một con số cho nhiều vòng lặp

1. Thêm Đặt biến ở đầu (2), tên `n` (1), **Kiểu** = Số (1), Giá trị `5` (1).
2. Ở Lặp ngoài, ô "Số lần lặp": bấm `{x}`, chọn `var.n` (2) — bảng chọn ở ô số chỉ hiện biến kiểu Số (0013 B), nên `var.n` đứng đầu
   nhóm Biến. Làm lại ở Lặp trong (2).
3. Chip ước tính trên thẻ Record vẫn là số chắc chắn (`25 bản ghi`, không phải `≈`): biến số chỉ được đặt một lần bằng hằng số nên
   bộ ước tính (0012 H) đọc được giá trị (xem [Ước tính](#ước-tính-số-bản-ghi-0012-h)).

### Luồng phụ: cộng dồn

```
Đặt biến   total = 0          (Số)
Lặp mỗi bản ghi trong accs → acc
  Record   opp  (Opportunity, Amount: Số 1000–50000)
  Đặt biến total += {{opp.Amount}}
Record     sum  (Account, Description = "Tổng {{var.total}}")
```

1. Thêm Đặt biến `total`, Kiểu Số, Giá trị `0` trước vòng lặp (5).
2. Trong thân Lặp, sau `opp`: thêm Đặt biến (2), gõ tên `total` (1) — tên trùng một biến có sẵn nên ô tên hiện gợi ý
   "Đặt lại biến có sẵn `total` (Số)"; **Cách đặt** = Cộng thêm (1), Giá trị: `{{` → `opp.Amount` (2).
3. Ở `sum.Description`: `Tổng {{var.total}}` (2). Xem trước (1).

### Trường hợp lỗi

- Dùng `{{var.total}}` ở bước nằm **trên** bước Đặt biến: lỗi gắn ô đó, `Bước Đặt biến "total" chạy sau bước này nên {{var.total}}
  chưa có giá trị khi chạy tới đây. Kéo bước Đặt biến "total" lên phía trên.` Bấm lỗi → nhảy tới ô.
- Gõ sai tên `{{var.totl}}`: `chưa có biến var.totl. Ý bạn là var.total? …` kèm nút sửa nhanh (cơ chế `suggestion` sẵn có).
- Đặt `total += …` mà quên bước khởi tạo: không lỗi (Cộng thêm bắt đầu từ 0). Đặt `s = {{var.s}}-x` (Gán, tự đọc chính nó) mà không
  có bước nào đặt `s` phía trên: lỗi `varUnset` gợi ý thêm bước khởi tạo hoặc dùng Cộng thêm.
- Biến Chữ dùng trong "Số lần lặp": cảnh báo `notNumber` sẵn có, thêm câu và **sửa nhanh** "Đổi Kiểu thành Số" (1 bấm).

## Thiết kế UI

### Thẻ (Quy trình và Sơ đồ)

Nhãn loại "Đặt biến", icon `--ico-set` (ngoặc nhọn `{ }` có dấu `=` ở giữa, 24×24, stroke 2). Dòng tóm tắt (`stepSummary`):

| Cấu hình | Tóm tắt |
| --- | --- |
| Gán, Chữ | `var.lo = TEST-{{run.today}}` (giá trị cắt ở 48 ký tự, thêm `…`) |
| Gán, Chữ, giá trị trống | `var.lo = (trống)` |
| Gán, Số | `var.n = 5 · Số` |
| Cộng thêm | `var.total += {{opp.Amount}}` |
| Chưa có tên | `Chưa đặt tên biến` |

Tên hiển thị của bước (`stepLabel`, dùng trong danh sách lỗi, hộp xóa, Sơ đồ): `var.<tên>`.

Chip sau khi chạy (`statChip`, từ `stats.byStep`): `đặt 12 lần · = 4.520` (số theo vi-VN) hoặc `đặt 1 lần · = "TEST-2026-11-02"`
(chữ cắt ở 24 ký tự); có `notNumber`: thêm ` · 2 lần không phải số`. Không chạy lần nào: không có chip (như Lặp).

### Inspector (dựng từ option schema, không có code riêng ở client)

```
┌ Đặt biến ─────────────────────────────────────────────┐
│ Tên biến     [ total               ]                   │
│              Bước phía dưới dùng {{var.total}}. …      │
│ Cách đặt     [ Gán giá trị        ▾]                   │
│ Kiểu         [ Số                 ▾]   (ẩn khi Cộng thêm)│
│ Giá trị      [ 0                        ] {x}          │
│              Chữ cố định, số, hoặc bấm {x} …           │
└────────────────────────────────────────────────────────┘
```

| Khóa | Nhãn | `kind` | `default` / `initial` | `showIf` | `help` |
| --- | --- | --- | --- | --- | --- |
| `name` | Tên biến | `string` | `''` / UI gợi ý `bien1`, `bien2`… (tên chưa có bước Đặt biến nào dùng) | – | `Bước phía dưới dùng {{var.<tên>}}. Đặt cùng tên ở một bước Đặt biến khác để đổi giá trị (ví dụ trong vòng lặp). Chữ không dấu, số, "_".` |
| `mode` | Cách đặt | `select` | `set` | – | `Cộng thêm: cộng Giá trị vào biến số hiện tại (chưa có thì từ 0), dùng để tính tổng hoặc đếm trong vòng lặp.` |
| `valueType` | Kiểu | `select` | `text` | `mode` ∈ `set` | `Số: dùng được trong ô số như "Số lần lặp" ({{var.n}}). Giá trị không ra số thì biến trống.` |
| `value` | Giá trị | `string`, `vars: 'template'` | `''` | – | `Chữ cố định (TEST-01), số (5), hoặc bấm {x} để chèn biến: TEST-{{run.today}}, {{opp.Amount}}. Cộng thêm: một số hoặc biến số.` |

Lựa chọn: `mode` = `set` "Gán giá trị", `add` "Cộng thêm (số)"; `valueType` = `text` "Chữ", `number` "Số". Ô `value` có dải
chip, `{x}`, gõ `{{` và cảnh báo `unclosed` như mọi ô template (0005), không cần code mới.

Hành vi riêng ở client (nhỏ, trong `ops.js` / `inspector.js`):

- Bước mới: `name` = `suggestVarName()` (`bien1`, `bien2`… chưa dùng); focus ô Tên biến, chữ được chọn sẵn.
- Ô Tên biến có `<datalist>` các tên biến đã có trong workflow (kèm kiểu), để đặt lại đúng tên một biến có sẵn bằng 1 lần chọn.
  Gõ trúng một tên có sẵn: dòng help đổi thành `Đặt lại biến có sẵn "total" (Số, 2 bước). Giá trị mới thay giá trị cũ từ bước này trở xuống.`
- Đổi tên (gõ trong ô Tên biến): đổi **cả biến** — mọi bước Đặt biến cùng tên cũ và mọi `{{var.<cũ>}}` — theo cơ chế
  `memo` của `setStepAlias` (chỉ đổi sang tên hợp lệ và **chưa** là tên của biến khác, để lúc gõ dở `s` → `su` → `sum` không nhập
  nhầm vào biến `s`). Một mục undo. Toast: `Đã đổi tên biến total → sum ở 2 bước Đặt biến và 5 chỗ dùng.` (nút Hoàn tác).
- Copy/paste và nhân bản (Ctrl+D) **giữ nguyên** tên biến: bản sao là thêm một lần gán cùng biến (khác alias, vốn phải duy nhất).
  Tên biến không thuộc không gian tên alias (`stepNames` chỉ đọc nguồn `kind: 'record'`) nên `cloneSteps` không đổi nó.
- Màu (design system §10): vòng hue đã kín (đỏ 27°, hổ phách 72°, olive 112°, xanh lá 150°, teal 180°, cyan 226°, xanh dương 260°,
  tím 300°, magenta 352°; khoảng trống lớn nhất 52°), nên **không** còn hue cách mọi hue ≥ 35°. Chọn họ **copper** (nâu đồng,
  hue ≈ 50°, C ≈ 0.08–0.10, L ≈ 0.48 ở theme sáng): cách đỏ/hổ phách ~23° nhưng bão hòa thấp hơn hẳn màu trạng thái (C ≥ 0.15) và
  tối hơn badge cảnh báo; kèm icon và nhãn. Người làm chạy lại kiểm tra tương phản + ΔE của 0008; nếu cặp copper/cảnh báo dưới
  ngưỡng của 0008 thì dùng phương án dự phòng **slate** (hue 250°, C ≈ 0.03) — xem Câu hỏi mở 1.

### Bảng chọn biến (0005)

- Mọi bước Đặt biến thấy được ở bước đang sửa gộp thành **một nhóm** tiêu đề `var · Biến` (màu `set`), mỗi tên một dòng
  (`var.total`, kiểu `Số`/`Chuỗi`, mẫu = giá trị lần xem trước), sắp theo bước gán gần nhất trước. Nhóm đứng sau các alias, trước
  nhóm "Lần chạy".
- Tên chỉ được đặt trên một số nhánh hoặc trong vòng lặp có thể chạy 0 lần (và không có lần gán chắc chắn nào phía trên): badge
  `có thể trống` (như nguồn `maybe`). Chỉ đặt trong một vòng lặp đã xong: badge `giá trị lần lặp cuối`.
- Ô số (`vars: 'number'`) chỉ hiện biến Số (lọc `NUMBER_TYPES` sẵn có).
- Mục "Không dùng được ở đây": `var.x — Đặt biến chạy sau bước này` / `— ở nhánh còn lại của Rẽ nhánh` / `— đang tắt`.
- Gõ `{{` rồi chữ: tìm theo cả `var.total` và `total` (`matchScore` đã so `key`).

### Thông báo (đúng câu chữ)

Lỗi validate (chặn Xem trước/Insert), luôn có `nodeId` + `field`:

| `code` | Gắn | Câu |
| --- | --- | --- |
| `setVarName` | `name` | Trống: `Đặt tên biến (chữ không dấu, số, "_"), ví dụ total. Bước phía dưới dùng {{var.total}}.` Sai: `Tên biến "<x>" không hợp lệ: chỉ dùng chữ không dấu, số và "_", không bắt đầu bằng số, tối đa 40 ký tự. Ví dụ: total, ma_lo.` |
| `setVarNotNumber` | `value` | (Số hoặc Cộng thêm, giá trị không có `{{`, không phải số hoặc trống) `"Giá trị" phải là số (ví dụ 5 hoặc 12.5) hoặc một biến {{…}}. Muốn lưu chữ thì đổi "Kiểu" thành Chữ.` (Cộng thêm: `… hoặc một biến số {{…}}.` không có câu cuối) |
| `setVarTooLong` | `value` | `"Giá trị" dài quá 10.000 ký tự. Rút ngắn giá trị.` |
| `varReserved` | `alias` / `itemAlias` | (workflow có bước Đặt biến, kể cả bước tắt) `Alias "var" trùng tên nhóm biến của bước Đặt biến ({{var.…}}). Đổi alias khác, ví dụ vars.` Biến lặp: `Tên biến lặp "var" trùng tên nhóm biến của bước Đặt biến. Đổi tên biến lặp, ví dụ v.` |
| `unknownName` (biến) | ô dùng | `chưa có biến var.<x>.[ Ý bạn là var.<y>?] Thêm bước Đặt biến tên <x> ở phía trên, hoặc bấm {x} để chọn biến có sẵn.` |
| `after` (biến) | ô dùng | `bước Đặt biến "<x>" chạy sau bước này nên {{var.<x>}} chưa có giá trị khi chạy tới đây. Kéo bước Đặt biến "<x>" lên phía trên.` |
| `otherBranch` (biến) | ô dùng | `biến var.<x> chỉ được đặt ở nhánh còn lại của Rẽ nhánh phía trên. Đặt giá trị ban đầu bằng một bước Đặt biến "<x>" trước Rẽ nhánh.` |
| `disabled` (biến) | ô dùng | `bước Đặt biến "<x>" đang tắt. Bật lại bước đó (Ctrl+/) hoặc chọn biến khác.` |
| `varUnset` | `value` | `{{var.<x>}} chưa có giá trị trước bước này (chính bước này đang đặt nó). Thêm bước Đặt biến "<x>" phía trên để đặt giá trị ban đầu (ví dụ trước vòng lặp), hoặc chọn "Cộng thêm" nếu muốn cộng dồn.` |
| `wholeRecord` (biến) | ô dùng | `{{var}} là cả nhóm biến; chọn một biến, ví dụ {{var.<tên gần nhất>}}.` |
| `unknownMember` (biến) | ô dùng | `var.<x> là một giá trị, không có "<y>". Dùng {{var.<x>}}.` |

Cảnh báo (không chặn):

| `code` | Gắn | Câu |
| --- | --- | --- |
| `maybe` (biến) | ô dùng | `biến var.<x> chỉ được đặt trên một số nhánh hoặc trong vòng lặp có thể chạy 0 lần trước khi tới đây, nên có thể trống. Thêm bước Đặt biến "<x>" phía trên (trước Rẽ nhánh/Lặp) để luôn có giá trị.` |
| `setVarType` | `valueType` (hoặc `mode`) | `Biến var.<x> được đặt kiểu <Số> ở bước khác; ở đây là <Chữ>. Chọn cùng một kiểu cho mọi bước Đặt biến "<x>", nếu không ô dùng biến có thể nhận chữ thay vì số.` (Cộng thêm tính là Số; báo ở bước thứ hai trở đi theo thứ tự đọc) |
| `notNumber` (biến Chữ trong ô số) | ô dùng | câu sẵn có của 0013 + ` Đổi "Kiểu" của bước Đặt biến "<x>" thành Số.` kèm `fix: { kind: 'setVarType', name: '<x>', to: 'number' }` → nút **Đổi Kiểu thành Số** (đổi mọi bước Đặt biến tên đó đang Gán) |
| `setVarNotNumber` (khi chạy) | `value` | `Bước Đặt biến "<x>": giá trị không ra số ở <k>/<n> lần chạy qua nên biến trống ở các lần đó. Kiểm tra biến trong "Giá trị" hoặc đổi "Kiểu" thành Chữ.` Cộng thêm: `… nên đã cộng 0 ở các lần đó. Kiểm tra biến trong "Giá trị".` Một cảnh báo mỗi bước, cuối lần chạy |

Lỗi khi chạy: giá trị Chữ sau khi thay `{{…}}` dài hơn 10 000 ký tự (cộng chuỗi trong vòng lặp) → dừng, `Bước Đặt biến "<x>":
giá trị dài quá 10.000 ký tự ở lần chạy qua thứ <k>. Kiểm tra "Giá trị" (có đang nối thêm vào chính biến này trong vòng lặp?).`
gắn `value`.

## Thay đổi dữ liệu / API

### Workflow JSON

Thêm loại bước, không đổi gì của bước cũ:

```json
{
  "version": 2,
  "steps": [
    { "id": "s1", "type": "set", "config": { "name": "lo", "value": "TEST-{{run.today}}" } },
    { "id": "s2", "type": "set", "config": { "name": "total", "valueType": "number", "value": "0" } },
    { "id": "l1", "type": "loop", "config": { "mode": "each", "from": "accs", "itemAlias": "acc" }, "slots": { "body": [
      { "id": "opp", "type": "record", "config": { "sobject": "Opportunity", "alias": "opp", "fields": [] } },
      { "id": "s3", "type": "set", "config": { "name": "total", "mode": "add", "value": "{{opp.Amount}}" } }
    ] } },
    { "id": "sum", "type": "record", "config": { "sobject": "Account", "fields": [
      { "name": "Name", "type": "template", "options": { "template": "{{var.lo}} tổng" } },
      { "name": "Description", "type": "template", "options": { "template": "Tổng {{var.total}}" } }
    ] } }
  ]
}
```

| Khóa `config` | Mặc định khi thiếu | Ghi chú |
| --- | --- | --- |
| `name` | `''` (lỗi `setVarName`) | `^[A-Za-z_][A-Za-z0-9_]*$`, ≤ 40 ký tự, phân biệt hoa thường |
| `mode` | `set` | `set` \| `add` |
| `valueType` | `text` | `text` \| `number`; bỏ qua khi `add` (luôn Số) |
| `value` | `''` | chuỗi template; số JSON (`5`) cũng nhận, coi như `"5"` |

Tương thích: workflow `version: 2` cũ không có bước `set` nên chạy y như trước (cùng `rng`, cùng hash vàng). Workflow `version: 1`
không có loại bước này; `migrate-v1.js` không đổi. Bản app cũ mở workflow có `set` sẽ báo `Loại bước "set" không tồn tại.` (đúng
như với mọi loại bước mới). Workflow cũ có alias `var` vẫn hợp lệ cho tới khi thêm bước Đặt biến (`varReserved`).

### Catalogue (`server/workflow/nodes.js`)

```js
{
  type: 'set',
  label: 'Đặt biến',
  category: 'control',
  description: 'Gán một giá trị cho biến có tên, hoặc cộng thêm vào biến số. Các bước phía dưới dùng {{var.<tên>}}.',
  slots: [],
  flow: { kind: 'sequence' },
  exposes: {
    kind: 'value',                       // mới: một giá trị có tên trong một nhóm (namespace)
    namespace: 'var',                    // đường dẫn {{var.<name>}}
    name: { key: 'name' },
    label: 'Biến',
    visibleIn: 'downstream',
    valueType: { key: 'valueType', map: { text: 'string', number: 'number' }, whenMode: { add: 'number' } },
  },
  options: [ /* name, mode, valueType, value như bảng Inspector */ ],
}
```

`LIMITS.maxVarLength = 10000` (chiều dài tối đa giá trị Chữ). Meta (`/api/meta`) tự có loại bước mới; thêm
`meta.syntax.varNamespace = 'var'` để client không hard-code tiền tố.

### Phạm vi (`shared/scope.js`)

Phạm vi **toàn lần chạy, theo dòng chảy** — giống alias của Record, không giống biến lặp:

- Một bước Đặt biến là một nguồn `kind: 'value'` (`id` = id bước, `name` = `config.name`, `namespace: 'var'`, một member ảo là
  chính giá trị với `valueType`). Nguồn được đẩy lên chuỗi trạng thái như nguồn `downstream` khác, nên `always` / `last` / `maybe`,
  `after`, `otherBranch`, `disabled` tính đúng như Record mà không cần luật mới. Gán trong thân vòng lặp ⇒ sau vòng lặp là `last`
  (vòng luôn chạy ≥ 1 lần) hoặc `maybe`.
- Nguồn `value` **không** vào `byName` (không gian tên alias), mà vào `byVar: Map<name, source[]>`; tên biến không bao giờ trùng alias.
- Phân giải `var.<x>` (trong `resolveRef`): biến lặp tên `var` > alias tên `var` (cả hai bị `varReserved` khi có bước Đặt biến) >
  nhóm biến > `run`. Với `byVar.get(x)` trừ chính bước đang xét:
  - có nguồn thấy được: `source` = nguồn gần nhất (seq lớn nhất), `certainty` = **tốt nhất** trong các nguồn thấy được (một lần gán
    `always` phía trên đủ để biến luôn có giá trị), `valueType` = kiểu chung, khác nhau thì `any`;
  - không nguồn nào thấy được: chính bước này là nguồn duy nhất ⇒ `varUnset`; còn lại ⇒ lý do của nguồn đầu tiên theo thứ tự
    `disabled` > `otherBranch` > `after`;
  - không có nguồn nào: `unknownName`, gợi ý `closest` trong tên biến (thấy được trước).
  - `var` một mình ⇒ `wholeRecord`; `var.x.y` ⇒ `unknownMember`.
- Ô nằm trong chính bước Đặt biến (`value`) đọc giá trị **trước** khi bước này gán (`{{var.s}}-x` nối thêm).
- `at[...].visible` có các nguồn `value` (bảng chọn gộp theo tên); `hidden` có lý do và ghi chú `Đặt biến chạy sau bước này`, …
- `shadowsGlobal` không đổi (nguồn `value` không che `run`). `refChoices`, `poolUsage` không đổi (nguồn `value` không là pool hay
  bản ghi cha).
- `numericSampleFields`: tham chiếu trong `value` của bước Đặt biến Số hoặc Cộng thêm cũng tính là "dùng như số" (dòng Query mẫu
  khi không có org ra số, `var.n = {{q.NumberOfEmployees}}` không cảnh báo).

### Executor (`server/workflow/executor.js`, `paths.js`)

- `rootScope.var = Object.create(null)` (không prototype: tên `__proto__` hợp lệ theo regex nhưng không chạm prototype). Thân vòng
  lặp chép `scope` nông (`{ ...scope, vars }`) nên mọi lượt dùng chung **một** object `var`: gán trong vòng lặp còn sau vòng lặp.
- `resolvePath`: thêm nhánh `head === 'var' && scope.var` → `getPath(scope.var, rest)`, đặt **sau** biến lặp, `current`, `$count` và
  **trước** `run` (thứ tự như phân tích).
- `case 'set'` trong `runSteps`, không rút `rng`, không sinh bản ghi, tính một lượt `countVisit` như bước khác:
  - `set` + `text`: `renderTemplate(value, scope)`; dài hơn `maxVarLength` ⇒ lỗi khi chạy.
  - `set` + `number`: `value` đúng một token ⇒ `toNumber(resolvePath(...))`; không thì `toNumber(renderTemplate(...))`; `null`/NaN ⇒
    biến = `null` (template ra `''`), đếm cho cảnh báo `setVarNotNumber`.
  - `add`: `x` như trên (không ra số ⇒ 0, đếm cảnh báo); `prev = toNumber(scope.var[name]) ?? 0`;
    `scope.var[name] = Number((prev + x).toPrecision(15))` (bỏ sai số `0.1 + 0.2`, tất định).
- `stats.byStep[id] = { runs, records: 0, value, notNumber? }`: `value` = giá trị cuối (chữ cắt ở 100 ký tự). Shape `byStep` của các
  loại bước cũ không đổi (hash vàng).
- `samples[id] ??= { [name]: value }` (giá trị lần gán đầu) cho mẫu trong bảng chọn.
- Bước tắt: bỏ qua, biến không đổi (như mọi bước tắt).

### Ước tính số bản ghi (0012 H)

`shared/estimate.js` `varCount`: `var.<x>` có **đúng một** bước Đặt biến bật trong cả workflow, `mode: set`, `valueType: number`,
`value` là hằng số (không `{{`) ⇒ dùng giá trị đó, `exact` như số cố định. Mọi trường hợp khác giữ cách cũ (`e = 1`, `0…max`,
không exact).

### Endpoint

Không có endpoint mới. `/api/run`, `/api/export` không đổi ngoài `byStep` của bước `set` và cảnh báo mới. Không có gì ghi vào org.

## Checklist tiện dụng

- [x] 1. Chạy được ngay với mặc định — bước mới `bien1 = ''` (Chữ) hợp lệ, xem trước chạy ngay; không bắt điền gì.
- [x] 2. Ít thao tác cho việc hay làm — 2 thao tác thêm bước, 1 gõ tên, 1 gõ giá trị; chọn `var.x` bằng `{{`/`{x}`; đặt lại biến
  có sẵn bằng datalist; sửa kiểu bằng sửa nhanh 1 bấm.
- [x] 3. Xem trước trước khi ghi — bước không ghi vào org; giá trị hiện ở chip và mẫu bảng chọn sau Xem trước; cùng seed + now ⇒
  cùng giá trị khi insert.
- [x] 4. Lỗi chỉ đúng chỗ và nói cách sửa — mọi issue có `nodeId` + `field` (`name`, `value`, `valueType`, ô dùng biến), câu tiếng
  Việt nói phải làm gì (bảng Thông báo); gõ sai tên có "Ý bạn là".
- [x] 5. Không mất công sức — đổi tên biến kéo theo mọi bước gán và chỗ dùng (một mục undo, toast có Hoàn tác); autosave/undo sẵn có;
  xóa bước có chỗ dùng vẫn qua hộp xác nhận tham chiếu sẵn có.
- [ ] 6. Lấy thông tin từ org thay vì bắt gõ — không áp dụng: biến không liên quan describe; giá trị lấy từ org thì chèn
  `{{q.Field}}` qua bảng chọn sẵn có.
- [x] 7. Một nguồn sự thật — option, `exposes`, nhãn khai báo ở server; phân tích phạm vi duy nhất ở `analyzeScope`; client chỉ thêm
  gộp nhóm theo `namespace`, gợi ý tên và đổi tên cả biến.
- [x] 8. Giải thích tại chỗ — `help` có ví dụ `{{var.total}}`, `TEST-{{run.today}}`; help ô tên đổi khi trùng biến có sẵn.
- [x] 9. An toàn khi lỡ tay — `maxVarLength` chặn chuỗi phình trong vòng lặp; bước tính vào `maxSteps`; không rút `rng`; không I/O.

## Phương án đã cân nhắc

| Phương án | Ưu | Nhược | Chọn? |
| --- | --- | --- | --- |
| **A. Nhóm `{{var.<tên>}}`, phạm vi theo dòng chảy toàn lần chạy (như alias), có Gán và Cộng thêm** | Không đổi ngữ pháp token (hai đoạn như `run.seed`); không đụng không gian tên alias; tái dùng nguyên chuỗi trạng thái của `analyzeScope` (always/last/maybe); cộng dồn qua vòng lặp làm được | Gõ dài hơn 4 ký tự; cần `byVar` và một nhánh phân giải mới; alias `var` bị cấm khi có bước Đặt biến | **Có** |
| B. Tên trần `{{total}}` chung không gian tên với alias | Gõ ngắn | `{{acc}}` hôm nay là lỗi `wholeRecord`; tên biến và alias phải duy nhất chung, gán lại cùng tên lại hợp lệ ⇒ luật trùng tên rối; gõ sai không biết là alias hay biến | Không |
| C. Biến lexical trong `scope.vars` (như biến lặp) | Đơn giản ở executor | Gán trong thân vòng lặp mất khi hết lượt ⇒ không cộng dồn, không dùng sau vòng lặp được — đúng những ca người dùng cần | Không |
| D. Thêm hàm/biểu thức (`{{var.total + opp.Amount}}`) thay cho Cộng thêm | Linh hoạt | Đổi `TEMPLATE_TOKEN_SOURCE`, chạm chip, bảng chọn, đổi tên, `hasUnclosed`; cần trình phân tích biểu thức không `eval` — đúng lý do 0013 hoãn | Không (hoãn) |
| E. Chỉ Gán, hoãn Cộng thêm | Nhỏ hơn | Gán lại trong vòng lặp chỉ giữ "giá trị cuối" — thiếu ca cộng dồn/đếm vốn là lý do có phạm vi toàn lần chạy; Cộng thêm chỉ thêm một lựa chọn và vài dòng | Không |

## Kế hoạch thực hiện

Theo bảng đồng bộ hợp đồng của `.claude/agents/implementer.md` và skill `add-node-type`. Mỗi bước tự chạy `npm test`.

1. **Catalogue + meta.** `server/workflow/nodes.js`: loại `set` (options, `exposes` `kind: 'value'`), `LIMITS.maxVarLength`;
   `meta.syntax.varNamespace`. Test: `test/server.test.js` (danh sách loại bước trong `/api/meta`).
2. **Phạm vi.** `shared/scope.js`: `buildSource` cho `kind: 'value'` (member + `valueType` theo `valueType`/`mode`), `byVar`, nhánh
   `var.` trong `resolveRef` (certainty tốt nhất, `varUnset`, `wholeRecord`, `unknownMember`, gợi ý), ghi chú `hidden`,
   `numericSampleFields`. Test `test/scope.test.js`: thấy sau bước (`always`), trong nhánh (`maybe`), sau vòng lặp (`last`/`maybe`),
   khởi tạo + cộng trong vòng ⇒ `always`, `after`, `otherBranch`, `disabled`, `varUnset`, gợi ý tên, `valueType` cho ô số,
   alias `run` không bị ảnh hưởng.
3. **Validate.** `server/workflow/schema.js`: `setVarName`, `setVarNotNumber`, `setVarTooLong`, `setVarType`, `varReserved`
   (alias/`itemAlias`/biến lặp `var` khi có bước `set`), câu của các `code` phạm vi cho nguồn `value` trong `referenceIssue`,
   `fix: setVarType` cho `notNumber`. Test `test/workflow.test.js` ("set variable validation"): từng câu và `field`.
4. **Executor.** `server/workflow/paths.js` (nhánh `var`), `executor.js` (`rootScope.var`, `case 'set'`, `byStep`, `samples`, cảnh báo
   `setVarNotNumber`, lỗi dài quá). Test `test/workflow.test.js` ("set variable"): Gán Chữ/Số, Cộng thêm qua Lặp `each`, dùng trong
   `count`, `left` của Rẽ nhánh, "Lấy từ biến" giữ số, `0.1 + 0.2 = 0.3`, bước tắt, `__proto__`, cùng seed ⇒ cùng kết quả;
   `test/stream.test.js` chạy lại không đổi hash.
5. **Ước tính.** `shared/estimate.js` `varCount` với hằng số Số. Test `test/estimate.test.js`.
6. **Đổi tên cả biến.** `shared/workflow-tree.js`: `renameVariable(wf, from, to, { catalog })` (đổi `name` mọi bước `set` cùng tên,
   `renameInValue(mode, v, 'var.'+from, 'var.'+to)` mọi option có `vars`) và `setVariableName(wf, id, value, { memo, catalog })` theo kiểu
   `setStepAlias`. Test `test/workflow-tree.test.js`: đổi tên khi gõ dở không nhập vào biến khác; template, path, ô số đều đổi.
7. **UI.** `client/js/ops.js` (`newStep` gợi ý `bien1`, focus ô tên), `client/js/store.js` (`suggestVarName`),
   `client/js/inspector.js` (datalist tên biến, help khi trùng, gọi `setVariableName`, toast, áp `fix.kind === 'setVarType'`),
   `client/js/variables.js` (gộp nguồn `namespace` thành nhóm `var · Biến`, badge, mẫu từ `samples`), `client/js/summary.js`
   (`stepSummary`, `stepLabel`, `statChip`), `client/css/app.css` (primitive copper, 4 token × 2 theme tối + sáng, `--ico-set`,
   luật `[data-type="set"]`). Test `test/css-tokens.test.js`; smoke test (skill `smoke-test`): thêm Đặt biến từ "+", đặt `lo`,
   chèn `{{var.lo}}` vào field Name bằng bảng chọn, Ctrl+Enter, thấy chip và giá trị trong bảng kết quả; đổi tên `lo` → `ma` và
   kiểm template đổi theo.
8. **Docs.** `docs/workflow-schema.md` (bỏ "(dự kiến)"), `docs/architecture.md`, `docs/ui-design-system.md` (§2, §3.4, §5, §8.1:
   họ copper, loại `set`, chip biến `var.*` màu `set`), `CLAUDE.md` (scope `var` trong đoạn executor), README backlog, mục "Đã làm".

## Đã chốt (2026-11-02)

1. **Cú pháp `{{var.<tên>}}`**, không đổi `TEMPLATE_TOKEN_SOURCE`. Hàm trong template vẫn hoãn (backlog tách dòng riêng).
2. **Phạm vi toàn lần chạy, theo dòng chảy** (như alias): thấy từ bước gán trở xuống, kể cả sau vòng lặp/nhánh (`last`/`maybe`);
   gán lại cùng tên là hợp lệ và là cách "đổi giá trị".
3. **Kiểu Chữ và Số**; Cộng thêm luôn là Số. Ngày/Đúng-sai để sau.
4. **Cộng thêm có trong phạm vi** (ca cộng dồn/đếm); không có phép tính nào khác.
5. **Tên biến không trùng alias được** vì nằm trong nhóm `var`; alias / biến lặp / `itemAlias` tên `var` là lỗi khi workflow có bước
   Đặt biến. Không có cảnh báo "biến chưa được dùng" (tránh ồn khi đang soạn).
6. **Đổi tên = đổi cả biến** (mọi bước gán + mọi chỗ dùng); copy/paste giữ tên.
7. Danh mục Điều khiển; màu copper (dự phòng slate nếu không qua kiểm tra ΔE).

## Câu hỏi mở

1. **Màu.** Copper (hue ≈ 50°) có qua ngưỡng ΔE của 0008 so với badge cảnh báo ở cả hai theme và khi mù màu không? Nếu không:
   slate (gần trung tính, gần `start`) — người làm báo lại kết quả đo.
2. **"Tách thành biến"**: chọn một đoạn trong ô template → menu "Tạo biến từ đoạn này" (thêm bước Đặt biến ở đầu quy trình, thay mọi
   chỗ có đúng đoạn đó). Hữu ích cho luồng mã lô; để design sau nếu người dùng muốn.
3. **Kiểu Ngày** (`var.d = {{run.today}}` rồi dùng trong option from/to của Date) phụ thuộc mục "Option số/ngày của generator nhận
   biến" (đang Hoãn).
4. **Hàm trong template** (`upper`, `pad`, phép tính) — vẫn Hoãn; khi làm, Cộng thêm có thể giữ nguyên như lối tắt.
5. Có cần mục "Biến" trong panel kết quả (bảng tên → giá trị cuối) ngoài chip trên thẻ không? Chưa làm; chip + mẫu bảng chọn đủ cho
   đợt này.

## Đã làm

(Cập nhật khi code xong: commit hoặc PR, chỗ nào khác với thiết kế và vì sao.)
