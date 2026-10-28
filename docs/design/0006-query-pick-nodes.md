# 0006 — Node Query và Chọn bản ghi: dùng bản ghi có sẵn trong org

- **Trạng thái:** Đã làm (duyệt 2026-10-27, xem [0007](0007-tong-hop-0003-0006.md); làm trên cây v2 của 0003 và hợp đồng `exposes` của 0005, xem [Đã làm](#đã-làm))
- **Ngày:** 2026-10-27
- **Liên quan:** [0001](0001-workflow-editor-ux.md) (việc tiếp theo "Lookup tới bản ghi có sẵn trong org bằng SOQL"),
  [0002](0002-jsforce-api.md) (`conn.query` đã có sẵn trong jsforce), [0003](0003-process-mode.md) (chế độ Quy trình, JSON v2),
  0004 (chạy dạng stream), [0005](0005-variable-picker.md) (chọn biến, `exposes`), [workflow-schema.md](../workflow-schema.md),
  [org-connection.md](../org-connection.md)

## Vấn đề

Hiện giờ workflow chỉ tham chiếu được bản ghi do chính nó sinh ra. Nhưng người dùng thường gặp những việc như:

- "Tạo 50 Contact và 20 Opportunity cho các Account **đã có** trong sandbox." Sandbox được copy từ production hoặc
  team khác đã tạo sẵn Account.
- "Owner của Account mới là một User đang active bất kỳ."
- "OpportunityLineItem phải dùng PricebookEntry có sẵn của Pricebook chuẩn, và `Opportunity.Pricebook2Id` phải là
  Pricebook chuẩn."
- "`RecordTypeId` lấy từ các RecordType của sObject đó."

Hiện chỉ có một cách là dùng Lookup mode `fixed`: mở Salesforce, chạy query trong Developer Console, copy từng Id rồi dán
vào ô "Danh sách Id". Cách này mất 5–10 phút và dễ dán nhầm Id của org khác, khiến insert lỗi `INVALID_CROSS_REFERENCE_KEY`.
Nó cũng không lấy được field khác (`Name`, `UnitPrice`) để ghép template, và không có cách nào "chọn **một** Account rồi
dùng chính nó cho cả Contact lẫn Opportunity".

## Mục tiêu / Ngoài phạm vi

Mục tiêu:

- Node **Query** đọc bản ghi có sẵn từ org bằng `conn.query` của jsforce. Node chỉ đọc và có trần số dòng.
  Kết quả là một **pool** (tập bản ghi để chọn) có alias.
- Node **Chọn bản ghi** (`pick`) chọn một bản ghi từ pool (kết quả Query hoặc bản ghi đã sinh) làm "bản ghi hiện tại"
  của một alias mới. Có ba cách chọn: ngẫu nhiên, không lặp lại, lần lượt. Có thể lọc theo điều kiện, kể cả theo
  `{{acc.Id}}` của node trước.
- Lookup trỏ tới bản ghi có sẵn trong org cho ra **Id thật** (chuỗi `001…`), không phải `{ "$ref" }`.
- Xem trước rồi insert với cùng seed ra đúng cùng dữ liệu, kể cả khi workflow có Query (cache + fingerprint).
- Xem trước được cả khi chưa chọn org, bằng bản ghi mẫu.
- Lấy thông tin từ describe: gợi ý sObject và field, preset cho `User`/`Product2`/`Pricebook2`/`PricebookEntry`/`RecordType`.
  Trong hộp "Import từ org…", chỉ cần một lựa chọn để thêm Query cho field Lookup.

Ngoài phạm vi (bản này):

- Query phụ thuộc giá trị lúc chạy (`WHERE AccountId = '{{acc.Id}}'`). Thay vào đó dùng bộ lọc của node Chọn bản ghi
  (xem [Mô hình thực thi](#mô-hình-thực-thi-đọc-trước-pre-fetch-rồi-chạy-executor-thuần)).
- Update, upsert hoặc delete bản ghi có sẵn; query qua Bulk API; subquery quan hệ con trong SELECT; SOSL.
- Chọn N bản ghi trong một lần, trọng số theo field, Lặp "mỗi bản ghi trong pool". Các mục này nằm ở
  [Các node khác](#các-node-khác-đánh-giá-nhanh) và [Câu hỏi mở](#câu-hỏi-mở).

## Luồng người dùng

### A. Contact cho các Account có sẵn (đường ngắn nhất, qua Import)

Org `dev` đã được chọn ở thanh trên. Workflow chỉ có node Bắt đầu.

1. Chọn **Bắt đầu**, bấm **Lặp**, gõ `20` vào "Số lần lặp". (2)
2. Bấm **Record**. Node mới nối vào cổng "lặp". Gõ `Contact` vào sObject, alias tự đổi thành `con`. (2)
3. Bấm **Import từ org…**. `LastName` đã được chọn sẵn. Tick `AccountId`. Ô "Node cha" của dòng này **đã chọn sẵn**
   `＋ Account có sẵn trong org (thêm node Query)` vì chưa có node nào cho Account. Bấm **Thêm field đã chọn**. (2)
   → Node Query `accs` (Account; Id, Name; ORDER BY Id; LIMIT 200) được chèn ngay sau Bắt đầu, và `AccountId` thành
   Lookup "Ngẫu nhiên trong pool" `accs`. Toast: `Đã thêm 2 field và node Query "accs" (Account có sẵn trong org).`
4. **Ctrl+Enter**. Tab `Contact (20)` có `AccountId` là Id thật. Tab `↓ accs · Account (200)` liệt kê các bản ghi
   vừa đọc. (1)
5. Bấm **📌 giữ seed** rồi **Insert vào org**. Hộp xác nhận ghi "Giống lần xem trước (seed 42): Contact 20" và
   "Đọc từ org, không ghi: Account 200 (accs, đọc lúc 10:32)". Bấm **Insert**. (3)

Phần dành riêng cho Query chỉ là **1 tick**, vì lựa chọn "＋ … có sẵn" đã được chọn sẵn. Mọi thao tác khác giống luồng hiện có.

### B. Contact và Opportunity dùng chung một Account có sẵn, có template theo tên Account

1. Chọn **Bắt đầu**, bấm **Query**. Node `accs` (Account, Id + Name, LIMIT 200) chạy được ngay với mặc định. (1)
2. Bấm **Lặp** (node tự nối sau Query), gõ `10`. (2)
3. Bấm **Chọn bản ghi**. Node nối vào cổng "lặp", tự điền "Chọn từ pool" = `accs`, alias `acc`, cách chọn
   "Ngẫu nhiên (có thể lặp lại)". (1)
4. Bấm **Record**, gõ `Contact`, **Import từ org…**. `AccountId` tự chọn `acc` ("Bản ghi hiện tại") vì chỉ có `acc` là
   node chọn bản ghi khớp Account. Bấm **Thêm**. (4)
5. Bấm **Record** (nối sau Contact), gõ `Opportunity`, **Import từ org…**. `AccountId` → `acc`. `Name`, `StageName` và
   `CloseDate` bắt buộc nên đã được chọn sẵn. Bấm **Thêm**. (4)
6. Đổi field `Name` của Opportunity sang Template `Cơ hội của {{acc.Name}}`, rồi **Ctrl+Enter**. (3)

Mỗi vòng lặp chọn một Account. Contact và Opportunity của vòng đó dùng **cùng** Account ấy.

### C. Owner là User active, Opportunity dùng Pricebook chuẩn

1. Bấm **Query**, gõ `User` vào sObject. Preset tự điền WHERE `IsActive = true AND UserType = 'Standard'`, field
   `Id, Name, Email`, alias `users`. (2)
2. Bấm **Query**, gõ `Pricebook2`. Preset điền WHERE `IsStandard = true`, LIMIT `1`, alias `pb`. (2)
3. Trong node Record Opportunity: `Pricebook2Id` = Lookup "Ngẫu nhiên trong pool" `pb`. Query có LIMIT 1 nên lần nào cũng
   ra Pricebook chuẩn. `OwnerId` = Lookup "Ngẫu nhiên trong pool" `users`. Nếu dùng Import từ org thì cả hai đều được chọn
   sẵn, vì mỗi field chỉ có đúng một Query khớp. (≈4)

### D. Trường hợp lỗi

- **Chưa chọn org mà bấm Xem trước.** Workflow vẫn chạy. Query dùng 5 bản ghi mẫu (Id `mẫu:accs#1`, …) và node Query có
  cảnh báo vàng. Nút Insert vẫn bị khóa như hiện nay khi chưa chọn org.
- **Gõ sai field `Nme`.** Xem trước trả HTTP 422. Node Query có badge đỏ, ô "Field cần lấy" có viền đỏ, kèm thông báo
  ở [bảng thông báo](#thông-báo-đúng-câu-chữ). Sửa mất 1–2 thao tác (sửa tên hoặc "Chọn field…").
- **Query không trả về bản ghi nào.** Node Query có cảnh báo. Node Chọn bản ghi bỏ qua các node phía sau và có một
  cảnh báo ghi tổng số lần bỏ qua.
- **Dữ liệu org đổi giữa lúc xem trước và lúc insert.** Server dừng **trước khi ghi** (HTTP 409). Lỗi gắn vào node Query.
  Người dùng bấm Ctrl+Enter rồi Insert lại. (2)
- **Org hết hạn đăng nhập.** Hiện thông báo sẵn có của CLI (`Org "dev" chưa đăng nhập… Chạy: sf org login web --alias dev`)
  và thêm câu `Hoặc chọn "— không kết nối —" để xem trước bằng bản ghi mẫu.`

## Thiết kế UI

### Palette và canvas

- Hai mục mới nằm ngay sau **Record** (theo thứ tự của `NODE_TYPES`):
  - **Query (đọc org)**, dòng nhỏ: "Đọc bản ghi có sẵn trong org bằng SOQL, chỉ đọc"
  - **Chọn bản ghi**, dòng nhỏ: "Chọn một bản ghi từ pool làm bản ghi hiện tại"
- Màu và icon: dùng token có sẵn của [0008](0008-ui-design-system.md): `--step-query` (cyan `#057da0` / tối `#54c1e3`, icon trụ dữ liệu + kính lúp `--ico-query`) và `--step-pick` (olive `#656902` / tối `#b4d35c`, icon hồng tâm `--ico-pick`). Không dùng `#0f766e` (gần màu thành công) hay `#b4235a` (gần màu lỗi).
- Bấm **Query**: config lấy mặc định từ option. Alias gợi ý lấy `alias` của preset nếu có, nếu không thì dùng
  `suggestAlias(sobject)` + `s` (`accs`, `cons`). Trùng thì thêm số (`accs2`).
- Bấm **Chọn bản ghi**:
  - `from` = alias của node đang chọn nếu node đó là Query, Record hoặc Chọn bản ghi. Nếu không, lấy pool gần nhất phía
    trên: đi ngược cạnh từ node đang chọn tới node Query/Record/Chọn bản ghi đầu tiên có alias. Không có pool nào thì để trống.
  - `alias` = `from` bỏ chữ `s` ở cuối (`accs` → `acc`, `users` → `user`). Nếu đã bị dùng thì thêm số (`acc2`).
- Thẻ node Query: badge alias `accs`. Summary ở chế độ builder là `Account · 2 field · ≤200`, ở chế độ SOQL là 40 ký tự
  đầu của SOQL. Nếu lần chạy gần nhất có kết quả thì thêm `· đọc 200` hoặc `· mẫu 5`.
- Thẻ node Chọn bản ghi: badge alias `acc`. Summary là `ngẫu nhiên từ accs` / `không lặp từ accs` / `lần lượt từ accs`,
  có lọc thì thêm `· lọc AccountId = {{acc.Id}}`.
- Ctrl+D nhân bản node Query hoặc Chọn bản ghi thì node mới có alias mới (`accs2`, `acc2`), giống node Record.

### Inspector — Query

```
● Query (đọc org)                                              ⧉  ✕
Đọc bản ghi có sẵn trong org bằng SOQL, chỉ đọc. Kết quả là một pool cho Lookup và node Chọn bản ghi.
┌─────────────────────────────────────────────────────────────────┐
│ ⓘ Chưa chọn org: Xem trước sẽ dùng 5 bản ghi mẫu (Id giả).      │   ← chỉ hiện khi chưa chọn org
└─────────────────────────────────────────────────────────────────┘
Cách nhập           [Chọn sObject và field ▾]        (Chọn sObject và field | Viết SOQL)
sObject             [Account               ]          ← datalist các sObject queryable của org
Tên pool (alias)    [accs]
                    Lookup "Ngẫu nhiên trong pool" và node Chọn bản ghi dùng tên này. {{accs.$count}} = số bản ghi đọc được.
Field cần lấy       ┌Id──────────────────┐ [Chọn field…]
                    │Name                │
                    └────────────────────┘
                    Mỗi dòng một field. Dùng được field quan hệ như Owner.Name. Id luôn được lấy.
Điều kiện (WHERE)   [                      ]
                    Cú pháp SOQL, ví dụ Industry = 'Banking' AND CreatedDate = LAST_N_DAYS:30. Để trống = lấy tất cả.
Sắp xếp (ORDER BY)  [Id                    ]
                    Giữ thứ tự cố định để cùng seed chọn ra cùng bản ghi.
Số bản ghi tối đa (LIMIT) [200]   (1–2000)
──────────────────────────────────────────────────────────────────
SOQL sẽ chạy
  SELECT Id, Name FROM Account ORDER BY Id LIMIT 200           [Sửa dạng SOQL]
Lần đọc gần nhất: 200 bản ghi từ dev lúc 10:32 (xem tab ↓ accs ở bảng kết quả).
```

- **sObject**: ô nhập có datalist lấy từ `GET /api/orgs/:org/sobjects?for=query` (cache theo org), khai báo bằng
  `suggest: { kind: 'sobject', purpose: 'query' }`. Datalist gợi ý ngay khi gõ, không cần bấm thêm.
- **Chọn field…** (`suggest: { kind: 'fields', sobjectKey: 'sobject' }`) mở hộp "Chọn field của Account". Dữ liệu lấy từ
  `GET /api/orgs/:org/sobjects/Account/fields`.
  - Mỗi dòng gồm checkbox, nhãn và `Name · kiểu → referenceTo`, có ô "Lọc field…".
  - `Id` luôn được tick và bị khóa. Field đã có trong danh sách thì được tick sẵn.
  - Field Lookup có `relationshipName` có thêm checkbox nhỏ `kèm tên (Owner.Name)`.
  - Bấm **Cập nhật danh sách** để ghi lại theo thứ tự: `Id`, rồi các field đã tick theo thứ tự hiển thị. Thao tác này
    là một bước undo.
  - Khi chưa chọn org, nút bị khóa với title `Chọn org ở thanh trên trước`.
- **Đổi sObject**: field `fields`/`where`/`orderBy`/`limit` nào còn đúng giá trị mặc định hoặc preset cũ (chưa sửa tay)
  thì nhận preset của sObject mới. Alias tự đổi theo nếu vẫn còn là gợi ý tự động, giống node Record. Nếu sObject không
  có preset và đã chọn org, `fields` = `Id` + field có `nameField: true` trong describe (Case → `CaseNumber`).
- **SOQL sẽ chạy** lấy từ `derived[nodeId].soql` mà `/api/validate` trả về (do server dựng). Client không tự dựng SOQL.
- **Sửa dạng SOQL**: đặt `mode = 'soql'` và `soql` = câu SOQL đang hiển thị, trong một bước undo. Quay lại "Chọn sObject
  và field" thì giữ nguyên các ô builder như cũ (cả hai bộ khóa cùng nằm trong config, chỉ bộ của mode đang chọn được dùng).
- Chế độ **Viết SOQL** là một textarea `SOQL` cao 6 dòng, font monospace. Help:
  `Chỉ SELECT. Ví dụ: SELECT Id, Name FROM Account WHERE Industry = 'Banking' ORDER BY Id LIMIT 200. Tối đa 2000 bản ghi.`

### Inspector — Chọn bản ghi

```
● Chọn bản ghi                                                  ⧉  ✕
Chọn một bản ghi từ pool (kết quả Query hoặc bản ghi đã sinh) làm bản ghi hiện tại của alias mới. Mỗi lần chạy qua chọn lại.
Chọn từ pool        [accs (Account · đọc từ org) ▾]
Alias               [acc]
                    Node sau dùng {{acc.Name}}, hoặc Lookup "Bản ghi hiện tại" acc.
Cách chọn           [Ngẫu nhiên (có thể lặp lại) ▾]
Lọc                 [Không lọc ▾]
  Field             [AccountId      ]   ← datalist field của pool (suggest poolFields)
  Phép so sánh      [= ▾]
  So với            [{{acc.Id}}     ]
                    Giá trị cố định, hoặc {{acc.Id}} để lấy theo bản ghi ở node trước.
Khi không còn bản ghi để chọn  [Bỏ qua các node phía sau (có cảnh báo) ▾]
```

- "Cách chọn" có ba lựa chọn: `Ngẫu nhiên (có thể lặp lại)` (mặc định), `Ngẫu nhiên, không lặp lại`,
  `Lần lượt theo thứ tự (quay vòng)`.
- "Lọc" có hai lựa chọn: `Không lọc` (mặc định) và `Chỉ bản ghi thỏa điều kiện`. Ba ô Field / Phép so sánh / So với chỉ
  hiện khi chọn lọc (`showIf`).
- "Khi không còn bản ghi để chọn" có hai lựa chọn: `Bỏ qua các node phía sau (có cảnh báo)` (mặc định) và `Báo lỗi và dừng`.
- Ví dụ "Contact có sẵn của Account đang chọn": Query `cons` (Contact; Id, AccountId, LastName; WHERE `AccountId != null`)
  → … → Chọn bản ghi `con` từ `cons`, lọc `AccountId` `=` `{{acc.Id}}`.

### Field Lookup / Master-Detail

Option key giữ nguyên. Chỉ đổi nhãn, help và danh sách lựa chọn:

| Option | Trước | Sau |
| --- | --- | --- |
| `mode` = `current` | Bản ghi gần nhất của node được chọn | Bản ghi hiện tại của alias |
| `mode` = `random` | Ngẫu nhiên trong các bản ghi đã sinh | Ngẫu nhiên trong pool (đã sinh hoặc đọc từ org) |
| `mode` = `fixed` | Id có sẵn trong org | Id nhập tay |
| `ref` nhãn | Node cha (alias) | Node cha / pool (alias) |
| `ref` help | Alias của một node Record ở phía trước trong workflow. | Alias của node Record, Query hoặc Chọn bản ghi ở phía trước. Bản ghi đọc từ org cho ra Id thật. |

Danh sách trong ô `ref` có dạng `acc (Account)`, `accs (Account · đọc từ org)`, `acc2 (Account · chọn từ accs)`.
Khi chưa có pool nào, dòng trống ghi `— chưa có pool nào —`.

### Import từ org (node Record)

- Ô "Node cha" của field Lookup liệt kê cả pool của Query và Chọn bản ghi. Cuối danh sách có
  `＋ <sObject> có sẵn trong org (thêm node Query)` cho từng `referenceTo`, tối đa 3 (ví dụ `OwnerId` → `＋ User có sẵn…`,
  `＋ Group có sẵn…`).
- Thứ tự chọn sẵn:
  1. Có đúng một node Record hoặc Chọn bản ghi có sObject khớp: chọn node đó với `mode: current` (như hiện nay).
  2. Nếu không, có đúng một node Query khớp: chọn Query đó với `mode: random`.
  3. Không có node nào khớp: chọn `＋ <referenceTo[0]> có sẵn trong org`.
  4. Nhiều node khớp: để `— node cha —` như hiện nay.
- Khi bấm **Thêm field đã chọn**, mỗi sObject được chọn qua "＋ … có sẵn" sinh ra một node Query (theo preset):
  - Node được chèn giữa Bắt đầu và node đang nối sau Bắt đầu, đặt ngay dưới Bắt đầu (`y + 120`).
  - Với `RecordType`, WHERE của preset được nối thêm `AND SobjectType = '<sObject của node>'`.
  - Việc thêm field và thêm Query nằm trong cùng một bước undo.
- Hint của hộp được đổi thành: `Field bắt buộc đã được chọn sẵn. Field Lookup tự chọn node cha nếu chỉ có một node khớp
  sObject; chọn "＋ … có sẵn trong org" để dùng bản ghi có sẵn.`

### Bảng kết quả

- Dòng tóm tắt: `Contact: 20 · 20 bản ghi · seed 42 📌 · 412 ms · ↓ đọc từ dev: accs 200 (10:32) · ⟳ Đọc lại`.
  - **⟳ Đọc lại** chạy Xem trước với `refreshQueries: true`. Phím tắt **Ctrl+Shift+Enter** (thêm vào danh sách phím tắt
    ở inspector trống).
  - Khi dùng bản ghi mẫu thì hiện `↓ accs: 5 bản ghi mẫu`.
- Mỗi Query có một tab, đặt sau các tab sObject: `↓ accs · Account (200)`.
  - Tab bắt đầu bằng dòng hint `Đọc từ org "dev" lúc 10:32:05, chỉ để xem, không insert. SOQL: SELECT …`, sau đó là bảng
    như tab thường. Field quan hệ hiển thị thành cột `Owner.Name`.
  - Với bản ghi mẫu, dòng hint là `Bản ghi mẫu (Id giả) vì chưa chọn org. Chọn org để đọc dữ liệu thật.`
  - Tải CSV được như tab thường.

### Hộp xác nhận insert

```
Insert vào org?
Org: dev (a@x.com)
[cảnh báo production như hiện tại]
Giống lần xem trước (seed 42): Contact 20.
Đọc từ org, không ghi: Account 200 (accs, đọc lúc 10:32).
Nếu dữ liệu đọc được đã đổi so với lần xem trước, app sẽ dừng trước khi ghi và yêu cầu xem trước lại.
                                                         [Hủy] [Insert]
```

Nếu chưa xem trước với org này và seed này, hiện dòng hint như hiện nay và thêm `Node Query sẽ đọc org "dev" ngay trước khi insert.`
"Giống lần xem trước" giờ còn yêu cầu lần xem trước đó dùng **cùng org** (`state.lastRunOrg === state.org`).

### Thông báo (đúng câu chữ)

| Tình huống | Mức | Gắn với | Câu chữ |
| --- | --- | --- | --- |
| Chưa chọn org | cảnh báo | Query | `Chưa chọn org nên node Query "accs" dùng 5 bản ghi mẫu (Id giả). Chọn org ở thanh trên để đọc dữ liệu thật.` |
| Thiếu alias | lỗi | Query/Pick, `alias` | `Đặt alias để node khác dùng được pool này (ví dụ accs).` |
| Alias trùng | lỗi | `alias` | `Alias "acc" đã được dùng ở node khác.` (câu hiện có, áp dụng chung cho Record/Query/Chọn bản ghi) |
| sObject sai | lỗi | `sobject` | `Chưa nhập sObject hợp lệ (API name).` (câu hiện có) |
| Field sai cú pháp | lỗi | `fields` | `Field "Owner Name" không hợp lệ. Dùng API name; field quan hệ viết Owner.Name.` |
| `{{…}}` trong Query | lỗi | `where`/`orderBy`/`soql` | `Node Query không dùng được {{…}}: query chỉ chạy một lần trước khi sinh dữ liệu. Muốn lọc theo bản ghi khác (ví dụ {{acc.Id}}), dùng bộ lọc ở node Chọn bản ghi.` |
| LIMIT/ORDER BY trong WHERE | lỗi | `where` | `Đặt ORDER BY và LIMIT ở ô riêng, không viết trong "Điều kiện (WHERE)".` |
| LIMIT ngoài khoảng | lỗi | `limit` | `Số bản ghi tối đa phải là số nguyên từ 1 đến 2000.` |
| SOQL không phải SELECT | lỗi | `soql` | `SOQL phải bắt đầu bằng SELECT. Node Query chỉ đọc dữ liệu.` |
| SOQL thiếu FROM | lỗi | `soql` | `SOQL thiếu "FROM <sObject>".` |
| `FOR UPDATE/VIEW/REFERENCE` | lỗi | `soql` | `Bỏ FOR UPDATE / FOR VIEW / FOR REFERENCE: các lệnh này khóa hoặc đánh dấu bản ghi trong org.` |
| SOQL không có ORDER BY | cảnh báo | `soql` | `SOQL không có ORDER BY nên thứ tự bản ghi có thể đổi giữa các lần chạy, cùng seed có thể chọn ra bản ghi khác. Thêm ORDER BY Id.` |
| SELECT không có Id | cảnh báo | `soql` | `SOQL không lấy Id nên pool này không dùng được cho Lookup. Thêm Id vào SELECT.` |
| Có subquery | cảnh báo | `soql` | `Subquery (SELECT … FROM quan hệ con) chưa được hỗ trợ; phần đó sẽ bị bỏ qua.` |
| Query trong Lặp | cảnh báo | Query | `Query nằm trong vòng lặp vẫn chỉ đọc org một lần, trước khi sinh dữ liệu. Nên đặt Query ngay sau Bắt đầu.` |
| Quá nhiều Query | lỗi | Query thứ 21 | `Workflow có quá 20 node Query. Gộp các query cùng sObject lại (lọc bằng node Chọn bản ghi).` |
| Pool chưa ai dùng | cảnh báo | Query | `Chưa có node nào dùng pool "accs". Thêm node Chọn bản ghi hoặc chọn "accs" ở một field Lookup.` |
| Template dùng field không lấy | cảnh báo | node dùng template, `fields.<Name>` | `Template dùng {{acc.Industry}} nhưng Query "accs" không lấy field Industry. Thêm Industry vào "Field cần lấy" của node Query.` |
| Lookup `current` vào Query | lỗi | `fields.<Name>` | `Query "accs" là một pool nhiều bản ghi, không có "bản ghi hiện tại". Chọn "Ngẫu nhiên trong pool", hoặc thêm node Chọn bản ghi rồi trỏ Lookup vào alias của nó.` |
| `{{accs.Name}}` trỏ thẳng vào Query | lỗi | ô chứa template / `left` | `{{accs.Name}}: "accs" là pool nhiều bản ghi nên không biết lấy bản ghi nào. Thêm node Chọn bản ghi từ "accs" rồi dùng {{acc.Name}}; {{accs.$count}} thì dùng được.` (nếu có 0005, đây là một lỗi của scope) |
| Pick chưa chọn pool | lỗi | `from` | `Chưa chọn pool. Chọn alias của node Query hoặc Record ở phía trước.` |
| Pool không ở phía trước | lỗi | `from` | `Pool "accs" phải nằm phía trước node này trong workflow.` |
| Pick lọc thiếu field | lỗi | `filterField` | `Chưa nhập field để lọc, ví dụ AccountId hoặc Account.Type.` |
| Pick bị bỏ qua (`skip`) | cảnh báo | Pick | `Node Chọn bản ghi "acc": 7/20 lần không có bản ghi phù hợp nên đã bỏ qua các node phía sau. Đổi điều kiện lọc, tăng LIMIT của Query, hoặc chọn "Báo lỗi và dừng" nếu đây là lỗi.` |
| Pick hết bản ghi (`error`) | lỗi (khi chạy) | Pick | `Node Chọn bản ghi "acc": không còn bản ghi nào trong "accs" thỏa điều kiện (lần thứ 8). Tăng LIMIT của Query, đổi điều kiện lọc, hoặc chọn cách chọn "Ngẫu nhiên (có thể lặp lại)".` |
| Pool không có Id | lỗi (khi chạy) | `fields.<Name>` | `Field AccountId: pool "accs" không có cột Id. Thêm Id vào SELECT của node Query.` |
| Query trả 0 dòng | cảnh báo | Query | `Query "accs" không trả về bản ghi nào trong org "dev". Kiểm tra "Điều kiện (WHERE)"; Lookup và node Chọn bản ghi dùng pool này sẽ không có gì để chọn.` |
| Bị cắt ở 2000 dòng | cảnh báo | Query | `Query "accs" khớp 15 342 bản ghi nhưng chỉ lấy 2000 bản ghi đầu theo ORDER BY. Thu hẹp WHERE nếu cần đúng nhóm bản ghi.` |
| Quá thời gian | lỗi | Query | `Query "accs" chạy quá 30 giây nên đã dừng. Thêm điều kiện WHERE trên field có index (Id, Name, CreatedDate, RecordTypeId) hoặc giảm số bản ghi.` |
| Org đổi trước khi insert (409) | lỗi | Query | `Query "accs" lúc xem trước có 200 bản ghi (đọc 10:32), bây giờ đọc lại thì khác (201 bản ghi). Chưa ghi gì vào org. Bấm Xem trước để xem dữ liệu mới rồi Insert lại.` |

Lỗi Salesforce trả về khi chạy query được đổi thành issue gắn đúng ô (HTTP 422):

| `errorCode` | `field` (builder) | `field` (SOQL) | Câu chữ |
| --- | --- | --- | --- |
| `INVALID_TYPE` | `sobject` | `soql` | `Org "dev" không có sObject "Acount" hoặc bạn không có quyền đọc (INVALID_TYPE). Chọn sObject trong danh sách gợi ý.` |
| `INVALID_FIELD` | `fields` nếu tên lỗi (bắt bằng `No such column '(…)'` hoặc `relationship '(…)'`) có trong "Field cần lấy"; nếu không thì `where` hoặc `orderBy`, tùy tên đó xuất hiện ở ô nào | `soql` | `Salesforce không có field "Nme" trên Account hoặc bạn không có quyền đọc (INVALID_FIELD). Sửa tên ở "Field cần lấy" hoặc bấm "Chọn field…".` |
| `MALFORMED_QUERY` | `where` | `soql` | `SOQL sai cú pháp (MALFORMED_QUERY): <dòng cuối thông báo của Salesforce>. Kiểm tra ô "Điều kiện (WHERE)".` |
| `INVALID_QUERY_FILTER_OPERATOR` | `where` | `soql` | `Phép so sánh trong WHERE không dùng được với field này (INVALID_QUERY_FILTER_OPERATOR): <thông báo>. Sửa ô "Điều kiện (WHERE)".` |
| Mã khác (`REQUEST_LIMIT_EXCEEDED`, `QUERY_TIMEOUT`, lỗi mạng, …) | – | – | HTTP 502 `Node Query "accs": Salesforce: <code>: <thông báo>`, kèm `issues: [{ nodeId }]` để UI vẫn chọn được node |

## Ngữ nghĩa khi chạy

### Mô hình thực thi: đọc trước (pre-fetch) rồi chạy executor thuần

```
POST /api/run
  1. validateWorkflow(workflow)                          đồng bộ, không gọi org → 422 nếu có lỗi
  2. prefetchQueries(...)                                 async, server/sf/query.js
       org = target.kind === 'org' ? target.org : body.org
       với mỗi node Query đến được từ Bắt đầu (theo thứ tự duyệt, tuần tự):
         soql = buildSoql(node.config)                    server/workflow/soql.js (hàm thuần)
         không có org        → sampleRows(...), source 'sample', cảnh báo
         cache (org, soql) còn hạn và không refreshQueries → source 'cache'
         ngược lại           → client.query(org, soql, { maxFetch }) → source 'org', ghi cache
         fingerprint = sha1(JSON các dòng đã chuẩn hóa).slice(0, 8)      (node:crypto, không thêm dependency)
       expectQueries[nodeId] có và khác fingerprint → 409, dừng (chưa ghi gì)
  3. runWorkflow(workflow, { seed, maxRecords, queryResults })            vẫn thuần và đồng bộ như cũ
  4. target org → insertRecords(...) → queryCache.invalidateOrg(org)
```

- Executor **không** gọi org. Nó chỉ đọc `opts.queryResults[nodeId]`. Nếu thiếu (chỉ xảy ra khi gọi `runWorkflow` trực tiếp
  mà không truyền) thì báo lỗi gắn node: `Node Query chưa có dữ liệu: server chưa đọc org cho node này.`
- Query của node không đến được từ Bắt đầu thì không chạy, nên không tốn API call.
- Các query chạy **tuần tự**: lỗi luôn báo theo cùng một thứ tự, và không dồn nhiều request đồng thời lên org.

### Node Query khi chạy

- Mỗi lần executor đi qua node Query:
  - `scope.all[alias]` = các dòng. Các object pool chỉ dựng một lần mỗi lần chạy và được dùng lại.
  - **Không** đặt `scope.current[alias]`. Query là pool nhiều bản ghi, giống `kind: 'pool'` của 0005. Muốn dùng một bản ghi
    thì đi qua node Chọn bản ghi, hoặc Lookup "Ngẫu nhiên trong pool". Biến có sẵn duy nhất là `{{accs.$count}}` (số dòng),
    do `resolvePath` xử lý khi khóa bắt đầu bằng `$`, giống `$n` của 0005.
  - Không thêm gì vào `records`, không tính vào `maxRecords`, tính 1 bước (`maxSteps`).
- Mỗi dòng trở thành một bản ghi pool:

  ```js
  { ref: 'accs#1', sobject: 'Account', alias: 'accs', nodeId: 'q1', id: '0015g00000AbCdEAAV', existing: true,
    fields: { Id: '0015g00000AbCdEAAV', Name: 'Acme', Owner: { Name: 'Lan Nguyễn' } } }
  ```

  `fields` là dòng đã bỏ `attributes` (đệ quy). Field quan hệ được giữ dạng object lồng, nên `{{acc.Owner.Name}}` dùng
  được với `resolvePath` sẵn có.
- Query nằm trong Lặp vẫn chỉ đọc org một lần; mỗi vòng chỉ gán lại pool (có cảnh báo, xem bảng thông báo).

### Node Chọn bản ghi khi chạy

1. Ứng viên = `scope.all[from]`. Với Query là các dòng; với Record là mọi bản ghi đã sinh tới lúc đó; với Chọn bản ghi là
   mọi bản ghi đã chọn tới lúc đó.
2. Lọc (`filter: 'compare'`):
   - Vế trái là giá trị `filterField` của ứng viên, đọc theo đường dẫn có dấu chấm trong `fields`.
   - Vế phải là `filterValue` sau khi thay `{{…}}` theo cùng quy tắc với template. Giá trị `{ $ref }` thành chuỗi ref,
     bản ghi có sẵn thành Id. Vế trái cũng được chuẩn hóa như vậy.
   - So sánh bằng `compareValues(left, op, right)`, hàm được tách ra từ `evaluateCondition` nên cùng phép so sánh với Rẽ nhánh.
   - Kết quả lọc được cache theo `(giá trị vế phải, độ dài pool)` trong `fieldState` của node, để Lặp 100 000 vòng không
     lọc lại 2000 dòng ở mỗi vòng.
3. Chọn:
   - `random`: `rng.pick(ứng viên)`.
   - `unique`: `rng.pick` trong những ứng viên mà node này chưa chọn trong lần chạy (một Set theo `ref`).
   - `sequential`: con trỏ riêng của node (tách theo từng giá trị vế phải), quay vòng, không dùng rng.
4. Có bản ghi: `scope.current[alias] = rec` và `(scope.all[alias] ??= []).push(rec)`. `rec` là **chính object đó**, không
   copy, nên Lookup tới một bản ghi đã sinh vẫn ra `{ "$ref": "acc#3" }` đúng. Sau đó đi tiếp cổng `next`.
5. Không có bản ghi nào để chọn (pool rỗng, lọc không khớp, hoặc `unique` đã dùng hết):
   - `onEmpty: 'skip'`: dừng chuỗi hiện tại (trong Lặp thì sang vòng sau) và đếm lại. Cuối lần chạy thêm **một** cảnh báo
     cho node, ghi số lần bị bỏ qua.
   - `onEmpty: 'error'`: báo `WorkflowError` gắn `nodeId`.

### Lookup

- Mode `random` trên alias của Query, Record hoặc Chọn bản ghi, và mode `current` trên alias của Record hoặc Chọn bản ghi:
  bản ghi có `existing` trả về **chuỗi Id** (`rec.id`), bản ghi được sinh ra vẫn trả `{ "$ref" }` như cũ. Pool không có Id
  thì báo lỗi (xem bảng thông báo).
- Mode `current` trỏ vào alias của Query là lỗi validate, vì pool không có bản ghi hiện tại. Import từ org luôn đặt `random`
  cho Query nên người dùng không gặp lỗi này trên đường chính.
- `server/sf/insert.js` **không cần đổi logic**. Chuỗi Id đi thẳng qua `toSObject`, và `collectRefs` không coi nó là phụ
  thuộc, nên con của bản ghi có sẵn được gửi ngay ở đợt đầu. Thêm test để giữ chắc hành vi này. Bản ghi đọc từ org không
  bao giờ nằm trong `records`, nên không bao giờ bị insert lại.
- Mode `fixed` giữ nguyên để tương thích ngược.

### Tất định và độ tin cậy của "xem trước rồi insert"

- Mọi lựa chọn ngẫu nhiên đều đi qua `ctx.rng`. Query không rút số ngẫu nhiên nào, nên thêm một Query không làm lệch các
  giá trị ngẫu nhiên phía sau. Cùng workflow, cùng seed và cùng `queryResults` cho ra cùng kết quả (có test).
- Dữ liệu trong org có thể đổi giữa hai lần chạy, nên có ba lớp bảo vệ:
  1. **Thứ tự ổn định.** Builder mặc định dùng `ORDER BY Id`. SOQL tự viết mà không có ORDER BY thì có cảnh báo.
  2. **Cache.** Cache nằm trong bộ nhớ, theo khóa `(org, SOQL)`, có TTL 10 phút và tối đa 50 mục. Xem trước và insert ngay
     sau đó dùng **cùng** các dòng đã đọc. Sau khi insert vào một org, cache của org đó bị xóa, để lần xem trước sau thấy
     cả bản ghi vừa tạo. "⟳ Đọc lại" (Ctrl+Shift+Enter) bỏ qua cache.
  3. **Fingerprint.** Khi insert "giống lần xem trước" (cùng workflow, seed và org), client gửi `expectQueries`, tức các
     fingerprint của lần xem trước. Nếu cache đã hết hạn hoặc server đã khởi động lại (`npm run dev`), server đọc lại và so.
     Fingerprint khác thì trả 409 trước khi ghi bất cứ gì. Vì vậy dữ liệu insert hoặc giống hệt bản xem trước, hoặc không
     có gì được ghi.
- Bản ghi mẫu không bao giờ dùng cho insert: insert luôn có `target.org`, nên luôn đọc dữ liệu thật.

### Xem trước khi chưa có org

- Mỗi node Query trả `min(limit, 5)` dòng mẫu, tất định và không dùng rng:
  - `Id` = `mẫu:accs#1`, …
  - `Name` = `Account mẫu 1`.
  - Field khác = `<field> mẫu 1`.
  - Field quan hệ thành object lồng: `Owner.Name` → `{ Owner: { Name: 'Owner.Name mẫu 1' } }`.
- Node Query có cảnh báo vàng.
- Mục đích là để thấy được hình dạng dữ liệu và kiểm tra template, Lookup, Chọn bản ghi mà không cần org. Bộ lọc theo
  giá trị thật (ví dụ `Industry = 'Banking'`) có thể không khớp bản ghi mẫu. Khi đó cảnh báo của Chọn bản ghi sẽ hiện ra,
  nhưng cảnh báo của Query đã nói rõ lý do.

## Thay đổi dữ liệu / API

### Workflow JSON (version 1, tương thích ngược)

Hai loại node mới chỉ là phần thêm vào. `version` vẫn là `1`, workflow đã lưu chạy y như cũ và không cần migration.
File có node mới mở bằng bản cũ sẽ báo `Loại node "query" không tồn tại.`, điều này chấp nhận được.

Trước đây, để dùng Account có sẵn phải dán Id:

```json
{ "name": "AccountId", "type": "lookup", "options": { "mode": "fixed", "ids": ["0015g00000AbCdEAAV", "0015g00000AbCdFAAV"] } }
```

Sau:

```json
{
  "version": 1,
  "name": "Contact và Opportunity cho Account có sẵn",
  "seed": 42,
  "nodes": [
    { "id": "start", "type": "start", "config": {} },
    { "id": "q1", "type": "query", "config": {
        "mode": "builder", "sobject": "Account", "alias": "accs",
        "fields": ["Id", "Name", "Industry"], "where": "Industry != null", "orderBy": "Id", "limit": 200 } },
    { "id": "loop1", "type": "loop", "config": { "mode": "fixed", "count": 10, "alias": "loop" } },
    { "id": "p1", "type": "pick", "config": {
        "from": "accs", "alias": "acc", "mode": "random", "filter": "none", "onEmpty": "skip" } },
    { "id": "con", "type": "record", "config": { "sobject": "Contact", "alias": "con", "count": 2, "fields": [
        { "name": "LastName", "type": "text", "options": { "mode": "lastName" } },
        { "name": "AccountId", "type": "lookup", "options": { "mode": "current", "ref": "acc" } } ] } },
    { "id": "opp", "type": "record", "config": { "sobject": "Opportunity", "alias": "opp", "fields": [
        { "name": "Name", "type": "template", "options": { "template": "Cơ hội của {{acc.Name}}" } },
        { "name": "StageName", "type": "picklist", "options": { "values": ["Prospecting"] } },
        { "name": "CloseDate", "type": "date", "options": {} },
        { "name": "AccountId", "type": "lookup", "options": { "mode": "current", "ref": "acc" } } ] } }
  ],
  "edges": [
    { "from": "start", "to": "q1" },
    { "from": "q1", "to": "loop1" },
    { "from": "loop1", "fromPort": "body", "to": "p1" },
    { "from": "p1", "to": "con" },
    { "from": "con", "to": "opp" }
  ]
}
```

Query ở chế độ SOQL, và Chọn bản ghi có lọc:

```json
{ "id": "q2", "type": "query", "config": { "mode": "soql", "alias": "pbes",
  "soql": "SELECT Id, UnitPrice, Product2.Name FROM PricebookEntry WHERE IsActive = true AND Pricebook2.IsStandard = true ORDER BY Id LIMIT 500" } }

{ "id": "p2", "type": "pick", "config": { "from": "cons", "alias": "con", "mode": "unique",
  "filter": "compare", "filterField": "AccountId", "filterOp": "eq", "filterValue": "{{acc.Id}}", "onEmpty": "skip" } }
```

Quy tắc về alias (dự kiến, cập nhật vào `workflow-schema.md`):

- Alias của Record, Query và Chọn bản ghi dùng **chung một không gian tên**: phải duy nhất, không trùng tên biến lặp,
  không được là `this`.
- `<alias>.Field` đọc bản ghi hiện tại: với Record là bản ghi cuối vừa sinh, với Chọn bản ghi là bản ghi vừa chọn.
- Alias của Query là pool nên không có bản ghi hiện tại. Nó chỉ dùng được trong Lookup "Ngẫu nhiên trong pool", trong `from`
  của Chọn bản ghi, và qua `{{accs.$count}}`.

### Danh mục node (`server/workflow/nodes.js`, dự kiến)

```js
export const LIMITS = {
  // ...giới hạn hiện có
  maxQueryRows: 2000,         // LIMIT tối đa và maxFetch của một node Query
  maxQueryNodes: 20,          // số node Query tối đa mỗi workflow
  queryTimeoutMs: 30000,      // mỗi query
  queryCacheTtlMs: 600000,    // 10 phút, cùng TTL với token của sf CLI
};

const BUILDER = { key: 'mode', in: ['builder'] };
const SOQL = { key: 'mode', in: ['soql'] };
const FILTER = { key: 'filter', in: ['compare'] };

// Thêm vào NODE_TYPES ngay sau 'record':
{
  type: 'query',
  label: 'Query (đọc org)',
  description: 'Đọc bản ghi có sẵn trong org bằng SOQL, chỉ đọc. Kết quả là một pool cho Lookup và node Chọn bản ghi.',
  needsOrg: true, // theo đề xuất của 0003: thẻ hiện "Chưa chọn org: dùng bản ghi mẫu"; v2 thêm category: 'data', slots: []
  inputs: true,
  outputs: [{ port: 'next', label: '' }],
  options: [
    { key: 'mode', label: 'Cách nhập', kind: 'select', default: 'builder',
      choices: [{ value: 'builder', label: 'Chọn sObject và field' }, { value: 'soql', label: 'Viết SOQL' }] },
    { key: 'sobject', label: 'sObject', kind: 'string', default: 'Account', showIf: BUILDER,
      suggest: { kind: 'sobject', purpose: 'query' }, help: 'API name. Chọn org ở thanh trên để có gợi ý.' },
    { key: 'alias', label: 'Tên pool (alias)', kind: 'string', default: '',
      help: 'Lookup "Ngẫu nhiên trong pool" và node Chọn bản ghi dùng tên này. {{accs.$count}} = số bản ghi đọc được.' },
    { key: 'fields', label: 'Field cần lấy', kind: 'list', default: ['Id', 'Name'], showIf: BUILDER,
      suggest: { kind: 'fields', sobjectKey: 'sobject' },
      help: 'Mỗi dòng một field. Dùng được field quan hệ như Owner.Name. Id luôn được lấy.' },
    { key: 'where', label: 'Điều kiện (WHERE)', kind: 'string', default: '', showIf: BUILDER,
      help: "Cú pháp SOQL, ví dụ Industry = 'Banking' AND CreatedDate = LAST_N_DAYS:30. Để trống = lấy tất cả." },
    { key: 'orderBy', label: 'Sắp xếp (ORDER BY)', kind: 'string', default: 'Id', showIf: BUILDER,
      help: 'Giữ thứ tự cố định để cùng seed chọn ra cùng bản ghi.' },
    { key: 'limit', label: 'Số bản ghi tối đa (LIMIT)', kind: 'integer', default: 200, min: 1, max: LIMITS.maxQueryRows, showIf: BUILDER },
    { key: 'soql', label: 'SOQL', kind: 'text', default: '', showIf: SOQL,
      help: "Chỉ SELECT. Ví dụ: SELECT Id, Name FROM Account WHERE Industry = 'Banking' ORDER BY Id LIMIT 200. Tối đa 2000 bản ghi." },
  ],
},
{
  type: 'pick',
  label: 'Chọn bản ghi',
  description: 'Chọn một bản ghi từ pool (kết quả Query hoặc bản ghi đã sinh) làm bản ghi hiện tại của alias mới. Mỗi lần chạy qua chọn lại.',
  inputs: true,
  outputs: [{ port: 'next', label: '' }],
  options: [
    { key: 'from', label: 'Chọn từ pool', kind: 'ref', default: '', help: 'Alias của node Query hoặc Record ở phía trước.' },
    { key: 'alias', label: 'Alias', kind: 'string', default: '', help: 'Node sau dùng {{acc.Name}}, hoặc Lookup "Bản ghi hiện tại" acc.' },
    { key: 'mode', label: 'Cách chọn', kind: 'select', default: 'random', choices: [
      { value: 'random', label: 'Ngẫu nhiên (có thể lặp lại)' },
      { value: 'unique', label: 'Ngẫu nhiên, không lặp lại' },
      { value: 'sequential', label: 'Lần lượt theo thứ tự (quay vòng)' } ] },
    { key: 'filter', label: 'Lọc', kind: 'select', default: 'none', choices: [
      { value: 'none', label: 'Không lọc' }, { value: 'compare', label: 'Chỉ bản ghi thỏa điều kiện' } ] },
    { key: 'filterField', label: 'Field', kind: 'string', default: '', showIf: FILTER,
      suggest: { kind: 'poolFields', poolKey: 'from' }, help: 'Field của bản ghi trong pool, ví dụ AccountId, Industry hoặc Account.Type.' },
    { key: 'filterOp', label: 'Phép so sánh', kind: 'select', default: 'eq', choices: CONDITION_OPS, showIf: FILTER },
    { key: 'filterValue', label: 'So với', kind: 'string', default: '', showIf: FILTER, vars: 'template', // vars: theo 0005
      help: 'Giá trị cố định, hoặc {{acc.Id}} để lấy theo bản ghi ở node trước.' },
    { key: 'onEmpty', label: 'Khi không còn bản ghi để chọn', kind: 'select', default: 'skip', choices: [
      { value: 'skip', label: 'Bỏ qua các node phía sau (có cảnh báo)' },
      { value: 'error', label: 'Báo lỗi và dừng' } ] },
  ],
},
```

Preset theo sObject. Đây là kiến thức về quy ước đặt tên nên nằm ở server và được trả qua `/api/meta` dưới khóa `queryPresets`:

```js
export const QUERY_PRESETS = {
  User: { alias: 'users', fields: ['Id', 'Name', 'Email'], where: "IsActive = true AND UserType = 'Standard'" },
  Product2: { alias: 'prods', fields: ['Id', 'Name', 'ProductCode'], where: 'IsActive = true' },
  Pricebook2: { alias: 'pb', fields: ['Id', 'Name'], where: 'IsStandard = true', limit: 1 },
  PricebookEntry: { alias: 'pbes', fields: ['Id', 'Product2Id', 'UnitPrice', 'Product2.Name'],
                    where: 'IsActive = true AND Pricebook2.IsStandard = true' },
  RecordType: { alias: 'rts', fields: ['Id', 'Name', 'DeveloperName', 'SobjectType'], where: 'IsActive = true' },
  Case: { fields: ['Id', 'CaseNumber', 'Subject'] },
  Task: { fields: ['Id', 'Subject'] },
  Event: { fields: ['Id', 'Subject'] },
};
```

### Option schema: thuộc tính mới `suggest` (dự kiến)

`suggest` là gợi ý không bắt buộc để `client/js/forms.js` gắn trợ giúp lấy từ org vào control. Form vẫn được dựng hoàn toàn
từ meta. `forms.js` nhận `ctx.suggest` do inspector cung cấp; khi chưa có org, các trợ giúp này bị khóa kèm title
`Chọn org ở thanh trên trước`. Tên `suggest` được chọn để không lẫn với bộ chọn biến của 0005 (khóa `vars`,
file `client/js/picker.js`): `vars` gợi ý **biến trong workflow**, còn `suggest` gợi ý **thông tin từ org**.

| `suggest.kind` | Control | Nguồn |
| --- | --- | --- |
| `sobject` (`purpose: 'query' \| 'create'`) | datalist trên ô nhập | `GET /api/orgs/:org/sobjects?for=query` (hoặc danh sách createable như hiện nay) |
| `fields` (`sobjectKey`) | nút "Chọn field…" mở hộp chọn | `GET /api/orgs/:org/sobjects/:name/fields` |
| `poolFields` (`poolKey`) | datalist field của pool | `members` của nguồn trong `scope.sources` (0005), hoặc `derived[nodeId].fields` nếu chưa có 0005 |

Kind `ref` giữ nguyên. Chỉ mở rộng `ctx.aliases` để có cả pool của Query và Chọn bản ghi. Client đổi `recordAliases()`
thành `poolAliases()`, trả về `{ alias, sobject, nodeId, kind: 'record' | 'query' | 'pick', from? }`. Node Record cũng có
thể dùng `suggest: { kind: 'sobject', purpose: 'create' }` cho ô sObject (lợi ích phụ, không bắt buộc). Nếu 0005 xong
trước thì danh sách này lấy từ `scope.at[nodeId]` với `accepts` như 0005 mô tả, thay cho `poolAliases()`.

### Endpoint (dự kiến)

**`POST /api/run`**: request có thêm ba khóa:

```json
{ "workflow": {}, "seed": 42, "org": "dev", "refreshQueries": false,
  "expectQueries": { "q1": "9f2c1a7e" }, "target": { "kind": "org", "org": "dev" } }
```

| Khóa | Mô tả |
| --- | --- |
| `org` | Org để node Query đọc khi **xem trước**. Bị bỏ qua khi có `target`, vì lúc insert Query luôn đọc `target.org`. Không có org thì dùng bản ghi mẫu. |
| `refreshQueries` | `true` thì bỏ qua cache và đọc lại org. |
| `expectQueries` | `{ nodeId: fingerprint }` của lần xem trước. Nếu khác thì trả **409** và không ghi gì. |

Response có thêm `queries`. Các dòng đọc từ org không nằm trong `records` và `stats`:

```json
"queries": [{
  "nodeId": "q1", "alias": "accs", "sobject": "Account",
  "soql": "SELECT Id, Name FROM Account ORDER BY Id LIMIT 200",
  "org": "dev", "source": "org", "fetchedAt": "2026-10-27T10:32:05.120Z",
  "count": 200, "totalSize": 200, "truncated": false, "fingerprint": "9f2c1a7e",
  "records": [{ "Id": "0015g00000AbCdEAAV", "Name": "Acme" }]
}]
```

- `source` nhận một trong ba giá trị `org`, `cache`, `sample`.
- `fetchedAt` lấy theo giờ của server. Bước đọc trước nằm ngoài executor, nên điều này không ảnh hưởng `ctx.now`.

Mã trạng thái:

- **422** khi Salesforce từ chối query vì config sai. Body có `issues` gắn `nodeId` và `field`.
- **409** khi fingerprint không khớp. Body có `{ error, issues }`. `error` là
  `Dữ liệu trong org đã thay đổi từ lần xem trước nên bản insert sẽ khác bản đã xem. Chưa ghi gì vào org. Bấm Xem trước để xem dữ liệu mới rồi Insert lại.`,
  còn mỗi issue gắn `nodeId` của Query như trong bảng thông báo.
- **502** cho các lỗi Salesforce còn lại, như hiện nay, nhưng giờ có thể kèm `issues: [{ nodeId }]`. Bộ xử lý lỗi trong
  `server/index.js` gửi thêm `issues` khi có.

**`POST /api/validate`** trả thêm `derived`: thông tin mà server suy ra từ config. Client dùng nó cho dòng "SOQL sẽ chạy",
cho nhãn pool khi node ở chế độ SOQL, và cho `poolFields`.

```json
{ "errors": [], "warnings": [],
  "derived": { "q1": { "soql": "SELECT Id, Name FROM Account ORDER BY Id LIMIT 200", "sobject": "Account", "fields": ["Id", "Name"] },
               "p1": { "sobject": "Account", "fields": ["Id", "Name"], "from": "accs" } } }
```

**`GET /api/orgs/:org/sobjects?for=query`** trả về các sObject `queryable && !deprecatedAndHidden`, cùng dạng với danh sách
hiện có. Danh sách mặc định (không có `for`) giữ nguyên là createable. Router truyền thêm `url.searchParams` cho handler.

**`GET /api/orgs/:org/sobjects/:name/fields`** trả về mọi field, không chỉ field createable:

```json
{ "sobject": "Account", "label": "Account", "nameField": "Name",
  "fields": [{ "name": "OwnerId", "label": "Owner ID", "type": "reference", "referenceTo": ["User"],
               "relationshipName": "Owner", "filterable": true, "sortable": true }] }
```

Thứ tự: `Id`, field `nameField`, rồi theo nhãn A–Z.

**`GET /api/meta`** có thêm `queryPresets`, và `limits` có thêm `maxQueryRows`, `maxQueryNodes`, `queryTimeoutMs`,
`queryCacheTtlMs`.

### Tầng sf (dự kiến)

- `server/sf/client.js` thêm `query(target, soql, { maxFetch })`, cài là
  `call(target, (conn) => conn.query(soql, { autoFetch: true, maxFetch }))`.
  - Trong jsforce 3.12, `Query` là thenable. `autoFetch` tự theo `nextRecordsUrl` (queryMore) cho tới `maxFetch` dòng
    (mặc định của jsforce là 10 000, ở đây đặt bằng `limit` hoặc 2000). Kết quả có dạng `{ records, totalSize, done }`.
  - **Không** bao giờ đặt `scanAll`, vì nó chuyển sang `queryAll` và trả cả bản ghi đã xóa.
  - Có timeout `LIMITS.queryTimeoutMs`. Lỗi vẫn giữ `cause.errorCode` như `call` đang làm.
- `server/sf/query.js` (mới) gồm `createQueryCache({ ttlMs, maxEntries })` (với `get`, `set`, `invalidateOrg`) và
  `prefetchQueries({ client, org, workflow, cache, refresh, expect })`. Hàm thứ hai trả
  `{ results: { [nodeId]: { records, totalSize, done, soql, fetchedAt, source, fingerprint } }, summary, warnings }`, hoặc
  ném `WorkflowError` (422), lỗi 409, lỗi 502.
- `server/workflow/soql.js` (mới, thuần) gồm `buildSoql(config)`, `selectFields(config)`, `soqlSobject(config)`,
  `checkSoql(text)`, `normalizeRow(row)` và `sampleRows(config, alias)`. Các hàm này được dùng chung cho validate, pre-fetch
  và test.
- An toàn:
  - Chỉ gọi `/query`.
  - SOQL tự viết phải bắt đầu bằng `SELECT` và không có `FOR UPDATE|VIEW|REFERENCE`.
  - Không cho `{{…}}`.
  - Có trần số dòng và số node, có timeout.
  - Không bao giờ ghi gì vào org.
  - Đọc từ org production là thao tác chỉ đọc nên không cần hộp xác nhận. Hộp xác nhận insert vẫn liệt kê những gì đã đọc.

### Tài liệu tham chiếu cần cập nhật (dự kiến, implementer làm khi code xong)

Theo quy tắc phối hợp, doc này **không** sửa các file dưới đây. Đây là danh sách việc cần làm:

- `docs/workflow-schema.md`: thêm dòng `query` và `pick` vào bảng Node; thêm mục ngữ nghĩa cho hai node; quy tắc alias
  chung; cú pháp `<alias>.Field` cho pool; các khóa request `org`, `refreshQueries`, `expectQueries`; `queries` trong kết quả;
  mã 409; `derived` của `/api/validate`.
- `docs/org-connection.md`: thêm mục "Đọc dữ liệu (Query)" (jsforce `conn.query`, `autoFetch`/`maxFetch`, cache, fingerprint,
  ánh xạ mã lỗi); hai endpoint mới; bỏ "tìm bản ghi có sẵn bằng SOQL (`conn.query`)" khỏi dòng "Chưa làm".
- `docs/field-types.md`: nhãn mới của mode Lookup; Lookup tới pool đọc từ org cho ra Id thật.
- `docs/architecture.md`: thêm bước pre-fetch vào sơ đồ; thêm các giới hạn mới vào bảng `LIMITS`; ghi rõ "executor vẫn thuần,
  dữ liệu query được đọc trước ở `server/sf/query.js`".
- `CLAUDE.md` (mức kiến trúc): một ý ở "Architecture" về việc Query được đọc trước còn executor nhận `queryResults`.
- `docs/design/README.md`: thêm dòng 0006 với trạng thái `Nháp`.

## Checklist tiện dụng

- [x] 1. **Chạy được ngay với mặc định.** Node Query mới (Account; Id, Name; ORDER BY Id; LIMIT 200) chạy được ngay, kể cả
  khi chưa có org (bản ghi mẫu). Node Chọn bản ghi tự điền pool và alias. Riêng node Chọn bản ghi thêm khi chưa có pool nào
  thì báo lỗi "Chưa chọn pool…", vì không có gì để chọn; thông báo nói rõ cách sửa.
- [x] 2. **Ít thao tác.** Import từ org chỉ cần một tick để có "Account có sẵn". Palette tự nối và tự điền `from`/`alias`.
  Có thêm phím tắt Ctrl+Shift+Enter để đọc lại.
- [x] 3. **Xem trước trước khi ghi.** Query chỉ đọc. Hộp xác nhận liệt kê cả phần đọc lẫn phần sẽ ghi. Fingerprint bảo đảm
  dữ liệu insert giống bản xem trước, nếu không thì không ghi gì. Cảnh báo production giữ nguyên.
- [x] 4. **Lỗi chỉ đúng chỗ.** Lỗi Salesforce (`INVALID_FIELD`, …) được đổi thành issue gắn đúng ô (`fields`/`where`/`soql`).
  Lỗi lúc chạy của Chọn bản ghi gắn node. Mọi câu đều nói cách sửa.
- [x] 5. **Không mất công sức.** Mọi thay đổi (kể cả "Sửa dạng SOQL", thêm Query từ Import) đều có undo. Đổi alias thì cập
  nhật `from`, `filterValue`, Lookup, template và điều kiện Rẽ nhánh. Builder và SOQL giữ cả hai bộ giá trị khi đổi qua lại.
- [x] 6. **Lấy từ org.** Có datalist sObject queryable, hộp chọn field từ describe, `nameField`, preset cho
  User/Product2/Pricebook2/PricebookEntry/RecordType, và tự chọn pool theo `referenceTo` khi Import.
- [x] 7. **Một nguồn sự thật.** Option, preset và `LIMITS` nằm ở server. SOQL do server dựng (`derived`). Trợ giúp UI được
  khai báo bằng `suggest` trong option schema. Biến do node đưa ra được khai báo theo `exposes` của 0005. Ngoại lệ có chủ đích: quy tắc gợi ý alias (`accs` → `acc`) nằm ở client, giống
  `suggestAlias` hiện nay, vì đó chỉ là cách đặt tên mặc định và không ảnh hưởng ngữ nghĩa.
- [x] 8. **Giải thích tại chỗ.** Mỗi ô khó đều có `help` kèm ví dụ cú pháp (WHERE, `{{acc.Id}}`, `Owner.Name`). Có dòng
  "SOQL sẽ chạy" ngay dưới builder.
- [x] 9. **An toàn khi lỡ tay.** Chỉ SELECT, không `queryAll` và không `FOR UPDATE`. Trần 2000 dòng mỗi Query, tối đa 20
  Query, timeout 30 giây, cache tối đa 50 mục. Bộ lọc của Chọn bản ghi có cache để vòng lặp lớn không làm treo server.

## Phương án đã cân nhắc

Mô hình thực thi:

| Phương án | Ưu | Nhược | Chọn? |
| --- | --- | --- | --- |
| (a) Đọc trước mọi Query rồi chạy executor thuần với `queryResults` | Executor vẫn thuần và đồng bộ, test chỉ cần tiêm kết quả. "Ảnh chụp" dữ liệu có sẵn (cache + fingerprint). Mỗi Query chỉ tốn đúng 1 API call. Hợp với cả 0004. | Query không phụ thuộc được giá trị lúc chạy. Query trong Lặp không chạy lại, nên phải cảnh báo. | **Có** |
| (b) Executor async, chạy query ngay tại node | Cho phép `WHERE AccountId = '{{acc.Id}}'` | Query trong Lặp 1000 vòng thành 1000 API call (tốn giới hạn API trong 24 giờ, chậm). Dữ liệu không ổn định giữa các vòng. Phải viết lại executor và mọi test. Bản ghi sinh ra chưa có Id nên phụ thuộc vào chúng vô nghĩa. | Không (xem lại sau 0004) |
| (c) UI tự query rồi nhúng các dòng vào workflow JSON | Server không cần đổi luồng chạy | Workflow phình to, lưu luôn dữ liệu org vào file. Trùng logic jsforce ở client. Trái quy tắc "mọi API đi qua `server/sf/client.js`". | Không |

Thay cho query phụ thuộc: query rộng một lần, rồi **lọc trong bộ nhớ** bằng node Chọn bản ghi (`filterValue: {{acc.Id}}`).

Cách nhập Query:

| Phương án | Ưu | Nhược | Chọn? |
| --- | --- | --- | --- |
| Chỉ SOQL tự viết | Linh hoạt nhất, ít UI | Phải nhớ cú pháp và tên field; không có mặc định chạy được ngay; khó gắn lỗi vào đúng ô | Không |
| Chỉ builder | Dễ, gợi ý được từ describe | Không viết được `TYPEOF`, `FIELDS(STANDARD)`, `OFFSET`, … | Không |
| Builder làm mặc định, thêm chế độ SOQL, "Sửa dạng SOQL" để chuyển sang | Việc hay làm thì dễ, việc khó vẫn làm được, học cú pháp qua dòng "SOQL sẽ chạy" | Có hai bộ khóa trong config | **Có** |
| Builder có WHERE dạng có cấu trúc (field/op/value) | Validate được trước | Nhiều UI; khó với AND/OR lồng nhau và literal ngày (`LAST_N_DAYS:30`) | Không (WHERE dạng text kèm ví dụ) |

Cách dùng pool:

| Phương án | Ưu | Nhược | Chọn? |
| --- | --- | --- | --- |
| Chỉ mở rộng Lookup cho pool Query (không có node Chọn bản ghi) | Ít node nhất, đủ cho "cha ngẫu nhiên" | Không dùng chung **một** bản ghi cho nhiều node; không có `{{acc.Name}}` của bản ghi đã chọn; không lọc được | Không (riêng phần này vẫn làm) |
| Lookup đọc được pool **và** có node Chọn bản ghi | Đường ngắn cho việc đơn giản (Lookup ngẫu nhiên), có node riêng cho việc cần "cùng một bản ghi" | Hai cách làm gần giống nhau, cần help rõ | **Có** |

Khi không còn gì để chọn:

| Phương án | Ưu | Nhược | Chọn? |
| --- | --- | --- | --- |
| Luôn báo lỗi | Rõ ràng | Lọc kiểu "Contact của Account này" thường có lúc rỗng, báo lỗi thì phiền | Không |
| Thêm cổng ra thứ hai `không có` | Rẽ nhánh được khi rỗng | Canvas rối hơn; hầu như ai cũng chỉ cần "bỏ qua" | Không (có thể thêm sau) |
| Option `onEmpty`: bỏ qua có cảnh báo (mặc định) hoặc báo lỗi | Đơn giản, có cảnh báo tổng hợp | Không làm được việc khác khi rỗng | **Có** |

Giữ "xem trước = insert" khi có Query:

| Phương án | Ưu | Nhược | Chọn? |
| --- | --- | --- | --- |
| Luôn đọc lại và chỉ cảnh báo | Đơn giản | Có thể insert dữ liệu khác với bản đã xem, trái nguyên tắc 3 | Không |
| Client gửi lại các dòng đã xem trong request insert | Server không cần lưu trạng thái | Request nặng; server phải tin dữ liệu từ client | Không |
| Cache ở server theo (org, SOQL) + fingerprint, khác thì 409 | Insert dùng đúng dữ liệu đã xem, và nếu khác thì không ghi gì | Server có trạng thái nhỏ trong bộ nhớ | **Có** |
| Lưu ảnh chụp vào workflow JSON | Tái lập được qua nhiều phiên | File chứa dữ liệu org (có thể là PII); phình to | Không |

Khi chưa có org:

| Phương án | Ưu | Nhược | Chọn? |
| --- | --- | --- | --- |
| Báo lỗi "chọn org" | Không bao giờ có dữ liệu giả | Workflow có Query không xem trước được, trái nguyên tắc 1 | Không |
| 5 dòng mẫu tất định kèm cảnh báo | Luôn xem trước được; insert vẫn cần org nên không có rủi ro | Bộ lọc theo giá trị thật có thể không khớp | **Có** |

Query là node hay nguồn dữ liệu cấp workflow:

| Phương án | Ưu | Nhược | Chọn? |
| --- | --- | --- | --- |
| Node trong luồng | Người dùng yêu cầu; nằm cạnh nơi dùng; thêm bằng palette; cùng quy tắc "phía trước" với Lookup | Đặt trong Lặp dễ hiểu nhầm là chạy lại (đã có cảnh báo) | **Có** |
| `sources[]` cấp workflow (ngoài đồ thị) | Đúng bản chất "chạy một lần" | Thêm một khu vực UI mới; khó thấy; đổi schema | Không (0003 có thể hiển thị Query thành nhóm "Nguồn dữ liệu" ở đầu) |

## Các node khác (đánh giá nhanh)

| Ứng viên | Đánh giá | Khuyến nghị |
| --- | --- | --- |
| Lặp "mỗi bản ghi trong pool" (`loop.mode: 'each'`, option `pool`) | "Mỗi Account có sẵn tạo 3 Contact" rất hay gặp, mà Chọn bản ghi `sequential` không làm trọn được vì người dùng không biết pool có bao nhiêu dòng. Việc làm nhỏ: mỗi vòng gán `scope.current[pool]` = dòng thứ i, `{{loop.count}}` = kích thước pool. | **Làm tiếp ngay sau 0006**, hoặc gộp vào 0006 (câu hỏi mở 5) |
| Xóa dữ liệu vừa insert | Là hành động ở bảng kết quả, không phải node. Dùng `insert.ids` + `conn.sobject(type).destroy`, xóa theo thứ tự ngược các đợt (con trước cha). Có xác nhận ghi rõ org và số bản ghi. | **Nên làm sớm** (dọn dữ liệu test); cần design doc riêng |
| Cập nhật bản ghi có sẵn (Update) | Dùng pool của Query để sửa field của bản ghi có sẵn. Rủi ro cao hơn insert vì sửa dữ liệu người khác: cần hộp xác nhận riêng "sẽ **sửa** N bản ghi có sẵn" và cảnh báo production mạnh hơn. | Làm sau, design doc riêng |
| Upsert theo External Id | Hợp lý hơn nếu là option của node Record (`upsertKey`) thay vì node mới; giúp chạy lại mà không bị trùng. | Design doc riêng, ưu tiên trung bình |
| Đặt biến (Set variable) | Ví dụ mã lô `RUN-{{seed}}` dùng chung để lọc hoặc xóa sau. Template và Giá trị cố định đã làm được phần lớn. | Chờ 0005 (biến) rồi xét |
| Sub-workflow | Cần thư viện workflow có tên, hiện chưa có. | Chưa |
| Delay | Không có ý nghĩa với việc sinh dữ liệu; tốc độ insert do `insert.js` lo. | Không |
| Query phụ thuộc (chạy mỗi lượt) | Tốn API; bộ lọc của Chọn bản ghi đã thay được. | Chưa; xem lại sau 0004 nếu có nhu cầu thật (có cache theo SOQL và trần số lần gọi) |

## Kế hoạch thực hiện

Theo bảng đồng bộ hợp đồng trong `.claude/agents/implementer.md` và skill `add-node-type`. Mỗi bước tự chạy được
`npm test`.

1. **Hàm SOQL thuần**: tạo `server/workflow/soql.js` gồm `buildSoql`, `selectFields`, `soqlSobject`, `checkSoql`,
   `normalizeRow`, `sampleRows`.
   Test `test/soql.test.js` (mới): `buildSoql adds Id once, ORDER BY and LIMIT`,
   `checkSoql rejects non-SELECT, FOR UPDATE and {{ }}`, `selectFields parses relationship fields and ignores subqueries`,
   `sampleRows is deterministic and nests relationship fields`.
2. **Danh mục và meta**: trong `server/workflow/nodes.js` thêm `query`, `pick`, các khóa mới của `LIMITS` và `QUERY_PRESETS`.
   Trong `server/generators/reference.js` đổi nhãn và help của Lookup. Trong `server/index.js`, `/api/meta` trả thêm
   `queryPresets`.
   Test: sửa phép kiểm danh sách node trong `test/server.test.js` thành
   `['start', 'record', 'query', 'pick', 'loop', 'branch']`.
3. **Validate** (`server/workflow/schema.js`): không gian alias chung cho Record/Query/Pick; validate config Query (builder và
   SOQL); validate Pick (`from` phải ở phía trước, alias, lọc); Lookup `ref` nhận pool; các cảnh báo (Query trong Lặp, pool chưa
   ai dùng, template dùng field không lấy); các lỗi (Lookup `current` vào Query, `{{accs.Field}}` trỏ thẳng vào pool);
   `derived`; trần `maxQueryNodes`. Nếu 0005 đã có thì khai báo `flow`/`exposes` cho hai node và để `scope.js` báo các lỗi
   về biến, thay vì viết riêng.
   Test `test/workflow.test.js`: `validation: query config errors carry nodeId and field`,
   `validation: pick needs an upstream pool`, `validation: template using a field the query does not select warns`,
   `validation: aliases are unique across record, query and pick`.
4. **Executor**: trong `server/workflow/executor.js` thêm case `query` và `pick`, nhận `opts.queryResults`, cảnh báo tổng hợp
   cho `skip`. Trong `server/workflow/conditions.js` tách `compareValues`. Trong `server/workflow/paths.js` thêm `getPath`.
   Trong `server/generators/reference.js`, bản ghi `existing` trả về Id.
   Test `test/workflow.test.js`: `query pool feeds lookups with real Ids and rows are not output records`,
   `pick random, unique and sequential are reproducible with a seed`,
   `pick filter with {{acc.Id}} selects children of the current parent`,
   `pick onEmpty skip warns once, error fails with nodeId`, `pick from a record pool keeps $ref`.
5. **Query qua jsforce, pre-fetch và cache**: trong `server/sf/client.js` thêm `query()` (có timeout). Tạo
   `server/sf/query.js` (`createQueryCache`, `prefetchQueries`, fingerprint, ánh xạ mã lỗi).
   Test `test/sf.test.js` dùng `fakeJsforce()` có thêm `query()`: `prefetch maps INVALID_FIELD to an issue on fields`,
   `prefetch without org returns sample rows with a warning`,
   `cache is reused, bypassed by refresh and cleared after insert`, `expectQueries mismatch is a 409 before any write`.
   Test `test/jsforce.test.js` dùng Salesforce giả có `/query?q=` và `nextRecordsUrl`:
   `real jsforce: query follows nextRecordsUrl and stops at maxFetch, never calls queryAll`.
6. **HTTP** (`server/index.js`): `/api/run` thêm pre-fetch, `org`, `refreshQueries`, `expectQueries`, 409 và xóa cache sau
   insert; `/api/validate` trả `derived`; thêm `?for=query` và `/fields`; bộ xử lý lỗi gửi kèm `issues` cho 502.
   Test `test/server.test.js` (client giả có `query`, `describe`, `describeGlobal`):
   `POST /api/run with a query node returns queries[] and real Ids`,
   `insert reuses the previewed query rows; changed org data gives 409 and inserts nothing`,
   `GET /api/orgs/:org/sobjects?for=query lists queryable objects`, `GET /api/orgs/:org/sobjects/:name/fields`.
7. **Insert**: `server/sf/insert.js` không đổi code.
   Test `test/sf.test.js`: `insertRecords sends existing Ids as-is in the first wave`.
8. **Phần dữ liệu ở client**:
   - `client/js/api.js`: `run` nhận `org`, `refreshQueries`, `expectQueries`; thêm `sobjects(org, { for })` và `fields(org, name)`.
   - `client/js/store.js`: `poolAliases()` thay cho `recordAliases()`; `suggestPoolAlias`/`suggestPickAlias`;
     `state.derived`, `state.lastRunOrg`.
   - `client/js/main.js`: gửi `org`/`expectQueries`; Ctrl+Shift+Enter; các dòng mới trong hộp xác nhận; xử lý 409 (chọn node
     từ `issues`).
9. **Giao diện ở client**:
   - `client/js/canvas.js`: `nodeSummary`, badge alias, mặc định khi `addNode` (`from`/`alias`), alias mới khi nhân bản.
   - `client/js/forms.js`: `suggest`, dòng trống của `ref`.
   - `client/js/inspector.js`:
     - Node Query: khung "SOQL sẽ chạy", "Sửa dạng SOQL", hộp chọn field, preset khi đổi sObject, khung báo chưa có org.
     - `renameAlias`: cập nhật thêm `from` và `filterValue`.
     - Import: lựa chọn "＋ … có sẵn trong org" và chèn Query sau Bắt đầu.
   - `client/js/results.js`: tab `↓ alias`, chip tóm tắt, "⟳ Đọc lại".
   - `client/css/app.css`: không cần màu mới; token `--step-query*`, `--step-pick*`, icon `--ico-query`/`--ico-pick` và luật `[data-type="query"|"pick"]` đã có từ 0008 (`test/css-tokens.test.js` kiểm cả hai).
10. **Mẫu**: trong `client/js/samples.js` thêm mẫu "Contact cho Account có sẵn" (Query → Lặp → Chọn bản ghi → Contact). Khi
    chưa có org, mẫu này xem trước bằng bản ghi mẫu.
11. **Smoke test** (skill `smoke-test`), làm khi chưa có org:
    - Mở mẫu mới, Ctrl+Enter. Thấy tab `↓ accs` có 5 bản ghi mẫu và cảnh báo trên node Query.
    - Chọn node Query, bấm **Chọn bản ghi** ở palette. `from` = `accs` và alias = `acc` được điền sẵn.
    - Gõ `{{` vào WHERE thì ô có viền đỏ.
12. **Tài liệu**: cập nhật danh sách ở mục "Tài liệu tham chiếu cần cập nhật", điền mục "Đã làm" và trạng thái trong
    `docs/design/README.md`.

## Phụ thuộc với 0003 / 0004 / 0005

- **0003 (chế độ Quy trình, JSON v2 dạng cây `steps`).** Doc này **xác nhận** các giả định của 0003: Query và Chọn bản ghi là
  bước thường (`slots: []`, `category: 'data'`), có alias như Record, tóm tắt bằng `summary`, và có cờ `needsOrg: true` ở
  Query. Doc này khác 0003 ở một điểm: khi chưa chọn org, Query **không báo lỗi** mà dùng bản ghi mẫu và cảnh báo (câu hỏi mở 1).
  Vì vậy thẻ hiện `Chưa chọn org: dùng bản ghi mẫu` thay cho `Cần chọn org`.
  - Ví dụ JSON trong doc này viết theo v1 (`nodes`/`edges`). Ở v2, chúng là các phần tử của `steps`, còn config giữ nguyên.
    Migration v1 → v2 chỉ chép nguyên config.
  - "Pool phải ở phía trước" theo quy tắc "phía trước" / `availableAt()` của 0003. Pre-fetch duyệt mọi bước Query đang bật
    (`disabled` thì bỏ qua). Executor thêm case vào `runSteps` thay cho `runChain`.
  - Import từ org "＋ … có sẵn" chèn Query thành **bước đầu tiên** của `steps` gốc (v1: sau node Bắt đầu).
  - Lặp "mỗi bản ghi trong pool" (Việc tiếp theo) đúng là một `mode: 'each'` của Lặp như 0003 đề xuất. Tên option đề xuất
    là `pool`, không phải `source`, để không trùng thuật ngữ `source` của 0005.
  - Thứ tự làm: 0003 đề nghị làm bước 1–3 của nó trước, rồi 0006 viết trên v2. Doc này làm được theo cả hai thứ tự, vì phần
    lớn công việc (soql.js, pre-fetch, cache, jsforce, Lookup ra Id thật, UI inspector) không phụ thuộc vào dạng đồ thị.
  - Gợi ý cho 0003: đặt các Query thành nhóm "Nguồn dữ liệu" ở đầu, vì chúng chỉ chạy một lần.
- **0004 (stream, executor có thể thành async/async iterator).** Pre-fetch là "bước 0" trước khi stream. Stream nên phát sự
  kiện tiến độ `Đang đọc Query "accs" từ dev…` và trả `queries[]` trong sự kiện đầu (cần cho fingerprint). Kể cả khi executor
  thành async, **vẫn giữ** pre-fetch: executor không gọi Salesforce. Cache và fingerprint phải chạy trước khi bản ghi đầu tiên
  được ghi.
- **0005 (chọn biến, hợp đồng `flow`/`exposes`).** 0005 đã chọn khóa `exposes` (không dùng `outputs` vì đó là cổng ra) và có
  ghi giả định cho 0006. Doc này **xác nhận** các phần sau:
  - Query có `kind: 'pool'`, `lookupTarget: 'org'` và builtin `$count`.
  - Pool không có bản ghi hiện tại. Doc này đã bỏ ý "`{{accs.Name}}` = dòng đầu" cho khớp với 0005.

  Còn bốn chỗ cần 0005 chỉnh:

  ```js
  // query
  { flow: { kind: 'sequence', next: 'next' },
    exposes: { kind: 'pool', name: { key: 'alias' }, visibleIn: 'downstream', lookupTarget: 'org',
               label: queryLabel,      // hàm ở server: builder → config.sobject; SOQL → sObject sau FROM
               members: queryMembers,  // hàm ở server: selectFields(config) → [{ key: 'Name', valueType: 'string' },
                                       //   { key: 'Owner', valueType: 'object', members: [{ key: 'Name' }] }]
               open: openForSoql,      // true khi SOQL có FIELDS(...)/TYPEOF
               builtins: [{ key: '$count', valueType: 'number', label: 'Số bản ghi đọc được' }] } }
  // pick
  { flow: { kind: 'sequence', next: 'next' },
    exposes: { kind: 'record', name: { key: 'alias' }, visibleIn: 'downstream',
               members: { fromSource: 'from' }, lookupTarget: { fromSource: 'from' } } }
  ```

  1. **Tên.** Loại node là `pick` (không phải `pickRecord`) và option nguồn là `from` (không phải `source`), vì `source` đã là
     thuật ngữ của 0005 (`scope.sources`, `refs[].source`). Nếu người dùng muốn theo tên của 0005 thì chỉ cần đổi tên trước
     khi code (câu hỏi mở 10).
  2. **`members`/`label` của Query phải tính được từ config bằng hàm ở server.** `config.fields` của Query là danh sách chuỗi
     (không phải field spec), và ở chế độ SOQL thì phải parse. Cách làm giống `minIterations` của Loop: hàm chỉ có ở server
     và bị bỏ khỏi `/api/meta`. Khi chưa có describe thì kiểu là `string` (`Id` là `reference`).
  3. **`lookupTarget` của Chọn bản ghi phải lấy theo nguồn**: `{ fromSource: 'from' }`. Chọn từ pool của Record thì Lookup ra
     `{ $ref }`, chọn từ Query thì ra Id thật. Không cố định là `org`.
  4. **`accepts`**: `from` của Chọn bản ghi nhận `{ kinds: ['pool', 'record'] }`, vì chọn từ bản ghi đã sinh cũng hợp lệ.
     Lookup `ref` với mode `current` chỉ nhận `record`.

  Ngoài ra:
  - `filterValue` khai báo `vars: 'template'` để bộ chọn biến của 0005 gắn vào. `filterField` là đường dẫn trong bản ghi của
    pool, không phải biến của scope, nên dùng `suggest: poolFields`.
  - Nếu 0005 xong trước: `derived.fields` không cần nữa (dùng `scope.sources[id].members`). Chỉ còn `derived.soql` và
    `derived.sobject` cho dòng "SOQL sẽ chạy". Cảnh báo "template dùng field không lấy" trở thành lỗi `unknownMember` của 0005.

## Câu hỏi mở

1. **Khi chưa có org**: dùng 5 bản ghi mẫu kèm cảnh báo (đề xuất), hay báo lỗi bắt chọn org?
2. **Cache khi xem trước**: dùng cache 10 phút kèm "⟳ Đọc lại" và xóa cache sau insert (đề xuất, xem trước nhanh), hay lần
   xem trước nào cũng đọc lại org (dễ hiểu hơn, mỗi lần chậm hơn khoảng 0,3–1 giây cho mỗi Query)?
3. **Org đổi giữa xem trước và insert**: chặn bằng 409 (đề xuất), hay chỉ cảnh báo rồi vẫn insert?
4. **Mặc định `onEmpty`**: "Bỏ qua (cảnh báo)" (đề xuất) hay "Báo lỗi và dừng"?
5. **Lặp "mỗi bản ghi trong pool"**: gộp vào 0006 hay để một doc riêng ngay sau?
6. **Trần 2000 dòng mỗi Query** có đủ không? Muốn nhiều hơn thì `maxFetch` lên tới 10 000 (5 lần queryMore) và cache tốn bộ
   nhớ hơn.
7. **Pool không có "bản ghi hiện tại"** (khớp với 0005): `{{accs.Name}}` và Lookup `current` vào Query là lỗi, kèm hướng
   dẫn thêm node Chọn bản ghi. Đồng ý chứ? Phương án kia là cho "dòng đầu" (tiện hơn một chút cho Pricebook chuẩn với
   LIMIT 1), nhưng dễ hiểu nhầm khi pool có nhiều dòng.
8. **Giá trị số từ tham chiếu**: `{{pbe.UnitPrice}}` qua Template ra chuỗi. Có cần một kiểu field "Giá trị từ tham chiếu"
   giữ nguyên kiểu (số, boolean) để gán `OpportunityLineItem.UnitPrice` không, hay Template trả giá trị gốc khi mẫu chỉ có
   đúng một `{{…}}`? Cách sau thay đổi hành vi hiện có.
9. **Chọn N bản ghi một lần / trọng số theo field** (ví dụ chọn theo `NumberOfEmployees`): để sau, hay cần ngay?
10. **Tên khi khớp với 0005**: giữ `pick`/`from` (đề xuất; `source` đã là thuật ngữ của 0005), hay theo giả định của 0005
    là `pickRecord`/`source`? Ngoài ra 0005 cần chấp nhận `members`/`label` dạng hàm ở server cho Query và
    `lookupTarget: { fromSource }` cho Chọn bản ghi.

## Đã làm

Đợt 4 của [0007](0007-tong-hop-0003-0006.md), làm **sau** 0003 đợt A và 0005, nên mọi chỗ viết cho đồ thị v1 được chuyển sang
cây v2: Query và Chọn bản ghi là bước thường trong `steps`/`slots` (`category: 'data'`, `slots: []`), thêm bằng palette hoặc
menu "+" của chế độ Quy trình (không có canvas), pre-fetch duyệt mọi bước Query **không tắt** theo thứ tự đọc.

Commit trên nhánh `claude/salesforce-data-generator-xt3u27`:

| Commit | Nội dung |
| --- | --- |
| `aa9c8ba` Add Query and Chọn bản ghi steps: SOQL helpers, validation, executor and pre-fetch | Bước 1–7: `shared/soql.js`, danh mục + `LIMITS` + `QUERY_PRESETS`, validate, executor, `server/sf/query.js` (pre-fetch, cache, dấu vân tay, ánh xạ lỗi), `client.query`, endpoint, field type "Lấy từ biến", sửa mặc định số lần lặp; test |
| `f181163` Add the Query and Chọn bản ghi UI | Bước 8–11: inspector, Import từ org, forms (`suggest`), kết quả, hộp xác nhận, 409, mẫu mới, smoke test luồng 5c |
| (commit tài liệu) | Bước 12: `workflow-schema.md`, `field-types.md`, `org-connection.md`, `architecture.md`, `ui-design-system.md`, `CLAUDE.md` (mức kiến trúc), skill `add-node-type`/`smoke-test`, doc này, 0007, README |

**Đã có:** mọi mục của kế hoạch 1–12, gồm cả câu hỏi mở 8 (0007: "Có", xem quyết định 12) và các quyết định nhỏ của 0007
(cache 10 phút + "⟳ Đọc lại", 409, `onEmpty` mặc định "Bỏ qua", 2 000 dòng mỗi Query).

**Khác với thiết kế, và quyết định ở chỗ doc chưa rõ** (theo đề xuất của doc này hoặc 0007):

1. **Hàm SOQL ở `shared/soql.js`**, không phải `server/workflow/soql.js`: `analyzeScope` (ở `shared/`) cần `selectFields`
   cho member của Query (0005 đã ghi "nếu `analyzeScope` ở `shared/` thì `selectFields` cũng phải đặt ở `shared/`"). Vì vậy dòng
   "SOQL sẽ chạy" dùng thẳng `buildSoql` (cùng hàm server chạy, hiện ngay khi gõ). `/api/validate` vẫn trả `derived` đúng dạng
   doc (Query: `soql`, `sobject`, `fields`; Chọn bản ghi: `sobject`, `fields`, `from`, lấy từ `scope.sources`).
2. **Hợp đồng nguồn theo 0005/0007**, không theo bản nháp này: Query là `kind: 'record'`, `current: 'none'`, `pool: true`,
   `origin: 'org'`, `members: 'select'`, builtin `$count`; Chọn bản ghi `current: 'picked'`, `members`/`label`/`origin` =
   `{ fromSource: 'from' }`. Không có `kind: 'pool'`/`lookupTarget` (giả định 2 của [0010](0010-lap-theo-ban-ghi.md)). Chọn bản ghi
   **không** kế thừa builtin (`$count`, `$n`) của nguồn (giả định 7 của 0010); kế thừa `open` của Query có `FIELDS(...)`.
3. **Pool của Query trong executor** đúng như giả định 4 của 0010: `scope.all[alias]` là mảng dựng một lần mỗi lần chạy, mỗi
   phần tử `{ ref: 'accs#1', sobject, alias, nodeId, id, existing: true, fields }`; Query không đặt `scope.current`.
4. **Pool giữ bản ghi đầy đủ** (mâu thuẫn 1 của 0007): 0004 chưa làm nên mọi pool vẫn giữ bản ghi đầy đủ như trước. Khi làm 0004,
   alias là `from` của một Chọn bản ghi (và của Lặp `each` của 0010) phải giữ bản ghi đầy đủ; test `pick from a record pool keeps
   $ref` khóa hành vi này.
5. **"Bỏ qua các bước phía sau" trên cây:** dừng phần còn lại của lượt hiện tại **tới thân Lặp gần nhất** (sang lần lặp sau),
   đi xuyên qua Rẽ nhánh; ở dãy gốc thì dừng lần chạy. Cách này giống "chuỗi phía sau" của đồ thị v1 (chuỗi đi qua điểm gộp tới
   hết thân vòng lặp). Option có thêm help `Bỏ qua: các bước còn lại của lượt này không chạy (trong Lặp thì sang lần lặp sau).`
6. **Template dùng field Query không lấy là lỗi** `unknownMember` (0007 mâu thuẫn 3), câu của doc này:
   `Field "Title": Template dùng {{acc.Industry}} nhưng Query "accs" không lấy field Industry. Thêm Industry vào "Field cần lấy" của bước Query.`
   (với Chọn bản ghi, câu nêu tên Query gốc). Nút sửa nhanh "Thêm `<Field>` vào SELECT" chưa làm.
7. **Câu chữ:** "node" đổi thành "bước" ở mọi câu của bảng "Thông báo". Thêm hoặc chỉnh:
   - `Pool "accs" phải nằm phía trước bước này trong workflow. Kéo bước "accs" lên phía trên hoặc chọn pool khác.` (thêm cách sửa);
     `unknownName`/`otherBranch`/`disabled` của `from` dùng câu "pool" của 0010 để Lặp `each` dùng chung;
   - `{{accs.Name}}` (`noCurrent`) đổi sang câu của doc này, thay câu tạm của 0005; gợi ý alias bỏ chữ `s` cuối (`acc`);
   - LIMIT trong ô ORDER BY: `Đặt LIMIT ở ô "Số bản ghi tối đa (LIMIT)", không viết trong "Sắp xếp (ORDER BY)".`; `FOR UPDATE`
     viết trong WHERE dùng câu `forClause` gắn ô `where`; `MALFORMED_QUERY`/`INVALID_QUERY_FILTER_OPERATOR` ở chế độ SOQL nói
     `Kiểm tra ô "SOQL"`; tên field lỗi trong `pick.filterField`: `Field "x" không hợp lệ. Dùng API name; field quan hệ viết Account.Type.`;
   - tên biến lặp trùng alias nói rõ loại bước (`… trùng alias của một bước Query (đọc org)`);
   - quá 30 giây là lỗi 422 gắn bước Query (không phải 502), vì người dùng sửa được bằng WHERE.
8. **`expectQueries`** nhận chuỗi fingerprint (như doc) hoặc `{ fingerprint, count, fetchedAt }`; UI gửi dạng object để câu 409
   ghi được "lúc xem trước có 200 bản ghi (đọc 10:32)". Lỗi CLI (org chưa đăng nhập) khi xem trước thêm câu "Hoặc chọn
   "— không kết nối —"…" và `issues: [{ nodeId }]`. Lỗi có `issues` (409, 502 của Query) được gửi kèm `issues`.
9. **Cache** khóa theo `(org, SOQL, maxFetch)` (thêm `maxFetch` để Query SOQL không LIMIT với trần khác không dùng nhầm).
10. **Hộp "Chọn field…"** giữ lại các đường dẫn gõ tay mà describe không liệt kê (ví dụ `Account.Owner.Name`) ở cuối danh sách,
    để không mất công sức (nguyên tắc 5). Danh sách mới là một bước undo riêng.
11. **Import từ org:** mỗi sObject chọn qua "＋ … có sẵn" thêm **một** Query (theo preset) ở đầu `steps` gốc, cùng bước undo với
    field; parent là Query thì `mode: 'random'`. Thứ tự chọn sẵn đúng như doc (Record/Chọn bản ghi khớp → Query khớp → "＋").
12. **Câu hỏi mở 8 (giữ kiểu số):** làm field type mới `copy` "Lấy từ biến (giữ kiểu)" (option `path`, `vars: 'path'`, mặc định
    `this.$n`), không đổi hành vi của Template (Template vẫn luôn ra chuỗi).
13. **Thẻ Query khi chưa chọn org:** nhãn ngắn `chưa chọn org` (title đầy đủ "Chưa chọn org: Xem trước dùng bản ghi mẫu…") vì
    câu dài che mất tóm tắt trên thẻ hẹp. Chip số liệu: `200 bản ghi đọc từ org` / `5 bản ghi mẫu`; Chọn bản ghi: `chọn 20 lần · bỏ qua 7`.
14. **Đổi sObject của Query:** áp preset cho ô còn ở mặc định/preset cũ; không có preset mà có org thì sau 0,5 giây lấy
    `nameField` từ `/fields` (chỉ khi sObject có trong danh sách queryable), không tạo bước undo riêng.
15. **Giá trị mẫu cho bảng chọn biến** (0005 chờ 0006): Query lấy từ `queries[].records[0]`, Chọn bản ghi từ `samples` (khóa mới
    của kết quả `/api/run`: bản ghi đầu tiên mỗi bước Chọn bản ghi đã chọn).
16. **Hộp xác nhận insert** trước đây in chữ `null` khi không có cảnh báo production (lỗi cũ của `replaceChildren`); đã sửa.
17. **Sửa nhỏ đi kèm (yêu cầu riêng):** inspector hiện 3 cho một Lặp v2 viết tay không có `count`, còn executor chạy `count ?? 0`.
    Chọn theo `workflow-schema.md` (migration ghi rõ "`count: 0` — giá trị executor dùng"): giữ executor, đổi ý nghĩa `default`
    của option thành "giá trị khi thiếu khóa" (`count` 0, `max` 1 — `max` cũng lệch: hiện 5, chạy 1), thêm `initial` (3, 5) cho
    bước mới thêm từ UI. Test `a v2 loop without "count" runs 0 times…` và kiểm tra meta.

**Test:** thêm `test/soql.test.js` (6 test); `test/workflow.test.js` (Query pool và Id thật, Query không dùng rng, ba cách chọn
tái lập theo seed, lọc theo `{{acc.Id}}`, `onEmpty`, pool Record giữ `$ref`, validate Query/Chọn bản ghi, template field không
lấy, Lookup `current` vào pool, alias chung, field type `copy`, mặc định số lần lặp); `test/sf.test.js` (client.query + timeout,
pre-fetch không org, đọc tuần tự + cảnh báo 0 dòng / bị cắt, ánh xạ lỗi, cache, 409, Id có sẵn gửi ngay đợt đầu,
`mapQueryFields`); `test/jsforce.test.js` (jsforce thật theo `nextRecordsUrl`, dừng ở `maxFetch`, không `queryAll`);
`test/server.test.js` (`/api/run` có Query, mẫu khi không org, 422 trên ô, insert dùng lại dòng đã xem / 409, hai endpoint mới,
`derived`, meta 0006); `test/scope.test.js` và `test/workflow-tree.test.js` (danh mục thật, đổi tên kéo theo `from`/`filterValue`,
nhân bản). Hai test cũ **được sửa có chủ đích**: phép kiểm meta trong `test/server.test.js` (danh sách bước thêm `query`, `pick`;
nhãn `ref` mới), và `test/samples.test.js` (có mẫu thứ ba không có bản v1; thêm test mẫu đó xem trước được không cần org).
Tổng 173 test, đều qua (184 sau phần sửa sau review). Smoke test thêm luồng 5c: `SMOKE OK` (~8,5 giây, dưới trần 10 giây).

**Sửa sau review** (commit sau `832b368`; mỗi mục có test):

1. **(chặn) Kiểm tra chỉ đọc bị lọt `UPDATE VIEWSTAT` / `UPDATE TRACKING`** (ghi số liệu vào org ngay khi xem trước). Giờ trên
   văn bản đã xóa chuỗi ký tự, ở bất kỳ đâu (cả trong ngoặc, subquery), ở cả SOQL tự viết lẫn ô WHERE / ORDER BY: từ
   `UPDATE` → lỗi `update` (`Bỏ UPDATE (UPDATE VIEWSTAT / UPDATE TRACKING): lệnh này ghi số liệu vào org. Bước Query chỉ đọc dữ
   liệu.`), `FOR UPDATE|VIEW|REFERENCE` → `forClause`, `;` → `semicolon` (`Bỏ dấu ";": mỗi bước Query chỉ chạy đúng một câu
   SELECT.`), ngoặc không khớp trong ô builder → `parens` (chặn kiểu `Id) FROM Lead`). `prefetchQueries` kiểm lại ngay trước khi
   gọi Salesforce (phòng khi validate bị bỏ qua). Test `read-only check: …`, `prefetch refuses unsafe SOQL…`.
2. **Tên field phân biệt hoa thường**, trong khi SOQL thì không: dòng đọc về được đổi khóa theo cách viết trong SELECT
   (`rekeyRow`, cả field quan hệ; `sampleRows` cũng vậy); `analyzeScope` so member của nguồn `origin: 'org'` không phân biệt
   hoa thường; lúc chạy, tham chiếu vào bản ghi `existing` (template, ô lọc `filterField`) và Id của dòng cũng vậy. Bản ghi
   sinh ra vẫn phân biệt. Test `Query field names ignore case…`, `rekeyRow and sampleRows…`, `prefetch re-keys rows…`.
3. **"Lấy từ biến" cho lọt object quan hệ:** biến `vars: 'path'` trỏ vào member có field con là lỗi `wholeRecord`
   (`pbe.Product2 là cả một đối tượng (Name), không phải một giá trị; hãy chọn một field con, ví dụ pbe.Product2.Name.`);
   `copy.generate` báo lỗi với object không phải `{ $ref }`; câu `unknownMember` của Query ngoài template nói `Biến … cần
   field … nhưng Query "…" không lấy field này.` thay cho "Template dùng…". Test `"Lấy từ biến" refuses an object…`.
4. **Master-Detail vào pool Query rỗng** báo câu sai chỗ ("đặt bước … phía trên"). Giờ: `Field AccountId: Query "accs" không
   trả về bản ghi nào. Kiểm tra "Điều kiện (WHERE)" của bước Query hoặc chọn org khác.` (pool Query mang tên Query). Test.
5. **`LIMIT 0`:** `maxFetchFor` trả 0 và pre-fetch không gọi jsforce (jsforce hiểu `maxFetch: 0` là mặc định 10 000). Test.
6. **Chú thích `client.js`** sửa lại: timeout là `QUERY_TIMEOUT` bọc thành 502 rồi `query.js` đổi thành issue 422; timeout không
   hủy được jsforce (trang đang tải vẫn có thể về và bị bỏ).
7. **Tổng thời gian đọc trước:** `LIMITS.queryTotalMs` = 120 000. Mỗi query chỉ được phần thời gian còn lại; hết thì dừng với
   lỗi gắn bước Query kế tiếp: `Các bước Query đọc org quá 120 giây nên đã dừng ở bước Query "cs" (chưa ghi gì vào org). Bớt
   bước Query, thu hẹp "Điều kiện (WHERE)" hoặc giảm LIMIT rồi chạy lại.` (20 × 30 giây không còn vượt timeout HTTP). Test.
8. **Hộp xác nhận hứa quá:** trong 10 phút cache, insert dùng lại đúng các dòng đã xem nên không thấy org đổi. Câu mới: `Insert
   dùng lại đúng các dòng đã đọc lúc xem trước. Nếu đã quá 10 phút (hoặc server vừa khởi động lại), app đọc lại org và dừng
   trước khi ghi nếu dữ liệu đã đổi. Muốn insert theo dữ liệu mới nhất, bấm ⟳ Đọc lại rồi Insert.` Bước smoke mới (bản xem
   trước giả lập đã đọc org) kiểm câu này và việc không còn chữ `null`.
9. **Khóa cache theo org thật:** `client.identity(org)` = instance URL + username từ sf CLI; hai alias của cùng org dùng chung,
   alias trỏ sang org khác không dùng lại; xóa cache sau insert theo cùng khóa. Test.
10. **Danh sách loại bước có alias lấy từ danh mục:** `aliasTypes(catalog)` trong `shared/workflow-tree.js` (loại có `exposes`
    là bản ghi đặt tên bằng `alias`; không có danh mục — migration v1 — thì chỉ `record`) thay `ALIAS_TYPES`; `stepAlias`
    (`summary.js`) đọc `exposes.name`; inspector so `key` với `exposes.name.key`. Test `alias types come from the catalogue…`.

Smoke test: trần thời gian nâng từ 10 lên 12 giây (thường ~8 giây, có lần 9,6 giây trên máy bận; 10 giây không còn dư).

**Chưa làm / để sau:**

- Nút sửa nhanh "Thêm `<Field>` vào SELECT" cho lỗi template dùng field Query không lấy.
- ~~Sự kiện tiến độ `Đang đọc Query…` và `queries[]` trong sự kiện đầu khi chạy dạng stream (0004).~~ Đã làm ở
  [0004](0004-streaming-execution.md#đã-làm) (`queries` trong sự kiện `start`; UI ghi `Đang đọc Query…` trong lúc chờ).
- ~~Lặp "mỗi bản ghi trong pool"~~ Đã làm ở [0010](0010-lap-theo-ban-ghi.md#đã-làm). Chọn N bản ghi / trọng số,
  Update/Upsert/Delete.
