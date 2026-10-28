# 0010 — Lặp theo từng bản ghi trong pool (`loop.mode: 'each'`)

- **Trạng thái:** Đã làm (duyệt 2026-10-27, người dùng chọn theo đề xuất cho mọi quyết định, xem [Đã chốt](#đã-chốt-2026-10-27);
  làm 2026-10-28, xem [Đã làm](#đã-làm))
- **Ngày:** 2026-10-27
- **Liên quan:** [0003](0003-process-mode.md) (cây bước v2, Lặp, `slots.body`), [0005](0005-variable-picker.md)
  (`analyzeScope`, `flow`/`exposes`, `outsideLoop`), [0006](0006-query-pick-nodes.md) (Query, Chọn bản ghi, pool, bản ghi mẫu,
  mục "Các node khác"), [0007](0007-tong-hop-0003-0006.md) (thứ tự triển khai: "vòng lặp với mỗi bản ghi trong pool" làm sau
  0006; mâu thuẫn 1 về pool giữ bản ghi đầy đủ), 0004 (executor dạng generator), [workflow-schema.md](../workflow-schema.md)

## Vấn đề

Người dùng có sẵn 5 Account trong sandbox (đọc bằng bước Query `accs` của 0006) và muốn "mỗi Account tạo 3 Contact".
Với những gì 0006 có, họ chỉ làm được gần đúng:

| Cách | Kết quả |
| --- | --- |
| Lặp cố định N lần → Chọn bản ghi `acc` từ `accs`, cách chọn "Lần lượt (quay vòng)" → Record Contact × 3 | Phải biết trước pool có đúng 5 dòng. Org có 7 Account thì 2 Account không có Contact; có 4 thì một Account nhận 6 Contact. Số dòng đổi theo org, nên workflow không dùng lại được giữa các sandbox |
| Lookup `AccountId` "Ngẫu nhiên trong pool" `accs`, Contact × 15 | Phân bố ngẫu nhiên: có Account 0 Contact, có Account 6 |
| Lặp `count = {{accs.$count}}` | Chưa có: 0007 chốt "option số nhận biến" là design riêng, chưa làm |

Cùng nhu cầu với bản ghi đã sinh: Record `acc` × 20 (một bước, `count: 20`), rồi "mỗi Account 2 Opportunity". Hiện phải bọc
Account trong Lặp 20 lần với `count: 1` để có "bản ghi hiện tại" ở từng vòng. Làm được, nhưng phải dựng lại cấu trúc.

Power Automate gọi cái này là "Apply to each". 0003 đã nói nó nên là một `mode` mới của Lặp, 0006 đánh giá là "rất hay gặp,
việc làm nhỏ", 0007 xếp nó ngay sau 0006.

## Mục tiêu / Ngoài phạm vi

Mục tiêu:

- Lặp có chế độ thứ ba **"Mỗi bản ghi trong pool"**: thân vòng lặp chạy đúng một lần cho mỗi bản ghi của một pool đứng phía
  trên. Pool là kết quả Query, các bản ghi đã sinh của một Record, hoặc các bản ghi đã chọn của một Chọn bản ghi.
- Bản ghi đang lặp có **alias riêng** (`acc`), dùng y như alias của Chọn bản ghi: `{{acc.Name}}`, Lookup "Bản ghi gần nhất" `acc`.
- Biến lặp như cũ: `{{loop.index}}`, `{{loop.index0}}`, `{{loop.count}}` (= số bản ghi của pool).
- Tạo vòng lặp này từ một pool trong 2 thao tác, mọi ô đều được điền sẵn.
- Xem trước được khi chưa có org (5 bản ghi mẫu của Query), cùng seed ra cùng dữ liệu, không làm lệch rng.

Ngoài phạm vi (ghi ở [Câu hỏi mở](#câu-hỏi-mở--việc-tiếp-theo)):

- Lọc, giới hạn số bản ghi, xáo trộn thứ tự ngay trong Lặp (lọc dùng WHERE của Query hoặc bước Chọn bản ghi).
- Lặp theo bản ghi con của bản ghi đang lặp ("mỗi Contact của Account đang lặp") bằng bộ lọc `{{acc.Id}}`.
- Số lần lặp lấy từ biến (`count = {{acc.NumberOfEmployees}}`).
- Lặp theo danh sách giá trị cố định (`["Hot", "Warm", "Cold"]`).

## Luồng người dùng

### Luồng chính: "Mỗi Account có sẵn tạo 3 Contact"

Điểm xuất phát: workflow đã có bước Query `accs` (Account; Id, Name; `ORDER BY Id LIMIT 200`), tạo theo luồng A của 0006.

1. Bấm `⋯` trên thẻ Query `accs`, chọn **Lặp qua từng bản ghi** (2). Một bước Lặp được chèn ngay sau `accs`, đã chọn sẵn:
   "Lặp theo" = `Mỗi bản ghi trong pool`, "Lặp qua pool" = `accs`, "Tên bản ghi đang lặp" = `acc`, "Tên biến lặp" = `loop`
   (hoặc `loop2` nếu bị che). Thân rỗng hiện nút "Thêm bước vào vòng lặp".
2. Bấm **Thêm bước vào vòng lặp** → **Record** (2). Bước Record mới nằm trong thân.
3. Gõ `Contact` vào sObject, đặt "Số bản ghi mỗi lần chạy" = 3 (2).
4. **Import từ org…**, tick `LastName`, `AccountId` (2). `AccountId` tự trỏ "Bản ghi cha" = `acc`, vì `acc` là nguồn gần nhất
   có sObject `Account` khớp `referenceTo` (luật sẵn có trong `client/js/inspector.js`).
5. Ctrl+Enter (1). Có org: 5 Account → 15 Contact, chip của Lặp ghi `5 lần lặp`. Chưa có org: Query dùng 5 bản ghi mẫu,
   vẫn ra 15 Contact, thẻ Query có cảnh báo vàng của 0006.
6. **Insert vào org** (1 + xác nhận). Hộp xác nhận như hiện nay (tên org, `Contact 15`, cảnh báo production). Query được đọc
   lại và so dấu vân tay; org đổi số Account thì 409, không ghi gì (0006).

Tổng: khoảng 9 thao tác cho cả workflow; riêng phần "lặp qua từng bản ghi" là **2 thao tác** (bước 1). Hiện tại không có cách
nào làm đúng việc này.

### Luồng phụ

- **Từ menu "+":** thêm Lặp như thường (2), đổi "Lặp theo" sang `Mỗi bản ghi trong pool` (1). "Lặp qua pool" tự điền pool gần
  nhất phía trên; "Tên bản ghi đang lặp" tự điền theo pool. Tổng 3 thao tác.
- **Từ bản ghi đã sinh:** Record `acc` (Account × 20) → `⋯` → **Lặp qua từng bản ghi** → `from = acc`, item = `acc2` (vì `acc`
  đã dùng; người dùng có thể đổi thành `a`). Trong thân: Record Opportunity × 2, `AccountId` = `acc2` → 40 Opportunity, mỗi
  Account đúng 2, Lookup ra `{ "$ref": "acc#n" }`.
- **Lồng hai vòng:** Query `accs` → mỗi `acc` { Query `users` đã có ở trên → mỗi `user` { Task × 1 } } → 5 × (số User) Task.
  Vòng trong tự đặt biến lặp `loop2`.
- **Dùng sai chỗ:** kéo Record Contact (có `AccountId` = `acc`) ra ngoài vòng lặp → lỗi trên `fields.AccountId` (bảng thông
  báo). Bấm vào lỗi → nhảy tới field.
- **Pool rỗng:** Query không trả dòng nào → vòng lặp chạy 0 lần, có cảnh báo gắn ô "Lặp qua pool", không chặn xem trước.
- **Xóa bước pool:** xóa Query `accs` → lỗi `from` ("không có bước nào có alias "accs""); Ctrl+Z khôi phục.

## Thiết kế UI

### Inspector — bước Lặp

```
● Lặp                                                      ⊘  ⧉  ✕
Chạy các bước bên trong nhiều lần: số lần cố định, ngẫu nhiên, hoặc mỗi bản ghi của một pool; rồi đi tiếp xuống bước sau.
Lặp theo              [Mỗi bản ghi trong pool ▾]
Lặp qua pool          [accs (Account · đọc từ org) ▾]
                      Alias của bước Query, Record hoặc Chọn bản ghi ở phía trên. Thân vòng lặp chạy một lần cho mỗi bản ghi, theo thứ tự của pool.
Tên bản ghi đang lặp  [acc]
                      Bên trong vòng lặp dùng {{acc.Name}}, hoặc Lookup "Bản ghi gần nhất" acc.
Tên biến lặp          [loop]
                      Dùng {{loop.index}} (từ 1), {{loop.index0}} (từ 0), {{loop.count}}. Khi lặp theo pool, count = số bản ghi của pool.
```

- "Lặp theo" (đổi nhãn từ "Số lần"; giá trị giữ nguyên) có ba lựa chọn, theo thứ tự: `Số lần cố định` (`fixed`, mặc định),
  `Số lần ngẫu nhiên trong khoảng` (`range`), `Mỗi bản ghi trong pool` (`each`).
- "Lặp qua pool" và "Tên bản ghi đang lặp" chỉ hiện khi `each` (`showIf`). "Số lần lặp", "Ít nhất", "Nhiều nhất" ẩn khi `each`.
  Đổi chế độ **không xóa** giá trị đang ẩn, nên đổi qua lại không mất công.
- Dropdown "Lặp qua pool" là control `ref` sẵn có, lọc theo `accepts: { pool: true }`:
  - Dòng: `<alias> (<sObject> · <nguồn>)`, nguồn là `đọc từ org` (Query), `đã sinh` (Record), `đã chọn` (Chọn bản ghi).
    Pool `maybe` thêm `· có thể chưa có`.
  - Gần nhất trước. Pool không dùng được ở đây nằm trong nhóm "Không dùng được ở vị trí này" kèm lý do (`nằm phía dưới bước
    này`, `ở nhánh khác của Rẽ nhánh`, `đang tắt`).
  - Không có pool nào: dòng đầu `— chưa có pool nào phía trên —`.
- **Điền sẵn khi chuyển sang `each`** (và khi tạo từ menu `⋯`), chỉ điền ô đang trống:
  - `from` = pool dùng được gần nhất (cùng luật "pool gần nhất phía trên" của Chọn bản ghi trong 0006).
  - `itemAlias` = `from` bỏ chữ `s` cuối (`accs` → `acc`, `users` → `user`, `pbes` → `pbe`); trùng thì thêm số (`acc2`).
    Đây là cùng hàm `suggestPickAlias` của 0006.
  - Đổi `from` khi `itemAlias` vẫn là giá trị tự gợi ý thì `itemAlias` đổi theo (giống alias của Record đổi theo sObject).
- Đổi "Tên bản ghi đang lặp" → tham chiếu bên trong thân đổi theo (`{{acc.` và Lookup `ref`), chỉ trong thân, cùng cơ chế với
  tên biến lặp (`setStepAlias`). Đổi alias của pool (`accs` → `accounts`) → `from` của mọi Lặp đổi theo.

### Menu `⋯` của thẻ

Thẻ Record, Query và Chọn bản ghi có thêm mục **Lặp qua từng bản ghi** (sau "Bọc trong Rẽ nhánh"), title
`Thêm bước Lặp ngay sau bước này, chạy một lần cho mỗi bản ghi của "<alias>".`. Mục bị khóa khi bước chưa có alias, title
`Đặt alias cho bước này trước.` Chọn mục: chèn Lặp `each` ngay sau bước (cùng dãy), điền sẵn như trên, chọn bước mới, nháy thẻ.
Một lần Ctrl+Z bỏ cả thao tác.

### Thẻ trong view Quy trình

- Dòng tóm tắt (`client/js/summary.js`):
  - `each` có pool: `Mỗi bản ghi trong accs → acc · {{loop.index}}`
  - `each` chưa chọn pool: `Mỗi bản ghi trong ? · chọn pool`
  - `fixed`/`range`: như cũ (`3 lần · {{loop.index}}`).
- Nhãn alias trên đầu thẻ (`stepAlias`): ở `each` hiện **tên bản ghi đang lặp** (`acc`), vì đó là tên các bước bên trong dùng.
  `stepLabel` cho toast: `Lặp "acc"`.
- Chip sau xem trước: `5 lần lặp` (đã có, từ `stats.byStep[id].iterations`). Pool rỗng: `0 lần lặp`.

### Bước Chọn bản ghi (0006)

Help của "Cách chọn" thêm một câu: `Muốn chạy đúng một lần cho mỗi bản ghi của pool, dùng bước Lặp → "Mỗi bản ghi trong pool".`
Không đổi gì khác.

### Thông báo (đúng câu chữ)

Mọi issue gắn `nodeId` (id bước) và `field`.

| Tình huống | Mức | Gắn với | Câu chữ |
| --- | --- | --- | --- |
| Chưa chọn pool | lỗi | Lặp, `from` | `Chưa chọn pool để lặp. Chọn alias của một bước Query, Record hoặc Chọn bản ghi ở phía trên.` |
| Pool không tồn tại | lỗi | `from` | `Không có bước nào có alias "accs". Chọn pool khác trong danh sách hoặc thêm bước Query/Record có alias này ở phía trên.` |
| Pool nằm sau | lỗi | `from` | `Pool "accs" nằm sau bước Lặp này nên chưa có bản ghi khi chạy tới đây. Kéo bước "accs" lên phía trên hoặc chọn pool khác.` |
| Pool ở nhánh kia | lỗi | `from` | `Pool "accs" nằm ở nhánh còn lại của bước Rẽ nhánh phía trên nên không chạy cùng lượt với bước này. Đưa "accs" ra trước bước Rẽ nhánh hoặc chọn pool khác.` |
| Pool đang tắt | lỗi | `from` | `Bước "accs" đang tắt. Bật lại bước đó (Ctrl+/) hoặc chọn pool khác.` |
| Pool là bản ghi đang lặp của Lặp khác | lỗi | `from` | `"acc" là bản ghi đang lặp của bước Lặp phía trên, không phải pool. Chọn pool gốc "accs".` |
| Pool có thể chưa có | cảnh báo | `from` | `Pool "acc" nằm trong một nhánh rẽ hoặc vòng lặp có thể không chạy, nên có lúc vòng lặp này không chạy lần nào.` |
| Thiếu tên bản ghi đang lặp | lỗi | `itemAlias` | `Đặt tên cho bản ghi đang lặp (ví dụ acc) để các bước bên trong dùng {{acc.Name}}.` |
| Tên không hợp lệ | lỗi | `itemAlias` | Câu sẵn có: `Alias "…" không hợp lệ (chỉ chữ, số, gạch dưới; không bắt đầu bằng số; không dùng "this").` |
| Tên trùng alias khác | lỗi | `itemAlias` | Câu sẵn có: `Alias "acc" đã được dùng ở bước khác. Đổi alias của một trong hai bước.` |
| Tên trùng biến lặp | lỗi | `itemAlias` | `Tên bản ghi đang lặp "loop" trùng tên biến lặp. Đổi một trong hai tên.` |
| Dùng bản ghi đang lặp ngoài thân (Lookup) | lỗi | bước dùng, `fields.<Name>` | `Field "AccountId": "acc" là bản ghi đang lặp của bước Lặp phía trên, chỉ dùng được bên trong vòng lặp đó. Kéo bước này vào trong vòng lặp hoặc chọn bản ghi cha khác.` |
| Dùng bản ghi đang lặp ngoài thân (template, `left`) | lỗi | ô chứa tham chiếu | `{{acc.Name}}: "acc" là bản ghi đang lặp của bước Lặp phía trên, chỉ dùng được bên trong vòng lặp đó. Kéo bước này vào trong vòng lặp.` (lý do `outsideLoop` của 0005) |
| Lookup "Ngẫu nhiên" vào bản ghi đang lặp | lỗi | `fields.<Name>` | `Field "AccountId": "acc" là bản ghi đang lặp, không phải pool. Chọn "Bản ghi gần nhất của bước được chọn", hoặc chọn pool "accs" nếu muốn ngẫu nhiên.` |
| Chọn bản ghi `from` = bản ghi đang lặp | lỗi | Chọn bản ghi, `from` | `"acc" là bản ghi đang lặp, không phải pool. Chọn pool gốc "accs".` |
| Thân rỗng | cảnh báo | `slots.body` | Câu sẵn có: `Vòng lặp chưa có bước nào. Bấm "+ Thêm bước vào vòng lặp".` |
| Pool rỗng khi chạy | cảnh báo (một lần cho mỗi bước) | Lặp, `from` | `Bước Lặp "acc": pool "accs" không có bản ghi nào nên các bước bên trong không chạy. Kiểm tra bước "accs" (WHERE của Query hoặc số bản ghi).` |
| Pool quá lớn khi chạy | lỗi (khi chạy) | Lặp, `from` | `Pool "con" có 150 000 bản ghi, quá giới hạn 100 000 lần lặp của một bước Lặp. Thu hẹp pool (WHERE/LIMIT của Query) hoặc giảm số bản ghi.` |

Lỗi `from` dùng chung câu với Lookup `ref` (đã có trong `server/workflow/schema.js` `checkRef`), chỉ đổi chủ ngữ "Field …" thành
"Pool …", để người dùng gặp cùng một kiểu câu.

## Thay đổi dữ liệu / API

Mọi thứ dưới đây là **(dự kiến)**.

### Workflow JSON (version 2, chỉ thêm)

Trước (cách gần đúng với 0006):

```json
{ "id": "l1", "type": "loop", "config": { "mode": "fixed", "count": 5, "alias": "loop" }, "slots": { "body": [
  { "id": "p1", "type": "pick", "config": { "from": "accs", "alias": "acc", "mode": "sequential", "filter": "none", "onEmpty": "skip" } },
  { "id": "con", "type": "record", "config": { "sobject": "Contact", "alias": "con", "count": 3, "fields": ["…"] } }
] } }
```

Sau:

```json
{
  "version": 2,
  "name": "Contact cho mỗi Account có sẵn",
  "seed": 42,
  "steps": [
    { "id": "q1", "type": "query", "config": { "mode": "builder", "sobject": "Account", "alias": "accs",
      "fields": ["Id", "Name"], "orderBy": "Id", "limit": 200 } },
    { "id": "l1", "type": "loop",
      "config": { "mode": "each", "from": "accs", "itemAlias": "acc", "alias": "loop" },
      "slots": { "body": [
        { "id": "con", "type": "record", "config": { "sobject": "Contact", "alias": "con", "count": 3, "fields": [
          { "name": "LastName", "type": "text", "options": { "mode": "lastName" } },
          { "name": "Title", "type": "template", "options": { "template": "Liên hệ {{loop.index}}/{{loop.count}} của {{acc.Name}}" } },
          { "name": "AccountId", "type": "lookup", "options": { "mode": "current", "ref": "acc" } }
        ] } }
      ] } }
  ]
}
```

| Khóa `config` của `loop` | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `mode` | `fixed` | Thêm giá trị `each`. `fixed`/`range` không đổi |
| `from` | `''` | Chỉ khi `each`. Alias của bước Query, Record hoặc Chọn bản ghi chạy trước (trạng thái `always`/`last`; `maybe` là cảnh báo) |
| `itemAlias` | `''` (UI luôn điền sẵn) | Chỉ khi `each`. Alias của bản ghi đang lặp. Cùng không gian tên với alias của Record/Query/Chọn bản ghi: duy nhất trên cả cây, không trùng tên biến lặp, không là `this` |
| `alias` | `loop` | Tên biến lặp, như cũ |
| `count`, `min`, `max` | – | Bị bỏ qua khi `each` (không validate, không xóa) |

Tương thích:

- Workflow `version: 2` đã lưu không có `each` nên chạy y như cũ, cùng seed ra cùng từng byte (test vàng hiện có giữ nguyên).
- Workflow `version: 1` không có chế độ này; `shared/migrate-v1.js` không đổi. Không cần migration.
- Bản app cũ mở file có `each` sẽ báo `Chế độ lặp "each" không hợp lệ.` (câu sẵn có, gắn `mode`). Chấp nhận được.
- Không tăng `version`.

### Ngữ nghĩa khi chạy (`server/workflow/executor.js`)

```js
case 'loop': {
  const mode = c.mode ?? 'fixed';
  const body = step.slots?.body ?? [];
  const varName = c.alias || 'loop';
  if (mode === 'each') {
    const items = (scope.all[c.from] ?? []).slice();          // ảnh chụp lúc bắt đầu vòng lặp
    if (items.length > LIMITS.maxCountPerNode) failField(step, 'from', `Pool "${c.from}" có …`);
    stat.iterations = (stat.iterations ?? 0) + items.length;
    if (!items.length) emptyEach.add(step.id);                 // một cảnh báo cho mỗi bước, thêm ở cuối lần chạy
    if (body.length) {
      for (let i = 0; i < items.length; i++) {
        scope.current[c.itemAlias] = items[i];                 // chính object trong pool, không copy
        runSteps(body, { ...scope, vars: { ...scope.vars, [varName]: { index: i + 1, index0: i, count: items.length } } });
      }
    }
    break;
  }
  // fixed / range như cũ
}
```

- **Pool là gì:** `scope.all[from]` tại lúc bắt đầu vòng lặp. Query: các dòng (0006). Record: **mọi** bản ghi của alias đó đã sinh
  từ đầu lần chạy tới lúc này (cùng nghĩa với Lookup "Ngẫu nhiên trong pool"). Chọn bản ghi: mọi bản ghi đã chọn.
- **Ảnh chụp:** độ dài và thứ tự cố định lúc bắt đầu; bản ghi được thêm vào pool trong lúc lặp (chỉ có thể với pool của Chọn bản ghi
  khi bước đó nằm trong thân, mà validate đã chặn vì nó nằm "sau") không được lặp.
- **Thứ tự:** thứ tự của pool: Query theo `ORDER BY` (mặc định `Id`), Record theo thứ tự sinh (`acc#1`, `acc#2`, …).
- **Bản ghi đang lặp:** `scope.current[itemAlias]` = chính object của pool. Vì vậy Lookup "Bản ghi gần nhất" ra Id thật với dòng
  Query (`existing`, 0006) và ra `{ "$ref": "acc#3" }` với bản ghi đã sinh; `{{acc.Name}}` đọc qua `resolvePath` sẵn có.
  `scope.current` dùng chung cả lần chạy; việc chỉ dùng trong thân do validate bảo đảm. `itemAlias` **không** được thêm vào
  `scope.all` (không phải pool).
- **Không dùng rng:** chế độ `each` không rút số ngẫu nhiên nào, kể cả khi thân rỗng hoặc pool rỗng. Cùng workflow, seed và
  `queryResults` ra cùng kết quả. Lưu ý: đổi một Lặp `range` sang `each` bỏ đi một lần `rng.int`, nên dữ liệu phía sau đổi; đây
  là chỉnh sửa workflow, không phải lỗi tất định.
- **Bước tắt:** Lặp tắt bị bỏ qua cùng thân như mọi bước.
- **`stats.byStep[id]`:** như Lặp hiện nay (`runs`, `records`, `iterations`). Không thêm khóa.
- **Giới hạn (`LIMITS`, không thêm khóa mới):** số lần lặp của một lượt ≤ `maxCountPerNode` (100 000), giống `count`; tổng bước
  ≤ `maxSteps`; bản ghi ≤ `maxRecords`; độ sâu ≤ `maxDepth`. Pool Query tối đa 2 000 dòng (0006) nên thực tế chỉ pool Record
  chạm được trần 100 000.
- **Pool giữ bản ghi đầy đủ (0004, mâu thuẫn 1 của 0007):** quy tắc "alias là `from` của một bước `pick` thì giữ bản ghi đầy đủ"
  mở rộng thành "là `from` của một bước `pick` **hoặc của một Lặp `each`**". Alias khác vẫn dùng pool chỉ đếm.
- **Executor dạng generator (0004):** không có gì đặc biệt; vòng lặp `each` chỉ là một vòng `for` trên mảng.

### Xem trước khi chưa có org

Query trả `min(limit, 5)` dòng mẫu (`Id = mẫu:accs#1`, …, 0006), nên Lặp `each` chạy 5 lần, có dữ liệu ngay, cảnh báo nằm ở thẻ
Query. Pool Record không cần org. Insert không bao giờ dùng dòng mẫu (0006), và dấu vân tay bảo đảm số lần lặp lúc insert bằng
lúc xem trước.

### Danh mục bước (`server/workflow/nodes.js`)

```js
const EACH = { key: 'mode', in: ['each'] };
{
  type: 'loop',
  label: 'Lặp',
  category: 'control',
  description: 'Chạy các bước bên trong nhiều lần: số lần cố định, ngẫu nhiên, hoặc mỗi bản ghi của một pool; rồi đi tiếp xuống bước sau.',
  slots: [{ key: 'body', label: '', empty: 'Thêm bước vào vòng lặp' }],
  options: [
    { key: 'mode', label: 'Lặp theo', kind: 'select', default: 'fixed', choices: [
      { value: 'fixed', label: 'Số lần cố định' },
      { value: 'range', label: 'Số lần ngẫu nhiên trong khoảng' },
      { value: 'each', label: 'Mỗi bản ghi trong pool' } ] },
    // count / min / max như cũ (showIf fixed / range)
    { key: 'from', label: 'Lặp qua pool', kind: 'ref', default: '', showIf: EACH, accepts: { pool: true },
      help: 'Alias của bước Query, Record hoặc Chọn bản ghi ở phía trên. Thân vòng lặp chạy một lần cho mỗi bản ghi, theo thứ tự của pool.' },
    { key: 'itemAlias', label: 'Tên bản ghi đang lặp', kind: 'string', default: '', showIf: EACH,
      help: 'Bên trong vòng lặp dùng {{acc.Name}}, hoặc Lookup "Bản ghi gần nhất" acc.' },
    { key: 'alias', label: 'Tên biến lặp', kind: 'string', default: 'loop',
      help: 'Dùng {{loop.index}} (từ 1), {{loop.index0}} (từ 0), {{loop.count}}. Khi lặp theo pool, count = số bản ghi của pool.' },
  ],
  flow: { kind: 'loop', body: 'body' },        // 0005; minIterations ở shared/, trả 0 khi mode = each
  exposes: [                                   // mở rộng 0005: mảng, mỗi phần tử có thể có `when`
    { kind: 'vars', name: { key: 'alias', default: 'loop' }, label: 'Vòng lặp', visibleIn: { inside: 'body' },
      members: [/* index, index0, count như 0005 */] },
    { when: EACH, kind: 'record', name: { key: 'itemAlias' }, label: { fromSource: 'from' }, visibleIn: { inside: 'body' },
      members: { fromSource: 'from' }, current: 'item', pool: false, origin: { fromSource: 'from' }, lookupParent: true },
  ],
}
```

Thay đổi hợp đồng option/meta:

- `exposes` có thể là **mảng**; phần tử có `when` (cùng dạng `showIf`) chỉ có hiệu lực khi config khớp. Một object đơn như
  0005 viết vẫn hợp lệ (coi như mảng một phần tử).
- `exposes.current` thêm giá trị `"item"`: bộ chọn biến ghi ở đầu nhóm `bản ghi đang lặp`.
- `members: { fromSource: 'from' }` lấy field của pool, **không** kế thừa builtin cấp pool (`$count` của Query). Builtin cấp bản
  ghi (`$n` của bản ghi đã sinh) thì kế thừa.
- `kind: 'ref'` + `accepts: { pool: true }` (0005 mục 3) cho `from`. Inspector truyền danh sách lựa chọn **theo từng option**
  (0006 cần điều này cho `pick.from`).

### Phạm vi (`analyzeScope` của 0005 trong `shared/scope.js`)

Đối chiếu với `analyzeScope` đang có trong cây làm việc (0005 đang làm): `sources` có khóa là **id bước**, mỗi bước một nguồn;
`visibleIn: { inside }` và lý do `outsideLoop` hiện chỉ áp dụng cho nguồn `kind: 'vars'`; `refChoices(scope, stepId, accepts)`
lọc nguồn theo cờ (`{ pool: true }` dùng được ngay). Vì vậy:

- Nguồn bản ghi đang lặp có khóa **`<stepId>#item`** (ký tự `#` không có trong id bước do UI tạo, và `nodeId` của issue vẫn là
  `<stepId>`). `buildSource` dựng thêm nguồn này khi phần tử `exposes` có `when` khớp.
- Nhánh `flow.kind === 'loop'` của `walk` đưa **mọi** nguồn có `visibleIn.inside === body` vào thân (không chỉ `vars`): nguồn
  `vars` vào danh sách biến như hôm nay, nguồn `record` vào `S` với `always`. Sau vòng lặp, nguồn `record` này **không** được
  đưa ra `S` (khác bản ghi tạo trong thân).
- Lý do ẩn `outsideLoop` áp dụng cho mọi nguồn có `visibleIn` khác `downstream`; `note` = `chỉ có bên trong vòng lặp "<tên biến lặp>"`.
- `loopMinIterations({ mode: 'each' })` = 0. Hệ quả: nguồn tạo trong thân Lặp `each` thành `maybe` sau vòng lặp (pool có thể
  rỗng), nên Lookup tới chúng từ phía sau có cảnh báo "có lúc field này sẽ trống". Đúng với thực tế.
- Bản ghi đang lặp (`itemAlias`) là một nguồn: `always` bên trong thân (cả các khung lồng trong thân), ẩn với lý do mới
  `outsideLoop` ở mọi chỗ khác. `sobject` lấy theo nguồn `from` (để Import từ org và lọc `referenceTo` tự chọn đúng).
- `refState` có thêm trạng thái `outsideLoop`; `HIDDEN_REASON.outsideLoop = 'chỉ dùng được bên trong vòng lặp của nó'`.
- `from` của Lặp được kiểm tra bằng `refState` như Lookup `ref`, cộng điều kiện "nguồn phải là pool": Record, Query, Chọn
  bản ghi. Bản ghi đang lặp của một Lặp khác không phải pool.
- Lặp `each` mà `from` đang tắt hoặc không hợp lệ vẫn khai báo `itemAlias` trong thân, để không sinh thêm lỗi dây chuyền ở các
  bước bên trong; lỗi chỉ hiện ở `from`.

### Cây và đổi tên (`shared/workflow-tree.js`)

- `collectAliases` gồm cả `itemAlias` của Lặp `each` (để `suggestAlias`, `suggestPickAlias` không gợi ý trùng).
- `aliasTaken` coi `itemAlias` như alias Record (duy nhất trên cả cây, không trùng biến lặp).
- `renameAlias` cập nhật `config.from` của Lặp (và mọi option `kind: 'ref'` lấy từ meta khi 0005 xong).
- `setStepAlias(wf, id, value, { key: 'itemAlias' })`: đổi tham chiếu **chỉ trong thân**, giống biến lặp. Tham số `key` mới,
  mặc định `'alias'`.
- `cloneSteps` (Ctrl+D, migration) đặt `itemAlias` mới cho Lặp được nhân bản (`acc` → `acc2`) và đổi tham chiếu trong bản sao.

### Endpoint

Không có endpoint mới. `/api/meta` trả thêm lựa chọn và option như trên; `/api/validate`, `/api/run` giữ nguyên dạng.

### Tài liệu tham chiếu cần cập nhật khi làm (dự kiến)

- `docs/workflow-schema.md`: bảng "Bước" thêm `each` (`from`, `itemAlias`); "Ngữ nghĩa khi chạy" thêm đoạn Lặp `each`; bảng
  "Đường dẫn tham chiếu" thêm `<itemAlias>.Field`; bảng trạng thái alias thêm `outsideLoop`; câu về không gian tên alias.
- `docs/architecture.md`: không đổi cấu trúc; thêm một dòng ở mục executor ("Lặp `each` không dùng rng").
- `docs/field-types.md`: Lookup "Ngẫu nhiên" không nhận bản ghi đang lặp.
- `docs/org-connection.md`: không đổi.
- `docs/design/README.md`: thêm dòng 0010, trạng thái `Đã duyệt`.

## Checklist tiện dụng

- [x] 1. Chạy được ngay với mặc định: tạo từ menu `⋯` hoặc chuyển chế độ thì `from`, `itemAlias`, `alias` đều được điền; chưa có
  org vẫn xem trước được nhờ bản ghi mẫu.
- [x] 2. Ít thao tác cho việc hay làm: 2 thao tác từ thẻ pool; Import từ org tự trỏ Lookup vào bản ghi đang lặp.
- [x] 3. Xem trước trước khi ghi: không thêm đường ghi nào; hộp xác nhận cũ ghi org và số bản ghi; dấu vân tay Query bảo đảm số
  lần lặp lúc insert bằng lúc xem trước.
- [x] 4. Lỗi chỉ đúng chỗ và nói cách sửa: mọi issue gắn `nodeId` + `from`/`itemAlias`/`fields.<Name>`, câu tiếng Việt có cách sửa.
- [x] 5. Không mất công sức: đổi chế độ giữ giá trị ẩn; đổi tên pool/bản ghi đang lặp kéo theo tham chiếu; Ctrl+Z bỏ cả thao tác
  chèn từ menu.
- [x] 6. Lấy thông tin từ org thay vì bắt gõ: sObject của bản ghi đang lặp lấy từ pool, nên Lookup tự trỏ đúng theo `referenceTo`.
- [x] 7. Một nguồn sự thật: option, `showIf`, `accepts`, `exposes` khai báo ở server; client chỉ thêm tóm tắt thẻ và mục menu
  (giống Record/Lặp/Rẽ nhánh đã có câu tóm tắt riêng) và luật điền sẵn dùng chung với Chọn bản ghi.
- [x] 8. Giải thích tại chỗ: help cho `from`, `itemAlias`, `alias` (nói rõ `count` = số bản ghi của pool).
- [x] 9. An toàn khi lỡ tay: số lần lặp ≤ 100 000 mỗi lượt, cộng `maxSteps`, `maxRecords`; không gọi org thêm.

## Phương án đã cân nhắc

| Phương án | Ưu | Nhược | Chọn? |
| --- | --- | --- | --- |
| A. `mode: 'each'` của Lặp + alias riêng `itemAlias` cho bản ghi đang lặp | Dùng lại khung Lặp, biến lặp, `slots.body`, chip; bản ghi đang lặp hành xử như alias của Chọn bản ghi nên Lookup/template/bộ chọn biến không phải học gì mới | Lặp có thêm hai option; `exposes` phải nhận mảng có `when` | **Có** |
| B. Gán `scope.current[from]` trong thân (ý ban đầu của 0006): `{{accs.Name}}` dùng được trong thân | Không cần tên mới | Trái quyết định Q3 của 0007 (pool không có bản ghi hiện tại); cùng một tên lúc là pool lúc là một bản ghi; với pool Record thì ghi đè "bản ghi hiện tại" của `acc` và đổi nghĩa Lookup phía sau vòng lặp | Không |
| C. `{{loop.item.Name}}` (bản ghi nằm trong biến lặp) | Không thêm alias | Lookup `ref` là alias, không phải đường dẫn, nên phải thêm cú pháp mới cho Lookup; bộ chọn biến phải xử lý member lồng kiểu bản ghi | Không |
| D. Bước mới "Với mỗi bản ghi" (`forEach`) tách khỏi Lặp | Inspector gọn hơn | Thêm loại bước, màu, icon, menu; trùng 90% với Lặp; "Bọc trong Lặp" không chuyển được sang | Không |
| E. Không làm gì: Lặp `count = {{accs.$count}}` + Chọn bản ghi `sequential` | Không thêm khái niệm | Cần "option số nhận biến" (0007 để design riêng), vẫn tốn 2 bước và dễ lệch khi lọc | Không |
| F. Đặt tên chế độ `count` / `each` thay cho `fixed` / `range` | Khớp cách gọi trong yêu cầu | Đổi giá trị đã lưu trong mọi workflow v2 và mẫu, cần migration, không có lợi cho người dùng | Không (giữ `fixed`/`range`, thêm `each`) |

## Kế hoạch thực hiện

Làm **sau** khi 0005 (đợt 3) và 0006 (đợt 4) đã vào. Theo bảng đồng bộ hợp đồng trong `.claude/agents/implementer.md`. Mỗi bước
tự chạy được `npm test`.

1. **Phạm vi** (`shared/scope.js`, `analyzeScope` của 0005):
   `loopMinIterations` trả 0 cho `each`; `exposes` dạng mảng có `when`; nguồn `<stepId>#item` (`always` trong thân, `outsideLoop`
   ngoài, `sobject`/`members`/`origin` theo `from`); nới `outsideLoop` cho nguồn `record`; dropdown `from` dùng
   `refChoices(scope, stepId, { pool: true })` sẵn có.
   Test `test/scope.test.js`: `scope: loopMinIterations is 0 in each mode`,
   `scope: each item alias is visible inside the body with the pool sObject`, `scope: each item alias is outsideLoop after the loop`,
   `scope: sources created in an each loop are maybe after it`.
2. **Danh mục** (`server/workflow/nodes.js`): option `mode` thêm `each`, đổi nhãn; `from`, `itemAlias`; description; `flow`/`exposes`
   (mảng có `when`).
   Test `test/server.test.js`: `GET /api/meta: loop has mode each with from and itemAlias shown only for each`.
3. **Validate** (`server/workflow/schema.js`): `mode` hợp lệ gồm `each`; bỏ kiểm tra `count/min/max` khi `each`; `from` qua
   `refState` + "phải là pool"; `itemAlias` vào không gian alias chung; trùng biến lặp; Lookup `random` vào bản ghi đang lặp;
   `pick.from` vào bản ghi đang lặp.
   Test `test/workflow.test.js`: `validation: each loop needs an upstream pool (nodeId + field from)`,
   `validation: each item alias is unique and differs from loop variables`,
   `validation: item alias used outside its loop is an error on fields.<Name>`,
   `validation: lookup random on an item alias is an error`, `validation: count/min/max are ignored in each mode`.
4. **Executor** (`server/workflow/executor.js`): case `each` như trên, cảnh báo pool rỗng một lần mỗi bước (`field: 'from'`), lỗi
   pool quá lớn; quy tắc giữ bản ghi đầy đủ cho alias là `from` của Lặp `each` (nếu 0004 đã vào).
   Test `test/workflow.test.js`: `each loop runs the body once per record of a record pool, in order` (Record `acc` × 3 → mỗi `a`
   một Contact: `AccountId` = `$ref` `acc#1..3`, `Title` = `1/3 …`), `each loop over query rows gives real Ids`
   (`queryResults` giả), `each loop draws nothing from the rng` (chèn Lặp `each` thân rỗng trước một Record: giá trị của Record
   không đổi với cùng seed), `each loop over an empty pool runs 0 times and warns once on from`,
   `each loop snapshots the pool when it starts`, `each loop over more than maxCountPerNode records fails on from`
   (Lặp fixed 2 × Record `count: 50001`, `settings.maxRecords` 200 000).
5. **Cây và đổi tên** (`shared/workflow-tree.js`): `collectAliases`, `aliasTaken`, `renameAlias` (`from`), `setStepAlias` với
   `key`, `cloneSteps` (`itemAlias`).
   Test `test/workflow-tree.test.js`: `renameAlias updates loop from`,
   `setStepAlias on itemAlias renames references inside the body only`, `cloneSteps gives a copied each loop a new item alias`.
6. **Client**:
   - `client/js/inspector.js`: `onStepOption` cho `mode` → `each` (điền `from`, `itemAlias` nếu trống), `from` (đổi `itemAlias`
     tự gợi ý), `itemAlias` (`setStepAlias` với `key`); ctx `ref` theo từng option (dùng lại phần của 0006 cho `pick.from`).
   - `client/js/ops.js`: `addEachLoopAfter(id)`; `newStep` cho Lặp `each`.
   - `client/js/process.js`: mục menu `Lặp qua từng bản ghi` cho Record/Query/Chọn bản ghi.
   - `client/js/summary.js`: `stepSummary`, `stepAlias` cho `each`.
   - `client/js/store.js`: dùng `suggestPickAlias` của 0006 cho `itemAlias`.
   Kiểm tra bằng smoke test (bước 8).
7. **Mẫu** (`client/js/samples.js`): thêm "Contact cho mỗi Account có sẵn" (Query `accs` → Lặp `each` `acc` → Contact × 3).
   Test `test/samples.test.js`: mẫu mới validate sạch và xem trước không org ra 15 Contact.
8. **Smoke test** (skill `smoke-test`, không org): mở mẫu mới, Ctrl+Enter → 15 Contact, chip `5 lần lặp`; `⋯` trên Query →
   **Lặp qua từng bản ghi** → ô `from` = `accs`, `itemAlias` = `acc2`; kéo Contact ra ngoài vòng lặp → viền đỏ ở `AccountId`.
9. **Tài liệu**: cập nhật theo mục "Tài liệu tham chiếu cần cập nhật", điền "Đã làm", trạng thái trong `docs/design/README.md`.

### Giả định cần kiểm tra lại khi làm (0005 và 0006 đang được làm)

1. **Dạng `exposes` và khóa nguồn:** `analyzeScope` hiện đọc `type.exposes` là một object và đặt `sources[step.id]`. Doc này cần
   mảng có `when` và khóa phụ `<stepId>#item`. Kiểm tra mọi chỗ đọc `sources[...]` theo `nodeId` (`refsTo`, đổi tên, giá trị mẫu
   theo `nodeId` trong kết quả chạy) để chúng hiểu khóa phụ.
2. **Tên khóa pool:** 0005 (đã chốt qua 0007) mô tả Query là `kind: 'record'`, `current: 'none'`, `pool: true`, `origin`; 0006 lại
   viết `kind: 'pool'`, `lookupTarget`. Doc này theo 0005. Nếu code chọn tên của 0006 thì đổi `pool: false` → loại nguồn
   tương ứng và `origin` → `lookupTarget`.
3. **`outsideLoop`:** trong code hiện tại lý do này chỉ gán cho `kind: 'vars'` (`s.kind === 'vars' && s.visibleIn !== 'downstream'`).
   Phải nới thành "mọi nguồn có `visibleIn` khác `downstream`", và sửa câu lỗi Lookup/template tương ứng (bảng thông báo).
4. **Pool Query trong executor:** 0006 đặt `scope.all[alias]` khi executor đi qua bước Query, dòng có `existing` và `id`. Lặp
   `each` đọc đúng mảng đó.
5. **Option `ref` theo từng option và `accepts`:** hôm nay inspector truyền `ctx` rỗng cho option của bước, và `forms.js` dùng một
   danh sách `aliases` cho mọi ô `ref`. 0006 phải đổi điều này cho `pick.from`; Lặp dùng lại.
6. **`suggestPickAlias` và "pool gần nhất phía trên":** dùng đúng hàm 0006 làm cho Chọn bản ghi; nếu 0006 đặt luật khác thì theo 0006.
7. **Kế thừa builtin:** `members: { fromSource }` của Chọn bản ghi có kế thừa `$count` của Query không. Bản ghi đang lặp không được kế thừa.
8. **0004 chưa vào:** nếu executor đã là generator thì case `each` chỉ là vòng `for` trong generator; quy tắc giữ bản ghi đầy đủ
   phải gồm `from` của Lặp `each`.
9. **Nhãn "Số lần" → "Lặp theo":** tìm trong smoke test và `test/` trước khi đổi (hiện không có test nào so nhãn này).

## Đã chốt (2026-10-27)

Người dùng giao chọn theo đề xuất cho mọi quyết định:

1. **Giá trị chế độ:** thêm `each` vào `mode` sẵn có (`fixed` | `range` | `each`); không đổi tên thành `count`. Không migration.
2. **Khóa pool:** `from` (`kind: 'ref'`, `accepts: { pool: true }`), cùng tên với `pick.from` (0007 mục 8), để `renameAlias` và bộ
   chọn xử lý chung.
3. **Bản ghi đang lặp có alias riêng** `itemAlias`, không dùng lại tên pool (giữ Q3 của 0007) và không dùng `{{loop.item.X}}`.
4. **Chỉ thấy trong thân**, không phải pool: ngoài thân là lỗi `outsideLoop`; Lookup "Ngẫu nhiên" hay `pick.from` vào nó là lỗi.
5. **Biến lặp giữ nguyên** (`alias`, mặc định `loop`): `index`, `index0`, `count` = số bản ghi của pool lúc bắt đầu.
6. **Ảnh chụp pool lúc bắt đầu**, lặp theo thứ tự pool, **không dùng rng**.
7. **Pool Record = mọi bản ghi của alias đã sinh tới lúc đó** trong lần chạy (cùng nghĩa Lookup "Ngẫu nhiên").
8. **Pool rỗng:** 0 lần lặp + một cảnh báo gắn `from`; không phải lỗi.
9. **Giới hạn:** dùng lại `maxCountPerNode` cho số lần lặp mỗi lượt; không thêm khóa `LIMITS`.
10. **Không có lọc / giới hạn / xáo trộn** trong Lặp ở bản này.
11. **`minIterations` = 0** cho `each`: nguồn tạo trong thân thành `maybe` sau vòng lặp.
12. **Nhãn:** option `mode` thành "Lặp theo" với `Số lần cố định` / `Số lần ngẫu nhiên trong khoảng` / `Mỗi bản ghi trong pool`;
    đổi chế độ giữ giá trị đang ẩn.
13. **Lối tắt:** mục `Lặp qua từng bản ghi` trong menu `⋯` của Record, Query, Chọn bản ghi; chuyển sang `each` tự điền `from` và
    `itemAlias`.
14. **Nhãn alias trên thẻ** ở `each` là `itemAlias`.
15. **Pool giữ bản ghi đầy đủ** (0004) gồm cả alias là `from` của Lặp `each`.
16. **Chọn bản ghi `sequential` giữ nguyên**, help trỏ sang Lặp `each`.

## Câu hỏi mở / Việc tiếp theo

Không có câu hỏi chặn việc làm. Ý tưởng để sau:

- Lọc ngay trong Lặp (`filterField`/`filterOp`/`filterValue` như Chọn bản ghi), mở ra "mỗi Contact của Account đang lặp"
  (`AccountId = {{acc.Id}}`).
- "Tối đa N bản ghi đầu" và "xáo trộn thứ tự (theo seed)" cho pool lớn.
- `minIterations` thông minh hơn: pool Record `always` với `count ≥ 1` thì vòng lặp luôn chạy ≥ 1 lần, bỏ cảnh báo `maybe` phía sau.
- Pool Record "chỉ các bản ghi sinh trong lượt hiện tại của vòng lặp ngoài" (option phạm vi pool), nếu người dùng thấy cách 7
  khó hiểu khi lồng vòng lặp.
- Lặp theo danh sách giá trị cố định (`["Hot", "Warm", "Cold"]`), dùng cùng `{{loop.value}}`.
- "Bọc trong Lặp qua từng bản ghi" trong menu `⋯` (bọc các bước có sẵn).

## Đã làm

Làm sau 0004, 0005, 0006 và 0009 (doc viết khi 0005/0006 đang làm, 0004/0009 chưa vào). Commit trên nhánh
`claude/salesforce-data-generator-xt3u27`:

| Commit | Nội dung |
| --- | --- |
| `313cc51` Add each-record loops: Lặp mode each over a pool | Bước 1–5 và 7 của kế hoạch: `shared/scope.js`, danh mục, validate, executor, `shared/workflow-tree.js`, mẫu mới, test, ca vàng mới |
| `8ccc1d1` Add the each-loop UI… | Bước 6 và 8: inspector, `ops.js`, menu `⋯`, tóm tắt thẻ, bảng chọn biến, smoke luồng 14 |
| (commit tài liệu) | Bước 9: `workflow-schema.md`, `architecture.md`, `field-types.md`, skill `add-node-type` / `smoke-test`, `CLAUDE.md` (dòng executor), doc này, 0006, 0007, README |

### Kiểm tra lại các giả định (so với code lúc làm)

1. **`exposes` và khóa nguồn** — `analyzeScope` đọc `type.exposes` là một object, khóa `sources[step.id]`. Đã mở rộng đúng như
   doc: `exposesOf(type, config, stepId)` (mới, `shared/scope.js`) nhận object hoặc mảng, lọc theo `when`, phần tử đầu có id
   nguồn = id bước, phần tử sau `<stepId>#<key>` (`l1#item`). Nguồn có thêm `id`; `nodeId` vẫn là id bước. Mọi chỗ dùng nguồn
   làm khóa (`refs[].source`, `refChoices`, `hidden`, `state`) chuyển sang `id`; nguồn cũ có `id === nodeId` nên không đổi gì.
   Chỗ đọc theo `nodeId` của bước: toast xóa / Bỏ vỏ (`ops.js`) dùng hàm mới `sourceStep(scope, id)`; `variables.js` dùng
   `src.id` cho nhóm và `src.root` cho giá trị mẫu; `refsTo`/`renameField` không đổi (tham chiếu qua bản ghi đang lặp không đi
   theo khi đổi tên field của Record gốc — giống Chọn bản ghi hôm nay, xem "Để sau"). Code khác đọc `exposes` như object
   (`stepAlias`, `inspector.js`, `setStepAlias`, `poolUsage`, `schema.js`) đã chuyển sang `exposesOf`/`exposesList`.
2. **Tên khóa pool** — code theo 0005/0007: Query `kind: 'record'`, `current: 'none'`, `pool: true`, `origin: 'org'`. Dùng
   nguyên `pool: false` / `origin: { fromSource }` như doc.
3. **`outsideLoop`** — hiện xét **trước** `disabled` cho biến lặp (sửa sau review của 0005). Nới cho mọi nguồn có `visibleIn`
   khác `downstream`: nguồn bản ghi như vậy chỉ "thấy" khi nằm trên chuỗi của thân, còn lại luôn là `outsideLoop` (kể cả khi
   vòng lặp tắt). `visible`/`hidden` vẫn tính lười; phân tích vẫn tuyến tính (bản ghi đang lặp là một nút trên chuỗi lúc vào
   thân). Option đang ẩn vẫn có trong `refs` với `hidden: true`, nên `from` ẩn (chế độ `fixed`) vẫn đi theo khi đổi tên pool.
   `poolUsage` (0004): `from` của Lặp khai báo `kind: 'ref'` + `accepts: { pool: true }` + `showIf` each nên pool tự giữ bản ghi
   đầy đủ **chỉ khi** đang ở `each` (không sửa executor cho việc này); `poolUsage` đi qua `exposesOf` nên Lookup tới bản ghi
   đang lặp kéo theo pool phía sau vào `referencedAliases` (Id được giữ qua các cửa sổ insert; test). Pool chỉ đếm gặp Lặp
   `each` thì báo lỗi nội bộ gắn `from` (không xảy ra vì cùng một quy tắc).
4. **Pool Query** — đúng như giả định: `scope.all[alias]` là mảng `{ ref, id, existing: true, fields }` dựng một lần mỗi lần
   chạy; member của nguồn `origin: 'org'` không phân biệt hoa thường, nên `{{acc.industry}}` qua bản ghi đang lặp cũng được.
5. **`ref` theo từng option** — đã có từ 0006 (`refChoices: (def) => parentChoices(step, def.accepts)`); `from` của Lặp dùng
   lại, không sửa `forms.js`.
6. **`suggestPickAlias` và "pool gần nhất"** — dùng đúng hàm 0006 (thêm tham số `key` để bỏ tên của chính ô `itemAlias` ra
   khỏi danh sách đã dùng) và cùng luật `refChoices(…, { pool: true })` lọc `usable` như Chọn bản ghi mới (`fillEach`).
7. **Kế thừa builtin** — Chọn bản ghi không kế thừa builtin. Bản ghi đang lặp kế thừa builtin cấp bản ghi (`$n`), không kế
   thừa builtin cấp pool: `$count` của Query được đánh dấu `level: 'pool'` trong danh mục.
8. **0004 đã vào** — case `each` là một vòng `for` trong generator (`runEach`, `yield*`), `TICK` không đổi. Golden hash: mọi ca
   cũ giữ nguyên từng byte (đã so `golden-hashes.json` trước/sau: 16 khóa cũ không đổi), thêm 4 khóa (mẫu mới và một ca lồng
   `each` qua pool Record, Query, Chọn bản ghi; × 2 seed) ghi bằng executor này.
9. **Nhãn "Số lần" → "Lặp theo"** — không có test hay bước smoke nào so nhãn cũ.
10. **(thêm) `aliasTypes(catalog)`** — trả *loại bước* có `alias` đặt tên bản ghi; giữ nguyên (test 0006 khóa nó). Không gian
    tên chung giờ đi qua `stepNames(step, catalog)` (mới, `shared/workflow-tree.js`): mọi khóa config đặt tên nguồn `record`
    của `exposes` đang hiệu lực (`alias`, và `itemAlias` khi `each`). `collectAliases`, `aliasTaken`, `cloneSteps` và validate
    (`schema.js`) dùng nó.
11. **(thêm) Bảng chọn biến, `stepAlias`, thanh lỗi 0009** — `stepAlias` lấy tên cuối cùng có giá trị trong `exposes` đang
    hiệu lực (`each` ⇒ `itemAlias`), nên thẻ, toast, nhãn "con › Title" và dòng lỗi của thanh lỗi ghi `acc`. Thanh lỗi, F8,
    viền ô theo `field` không phải sửa.

### Khác với thiết kế, và quyết định ở chỗ doc chưa rõ

1. **Help của `itemAlias`** viết `Lookup "Bản ghi hiện tại" acc` (nhãn thật của chế độ Lookup là "Bản ghi hiện tại của
   alias"), không phải "Bản ghi gần nhất". Câu lỗi Lookup "Ngẫu nhiên" vào bản ghi đang lặp cũng dùng nhãn thật: `Chọn "Bản
   ghi hiện tại của alias", hoặc chọn pool "accs" nếu muốn ngẫu nhiên.`
2. **Câu lỗi template ngoài thân** có tiền tố `Field "Title": ` như mọi issue của field (`Field "Title": {{acc.Name}}: "acc" là
   bản ghi đang lặp…`); `left` của Rẽ nhánh không có tiền tố.
3. **Lookup "Ngẫu nhiên" vào bản ghi đang lặp ngoài thân** chỉ báo một lỗi (`outsideLoop`), không báo thêm `randomOfItem`.
4. **Trùng tên giữa `itemAlias` và biến lặp** chỉ báo một lần, ở `itemAlias` (câu của doc), không báo thêm "Tên biến lặp trùng
   alias…" ở ô biến lặp. Trùng alias khác: bước đứng sau theo thứ tự đọc nhận lỗi, như hôm nay.
5. **`from` hỏng** (thiếu, không tồn tại): bản ghi đang lặp vẫn có trong thân nhưng không có danh sách field (`unresolved`),
   nên `{{acc.Name}}` bên trong không bị báo thêm; chỉ `from` có lỗi. `from` đang tắt vẫn lấy field của bước đó.
6. **Ghi chú lý do ẩn** giữ câu sẵn có (`chạy sau bước này`, `ở nhánh còn lại của Rẽ nhánh`, `đang tắt`; bản ghi đang lặp:
   `chỉ có bên trong vòng lặp "loop"` — tên biến lặp, như biến lặp) và nhóm "Không dùng được ở đây" sẵn có.
7. **Dòng của dropdown pool** (`from` của Lặp **và** của Chọn bản ghi): `accs (Account · đọc từ org)`, `acc (Account · đã
   sinh)`, `pk (Account · đã chọn)`, `maybe` thêm `· có thể chưa có`. Ô "Bản ghi cha" của Lookup giữ cách ghi cũ, thêm
   `acc (Account · bản ghi đang lặp)`; ở chế độ "Ngẫu nhiên" bản ghi đang lặp nằm trong nhóm không dùng được, kèm lý do.
8. **Import từ org** ưu tiên bản ghi đang lặp gần nhất khớp `referenceTo` (luật cũ chỉ tự chọn khi có đúng một bước khớp; trong
   thân Lặp qua pool Record thì cả `acc` lẫn `acc2` đều khớp).
9. **Mục menu chỉ hiện** trên bước có nguồn `pool` đặt tên bằng `alias` (đọc từ danh mục, không hard-code Record/Query/Chọn
   bản ghi); chưa có alias thì hiện nhưng bị khóa, title như doc.
10. **Lặp `each` mới từ `⋯`** giữ `count: 3` (giá trị `initial`) ở dạng ẩn: chuyển về "Số lần cố định" vẫn chạy 3 lần.
11. **`maybe` sau Lặp `each`**: câu cảnh báo nói nguyên nhân thật (`vòng lặp "loop" chạy 0 lần khi pool "accs" rỗng nên "con"
    có thể chưa có bản ghi.`; Master-Detail: `… sẽ báo lỗi khi chạy nếu pool đó rỗng.`) thay vì "đặt Số lần lặp ≥ 1".
12. **Cảnh báo pool rỗng** có `field: 'from'` và `code: 'eachEmpty'`; `stats.byStep` không thêm khóa (đếm bằng tập riêng).
    Lỗi chạy của executor giờ mang được `field` (pool quá lớn gắn `from`).
13. **Bảng chọn biến:** nhóm bản ghi đang lặp có ghi chú `bản ghi đang lặp`, giá trị mẫu là bản ghi đầu tiên của pool gốc; ví
    dụ biến lặp ở `each`: `index 1, 2, 3…`, `count = số bản ghi của accs`, nhãn `Vòng lặp mỗi bản ghi trong accs`.
14. **Đổi tên:** `setStepAlias(…, { key: 'itemAlias' })` nhớ tên tốt cuối cùng riêng cho từng khóa (`<id>#itemAlias`), nên
    đổi biến lặp và bản ghi đang lặp của cùng vòng không lẫn nhau. `renameAlias` không có danh mục (migration v1) cũng đổi
    `from` của Lặp `each`. `cloneSteps` trả thêm `renamed[].names` cho khóa khác `alias`.

### Test

Thêm 24 test, sửa có chủ đích 2 test cũ; tổng **253** (229 + 24), đều qua (`npm test`).

- `test/scope.test.js` (+4, đúng tên của kế hoạch): `loopMinIterations is 0 in each mode`, `each item alias is visible inside
  the body with the pool sObject` (cả pool Record với `$n`, khung lồng trong thân, không có nguồn ở `fixed`), `… outsideLoop
  after the loop` (cả khi vòng tắt), `sources created in an each loop are maybe after it` (cả `from` hỏng không lan lỗi).
- `test/server.test.js` (+1): `GET /api/meta: loop has mode each with from and itemAlias shown only for each`.
- `test/workflow.test.js` (+12): 5 test validate của kế hoạch (mọi câu của bảng "Thông báo" trừ hai câu lúc chạy, có
  `nodeId` + `field`), 6 test executor của kế hoạch, và `each loop over a pick pool and nested each loops`. Pool Record
  (thứ tự, `$ref` `acc#1..3`, `1/3 …`, mọi bản ghi qua nhiều lượt), dòng Query (Id thật, field không phân biệt hoa thường),
  rng (chèn hai Lặp `each` rỗng và pool rỗng không đổi dữ liệu), pool rỗng (0 lần, một cảnh báo dù chạy 3 lượt; pool chưa
  từng chạy), ảnh chụp, trần 100 000 (`Pool "acc" có 100.002 bản ghi…`, gắn `from`).
- `test/workflow-tree.test.js` (+4): namespace (`stepNames`, mọi tên bị chiếm), `renameAlias updates loop from` (cả `from`
  ẩn và không danh mục), `setStepAlias on itemAlias renames references inside the body only` (khung lồng, gõ dở, biến lặp
  riêng), `cloneSteps gives a copied each loop a new item alias` (cả khi chép kèm pool).
- `test/run.test.js` (+2): Lookup tới bản ghi đang lặp qua cửa sổ insert 10 bản ghi với 1 dòng xem trước (Id của pool chỉ
  được giữ nhờ `referencedAliases`); xem trước = insert với cùng seed trên dòng Query.
- `test/samples.test.js` (+1): mẫu mới không lỗi/cảnh báo, không org ra 15 Contact, 3 cho mỗi Account mẫu theo thứ tự.
- `test/stream.test.js`: không sửa; ca vàng thêm trong `test/fixtures/golden-cases.js` + `golden-hashes.json`.
- **Sửa có chủ đích:** `GET /api/meta lists field types…` (`exposes` của Lặp là mảng: so `vars+record`); `the first palette
  samples are exactly the migrated v1 samples` (có thêm mẫu thứ tư không có bản v1: `V1_SAMPLES.length + 2`).

**Smoke:** luồng 14 (`flowEach`, chạy song song như các luồng khác, không chờ cố định): thẻ Lặp ghi `acc` và câu tóm tắt,
Ctrl+Enter không org ra `Contact: 15` và chip `5 lần lặp`; `⋯ → Lặp qua từng bản ghi` trên Query chèn Lặp ngay sau, được
chọn, `each` / `accs` (dòng `accs (Account · đọc từ org)`) / `acc2`, ô "Số lần lặp" ẩn, một ↶ bỏ; Lặp mới từ palette đổi sang
`each` tự điền `accs` / `acc2`; đổi `acc` → `a` kéo Lookup và template trong thân; Alt+↑ đưa Contact ra ngoài ⇒ badge lỗi và
câu `outsideLoop` trên thanh lỗi. Sau commit cuối, ba lần liên tiếp `SMOKE OK`, 5,5–5,8 giây (trước đó 5,4–6,5 giây; trần 12 giây).

### Để sau

- ~~Đổi tên field của Record gốc chưa kéo theo `{{acc.Field}}` qua bản ghi đang lặp (cũng chưa có với Chọn bản ghi).~~ Đã
  sửa sau review (mục 2 dưới đây).
- Các ý trong [Câu hỏi mở](#câu-hỏi-mở--việc-tiếp-theo): lọc / giới hạn / xáo trộn trong Lặp, `minIterations` thông minh hơn,
  phạm vi pool theo lượt, lặp theo danh sách giá trị, "Bọc trong Lặp qua từng bản ghi".

### Sửa sau review (2026-10-28)

Mỗi mục có test (`npm test`) hoặc bước smoke (thay đổi chỉ ở giao diện); bước smoke đã thử đỏ khi bỏ phần sửa.

1. **Lặp `each` chép cả pool mỗi lần chạy qua, kể cả khi thân rỗng** (Lặp 100 000 × `each` thân rỗng qua pool 100 000: 38 giây
   chạy đồng bộ). Pool chỉ được nối thêm, nên ảnh chụp giờ là **độ dài** `n` lúc bắt đầu, đọc `pool[i]` với `i < n` (không
   chép); thân rỗng thì trả về ngay sau khi đếm `iterations` và cảnh báo. Ca trên: 135 ms. Test `an each loop with an empty
   body does no work per visit…` (< 5 giây).
2. **Đổi tên field không đi theo tham chiếu qua bản ghi đang lặp hay Chọn bản ghi** (`{{a.Name}}`, `left: a.Name` với `a` là
   bản ghi đang lặp qua `acc`). Hàm mới `refsToRecords(scope, stepId, member)` (`shared/scope.js`) gom thêm tham chiếu tới
   mọi nguồn có `root` = bước đó và `current` là `picked`/`item` (cả Chọn bản ghi của Chọn bản ghi); `renameField` và toast xóa
   field dùng nó, nên số trong toast "Đã cập nhật N tham chiếu" đếm cả chúng. Test `renameField follows references through the
   record of an each loop and a Chọn bản ghi`.
3. **(lỗi có từ trước) Lặp có thân toàn bước tắt treo server.** `runSteps` bỏ bước tắt trước khi đếm, nên Lặp 100 000 × Lặp
   100 000 × [Record tắt] chạy 10¹⁰ lần lặp không đếm, không `TICK`, Dừng không tới được. Giờ mỗi lần lặp (cố định, ngẫu nhiên,
   `each`) là một lần thăm (`countVisit`): tính vào `LIMITS.maxSteps` và nhịp `TICK` (nên Dừng/ngắt kết nối có hiệu lực). Ca
   trên dừng sau ~1 giây với `Workflow chạy quá 2000000 bước…`; 1 000 × 1 500 lần lặp không bản ghi thì Dừng sau < 400 ms.
   Hash vàng không đổi (không đụng `rng`). **Hệ quả:** số bước đếm của workflow cũ tăng tối đa gấp đôi, nên một workflow cũ
   hợp lệ có thể bị từ chối mới — ví dụ Lặp 1 000 × Lặp 1 000 × [Rẽ nhánh] (≈ 1 001 000 → ≈ 2 002 000 bước) dù chỉ sinh
   ~100 000 bản ghi. Không nâng `maxSteps`; đã ghi ở bảng `LIMITS` của `architecture.md`. Test `loop iterations count as step
   visits…`.
4. **Nhỏ:**
   - N1: Record không alias được gọi bằng id; id đó trùng `itemAlias`, alias Chọn bản ghi hay tên biến lặp thì âm thầm ra sai
     dữ liệu. Giờ là lỗi gắn ô `alias` của Record: `Bước này chưa có alias nên được gọi bằng id "r1", trùng tên bản ghi đang lặp
     của một bước Lặp. Đặt alias cho bước này (ví dụ r1_rec) hoặc đổi tên kia.` (test).
   - N2: cảnh báo `poolUnused` nói thêm `Lặp qua từng bản ghi (menu ⋯)`; test cũ so câu này được sửa theo.
   - N3: chưa chọn `from` thì không báo thiếu `itemAlias` (lỗi đầu tiên là `from`) (test).
   - N4: `from` bằng chính `itemAlias` của vòng đó ⇒ câu `unknownName` thay vì `Chọn pool gốc "…"` (test).
   - N5: mẫu "Contact cho mỗi Account có sẵn" có `count: 3` (ẩn), chuyển sang "Số lần cố định" không còn "0 lần"; hash vàng của
     mẫu không đổi (test). Gợi ý "Ý bạn là" của một đường dẫn tới field (`{{acc.Name}}`) không bao giờ là pool không có bản ghi
     hiện tại (`accs`, sẽ là `noCurrent`); `{{acc.$count}}` vẫn được gợi ý `accs.$count` (test).
   - N6: dropdown pool không ghi "bản ghi cuối" cho pool tạo trong một Lặp đã chạy xong (smoke 14).
   - N7: bên trong Lặp qua từng bản ghi của một Query, nhóm pool của bảng chọn biến ghi `không có bản ghi hiện tại: dùng bản
     ghi đang lặp "row"` thay vì "dùng bước Chọn bản ghi" (smoke 14).

Tổng sau sửa: **258** test (253 + 5), đều qua. Smoke `SMOKE OK` ba lần liên tiếp.

