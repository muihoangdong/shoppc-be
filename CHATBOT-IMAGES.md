# Tìm ảnh Internet và cập nhật qua chatbot admin

Ví dụ nhập trong chatbot:

> Tự tìm ảnh trên Internet cho sản phẩm RAM Kingston Fury Beast DDR5 16GB. Cho tôi URL ảnh và trang nguồn để xem trước, sau đó chuẩn bị cập nhật ảnh chính, giữ các ảnh cũ.

Hoặc:

> Tìm 3 ảnh Internet cho sản phẩm #25, không dùng ảnh khác model. Cho tôi chọn trước khi cập nhật.

1. Chatbot tra sản phẩm có thật bằng `list_products` / `get_product`.
2. Tool đọc `search_product_images({product_id, query?})` tìm tối đa 8 ảnh. Mặc định query là tên sản phẩm; chỉ gửi tên/model công khai tới nguồn tìm kiếm.
3. Kết quả gồm URL ảnh gốc, trang nguồn, tên ảnh và thông tin quyền sử dụng nếu nguồn cung cấp. Các liên kết trong chatbot mở tab mới. Kết quả tìm kiếm chỉ là gợi ý; chưa xác minh đúng model/màu/phiên bản.
4. Khi đã chọn ảnh, tool ghi `apply_searched_product_image({product_id, image_url})` chuẩn bị thẻ xác nhận có URL và nguồn. Chỉ khi bấm Xác nhận, URL được lưu thành ảnh chính và đưa lên đầu thư viện; ảnh cũ được giữ lại. Không tải/copy file ảnh về server.

## Nguồn

- Không cần API key: Wikimedia Commons qua API `https://commons.wikimedia.org/w/api.php`, generator search trong namespace File và imageinfo. Chỉ lấy JPEG/PNG/WebP. Ảnh linh kiện/model thương mại có thể ít hoặc không có; chatbot phải nói rõ không tìm được, không bịa URL.
- Khi có `BRAVE_SEARCH_API_KEY`: dùng Brave Image Search qua `https://api.search.brave.com/res/v1/images/search`. Cần tài khoản/key và hạn mức của nhà cung cấp. Đây là tùy chọn mở rộng nguồn ảnh; không có key thì Commons vẫn hoạt động. Key chỉ đặt ở backend/Render Environment, không đưa vào frontend hoặc chat.
- Tài liệu nguồn: https://www.mediawiki.org/wiki/API:Imageinfo và https://api-dashboard.search.brave.com/app/documentation/image-search.

Chủ shop kiểm tra ảnh đúng sản phẩm và điều kiện sử dụng tại trang nguồn; Commons có thể yêu cầu ghi tên tác giả/giấy phép. Việc dùng URL không tự tạo quyền sử dụng hay tự thêm attribution vào trang sản phẩm. Ảnh bên ngoài có thể bị gỡ/chặn hotlink; có thể tải ảnh hợp lệ lên bằng form sản phẩm để chủ động lưu trữ.

## Ràng buộc

- Staff/admin mới được dùng tool. Mỗi tài khoản tìm tối đa 6 lần/phút.
- URL phải được tool tìm cho đúng tài khoản và sản phẩm trong 15 phút; URL do model tự nghĩ ra bị từ chối. Server chỉ gọi hai endpoint tìm kiếm cố định, không fetch URL tùy ý hoặc đọc nội dung trang nguồn.
- Thẻ ghi dữ liệu đi qua cơ chế xác nhận hiện có; xác nhận lại không thực hiện lần hai. Kiểm tra lại nguồn khi chạy, nên ảnh hết hạn/khởi động lại backend thì cần tìm lại.
- Tối đa 20 ảnh/sản phẩm. Không tự loại ảnh cũ khi thư viện đầy.
- Không cần thay đổi cấu trúc database.

Kiểm tra: `npm test`, riêng chức năng `npm run test:product-image-search`. Kiểm thử dùng response giả cho cả hai nguồn và luồng xác nhận; thử kết nối Commons thật chỉ đọc và không cập nhật sản phẩm. Brave cần key triển khai để kiểm tra live.
