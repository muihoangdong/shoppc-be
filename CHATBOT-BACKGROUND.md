# AI tách nền ảnh sản phẩm trong chatbot

Ví dụ lệnh:

> Tách nền ảnh chính của sản phẩm #25, cho tôi xem PNG trước khi cập nhật.

Hoặc:

> Xem thư viện ảnh của RAM Kingston Fury Beast, tách nền ảnh mặt trước, giữ nguyên các ảnh cũ.

## Luồng xử lý

1. Chatbot tra đúng sản phẩm/ảnh hiện có bằng các tool đọc. Ảnh Internet mới tìm cần được chọn và lưu vào sản phẩm trước, hoặc tải file từ máy lên form sản phẩm.
2. `remove_product_background` tạo thẻ xác nhận, ghi rõ ảnh nguồn, gửi ảnh đến Photoroom và khả năng dùng hạn mức/tính phí API. Chưa gọi AI trước khi người dùng xác nhận.
3. Sau xác nhận, backend đọc ảnh nội bộ hoặc tải URL HTTPS công khai, gọi Photoroom Remove Background API, lưu PNG trong thư mục upload và trả ảnh xem trước trong chatbot. Ảnh sản phẩm chưa thay đổi.
4. Người dùng kiểm tra ảnh trên nền caro, bấm **Dùng ảnh này**. Chatbot tạo thẻ xác nhận `apply_background_removed_image`; sau xác nhận mới cập nhật ảnh chính và giữ ảnh cũ trong thư viện. Bước áp dụng không gọi AI lần nữa.

Chỉ một yêu cầu xử lý ảnh mỗi lượt chat, tối đa 3 ảnh/phút/tài khoản. Thẻ xác nhận dùng một lần. Kết quả chờ áp dụng thuộc đúng tài khoản/sản phẩm, hết hạn sau 30 phút hoặc khi backend restart. Nếu ảnh nguồn/ảnh chính đã đổi thì phải tạo kết quả mới. Không tự xóa ảnh cũ nếu thư viện đã đủ 20 ảnh.

## Cấu hình backend

```env
PHOTOROOM_API_KEY=<key Remove Background API của Photoroom>
PUBLIC_API_URL=https://api.shop-cua-ban.com
UPLOAD_DIR=/var/data/uploads
```

- `PHOTOROOM_API_KEY` bắt buộc để xử lý thật. Chỉ đặt trong Environment backend/Render, không gửi key trong chatbot hoặc đưa vào frontend.
- `PUBLIC_API_URL`: origin công khai của backend, trùng origin mà admin dùng làm API. Render dùng `RENDER_EXTERNAL_URL` khi không đặt biến này; local mặc định `http://localhost:3000` (theo PORT).
- PNG dùng cùng cơ chế upload hiện có. Cần persistent disk cho `UPLOAD_DIR` để ảnh không mất khi redeploy. File chưa áp dụng được lưu như các file upload nháp khác, không tự dọn/xóa trong tính năng này.
- Không đổi database, không cài mô hình AI nặng vào Render. Photoroom là dịch vụ ngoài, cần tài khoản/key và hạn mức theo nhà cung cấp. Tài liệu chính thức: https://docs.photoroom.com/remove-background-api-basic-plan/quickstart-guide.

## Phạm vi và bảo vệ

- Chỉ staff/admin dùng được. Chỉ xử lý ảnh chính hoặc ảnh trong thư viện của sản phẩm đang chọn, không nhận file đường dẫn tùy ý từ model.
- Ảnh PNG/JPEG/WebP tối đa 10 MB. URL bên ngoài phải HTTPS; DNS IPv4 công khai được kiểm tra và pin vào kết nối TLS, không theo redirect hay truy cập mạng nội bộ. Ảnh không tải được có thể tải lên form sản phẩm trước.
- Kết quả yêu cầu định dạng PNG. Giữ kích thước/không đặt nền mới trong request. Cần kiểm tra biên, dây và các linh kiện nhỏ trước khi áp dụng; kết quả AI có thể chưa phù hợp.
- Lỗi key/hạn mức, timeout, response sai định dạng hoặc file quá lớn đều không cập nhật sản phẩm. Không tự retry request AI để tránh dùng thêm hạn mức; timeout không khẳng định nhà cung cấp chưa tính phí.
- Backend hiện lưu pending và kết quả trong bộ nhớ như chatbot cũ, phù hợp một instance. Chạy nhiều instance cần shared store để xác nhận không rơi sang instance khác.
- Giao diện preview chỉ tải PNG từ origin API, có liên kết mở ảnh và nền caro. Preview không lưu trong sessionStorage; tải lại trang sẽ mất thẻ xem trước. Có thể dùng mã kết quả còn hiệu lực để nhờ chatbot chuẩn bị cập nhật.

## API nội bộ

- Tool ghi `remove_product_background({product_id, source_url?})`: default ảnh chính, mô tả xác nhận chụp URL nguồn. `POST /api/chat/confirm` trả thêm `preview: {result_id, product_id, image_url, original_url}` khi thành công.
- Tool ghi `apply_background_removed_image({product_id, result_id})`: ràng buộc quyền sở hữu và ảnh nguồn, chờ xác nhận rồi cập nhật qua model sản phẩm hiện có, ghi audit và phát sự kiện sản phẩm.

Kiểm thử: `npm test`, `npm run test:background-removal`; admin `npm run build` và `npm run lint`. Các test dùng Photoroom giả lập, kiểm tra luồng thật của pending/confirm và file PNG được lưu; không gửi ảnh thật tới Photoroom khi chưa có key được cấu hình.
