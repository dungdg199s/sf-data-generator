# Kiến trúc

## Luồng tổng thể

```
Trình duyệt (client/)                         Server Node.js (server/)
┌──────────────────────────┐   GET /api/meta   ┌───────────────────────────────┐
│ Quy trình + Inspector    │ ◄──────────────── │ generators/  (field types)    │
│ (form sinh từ meta)      │                   │ workflow/nodes.js (step types)│
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
2. Người dùng dựng các bước ở chế độ Quy trình (chế độ Sơ đồ là đợt B của [0003](design/0003-process-mode.md), chưa làm).
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
| `server/workflow/` | Danh mục loại bước, validate, chạy workflow | Executor là generator đồng bộ, thuần: không I/O, không timer, không gọi org; dữ liệu Query được đọc trước ở `server/sf/query.js` và truyền vào. Nhận cả v1 (chuyển sang v2 trước) |
| `server/run.js` | Driver của một lần chạy ([0004](design/0004-streaming-execution.md)): lượt xem trước / chạy thử, lượt insert, sự kiện tiến độ, sổ `runId` → `AbortController` để Dừng | Nơi duy nhất có thời gian trôi: nhường event loop, throttle tiến độ, chờ inserter |
| `server/sf/` | sf CLI (chỉ lấy token), jsforce connection, map describe → field, đọc trước Query (cache, dấu vân tay), insert theo cửa sổ | Không lưu credential; token và dòng đã đọc chỉ giữ trong bộ nhớ |
| `server/random.js` | PRNG có seed (mulberry32) | Cùng workflow + seed ⇒ cùng dữ liệu |

## Module dùng chung (`shared/`)

Hàm thuần (không DOM, không I/O, không import ngoài `shared/`), chạy ở cả server (Node) lẫn trình duyệt. Server phục vụ
thư mục này ở `/shared/…` với cùng cách chặn path traversal như `client/`.

| File | Trách nhiệm |
| --- | --- |
| `shared/workflow-tree.js` | Duyệt/tìm bước, chèn, di chuyển, xóa (bỏ vỏ), bọc, nhân bản (đổi alias nội bộ), đổi alias và tên field kéo theo tham chiếu (`renameAlias`, `setStepAlias`, `renameField`, theo mọi option có `vars`/`kind: 'ref'`), quy tắc chèn mặc định, đích của Alt+↑/↓ |
| `shared/migrate-v1.js` | Chuyển workflow v1 (đồ thị) sang v2 (cây) và mô tả báo cáo chuyển đổi |
| `shared/soql.js` | SOQL của bước Query ([0006](design/0006-query-pick-nodes.md)): dựng câu từ builder, đọc danh sách field / sObject của SOQL tự viết, kiểm tra chỉ đọc (`checkSoql`, `checkBuilder`), dòng mẫu khi chưa chọn org |
| `shared/scope.js` | `analyzeScope(wf, catalog)` ([0005](design/0005-variable-picker.md)): nguồn biến, biến dùng được ở từng bước (`always`/`last`/`maybe`) và lý do bị ẩn (`after`/`otherBranch`/`outsideLoop`/`shadowed`/`disabled`), mọi tham chiếu đã phân giải; `refChoices` cho ô "Bản ghi cha"; regex token `{{…}}` (`TEMPLATE_TOKEN_SOURCE`); `poolUsage` ([0004](design/0004-streaming-execution.md)): pool nào phải giữ bản ghi đầy đủ, alias nào cần giữ Id khi insert |

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
  `kind: 'ref'` có `accepts.pool` (Chọn bản ghi `from`, sau này Lặp "mỗi bản ghi" của 0010) mới giữ bản ghi đầy đủ —
  `poolUsage` tính từ danh mục, không hard-code loại bước. Phần bộ nhớ còn tăng theo số bản ghi: tập giá trị `unique`
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
| `maxSteps` | 2 000 000 | Chặn workflow lặp lồng nhau chạy quá lâu |
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
| `client/js/store.js` | State duy nhất, undo/redo, autosave `localStorage` (`sfdg.workflow.v2`; `sfdg.workflow.v1` chỉ đọc), trạng thái thu gọn khung (`sfdg.collapsed`), phát sự kiện thay đổi; `currentScope()` (kết quả `analyzeScope`, tính lại một lần mỗi phiên bản workflow) |
| `client/js/process.js` | Chế độ Quy trình: thẻ bước, khung Lặp/Rẽ nhánh, nút "+", menu bước, kéo thả, bàn phím kiểu cây |
| `client/js/ops.js` | Thao tác trên bước (thêm, xóa, nhân bản, tắt, bọc, bỏ vỏ, di chuyển) qua `shared/workflow-tree.js`, toast Hoàn tác |
| `client/js/summary.js` | Câu tóm tắt trên thẻ và chip số liệu từ `stats.byStep` |
| `client/js/inspector.js` | Cấu hình bước (nơi duy nhất sửa cấu hình), trình soạn field, import field từ org, đổi alias tự cập nhật tham chiếu; bottom sheet trên màn hình hẹp |
| `client/js/forms.js` | Dựng form từ option schema (`showIf`, các `kind`); gắn bảng chọn biến cho option có `vars` |
| `client/js/var-picker.js` | Bảng chọn biến (nút `{x}`, gõ `{{`, Ctrl+Space), tìm kiếm, phím tắt, ARIA, chèn bằng `execCommand('insertText')`; dải chip dưới ô và dòng "Lần xem trước" |
| `client/js/variables.js` | Dữ liệu cho bảng chọn: nhóm biến theo bước từ `currentScope()` và meta (nhóm `this` dựng từ thứ tự field hiện tại), giá trị mẫu từ lần xem trước, chỗ đang dùng một biến (toast khi xóa/đổi tên) |
| `client/js/results.js` | Bảng kết quả theo sObject (200 dòng đầu + tổng), tab chỉ đọc `↓ alias` cho dòng Query đã đọc, "⟳ Đọc lại", tab lỗi insert gom nhóm (bấm để chọn bước/field), tải JSON/CSV qua `/api/export`; tiến độ, `<progress>` 3 px và nút Dừng khi đang chạy |
| `client/js/main.js` | Khởi động, toolbar, phím tắt, validate trực tiếp, chạy/insert: đọc NDJSON, tự xem trước trước khi xác nhận insert, hộp xác nhận luôn có số bản ghi, `beforeunload` khi đang insert |
| `client/js/api.js` | Gọi API; `runStream` đọc NDJSON bằng `res.body.getReader()`, `cancelRun`, `exportFile` (Blob) |
| `client/js/theme.js` | Nút chuyển giao diện Sáng / Tối / Theo hệ thống: `data-theme` trên `<html>`, nhớ trong `sfdg.theme`; script thường trong `<head>` để áp dụng trước lần vẽ đầu |
| `client/js/dom.js` | Helper DOM `h()`, toast, tải file, `icoTile()` (ô icon loại bước) |
| `client/css/app.css` | Khối token (primitive, sáng/tối, thang đo, icon) rồi tới thành phần; màu và icon loại bước chỉ ở luật `[data-type]`. Quy tắc: `docs/ui-design-system.md` |

Sự kiện của store có `source`: inspector bỏ qua thay đổi do chính nó tạo ra (`source: 'inspector'`)
để không render lại và mất focus khi người dùng đang gõ. Thay đổi cấu trúc dùng `'inspector-structure'`.
View Quy trình dựng lại DOM khi workflow đổi (giữ vị trí cuộn và focus); khi chỉ đổi lựa chọn hay lỗi thì chỉ cập nhật
class và badge. Thu gọn/mở khung là trạng thái UI (`kind: 'view'`), không tạo bước undo.
