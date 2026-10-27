# SF Data Generator

Công cụ sinh dữ liệu test đúng kiểu dữ liệu Salesforce. Bạn dựng workflow bằng node (Record, Lặp, Rẽ nhánh),
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

1. Mở trang, chọn mẫu **Account + Contact** ở cột trái, hoặc chọn node **Bắt đầu** rồi bấm **Record** / **Lặp** để thêm và tự nối.
2. Chọn node để cấu hình ở cột phải. Với node Record, bấm **Import từ org…** để lấy field có sẵn từ org.
3. **▶ Xem trước** (Ctrl+Enter) để sinh dữ liệu và xem bảng kết quả, tải JSON hoặc CSV.
4. Bấm **📌 giữ seed** để lần chạy sau ra đúng dữ liệu đó, chọn org, rồi bấm **⤒ Insert vào org**.

Tài liệu chi tiết ở [docs/](docs/README.md).
