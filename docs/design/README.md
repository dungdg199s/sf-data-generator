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
| [0003](0003-process-mode.md) | Chế độ Quy trình (kiểu Power Automate), workflow JSON v2 dạng cây; chế độ Sơ đồ | Đã làm (đợt A và đợt B) |
| [0004](0004-streaming-execution.md) | Chạy dạng luồng: nghiên cứu khả thi và thiết kế | Đã làm |
| [0005](0005-variable-picker.md) | Quét và chọn biến từ UI | Đã làm |
| [0006](0006-query-pick-nodes.md) | Node Query và Chọn bản ghi | Đã làm |
| [0007](0007-tong-hop-0003-0006.md) | Tổng hợp 0003–0006: mâu thuẫn, thứ tự triển khai, quyết định cần chốt | Đã làm |
| [0008](0008-ui-design-system.md) | Chuẩn hoá bảng màu và phong cách UI (design system) | Đã làm |
| [0009](0009-bo-cuc-man-hinh.md) | Bố cục màn hình: danh sách lỗi, thanh trên, bottom sheet, panel kết quả | Đã làm |
| [0010](0010-lap-theo-ban-ghi.md) | Lặp theo từng bản ghi trong pool | Đã làm |
| [0011](0011-thao-tac-du-lieu-org.md) | Thao tác dữ liệu org: Bulk API 2.0, lịch sử chạy, xóa dữ liệu đã insert | Đã duyệt |
| [0012](0012-nang-suat-soan-thao.md) | Năng suất soạn thảo: thư viện workflow, chọn nhiều bước, copy/paste, sửa nhanh | Đã làm |
| [0013](0013-mo-rong-bien-va-lap.md) | Mở rộng biến và lặp | Đã duyệt |
| [0014](0014-hoan-thien-giao-dien.md) | Hoàn thiện giao diện: icon SVG, đổi cao panel kết quả, sheet hai nấc, dấu hiệu cuộn ngang, minimap, phím chọn biến | Đã duyệt |

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

## Việc còn lại

Các mục "Câu hỏi mở" / "Việc tiếp theo" / "Chưa làm" của 0001–0010 đã được đánh dấu ngay tại chỗ (→ **Đã chốt**,
→ **Đã làm**, → **Chuyển sang**, → **Không làm**). Bảng này gom các mục chưa làm vào một chỗ.
"Chưa xếp lịch" là mục còn mở nhưng chưa thuộc design doc nào.

