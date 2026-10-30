# 0013 — Mở rộng biến và vòng lặp

- **Trạng thái:** Đã duyệt (2026-10-28; người dùng giao chọn theo đề xuất cho mọi quyết định, xem [Đã chốt](#đã-chốt-2026-10-28))
- **Ngày:** 2026-10-28
- **Liên quan:** [0004](0004-streaming-execution.md) (executor dạng luồng, pool chỉ đếm, hash vàng),
  [0005](0005-variable-picker.md) (`analyzeScope`, `vars`, `valueType`; Câu hỏi mở 3 và 4; "Ý tưởng để sau"),
  [0006](0006-query-pick-nodes.md) (Query đọc trước, Chọn bản ghi; Câu hỏi mở 9), [0010](0010-lap-theo-ban-ghi.md) (Lặp `each`;
  "Câu hỏi mở / Việc tiếp theo"), [workflow-schema.md](../workflow-schema.md), [architecture.md](../architecture.md)

Doc này gom các việc còn treo về **biến** và **vòng lặp** từ 0005, 0006, 0010 và các mục được chuyển sang sau đợt dọn tài liệu.
Mỗi mục được chốt là **làm trong doc này** hoặc **để sau / không làm** kèm lý do (bảng [Đã chốt](#đã-chốt-2026-10-28)).

## Vấn đề

Người dùng đã dựng được "mỗi Account có sẵn tạo 3 Contact" (0010), nhưng vẫn vấp ở những chỗ sau:

1. **So sánh hai biến.** Rẽ nhánh "Opportunity lớn hơn doanh thu của Account" phải viết `acc.AnnualRevenue` > `{{opp.Amount}}`,
   nhưng ô "So với" chỉ nhận giá trị cố định: `{{opp.Amount}}` bị so như một chuỗi chữ, nhánh Đúng không bao giờ chạy.
2. **Số lần lặp theo dữ liệu.** "Mỗi Account tạo số Contact bằng `NumberOfEmployees__c`" hay "lặp `{{accs.$count}}` lần" không làm
   được: ô "Số lần lặp" là ô số.
3. **Lặp qua bản ghi con có sẵn.** "Mỗi Account → mỗi Contact có sẵn của Account đó → tạo Task" cần lọc pool Contact theo
   `AccountId = {{acc.Id}}` ngay trong Lặp; hôm nay chỉ Chọn bản ghi có lọc, và nó chọn **một** bản ghi chứ không lặp hết.
   Pool lớn (2 000 Contact) cũng không có cách "chỉ 3 bản ghi ngẫu nhiên" hay "10 bản ghi đầu".
4. **Cảnh báo thừa.** `Record acc ×5` rồi Lặp `each` qua `acc` luôn chạy ≥ 1 lần, nhưng mọi Lookup phía sau tới bản ghi tạo trong
   vòng lặp vẫn bị cảnh báo "có thể chạy 0 lần".
5. **Lặp theo danh sách giá trị.** "Một Lead cho mỗi Rating Hot / Warm / Cold" phải dựng 3 bước Record gần như giống nhau.
6. **Chọn có trọng số.** "Opportunity rơi vào Account lớn nhiều hơn" (chọn theo `NumberOfEmployees`) không làm được.
7. **Giá trị mẫu thiếu.** Với chạy dạng luồng, kết quả chỉ có 200 dòng đầu mỗi sObject; bước Record thứ hai cùng sObject (Account
   cha và Account con) thường không có giá trị mẫu trong bảng chọn biến (`—`).
8. **Biến của lần chạy.** Muốn ghi `Batch {{run.seed}}` vào Description để sau này tìm và xóa đúng lô dữ liệu test, hoặc
   `{{run.today}}` vào tên, nhưng không có biến nào như vậy.

## Mục tiêu / Ngoài phạm vi

- Mục tiêu (làm trong doc này):
  - **A.** `right` của Rẽ nhánh nhận biến (`{{opp.Amount}}`), tương thích với giá trị cũ.
  - **B.** Option số của Lặp (`count`, `min`, `max`) nhận **một** biến kiểu số (`vars: 'number'`), kẹp theo `LIMITS` khi chạy.
  - **C.** Lặp `each` có thêm: lọc (`filter`/`filterField`/`filterOp`/`filterValue`, như Chọn bản ghi), thứ tự `order: 'shuffle'`
    theo seed, `limit` ("tối đa N bản ghi"), và `minIterations` biết pool Record luôn có bản ghi.
  - **D.** Lặp theo danh sách giá trị cố định (`mode: 'values'`, `{{loop.value}}`).
  - **E.** Chọn bản ghi theo trọng số (`mode: 'weighted'`, `weightField`).
  - **F.** `samples` theo bước cho mọi bước Record (giá trị mẫu của bảng chọn biến), và dòng Query mẫu cho ra số ở field dùng làm số.
  - **G.** Biến của lần chạy `{{run.seed}}`, `{{run.now}}`, `{{run.today}}`.
- Ngoài phạm vi (lý do ở [Đã chốt](#đã-chốt-2026-10-28)): `count` của Record nhận biến; option số của generator (Number min/max,
  Date from/to) nhận biến; phạm vi pool "chỉ bản ghi của lượt hiện tại"; Chọn N bản ghi một lần; hàm trong template; đi xuyên
  Lookup `{{con.AccountId.Name}}`; `{{acc.Id}}` thành Id thật khi insert; bước "Đặt biến"; Query chạy lại mỗi lần lặp; bước
  Switch N nhánh. `pick.filterValue` **đã** nhận biến (`vars: 'template'` trong `server/workflow/nodes.js`) nên không có việc gì
  ở đó; "filterValue nhận biến" trong doc này là ô lọc **mới** của Lặp `each`.
- Không tăng `version` của workflow JSON; mọi thay đổi là **thêm khóa / thêm giá trị**.

## Luồng người dùng

Số trong ngoặc là số thao tác (bấm, chọn, hoặc một lần gõ).

### Luồng chính: "Mỗi Account có sẵn → mỗi Contact có sẵn của nó → một Task"

Đang có: Query `accs` (Account) và Lặp `each` qua `accs` → `acc` (luồng chính của 0010).

1. Bấm "+" ngay dưới Query `accs`, chọn **Query** (2). Gõ `Contact` ở sObject (1); alias tự gợi ý `cons`.
2. Bấm **Chọn field…**, tích `AccountId`, OK (3). (Bỏ qua nếu dùng preset sau này.)
3. Trong thân Lặp `acc`, bấm "+", chọn **Lặp** (2). Đổi "Lặp theo" → **Mỗi bản ghi trong pool** (1): `from` tự điền pool gần nhất
   dùng được là `cons`, `itemAlias` = `con` (luật 0010).
4. Đổi "Lọc" → **Chỉ bản ghi thỏa điều kiện** (1). Inspector **tự điền** `AccountId` = `{{acc.Id}}` (luật "điều kiện cha–con",
   [Thiết kế UI](#tự-điền-điều-kiện-cha–con)); không phải gõ gì.
5. Trong thân Lặp `con`, bấm "+", chọn **Record** (2), sObject `Task` (1), Import field từ org hoặc thêm `WhoId`/`WhatId` Lookup
   (Import tự chọn bản ghi đang lặp gần nhất khớp `referenceTo`, 0010).
6. Ctrl+Enter (1): xem trước không org dùng 5 Account mẫu × Contact mẫu; chip `n lần lặp` trên từng Lặp.

Tổng ≈ 14 thao tác cho một workflow ba tầng có lọc; phần mới của doc này chỉ là bước 4 (**1 thao tác**). Không có tự điền thì bước 4
tốn 5 thao tác (chọn field, phép so sánh, bấm {x}, chọn `acc.Id`).

### Luồng phụ

- **Số lần lặp theo biến** (trong Lặp `fixed` nằm trong thân Lặp `acc`): bấm `{x}` cạnh "Số lần lặp" (1), chọn
  `acc.NumberOfEmployees__c` (1). **2 thao tác.** Thẻ: `{{acc.NumberOfEmployees__c}} lần · {{loop.index}}`.
- **3 Contact ngẫu nhiên không trùng của pool:** Lặp `each` qua `cons` → "Thứ tự" = **Xáo trộn (theo seed)** (1), "Tối đa số bản ghi"
  = 3 (1). **2 thao tác.** (Đây cũng là cách "Chọn N bản ghi một lần".)
- **Một Lead cho mỗi Rating:** thêm Lặp (2), "Lặp theo" → **Mỗi giá trị trong danh sách** (1), gõ `Hot⏎Warm⏎Cold` (1); thêm Record
  Lead trong thân (2); field `Rating` đổi kiểu sang "Lấy từ biến (giữ kiểu)" (1), bấm `{x}` → `loop.value` (2). **9 thao tác.**
- **Rẽ nhánh so hai biến:** "Giá trị" = `acc.AnnualRevenue` (đã có), "Phép so sánh" `>`, bấm `{x}` cạnh "So với" (1), chọn
  `opp.Amount` (1). **2 thao tác** cho phần mới.
- **Chọn theo trọng số:** ở Chọn bản ghi, "Cách chọn" → **Ngẫu nhiên theo trọng số (field số)** (1), "Field trọng số" chọn từ gợi ý
  (1). **2 thao tác.**
- **Đánh dấu lô dữ liệu:** field `Description` kiểu Template, bấm `{x}` (1), nhóm **Lần chạy** → `run.seed` (1). **2 thao tác.**

### Trường hợp lỗi

- Gõ `{{acc.Name}}` vào "Số lần lặp" → lỗi gắn `count`: `"Số lần lặp": {{acc.Name}} là Chuỗi…` (mức cảnh báo, xem bảng); chọn
  `acc.CloseDate` → **lỗi** "là Ngày, không phải số". Gõ `{{acc.X}} lần` → lỗi định dạng "bỏ phần chữ quanh biến".
- Dùng `{{con.Id}}` (bản ghi đang lặp của chính vòng lặp) trong "So với" của ô lọc → lỗi `ownLoop`, nói ô lọc được tính trước
  lần lặp đầu.
- `NumberOfEmployees__c` trống ở 12 Account → các lượt đó lặp 0 lần; cuối lần chạy **một** cảnh báo `12/200 lần…`.
- Lọc không khớp bản ghi nào ở **mọi** lượt (ví dụ quên thêm `AccountId` vào Query) → **một** cảnh báo `eachFilterEmpty`.
- Danh sách giá trị rỗng → lỗi gắn `values`.

## Thiết kế UI

Không thêm code UI riêng cho từng loại bước: mọi ô mới đến từ option schema trong `/api/meta`. Phần client mới là **chung**:
ô số nhận biến (`vars: 'number'`), `showIf` bắc cầu, placeholder cho ô danh sách, và luật tự điền điều kiện cha–con.

### Inspector — bước Lặp

Thứ tự option: `mode`, `count`, `min`, `max`, `values`, `from`, `itemAlias`, `filter`, `filterField`, `filterOp`, `filterValue`,
`order`, `limit`, `alias`.

```
● Lặp                                                      ⊘  ⧉  ✕
Lặp theo              [Mỗi bản ghi trong pool ▾]
Lặp qua pool          [cons (Contact · đọc từ org) ▾]
Tên bản ghi đang lặp  [con]
Lọc                   [Chỉ bản ghi thỏa điều kiện ▾]
Field                 [AccountId          ]   (gợi ý: field của pool cons)
Phép so sánh          [= ▾]
So với                [{{acc.Id}}         ] {x}
                      ‹acc.Id›
                      Giá trị cố định, hoặc {{acc.Id}} để chỉ lấy bản ghi con của bản ghi đang lặp ở vòng ngoài. Tính một lần khi vòng lặp bắt đầu.
Thứ tự                [Theo thứ tự của pool ▾]
Tối đa số bản ghi     [0      ]
                      0 = tất cả. Áp dụng sau khi lọc và xáo trộn.
Tên biến lặp          [loop2]
```

```
Lặp theo              [Số lần cố định ▾]
Số lần lặp            [{{acc.NumberOfEmployees__c}}  ] {x}
                      ‹acc.NumberOfEmployees__c›
                      Số nguyên 0–100000, hoặc bấm {x} để lấy từ biến kiểu Số, ví dụ {{acc.NumberOfEmployees}} hay {{accs.$count}}.
```

```
Lặp theo              [Mỗi giá trị trong danh sách ▾]
Danh sách giá trị     [Hot                ]
                      [Warm               ]
                      [Cold               ]
                      Mỗi dòng một giá trị. Bên trong dùng {{loop.value}}; với field Picklist chọn kiểu "Lấy từ biến (giữ kiểu)" rồi loop.value.
```

- "Lặp theo" có 4 lựa chọn theo thứ tự: `Số lần cố định` (`fixed`), `Số lần ngẫu nhiên trong khoảng` (`range`), `Mỗi bản ghi
  trong pool` (`each`), `Mỗi giá trị trong danh sách` (`values`). Đổi chế độ không xóa giá trị đang ẩn (như 0010).
- **Ô số nhận biến** (`count`, `min`, `max`): ô chữ `inputmode="numeric"` (không phải `type=number`, vì phải chứa được
  `{{…}}`) kèm nút `{x}` và dải chip của 0005. Gõ số (`12`) lưu **số** `12`; xóa trống lưu `undefined` (mặc định); có `{{` lưu
  chuỗi. Chèn biến bằng bảng chọn **thay cả ô** bằng `{{path}}` (giống chế độ `path`, nhưng có dấu ngoặc). Bảng chọn ở chế độ này
  chỉ liệt kê biến `valueType` là `number` hoặc `any` (field đọc từ org, chưa biết kiểu); cuối bảng có một dòng xám:
  `Chỉ hiện biến kiểu Số và field đọc từ org (chưa biết kiểu).`
- **`showIf` bắc cầu**: `filterField` có `showIf: filter = compare`, `filter` có `showIf: mode = each`; ở `fixed` mọi ô lọc đều ẩn
  vì ô mà nó phụ thuộc đang ẩn. Luật chung, áp dụng ở `forms.js` và `referenceOptions` (`shared/scope.js`), không hard-code.
- Ô "Danh sách giá trị" là `kind: 'list'` sẵn có (textarea), có thêm `placeholder` từ option (`Hot\nWarm\nCold`).

#### Tự điền điều kiện cha–con

Khi người dùng đổi "Lọc" sang "Chỉ bản ghi thỏa điều kiện" ở **Lặp `each` hoặc Chọn bản ghi**, và cả `filterField` lẫn
`filterValue` đang trống, inspector (`client/js/ops.js`, hàm mới `fillParentFilter`) tìm:

1. Nguồn `from` có `origin: 'org'` (Query, hoặc Chọn bản ghi từ Query) và danh sách field (`members`) đã biết.
2. Các nguồn bản ghi **dùng được** ở bước này (`scope.at[id].visible`, gần nhất trước) có `origin: 'org'`, có bản ghi hiện tại
   (`current` là `item` hoặc `picked`) và có `sobject` = S.
3. Nguồn đầu tiên mà pool có field tên `${S}Id` (không phân biệt hoa thường; quy ước tên của Salesforce: `AccountId`,
   `ContactId`, `OpportunityId`).

Có ⇒ điền `filterField = "AccountId"`, `filterOp = "eq"`, `filterValue = "{{acc.Id}}"`, cùng một bước undo với việc đổi "Lọc", và
toast `Đã điền điều kiện AccountId = {{acc.Id}} (bản ghi con của "acc"). Sửa nếu cần.` Không có ⇒ không điền gì. Bản ghi đã sinh
không được gợi ý (chưa có Id, xem `{{acc.Id}}` ở [Đã chốt](#đã-chốt-2026-10-28) mục 21; lọc pool đã sinh theo cha nằm ở "Việc tiếp theo": `{{acc.$ref}}`).

### Inspector — Chọn bản ghi

- "Cách chọn" thêm lựa chọn cuối: `Ngẫu nhiên theo trọng số (field số)` (`weighted`).
- Ô mới `Field trọng số` (`weightField`, chỉ hiện khi `weighted`), gợi ý field của pool như "Field" của lọc. Help:
  `Field số của bản ghi trong pool, ví dụ NumberOfEmployees hoặc Amount. Bản ghi có giá trị gấp đôi được chọn nhiều gấp đôi; trống hoặc âm tính là 0.`
- Help của "Cách chọn" thêm: `Muốn chọn N bản ghi khác nhau một lần, dùng Lặp → "Mỗi bản ghi trong pool", Xáo trộn, Tối đa N.`

### Inspector — Rẽ nhánh

"So với" (`right`) có nút `{x}`, gõ `{{` mở bảng chọn, dải chip; help mới:
`Giá trị cố định (100000, Banking), hoặc bấm {x} để so với biến, ví dụ {{opp.Amount}}.`

### Bảng chọn biến

- Nhóm mới **Lần chạy** (luôn ở cuối danh sách, icon trung tính như `$n`): `run.seed` (Số, mẫu là seed của lần xem trước),
  `run.now` (Ngày giờ, ví dụ `2026-10-28T03:00:00.000Z`), `run.today` (Ngày, ví dụ `2026-10-28`). Nếu một bước hay biến lặp đặt
  tên `run` thì tên đó thắng; nhóm Lần chạy chuyển vào "Không dùng được ở đây" với ghi chú `bị alias "run" che`.
- Biến lặp ở chế độ `values` có thêm `value` (`Giá trị đang lặp`, ví dụ `"Hot", "Warm", "Cold"`); nhãn nhóm
  `Vòng lặp theo 3 giá trị`. Ở `count` là biến: nhãn `Vòng lặp {{acc.NumberOfEmployees__c}} lần`, `count` ví dụ
  `giá trị của acc.NumberOfEmployees__c`.
- Giá trị mẫu của bước Record lấy từ `samples` (mục F) nên không còn `—` với bước Record thứ hai cùng sObject.

### Thẻ trong view Quy trình (`client/js/summary.js`)

| Bước | Câu tóm tắt |
| --- | --- |
| Lặp `fixed`, biến | `{{acc.NumberOfEmployees__c}} lần · {{loop.index}}` (như hôm nay, in nguyên giá trị) |
| Lặp `range`, biến | `1–{{acc.NumberOfEmployees__c}} lần · {{loop.index}}` |
| Lặp `values` | `3 giá trị: Hot, Warm, Cold · {{loop.value}}`; hơn 3 giá trị: `5 giá trị: Hot, Warm, Cold, +2 · {{loop.value}}`; rỗng: `Danh sách trống · nhập giá trị` |
| Lặp `each` có thêm | `Mỗi bản ghi trong cons → con · lọc AccountId = {{acc.Id}} · xáo trộn · tối đa 3 · {{loop2.index}}` (chỉ thêm đoạn đang bật) |
| Chọn bản ghi `weighted` | `theo trọng số NumberOfEmployees từ accs` (+ `· lọc …` như cũ) |
| Rẽ nhánh | không đổi: `acc.AnnualRevenue > {{opp.Amount}}` |

Chip sau xem trước không đổi (`n lần lặp`, `chọn n lần`).

### Thông báo (đúng câu chữ)

Mọi issue gắn `nodeId` (id bước) và `field` (khóa option). `<Nhãn>` là `label` của option trong danh mục ("Số lần lặp", "Ít nhất",
"Nhiều nhất").

| `code` | Mức | Gắn với | Câu chữ |
| --- | --- | --- | --- |
| (số sẵn có) | lỗi | `count`/`min`/`max` | Câu sẵn có: `Số lần lặp phải là số nguyên từ 0 đến 100000.` |
| `numberFormat` | lỗi | `count`/`min`/`max` | `"Số lần lặp" phải là một số nguyên, hoặc đúng một biến như {{acc.NumberOfEmployees}}. Bỏ phần chữ quanh biến.` |
| `notNumber` | lỗi | ô đó | `"Số lần lặp": {{acc.CloseDate}} là Ngày, không phải số. Bấm {x} để chọn biến kiểu Số, ví dụ {{accs.$count}} hoặc {{loop.index}}.` (Ngày, Ngày giờ, Giờ, Đúng/Sai, Tham chiếu, Đối tượng) |
| `notNumber` | cảnh báo | ô đó | `"Số lần lặp": {{acc.Description}} là Chuỗi; lần chạy nào giá trị không phải số thì vòng lặp chạy 0 lần. Nên chọn biến kiểu Số bằng {x}.` |
| `ownLoop` | lỗi | ô đó | `"Số lần lặp": {{loop.index}} là biến của chính bước Lặp này, chỉ có bên trong thân; ô này được tính một lần trước lần lặp đầu. Dùng biến của bước phía trên.` (ô lọc: `"So với": {{con.Id}} là bản ghi đang lặp của chính bước Lặp này, …`) |
| (phạm vi sẵn có) | lỗi/cảnh báo | ô đó | Mọi câu của 0005 (`unknownName`, `after`, `maybe`, …) áp dụng cho `right`, `count`/`min`/`max`, `filterValue` của Lặp như ô template |
| `unknownMember` + `value` | lỗi | ô chứa | `biến lặp "loop" chỉ có index, index0, count; không có "value". {{loop.value}} chỉ có khi "Lặp theo" là "Mỗi giá trị trong danh sách".` |
| `valuesEmpty` | lỗi | `values` | `Nhập ít nhất một giá trị, mỗi dòng một giá trị (ví dụ Hot, Warm, Cold).` |
| (sẵn có) | lỗi | `values` | Quá 100 000 giá trị: `Danh sách có 100.001 giá trị, quá giới hạn 100.000 lần lặp của một bước Lặp. Bớt giá trị.` |
| (sẵn có, dùng lại) | lỗi | `filterField`/`filterOp` | Câu của Chọn bản ghi: `Chưa nhập field để lọc, ví dụ AccountId hoặc Account.Type.`; `Field "x" không hợp lệ…`; `Phép so sánh không hợp lệ.` |
| (mới) | lỗi | `filter`/`order`/`limit` | `Cách lọc "x" không hợp lệ.`; `Thứ tự "x" không hợp lệ.`; `"Tối đa số bản ghi" phải là số nguyên từ 0 đến 100000 (0 = tất cả).` |
| (mới) | lỗi | `weightField` | `Chưa nhập field trọng số, ví dụ NumberOfEmployees hoặc Amount.`; `Field "x" không hợp lệ. Dùng API name; field quan hệ viết Account.NumberOfEmployees.` |
| `numberVarEmpty` | cảnh báo (khi chạy, một lần mỗi bước + ô) | Lặp, `count`/`min`/`max` | `Bước Lặp "loop": "Số lần lặp" = {{acc.NumberOfEmployees__c}} trống, âm hoặc không phải số ở 12/200 lần chạy qua, nên các lần đó lặp 0 lần. Kiểm tra field trong org hoặc chọn biến khác.` |
| `numberVarClamped` | cảnh báo (khi chạy) | như trên | `Bước Lặp "loop": "Số lần lặp" = {{acc.NumberOfEmployees__c}} lớn hơn 100.000 ở 2/200 lần chạy qua, nên đã dùng 100.000.` |
| `eachFilterEmpty` | cảnh báo (khi chạy) | Lặp, `filterValue` | `Bước Lặp "con": không bản ghi nào của pool "cons" thỏa điều kiện lọc ở cả 200 lần chạy qua, nên các bước bên trong không chạy. Kiểm tra field lọc (có trong "Field cần lấy" của Query chưa?) và giá trị so sánh.` |
| `eachEmpty` | cảnh báo (khi chạy) | Lặp, `from` | Câu sẵn có của 0010 (pool rỗng, **trước** khi lọc) |
| (khi chạy) | lỗi | Lặp, `from` | Câu sẵn có khi không lọc/giới hạn; có lọc: `Pool "cons" còn 150.000 bản ghi sau khi lọc, quá giới hạn 100.000 lần lặp của một bước Lặp. Đặt "Tối đa số bản ghi" hoặc thu hẹp điều kiện lọc.` |
| `pickWeightZero` | cảnh báo (khi chạy) | Chọn bản ghi, `weightField` | `Bước Chọn bản ghi "acc": 7/40 lần mọi bản ghi có trọng số 0 (field "NumberOfEmployees" trống hoặc không phải số) nên đã chọn đều. Kiểm tra field trọng số hoặc thêm nó vào "Field cần lấy" của Query.` |
| `unclosed` | cảnh báo | `right` | Câu sẵn có của 0005 (giờ áp dụng cả cho `right`) |

## Thay đổi dữ liệu / API

Mọi thứ dưới đây là **(dự kiến)** cho tới khi có mục "Đã làm".

### Workflow JSON (version 2, chỉ thêm)

**A — Rẽ nhánh.** Trước (so với hằng): `{ "kind": "compare", "left": "acc.AnnualRevenue", "op": "gt", "right": "1000000" }`. Sau:

```json
{ "id": "big", "type": "branch",
  "config": { "kind": "compare", "left": "acc.AnnualRevenue", "op": "gt", "right": "{{opp.Amount}}" },
  "slots": { "true": [ "…" ], "false": [] } }
```

**B — Số lần lặp theo biến.** Trước: `"config": { "mode": "fixed", "count": 3 }`. Sau (giá trị là **chuỗi đúng một token**; số vẫn là số):

```json
{ "id": "lc", "type": "loop", "config": { "mode": "fixed", "count": "{{acc.NumberOfEmployees__c}}", "alias": "loop2" },
  "slots": { "body": [ { "id": "con", "type": "record", "config": { "sobject": "Contact", "alias": "con", "fields": [ "…" ] } } ] } }
```

`range` tương tự: `"min": 1, "max": "{{acc.NumberOfEmployees__c}}"`.

**C — Lặp `each` có lọc, xáo trộn, giới hạn.** Trước (0010):
`{ "mode": "each", "from": "cons", "itemAlias": "con", "alias": "loop2" }`. Sau:

```json
{
  "version": 2,
  "name": "Task cho mỗi Contact có sẵn của mỗi Account có sẵn",
  "seed": 42,
  "steps": [
    { "id": "q1", "type": "query", "config": { "mode": "builder", "sobject": "Account", "alias": "accs", "fields": ["Id", "Name"], "limit": 200 } },
    { "id": "q2", "type": "query", "config": { "mode": "builder", "sobject": "Contact", "alias": "cons", "fields": ["Id", "LastName", "AccountId"], "limit": 2000 } },
    { "id": "la", "type": "loop", "config": { "mode": "each", "from": "accs", "itemAlias": "acc", "alias": "loop" },
      "slots": { "body": [
        { "id": "lc", "type": "loop",
          "config": { "mode": "each", "from": "cons", "itemAlias": "con", "alias": "loop2",
            "filter": "compare", "filterField": "AccountId", "filterOp": "eq", "filterValue": "{{acc.Id}}",
            "order": "shuffle", "limit": 3 },
          "slots": { "body": [
            { "id": "task", "type": "record", "config": { "sobject": "Task", "alias": "task", "fields": [
              { "name": "Subject", "type": "template", "options": { "template": "Gọi {{con.LastName}} ({{loop2.index}}/{{loop2.count}}) · lô {{run.seed}}" } },
              { "name": "WhoId", "type": "lookup", "options": { "mode": "current", "ref": "con" } },
              { "name": "WhatId", "type": "lookup", "options": { "mode": "current", "ref": "acc" } }
            ] } }
          ] } }
      ] } }
  ]
}
```

**D — Lặp theo danh sách giá trị.**

```json
{ "id": "lr", "type": "loop", "config": { "mode": "values", "values": ["Hot", "Warm", "Cold"], "alias": "loop" },
  "slots": { "body": [ { "id": "lead", "type": "record", "config": { "sobject": "Lead", "alias": "lead", "fields": [
    { "name": "LastName", "type": "text", "options": { "mode": "lastName" } },
    { "name": "Company", "type": "text", "options": { "mode": "company" } },
    { "name": "Rating", "type": "copy", "options": { "path": "loop.value" } }
  ] } } ] } }
```

**E — Chọn bản ghi theo trọng số.** Trước: `{ "from": "accs", "alias": "acc", "mode": "random" }`. Sau:
`{ "from": "accs", "alias": "acc", "mode": "weighted", "weightField": "NumberOfEmployees" }`.

| Bước | Khóa `config` mới / giá trị mới | Mặc định | Ý nghĩa |
| --- | --- | --- | --- |
| `branch` | `right` nhận `{{…}}` | `''` | Thay token như template rồi mới so sánh; giá trị không có `{{` dùng nguyên như cũ |
| `loop` | `count`, `min`, `max` nhận chuỗi `"{{path}}"` | như cũ | Đúng **một** token, không chữ quanh (khoảng trắng hai đầu được bỏ qua) |
| `loop` | `mode: "values"`, `values` (mảng chuỗi; chuỗi nhiều dòng cũng được nhận như `kind: 'list'`) | `[]` | Một lần lặp cho mỗi giá trị không rỗng (đã trim), theo thứ tự; `{{<alias>.value}}` |
| `loop` (`each`) | `filter` (`none`\|`compare`), `filterField`, `filterOp`, `filterValue` | `none`, `''`, `eq`, `''` | Như Chọn bản ghi; `filterValue` nhận `{{…}}`, tính một lần khi vòng lặp bắt đầu |
| `loop` (`each`) | `order` (`pool`\|`shuffle`) | `pool` | `shuffle`: xáo trộn bằng `rng` |
| `loop` (`each`) | `limit` (số nguyên ≥ 0) | `0` | Tối đa số lần lặp sau lọc và xáo trộn; `0` = tất cả. **Không** nhận biến |
| `pick` | `mode: "weighted"`, `weightField` | –, `''` | Chọn có hoàn lại, xác suất tỉ lệ với giá trị số của field |

Tương thích:

- **Workflow `version: 2` đã lưu** không có khóa / giá trị mới nên chạy y như cũ, cùng seed ra **cùng từng byte và cùng
  `stats.byStep`** (hash vàng trong `test/fixtures/golden-hashes.json` không đổi; mọi khóa `byStep` mới chỉ là không có, các đếm
  cho cảnh báo mới nằm ở map riêng như `emptyEach`). Hai ngoại lệ có chủ đích, đều chỉ chạm workflow đang "hỏng":
  1. `right` cũ là một chuỗi chứa token hợp lệ (`"{{opp.Amount}}"`): trước so như chữ (luôn sai), nay so với giá trị biến. `right`
     có `{{` không thành token: giữ nguyên là chữ như cũ, thêm cảnh báo `unclosed`. Token trỏ tên không tồn tại: lỗi `unknownName`.
  2. `left` của Rẽ nhánh là một field Lookup (`con.AccountId` = `{ "$ref": "acc#3" }`): trước so chuỗi `"[object Object]"`, nay so
     ref `acc#3` (giống lọc của Chọn bản ghi), nên `con.AccountId` `=` `{{opp.AccountId}}` có nghĩa.
- Validate ít cảnh báo hơn (mục C4: `maybe` sau Lặp `each` qua pool Record luôn có bản ghi). Không thêm lỗi cho workflow cũ, trừ
  ngoại lệ 1 (token hỏng trong `right`) và alias/biến lặp tên `run` — **không** bị cấm (xem G).
- **Workflow `version: 1`**: không có các khóa này; `shared/migrate-v1.js` không đổi.
- Bản app cũ mở file mới: `values` ⇒ `Chế độ lặp "values" không hợp lệ.`; `count` là chuỗi ⇒ `Số lần lặp phải là số nguyên…`;
  khóa lọc/`order`/`limit` bị bỏ qua (lặp toàn pool); `weighted` ⇒ `Cách chọn "weighted" không hợp lệ.` Chấp nhận được.
- Không tăng `version`.

### Danh mục bước (`server/workflow/nodes.js`)

```js
const EACH = { key: 'mode', in: ['each'] };
const VALUES = { key: 'mode', in: ['values'] };
const FILTER = { key: 'filter', in: ['compare'] };          // sẵn có
const NUM_HELP = 'Số nguyên 0–100000, hoặc bấm {x} để lấy từ biến kiểu Số, ví dụ {{acc.NumberOfEmployees}} hay {{accs.$count}}.';

/** Bốn option lọc dùng chung cho Chọn bản ghi và Lặp `each` (khác nhau ở showIf của `filter` và help của `filterValue`). */
function filterOptions({ showIf, valueHelp }) { /* filter, filterField (suggest poolFields), filterOp, filterValue (vars: 'template') */ }

// record.exposes: thêm
nonEmpty: true,   // mỗi lần chạy qua thêm ≥ 1 bản ghi vào pool (count ≥ 1 là bắt buộc)

// loop.options
{ key: 'mode', label: 'Lặp theo', kind: 'select', default: 'fixed', choices: [
  { value: 'fixed', label: 'Số lần cố định' },
  { value: 'range', label: 'Số lần ngẫu nhiên trong khoảng' },
  { value: 'each', label: 'Mỗi bản ghi trong pool' },
  { value: 'values', label: 'Mỗi giá trị trong danh sách' } ] },
{ key: 'count', label: 'Số lần lặp', kind: 'integer', vars: 'number', default: 0, initial: 3, min: 0, max: LIMITS.maxCountPerNode, showIf: { key: 'mode', in: ['fixed'] }, help: NUM_HELP },
{ key: 'min', label: 'Ít nhất', kind: 'integer', vars: 'number', default: 1, min: 0, max: LIMITS.maxCountPerNode, showIf: { key: 'mode', in: ['range'] } },
{ key: 'max', label: 'Nhiều nhất', kind: 'integer', vars: 'number', default: 1, initial: 5, min: 0, max: LIMITS.maxCountPerNode, showIf: { key: 'mode', in: ['range'] },
  help: 'Ít nhất / Nhiều nhất nhận số hoặc một biến kiểu Số (bấm {x}). Khi chạy, Nhiều nhất nhỏ hơn Ít nhất thì dùng Ít nhất.' },
{ key: 'values', label: 'Danh sách giá trị', kind: 'list', default: [], showIf: VALUES, placeholder: 'Hot\nWarm\nCold',
  help: 'Mỗi dòng một giá trị. Bên trong dùng {{loop.value}}; với field Picklist chọn kiểu "Lấy từ biến (giữ kiểu)" rồi loop.value.' },
{ key: 'from', … },                     // như 0010; help thêm: 'Pool Record gồm mọi bản ghi của alias đã sinh từ đầu lần chạy.'
{ key: 'itemAlias', … },                // như 0010
...filterOptions({ showIf: EACH, valueHelp: 'Giá trị cố định, hoặc {{acc.Id}} để chỉ lấy bản ghi con của bản ghi đang lặp ở vòng ngoài. Tính một lần khi vòng lặp bắt đầu.' }),
{ key: 'order', label: 'Thứ tự', kind: 'select', default: 'pool', showIf: EACH, choices: [
  { value: 'pool', label: 'Theo thứ tự của pool' }, { value: 'shuffle', label: 'Xáo trộn (theo seed)' } ],
  help: 'Xáo trộn: mỗi lần chạy qua một thứ tự khác, cùng seed thì như nhau. Kết hợp với "Tối đa số bản ghi" để lấy N bản ghi ngẫu nhiên không trùng.' },
{ key: 'limit', label: 'Tối đa số bản ghi', kind: 'integer', default: 0, min: 0, max: LIMITS.maxCountPerNode, showIf: EACH,
  help: '0 = tất cả. Áp dụng sau khi lọc và xáo trộn.' },
{ key: 'alias', … },                    // help thêm: '… {{loop.value}} khi lặp theo danh sách.'

// loop.exposes[0].members: thêm
{ key: 'value', valueType: 'string', label: 'Giá trị đang lặp', when: VALUES },

// pick.options
mode.choices += { value: 'weighted', label: 'Ngẫu nhiên theo trọng số (field số)' },
{ key: 'weightField', label: 'Field trọng số', kind: 'string', default: '', showIf: { key: 'mode', in: ['weighted'] },
  suggest: { kind: 'poolFields', poolKey: 'from' }, help: '…(xem Thiết kế UI)' },
...filterOptions({ showIf: undefined, valueHelp: 'Giá trị cố định, hoặc {{acc.Id}} để lấy theo bản ghi ở bước trước.' }),   // = hôm nay

// branch.options
{ key: 'right', label: 'So với', kind: 'string', vars: 'template', default: '', showIf: { key: 'kind', in: ['compare'] },
  help: 'Giá trị cố định (100000, Banking), hoặc bấm {x} để so với biến, ví dụ {{opp.Amount}}.' },

// Biến cấp lần chạy (mới), gửi qua /api/meta là `globals`
export const WORKFLOW_GLOBALS = [{
  name: 'run', label: 'Lần chạy',
  members: [
    { key: 'seed', valueType: 'number', label: 'Seed của lần chạy' },
    { key: 'now', valueType: 'datetime', label: 'Thời điểm chạy (UTC, ISO 8601)' },
    { key: 'today', valueType: 'date', label: 'Ngày chạy (UTC, YYYY-MM-DD)' } ] }];
```

Thay đổi hợp đồng option / meta (cập nhật `docs/workflow-schema.md` khi làm):

- `vars` có thêm giá trị **`"number"`** cho option `kind: 'integer'`/`'number'`: giá trị là số, hoặc chuỗi đúng một token
  `{{path}}`. Validate kiểm tra định dạng, phạm vi biến (như template) và `valueType` của biến.
- **`showIf` bắc cầu**: một option hiện khi điều kiện của nó đúng **và** option nó phụ thuộc cũng đang hiện. Không có option nào
  hôm nay phụ thuộc vào một option có `showIf`, nên không đổi hành vi cũ.
- Option có thể có **`placeholder`** cho `kind: 'list'`/`'text'` (đã có cho `ref`).
- `exposes.nonEmpty: true` (Record): mỗi lần chạy qua bước thêm ít nhất một bản ghi vào pool.
- Member của `exposes.members` có thể có **`when`** (cùng dạng `showIf`): chỉ có khi config khớp (`loop.value`).
- `GET /api/meta` thêm **`globals`** (= `WORKFLOW_GLOBALS`).
- `minIterations(config, ctx)` nhận thêm `ctx = { poolNonEmpty(name) }` (vẫn không gửi qua meta).

### Ngữ nghĩa khi chạy (`server/workflow/executor.js`)

```js
/** Giá trị của option `vars: 'number'` ở lần chạy qua này. Số (hoặc chuỗi số) đi nguyên đường cũ. */
function numberOption(step, key, fallback, scope) {
  const raw = step.config?.[key] ?? fallback;
  const path = numberVarPath(raw);                 // shared/scope.js: ' {{ p }} ' → 'p'; còn lại null
  if (path === null) return Number(raw);           // y như hôm nay ⇒ hash vàng không đổi
  const w = numberWarn(step.id, key);              // { runs, empty, clamped }, map riêng, không vào byStep
  w.runs++;
  const v = resolvePath(path, scope, undefined);
  const x = toNumber(v);                           // số, hoặc chuỗi số; còn lại (null, '', chữ, Đúng/Sai, object) → null
  if (x === null || x < 0) { w.empty++; return 0; }
  if (x > LIMITS.maxCountPerNode) { w.clamped++; return LIMITS.maxCountPerNode; }
  return Math.trunc(x);                            // 2,7 → 2
}

case 'loop': {
  const mode = c.mode ?? 'fixed';
  if (mode === 'each') { yield* runEach(step, c, stat, scope); break; }
  if (mode === 'values') { yield* runValues(step, c, stat, scope); break; }
  let times;
  if (mode === 'range') {
    let lo = numberOption(step, 'min', 1, scope);
    let hi = numberOption(step, 'max', 1, scope);
    // Chỉ khi có biến: workflow cũ thiếu `min` với `max: 0` vẫn rút rng.int(1, 0) như trước.
    if (isVar(c.min) || isVar(c.max)) hi = Math.max(lo, hi);
    times = rng.int(lo, hi);                       // luôn đúng một lần rút, kể cả khi thân rỗng
  } else times = numberOption(step, 'count', 0, scope);
  // … như hôm nay (stat.iterations, countVisit mỗi lần lặp, vars { index, index0, count })
}

function* runValues(step, c, stat, scope) {        // không dùng rng
  const values = valueList(c.values);              // mảng chuỗi đã trim, bỏ dòng trống (toList)
  stat.iterations = (stat.iterations ?? 0) + values.length;
  const body = step.slots?.body ?? [];
  if (!body.length) return;
  for (let i = 0; i < values.length; i++) {
    if (countVisit(step)) yield TICK;
    yield* runSteps(body, { ...scope, vars: { ...scope.vars, [c.alias || 'loop']: { index: i + 1, index0: i, count: values.length, value: values[i] } } });
  }
}

function* runEach(step, c, stat, scope) {
  const pool = scope.all[c.from];
  if (pool && !Array.isArray(pool)) fail(/* như hôm nay */);
  const n = pool ? pool.length : 0;                 // ảnh chụp = độ dài (0010 sửa sau review)
  let idx = null;                                   // null = 0..n-1, không cấp phát
  if ((c.filter ?? 'none') === 'compare') {
    const right = renderTemplate(c.filterValue ?? '', scope, undefined);   // một lần, scope lúc bắt đầu
    idx = filterIndices(step, pool ?? [], n, right);                      // vị trí tăng dần (thứ tự pool)
    const f = eachFilterStat(step.id); f.visits++; if (idx.length) f.matched++;
  }
  const m0 = idx ? idx.length : n;
  const limit = Number(c.limit ?? 0);
  const k = limit > 0 ? Math.min(limit, m0) : m0;
  if ((c.order ?? 'pool') === 'shuffle') idx = rng.shuffleTake(idx ?? rangeArray(n), k);   // rút đúng k số
  // `pool` + giới hạn: k phần tử đầu (idx hoặc 0..k-1), không rút số
  const m = k;
  if (m > LIMITS.maxCountPerNode) fail(/* câu sẵn có nếu không lọc/giới hạn, câu "sau khi lọc" nếu có */, 'from');
  stat.iterations = (stat.iterations ?? 0) + m;
  if (!n) emptyEach.add(step.id);                   // pool rỗng (trước lọc): cảnh báo 0010 như cũ
  const body = step.slots?.body ?? [];
  if (!body.length) return;
  for (let i = 0; i < m; i++) {
    if (countVisit(step)) yield TICK;
    scope.current[c.itemAlias] = pool[idx ? idx[i] : i];
    yield* runSteps(body, { ...scope, vars: { ...scope.vars, [c.alias || 'loop']: { index: i + 1, index0: i, count: m } } });
  }
}
```

- **`filterIndices`** (mới, dùng riêng cho Lặp `each`): vế trái là `getPath(rec.fields, filterField, { ignoreCase: rec.existing })`,
  `{ $ref }` thành ref, so bằng `compareValues` như Chọn bản ghi.
  - Phép `eq`: **chỉ mục** `Map<khóa, vị trí[]>` cho mỗi bước, nối thêm khi pool dài ra (pool chỉ được nối thêm, nên vị trí luôn
    < `n` của ảnh chụp hiện tại). Khóa: `n:<số>` nếu giá trị là số hoặc chuỗi số, còn lại `s:<chuỗi>` (`null`/`undefined` → `s:`).
    Tương đương đúng `compareValues(·, 'eq', ·)` (số so theo số khi **cả hai** là số; khác thì so chuỗi). Lặp lồng
    "2 000 Account × 2 000 Contact" chỉ quét Contact một lần thay vì 4 triệu phép so sánh.
  - Phép khác: lọc tuyến tính, cache theo `(vế phải, n)` tối đa 1 000 mục như `pickOne`.
  - Mảng trả về là của cache: không được sửa; `shuffleTake` chép trước khi xáo.
  - Chọn bản ghi **giữ nguyên** code lọc hiện tại (không đổi dữ liệu cũ); dùng chung chỉ mục để sau.
- **`rng.shuffleTake(list, k)`** (mới trong `server/random.js`; hàm cũ không đổi): chép `list`, Fisher–Yates một phần: với
  `i = 0…k−1`: `j = i + floor(next() · (len − i))`, đổi chỗ `i`, `j`; trả `k` phần tử đầu. **Rút đúng `k` số** (`k = min(limit hoặc m,
  m)`), kể cả khi thân rỗng; `m = 0` thì không rút. `order: 'pool'` không bao giờ rút số. Số rút xảy ra lúc vòng lặp bắt đầu, trước
  mọi bước trong thân.
- **Không dùng `rng`**: `values`, `each` với `order: 'pool'` (có hay không lọc/giới hạn), đọc biến số. `range` vẫn rút đúng một số.
- **Ô số nhận biến** được tính **mỗi lần chạy qua bước Lặp**, với scope tại bước đó (ngoài thân): `{{acc.NumberOfEmployees__c}}` là bản
  ghi hiện tại của `acc` lúc đó. Biến lặp `count` = số lần đã tính.
- **Rẽ nhánh**:

```js
export function evaluateCondition(config, scope, rng) {
  if ((config.kind ?? 'chance') === 'chance') return rng.bool(Number(config.probability ?? 0.5));
  const left = refText(resolvePath(config.left, scope, undefined));          // { $ref } → 'acc#3' (mới)
  const r = config.right;
  const right = typeof r === 'string' && r.includes('{{') ? renderTemplate(r, scope, undefined) : r;   // không có {{ ⇒ như cũ
  return compareValues(left, config.op, right);
}
```

- **Chọn bản ghi `weighted`**: ứng viên như hôm nay (sau lọc). Trọng số `w = toNumber(getPath(rec.fields, weightField, { ignoreCase:
  rec.existing }))`; `null`, âm, không hữu hạn → 0. Tổng tiền tố cache theo **mảng ứng viên** (`WeakMap`, nối thêm khi mảng dài ra:
  pool không lọc là chính mảng pool). **Luôn rút đúng một số** `r = rng.next()`: tổng > 0 ⇒ phần tử đầu tiên có tổng tiền tố
  > `r · tổng` (tìm nhị phân); tổng = 0 ⇒ `cands[floor(r · len)]` (chọn đều) và đếm cho cảnh báo `pickWeightZero`. Không có bản ghi
  nào: `onEmpty` như cũ. `weighted` là chọn có hoàn lại (không kết hợp được với "không lặp lại").
- **`samples`** (mục F): `makeRecord` ghi `samples[step.id] ??= fields` (bản ghi đầu tiên của mỗi bước Record), cùng map với
  Chọn bản ghi. Generator có `it.samples` để lần chạy bị Dừng vẫn trả mẫu đã có (`server/run.js` `finish`). Không đổi `records`,
  `byStep`, rng.
- **`run`** (mục G): `rootScope.run = { seed, now: new Date(now).toISOString(), today: <10 ký tự đầu của now> }`. `resolvePath`: biến
  lặp, rồi bản ghi hiện tại, rồi `$count` của pool, **rồi** `run` — tên do người dùng đặt luôn thắng. Cùng `seed` + `now` ở xem
  trước, insert và `/api/export` ⇒ cùng giá trị.
- **Cảnh báo khi chạy** gom một lần mỗi bước (+ ô), thêm vào `runWarnings` theo thứ tự đọc như `eachEmpty`/`pickSkipped`.
- **Giới hạn**: không thêm khóa `LIMITS`. Số lần lặp từ biến kẹp ở `maxCountPerNode`; danh sách giá trị ≤ `maxCountPerNode` (validate);
  mỗi lần lặp vẫn là một lần thăm (`maxSteps`, nhịp `TICK`); `maxRecords` vẫn dừng lần chạy.
- **Bộ nhớ / pool chỉ đếm (0004)**: không đổi luật. `filter`/`order`/`limit` chỉ có ở Lặp `each` mà `from` đã là pool giữ bản ghi đầy
  đủ (`accepts.pool`). Ô lọc, `weightField` không làm pool nào phải giữ thêm. `samples` giữ một object field mỗi bước Record.

### Xem trước khi chưa có org

Dòng Query mẫu (`sampleRows`, `shared/soql.js`) hôm nay cho mọi field giá trị chữ (`NumberOfEmployees mẫu 1`), nên "Số lần lặp" =
`{{acc.NumberOfEmployees}}` sẽ ra 0 lần và trọng số đều 0. Thêm tham số `sampleRows(config, alias, { numeric })`: field nằm trong
`numeric` có giá trị **số thứ tự dòng** (`1, 2, 3, 4, 5`). Server tính `numeric` bằng hàm mới `numericSampleFields(workflow, catalog)`
(`shared/scope.js`): field của Query được dùng ở một option `vars: 'number'` (qua bước Query, Chọn bản ghi từ nó, hoặc bản ghi đang
lặp của nó) hoặc là `weightField` của Chọn bản ghi trên pool đó. Dòng mẫu vẫn tất định, có dấu vân tay, và không bao giờ được dùng khi
insert (0006).

### Phạm vi (`analyzeScope`, `shared/scope.js`)

- **`pathsIn('number', value)`**: chuỗi → token như template; số / `undefined` → không có tham chiếu (không coi `5` là đường dẫn).
  `numberVarPath(value)` (mới, export): đường dẫn nếu giá trị là đúng một token, ngược lại `null`.
- **`valueType` trên tham chiếu**: `resolveRef` ghi `valueType` của member tìm được (field, builtin, biến lặp, `run`). Với
  `o.mode === 'number'`: `number`/`any` hợp lệ; `string` ⇒ cảnh báo `notNumber`; khác ⇒ lỗi `notNumber`.
- **`ownLoop`**: tham chiếu trong option của chính bước Lặp tới biến lặp hoặc bản ghi đang lặp **của chính nó** (hôm nay ra
  `outsideLoop` với câu "Kéo bước này vào trong vòng lặp", sai hướng) thành mã riêng `ownLoop`.
- **`showIf` bắc cầu** trong `shown()` của `referenceOptions` (option ẩn vẫn có trong `refs` với `hidden: true` để đổi tên đi theo).
- **`members[].when`**: `buildSource` bỏ member có `when` không khớp config (`loop.value` ngoài `values` ⇒ `unknownMember`, câu riêng).
  `VAR_EXAMPLES.loop` có nhãn/ví dụ cho `values` và cho `count` là biến.
- **`minIterations` thông minh hơn** (mục C4). `walk` truyền `ctx.poolNonEmpty(name)`: có nguồn `pool` tên đó với `nonEmpty: true`, và
  trạng thái của nó tại bước Lặp (tìm ngược trên chuỗi `head`) là `always` hoặc `last`.

```js
export function loopMinIterations(config = {}, ctx = {}) {
  const c = config ?? {};
  if (c.mode === 'each') {
    // Pool Record luôn có bản ghi, không lọc ⇒ ≥ 1 lần (limit 0 = tất cả, limit ≥ 1 ⇒ ≥ 1).
    return (c.filter ?? 'none') === 'none' && ctx.poolNonEmpty?.(c.from) ? 1 : 0;
  }
  if (c.mode === 'values') return valueList(c.values).length;
  if ((c.mode ?? 'fixed') === 'range') return isVar(c.min) ? 0 : Math.max(0, Number(c.min ?? 1)) || 0;
  return isVar(c.count) ? 0 : Math.max(0, Number(c.count ?? 0)) || 0;
}
```

- **`run`**: `analyzeScope` dựng nguồn `$run` từ `catalog.globals` (`kind: 'vars'`, `visibleIn: 'downstream'`, luôn `always`, không gắn
  bước nào: `nodeId` = `null`). Phân giải tên: biến lặp trong phạm vi, rồi alias, rồi `run`. Alias hay biến lặp tên `run` **không** bị
  cấm (không làm hỏng workflow cũ); khi đó `run.*` trỏ vào alias đó, nhóm Lần chạy có `hidden` lý do `shadowed`.
- **`poolUsage`** không đổi (đi qua `referenceOptions`, nên ô lọc của Lặp ẩn ở chế độ khác không đếm).

### Cây và đổi tên (`shared/workflow-tree.js`)

Không cần code mới cho đường có danh mục: `renameAlias`/`setStepAlias`/`renameField` duyệt mọi option có `vars` (`renameInValue` với
mode khác `ref`/`path` đã xử lý token như template, nên `'number'` dùng được ngay). `legacyReferenceOptions` (không danh mục, migration
v1) thêm `right` của Rẽ nhánh và `filterValue` của Lặp `each` cho đủ. `applySuggestion` và `suggestionText` (client) coi `number` như
`template` (có ngoặc `{{ }}`).

### Endpoint

Không có endpoint mới. `/api/meta` thêm `globals` và các option ở trên. `/api/run`, `/api/export`: `done.result.samples` có thêm
mọi bước Record. `/api/validate` giữ nguyên dạng; issue có thêm các `code` ở bảng Thông báo.

### Tài liệu tham chiếu cần cập nhật khi làm (dự kiến; doc này không sửa)

- `docs/workflow-schema.md`: bảng "Bước" (`loop` thêm `values`, ô lọc/`order`/`limit` của `each`, `count`/`min`/`max` nhận biến;
  `pick` thêm `weighted`/`weightField`; `branch.right` nhận `{{…}}`); bảng `exposes` (`nonEmpty`, `members[].when`, `globals`);
  câu `vars: "number"` và `showIf` bắc cầu; "Ngữ nghĩa khi chạy" (Rẽ nhánh, Lặp `values`, `each` có lọc/xáo trộn/giới hạn, số rút
  rng, Chọn bản ghi theo trọng số); "Đường dẫn tham chiếu" (`<loopAlias>.value`, `run.seed`/`run.now`/`run.today`); bảng trạng thái
  (`last` cho Lặp `each` qua pool Record luôn có bản ghi); bảng `code` (`numberFormat`, `notNumber`, `ownLoop`, `valuesEmpty`,
  `numberVarEmpty`, `numberVarClamped`, `eachFilterEmpty`, `pickWeightZero`); `samples` trong kết quả `/api/run`; dòng Query mẫu số.
- `docs/architecture.md`: dòng "Lặp `each` không dùng `rng`" thêm ngoại lệ `order: 'shuffle'`; `shared/scope.js` thêm
  `numericSampleFields`; `forms.js` (ô số nhận biến, `showIf` bắc cầu).
- `CLAUDE.md`: dòng executor (Lặp `values`, `each` có lọc/xáo trộn/giới hạn; `run`); dòng `shared/scope.js` nếu cần.
- Skill `add-node-type`: `vars: 'number'`, `showIf` bắc cầu, `members[].when`, `exposes.nonEmpty`.

## Checklist tiện dụng

- [x] 1. **Chạy được ngay với mặc định** — mọi khóa mới có mặc định giữ hành vi cũ (`filter: none`, `order: pool`, `limit: 0`);
  Lặp mới vẫn chạy 3 lần. Xem trước không org vẫn ra dữ liệu với số lần lặp theo biến (dòng mẫu số). Ngoại lệ có lý do: đổi sang
  "Mỗi giá trị trong danh sách" cần gõ danh sách (lỗi chỉ đúng ô, có ví dụ; placeholder `Hot / Warm / Cold`) — không có danh sách
  mặc định nào đúng nghĩa.
- [x] 2. **Ít thao tác** — biến số, so hai biến, xáo trộn + giới hạn, trọng số: 2 thao tác mỗi việc; điều kiện cha–con 1 thao tác
  nhờ tự điền.
- [x] 3. **Xem trước trước khi ghi** — không đổi luồng insert; mọi thứ mới tất định theo seed + now (+ dòng Query có dấu vân tay), nên
  insert ra đúng bản xem trước. `{{run.seed}}` giúp tìm lại đúng lô đã insert.
- [x] 4. **Lỗi chỉ đúng chỗ, nói cách sửa** — mọi issue có `nodeId` + `field`; câu nói cách sửa (bấm {x}, bỏ chữ quanh biến, thêm
  field vào Query); cảnh báo lúc chạy gom một lần mỗi bước với số lần.
- [x] 5. **Không mất công sức** — đổi chế độ giữ giá trị ẩn; đổi alias/field kéo theo `right`, ô số, ô lọc (cùng cơ chế 0005);
  tự điền là một bước undo.
- [x] 6. **Lấy thông tin từ org** — gợi ý field pool cho `filterField`/`weightField`; tự điền `AccountId = {{acc.Id}}` theo
  `members` của Query và `sobject` của bản ghi đang lặp.
- [x] 7. **Một nguồn sự thật** — mọi ô từ option schema; `vars: 'number'`, `showIf` bắc cầu, `when`, `nonEmpty`, `globals` là hợp đồng
  chung trong meta/`shared/`. Ngoại lệ nhỏ có lý do: quy ước tên `<sObject>Id` của tự điền nằm ở client (chỉ là gợi ý, không ảnh
  hưởng validate hay chạy).
- [x] 8. **Giải thích tại chỗ** — help mới có ví dụ cú pháp (`{{acc.NumberOfEmployees}}`, `{{accs.$count}}`, `{{loop.value}}`,
  `0 = tất cả`); bảng chọn ghi vì sao chỉ hiện biến số.
- [x] 9. **An toàn khi lỡ tay** — biến số kẹp ở 100 000 mỗi lượt; `maxSteps`, `maxRecords` không đổi; chỉ mục `eq` tránh bùng nổ
  O(n²) khi lặp lồng có lọc; không thêm lời gọi org nào (Query vẫn đọc trước).

## Phương án đã cân nhắc

| Chủ đề | Phương án | Ưu | Nhược | Chọn? |
| --- | --- | --- | --- | --- |
| A. `right` nhận biến | `vars: 'template'`, render khi có `{{` | Đủ mọi trường hợp (`{{acc.Name}} Inc`), dùng lại bảng chọn/đổi tên/`unclosed`; dữ liệu cũ không đổi | Kết quả luôn là chuỗi (so số vẫn đúng vì `compareValues` nhận chuỗi số) | **Có** |
| | `vars: 'path'` + nút "Giá trị / Biến" | Giữ kiểu gốc | Thêm một khóa chế độ, UI riêng; không ghép được chữ | Không |
| B. Option số nhận biến | Cùng khóa, giá trị là chuỗi một token | Không thêm khóa, rename/validate dùng lại; số cũ giữ nguyên đường chạy | Khóa có hai kiểu (số \| chuỗi) | **Có** |
| | Khóa riêng `countVar` + chế độ "Theo biến" | Kiểu rõ | Nhân đôi option, thêm chế độ cho cả `range`; bản cũ lặp 0 lần âm thầm | Không |
| B. Giá trị vượt / hỏng | Kẹp + một cảnh báo gom | Một dòng org xấu không làm hỏng cả lần chạy | Có thể ít dữ liệu hơn mong đợi (đã báo) | **Có** |
| | Lỗi dừng lần chạy | Chặt chẽ | Dữ liệu org thật hay trống; phải sửa org mới chạy được | Không |
| C. Lặp qua bản ghi con | Lọc ngay trong Lặp `each` + chỉ mục `eq` | Một bước; O(n) tổng thay vì O(n²) | Thêm 4 ô cho Lặp (ẩn mặc định) | **Có** |
| | Query phụ thuộc (chạy mỗi lần lặp) | Đúng "SOQL theo cha" | Vỡ mô hình đọc trước: executor phải gọi org, xem trước ≠ insert, N lời gọi API (xem Đã chốt 19) | Không |
| C. Xáo trộn | Fisher–Yates một phần, rút đúng k số | Nhanh với `limit` nhỏ; số rút dễ đặc tả | – | **Có** |
| | `rng.sample` sẵn có | Có sẵn | Rút n số rồi sắp lại theo thứ tự pool (không phải xáo trộn) | Không |
| C4. `minIterations` | `ctx.poolNonEmpty` từ phân tích | Bỏ cảnh báo thừa, vẫn khai báo ở danh mục (`nonEmpty`) | Hàm có thêm tham số | **Có** |
| | Giữ 0 | Không đổi gì | Cảnh báo `maybe` sai ở ca phổ biến | Không |
| D. Danh sách giá trị | `mode: 'values'` + `{{loop.value}}` | Một chế độ của Lặp, biến lặp sẵn có | Thêm member có điều kiện (`when`) | **Có** |
| | Pool giả "danh sách" cho Lặp `each` | Dùng lại `each` | Pool phải có sObject/field; rối nghĩa | Không |
| E. Chọn N bản ghi | Dùng Lặp `each` + Xáo trộn + Tối đa N | Không thêm gì cho Chọn bản ghi; mỗi bản ghi có thân riêng | Chọn bản ghi vẫn chỉ một bản ghi | **Có** |
| | `pick.count` | Một ô | Bản ghi hiện tại chỉ một: N−1 bản ghi kia dùng vào đâu? | Không |
| G. Biến lần chạy | `run` có tên người dùng thắng | Cú pháp đề bài, không làm hỏng alias `run` cũ | Có thể bị che (UI báo) | **Có** |
| | `$run` / cấm alias `run` | Không bao giờ bị che | `$run` khó đọc; cấm thì workflow cũ báo lỗi | Không |

## Đã chốt (2026-10-28)

Người dùng giao chọn theo đề xuất cho mọi quyết định.

**Làm trong doc này:**

1. **`right` của Rẽ nhánh nhận biến** (0005 Câu hỏi mở 3): `vars: 'template'`; chỉ render khi chuỗi có `{{`, nên giá trị cũ không đổi
   dữ liệu. `left` là Lookup so theo ref (`acc#3`).
2. **Option số nhận biến** (0005 Câu hỏi mở 4) chỉ cho `count`/`min`/`max` của Lặp: `vars: 'number'`, đúng một token; `valueType`
   `number`/`any` hợp lệ, `string` cảnh báo, kiểu khác lỗi; khi chạy rỗng/âm/chữ → 0, > 100 000 → 100 000, thập phân cắt; mỗi loại
   một cảnh báo gom. `range` có biến: `max < min` ⇒ dùng `min`. `minIterations` = 0 khi số lần là biến.
3. **Lọc trong Lặp `each`** (0010): cùng bốn khóa với Chọn bản ghi; `filterValue` tính một lần khi vòng lặp bắt đầu; `eq` có chỉ mục;
   cảnh báo `eachFilterEmpty` chỉ khi **mọi** lượt không khớp (lượt rỗng lẻ tẻ là bình thường với lọc cha–con).
4. **`limit`** ("Tối đa số bản ghi", 0 = tất cả) — không nhận biến (0 từ biến sẽ thành "tất cả", gây hiểu nhầm).
5. **`order: 'shuffle'`** theo seed, rút đúng `k` số; `order: 'pool'` không rút số. Thứ tự áp dụng: lọc → xáo trộn → giới hạn.
6. **`minIterations` thông minh hơn**: Lặp `each` không lọc qua pool có `nonEmpty` (Record) ở trạng thái `always`/`last` ⇒ ≥ 1 lần.
   Query và Chọn bản ghi không `nonEmpty` (có thể 0 dòng / bị bỏ qua).
7. **Tự điền điều kiện cha–con** khi bật lọc (Lặp `each` và Chọn bản ghi), theo quy ước `<sObject>Id`, chỉ với nguồn đọc từ org.
8. **Lặp theo danh sách giá trị** (`mode: 'values'`, `values`, `{{loop.value}}`): không rng; giá trị là chuỗi cố định (không nhận biến);
   danh sách rỗng là lỗi; không tự điền từ Picklist (để sau).
9. **Chọn bản ghi theo trọng số** (0006 Câu hỏi mở 9, phần trọng số): `mode: 'weighted'`, `weightField`, có hoàn lại, luôn rút một số;
   tổng 0 ⇒ chọn đều + cảnh báo gom.
10. **`samples` cho mọi bước Record** (0005 "Chưa làm"), cả khi bị Dừng; dòng Query mẫu là số ở field dùng làm số.
11. **Biến lần chạy `run.seed`, `run.now`, `run.today`** (mục 8 mới; 0005 "Ý tưởng để sau"): khai báo ở `WORKFLOW_GLOBALS`, gửi qua
    meta `globals`; tên người dùng đặt thắng; `now`/`today` theo UTC như các mốc `today` của field ngày.
12. **Hợp đồng chung mới**: `vars: 'number'`, `showIf` bắc cầu, `placeholder` cho list/text, `members[].when`, `exposes.nonEmpty`,
    `minIterations(config, ctx)`, `globals`. Không tăng `version`, không khóa `LIMITS` mới.
13. **Hash vàng hiện có không đổi** (records và `byStep`); thêm ca vàng mới cho tính năng mới.

**Để sau / không làm:**

14. **`count` của Record nhận biến** — để sau. Lý do: Record hôm nay luôn sinh ≥ 1 bản ghi nên luôn là bản ghi hiện tại `always`; cho
    phép 0 bản ghi cần thêm trạng thái "có thể không sinh" cho nguồn Record (nếu không, Lookup phía sau âm thầm trỏ vào bản ghi của
    lượt trước). Cách làm ngay hôm nay: bọc Record trong Lặp "Số lần lặp" = biến (2 thao tác thêm), và `maybe` được tính đúng.
15. **Option số của generator nhận biến** (Number min/max, Date from/to) — để sau, design riêng: phạm vi khác (option field, tính mỗi
    bản ghi, tương tác với `unique`), không cần cho các luồng ở đây.
16. **Phạm vi pool "chỉ bản ghi của lượt hiện tại của vòng lặp ngoài"** — để sau. Cần chụp độ dài pool ở đầu mỗi lượt của vòng ngoài
    và một khái niệm "vòng ngoài nào"; cách thay thế: đặt các bước con trong một Lặp cố định ngay quanh Record thay vì Record `×3` +
    Lặp `each`. Help của `from` nói rõ "Pool Record gồm mọi bản ghi của alias đã sinh từ đầu lần chạy".
17. **Chọn N bản ghi một lần** (0006 Câu hỏi mở 9, phần N) — không làm: Lặp `each` + Xáo trộn + Tối đa N là đúng việc đó (help của
    "Cách chọn" trỏ sang).
18. **Hàm trong template** (`upper`, `lower`, `pad`, định dạng ngày) — để sau, design riêng. Các hàm này tất định (không cần rng),
    nhưng cần đổi ngữ pháp token (`{{acc.Name | upper}}`): regex `TEMPLATE_TOKEN_SOURCE` được gửi qua meta và dùng ở dải chip, bảng
    chọn, đổi tên, `hasUnclosed`, migration; một thay đổi chạm mọi tầng nên không gộp vào đây. Gợi ý hướng: cú pháp ống `|`, danh
    sách hàm khai báo ở server (`meta.syntax.functions`), không `eval`.
19. **Query phụ thuộc (chạy mỗi lần lặp)** — không làm trong mô hình hiện tại. Executor thuần, không gọi org; Query được đọc **trước**
    lần chạy, có cache và dấu vân tay để xem trước = insert. Query theo từng lượt cần executor bất đồng bộ (hoặc đọc trước mọi giá trị
    có thể của `{{acc.Id}}`), sinh N lời gọi API, và phá đảm bảo tất định. Cách thay thế đã có trong doc này: một Query đọc hết bản
    ghi con (tới 2 000 dòng) + Lặp `each` lọc `AccountId = {{acc.Id}}` (chỉ mục `eq`, 1 thao tác nhờ tự điền).
20. **Đi xuyên Lookup `{{con.AccountId.Name}}`** — không làm. Với bản ghi đã sinh, `AccountId` chỉ là `{ $ref }`; đọc field của cha
    cần giữ cả bản ghi của mọi pool bị trỏ tới, phá luật pool chỉ đếm (0004). Với dòng Query, field quan hệ đã có (`Account.Name`
    trong "Field cần lấy"). Câu lỗi `noTraversal` sẵn có đã chỉ cách: dùng thẳng alias cha `{{acc.Name}}`.
21. **`{{acc.Id}}` thành Id thật lúc insert** — để sau, design riêng (đánh giá): giá trị template là chuỗi đã ghép xong lúc sinh; muốn
    thay Id lúc insert phải (a) để một dấu giữ chỗ trong chuỗi (ví dụ `\u0000ref:acc#3\u0000`) mà inserter phát hiện và thay, (b) coi
    nó là một phụ thuộc như Lookup để bản ghi chứa nó vào "wave" sau cha, (c) giữ Id của alias đó qua mọi cửa sổ 2 000 bản ghi
    (`referencedAliases`), (d) chấp nhận xem trước/CSV khác insert (xem trước không có Id). Lợi ích nhỏ (ghi Id cha vào một field chữ)
    so với rủi ro với streaming và lô `allOrNone: false`. Lỗi `noIdYet` giữ nguyên.
22. **Bước "Đặt biến"** — để sau. Không có hàm / biểu thức (mục 18) thì nó chỉ đặt tên cho một template; trường hợp "rút một giá trị
    ngẫu nhiên dùng lại ở nhiều bước" làm được bằng một bước Record/Chọn bản ghi rồi `{{x.Field}}`. Làm cùng design hàm template.
23. **Bước Switch N nhánh** — để sau, design riêng. View và `flow.alternatives` đã chung cho N slot, nhưng `slots` hôm nay là **tĩnh
    theo loại bước** (`slotKeys(type)` ở `shared/workflow-tree.js`, `layout.js`, validate khóa slot hợp lệ); Switch cần slot sinh từ
    config (mỗi giá trị một nhánh), tức đổi hợp đồng `slotKeys(type)` → `slotKeys(step)` ở mọi tầng, cộng đổi tên/xóa nhánh khi sửa
    giá trị. Cách làm hôm nay: Rẽ nhánh lồng nhau, hoặc Lặp `values` + Rẽ nhánh so `{{loop.value}}`.
24. **`pick.filterValue` nhận biến** — đã có (`vars: 'template'`), không có việc gì. Dùng chung chỉ mục `eq` cho Chọn bản ghi: để sau
    (cần chứng minh lại thứ tự ứng viên để hash vàng không đổi).

## Kế hoạch thực hiện

Ba đợt, mỗi đợt một commit có test; sau mỗi đợt `npm test` xanh và hash vàng cũ không đổi (`test/stream.test.js` không sửa).

**Đợt A — hợp đồng và phân tích (`shared/`, danh mục, validate)**

1. `shared/scope.js`: `showIf` bắc cầu trong `shown`; `pathsIn` mode `number`; `numberVarPath`, `isVar`; `valueType` trên ref, mã
   `notNumber`/`ownLoop`; `members[].when`; `nonEmpty` trên nguồn; `loopMinIterations(config, ctx)` + `ctx.poolNonEmpty` trong `walk`;
   `VAR_EXAMPLES` (values, biến); nguồn `$run` từ `catalog.globals`; `numericSampleFields`.
   Test `test/scope.test.js`: `showIf is transitive: an option whose showIf key is hidden is hidden`, `number mode references are
   analysed like templates and carry valueType`, `numeric values of a number option hold no reference`, `loopMinIterations: variable
   counts give 0, values give the list length`, `an each loop over an always Record pool runs at least once (no maybe after it)`, `an
   each loop with a filter, over a Query, or over a maybe pool may run 0 times`, `loop.value exists only in values mode`, `a loop's own
   variable in its own options is ownLoop`, `run variables are visible everywhere and shadowed by an alias named run`,
   `numericSampleFields lists Query fields used as numbers or weights`, `analysis stays linear` (sẵn có, không chậm đi).
2. `server/workflow/nodes.js`: option và `exposes` như mục Danh mục; `filterOptions` dùng chung; `WORKFLOW_GLOBALS`; `server/index.js`
   (hoặc chỗ dựng meta) thêm `globals`. `server/workflow/schema.js`: `scopeCatalog()` có `globals`.
   Test `test/server.test.js`: `GET /api/meta: loop has values, filter, order and limit with chained showIf; count/min/max declare vars
   number; branch right declares vars template; pick has weighted and weightField; globals lists run`.
3. `server/workflow/schema.js`: kiểm tra chung mọi option `vars: 'number'` (thay `check(key)` của Lặp; câu số cũ giữ nguyên),
   `min > max` chỉ khi cả hai là số; `values` (`valuesEmpty`, trần); `validateFilter` dùng chung cho Chọn bản ghi và Lặp `each`;
   `order`, `limit`; `weighted`/`weightField`; `referenceIssue` thêm `notNumber`, `ownLoop`, câu `value`.
   Test `test/workflow.test.js`: `number option format errors carry nodeId and field`, `number variable of a non-number type: error for
   Ngày, warning for Chuỗi`, `branch right with a broken reference is an error on right; {{ left open is unclosed`, `values loop with no
   values is an error on values`, `each filter, order and limit are validated only in each mode`, `weighted pick needs weightField`.

**Đợt B — executor, đọc trước, kết quả**

4. `server/random.js`: `shuffleTake`. `server/workflow/conditions.js`: `right` render khi có `{{`, `left` `{ $ref }` → ref.
   `server/workflow/paths.js`: `run` sau mọi tên khác. `server/workflow/executor.js`: `numberOption`, `range` có biến, `runValues`,
   `runEach` (lọc + chỉ mục `eq`, xáo trộn, giới hạn, câu lỗi "sau khi lọc"), `weighted`, `samples` cho Record, `it.samples`,
   `rootScope.run`, các cảnh báo gom mới.
   Test `test/workflow.test.js`: `branch right renders variables before comparing`, `branch right without {{ compares exactly as before`,
   `branch left Lookup compares by ref`, `loop count accepts a number variable; empty and non-numeric values run 0 times with one
   warning`, `loop count variable above the limit is clamped with a warning`, `range with variable bounds draws exactly one number and
   uses min when max is smaller`, `each filter keeps pool order and renders filterValue once per loop start`, `each filter eq index gives
   the same records as a linear filter` (so với `compareValues` trên 1 000 giá trị lẫn số/chuỗi/null/`$ref`), `each shuffle draws exactly
   min(limit, m) numbers; pool order draws none`, `each limit takes the first N records`, `eachFilterEmpty warns only when no visit
   matched`, `values loop runs once per value with loop.value and draws nothing`, `pick weighted chooses by a numeric field; all-zero
   weights fall back to uniform with a warning`, `samples include the first record of every Record step`, `run.seed, run.now and
   run.today follow seed and now`, `nested each loops with an eq filter over 2 000 × 2 000 rows finish under 2 seconds`.
   `test/stream.test.js` không sửa; thêm ca vàng trong `test/fixtures/golden-cases.js` (`each extras: filter, shuffle, limit over
   Query and Record pools`; `values loop, number-variable counts, branch right variable, weighted pick, run vars`) và ghi hash bằng
   executor mới (× 2 seed); so `golden-hashes.json` trước/sau: mọi khóa cũ giữ nguyên.
5. `shared/soql.js` `sampleRows(…, { numeric })`, `server/sf/query.js` truyền `numericSampleFields`; `server/run.js` `finish` dùng
   `it.samples`.
   Test `test/run.test.js`: `sample Query rows give numbers for fields used as numbers`, `preview and insert give the same data with
   number variables, shuffle and weighted pick on Query rows`, `a cancelled preview still returns the samples it has`.
6. `shared/workflow-tree.js`: `legacyReferenceOptions` thêm `right` và `filterValue` của Lặp.
   Test `test/workflow-tree.test.js`: `renameAlias follows number variables, branch right and each filterValue`, `renameField follows
   number variables and each filter values`, `setStepAlias on a loop does not rename its own count variable from an outer loop`.

**Đợt C — giao diện**

7. `client/js/forms.js`: ô số nhận biến (`vars: 'number'`), `showIf` bắc cầu trong `refreshVisibility`, `placeholder` cho list/text.
   `client/js/var-picker.js`: mode `number` (thay cả ô bằng `{{path}}`), `applySuggestion`. `client/js/variables.js`: lọc theo
   `valueType` ở mode `number`, dòng giải thích, nhóm **Lần chạy**, mẫu `run.seed`. `client/js/inspector.js`: `suggestionText` cho
   `number`. `client/js/ops.js`: `fillParentFilter` (gọi khi `filter` đổi sang `compare`, cùng bước undo, toast).
   `client/js/summary.js`: câu tóm tắt của bảng Thiết kế UI.
   Smoke (`.claude/skills/smoke-test/smoke.cjs`), luồng 15 `flowVarsLoops`: Lặp "Số lần lặp" → `{x}` → `accs.$count` (chip, thẻ ghi
   `{{accs.$count}} lần`); Ctrl+Enter không org ra đúng số bản ghi; Lặp `each` qua `cons` trong thân Lặp `acc` → bật lọc ⇒ ô điền
   `AccountId` / `{{acc.Id}}` và toast, một ↶ bỏ cả hai; ở `fixed` mọi ô lọc ẩn; Xáo trộn + Tối đa 2 ⇒ chip `n lần lặp` đúng; Lặp
   "Mỗi giá trị trong danh sách" rỗng ⇒ viền đỏ `values` và câu `valuesEmpty`; nhập `Hot/Warm/Cold` ⇒ thẻ `3 giá trị: Hot, Warm, Cold`;
   Rẽ nhánh `{x}` ở "So với" chèn `{{opp.Amount}}`; `{{run.seed}}` trong template có mẫu. `SMOKE OK` ba lần liên tiếp, thời gian
   trong ngân sách của skill `smoke-test` (`SMOKE_BUDGET_MS` hoặc 15 s × max(1, 4 / số CPU); trước đây 12 giây).
8. Tài liệu: các file ở "Tài liệu tham chiếu cần cập nhật"; mục "Đã làm" của doc này; dòng 0013 trong `docs/design/README.md` (trạng
   thái `Đã duyệt` → `Đã làm`). Bảng đồng bộ hợp đồng trong `.claude/agents/implementer.md` áp dụng cho từng bước (danh mục, validate,
   executor, `shared/`, UI, doc, test cùng lúc).

## Câu hỏi mở / Việc tiếp theo

Không có câu hỏi chặn việc làm (mọi quyết định đã chốt ở trên). Ý tưởng để sau (theo thứ tự đề xuất):

- Design hàm template (mục 18) cùng bước "Đặt biến" (mục 22).
- Design Switch N nhánh với slot sinh từ config (mục 23).
- `count` của Record và option số của generator nhận biến (mục 14, 15).
- Tự điền danh sách giá trị của Lặp `values` từ Picklist đầu tiên trong thân (`values` của field Picklist, hoặc describe từ org).
- Builtin `{{acc.$ref}}` để lọc pool **đã sinh** theo bản ghi cha (`AccountId = {{acc.$ref}}`), vì `{{acc.Id}}` chỉ có với dòng org.
- Dùng chung chỉ mục `eq` cho Chọn bản ghi (mục 24).
- Phạm vi pool theo lượt (mục 16) nếu người dùng thấy Lặp `each` lồng trong Lặp khó hiểu.
- `{{acc.Id}}` thật lúc insert (mục 21) nếu có nhu cầu thật.

## Đã làm

(Cập nhật khi code xong: commit hoặc PR, chỗ nào khác với thiết kế và vì sao.)
