# Dịch vụ khách hàng trên storefront

## API và quyền truy cập

Tất cả kết quả có dạng `{ success: true, data: ... }`. Lỗi dùng mã HTTP và thông báo hiện có. Ngoại trừ `/spec-fields`, các route dưới `/api/customer` yêu cầu Bearer token; không nhận `user_id` từ client. Dữ liệu riêng đặt `Cache-Control: no-store`.

| Method | Path sau `/api/customer` | Request | Kết quả / hành vi |
| --- | --- | --- | --- |
| GET | `/spec-fields` | — | Mẫu thông số chuẩn theo danh mục, công khai |
| GET | `/state` | — | ID yêu thích, ID báo hàng đang chờ, email tài khoản và trạng thái cấu hình SMTP |
| GET | `/wishlist` | — | Sản phẩm yêu thích của chính tài khoản |
| PUT / DELETE | `/wishlist/:productId` | — | Lưu / bỏ sản phẩm; gọi lại không tạo trùng |
| GET | `/stock-alerts` | — | Đăng ký đang chờ và lịch sử gửi email của chính tài khoản |
| PUT / DELETE | `/stock-alerts/:productId` | — | Đăng ký / hủy báo hàng; chỉ đăng ký sản phẩm đang hết hàng và SMTP đã cấu hình |
| GET | `/warranties` | `?search=<serial hoặc mã đơn>` | Tối đa 100 serial đang gắn với đơn của chính tài khoản và phiếu bảo hành đúng lần bán |
| GET | `/return-items` | `?order=<mã đơn>` tùy chọn | Tối đa 200 dòng hàng đã giao/hoàn tất còn số lượng có thể yêu cầu |
| GET | `/returns` | — | Tối đa 200 yêu cầu gần nhất của tài khoản |
| POST | `/returns` | `{order_item_id, quantity, reason}` | Tạo yêu cầu chờ duyệt; server tự tính tiền dự kiến sau giảm giá, không nhận số tiền do khách gửi |
| POST | `/returns/:id/cancel` | — | Hủy yêu cầu của mình khi còn chờ duyệt |

Khách không được duyệt, nhận trả kho hay hoàn tiền. Các bước này vẫn thực hiện ở admin. Đổi sang sản phẩm khác dùng quy trình trả hàng rồi tạo đơn mới. Đơn mua trước khi đăng nhập chỉ hiện nếu đã được gắn với tài khoản bằng luồng đơn hàng hiện có.

## Trang FE

- `/account/wishlist`: yêu thích lưu database; nút tim tại thẻ và chi tiết sản phẩm.
- `/account/warranty`: đăng nhập để tra cứu serial/mã đơn và tiến độ bảo hành.
- `/account/returns`: gửi yêu cầu, xem tiền dự kiến, trạng thái và hủy yêu cầu chờ duyệt. Chi tiết đơn có liên kết điền sẵn mã đơn.
- `/account/stock-alerts`: email nhận thông báo, đăng ký đang chờ và lịch sử gửi; nút hủy.
- `/products`: chọn một danh mục cụ thể để hiện thông số chuẩn. Nhiều lựa chọn trong cùng trường dùng OR, các trường dùng AND. Trường số lọc theo khoảng bao gồm hai đầu. Đơn vị/kiểu không thống nhất giữa các mẫu sẽ không được gộp thành một trường lọc. Sản phẩm cần gán mẫu thông số ở admin để tham gia lọc chuyên sâu.

Bộ lọc tiếp tục chạy trên danh sách sản phẩm đã tải như source cũ, giữ chức năng giá/hãng/tồn/sắp xếp/phân trang. Ưu tiên thương hiệu được gán ở admin, dữ liệu cũ vẫn dò hãng theo thông số/tên như trước.

## Database và triển khai

```sh
npm run migrate-db
npm run migrate-db -- --apply
npm start
```

Thêm hai bảng `wishlists`, `stock_alerts` và khóa `warranty_tickets.order_item_id`. Không đổi bảng không liên quan. Các phiếu bảo hành mới lưu đúng dòng đơn tại lúc tiếp nhận, tránh lộ lịch sử của lần bán trước nếu serial được trả và bán lại. Phiếu cũ không có liên kết đơn vẫn xem được ở admin; không tự suy diễn chủ đơn cho các phiếu đó.

Khởi động lại backend và build FE sau migration. Không cần đổi source admin để duyệt các yêu cầu gửi từ FE.

## Email hàng về

- Dùng SMTP hiện có (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`); đặt `FRONTEND_URL` là URL shop thật để liên kết trong email đúng domain.
- Backend chạy worker mỗi 60 giây, kiểm tra tối đa 50 đăng ký đang chờ/lượt. Sản phẩm còn hàng thì gửi tới email hiện tại của tài khoản đang hoạt động. Mỗi tài khoản/sản phẩm chỉ có một đăng ký hoạt động.
- MySQL advisory lock tránh nhiều tiến trình cùng gửi một lượt. Chỉ đánh dấu đã gửi khi mailer báo thành công. Lỗi SMTP giữ đăng ký và thử lại sau 15 phút, không ghi nhận đã gửi giả.
- Hủy đăng ký ngăn các lượt gửi tiếp theo; email đã được bàn giao tới SMTP không thu hồi được. Email không giữ hàng, không cam kết giá.
- Worker khôi phục đăng ký sau khi backend khởi động lại. Nếu tiến trình dừng đúng giữa lúc SMTP chấp nhận mail và lúc lưu trạng thái thì có thể gửi lại; không cam kết exactly-once giữa SMTP và MySQL.
- Đây là dịch vụ cần backend chạy thường trực; tạm dừng backend thì tạm dừng gửi. SMTP được cấu hình chưa đồng nghĩa email chắc chắn vào inbox; cần kiểm tra môi trường triển khai và spam folder.

## Kiểm thử

```sh
npm test
npm run test:operations:integration
```

Integration tạo database riêng dùng thử rồi dọn, email được giả lập; bao phủ cách ly tài khoản, tính lặp an toàn, bảo hành đúng lần bán, giới hạn đổi trả, gửi lại khi lỗi, hủy đăng ký và hai worker đồng thời. `node tests/operations.integration.test.js --serve` giữ API QA ở cổng 3100 với fixture; nhập `stop` rồi Enter để dọn.

Trong FE chạy `npm run build`, `npm run lint`, `node scripts/test-spec-filters.cjs`. Test lọc bao phủ chọn giá trị, khoảng số, trường thiếu, kiểu số và danh mục khác.
