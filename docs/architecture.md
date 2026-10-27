# Kiến trúc

## Luồng tổng thể

```
Trình duyệt (client/)                         Server Node.js (server/)
┌──────────────────────────┐   GET /api/meta   ┌───────────────────────────────┐
│ Canvas node + Inspector  │ ◄──────────────── │ generators/  (field types)    │
│ (form sinh từ meta)      │                   │ workflow/nodes.js (node types)│
│                          │  POST /api/validate│                               │
│ state.workflow (JSON)    │ ────────────────► │ workflow/schema.js            │
│                          │  POST /api/run    │ workflow/executor.js          │
│ Kết quả / CSV / JSON     │ ◄──────────────── │   └─► sf/insert.js (nếu org)  │
└──────────────────────────┘                   │ sf/cli.js ─► `sf` CLI máy local│
                                               │ sf/client.js ─► Salesforce REST│
                                               └───────────────────────────────┘
```

1. Khi tải trang, UI gọi `GET /api/meta` để lấy danh sách field type, node type và option schema của từng loại.
   UI **không hard-code** option nào: form trong inspector được dựng từ meta này (`client/js/forms.js`).
2. Người dùng dựng workflow trên canvas. Mỗi lần sửa, UI gọi `POST /api/validate` (debounce 400 ms)
   để hiện lỗi/cảnh báo gắn đúng node và field.
3. Khi bấm **Xem trước** hoặc **Insert vào org**, UI gửi toàn bộ workflow JSON lên `POST /api/run`.
   Server validate lại, chạy executor, và nếu `target.kind === 'org'` thì insert.

## Các phần ở server

| Thư mục | Trách nhiệm | Ghi chú |
| --- | --- | --- |
| `server/generators/` | Mỗi kiểu field Salesforce một generator, tự khai báo option | Registry trong `index.js`; xử lý chung `nullRatio`/`unique` |
| `server/workflow/` | Danh mục node, validate, chạy workflow | Executor là hàm thuần: không I/O, không gọi org |
| `server/sf/` | sf CLI, REST client, map describe → field, insert | Không lưu credential; token chỉ cache trong bộ nhớ 10 phút |
| `server/random.js` | PRNG có seed (mulberry32) | Cùng workflow + seed ⇒ cùng dữ liệu |

## Quyết định thiết kế quan trọng

- **Không framework, không dependency runtime.** Server dùng `node:http`, client dùng ES modules thuần,
  không có bước build. Chỉ thêm thư viện khi thực sự cần (yêu cầu của dự án).
- **Server bind `127.0.0.1` mặc định.** Server hành động bằng quyền của sf CLI trên máy,
  nên không được lộ ra mạng trừ khi đặt `HOST` một cách có chủ đích.
- **Seed để tái lập.** Xem trước với seed cố định rồi insert với cùng seed thì dữ liệu insert giống hệt bản xem trước.
- **Lookup dùng placeholder `{ "$ref": "alias#n" }`.** Executor không biết Id thật; `sf/insert.js` chèn
  theo từng "đợt" (wave) để bản ghi cha luôn có Id trước bản ghi con.
- **Điều kiện rẽ nhánh là dữ liệu có cấu trúc**, không phải chuỗi để `eval`, nên an toàn
  và UI có thể dựng bằng form.
- **Lỗi validate luôn kèm `nodeId` và `field`** để UI tô đỏ đúng chỗ (badge trên node, viền đỏ ở field).

## Giới hạn an toàn (`server/workflow/nodes.js` → `LIMITS`)

| Giới hạn | Giá trị | Ý nghĩa |
| --- | --- | --- |
| `maxRecordsDefault` | 50 000 | Số bản ghi tối đa mỗi lần chạy nếu workflow không đặt `settings.maxRecords` |
| `maxRecordsHard` | 200 000 | Trần cứng, không vượt được |
| `maxCountPerNode` | 100 000 | Số lần lặp / số bản ghi tối đa của một node |
| `maxSteps` | 2 000 000 | Chặn workflow lặp lồng nhau chạy quá lâu |

## Client

| File | Trách nhiệm |
| --- | --- |
| `client/js/store.js` | State duy nhất, undo/redo, autosave `localStorage`, phát sự kiện thay đổi |
| `client/js/canvas.js` | Vẽ node/cạnh, kéo thả, nối cổng, pan/zoom, thêm node tự nối |
| `client/js/inspector.js` | Cấu hình node, trình soạn field, import field từ org, đổi alias tự cập nhật tham chiếu |
| `client/js/forms.js` | Dựng form từ option schema (`showIf`, các `kind`) |
| `client/js/results.js` | Bảng kết quả theo sObject, lỗi insert, tải JSON/CSV |
| `client/js/main.js` | Khởi động, toolbar, phím tắt, validate trực tiếp, chạy/insert |

Sự kiện của store có `source`: inspector bỏ qua thay đổi do chính nó tạo ra (`source: 'inspector'`)
để không render lại và mất focus khi người dùng đang gõ. Thay đổi cấu trúc dùng `'inspector-structure'`.
