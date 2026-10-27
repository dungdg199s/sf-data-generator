# Design doc

Mỗi tính năng đáng kể có một design doc trước khi code. Agent `planner` (`.claude/agents/planner.md`)
viết và cập nhật các file này theo skill `design-doc`; người viết tay cũng theo cùng mẫu.

- Tên file: `NNNN-ten-ngan.md` (số tăng dần, 4 chữ số), bắt đầu từ [TEMPLATE.md](TEMPLATE.md).
- Trạng thái: `Nháp` → `Đã duyệt` → `Đã làm` (hoặc `Bỏ`). Khi code xong, cập nhật phần "Đã làm".
- Mọi design doc phải đi qua checklist [Nguyên tắc tiện dụng](#nguyên-tắc-tiện-dụng) bên dưới.

## Danh sách

| # | Tiêu đề | Trạng thái |
| --- | --- | --- |
| [0001](0001-workflow-editor-ux.md) | Trải nghiệm trình soạn workflow (bản đầu) | Đã làm |
| [0002](0002-jsforce-api.md) | Gọi API Salesforce bằng jsforce, sf CLI chỉ lấy token | Đã làm |
| [0003](0003-process-mode.md) | Chế độ Quy trình (kiểu Power Automate), workflow JSON v2 dạng cây | Đã duyệt |
| [0004](0004-streaming-execution.md) | Chạy dạng luồng: nghiên cứu khả thi và thiết kế | Đã duyệt |
| [0005](0005-variable-picker.md) | Quét và chọn biến từ UI | Đã duyệt |
| [0006](0006-query-pick-nodes.md) | Node Query và Chọn bản ghi | Đã duyệt |
| [0007](0007-tong-hop-0003-0006.md) | Tổng hợp 0003–0006: mâu thuẫn, thứ tự triển khai, quyết định cần chốt | Đã duyệt |

## Nguyên tắc tiện dụng

Đây là tiêu chí chung để đánh giá mọi thiết kế. Khi một thiết kế phải vi phạm nguyên tắc nào, ghi rõ lý do trong doc.

1. **Chạy được ngay với mặc định.** Node, field và option mới thêm vào phải sinh ra dữ liệu hợp lý mà không cần chỉnh gì.
   Không bắt người dùng điền trước khi thấy kết quả.
2. **Ít thao tác cho việc hay làm.** Việc phổ biến (thêm node nối tiếp, import field từ org, xem trước) chỉ tốn 1–2 thao tác.
   Có phím tắt cho thao tác lặp lại.
3. **Xem trước trước khi ghi.** Mọi thao tác ghi vào org đều có bước xác nhận, ghi rõ org nào và bao nhiêu bản ghi.
   Org production phải có cảnh báo riêng. Seed giúp xem trước và insert ra cùng dữ liệu.
4. **Lỗi chỉ đúng chỗ và nói cách sửa.** Lỗi gắn với node và field (badge, viền đỏ, bấm vào để nhảy tới).
   Thông báo bằng tiếng Việt, nói *phải làm gì*, không chỉ nói *cái gì sai*.
5. **Không mất công sức.** Có autosave, undo/redo, xác nhận trước khi ghi đè workflow. Đổi alias thì tham chiếu tự cập nhật theo.
6. **Lấy thông tin từ org thay vì bắt gõ.** Tên sObject, field, giá trị picklist, quan hệ lookup nên được gợi ý hoặc điền sẵn từ describe.
7. **Một nguồn sự thật.** Option và kiểu dữ liệu khai báo ở server, UI dựng form từ meta. Tính năng mới không được nhân đôi định nghĩa ở client.
8. **Giải thích tại chỗ.** Mỗi option khó hiểu có `help` ngắn. Ví dụ cú pháp (`{{acc.Name}}`, `-1y`) nằm ngay cạnh ô nhập.
9. **An toàn khi lỡ tay.** Có giới hạn số bản ghi, số bước, kích thước request. Workflow sai không được làm treo server hay spam org.
