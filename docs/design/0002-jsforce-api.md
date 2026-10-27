# 0002 — Gọi API Salesforce bằng jsforce, sf CLI chỉ lấy token

- **Trạng thái:** Đã làm
- **Ngày:** 2026-10-27
- **Liên quan:** [org-connection.md](../org-connection.md), [0001](0001-workflow-editor-ux.md)

## Vấn đề

Bản đầu tự viết REST client bằng `fetch` (`server/sf/client.js`). Các tính năng tiếp theo đã có trong
[0001](0001-workflow-editor-ux.md) gồm Bulk API 2.0, xóa dữ liệu vừa insert, tìm bản ghi có sẵn bằng SOQL. Nếu tự viết
tất cả, ta phải tự lo phân trang query, poll job bulk, upload CSV, chia lô và refresh phiên.

## Mục tiêu / Ngoài phạm vi

- Mục tiêu: mọi lời gọi API Salesforce đi qua jsforce; sf CLI chỉ dùng để liệt kê org và lấy token.
- Ngoài phạm vi: làm Bulk API, delete hay query (chỉ chuẩn bị nền); tự làm OAuth trong app.

## Luồng người dùng

Không đổi. Người dùng vẫn chỉ cần `sf org login web` một lần. Thêm một bước khi cài đặt là `npm install`.
Khi token hết hạn giữa chừng, app tự lấy token mới qua CLI mà người dùng không phải làm gì.

## Thiết kế

```
sf/cli.js   ── sf org list / sf org display ──►  { accessToken, instanceUrl, apiVersion }
                                                        │
sf/client.js ── new jsforce.Connection({ instanceUrl, accessToken, version, refreshFn }) ── 1 connection / org
                 refreshFn(conn, cb) → cli.getConnection(target, { refresh: true }) → cb(null, token)
                 describeGlobal() · describe(name) · sobject(type).create(records, { allOrNone: false })
```

- Interface mà `server/index.js` và `server/sf/insert.js` dùng giữ gọn: `describeGlobal(target)`, `describe(target, name)`,
  `create(target, sobject, records)`, cùng `connection(target)` để tính năng sau dùng thẳng jsforce.
- `insert.js` vẫn tự chia lô 200 bản ghi và chạy theo đợt (wave), vì cần map kết quả của từng bản ghi về `ref` và để
  báo tiến độ sau này.
- Lỗi do Salesforce trả về được bọc thành HTTP 502 `Salesforce: <errorCode>: <message>`, không bị coi là lỗi server.
- Lần tra CLI bị lỗi (ví dụ org chưa đăng nhập) không bị cache, nên đăng nhập xong thử lại là được.

## Checklist tiện dụng

- [x] 1, 2, 6, 7, 8: không đổi UI.
- [x] 3. Insert vẫn cần xác nhận như trước.
- [x] 4. Lỗi Salesforce hiện kèm mã lỗi (`REQUIRED_FIELD_MISSING`, …) để biết sửa field nào.
- [x] 5. Token hết hạn không làm hỏng lần insert: jsforce tự refresh rồi gọi lại.
- [x] 9. Không đổi giới hạn.

## Phương án đã cân nhắc

| Phương án | Ưu | Nhược | Chọn? |
| --- | --- | --- | --- |
| Giữ `fetch` tự viết | Không có dependency | Phải tự làm Bulk/query/refresh | Không |
| jsforce + token từ sf CLI | Đầy đủ API, có refresh hook, cộng đồng lớn | Thêm một dependency (cùng các dependency kéo theo) | **Có** |
| `@salesforce/core` (thư viện của sf CLI) | Đọc auth trực tiếp, không cần spawn CLI | Nặng, gắn chặt với cấu trúc thư mục `~/.sfdx` | Không |
| Gọi `sf data` cho mọi thao tác | Không cần thư viện | Chậm (spawn mỗi lần), khó lấy kết quả từng bản ghi | Không |

## Đã làm

- `server/sf/client.js` viết lại bằng jsforce 3. `insert.js` gọi `client.create(target, sobject, records)`.
- Test: `test/sf.test.js` (connection giả: refreshFn, mã lỗi 502, không cache lỗi) và `test/jsforce.test.js`
  (jsforce thật với Salesforce giả trên localhost: 401 `INVALID_SESSION_ID` → refresh qua CLI → gọi lại thành công).
- Phát hiện khi làm: jsforce bỏ qua `NO_PROXY`, nên test jsforce xóa biến proxy trước khi import.
