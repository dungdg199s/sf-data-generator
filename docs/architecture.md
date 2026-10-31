# Kiến trúc

## Luồng tổng thể

```
Trình duyệt (client/)                         Server Node.js (server/)
┌──────────────────────────┐   GET /api/meta   ┌───────────────────────────────┐
│ Quy trình / Sơ đồ        │ ◄──────────────── │ generators/  (field types)    │
│ + Inspector (form từ meta)│                   │ workflow/nodes.js (step types)│
│                          │  POST /api/validate│                               │
│ state.workflow (JSON)    │ ────────────────► │ workflow/schema.js            │
│                          │  POST /api/run    │ run.js ◄─ workflow/executor.js│
│ Kết quả, tiến độ, Dừng   │ ◄── NDJSON ────── │   └─► sf/insert.js (nếu org)  │
│ Tải CSV / JSON           │  POST /api/export │ (sinh lại từ seed + now)      │
└──────────────────────────┘                   │ sf/cli.js ─► `sf` CLI máy local│
                                               │ sf/client.js ─► jsforce ─► SF  │
                                               └───────────────────────────────┘
        └──────── shared/ (logic cây, migration v1, phạm vi biến; dùng ở cả hai phía) ────────┘
```

1. Khi tải trang, UI gọi `GET /api/meta` để lấy danh sách field type, loại bước (kèm `slots`, `category`) và option schema
   của từng loại.
   UI **không hard-code** option nào: form trong inspector được dựng từ meta này (`client/js/forms.js`).
2. Người dùng dựng các bước ở chế độ Quy trình hoặc Sơ đồ (hai cách vẽ cùng một cây bước, [0003](design/0003-process-mode.md); phím M để đổi).
   Mỗi lần sửa, UI gọi `POST /api/validate` (debounce 400 ms) để hiện lỗi/cảnh báo gắn đúng bước, field và ô bước con.
3. Khi bấm **Xem trước** hoặc **Insert vào org**, UI gửi toàn bộ workflow JSON lên `POST /api/run`.
   Server validate lại, **đọc trước** các bước Query (`server/sf/query.js` qua jsforce `conn.query`, hoặc dòng mẫu khi chưa
   chọn org; cache 10 phút và dấu vân tay, [0006](design/0006-query-pick-nodes.md)), chạy executor với các dòng đó
   (`queryResults`), và nếu `target.kind === 'org'` thì insert. Lỗi validate (422), lỗi đọc trước (409/502) trả về trước
   khi gửi header, như JSON thường.
4. **Chạy dạng luồng** ([0004](design/0004-streaming-execution.md), luôn bật): executor là một **generator đồng bộ**
   (`createRun(workflow, opts).records()`) sinh từng bản ghi theo đúng thứ tự cũ. `server/run.js` tiêu thụ dòng bản ghi đó
   bằng các "sink", nên bộ nhớ không tăng theo số bản ghi:

   ```
   createRun(workflow, { seed, now, queryResults })   validate một lần; executor THUẦN (không I/O, không timer)
     │
   server/run.js  executeRun ── nhường event loop mỗi 1 000 bản ghi · tiến độ ≤ 4 lần/giây · signal Dừng
     ├─ lượt 1: sink xem trước   đếm theo sObject + 200 dòng đầu mỗi sObject (lượt chạy thử khi target là org:
     │                           lỗi sinh dữ liệu dừng lần chạy trước khi ghi bản ghi đầu tiên)
     ├─ lượt 2 (chỉ khi insert): records() mới, cùng seed + now ⇒ đúng chuỗi của lượt 1
     │        └─► sf/insert.js createInserter: cửa sổ 2 000 → wave → lô ≤ 200 → jsforce (allOrNone false)
     └─ emit(sự kiện) ──► NDJSON ──► trình duyệt (start, progress, plan, done | error)

   POST /api/export ── createRun → records() → CSV (một sObject) / JSON, ghi thẳng ra response (xử lý drain)
   ```

   UI đọc NDJSON (`Accept: application/x-ndjson`), vẽ tiến độ và nút **Dừng** (`POST /api/runs/:runId/cancel`; đóng kết
   nối cũng dừng). Không có header đó thì `/api/run` trả một JSON đủ mọi bản ghi như trước (script, test). Tải về không
   giữ bản ghi ở client: server sinh lại từ bản chụp workflow + `seed` + `now` của lần chạy.

