# NNNN — Tiêu đề

- **Trạng thái:** Nháp | Đã duyệt | Đã làm | Bỏ
- **Ngày:** YYYY-MM-DD
- **Liên quan:** (design doc khác, issue, PR)

## Vấn đề

Người dùng đang gặp khó gì? Viết theo góc nhìn của họ, có ví dụ cụ thể (sObject, số lượng, quan hệ).

## Mục tiêu / Ngoài phạm vi

- Mục tiêu: …
- Ngoài phạm vi: …

## Luồng người dùng

Từng bước người dùng làm, kể cả trường hợp lỗi. Đếm số thao tác cho luồng chính.

1. …

## Thiết kế UI

Bố cục, control, mặc định, phím tắt, thông báo lỗi (đúng câu chữ). Có thể vẽ ASCII.

## Thay đổi dữ liệu / API

- Workflow JSON (`docs/workflow-schema.md`): khóa mới, giá trị mặc định, có tương thích ngược không.
- Endpoint mới hoặc thay đổi.
- Option schema mới (`kind`, `showIf`, …).

## Checklist tiện dụng

Đánh dấu theo [Nguyên tắc tiện dụng](README.md#nguyên-tắc-tiện-dụng); ghi lý do nếu không đạt.

- [ ] 1. Chạy được ngay với mặc định
- [ ] 2. Ít thao tác cho việc hay làm
- [ ] 3. Xem trước trước khi ghi
- [ ] 4. Lỗi chỉ đúng chỗ và nói cách sửa
- [ ] 5. Không mất công sức
- [ ] 6. Lấy thông tin từ org thay vì bắt gõ
- [ ] 7. Một nguồn sự thật
- [ ] 8. Giải thích tại chỗ
- [ ] 9. An toàn khi lỡ tay

## Phương án đã cân nhắc

| Phương án | Ưu | Nhược | Chọn? |
| --- | --- | --- | --- |

## Kế hoạch thực hiện

Các bước nhỏ, mỗi bước có test hoặc cách kiểm tra. Ghi rõ file nào sẽ đổi.

## Câu hỏi mở

## Đã làm

(Cập nhật khi code xong: commit hoặc PR, chỗ nào khác với thiết kế và vì sao.)
