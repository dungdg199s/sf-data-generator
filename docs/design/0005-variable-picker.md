# 0005 — Quét và chọn biến từ UI (variable picker)

- **Trạng thái:** Nháp
- **Ngày:** 2026-10-27
- **Liên quan:** [0001](0001-workflow-editor-ux.md) (inspector, đổi alias tự cập nhật),
  [0003](0003-process-mode.md) (chế độ Quy trình, JSON v2 dạng cây, `shared/`),
  [0004](0004-streaming-execution.md) (chạy dạng stream), [0006](0006-query-pick-nodes.md) (node Query và Chọn bản ghi),
  [workflow-schema.md](../workflow-schema.md), [field-types.md](../field-types.md)

## Vấn đề

Muốn đặt `Title` của Contact là `"<Industry của Account> contact #<lần lặp>"`, hiện người dùng phải tự gõ
`{{acc.Industry}} contact #{{loop.index}}`. Để gõ đúng, họ phải nhớ alias của node Account, đúng API name của field,
và tên biến lặp của **đúng** vòng lặp bao quanh. Mỗi chỗ đó lại phải mở một node khác ra xem. Gõ sai cũng không có lỗi nào
báo. Đã kiểm tra trên code hiện tại (script thử với `runWorkflow`/`validateWorkflow`):

| Tình huống | Hiện tại |
| --- | --- |
| `{{acc.Nmae}}` (gõ sai field), `{{nope.X}}` (alias không có), `{{this.LastName}}` khi chưa có field đó | Validate không báo gì. Template sinh ra chuỗi rỗng ở chỗ đó |
| `{{i.index}}` dùng ngoài vòng lặp `i` | Không báo lỗi, ra `''` |
| Branch `left` gõ `{{loop.index}}` (theo thói quen viết template) | Không báo lỗi. Điều kiện không bao giờ đúng, nên **0 bản ghi** |
| Field Template mới, mặc định `{{this.LastName}} - {{loop.index}}`, node không nằm trong vòng lặp | Ra `" - "` |
| Loop(10){Account} → xong → Loop(30){Contact, `AccountId` lấy **ngẫu nhiên** từ `acc`} | Báo **lỗi sai** "node "acc" phải nằm phía trước". Lúc chạy thì vẫn đúng, vì `isAncestor` chỉ nhìn cạnh nối, không biết nhánh `xong` chạy sau nhánh `lặp` |
| Gõ alias có ký tự lạ (`acc(x`) | `renameAlias` dựng `RegExp` từ alias mà không escape, nên ném lỗi `Unterminated group` ngay khi đang gõ |
| Hai vòng lặp cùng tên `loop` (tên mặc định), đổi tên một vòng thành `i` | Mọi `{{loop.` trong workflow đều bị đổi, kể cả chỗ thuộc vòng còn lại |

Các công cụ workflow quen thuộc giải quyết việc này bằng một bảng chọn: "Dynamic content" của Power Automate, bảng
biến/expression của n8n, data picker của Zapier. Bảng đó liệt kê mọi giá trị có sẵn tại đúng điểm đang sửa và chèn vào
bằng một cú bấm.

## Mục tiêu / Ngoài phạm vi

- Mục tiêu:
  - Bộ chọn biến cho các ô nhận biến. Nó liệt kê đúng những gì dùng được tại node hoặc field đó, theo nhóm node và màu
    node, kèm kiểu và giá trị mẫu từ lần xem trước. Có tìm kiếm và dùng được hoàn toàn bằng bàn phím.
  - Phân tích phạm vi biến (scope analysis) bằng **một** hàm thuần `analyzeScope`, chạy ở server và, nếu có thư mục
    `shared/` của 0003, cả ở trình duyệt. Đây là nguồn sự thật duy nhất cho bộ chọn, validate và ô Node cha.
  - Hợp đồng `exposes` và `flow` trong danh mục node: mỗi loại node tự khai báo nó cung cấp biến gì, và các cổng (v1)
    hoặc slot (v2) của nó chạy ra sao. 0003 và 0006 dựa vào hợp đồng này.
  - Validate tham chiếu: biến không tồn tại hoặc ngoài phạm vi là **lỗi** (kèm "Ý bạn là…" và cách sửa). Biến có thể
    trống là **cảnh báo**.
  - Đổi tên hoặc xóa field, alias, biến lặp thì tham chiếu đi theo, hoặc người dùng được báo ngay là chỗ nào sẽ hỏng.