## Các phần ở server

| Thư mục | Trách nhiệm | Ghi chú |
| --- | --- | --- |
| `server/generators/` | Mỗi kiểu field Salesforce một generator, tự khai báo option | Registry trong `index.js`; xử lý chung `nullRatio`/`unique` |
| `server/workflow/` | Danh mục loại bước, validate, chạy workflow; `samples.js`: vài giá trị của một field cho `POST /api/field-samples` (0012 E) | Executor là generator đồng bộ, thuần: không I/O, không timer, không gọi org; dữ liệu Query được đọc trước ở `server/sf/query.js` và truyền vào. Nhận cả v1 (chuyển sang v2 trước) |
| `server/run.js` | Driver của một lần chạy ([0004](design/0004-streaming-execution.md)): lượt xem trước / chạy thử, lượt insert, sự kiện tiến độ (insert: theo sObject và theo bước, `byStep` của 0012 D), sổ `runId` → `AbortController` để Dừng | Nơi duy nhất có thời gian trôi: nhường event loop, throttle tiến độ, chờ inserter |
| `server/sf/` | sf CLI (chỉ lấy token), jsforce connection, map describe → field, đọc trước Query (cache, dấu vân tay), insert theo cửa sổ | Không lưu credential; token và dòng đã đọc chỉ giữ trong bộ nhớ |
| `server/random.js` | PRNG có seed (mulberry32) | Cùng workflow + seed ⇒ cùng dữ liệu |

## Module dùng chung (`shared/`)

Hàm thuần (không DOM, không I/O, không import ngoài `shared/`), chạy ở cả server (Node) lẫn trình duyệt. Server phục vụ
thư mục này ở `/shared/…` với cùng cách chặn path traversal như `client/`.

| File | Trách nhiệm |
| --- | --- |
| `shared/workflow-tree.js` | Duyệt/tìm bước, chèn, di chuyển, xóa (bỏ vỏ), bọc, nhân bản (đổi alias nội bộ), đổi alias và tên field kéo theo tham chiếu (`renameAlias`, `setStepAlias`, `renameField`, theo mọi option có `vars`/`kind: 'ref'`), quy tắc chèn mặc định, đích của Alt+↑/↓; nhóm bước ([0012](design/0012-nang-suat-soan-thao.md) B): `normalizeSelection`, `rangeBetween` (dải Shift nâng lên dãy chung gần nhất), `wrapSteps`, `removeSteps`, `moveBlock`, `neighbourTargetBlock`, `pasteSteps` (giữ alias trống, đổi alias trùng, đổi biến lặp che vòng ngoài) |
| `shared/migrate-v1.js` | Chuyển workflow v1 (đồ thị) sang v2 (cây) và mô tả báo cáo chuyển đổi |
| `shared/soql.js` | SOQL của bước Query ([0006](design/0006-query-pick-nodes.md)): dựng câu từ builder, đọc danh sách field / sObject của SOQL tự viết, kiểm tra chỉ đọc (`checkSoql`, `checkBuilder`), dòng mẫu khi chưa chọn org |
| `shared/each-wrap.js` | "Bọc trong Lặp qua từng bản ghi" ([0012](design/0012-nang-suat-soan-thao.md) C): `eachWrapPlan` (pool cho Lặp `each` mới, Lookup nên nối lại), `applyEachRewire` (nút [Đổi], chỉ khi Lặp còn nguyên và Lookup còn trong nó) |
| `shared/estimate.js` | `estimateSteps(wf, catalog, { queryCounts })` ([0012](design/0012-nang-suat-soan-thao.md) H): ước tính số bản ghi mỗi bước sinh ra trước khi chạy (`{ records, min, max, exact }`, khung: tổng bên trong, Lặp thêm `iterations`) và tổng; đọc ý nghĩa `count`/`min`/`max`/`mode` của Lặp, `kind`/`probability` của Rẽ nhánh, số dòng tối đa của Query theo `maxFetchFor` (hoặc số dòng lần đọc gần nhất); một lượt O(số bước), bước tắt bỏ qua |
| `shared/scope.js` | `analyzeScope(wf, catalog)` ([0005](design/0005-variable-picker.md)): nguồn biến, biến dùng được ở từng bước (`always`/`last`/`maybe`) và lý do bị ẩn (`after`/`otherBranch`/`outsideLoop`/`shadowed`/`disabled`), mọi tham chiếu đã phân giải (kèm `valueType`); `refChoices` cho ô "Bản ghi cha"; regex token `{{…}}` (`TEMPLATE_TOKEN_SOURCE`); `poolUsage` ([0004](design/0004-streaming-execution.md)): pool nào phải giữ bản ghi đầy đủ, alias nào cần giữ Id khi insert. Từ [0013](design/0013-mo-rong-bien-va-lap.md): `optionShown` (`showIf` bắc cầu), `numberVarPath`/`isVar` (option `vars: 'number'`), `valueList` (Lặp `values`), nguồn `$run` từ `catalog.globals`, `numericSampleFields` (field Query dùng như số, cho dòng mẫu) |