| Mục | Chuyển sang | Ghi chú (nguồn) |
| --- | --- | --- |
| Bulk API 2.0 | [0011](0011-thao-tac-du-lieu-org.md) | 0001, 0004, 0007 |
| Nâng `maxRecordsHard` quá 200 000 | [0011](0011-thao-tac-du-lieu-org.md) | 0004 câu 6, 0007: chờ Bulk API |
| Tải toàn bộ Id đã insert | [0011](0011-thao-tac-du-lieu-org.md) | 0004 câu 7: làm cùng tính năng xóa |
| Xóa dữ liệu vừa insert | [0011](0011-thao-tac-du-lieu-org.md) | 0001, 0004, 0006 "Các node khác", 0007 |
| Chạy tiếp lần chạy đã dừng | [0011](0011-thao-tac-du-lieu-org.md) | 0004 |
| Update / Upsert / Delete bản ghi có sẵn | [0011](0011-thao-tac-du-lieu-org.md) | 0006 "Các node khác" và "Chưa làm" |
| Gửi song song nhiều lô, worker thread | [0011](0011-thao-tac-du-lieu-org.md) | 0004; thứ tự sinh và kết quả vẫn phải tất định |
| Thư viện workflow (nhiều workflow có tên) | [0012](0012-nang-suat-soan-thao.md) | 0001; cũng là điều kiện của sub-workflow (0006) |
| Chọn nhiều bước (Shift+bấm), copy/paste bước | [0012](0012-nang-suat-soan-thao.md) | 0003 "Việc tiếp theo" |
| "Bọc trong Lặp qua từng bản ghi" (menu ⋯) | [0012](0012-nang-suat-soan-thao.md) | 0010 |
| Badge lỗi insert trên thẻ; chip `byStep` cập nhật trực tiếp khi chạy | [0012](0012-nang-suat-soan-thao.md) | 0003, 0004: server đã gửi `byStep` trong `progress`, thẻ chỉ đọc kết quả cuối |
| Giá trị mẫu ngay trong inspector | [0012](0012-nang-suat-soan-thao.md) | 0001 |
| Sửa nhanh "Thêm `<Field>` vào SELECT" | [0012](0012-nang-suat-soan-thao.md) | 0005 câu 8, 0006, 0007 mâu thuẫn 3: lỗi `unknownMember` đã có |
| Import từ org gợi ý field bắt buộc còn thiếu | [0012](0012-nang-suat-soan-thao.md) | 0001 |
| `right` của Rẽ nhánh nhận biến | [0013](0013-mo-rong-bien-va-lap.md) | 0005 câu 3, 0007 |
| Option số nhận biến (số lần lặp = `{{accs.$count}}`) | [0013](0013-mo-rong-bien-va-lap.md) | 0005 câu 4, 0007, 0010 |
| Lọc / giới hạn N / xáo trộn trong Lặp `each` | [0013](0013-mo-rong-bien-va-lap.md) | 0010 |
| Lặp theo danh sách giá trị cố định | [0013](0013-mo-rong-bien-va-lap.md) | 0010 |
| Chọn N bản ghi một lần, chọn theo trọng số | [0013](0013-mo-rong-bien-va-lap.md) | 0006 câu 9, 0007 |
| `minIterations` thông minh hơn | [0013](0013-mo-rong-bien-va-lap.md) | 0010 |
| Mẫu (`samples`) theo mọi bước | [0013](0013-mo-rong-bien-va-lap.md) | 0005: hiện chỉ có cho Chọn bản ghi |
| Biến trong `pick.filterValue` | [0013](0013-mo-rong-bien-va-lap.md) | Phần cơ bản đã có (`vars: 'template'`, 0006); 0013 chỉ mở rộng nếu cần |
| Option phạm vi pool (chỉ bản ghi của lượt hiện tại) | [0013](0013-mo-rong-bien-va-lap.md) | 0010 |
| Icon SVG cho các ký tự còn lại (`⋯ ▸ ▾ ⠿ ↶ ↷ ⟳ ⤓`) | [0014](0014-hoan-thien-giao-dien.md) | 0008, 0009 |
| Kéo đổi chiều cao panel kết quả; bottom sheet hai nấc | [0014](0014-hoan-thien-giao-dien.md) | 0009 |
| Dấu hiệu "còn mục" ở palette ngang | [0014](0014-hoan-thien-giao-dien.md) | 0009 |
| Minimap trên Sơ đồ | [0014](0014-hoan-thien-giao-dien.md) | 0001, 0003 |
| Phím thay thế Ctrl+Space trên macOS | [0014](0014-hoan-thien-giao-dien.md) | 0005 câu 7, 0007: vẫn giữ Ctrl+Space, nút `{x}`, gõ `{{` |
| Kéo thẻ / vị trí tự do trên Sơ đồ | **Không làm** | Trái mô hình cây (bố cục tự tính). Đổi thứ tự bằng Alt+↑/↓, menu ⋯, hoặc kéo trong Quy trình (M) |
| Sửa cấu hình ngay trong thẻ | **Không làm** | 0003 câu 3: chỉ sửa ở inspector, một nơi sửa cho cả hai chế độ |
| Nhánh song song | **Không làm** | 0003, 0004: phá tính tất định theo seed |
| Ước tính số bản ghi theo bước trước khi chạy | [0012](0012-nang-suat-soan-thao.md) | 0003 (phần H) |
| Rê chuột lên chip Lookup thì tô thẻ cha | [0012](0012-nang-suat-soan-thao.md) | 0003 (phần I) |
| Record: đổi sObject thì thay field `Name` bằng name field thật (Task → `Subject`) | [0012](0012-nang-suat-soan-thao.md) | 0003; lỗi thật, làm đầu tiên (phần G) |
| Biến cấp workflow `{{run.seed}}`, `{{run.now}}`, `{{run.today}}` | [0013](0013-mo-rong-bien-va-lap.md) | 0005 "Ý tưởng để sau" |
| Khung nhiều nhánh kiểu Switch (`slots` động) | **Hoãn** | 0003; 0013: cần đổi hợp đồng `slots` cố định theo loại bước |
| Hàm trong template; bước Đặt biến | **Hoãn** | 0005, 0006; 0013: cần design riêng vì đổi ngữ pháp token |
| `{{acc.Id}}` thành Id thật lúc insert | **Hoãn** | 0005; 0013: cần giữ Id qua cửa sổ insert, xem trước sẽ khác insert |
| Option số của generator nhận biến; `count` của Record nhận biến | **Hoãn** | 0013: cần design riêng; bọc Record trong Lặp thay thế |
| Option phạm vi pool (chỉ bản ghi của lượt hiện tại) | **Hoãn** | 0010, 0013 |
| Chọn N bản ghi một lần | **Không làm** | 0013: Lặp `each` + xáo trộn + giới hạn N làm được việc này |
| Đi xuyên Lookup (`{{con.AccountId.Name}}`) | **Không làm** | 0013: phá pool chỉ đếm số (0004) |
| Query phụ thuộc (chạy mỗi lượt) | **Không làm** | 0013: phá mô hình đọc trước và xem trước == insert; dùng Lặp `each` có lọc |
| Chạy tiếp lần đã dừng; Update/Upsert; gửi song song; nâng `maxRecordsHard` | **Không làm** (đợt này) | 0011: xóa rồi chạy lại; Update/Upsert cần design lưu giá trị cũ |
| Trùng alias ở các nhánh loại trừ nhau | **Không làm** | 0003: làm phân tích phạm vi phức tạp; đặt hai tên khác nhau |
| Sub-workflow | **Hoãn** | 0006: cần thư viện workflow (0012) trước |
| Nút "Biến" trên thẻ | **Không làm** | 0005: đã có bộ chọn biến ở inspector và tô thẻ nguồn (0012 phần I) |