- Ngoài phạm vi:
  - Biểu thức hoặc hàm trong template (`{{upper(acc.Name)}}`, phép tính).
  - Option kiểu số nhận biến (số lần lặp lấy từ `{{acc.NumberOfEmployees}}`).
  - `right` của Branch nhận biến.
  - Đi xuyên Lookup (`{{con.AccountId.Name}}`).
  - Id thật sau insert (`{{acc.Id}}`).
  - Ghi chú: các mục trên ghi ở [Câu hỏi mở](#câu-hỏi-mở--việc-tiếp-theo). Hợp đồng ở đây được thiết kế để thêm chúng
    sau mà không phải đổi lại.

## Luồng người dùng

**Luồng chính.** Mở mẫu "Account + Contact", node `con`, thêm field `Description` = `{{acc.Industry}} contact #{{loop.index}}`:

1. Chọn node `con` trên canvas. (1)
2. Bấm **+ Thêm field**, gõ `Description`, chọn kiểu **Template**. Panel tùy chọn tự mở (như hiện nay). Mặc định
   `{{this.$n}}` chạy được ngay: xem trước ra `1`, `2`, `3`… (3)
3. Bấm nút **{x}** ở cuối ô **Mẫu**. Bảng chọn mở và con trỏ nằm sẵn ở ô tìm kiếm. Ô đang hiện giá trị mặc định
   (option chưa được lưu), nên lần chèn đầu tiên sẽ thay cả ô. (1)
4. Gõ `indu`. Dòng `acc · Industry  Picklist  "Banking"` được tô sẵn. Nhấn **Enter**: ô thành `{{acc.Industry}}`,
   con trỏ nằm ngay sau `}}`. (2)
5. Gõ tiếp ` contact #{{`. Ngay khi gõ `{{`, bảng chọn tự mở với danh sách đã lọc. Gõ `in`: `loop · index` đứng đầu
   (vòng lặp trong cùng được xếp trước `i`, vòng ngoài). Nhấn **Enter**. (3)

Tổng cộng 10 thao tác, trong đó 6 thao tác cho phần ghép biến (bước 3–5). Người dùng không phải nhớ alias, API name hay
tên biến lặp, và không phải mở node khác để xem. Dưới ô Mẫu hiện dải chip `[acc · Industry] " contact #" [loop · index]`
và dòng `Lần xem trước: "Banking contact #1"` (sau khi bấm Ctrl+Enter).

**Lookup.** Field `AccountId` (kiểu Lookup), ô **Node cha**: bấm dropdown (1). Danh sách chỉ có các node Record đã chạy
trước node này, gần nhất ở trên. Node chạy sau nằm trong nhóm xám "Không dùng được ở đây". Chọn `acc (Account)` (1).
Import từ org vẫn tự chọn node cha khi chỉ có **một** node *dùng được* khớp sObject.

**Branch so sánh.** Chọn **Loại điều kiện = So sánh giá trị** (1). Bấm vào ô **Giá trị**: ô đang trống thì bảng chọn tự mở,
ô có giá trị thì bấm {x} (1). Gõ `indu` rồi Enter (2). Giá trị lưu là `acc.Industry`, không có ngoặc.

**Trường hợp lỗi:**

- *Gõ tay sai.* `{{acc.Nmae}}`: khoảng 400 ms sau, chip `acc · Nmae` đỏ lên và card field có viền đỏ, kèm dòng
  `Field "Title": node "acc" (Account) không có field "Nmae". Ý bạn là "Name"? …` và nút **Sửa thành {{acc.Name}}**. (1 thao tác để sửa)
- *Đổi tên field.* Ở node `acc`, đổi `Industry` thành `Industry__c` rồi rời ô. Mọi `{{acc.Industry}}` và `acc.Industry`
  tự đổi theo. Toast: `Đã cập nhật 1 tham chiếu: acc.Industry → acc.Industry__c. Ctrl+Z để hoàn tác.` (0 thao tác thêm)
- *Xóa field đang được dùng.* Toast: `Field "Industry" đang được dùng ở 1 chỗ: con › Title. Chỗ đó sẽ báo lỗi cho tới khi sửa. Ctrl+Z để hoàn tác.`
  Node `con` có badge đỏ. Bấm lỗi trong danh sách lỗi thì node `con` được chọn và card `Title` **tự mở**. Bấm chip đỏ thì
  bảng chọn mở ở chế độ thay đúng token đó. (2)
- *Kéo node ra ngoài vòng lặp.* Lỗi `{{loop.index}} chỉ dùng được bên trong nhánh "lặp" của vòng lặp "loop"…`.
- *Node chưa nối từ Bắt đầu* (vừa kéo từ palette). Bảng chọn vẫn cho chèn mọi biến, có dòng ghi chú
  `Node này chưa nối từ Bắt đầu nên chưa kiểm tra được phạm vi.` Validate chỉ kiểm tra phần tĩnh (tên và field có tồn tại không).

## Thiết kế UI

### Ô nào có bộ chọn biến

Bộ chọn bật theo khai báo trong option schema (`vars`, xem phần API). Client không hard-code tên option nào.

| Ô | Có bộ chọn? | Chế độ | Lý do |
| --- | --- | --- | --- |
| Template › **Mẫu** (`template`) | Có | `template`: chèn `{{path}}` tại con trỏ | Chỗ dùng biến nhiều nhất |
| Rẽ nhánh › **Giá trị** (`left`) | Có | `path`: thay cả ô bằng `path` | Ô chỉ nhận một đường dẫn |
| Lookup/Master-Detail › **Node cha** (`ref`, kind `ref`) | Có (dropdown) | `source`: chọn node | Một lựa chọn trong vài node. `<select>` gốc đủ dùng, có sẵn bàn phím và trợ năng, chỉ cần đổi nguồn dữ liệu sang scope |
| Rẽ nhánh › **So với** (`right`) | Không (bản này) | – | Hiện là giá trị cố định. Cho nhận `{{}}` là đổi ngữ nghĩa, để [Câu hỏi mở](#câu-hỏi-mở--việc-tiếp-theo) |
| `count`/`min`/`max` của Loop và Record | Không | – | Cần biểu thức kiểu số và kẹp theo `LIMITS` lúc chạy. Chế độ "Ngẫu nhiên trong khoảng" đã đủ cho phần lớn nhu cầu |
| Text `prefix`/`suffix`, Constant `value` | Không | – | Template đã làm được việc này. Tránh có hai cách cho một việc. `help` của Constant thêm câu "Muốn ghép biến? Đổi kiểu sang Template." |
| `sobject`, `alias`, tên field | Không | – | Không phải giá trị lúc chạy |

### Cách mở bảng chọn

- **Nút `{x}`** ở mép phải ô. `title="Chèn biến (gõ {{ hoặc Ctrl+Space)"`, `aria-label="Chèn biến"`. Khi mở bằng nút,
  focus nhảy vào ô tìm kiếm.
- **Gõ `{{`** trong ô chế độ `template`: bảng chọn mở dạng autocomplete. Focus ở lại trong ô, chữ gõ sau `{{` là từ khóa
  lọc. Bảng tự đóng khi gõ `}}`, gõ một ký tự không thuộc `[\w.$]`, hoặc khi con trỏ rời khỏi đoạn `{{…`.
- **Ctrl+Space** (mọi chế độ). Trên macOS, ⌃Space thường đã được dùng để đổi bộ gõ (Telex), nên ở đó dùng `{{` hoặc nút {x}.
- Chế độ `path`: bấm vào ô đang trống, hoặc nhấn **↓**, cũng mở bảng chọn (giống combobox).
- **Không dùng `@`** để mở: template hay chứa email (`{{this.FirstName}}@example.com`), mỗi lần gõ `@` lại bật bảng chọn
  thì rất phiền.

### Bố cục

Popup kiểu `position: fixed`, neo dưới ô và lật lên trên nếu không đủ chỗ. Rộng `max(độ rộng ô, 340px)`, cao tối đa 360 px.

Hình dưới minh họa lúc sửa field `Title` của `con` trong mẫu "Account + Contact". Giả sử có thêm hai node để thấy đủ các
trạng thái: `task` chỉ được tạo ở một nhánh trước `con`, và `opp` được nối sau `con`.

```
┌──────────────────────────────────────────────────────────┐
│ 🔍 [Tìm biến: tên field, alias, kiểu…                 ]   │
├──────────────────────────────────────────────────────────┤
│ ● this · Contact (bản ghi đang tạo)                       │
│     $n            Số        1, 2, 3…                      │
│     FirstName     Text      "Minh"                        │
│     LastName      Text      "Nguyen"                      │
│     Email         Email     "minh.nguyen12@example.com"   │
│ ● loop · Vòng lặp 1–4 lần                                 │  ← màu node Lặp
│     index         Số        1…4   Lần lặp hiện tại (từ 1) │
│     index0        Số        0…3                           │
│     count         Số        1–4                           │
│ ● task · Task                         [có thể trống]      │
│ ● acc · Account                                           │  ← màu node Record
│  ▸  Name          Text      "Acme Inc"                    │  ← dòng đang chọn
│     Industry      Picklist  "Banking"                     │
│     AnnualRevenue Currency  1250000                       │
│ ● i · Vòng lặp 5 lần                                      │
│ ▸ Không dùng được ở đây (3)                               │  ← thu gọn mặc định
│     opp · Opportunity — chạy sau node này                 │
│     this.AccountId — nằm dưới field "Title", kéo lên để dùng │
│     this.Birthdate — nằm dưới field "Title", kéo lên để dùng │
├──────────────────────────────────────────────────────────┤
│ ↑↓ chọn · Enter chèn · Esc đóng                           │
│ Bấm ▶ Xem trước (Ctrl+Enter) để thấy giá trị mẫu.         │  ← chỉ hiện khi chưa có kết quả
└──────────────────────────────────────────────────────────┘
```

- **Nhóm** theo node. Đầu nhóm có chấm màu `NODE_COLORS[nodeType]`, tên biến (`acc`, monospace), nhãn (`label` server
  trả về: sObject, hoặc "Vòng lặp 1–4 lần"), và badge trạng thái nếu có:
  - `bản ghi cuối` (`certainty: last`). Tooltip: `Tạo trong vòng lặp đã kết thúc: giá trị là bản ghi của lần lặp cuối. Lookup "Ngẫu nhiên" sẽ chọn trong tất cả.`
  - `có thể trống` (`certainty: maybe`). Tooltip là `note` do `analyzeScope` trả về, ví dụ `vòng lặp "loopAcc" có thể chạy 0 lần`.
- **Thứ tự:**
  1. `this`: field **phía trên** ô đang sửa, và `$n`.
  2. Các nguồn dùng được, theo thứ tự server trả về (gần nhất trước, nên vòng lặp trong cùng và node Record ngay trước
     đứng đầu).
  3. "Không dùng được ở đây". Nhóm này thu gọn, mỗi dòng ghi lý do và không chèn được.
- **Dòng biến:** `key` (monospace), nhãn kiểu (nhãn field type từ `meta.fieldTypes`, ví dụ "Currency"; biến không có
  field type thì dùng nhãn `valueType` từ `meta.syntax.valueTypes`, ví dụ "Số"), giá trị mẫu, và `label`/`help` nếu có
  (biến lặp, `$n`).
- **Tìm kiếm:** khớp chuỗi con, không phân biệt hoa thường, trên `name.key`, `key`, nhãn kiểu và nhãn nhóm. Khớp đầu
  chuỗi xếp trước, sau đó giữ thứ tự nhóm. Gõ `acc.na` lọc theo đường dẫn. Mỗi nhóm hiện tối đa 200 dòng; quá thì có dòng
  `Còn 312 field, gõ để lọc.` (field từ describe của 0006 có thể rất nhiều).
- **Không có biến nào:** `Chưa có biến nào dùng được ở đây. Biến đến từ: field phía trên trong node này (this), node Record chạy trước, hoặc node Lặp bao quanh.`
- **Đầu nhóm** chỉ để thu gọn hoặc mở nhóm, không chèn gì. `{{acc}}` (cả bản ghi) không có nghĩa trong template.

### Giá trị mẫu

- Lấy từ **lần xem trước gần nhất** (`state.result.records`): bản ghi **đầu tiên** của node nguồn, `fields[key]`. `this.*`
  lấy bản ghi đầu tiên của chính node đang sửa. Client dựng `Map<nodeId, record>` một lần mỗi khi có kết quả mới.
  - Với 0004 (stream), `records` chỉ có các dòng xem trước, và có thể thêm `samples` theo node (xem phần phụ thuộc).
  - Với 0006, member của Query lấy từ `queries[].records[0]`.
- Cách hiển thị:
  - chuỗi: cắt 24 ký tự, có ngoặc kép
  - số, boolean: in nguyên
  - `null`: `—`
  - `{ $ref }`: `→ acc#1`
  - geolocation: `10.77, 106.70`
- Workflow đã đổi so với lần xem trước (`runKey` khác): giá trị mẫu chuyển màu xám nghiêng, tooltip
  `Từ lần xem trước; workflow đã thay đổi sau đó.` Field thêm sau lần xem trước thì hiện `—`, tooltip `Chưa có trong lần xem trước.`
- Biến lặp và `$n` không nằm trong kết quả chạy. Chúng dùng `example` do server tính từ config (`1…4`, `0…3`, `1–4`, `1, 2, 3…`).
- Đang mở bảng chọn mà nhấn Ctrl+Enter thì xem trước vẫn chạy. Bảng chọn cập nhật giá trị mẫu khi có sự kiện `result`,
  và vẫn giữ dòng đang chọn.

### Phím tắt trong bảng chọn

| Phím | Tác dụng |
| --- | --- |
| ↑ / ↓, PageUp / PageDown, Home / End | Di chuyển giữa các dòng chèn được, bỏ qua đầu nhóm và dòng xám |
| Enter hoặc Tab | Chèn dòng đang chọn, đóng bảng, đưa focus về ô với con trỏ ngay sau phần vừa chèn |
| Esc | Đóng bảng, giữ nguyên chữ đã gõ, focus về ô. `stopPropagation` để Esc toàn cục không bỏ chọn node |
| Ctrl+Enter | Vẫn là Xem trước (phím tắt toàn cục) |

Trợ năng: ô nhập có `role="combobox"`, `aria-expanded`, `aria-controls`, `aria-activedescendant`. Danh sách có
`role="listbox"`, mỗi dòng có `role="option"`, mỗi nhóm có `role="group"` kèm `aria-label`.

### Cách chèn

- Chế độ `template`:
  - Chèn `{{path}}` vào chỗ đang chọn (thay đoạn đang bôi đen).
  - Ô đang hiện giá trị **mặc định** (option chưa được lưu, ví dụ `options.template === undefined`) thì lần chèn đầu
    tiên thay cả ô, vì giá trị mặc định chỉ là ví dụ.
  - Nếu mở bằng `{{query`, thay luôn đoạn `{{query` đó. Nếu ngay sau con trỏ đã có `}}` thì không thêm `}}` nữa.
  - Dùng `document.execCommand('insertText')` để Ctrl+Z gốc của ô vẫn hoàn tác được. Nếu không có thì dùng
    `setRangeText` rồi phát sự kiện `input`.
- Chế độ `path`: thay toàn bộ giá trị bằng `path`, không có ngoặc.
- Mỗi lần chèn là **một bước undo riêng**: gọi `updateWorkflow` với `coalesceKey` duy nhất, để không bị gộp vào lần gõ
  phím trước đó. Sự kiện vẫn có `source: 'inspector'` để inspector không render lại và ô không mất focus.

### Hiển thị biến đã chèn: chữ thô và dải chip

Giá trị trong ô vẫn là **chữ thô** `{{acc.Industry}} contact #{{loop.index}}`. Ngay dưới ô có một **dải chip chỉ để xem
và bấm** (không sửa được trực tiếp):

```
Mẫu  [ {{acc.Industry}} contact #{{loop.index}}                         {x} ]
     [● acc · Industry] " contact #" [● loop · index]
     Lần xem trước: "Banking contact #1"
```

- Mỗi chip có viền trái màu node nguồn. Rê chuột vào chip hiện `Account.Industry · Picklist · mẫu: "Banking"`.
- Chip **đỏ** khi trong danh sách lỗi có issue cùng `nodeId`, `field` và `path`. Tooltip là câu lỗi. Bấm vào chip thì
  bôi đen đúng token đó trong ô và mở bảng chọn để thay.
- Chip xám (không màu) khi tên chưa khớp nguồn nào trong `scope` mới nhất, tức là đang gõ dở và chưa có kết quả validate.
- `Lần xem trước:` là giá trị thật do server sinh cho field này ở bản ghi đầu tiên của node, không phải client tự ghép.
  Dòng này chỉ hiện khi đã có kết quả. (Đây cũng là mục "xem trước nhanh trong inspector" còn treo ở 0001.)
- Rẽ nhánh `left` dùng cùng thành phần này, chỉ có một chip.

Lý do không dùng chip bên trong ô (contenteditable như Power Automate): xem [Phương án](#phương-án-đã-cân-nhắc).

### Node cha của Lookup (`kind: 'ref'`)

Vẫn dùng `<select>` gốc, nhưng dựng từ `scope.at[nodeId]` thay cho `recordAliases()` (hiện liệt kê mọi node Record, kể
cả node chạy sau):

```
— chọn node cha —
acc (Account)
opp (Opportunity) · bản ghi cuối
task (Task) · có thể trống
─ Không dùng được ở đây ─          (optgroup, các option disabled)
lead (Lead) — chạy sau node này
```

- Chỉ hiện nguồn có `lookupParent: true` (node Record; 0006 thêm Query và Chọn bản ghi). Nhãn ghi kèm nguồn gốc:
  `accs (Account · đọc từ org)`, giống cách 0006 đề xuất.
- Option `from` của node Chọn bản ghi (0006) cũng có `kind: 'ref'` nên dùng cùng cách dựng, lọc theo `accepts: { pool: true }`.
- Giá trị đang lưu mà không còn tồn tại thì vẫn giữ option `xyz (không tồn tại)` như hiện nay.
- Hộp thoại Import từ org cũng tự chọn node cha theo danh sách *dùng được* này.

### Đổi tên và xóa (giữ công sức)

- **Alias của Record:** vẫn đổi toàn cục như hiện nay, vì alias Record là duy nhất. Thêm hai thay đổi:
  - Escape regex.
  - Duyệt mọi option có `vars` (lấy từ meta) thay vì hard-code `template`/`left`.
- **Tên biến lặp:** chỉ đổi ở những chỗ mà tham chiếu **thực sự trỏ tới vòng lặp này**. Lúc ô alias nhận focus, client
  chụp lại danh sách `scope.refs` có `source === loopNodeId`. Trong lúc gõ, chỉ đổi ở các option đó. Nếu chưa có scope
  (server không trả lời) thì đổi toàn cục như cũ.
- **Tên field:** khi rời ô (sự kiện `change`, không phải từng phím) và cả tên cũ lẫn tên mới đều không rỗng:
  - đổi `{{<alias>.Cũ}}` ở mọi node
  - đổi `{{this.Cũ}}` trong cùng node
  - đổi `left` bằng `<alias>.Cũ` hoặc bắt đầu bằng `<alias>.Cũ.`
  - Toast: `Đã cập nhật N tham chiếu: acc.Cũ → acc.Mới. Ctrl+Z để hoàn tác.` Không có tham chiếu nào thì không hiện toast.
- **Xóa field, xóa node Record hoặc Lặp:** vẫn xóa ngay, không hỏi. Dùng `scope.refs` để báo:
  `Field "Industry" đang được dùng ở 2 chỗ: con › Title, task › Subject. Các chỗ đó sẽ báo lỗi cho tới khi sửa. Ctrl+Z để hoàn tác.`
  Với node: `Node "acc" đang được dùng ở 3 chỗ: …`.
- **Bấm lỗi trong danh sách lỗi:** chọn node như hiện nay, và tự **mở card field** đang lỗi rồi cuộn tới đó.
- **Gợi ý sửa:** issue có `suggestion` thì dòng lỗi trong card có nút `Sửa thành {{acc.Name}}`. Nút này thay token đầu
  tiên khớp trong option `suggestion.option`. Mỗi lần sửa là một bước undo.

### Thông báo lỗi và cảnh báo (đúng câu chữ)

Option của field có tiền tố `Field "<Tên>": `, và issue có `field: "fields.<Tên>"`. Option của node (`left`) không có
tiền tố, và có `field: "left"`. Mọi issue tham chiếu đều có thêm `path` và `code`.

| `code` | Mức | Câu thông báo |
| --- | --- | --- |
| `unknownName` | lỗi | `Field "Title": không có biến "acco" (không phải alias của node Record nào, cũng không phải tên biến lặp). Ý bạn là "acc"? Bấm {x} để chọn biến có sẵn.` (bỏ câu "Ý bạn là" nếu không có gợi ý) |
| `unknownMember` | lỗi | `Field "Title": node "acc" (Account) không có field "Nmae". Ý bạn là "Name"? Thêm field đó vào node "acc" hoặc chọn field khác bằng {x}.` |
| `unknownMember` (biến lặp) | lỗi | `Field "Title": biến lặp "loop" chỉ có index, index0, count; không có "idx".` |
| `wholeRecord` | lỗi | `Field "Title": {{acc}} là cả bản ghi; hãy chọn một field, ví dụ {{acc.Name}}.` |
| `noTraversal` | lỗi | `Field "Title": không đi tiếp qua field Lookup "AccountId" được. Dùng thẳng alias của node cha, ví dụ {{acc.Name}}.` (chỉ khi member là `reference` không có member con; `{{accs.Owner.Name}}` của Query vẫn hợp lệ vì `Owner` có member con) |
| `after` | lỗi | `Field "Title": node "opp" chạy sau node này nên chưa có giá trị khi chạy tới đây. Nối lại để "opp" đứng trước, hoặc chọn biến khác.` |
| `otherBranch` | lỗi | `Field "Title": node "task" nằm ở nhánh còn lại của Rẽ nhánh phía trên nên không chạy cùng lượt với node này. Đưa "task" ra trước Rẽ nhánh, hoặc chọn biến khác.` |
| `after` (Lookup `ref`) | lỗi | `Field "AccountId": node "acc" phải nằm phía trước node này trong workflow.` (giữ đúng câu hiện tại cho v1; khi 0003 vào thì dùng câu của 0003 "bước "acc" nằm sau bước này nên chưa có bản ghi khi chạy tới đây…", và câu `otherBranch` của 0003 cho Lookup) |
| `disabled` (v2) | lỗi | Câu của 0003: `Field "Title": bước "acc" đang tắt. Bật lại bước đó (Ctrl+/) hoặc chọn biến khác.` |
| `outsideLoop` | lỗi | `Field "Title": {{loop.index}} chỉ dùng được bên trong nhánh "lặp" của vòng lặp "loop". Kéo node này vào nhánh "lặp", hoặc bỏ biến này.` |
| `thisBelow` | lỗi | `Field "Title": {{this.Email}} chỉ thấy field phía trên. Kéo field "Email" lên trên "Title" (nút ↑).` |
| `thisUnknown` | lỗi | `Field "Title": node này không có field "LastNam". Ý bạn là "LastName"?` |
| `thisSelf` | lỗi | `Field "Title": template không thể dùng chính field "Title".` |
| `thisOutsideRecord` | lỗi | `"this" chỉ dùng trong template của node Record. Ở đây hãy chọn alias của node, ví dụ acc.Industry.` |
| `selfAlias` | lỗi | `Field "Title": đang ở trong node "con", hãy dùng {{this.LastName}} thay cho {{con.LastName}} (con.* ở đây là bản ghi trước đó của chính node này).` |
| `unknownMember` (Query, 0006) | lỗi | `Field "Title": Query "accs" không lấy field "Industry". Thêm Industry vào "Field cần lấy" của node Query.` (lời sửa theo 0006; mức lỗi xem Câu hỏi mở số 8) |
| `noIdYet` | lỗi | `Field "Title": "acc" là bản ghi được sinh ra nên chưa có Id trước khi insert. Muốn nối bản ghi con với "acc" thì dùng field Lookup; {{acc.Id}} chỉ có với bản ghi đọc từ org (Query, Chọn bản ghi).` |
| `unclosed` | cảnh báo | `Field "Title": có "{{" chưa đóng bằng "}}" nên sẽ được giữ nguyên là chữ.` |
| `maybe` (nhánh) | cảnh báo | `Field "Title": "task" chỉ được tạo trên một số nhánh trước khi tới đây, nên có thể chưa có (giá trị trống, hoặc là bản ghi của lần lặp trước). Đặt node này ngay sau "task" nếu cần luôn có giá trị.` |
| `maybe` (lặp 0 lần) | cảnh báo | `Field "AccountId": vòng lặp "loopAcc" có thể chạy 0 lần nên "acc" có thể chưa có bản ghi.` Với Master-Detail thêm: ` Master-Detail sẽ báo lỗi khi chạy; đặt "Ít nhất" ≥ 1.` |
| `maybe` (biến lặp) | cảnh báo | `Field "Title": node này chạy cả trong và ngoài vòng lặp "loop", nên {{loop.index}} có lúc trống.` |
| `openMember` (0006) | cảnh báo | `Field "Title": chưa chắc "q" có field "Foo" (danh sách field chưa đầy đủ); kiểm tra lại câu truy vấn.` |
| (phân tích quá lớn) | cảnh báo | `Workflow quá phức tạp để kiểm tra hết phạm vi biến; một số lỗi về biến có thể không được báo.` (không có `nodeId`) |

Field và biến lặp so khớp **có phân biệt hoa thường**, giống lúc chạy. Gợi ý "Ý bạn là" lấy tên khớp khi bỏ qua hoa
thường, hoặc tên cách tối đa 2 ký tự (Levenshtein). `certainty: last` không sinh issue nào, vì giá trị lúc đó là xác
định. Dòng `maybe` (biến lặp) chỉ có ở v1. Trên cây v2 không có node nào vừa ở trong vừa ở ngoài vòng lặp.

### Chế độ process (0003)

- Bộ chọn là một thành phần độc lập, `client/js/var-picker.js`. Không đặt tên `picker.js`, vì 0006 đã dùng thuộc tính
  `picker` của option cho các trợ giúp lấy dữ liệu từ org. `forms.js` gắn bộ chọn biến vào mọi option có `vars`.
- Theo 0003, inspector là nơi **duy nhất** sửa cấu hình ở cả hai chế độ, và form vẫn dựng bằng `forms.js`. Vì vậy bộ chọn
  tự có ở chế độ Quy trình, không phải viết thêm gì. Nếu sau này thẻ bước cho sửa trực tiếp, chỉ cần gọi `renderOptions`
  với ctx `{ nodeId, fieldIndex }`.
- Dữ liệu bộ chọn là `scope.at[id]` do `analyzeScope` tính, không phụ thuộc cách hiển thị. Chuyển qua lại giữa Sơ đồ và
  Quy trình thì danh sách biến vẫn y hệt, vì id bước giữ nguyên (0003 giữ `id` khi chuyển v1 sang v2).
- Khi 0003 vào trước, câu chữ đổi "node" thành "bước" cho khớp chế độ Quy trình (ví dụ `bước "opp" chạy sau bước này…`).
  Mã lỗi (`code`) giữ nguyên.

## Thay đổi dữ liệu / API

Mọi thay đổi dưới đây là **(dự kiến)**.

### 1. Ngữ nghĩa phạm vi (scope analysis)

Hàm thuần `analyzeScope(workflow, catalog)` → `{ partial, sources, at, refs }`:

- Không gọi org.
- Không import gì chỉ có ở server. `catalog` là `{ nodeTypes, fieldTypes }`: server truyền danh mục của nó, client truyền
  `state.meta`.
- Đây là **nguồn sự thật duy nhất** cho phạm vi biến. Validate, ô Node cha, Import từ org và bộ chọn biến đều dùng nó.
- Hàm này là bản mở rộng của `availableAt()` mà 0003 đề xuất. Nên chỉ có **một** hàm: `availableAt(wf, id)` chỉ là
  `analyzeScope(wf).at[id].visible` lọc lấy nguồn bản ghi.

Đặt ở đâu tùy vào thứ tự làm với 0003 (người dùng chọn, Câu hỏi mở số 9):

| Thứ tự | File | Client lấy dữ liệu bằng cách | Thuật toán |
| --- | --- | --- | --- |
| **0003 làm trước (đề xuất, giống 0003 đề xuất)** | `shared/scope.js`, cạnh `shared/workflow-tree.js` | Gọi trực tiếp mỗi lần workflow đổi, không qua mạng, không bị trễ | Duyệt cây v2 (đơn giản). Server chuyển v1 sang v2 trước khi validate, nên không phải xử lý đồ thị |
| 0005 làm trước | `server/workflow/scope.js` | `/api/validate` trả kèm `scope` (mục 4); mở bộ chọn khi còn lượt validate đang chờ thì gọi validate ngay | Duyệt đồ thị v1 theo ngữ cảnh (bên dưới). 0003 sau này viết lại trên cây và chuyển sang `shared/`, test ngữ nghĩa giữ nguyên |

Dạng dữ liệu `scope` (mục 4) **giống nhau** ở cả hai cách, nên code bộ chọn không phụ thuộc vào cách nào được chọn.

**Nguồn biến (source):** mỗi node hoặc bước có loại khai báo `exposes`. Khóa của nguồn là `id`, ổn định khi đổi alias.
Tên dùng trong đường dẫn là `config[exposes.name.key]`; trống thì lấy `exposes.name.default`, rồi đến `id`. Record dùng
`alias || id`, giống executor.

**Độ chắc chắn (`certainty`) của một nguồn tại một node/bước.** Dùng đúng tên của 0003 (`always`, `maybe`, `disabled`)
và thêm `last`:

| `certainty` / lý do ẩn | Nghĩa | Ví dụ |
| --- | --- | --- |
| `always` | Trên **mọi** đường chạy tới đây, nguồn đã chạy trước, ở cùng ngữ cảnh hoặc ngữ cảnh bao ngoài | `acc` dùng trong `con`; `acc` nằm trước trong cùng body |
| `last` | Luôn có, nhưng được tạo trong body của một vòng lặp **đã kết thúc**: giá trị là bản ghi của lần lặp cuối. Chỗ nào chỉ biết `always`/`maybe` (như `availableAt` của 0003) thì coi là `always` | Lặp{acc}, sau đó `con` dùng `acc` |
| `maybe` | Chỉ có trên **một số** đường chạy | Tạo ở một nhánh; vòng lặp có thể chạy 0 lần (`count: 0`, `min: 0`); (chỉ v1) node chạy cả trong lẫn ngoài body |
| ẩn `after` | Nguồn chạy sau node này, hoặc là chính node này (khi tham chiếu bằng alias) | `opp` nối sau `con` |
| ẩn `otherBranch` | Nguồn nằm ở nhánh còn lại của một Rẽ nhánh đang bao node này | `task` ở nhánh Đúng, dùng ở nhánh Sai |
| ẩn `outsideLoop` | Biến lặp của vòng lặp mà body không chứa node này | `{{i.index}}` sau khi vòng `i` đã xong |
| ẩn `shadowed` | Biến lặp bị vòng trong cùng tên che | Hai vòng lồng nhau cùng tên `loop` |
| ẩn `disabled` (v2) | Nguồn, hoặc một khung bao nó, đang tắt (`disabled: true` của 0003) | – |
| ẩn `thisBelow` | Field của chính node, nằm dưới ô đang sửa. Bộ chọn tự tính từ thứ tự field; validate tính bằng `analyzeScope` | `this.Birthdate` khi sửa `Title` |

Tham chiếu tới nguồn `maybe` chỉ là cảnh báo, vì lúc chạy vẫn ra giá trị (có thể trống). Tham chiếu tới nguồn ẩn là lỗi,
vì lúc chạy luôn trống hoặc sai.

**Thuật toán trên cây v2** (khi 0003 làm trước). Duyệt đệ quy theo thứ tự đọc, mang theo trạng thái `S`:

- Bước có `exposes.visibleIn: "downstream"`: sau bước đó, `S + {nguồn: always}`.
- Khung `flow.kind: "loop"`: thân chạy với `S + {biến lặp: always}`. Sau khung, nguồn mới tạo trong thân thành `last`;
  nếu `minIterations(config) === 0` thì thành `maybe`.
- Khung `flow.kind: "branch"`: mỗi slot trong `alternatives` chạy với `S`. Sau khung, nguồn chỉ có ở một nhánh thành
  `maybe`. Nguồn ở nhánh này là `otherBranch` đối với nhánh kia.
- Bước tắt và bước con của nó không kiểm tra tham chiếu (giống 0003). Nguồn tắt thì `disabled`.

**Thuật toán trên đồ thị v1** (khi 0005 làm trước). Đa thức, chỉ dựa trên `flow`, không hard-code `loop`/`branch`:

1. *Ngữ cảnh* là ngăn xếp các vòng lặp đang chạy body. Ngữ cảnh gốc là `[]`. Trong một ngữ cảnh, đi theo mọi cổng trừ
   cổng `flow.body`. Xử lý node theo thứ tự topo (đồ thị không có vòng). `IN(node)` là phép gộp (join) các `OUT` của node
   đứng trước trong cùng ngữ cảnh.
2. Hàm chuyển trạng thái:
   - Node có `exposes.visibleIn: "downstream"`: `OUT = IN + {nguồn: always}`.
   - `flow.kind: "branch"`: mỗi cổng trong `alternatives` nhận `IN`.
   - `flow.kind: "loop"`:
     - Body chạy trong ngữ cảnh mới `stack + [loopId]`, với `IN + {biến lặp: always}`. Kết quả body `B` là phép gộp trạng
       thái ở mọi điểm kết thúc của chuỗi body.
     - Sau vòng lặp, đi theo cổng `after`, với biến lặp trả về như cũ. Nguồn mới tạo trong body có `always` thì thành
       `last`. Nếu `minIterations(config) === 0` thì gộp thêm với `IN`, khi đó nguồn mới thành `maybe`.
   - Điểm kết thúc (cổng cần đi tiếp không có cạnh): trạng thái tại đó góp vào kết quả của ngữ cảnh.
3. Phép gộp: có ở cả hai phía thì lấy mức xấu hơn (`always` < `last` < `maybe`); chỉ có ở một phía thì `maybe`. Biến lặp
   gộp theo tên: cùng vòng lặp nguồn thì giữ, khác vòng hoặc thiếu ở một phía thì `maybe`.
4. `at[node]` là phép gộp `IN(node)` qua **mọi** ngữ cảnh chạm tới node.
   - Nguồn ẩn: tới được node này từ nguồn thì là `after`, không thì `otherBranch`.
   - Node không tới được từ Bắt đầu: `reachable: false`, mọi nguồn (trừ chính nó) nằm trong `visible` với
     `certainty: "unchecked"`.
5. Giới hạn an toàn: tối đa `MAX_SCOPE_CONTEXTS = 1000` ngữ cảnh. Vượt giới hạn thì dừng, đặt `partial: true`, các node
   chưa xét coi như `unchecked`, và thêm cảnh báo "Workflow quá phức tạp…".

Cả hai cách đều có:

- `visible` sắp **gần nhất trước**: vòng lặp trong cùng và node hoặc bước ngay phía trên đứng đầu.
- Kiểm tra Lookup `ref` dùng kết quả này thay cho `isAncestor`. Kết quả là ít lỗi hơn hiện nay: Lặp{acc}, sau đó
  Lặp{con: `AccountId` random từ `acc`} trở thành hợp lệ (`last`), và lúc chạy cũng đúng là như vậy. 0003 nêu cùng kết
  luận này cho mô hình cây.

### 2. Hợp đồng `flow` và `exposes` trong danh mục node

`NODE_TYPES[].outputs` **đã là danh sách cổng ra** (canvas, schema và inspector đều đọc khóa này). Vì vậy hợp đồng biến
dùng khóa mới `exposes`, không dùng lại `outputs`. Khi 0003 bỏ cổng thì không còn khóa `outputs` nữa, nhưng vẫn giữ tên
`exposes` để không lẫn với tài liệu và file v1 cũ.

Thêm `flow` để nói rõ cổng (v1) hay slot (v2) nào chạy theo kiểu gì. Nhờ vậy `analyzeScope` dùng chung được cho mọi loại
node, kể cả node mới của 0006. `slots` của 0003 chỉ nói *có* những slot nào, không nói slot nào lặp lại, slot nào loại trừ
nhau; `flow` bổ sung phần đó.

Ví dụ dưới là danh mục v1 (vẫn còn `outputs`). Trên v2, `flow.next`/`flow.after` bỏ đi vì thứ tự trên xuống đã ngầm định,
còn `flow.body`/`flow.alternatives` trỏ tới khóa slot.

```json
{
  "type": "record",
  "outputs": [{ "port": "next", "label": "" }],
  "flow": { "kind": "sequence", "next": "next" },
  "exposes": {
    "kind": "record",
    "name": { "key": "alias", "fallback": "id" },
    "label": { "key": "sobject" },
    "visibleIn": "downstream",
    "members": "fields",
    "builtins": [{ "key": "$n", "valueType": "number", "label": "Số thứ tự bản ghi (n trong acc#n)" }],
    "current": "last",
    "pool": true,
    "origin": "generated",
    "lookupParent": true
  }
}
```

```json
{
  "type": "loop",
  "outputs": [{ "port": "body", "label": "lặp" }, { "port": "done", "label": "xong" }],
  "flow": { "kind": "loop", "body": "body", "after": "done" },
  "exposes": {
    "kind": "vars",
    "name": { "key": "alias", "default": "loop" },
    "label": "Vòng lặp",
    "visibleIn": { "inside": "body" },
    "members": [
      { "key": "index", "valueType": "number", "label": "Lần lặp hiện tại (từ 1)" },
      { "key": "index0", "valueType": "number", "label": "Lần lặp hiện tại (từ 0)" },
      { "key": "count", "valueType": "number", "label": "Tổng số lần lặp" }
    ]
  }
}
```

`branch`: `"flow": { "kind": "branch", "alternatives": ["true", "false"] }`, không có `exposes`. `start`:
`"flow": { "kind": "sequence", "next": "next" }`.

| Khóa | Giá trị | Ý nghĩa |
| --- | --- | --- |
| `flow.kind` | `sequence` (`next`), `branch` (`alternatives`), `loop` (`body`, `after`) | Cách các cổng (v1) hoặc slot (v2) chạy. Loop có thêm hàm `minIterations(config)`, không gửi qua meta. Nếu `analyzeScope` ở `shared/` thì hàm này cũng nằm ở `shared/`, vì client cũng cần |
| `exposes.kind` | `record`: `<name>.<field>` là field của bản ghi hiện tại. `vars`: `<name>.<key>` là biến rời | Bộ chọn và validate xử lý theo loại |
| `exposes.name` | `{ key, default?, fallback? }` | Tên trong đường dẫn lấy từ option nào |
| `exposes.label` | chuỗi, hoặc `{ key }` (lấy từ option, ví dụ `sobject`) | Nhãn đầu nhóm trong bộ chọn |
| `exposes.visibleIn` | `"downstream"` hoặc `{ "inside": "<khóa>" }` | Thấy ở mọi node chạy sau, hoặc chỉ bên trong `body`: chuỗi của cổng `body` (v1) hay slot `body` (v2). 0003 giữ nguyên tên `body`, `true`, `false` cho slot, nên khóa không phải đổi |
| `exposes.members` | mảng cố định; `"fields"` (từ `config.fields` dạng `{name, type}`, kiểu theo generator); `"select"` (danh sách field của câu SELECT, server dùng `selectFields(config)` của 0006; `Owner.Name` thành member `Owner` có member con `Name`); `{ "fromSource": "<optionKey>" }` (lấy member của nguồn mà option đó trỏ tới) | Danh sách biến con, cho phép lồng (`members` trong member) |
| `exposes.builtins` | mảng `{ key, valueType, label }`, key bắt đầu bằng `$` (API name của Salesforce không bao giờ có `$`) | Biến có sẵn, không phải field |
| `exposes.current` | `"last"` (bản ghi vừa sinh), `"first"` (dòng đầu của kết quả), `"picked"` (bản ghi vừa chọn) | `<name>.<field>` đọc bản ghi nào. Bộ chọn ghi chú ở đầu nhóm khi khác `last` (`dòng đầu tiên`, `bản ghi vừa chọn`) |
| `exposes.pool` | `true`/`false` | `scope.all[name]` có nghĩa: dùng được cho Lookup "Ngẫu nhiên" và làm `from` của node Chọn bản ghi |
| `exposes.origin` | `"generated"`, `"org"`, hoặc `{ "fromSource": "<optionKey>" }` | `generated`: Lookup ra `{ $ref }`, chưa có `Id`. `org`: có `Id` thật |
| `exposes.lookupParent` | `true`/`false` | Có hiện trong ô Node cha của Lookup không |
| `exposes.open` | `true`/`false` (mặc định `false`; server có thể bật theo từng node, ví dụ SOQL có `FIELDS(...)`) | `true`: danh sách field chưa chắc đầy đủ, nên field lạ chỉ là cảnh báo `openMember` |

`/api/meta` trả `nodeTypes` đã **bỏ các khóa là hàm** (`minIterations`). Khi gửi JSON thì hàm vốn đã bị bỏ, nhưng làm rõ
ra để test kiểm tra được.

Áp dụng cho node của 0006 (`query`, `pick`, khóa `from` theo đúng 0006):

```json
{ "type": "query", "flow": { "kind": "sequence", "next": "next" },
  "exposes": { "kind": "record", "name": { "key": "alias" }, "label": { "key": "sobject" }, "visibleIn": "downstream",
               "members": "select", "current": "first", "pool": true, "origin": "org", "lookupParent": true,
               "builtins": [{ "key": "$count", "valueType": "number", "label": "Số bản ghi đọc được" }] } }
{ "type": "pick", "flow": { "kind": "sequence", "next": "next" },
  "exposes": { "kind": "record", "name": { "key": "alias" }, "label": { "fromSource": "from" }, "visibleIn": "downstream",
               "members": { "fromSource": "from" }, "current": "picked", "pool": true,
               "origin": { "fromSource": "from" }, "lookupParent": true } }
```

`$count` của Query là đề xuất thêm; 0006 chưa có. Member của Query không có field type, vì `config.fields` chỉ là tên,
nên có `valueType: "any"` (nhãn "Từ org"). `Id` luôn có trong danh sách, vì 0006 luôn lấy `Id`.

### 3. Option schema, generator và `meta.syntax`

- Option có thêm khóa **`vars`**: `"template"` hoặc `"path"`. `forms.js` gắn bộ chọn theo khóa này. `schema.js` kiểm
  tra tham chiếu trong **mọi** option có `vars` (của generator và của node), không liệt kê theo tên.
  - `template.template`: `{ kind: 'string', vars: 'template', default: '{{this.$n}}' }`. Mặc định cũ là
    `{{this.LastName}} - {{loop.index}}`, xem [Câu hỏi mở](#câu-hỏi-mở--việc-tiếp-theo) số 1. Help mới:
    `Bấm {x} hoặc gõ {{ để chèn biến. Ví dụ {{this.FirstName}}, {{acc.Name}}, {{loop.index}}, {{this.$n}}.`
  - `branch.left`: `{ kind: 'string', vars: 'path' }`. Help mới: `Bấm {x} để chọn biến, ví dụ acc.Industry hoặc loop.index.`
  - `kind: 'ref'` có thêm `accepts` (không bắt buộc), ví dụ `{ "pool": true }` cho `pick.from`. Mặc định là mọi nguồn có
    `lookupParent: true`.
  - 0006 `pick.filterValue` (nhận `{{acc.Id}}`) nên khai báo `vars: 'template'` để có bộ chọn và được validate.
  - `vars` (biến trong workflow) khác `picker` của 0006 (trợ giúp lấy từ org). Một option có thể có cả hai khóa.
- Generator có thêm **`valueType`**: `string` | `number` | `boolean` | `date` | `datetime` | `time` | `reference` |
  `object` | `any` (`any` dùng cho member mà server không biết kiểu, ví dụ field của Query). Không khai báo thì là `string`.
  Ánh xạ:
  - `number`/`currency`/`percent` → `number`
  - `checkbox` → `boolean`
  - `date`/`datetime`/`time` → cùng tên
  - `lookup`/`masterdetail` → `reference`
  - `geolocation` → `object`, có thêm `members: [{ key: 'latitude', valueType: 'number' }, { key: 'longitude', valueType: 'number' }]`
  - `describeGenerators()` trả kèm `valueType` và `members`.
- `GET /api/meta` có thêm:

```json
"syntax": {
  "templateToken": "\\{\\{\\s*([\\w.$]+)\\s*\\}\\}",
  "valueTypes": [
    { "value": "string", "label": "Chuỗi" }, { "value": "number", "label": "Số" }, { "value": "boolean", "label": "Đúng/Sai" },
    { "value": "date", "label": "Ngày" }, { "value": "datetime", "label": "Ngày giờ" }, { "value": "time", "label": "Giờ" },
    { "value": "reference", "label": "Tham chiếu" }, { "value": "object", "label": "Đối tượng" }, { "value": "any", "label": "Từ org" }
  ]
}
```

  Regex token chỉ khai báo một lần, ở `server/workflow/paths.js` (`TEMPLATE_TOKEN`). Template generator, validate và
  client (dải chip, nhận biết `{{`) cùng dùng nó. Regex mới có thêm ký tự `$` so với hiện nay.

### 4. Dạng dữ liệu `scope` và issue mới (`POST /api/validate`)

Issue có thêm khóa `code`, `path`, `suggestion`, áp dụng cho cả hai thứ tự làm. Object `scope` là kết quả của
`analyzeScope`:

- 0005 làm trước: `/api/validate` trả kèm `scope`.
- 0003 làm trước: client tự gọi `shared/scope.js`, `/api/validate` không cần trả `scope`.

```json
{
  "errors": [
    { "message": "Field \"Title\": node \"acc\" (Account) không có field \"Nmae\". Ý bạn là \"Name\"? …",
      "nodeId": "con", "field": "fields.Title", "code": "unknownMember", "path": "acc.Nmae",
      "suggestion": { "option": "template", "from": "acc.Nmae", "to": "acc.Name" } }
  ],
  "warnings": [],
  "scope": {
    "partial": false,
    "sources": {
      "acc": { "nodeId": "acc", "nodeType": "record", "kind": "record", "name": "acc", "label": "Account",
               "sobject": "Account", "current": "last", "pool": true, "origin": "generated", "lookupParent": true, "open": false,
               "members": [
                 { "key": "Name", "type": "text", "valueType": "string" },
                 { "key": "Industry", "type": "picklist", "valueType": "string" },
                 { "key": "$n", "valueType": "number", "builtin": true, "label": "Số thứ tự bản ghi (n trong acc#n)", "example": "1, 2, 3…" }
               ] },
      "loopCon": { "nodeId": "loopCon", "nodeType": "loop", "kind": "vars", "name": "loop", "label": "Vòng lặp 1–4 lần",
                   "members": [{ "key": "index", "valueType": "number", "label": "Lần lặp hiện tại (từ 1)", "example": "1…4" }, "…"] }
    },
    "at": {
      "con": {
        "reachable": true,
        "self": "con",
        "visible": [
          { "source": "loopCon", "certainty": "always" },
          { "source": "acc", "certainty": "always" },
          { "source": "loopAcc", "certainty": "always" }
        ],
        "hidden": []
      },
      "acc": {
        "reachable": true, "self": "acc",
        "visible": [{ "source": "loopAcc", "certainty": "always" }],
        "hidden": [
          { "source": "con", "reason": "after", "note": "chạy sau node này" },
          { "source": "loopCon", "reason": "outsideLoop", "note": "chỉ có trong nhánh \"lặp\" của vòng lặp \"loop\"" }
        ]
      }
    },
    "refs": [
      { "nodeId": "con", "field": "fields.Title", "option": "template", "path": "acc.Industry", "source": "acc", "member": "Industry", "certainty": "always" },
      { "nodeId": "con", "field": "fields.Title", "option": "template", "path": "loop.index", "source": "loopCon", "member": "index", "certainty": "always" },
      { "nodeId": "con", "field": "fields.AccountId", "option": "ref", "path": "acc", "source": "acc", "certainty": "always" }
    ]
  }
}
```

- `sources` dùng `id` làm khóa. Mỗi field chỉ xuất hiện một lần, `at` chỉ chứa tham chiếu tới nguồn, nên kích thước
  tăng theo (số node × số nguồn) chứ không theo (số node × số field). Gửi kèm mỗi lần validate được (400 ms một lần, qua localhost).
- `note` là câu tiếng Việt do `analyzeScope` soạn, để code giao diện không phải tự viết câu cho từng lý do.
- `reachable` và `certainty: "unchecked"` chỉ có ở v1. Trên cây v2 bước nào cũng tới được; bước tắt thì không có `at`.
- Nhóm `this` trong bộ chọn do client dựng từ `node.config.fields` **hiện tại** (field phía trên ô đang sửa), kiểu lấy từ
  `meta.fieldTypes[].valueType`, để không bị trễ ngay sau khi thêm hoặc kéo field. `analyzeScope` vẫn là nơi quyết định lỗi `this*`.
- (Chỉ khi 0005 làm trước.) Khi mở bộ chọn mà còn lượt validate đang chờ debounce, client gọi validate **ngay** và vẽ lại
  danh sách khi có kết quả, giữ nguyên dòng đang chọn theo `path`.
- `/api/run` không đổi. Executor bỏ qua `scope`.

### 5. Workflow JSON

**0005 không đổi cấu trúc workflow**, ở cả `version: 1` lẫn `version: 2` của 0003 (0003 chép nguyên `config` khi chuyển,
nên chuỗi template và `left` không đổi). Tham chiếu vẫn là chuỗi `{{path}}` như trước:

```json
{ "name": "Title", "type": "template", "options": { "template": "{{acc.Industry}} contact #{{loop.index}}" } }
```

Bổ sung (tương thích ngược):

| Thay đổi | Trước | Sau |
| --- | --- | --- |
| Biến có sẵn `$n` | – | `{{this.$n}}`, `{{acc.$n}}` = `n` trong `acc#n` (đếm theo alias, từ 1). Executor truyền `n` vào ctx, `resolvePath` xử lý key bắt đầu bằng `$` |
| `left` của Branch có `{{ }}` | `"{{loop.index}}"` không bao giờ khớp | `resolvePath` bỏ `{{ }}` và khoảng trắng bao ngoài, nên `"{{loop.index}}"` giống `"loop.index"`. Bộ chọn luôn ghi dạng không ngoặc |
| Validate template và `left` | Không kiểm tra | Lỗi và cảnh báo như bảng trên |
| Validate Lookup `ref` | `isAncestor` theo cạnh nối | Theo `analyzeScope`: chấp nhận thêm node tạo trong body đã xong (`last`); `maybe` là cảnh báo |

Ảnh hưởng tới workflow đã lưu:

- Workflow có tham chiếu hỏng (gõ sai, ngoài phạm vi) giờ bị `422` khi chạy. Trước đây chúng âm thầm sinh `''`. Đây là
  thay đổi có chủ đích. Mỗi lỗi chỉ đúng field và có gợi ý sửa.
- Field Template **không lưu** `options.template` (vẫn dùng mặc định) sẽ ra dữ liệu khác vì mặc định đổi. Client lưu
  option rỗng `{}` khi đổi kiểu field, nên trường hợp này có thật.
- Hai mẫu có sẵn (`client/js/samples.js`) vẫn hợp lệ. Có test khóa điều này.
- Với v2 (0003): giữ nguyên cú pháp `{{alias.Field}}`. Khi 0003 chuyển v1 sang v2 và **nhân bản** một node (alias mới
  `con` → `con2`), `cloneSteps` của 0003 đổi theo các tham chiếu nội bộ. Hàm này cần duyệt option có `vars`/`kind: 'ref'`
  lấy từ meta, giống `renameAlias` ở mục "Đổi tên và xóa".

### 6. Tài liệu tham chiếu cần cập nhật khi làm (dự kiến)

Người viết doc này không sửa trực tiếp các file dưới đây, theo quy ước phối hợp.

- `docs/workflow-schema.md`:
  - Bảng "Đường dẫn tham chiếu": thêm `$n`, quy tắc phạm vi (chỉ thấy nguồn đã chạy trước; biến lặp chỉ trong body),
    `certainty` `always`/`last`/`maybe`.
  - `left` nhận `{{ }}`.
  - Quy tắc Lookup mới.
  - Phản hồi `/api/validate` có `scope`; issue có `code`, `path`, `suggestion`.
  - `flow`/`exposes` trong mô tả node.
- `docs/field-types.md`:
  - Template: mặc định mới và `vars`.
  - Hợp đồng generator thêm `valueType`/`members`.
  - Định dạng option thêm `vars`, `accepts`.
- `docs/architecture.md`:
  - `shared/scope.js` (hoặc `server/workflow/scope.js`, tùy thứ tự làm).
  - Client: `var-picker.js`, `variables.js`, và `validation.js` (chỉ khi 0005 làm trước).
  - Quyết định "phạm vi biến do **một** hàm thuần `analyzeScope` tính, dùng cho cả validate lẫn bộ chọn".
- `.claude/skills/add-node-type/SKILL.md`: thêm bước khai báo `flow` và `exposes`.
- `.claude/skills/add-field-type/SKILL.md`: thêm bước khai báo `valueType`.
- `docs/design/README.md`: thêm dòng 0005 với trạng thái `Nháp`. Người điều phối thêm.

## Checklist tiện dụng

- [x] 1. Chạy được ngay với mặc định. Field Template mới mặc định `{{this.$n}}`, hợp lệ ở mọi nơi, ra `1, 2, 3…`. Node
  Rẽ nhánh mặc định vẫn là `chance`. Khi chuyển sang `compare`, `left = loop.index` dùng được ngay trong vòng lặp; ngoài
  vòng lặp thì báo lỗi `outsideLoop` kèm cách sửa (người dùng lúc đó đang cấu hình, không phải lần chạy đầu).
- [x] 2. Ít thao tác cho việc hay làm. Chèn một biến mất 2–3 thao tác (nút {x} hoặc `{{`, gõ vài chữ, Enter), không phải
  mở node khác. Có Ctrl+Space; dùng được hoàn toàn bằng bàn phím.
- [x] 3. Xem trước trước khi ghi. Tính năng không ghi gì vào org; luồng insert giữ nguyên. Giá trị mẫu và dòng "Lần xem
  trước" khuyến khích xem trước.
- [x] 4. Lỗi chỉ đúng chỗ và nói cách sửa. Issue có `nodeId`, `field`, `path`, `code`. Chip đỏ đúng token. Có "Ý bạn
  là…" và nút sửa một chạm. Bấm lỗi thì tự mở card field.
- [x] 5. Không mất công sức. Đổi tên field, alias, biến lặp thì tham chiếu đi theo; đổi biến lặp chỉ đổi đúng phạm vi.
  Xóa thứ đang được dùng thì có toast liệt kê chỗ hỏng. Mỗi lần chèn hoặc sửa là một bước undo.
- [x] 6. Lấy thông tin từ org thay vì bắt gõ. Danh sách field và kiểu lấy từ workflow, vốn import từ describe. Không cần
  gọi org khi mở bộ chọn. (Lọc node cha theo `referenceTo` của describe: xem Câu hỏi mở số 5.)
- [x] 7. Một nguồn sự thật. Phạm vi do **một** hàm `analyzeScope` tính (ở server, hoặc ở `shared/` nếu 0003 làm trước),
  và cũng thay `availableAt` của 0003. Regex token, `valueType` và nhãn khai báo ở server, gửi qua meta. UI bật bộ chọn
  theo `vars` và `kind: 'ref'`. Node mới (0006) chỉ cần khai báo `flow`/`exposes`. Ngoại lệ có chủ đích: nhóm `this`
  dựng ở client từ thứ tự field hiện tại, vì quy tắc chỉ là "field phía trên"; `analyzeScope` vẫn quyết định lỗi.
- [x] 8. Giải thích tại chỗ. Help mới cho `template` và `left`. Dòng xám "Không dùng được ở đây" ghi lý do. Badge `bản
  ghi cuối`/`có thể trống` có tooltip. Có câu hướng dẫn khi bộ chọn trống.
- [x] 9. An toàn khi lỡ tay. Phân tích có trần `MAX_SCOPE_CONTEXTS`. Danh sách mỗi nhóm tối đa 200 dòng. Escape regex khi
  đổi tên (sửa lỗi ném exception hiện có). Option `vars` không bao giờ được `eval`.

## Phương án đã cân nhắc

| Phương án | Ưu | Nhược | Chọn? |
| --- | --- | --- | --- |
| **Một hàm thuần `analyzeScope(wf, catalog)`, đặt ở `shared/` khi 0003 đã có thư mục này** | Bộ chọn mở tức thì, không trễ; validate và bộ chọn dùng đúng một code; khớp hướng `shared/` của 0003 | Phải test chạy được trên cả Node lẫn trình duyệt (0003 đã có cùng yêu cầu) | **Có**, nếu 0003 làm trước |
| **Cùng hàm đó đặt ở server (`server/workflow/scope.js`), gửi kèm `/api/validate`** | Không cần thư mục `shared/`; một chỗ tính cho cả lỗi lẫn bộ chọn | Dữ liệu có thể trễ ≤ 400 ms; khắc phục bằng cách validate ngay khi mở bộ chọn | **Có**, nếu 0005 làm trước |
| `POST /api/scope` riêng, gọi mỗi lần mở bộ chọn | Dữ liệu luôn mới | Phân tích hai lần (validate và scope); trễ mỗi lần mở; thêm một endpoint | Không |
| Để `availableAt` (0003) và `analyzeScope` (0005) là hai hàm riêng | Mỗi doc tự làm phần của mình | Hai định nghĩa "phía trước" sẽ lệch nhau (đúng loại lỗi `isAncestor` đang có) | Không: `availableAt` là phần chiếu của `analyzeScope` |
| **Giữ chuỗi `{{alias.Field}}` trong JSON** | Tương thích v1, đọc và sửa tay được, executor không đổi; đổi tên đã có cơ chế cập nhật | Đổi tên phải sửa chuỗi (đã xử lý ở client và được validate kiểm lại) | **Có** |
| Token có cấu trúc `{ "$var": { "node": "<id>", "path": [...] } }` hoặc `{{#<nodeId>.Name}}` | Không hỏng khi đổi tên | Phá v1, cần migration; JSON khó đọc; executor, validate, CSV và docs đều phải đổi | Không |
| **Ô chữ thô và dải chip bên dưới** | Copy/paste, undo gốc và bộ gõ tiếng Việt (Telex/VNI qua IME) đều ổn; chip cho dễ đọc và chỉ đúng lỗi | Chip nằm ngoài ô, không ở ngay giữa chữ | **Có** |
| Chip nằm trong ô (contenteditable, kiểu Power Automate) | Nhìn đẹp nhất | Dễ lỗi con trỏ khi gõ IME quanh phần tử không sửa được; mất undo gốc; xử lý paste phức tạp | Không |
| Trình soạn code (CodeMirror) có tô màu | Tô màu và autocomplete có sẵn | Thêm dependency, trái ràng buộc stack | Không |
| **Mở bằng nút {x}, gõ `{{`, Ctrl+Space** | Dễ thấy (nút) và nhanh (bàn phím) | ⌃Space trên macOS thường đã bị chiếm | **Có** |
| Mở bằng `@` | Quen thuộc từ chat | Đụng với email trong template | Không |
| **Tham chiếu hỏng là lỗi** | Không còn chuyện âm thầm ra `''`, đúng yêu cầu | Workflow cũ có tham chiếu hỏng bị chặn chạy tới khi sửa | **Có** |
| Tham chiếu hỏng chỉ là cảnh báo | Workflow cũ vẫn chạy | Dễ bỏ qua, insert dữ liệu rỗng vào org | Không |
| **Khóa mới `exposes` + `flow`** | Không đụng `outputs` (cổng) mà canvas, schema và skill đang dùng | Tên khác với chữ "outputs" trong yêu cầu | **Có** |
| Đổi `outputs` (cổng) thành `ports`, dùng `outputs` cho biến | Khớp tên với yêu cầu | Phải sửa canvas, schema, inspector, test và skill; không được thêm gì | Không |
| **Mặc định template `{{this.$n}}` và biến `$n`** | Hợp lệ ở mọi nơi; `$n` còn giúp đánh số bản ghi khi không có vòng lặp ("Contact 1…50" với Số bản ghi = 50) | Thêm một biến có sẵn; field Template cũ không lưu `template` sẽ ra dữ liệu khác | **Có** (cần người dùng duyệt) |
| Mặc định template rỗng, tự mở bộ chọn khi đổi kiểu | Không thêm cú pháp | Giá trị rỗng không "hợp lý" (nguyên tắc 1); field bắt buộc sẽ lỗi khi insert | Không |
| Giữ mặc định cũ | Không đổi dữ liệu cũ | Field mới báo lỗi ngay khi không nằm trong vòng lặp hoặc không có `LastName` phía trên (vi phạm nguyên tắc 1) | Không |
| **Node cha Lookup: `<select>` gốc dựng từ scope** | Ít code, có sẵn bàn phím và trợ năng | Không có màu node | **Có** |
| Node cha Lookup dùng chung popup bộ chọn | Nhìn thống nhất | Quá nặng cho việc chọn một trong vài mục | Không |

## Kế hoạch thực hiện

Theo bảng contract-sync trong `.claude/agents/implementer.md`. Mỗi bước để `npm test` xanh.

1. **Hợp đồng danh mục (chưa đổi hành vi).**
   - `server/workflow/nodes.js`: `flow`, `exposes`, hàm `minIterations` cho loop, `vars: 'path'` cho `left`.
   - `server/workflow/paths.js`: export `TEMPLATE_TOKEN`.
   - `server/generators/*.js`: `valueType`; `members` cho geolocation. `misc.js`: `vars: 'template'` cho option `template`.
   - `server/generators/index.js`: `describeGenerators` trả thêm `valueType`/`members`.
   - `server/index.js`: `/api/meta` thêm `syntax`, và bỏ các khóa là hàm khỏi `nodeTypes`.
   - Test:
     - `test/server.test.js` mở rộng 'GET /api/meta lists field and node types': mọi node có `flow`; record và loop có
       `exposes`; không có khóa hàm; `new RegExp(meta.syntax.templateToken)` dựng được.
     - `test/generators.test.js` thêm 'every generator declares a known valueType'.
2. **`analyzeScope`.**
   - File: `shared/scope.js` nếu bước 1–3 của 0003 đã xong; nếu chưa thì `server/workflow/scope.js`.
   - Gồm `buildSources(wf, catalog)`, `analyzeScope(wf, catalog)` → `{ partial, sources, at, refs }`.
   - Khi ở `shared/`: `availableAt()` của 0003 gọi lại hàm này.
   - Test trong `test/scope.test.js` (mới). Các test chung cho cả cây lẫn đồ thị:
     - 'scope: upstream record and enclosing loop vars are visible in the loop body'
     - 'scope: record created in one branch is maybe after the branch; the other branch sees it as otherBranch'
     - 'scope: record created in a finished loop body is last; maybe when the loop can run 0 times'
     - 'scope: loop var after the loop is hidden as outsideLoop'
     - 'scope: nested loops with the same alias, inner shadows outer'
     - 'scope: query and pick sources expose select fields and fromSource members' (khi 0006 đã có)
   - Chỉ cho đồ thị v1:
     - 'scope: node reachable inside and outside a loop sees the loop var as maybe'
     - 'scope: unreachable node gets unchecked sources'
     - 'scope: context cap sets partial instead of hanging'
   - Chỉ cho cây v2: 'scope: disabled step is hidden as disabled and its own references are not checked'.
3. **Validate theo scope.** `server/workflow/schema.js`:
   - Kiểm tra mọi option có `vars`, và `kind: 'ref'` thay cho `isAncestor`.
   - Message theo bảng ở trên; `code`, `path`, `suggestion`. Validate trả thêm `scope`.
   - Test trong `test/workflow.test.js`:
     - Test 'validation: lookup must point at an upstream record node' hiện có vẫn qua.
     - Thêm 'validation: lookup to a record from a finished loop body is allowed'
     - Thêm 'validation: unknown variable and misspelt field are errors with a suggestion'
     - Thêm 'validation: loop var outside its body is an error on the right field'
     - Thêm 'validation: this.* below the current field is an error'
     - Thêm 'validation: maybe-defined source is a warning; masterdetail wording'
     - Thêm 'validation: unreachable nodes only get static reference checks'
     - Thêm 'built-in samples validate without errors' (import `../client/js/samples.js`)
4. **Lúc chạy.**
   - `paths.js`: key `$n`, bỏ `{{ }}` bao ngoài `left`.
   - `executor.js`: truyền `{ n }` của bản ghi đang tạo vào ctx; `acc.$n` lấy từ `ref`.
   - `misc.js`: dùng `TEMPLATE_TOKEN`, mặc định `{{this.$n}}` (chờ duyệt Câu hỏi mở số 1).
   - Test:
     - 'template: {{this.$n}} and {{acc.$n}} follow alias#n'
     - 'branch: left accepts {{loop.index}}'
     - 'every generator produces a value with default options' vẫn qua.
5. **API** (chỉ khi `analyzeScope` ở server). `/api/validate` trả `scope`. Test 'POST /api/validate returns scope with
   visible sources per node' trong `test/server.test.js`.
6. **Dữ liệu ở client.**
   - `client/js/store.js`: `state.scope`. Khi ở `shared/` thì tính lại mỗi lần sự kiện `workflow` xảy ra (cùng nhịp với
     validate) bằng `analyzeScope(state.workflow, state.meta)`. Nếu không thì lấy từ kết quả validate.
   - Chỉ khi ở server: `client/js/validation.js` (mới) chuyển `validateNow`/`setIssues` ra khỏi `main.js` để tránh import
     vòng, và thêm `flushValidation()`.
   - `client/js/variables.js` (mới):
     - `tokenize(text)` dùng `meta.syntax.templateToken`
     - `groupsFor(nodeId, fieldIndex, mode)`
     - `sampleFor(nodeId, key)`, với Map dựng lại theo sự kiện `result`
     - `formatSample(v)`
     - `refsTo(sourceId, member?)`
   - Kiểm tra: smoke test hiện có vẫn qua.
7. **Bộ chọn.**
   - `client/js/var-picker.js` (mới): popup, tìm kiếm, phím tắt, ARIA, chèn bằng `execCommand('insertText')`, dải chip.
   - `client/css/app.css`: `.var-input`, `.var-picker`, `.var-chip` (sáng và tối, dùng màu `--node-*`).
   - `client/js/forms.js`: gắn bộ chọn cho option có `vars`; dựng `kind: 'ref'` từ scope.
   - `client/js/inspector.js`: truyền ctx `{ nodeId, fieldIndex }` vào `renderOptions` (cả option của node); Import từ org
     tự chọn node cha theo nguồn dùng được.
   - Kiểm tra: mở rộng `.claude/skills/smoke-test/smoke.cjs`:
     - mở mẫu, chọn `con`, mở card `Title`
     - bấm {x}, gõ `indu`, Enter, rồi kiểm tra ô chứa `{{acc.Industry}}`
     - gõ `{{` thì popup hiện
     - không có lỗi trang
8. **Đổi tên và xóa.** `client/js/inspector.js`. Riêng `renameAlias` nằm ở `shared/workflow-tree.js` nếu 0003 đã chuyển nó sang đó.
   - `renameAlias`: escape regex, duyệt option có `vars` và `kind: 'ref'`, đổi biến lặp theo `scope.refs`.
   - Đổi tên field khi `change`.
   - Toast khi xóa field hoặc node đang được dùng.
   - Bấm lỗi thì tự mở card.
   - Nút "Sửa thành…".
   - Kiểm tra:
     - Thêm vào smoke test: đổi `Industry` thành `Industry__c` ở `acc`, rồi kiểm tra Title của `con` đổi theo.
     - Thử tay: hai vòng lặp cùng tên `loop`, đổi tên một vòng, rồi kiểm tra vòng kia không bị đổi.
9. **Docs.**
   - Cập nhật các file ở mục 6 và bỏ chữ "(dự kiến)".
   - Điền phần "Đã làm".
   - Đổi trạng thái trong `docs/design/README.md`.

## Câu hỏi mở / Việc tiếp theo

**Cần người dùng quyết định:**

1. **Mặc định của Template và biến `$n`.** Đề xuất mặc định `{{this.$n}}` và thêm `$n` (`{{this.$n}}`, `{{acc.$n}}`).
   Field Template cũ không lưu `options.template` sẽ ra dữ liệu khác. Phương án khác: mặc định rỗng và tự mở bộ chọn.
   Phương án này không đạt nguyên tắc 1 trọn vẹn.
2. **Mức độ của tham chiếu hỏng.** Đề xuất là **lỗi** (chặn Xem trước và Insert cho tới khi sửa). Nếu muốn workflow cũ
   vẫn chạy được ngay, có thể để là cảnh báo trong một phiên bản rồi mới nâng thành lỗi.
3. **`right` của Branch nhận biến** (`acc.AnnualRevenue > {{opp.Amount}}`)? Chỉ cần thêm `vars: 'template'` cho `right`
   và render template trước khi so sánh. Đổi ngữ nghĩa với giá trị cũ có chứa `{{`; trường hợp này hiếm.
4. **Option số nhận biến** (Số lần lặp = `{{acc.NumberOfEmployees__c}}`)? Cần `vars: 'number'`, kiểm tra `valueType`,
   kẹp theo `LIMITS` lúc chạy. Nên làm thành một design riêng.
5. **Lưu `referenceTo` từ describe vào option của Lookup** để dropdown Node cha chỉ hiện nguồn đúng sObject và cảnh báo
   khi chọn sai sObject? Cần thêm một option (ẩn) vào generator Lookup.
6. **Tự đặt tên biến lặp không trùng** (`loop`, `loop2`…) khi thêm node Lặp, để vòng lồng nhau không che nhau như hiện
   nay. 0003 đã đề xuất việc này cho chế độ Quy trình. Nếu 0003 không được duyệt thì làm trong `addNode` của `canvas.js`.
7. **Phím tắt:** giữ Ctrl+Space (quen thuộc, nhưng bị chiếm trên macOS) hay đổi sang phím khác?
8. **Template dùng field mà Query không lấy.** 0006 để là *cảnh báo*. 0005 đề xuất *lỗi* `unknownMember` khi danh sách
   field đã biết chính xác (chế độ builder, hoặc SOQL parse được), vì lúc chạy giá trị chắc chắn rỗng, giống field gõ sai
   ở node Record. Chỉ còn là cảnh báo `openMember` khi danh sách chưa đầy đủ (`FIELDS(...)`). Lời sửa dùng câu của 0006.
   Cần thống nhất một mức.
9. **Thứ tự làm với 0003.** Đề xuất làm bước 1–3 của 0003 (định dạng v2, `shared/`) **trước**, giống 0003 đề xuất. Khi đó:
   - `analyzeScope` chạy trên cây, đơn giản hơn nhiều so với thuật toán ngữ cảnh trên đồ thị.
   - Nó nằm ở `shared/`, nên bộ chọn không bị trễ.
   - Không cần `scope` trong `/api/validate`, cũng không cần `validation.js`.

   Nếu cần bộ chọn sớm hơn thì làm 0005 trên v1. Phần thuật toán đồ thị (bước 2) sẽ bị viết lại khi 0003 vào; phần còn
   lại (dạng `scope`, bộ chọn, validate, đổi tên) giữ nguyên.

**Phụ thuộc và giả định với các design khác:**

- **0003 (chế độ Quy trình, JSON v2 dạng cây).** Đã đối chiếu với bản nháp `0003-process-mode.md`:
  - Hai bên khớp nhau ở các điểm: id bước giữ nguyên khi chuyển v1 sang v2; inspector và `forms.js` là nơi sửa cấu hình
    duy nhất ở cả hai chế độ, nên bộ chọn biến tự có ở đó; `{{alias.Field}}` giữ nguyên; 0003 tự đặt tên biến lặp `loop2`.
  - **`availableAt()` của 0003 và `analyzeScope` của 0005 là cùng một phân tích.** Đề xuất chỉ có `analyzeScope`, còn
    `availableAt` là phần chiếu của nó. `certainty` dùng tên của 0003 (`always`/`maybe`/`disabled`) và thêm `last`.
    Câu lỗi Lookup dùng câu của 0003 (`after`, `otherBranch`, `disabled`).
  - **`slots` của 0003 cần thêm ngữ nghĩa.** Đó là `flow` của 0005: `body` lặp lại, `true`/`false` loại trừ nhau, và
    `minIterations`. Nhờ vậy `shared/scope.js` không hard-code `loop`/`branch`. Hiện 0003 suy luận `always` từ
    `fixed`/`range`; phần đó chuyển thành hàm `minIterations` của loại bước Lặp.
  - **`outputs`:** 0003 bỏ cổng và giải phóng tên `outputs`. 0005 vẫn dùng `exposes` (không phụ thuộc thứ tự làm).
  - `renameAlias` và `cloneSteps` (chuyển sang `shared/workflow-tree.js` trong 0003) cần duyệt option có `vars`/`kind: 'ref'`
    lấy từ meta, và escape regex.
  - Bước tắt (`disabled`) của 0003: không kiểm tra tham chiếu bên trong; nguồn tắt là ẩn `disabled`.
  - `maybe` của biến lặp kiểu v1 (node chạy cả trong lẫn ngoài body) không còn trên cây. 0003 xử lý trường hợp này bằng
    cách nhân bản khi chuyển đổi.
- **0004 (chạy dạng stream).** Đã đối chiếu với bản nháp `0004-streaming-execution.md`:
  - Không xung đột với `/api/run`. 0005 chỉ đọc kết quả chạy, không thêm khóa nào.
  - **Cần thêm từ 0004:** ở chế độ NDJSON, `done.result.records` chỉ có 200 dòng đầu **mỗi sObject**. Nếu hai node cùng
    sObject (ví dụ hai node Account), bản ghi đầu của node thứ hai có thể không nằm trong 200 dòng đó, nên bộ chọn và dòng
    "Lần xem trước" sẽ không có giá trị mẫu. Đề xuất 0004 luôn đưa thêm bản ghi đầu tiên của mỗi `nodeId` vào dòng xem
    trước, hoặc thêm `samples: { "<nodeId>": { ...fields } }` vào `done.result`. Nếu không có thì bộ chọn hiện `—`.
  - 0004 bỏ field trong pool của alias Record (chỉ giữ `length`/`refAt`). 0005 chỉ đọc field của **bản ghi hiện tại**
    (`scope.current`, vẫn giữ), còn `$n` lấy từ `ref`, nên không bị ảnh hưởng. `pool: true` trong `exposes` chỉ có nghĩa
    là "dùng được cho Lookup Ngẫu nhiên và `pick.from`".
  - Validate và `analyzeScope` không phụ thuộc vào cách chạy.
- **0006 (Query `query`, Chọn bản ghi `pick`).** Đã đối chiếu với bản nháp `0006-query-pick-nodes.md`:
  - Khai báo `flow`/`exposes` như mục 2:
    - `query`: `members: "select"`, `current: "first"` (đúng ngữ nghĩa `{{accs.Name}}` = dòng đầu của 0006), `origin: "org"`.
    - `pick`: `members`/`origin`/`label` lấy theo `{ fromSource: "from" }`, `current: "picked"`.
  - `analyzeScope` vẫn thuần. Member của Query lấy từ `selectFields(config)` (`server/workflow/soql.js` của 0006). Kiểu
    là `any`, vì `config.fields` chỉ lưu tên. Không parse được hết SELECT thì `open: true`. Nếu `analyzeScope` ở `shared/`
    thì `selectFields` cũng phải đặt ở `shared/`. Nó vốn là hàm thuần nên chỉ cần chuyển file.
  - **Trùng lặp với `derived` của 0006:**
    - `scope.sources[nodeId]` đã có `sobject`, danh sách field (`members`), và nguồn của `pick` (`fromSource`). Đề xuất
      0006 đọc `poolFields`/nhãn pool từ `scope.sources`.
    - `derived` chỉ giữ phần riêng của Query (`soql`).
    - Làm trước thì cái nào cũng được: nếu 0006 xong trước, 0005 chuyển `derived.fields` sang `scope.sources` trong cùng thay đổi.
  - **Ô `ref`:** 0006 đề xuất `poolAliases()` ở client; 0005 dựng ô này từ `scope.at` (chỉ nguồn chạy trước, có trạng thái).
    Nếu 0005 xong trước thì 0006 không cần `poolAliases()`.
  - **Đổi alias:** 0006 thêm cập nhật `from` và `filterValue`. Với 0005, việc này tự có, vì `renameAlias` duyệt mọi option
    `kind: 'ref'` và mọi option có `vars`. Điều kiện: `pick.filterValue` khai báo `vars: 'template'`.
  - **Cảnh báo "Template dùng field không lấy" và "Pool không ở phía trước"** của 0006 nên dùng chung phân tích của
    `analyzeScope` (mã `unknownMember`/`after`/`otherBranch`) thay vì kiểm tra riêng. Mức lỗi: Câu hỏi mở số 8.
  - **`{{acc.Id}}`:** có với nguồn `origin: "org"`. Với bản ghi sinh ra thì là lỗi `noIdYet`.
  - Lookup tới nguồn `origin: "org"` sinh Id thật (0006 làm, qua cờ `existing`).
  - **Giá trị mẫu** của member Query lấy từ `queries[].records[0]` trong kết quả `/api/run` (0006). Với `pick` thì lấy từ
    bản ghi pool mà lần chạy đã chọn, nếu 0006 đưa nó vào kết quả. Nếu không có thì hiện `—`.

**Ý tưởng để sau:** hàm trong template; `{{acc.Id}}` thành Id thật lúc insert (cần thay token trong chuỗi ở
`server/sf/insert.js`); biến cấp workflow (`{{run.today}}`, `{{run.seed}}`); đi xuyên Lookup (`{{con.AccountId.Name}}`);
nút "Biến" trên thẻ node của canvas để xem node đó cung cấp gì.

## Đã làm

(Cập nhật khi code xong: commit hoặc PR, chỗ nào khác với thiết kế và vì sao.)
