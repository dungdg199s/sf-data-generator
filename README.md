# SF Data Generator

Công cụ sinh dữ liệu test đúng kiểu dữ liệu Salesforce. Bạn dựng workflow bằng các bước (Record, Lặp, Rẽ nhánh) xếp từ trên xuống như Power Automate,
xem trước dữ liệu, rồi insert vào org đã đăng nhập bằng Salesforce CLI.

## Yêu cầu

- Node.js 20 trở lên
- (Không bắt buộc) [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) `sf`, đã đăng nhập org: `sf org login web --alias dev`

Cài dependency (chỉ có [jsforce](https://jsforce.github.io/)) một lần:

```bash
npm install
```

## Chạy

```bash
npm start          # http://127.0.0.1:3000
PORT=4000 npm start
npm run dev        # tự khởi động lại khi sửa code server
npm test
```

## Dùng nhanh

1. Mở trang, chọn mẫu **Account + Contact** ở cột trái, hoặc bấm **+ Thêm bước đầu tiên** / **Record** / **Lặp** ở cột trái.
   Bước mới vào sau bước đang chọn, hoặc vào nhánh còn trống của khung Lặp / Rẽ nhánh đang chọn. Nút **+** giữa hai bước
   chèn đúng chỗ đó; kéo tay cầm ⠿ (hoặc Alt+↑ / Alt+↓) để di chuyển.
2. Chọn bước để cấu hình ở cột phải. Với bước Record, bấm **Import từ org…** để lấy field có sẵn từ org.
3. **▶ Xem trước** (Ctrl+Enter) để sinh dữ liệu và xem bảng kết quả, tải JSON hoặc CSV.
4. Bấm **📌 giữ seed** để lần chạy sau ra đúng dữ liệu đó, chọn org, rồi bấm **⤒ Insert vào org**.

File workflow cũ (version 1, dạng sơ đồ nối dây) vẫn mở được: ứng dụng tự chuyển sang dạng các bước và giữ bản gốc.

Tài liệu chi tiết ở [docs/](docs/README.md).
