# 0001 — Trải nghiệm trình soạn workflow (bản đầu)

- **Trạng thái:** Đã làm
- **Ngày:** 2026-10-27
- **Liên quan:** [architecture.md](../architecture.md), [workflow-schema.md](../workflow-schema.md)

## Vấn đề

Tạo dữ liệu test cho Salesforce thường phải viết script Apex, dùng Data Loader với CSV soạn tay, hoặc dùng công cụ
không hiểu quan hệ giữa các object. Việc hay làm nhất là "N Account, mỗi Account vài Contact, một phần có Opportunity",
đúng kiểu dữ liệu và ràng buộc của org. Người dùng cần mô tả việc này bằng kéo thả, xem trước, rồi đẩy vào org.

## Mục tiêu / Ngoài phạm vi

- Mục tiêu: dựng workflow bằng node (Record, Lặp, Rẽ nhánh); option theo từng kiểu field; xem trước; insert vào org lấy từ sf CLI.
- Ngoài phạm vi (bản này): Bulk API, rollback dữ liệu đã insert, upsert theo External Id, cộng tác nhiều người, lưu workflow trên server.

## Luồng người dùng

Luồng chính "Account + Contact" từ workflow trống:

1. Chọn node **Bắt đầu**, bấm **Lặp** ở cột trái. Node Lặp được thêm và tự nối. (1 thao tác)
2. Bấm **Record**. Node nối vào cổng "lặp", mặc định Account, alias `acc`, có sẵn field `Name`. (1)
3. Đổi số lần lặp. Gõ `Contact` vào sObject thì alias tự đổi thành `con`. (2)
4. Chọn org ở thanh trên, bấm **Import từ org…**. Field bắt buộc được chọn sẵn, `AccountId` tự chọn node cha `acc`. (3)
5. **Ctrl+Enter** để xem trước, bấm **📌 giữ seed**, rồi **Insert vào org**. Hộp xác nhận ghi rõ org, số bản ghi,
   và cảnh báo nếu là production. (3)

Người dùng mới có thể bắt đầu từ mẫu "Account + Contact" ở cột trái.

## Thiết kế UI

```
┌ Topbar: tên workflow · Mới/Mở/Lưu/↶/↷ ········ Seed · Org ⟳ · ▶ Xem trước · ⤒ Insert ┐
├ Palette ──┬──────────── Canvas (pan/zoom, lưới) ───────────┬── Inspector ──────────────┤
│ Record    │  [Bắt đầu]──►[Lặp]══lặp══►[Record acc]──►…      │ option của node           │
│ Lặp       │                    ╚xong►                       │ Fields: tên · kiểu · ⚙↑↓✕ │
│ Rẽ nhánh  │  (badge đỏ/vàng trên node có lỗi/cảnh báo)      │ + Thêm field · Import…    │
│ Mẫu…      │  [danh sách lỗi, bấm để nhảy tới node]          │                           │
├───────────┴─────────────────────────────────────────────────┴───────────────────────────┤
│ Kết quả: chip theo sObject · seed · 📌 · tab theo sObject · bảng 200 dòng · JSON/CSV    │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

- Bấm item trong palette: node mới đặt bên phải node đang chọn và nối từ **cổng ra còn trống đầu tiên**
  ("lặp" trước "xong", "đúng" trước "sai"). Kéo item vào canvas: đặt tại chỗ thả, không tự nối.
- Kéo từ cổng ra sang node để nối. Nối lại cổng đã có cạnh thì **thay** cạnh cũ (mỗi cổng một cạnh).
- Phím tắt: Delete, Ctrl+D (nhân bản), Ctrl+Z / Ctrl+Shift+Z, Ctrl+S, Ctrl+Enter, Esc. Khi đang gõ trong ô nhập,
  phím tắt để lại cho ô nhập (trừ Ctrl+Enter và Ctrl+S).
- Option có `showIf` chỉ hiện khi liên quan (ví dụ "Mẫu" chỉ hiện khi Kiểu nội dung = Theo mẫu).
- Validate trực tiếp (debounce 400 ms): badge trên node, viền đỏ ở field, danh sách lỗi góc canvas.
- Autosave vào `localStorage`. Org đã chọn cũng được nhớ.

## Thay đổi dữ liệu / API

Định nghĩa schema version 1 ([workflow-schema.md](../workflow-schema.md)) và các endpoint `/api/meta`,
`/api/validate`, `/api/run`, `/api/orgs*`.

## Checklist tiện dụng

- [x] 1. Mặc định chạy được: node Record mới có field `Name`, mọi option có default.
- [x] 2. Thêm node bằng 1 cú bấm và tự nối, import field từ org, phím tắt.
- [x] 3. Hộp xác nhận insert ghi rõ org, cảnh báo production, seed để tái lập.
- [x] 4. Lỗi gắn `nodeId` và `field`; câu chữ chỉ cách sửa (ví dụ "Hãy đặt node "acc" trước node này").
- [x] 5. Autosave, undo/redo 100 bước, xác nhận khi thay workflow, đổi alias thì tham chiếu tự cập nhật.
- [x] 6. Import describe: field bắt buộc, picklist value, tự đoán node cha.
- [x] 7. UI dựng form từ `/api/meta`.
- [x] 8. `help` cho option khó; ví dụ cú pháp ngay cạnh ô nhập.
- [x] 9. `LIMITS` (số bản ghi, số bước), body tối đa 10 MB, server chỉ bind localhost.

## Phương án đã cân nhắc

| Phương án | Ưu | Nhược | Chọn? |
| --- | --- | --- | --- |
| React + thư viện flow (React Flow) | Nhiều tính năng canvas | Cần build, nặng, trái yêu cầu "chỉ thêm khi thật cần" | Không |
| Canvas tự viết (div + SVG) | Không build, đủ cho đồ thị nhỏ–vừa | Tự lo pan/zoom và nối cạnh | **Có** |
| Điều kiện rẽ nhánh dạng biểu thức JS | Linh hoạt | Phải `eval`, khó validate, khó dựng UI | Không |
| Điều kiện có cấu trúc (`kind`/`op`) | An toàn, dựng bằng form được | Ít linh hoạt hơn | **Có** |
| Node "Output" riêng trong graph | Cấu hình đích trong workflow | Thêm thao tác; đích thường đổi theo lần chạy | Không: đích chọn ở toolbar |

## Câu hỏi mở / Việc tiếp theo

- Lưu nhiều workflow có tên (thư viện workflow) thay vì một bản autosave duy nhất.
- Xem trước nhanh ngay trong inspector: 3 giá trị mẫu cho field đang sửa.
- Bulk API 2.0 khi số bản ghi lớn hơn khoảng 10 000; hiện tiến độ insert theo thời gian thực (SSE).
- Xóa dữ liệu vừa insert (lưu danh sách Id theo lần chạy).
- Import từ org cho cả node đã có field: gợi ý field bắt buộc còn thiếu.
- Lookup tới bản ghi có sẵn trong org bằng SOQL (thay vì dán Id).
- Minimap và căn chỉnh tự động khi workflow lớn.

## Đã làm

Bản khung đầu tiên của dự án (server, client, test). Khác với thiết kế: chưa có lưu nhiều workflow; chưa có xem trước trong inspector.
