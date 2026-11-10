# Upload ảnh và mô hình sản phẩm

Form sản phẩm admin có nút tải từ máy tính, tự điền URL ảnh hoặc mô hình vào các trường hiện có. Bấm **Lưu sản phẩm** để áp dụng. Có thể tải một GLB/GLTF và một USDZ cùng lúc. Thay ảnh/mô hình không tự xóa file cũ vì file có thể còn được tham chiếu ở sản phẩm khác.

## Lưu trữ khi deploy

File lưu tại `uploads/products` của backend, hoặc thư mục tuyệt đối cấu hình bằng `UPLOAD_DIR`. Thư mục này đã được Git bỏ qua. Không cần đổi database.

**Server production cần ổ đĩa bền vững/persistent disk** (ví dụ mount `/var/data/uploads` rồi đặt `UPLOAD_DIR=/var/data/uploads`). Ổ tạm của dịch vụ hosting có thể mất file khi khởi động lại hoặc deploy. Nhiều instance cần dùng chung thư mục lưu trữ hoặc thay bằng object storage.

URL ảnh/mô hình được admin chuyển thành URL đầy đủ của API. Cấu hình `VITE_API_URL` đúng địa chỉ backend HTTPS khi deploy, đồng thời thêm domain storefront/admin vào `CORS_ORIGINS`. AR trên điện thoại cần file truy cập công khai qua HTTPS.

## Hợp đồng API

- `POST /api/uploads/image?filename=ten.png`: PNG/JPG/JPEG/WEBP, tối đa 10 MiB.
- `POST /api/uploads/model?filename=ten.glb`: GLB/GLTF/USDZ, tối đa 50 MiB.
- Body là bytes file (`Content-Type: application/octet-stream`); `Authorization: Bearer ...` bắt buộc, quyền admin hoặc staff. Giới hạn 20 request upload/phút/IP.
- Thành công: HTTP 201, `{ "success": true, "data": { "url": "/api/uploads/files/UUID.glb", "filename": "ten.glb", "size": 123, "type": "glb" } }`.
- `GET /api/uploads/files/UUID.ext`: công khai, MIME theo định dạng; hỗ trợ HTTP Range. Tên do server tạo, không dùng tên người dùng làm đường dẫn.
- Lỗi: 400 file rỗng/sai nội dung/định dạng; 401 chưa đăng nhập; 403 không đủ quyền; 413 quá lớn; 429 quá nhiều request.
- GLTF và GLB phải tự chứa dữ liệu/texture, không tham chiếu `.bin` hay ảnh bên ngoài. Nếu GLTF có các file đi kèm, xuất lại thành GLB đóng gói đầy đủ trước khi tải.
- USDZ là file bổ sung cho iPhone; vẫn cần GLB/GLTF để bật xem 3D trên web.

Kiểm tra: `node tests/uploads.test.js` (HTTP thật trên cổng tạm, thư mục test riêng; không cần DB).