Thứ tự slot được truyền vào qua tham số `slotKeys(type)`: server lấy từ `nodeTypeMap`, client lấy từ `state.meta`.
`analyzeScope` nhận cả danh mục `{ nodeTypes, fieldTypes }` (server: `scopeCatalog()` trong `schema.js`; client:
`state.meta`) và chỉ đọc `flow`/`exposes` của loại bước, không hard-code `loop`/`branch`.

## Quyết định thiết kế quan trọng

- **Không framework, dependency tối thiểu.** Server dùng `node:http`, client dùng ES modules thuần,
  không có bước build. Dependency runtime duy nhất là `jsforce` để gọi API Salesforce
  ([0002](design/0002-jsforce-api.md)). Chỉ thêm thư viện khi thực sự cần (yêu cầu của dự án).
- **sf CLI chỉ dùng để lấy token.** Mọi lời gọi API (describe, insert, …) đi qua jsforce.
- **Server bind `127.0.0.1` mặc định.** Server hành động bằng quyền của sf CLI trên máy,
  nên không được lộ ra mạng trừ khi đặt `HOST` một cách có chủ đích.
- **Chỉ giao diện của chính app được gọi API.** `requestGuard` (`server/index.js`) từ chối mọi `/api/*` có `Origin` lạ,
  `Sec-Fetch-Site` khác `same-origin`/`none` hoặc `Host` không phải máy này (403), và POST không phải
  `application/json` (415): một trang web người dùng đang mở không thể insert vào org hay đọc describe qua server
  (chi tiết: [org-connection.md](org-connection.md#an-toàn)).
- **Seed và `now` để tái lập.** Cùng workflow, `seed`, `now` (và cùng dòng Query) ⇒ cùng dữ liệu. Insert luôn dùng `seed`
  và `now` của bản xem trước vừa xác nhận (tự xem trước nếu chưa có), nên dữ liệu insert giống hệt bản xem trước, kể cả
  field ngày tương đối như `today`.
- **Luôn chạy dạng luồng, không có checkbox "stream mode"** ([0004](design/0004-streaming-execution.md), 0007 Q2).
  Không làm "mỗi node một stream": workflow là luồng điều khiển (lặp, rẽ nhánh, bản ghi hiện tại), không phải luồng dữ
  liệu, và chạy xen kẽ sẽ đổi thứ tự rút số ngẫu nhiên (đổi dữ liệu của mọi seed cũ).
- **Pool bản ghi chỉ đếm khi không ai đọc cả bản ghi.** Pool của alias Record là `{ kind: 'generated', length, refAt }`
  (Lookup "Ngẫu nhiên" rút cùng một số như `rng.pick`, nên dữ liệu không đổi). Chỉ alias là pool của một option bước
  `kind: 'ref'` có `accepts.pool` (Chọn bản ghi `from`, Lặp "Mỗi bản ghi trong pool" `from` của
  [0010](design/0010-lap-theo-ban-ghi.md)) mới giữ bản ghi đầy đủ — `poolUsage` tính từ danh mục, không hard-code loại bước.
  Lookup tới bản ghi đang lặp giữ Id của pool phía sau nó khi insert (`referencedAliases` đi theo `fromSource`).
- **Lặp `each` không dùng `rng`** (0010): chụp pool lúc bắt đầu và lặp theo thứ tự pool, nên chèn hay bỏ một Lặp `each` không
  làm lệch số ngẫu nhiên của các bước khác; xem trước và insert cùng seed ra cùng số lần lặp (dòng Query có dấu vân tay).
  Ngoại lệ có chủ đích ([0013](design/0013-mo-rong-bien-va-lap.md) C): `order: 'shuffle'` rút **đúng** k số (`rng.shuffleTake`)
  lúc vòng lặp bắt đầu. Lọc của Lặp `each` (phép `eq`) dùng chỉ mục theo bước, nối thêm khi pool dài ra, nên Lặp lồng
  "mỗi Account → Contact của nó" là O(số Contact) chứ không O(Account × Contact). Lặp `values`, đọc biến số (`count`
  `"{{acc.N}}"`) và Rẽ nhánh so với biến không rút số nào; Chọn bản ghi `weighted` rút đúng một số như `rng.pick`. Phần bộ nhớ còn tăng theo số bản ghi: tập giá trị `unique`
  (khoảng 165 B/giá trị) và Id của alias có Lookup trỏ tới khi insert (khoảng 100 B/bản ghi).
- **Lookup dùng placeholder `{ "$ref": "alias#n" }`.** Executor không biết Id thật; `sf/insert.js` chèn
  theo từng "đợt" (wave) để bản ghi cha luôn có Id trước bản ghi con.
- **Điều kiện rẽ nhánh là dữ liệu có cấu trúc**, không phải chuỗi để `eval`, nên an toàn
  và UI có thể dựng bằng form.
- **Cây bước là mô hình chuẩn ([0003](design/0003-process-mode.md)).** Workflow JSON version 2 là `steps[]` lồng nhau
  qua `slots`; không có dây nối, node lơ lửng hay vòng. "Phía trên" là thứ tự đọc từ trên xuống, nên Lookup sau một
  vòng lặp hợp lệ. Version 1 vẫn được nhận và chuyển đổi, bản gốc không bị ghi đè.
- **Phạm vi biến do một hàm thuần `analyzeScope` tính** ([0005](design/0005-variable-picker.md)), dùng chung cho validate
  ở server và bảng chọn biến, ô "Bản ghi cha", đổi tên trên trình duyệt (tính lại mỗi lần workflow đổi, không qua mạng),
  nên hai bên không thể lệch nhau. Tham chiếu vẫn lưu là chuỗi `{{alias.Field}}`; tham chiếu hỏng là lỗi chặn chạy.
- **Lỗi validate luôn kèm `nodeId` (id bước) và `field`** để UI tô đỏ đúng chỗ (badge trên thẻ, viền đỏ ở field,
  ô bước con viền nét đứt với `slots.<key>`).

## Giới hạn an toàn (`server/workflow/nodes.js` → `LIMITS`)

| Giới hạn | Giá trị | Ý nghĩa |
| --- | --- | --- |
| `maxRecordsDefault` | 50 000 | Số bản ghi tối đa mỗi lần chạy nếu workflow không đặt `settings.maxRecords` |
| `maxRecordsHard` | 200 000 | Trần cứng, không vượt được |
| `maxCountPerNode` | 100 000 | Số lần lặp / số bản ghi tối đa của một node |
| `maxSteps` | 2 000 000 | Chặn workflow lặp lồng nhau chạy quá lâu. Đếm mỗi lần thăm một bước **và**, từ sửa sau review của [0010](design/0010-lap-theo-ban-ghi.md), mỗi lần lặp của Lặp (cố định, ngẫu nhiên, `each`): trước đó Lặp có thân toàn bước tắt chạy 10¹⁰ lần lặp mà không bị đếm, treo server và Dừng không tới được. Hệ quả: một workflow cũ có thể bị từ chối mới — số bước đếm tăng tối đa gấp đôi, ví dụ Lặp 1 000 × Lặp 1 000 × [Rẽ nhánh] trước là ≈ 1 001 000, nay ≈ 2 002 000 > 2 000 000 (`Workflow chạy quá 2000000 bước…`) dù chỉ sinh ~100 000 bản ghi. Sửa bằng cách giảm số lần lặp lồng nhau |
| `maxDepth` | 32 | Số cấp Lặp / Rẽ nhánh lồng nhau tối đa |
| `previewRows` | 200 | Số bản ghi đầu mỗi sObject server gửi về cho bảng kết quả; phần còn lại chỉ đếm, tải đủ qua `/api/export` |
| `maxQueryRows` | 2 000 | LIMIT tối đa và `maxFetch` của một bước Query |
| `maxQueryNodes` | 20 | Số bước Query tối đa mỗi workflow |
| `queryTimeoutMs` | 30 000 | Thời gian tối đa của một query |
| `queryTotalMs` | 120 000 | Thời gian tối đa của cả lần đọc trước (mọi bước Query), dưới mọi timeout HTTP |
| `queryCacheTtlMs` | 600 000 | Thời gian dùng lại dòng đã đọc (10 phút); cache tối đa 50 mục |

Migration v1 cũng giới hạn số bước nhân bản (`2 × số node + 50`) để workflow hiểm hóc không làm treo trình duyệt.

Hằng nội bộ của lần chạy (không đưa ra meta): cửa sổ insert 2 000 bản ghi, dừng sớm sau 3 lô đầu lỗi 100 % của một
sObject, tối đa 1 000 lỗi chi tiết trong kết quả (nhóm lỗi luôn đếm đủ), tiến độ mỗi 250 ms, nhường event loop mỗi
1 000 bản ghi (`server/sf/insert.js`, `server/run.js`).

## Client

| File | Trách nhiệm |
| --- | --- |
| `client/js/store.js` | State duy nhất (lựa chọn: bước chính `selection.id` + `selection.ids` khi chọn nhiều), undo/redo, tự lưu qua `setPersistHandler` (thư viện; không có thì autosave `sfdg.workflow.v2` như trước), `openWorkflow` (đổi workflow: đặt lại undo, lựa chọn, kết quả), `lastInserts` (≤ 20, giữ qua các workflow), trạng thái thu gọn khung (`sfdg.collapsed`), chế độ xem (`state.view`, `sfdg.view`), phát sự kiện thay đổi; `currentScope()` (kết quả `analyzeScope`, tính lại một lần mỗi phiên bản workflow); `currentEstimate()` (`estimateSteps`, mỗi phiên bản workflow và kết quả chạy) |
| `client/js/views.js` | Đổi chế độ xem Quy trình / Sơ đồ (nút ở hàng trên vùng xem, phím M, menu ⋯ trên điện thoại): chỉ view đang hiện có DOM; giữ lựa chọn, mở khung tổ tiên, đưa bước vào tầm nhìn, chuyển focus; nhớ `sfdg.view` trên màn hình > 720 px |
| `client/js/process.js` | Chế độ Quy trình: thẻ bước, khung Lặp/Rẽ nhánh, nút "+", kéo thả, bàn phím kiểu cây |
| `client/js/canvas.js` | Chế độ Sơ đồ ([0003](design/0003-process-mode.md) đợt B): vẽ cây từ `layout.js`, một SVG cho mọi đường nối, chỉ tạo thẻ/nút "+" gần khung nhìn; kéo/cuộn để di chuyển, Ctrl+cuộn / chụm hai ngón / nút − 100% + ⤢ để thu phóng; "+" trên đường nối, thả mục palette lên đường nối; cùng phím cây như Quy trình. Không kéo thẻ, không vị trí tự do; minimap góc dưới phải (`minimap.js`, nút `#btn-minimap`, `sfdg.minimap`; [0014](design/0014-hoan-thien-giao-dien.md)), `showRect` tránh thanh thu phóng và minimap |
| `client/js/layout.js` | Hàm thuần `layout(steps, { slotsOf, collapsed })` của Sơ đồ, O(n): dãy trái sang phải, loại 1 slot là khung, loại ≥ 2 slot là các làn gộp ở một chấm; slot lấy từ catalogue. Không import gì, test trong Node (`test/layout.test.js`) |
| `client/js/menus.js` | Menu "+" (loại bước theo `category`) và menu ⋯ của bước chia nhóm (Chỉnh sửa / Di chuyển / Bọc / Chọn), dùng chung cho hai chế độ; trên thẻ thuộc lựa chọn nhiều áp cho cả lựa chọn. `wrapItems`/`editItems`/`moveItems`/`offDeleteItems` cũng dựng panel chọn nhiều của inspector và thanh chọn |
| `client/js/selection.js` | Mô hình lựa chọn ([0012](design/0012-nang-suat-soan-thao.md) B), dùng chung hai view: Shift+bấm (dải), Ctrl/⌘+bấm (rời), Shift+↑/↓, Ctrl+A, Esc hai nấc, chế độ chọn ở màn hình hẹp (`body.select-mode`), `#sel-live` đọc số bước đã chọn |
| `client/js/select-bar.js` | Thanh `.select-bar` của chế độ chọn (≤ 900 px / cảm ứng): `[n đã chọn] [Bọc ▾] [Xóa] [⋯] [Xong]` thay chỗ bottom sheet |
| `client/js/required-fields.js` | "Thiếu n field bắt buộc" ([0012](design/0012-nang-suat-soan-thao.md) F2): `missingRequired(fields, described)`, `requiredHintText`; thuần, test trong Node. Inspector hiện khung gợi ý từ describe (cache theo `org|sObject`) |
| `client/js/clipboard.js` | Định dạng bộ nhớ tạm của bước (`toClipboard`, `parseClipboard` và các câu từ chối dán); thuần, import tương đối `../../shared/`, test trong Node. `main.js` bắt sự kiện `copy`/`cut`/`paste` của `document` |
| `client/js/library.js` | Thư viện workflow ([0012](design/0012-nang-suat-soan-thao.md) A), phần lưu trữ: `sfdg.library` + `sfdg.wf.<id>` + thùng rác một mục, `sessionStorage['sfdg.activeId']`; sửa chỉ mục khi đọc, quota (xóa thùng rác rồi thử lại), chuyển autosave v2 / v1 lần đầu (không ghi, không xóa hai khóa cũ), file thư viện. Storage truyền vào, test trong Node |
| `client/js/library-ui.js` | Thư viện, phần giao diện: popup `▾` / Ctrl+O, hộp "Quản lý thư viện", Mới / Mở file / Mẫu thành mục mới, khóa khi đang chạy, `▲ Chưa lưu` + `beforeunload` khi bộ nhớ đầy, hai tab cùng sửa một mục (sự kiện `storage`) |
| `client/js/ops.js` | Thao tác trên bước (thêm, xóa, nhân bản, tắt, bọc, bọc trong Lặp qua từng bản ghi, bỏ vỏ, di chuyển) qua `shared/workflow-tree.js`, toast Hoàn tác; tự điền khi bật "Lọc" (`fillParentFilter`, [0013](design/0013-mo-rong-bien-va-lap.md): `<S>Id = {{rec.Id}}` từ bản ghi đọc từ org gần nhất, cùng bước undo); bản cho cả lựa chọn (`deleteSelection`, `toggleSelectionDisabled`, `duplicateSelection`, `wrapSelection`, `moveSelectionBy`, mỗi cái một bước undo) và sao chép / cắt / dán (`pasteText`) |
| `client/js/ref-target.js` | Tô thẻ nguồn ([0012](design/0012-nang-suat-soan-thao.md) I): rê / focus chip biến hay chip Lookup thì thẻ bước nguồn (qua `sourceStep` của `currentScope()`) có `.is-ref-target` ở view đang hiện; hai view đọc `refTargetId()` khi vẽ lại thẻ (Sơ đồ tạo lại thẻ bị cull) |
| `client/js/run-cards.js` | Chip số liệu và tag lỗi insert của thẻ, dùng chung cho hai view ([0012](design/0012-nang-suat-soan-thao.md) D, H): số liệu trực tiếp từ `state.runLive` (main.js đặt theo sự kiện `progress` / `plan`), ước tính trước khi chạy, hoặc kết quả cuối; `paintCardRun` chỉ vá hai phần tử đó nên tiến độ không dựng lại DOM; bấm tag mở tab "Lỗi insert" ở nhóm của bước |
| `client/js/field-samples.js` | Hàng `Ví dụ:` cuối khối option của field đang mở ⚙ ([0012](design/0012-nang-suat-soan-thao.md) E): field độc lập gọi `POST /api/field-samples` (300 ms sau lần sửa cuối, bỏ câu trả lời cũ, cache nhỏ; seed = ô Seed nếu là số, không thì 1; `now` = 00:00 hôm nay); field phụ thuộc bước khác (`fieldDepends`, từ `currentScope().refs`, bắc cầu qua `{{this.X}}`) hiện 3 bản ghi đầu của lần xem trước |
| `client/js/summary.js` | Câu tóm tắt trên thẻ (kể cả Lặp `values`, lọc / xáo trộn / tối đa của Lặp `each`, Chọn bản ghi theo trọng số, 0013) và chip số liệu từ `stats.byStep`; chip ước tính của thẻ Record và dòng ước tính của thẻ Bắt đầu (`estimateChip`, `startEstimate`); nhóm lỗi theo bước và nhãn nút "+" dùng chung cho hai chế độ |
| `client/js/inspector.js` | Cấu hình bước (nơi duy nhất sửa cấu hình), trình soạn field, import field từ org, đổi alias tự cập nhật tham chiếu; bottom sheet trên màn hình hẹp (`body.sheet-open`, `openSheet`/`closeSheet`: chạy thì đóng, lỗi validate thì mở lại, [0009](design/0009-bo-cuc-man-hinh.md)); sheet hai nấc (tay nắm `.sheet-grip`, kéo hàng đầu sheet, [0014](design/0014-hoan-thien-giao-dien.md)) |
| `client/js/popup.js` | Popup menu dùng chung ([0009](design/0009-bo-cuc-man-hinh.md)): menu "+", menu bước, menu **⋯** của thanh trên, menu `⤓ Tải`; hàng thường, hàng chọn một (`menuitemradio`), hàng ô nhập; bàn phím |
| `client/js/issues.js` | Thanh lỗi dưới canvas ([0009](design/0009-bo-cuc-man-hinh.md)): số đếm, danh sách, thu gọn (`sfdg.issuesCollapsed`, không vào undo), F8 / Shift+F8, tự mở rộng khi chạy lỗi validate. Chỉ import `dom.js`, nên các hàm thuần (`issueCountsLabel`, `nextIssueIndex`) được test trong Node |
| `client/js/forms.js` | Dựng form từ option schema (`showIf` bắc cầu qua `optionShown`, các `kind`, `placeholder`, `split: 'lines'`); gắn bảng chọn biến cho option có `vars`; ô số `vars: 'number'` ([0013](design/0013-mo-rong-bien-va-lap.md) B) là ô chữ số có `{x}` (`numberBoxValue`: số → số, trống → mặc định, còn lại → chuỗi) |
| `client/js/var-picker.js` | Bảng chọn biến (nút `{x}`, gõ `{{`, Ctrl+Space, Alt+↓ / ⌥↓ của 0014; ba chế độ `template` / `path` / `number`, `number` thay cả ô bằng `{{path}}` và có dòng giải thích vì sao chỉ hiện biến số), tìm kiếm, phím tắt, ARIA, chèn bằng `execCommand('insertText')`; dải chip dưới ô (dòng "Lần xem trước" một giá trị đã chuyển thành hàng `Ví dụ:` của `field-samples.js`, 0012 E) |
| `client/js/variables.js` | Dữ liệu cho bảng chọn: nhóm biến theo bước từ `currentScope()` và meta (nhóm `this` dựng từ thứ tự field hiện tại), giá trị mẫu từ lần xem trước (`samples` của mọi bước Record, 0013 F), lọc theo `valueType` ở chế độ `number`, nhóm **Lần chạy** (`run`, màu trung tính, luôn cuối; mẫu là seed / now / today của lần xem trước), chỗ đang dùng một biến (toast khi xóa/đổi tên) |
| `client/js/results.js` | Bảng kết quả theo sObject (200 dòng đầu + tổng), tab chỉ đọc `alias · sObject (n)` (icon Query, không có `↓`) cho dòng Query đã đọc, "⟳ Đọc lại", tab lỗi insert gom nhóm (bấm để chọn bước/field; `showInsertErrorsFor(nodeId)` tô và focus nhóm đầu của một bước), tải JSON/CSV qua `/api/export`; tiến độ, `<progress>` 3 px và nút Dừng khi đang chạy; đầu panel một hàng, ở ≤ 720 px gộp hai nút tải thành `⤓ Tải`; tay nắm đổi cao panel (`role="separator"`, chuột / chạm / phím, nhớ tỉ lệ ở `sfdg.resultsH`, [0014](design/0014-hoan-thien-giao-dien.md)) |
| `client/js/main.js` | Khởi động, toolbar (và menu **⋯** + chip `Seed n` ở màn hình hẹp), phím tắt, validate trực tiếp, chạy/insert: đọc NDJSON, tự xem trước trước khi xác nhận insert, hộp xác nhận luôn có số bản ghi, `beforeunload` khi đang insert |
| `client/js/api.js` | Gọi API; `runStream` đọc NDJSON bằng `res.body.getReader()`, `cancelRun`, `exportFile` (Blob) |
| `client/js/theme.js` | Nút chuyển giao diện Sáng / Tối / Theo hệ thống: `data-theme` trên `<html>`, nhớ trong `sfdg.theme`; script thường trong `<head>` để áp dụng trước lần vẽ đầu; `title` của ô chọn (vẽ thành icon) theo giá trị |
| `client/js/dom.js` | Helper DOM `h()`, toast, tải file, `icoTile()` (ô icon loại bước), `ico(name)` (icon thao tác SVG mask, [0014](design/0014-hoan-thien-giao-dien.md)), `watchOverflow(el)` (mép mờ `data-overflow` và con lăn dọc thành cuộn ngang cho palette hẹp, tóm tắt kết quả, hàng tab) |
| `client/js/keys.js` | Nhãn phím theo nền tảng ([0014](design/0014-hoan-thien-giao-dien.md) §6): `isMac(nav)`, `pickerKeys(mac)` (`title` của `{x}`, dòng "Phím tắt"), `isPickerOpenKey(e)` (Ctrl+Space, Alt+↓). Thuần, test trong Node (`test/keys.test.js`) |
| `client/js/sizing.js` | Kích thước người dùng kéo ([0014](design/0014-hoan-thien-giao-dien.md) §2, §3): `clampResults` (panel kết quả 160 px … tổng − min(240 px, 50 %)), `resultsKeyStep`, `shouldCollapse`, `snapSheet` / `sheetSnaps` / `dragVelocity` (sheet hai nấc). Thuần, test trong Node (`test/sizing.test.js`) |
| `client/js/minimap.js` | Minimap của Sơ đồ ([0014](design/0014-hoan-thien-giao-dien.md) §5): `minimapModel` (tỉ lệ ≥ 0,05, cửa sổ đi theo khung nhìn, khung nhìn cắt theo cửa sổ, rãnh tổng quan), `minimapPaths` (một path mỗi nhóm, không tăng theo số bước). Thuần, test trong Node (`test/minimap.test.js`) |
| `client/css/app.css` | Khối token (primitive, sáng/tối, thang đo, icon) rồi tới thành phần; màu và icon loại bước chỉ ở luật `[data-type]`. Quy tắc: `docs/ui-design-system.md` |

Sự kiện của store có `source`: inspector bỏ qua thay đổi do chính nó tạo ra (`source: 'inspector'`)
để không render lại và mất focus khi người dùng đang gõ. Thay đổi cấu trúc dùng `'inspector-structure'`.
View đang hiện (Quy trình hoặc Sơ đồ) dựng lại DOM khi workflow đổi (giữ vị trí cuộn / pan và focus); khi chỉ đổi lựa chọn hay lỗi thì chỉ cập nhật
class và badge. Thu gọn/mở khung là trạng thái UI (`kind: 'view'`), không tạo bước undo.
