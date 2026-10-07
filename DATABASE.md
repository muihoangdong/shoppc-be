# Database

Nguồn duy nhất về cấu trúc: **`db/schema.sql`**. Code, kiểm thử và lệnh nâng cấp đều dựa vào file này.

## Vì sao phải làm lại database
Database thật của dự án (`shopdb`) khác với những gì code cần:

| Vấn đề | Hậu quả |
|---|---|
| `orders.status` chỉ cho phép `pending, confirmed, processing, shipping, delivered, cancelled`, còn code và giao diện dùng `shipped` (Đang giao) và `completed` (Hoàn tất) | Bấm "Giao hàng" hoặc "Hoàn tất" báo lỗi hệ thống vì MySQL từ chối giá trị |
| Chưa có bảng `support_conversations`, `support_messages` | Trang Hỗ trợ và khung chat của khách báo lỗi |
| Thiếu chỉ mục cho tìm đơn theo trạng thái/ngày/số điện thoại, tồn kho thấp, giỏ hàng | Chạy chậm khi dữ liệu lớn |

Các cột/bảng cũ mà code hiện không dùng (`orders.tracking_number`, `orders.admin_note`, `order_items.product_sku`, bảng `shipping_tracking`) được **giữ nguyên** để không mất dữ liệu.

## Cách 1 — Giữ database hiện tại, nâng cấp tại chỗ (khuyên dùng)
```bash
mysqldump -u root -p shopdb > backup.sql      # 1. sao lưu (bắt buộc nên làm)
cd shoppc-be
npm run migrate-db                            # 2. xem trước: liệt kê các bước, KHÔNG thay đổi gì
npm run migrate-db -- --apply                 # 3. thực hiện
```
- Chỉ **thêm** bảng/cột/chỉ mục hoặc **sửa enum kèm đổi dữ liệu** (`confirmed` → `processing`, `shipping` → `shipped`, cả bảng lịch sử). Không xóa bảng, cột hay dòng nào.
- Trước khi bỏ giá trị enum cũ, lệnh kiểm tra không còn dòng nào dùng nó; nếu còn dòng dùng giá trị lạ mà không có quy tắc đổi, lệnh **dừng** và nói rõ dòng nào cần tự xử lý.
- Chạy lại nhiều lần không sao. Bị dừng giữa chừng thì sửa nguyên nhân rồi chạy lại, nó tiếp tục từ chỗ dở (DDL của MySQL tự commit nên không rollback được — vì vậy cần sao lưu).
- `.env` có `AUTO_MIGRATE=true` thì server tự làm việc này mỗi lần khởi động.

## Cách 2 — Làm lại database từ file đã dựng sẵn (dữ liệu hiện có được giữ)
`db/shopdb-aligned.sql` là dump của bạn đã chuyển sang cấu trúc mới (đã bỏ các dòng GTID/`SQL_LOG_BIN` làm import báo lỗi 3546).
- **MySQL Workbench**: tạo schema trống → *Server > Data Import* → *Import from Self-Contained File* → chọn file → *Default Target Schema* = schema vừa tạo → *Start Import*.
- **Dòng lệnh**: `mysql -u root -p shopdb < db/shopdb-aligned.sql`
- File có `DROP TABLE IF EXISTS` cho từng bảng: nó **xóa các bảng cùng tên** trong schema được chọn, nên hãy chọn đúng schema và sao lưu trước. File chứa email và mật khẩu băm của người dùng nên đã được `.gitignore`; đừng chia sẻ công khai.

## Dùng DBeaver
- Kết nối: *Database > New Database Connection > MySQL*, host `localhost`, port `3306`, user/mật khẩu như `.env`. Tab *Driver properties*: đặt `allowPublicKeyRetrieval=true`, `useSSL=false` (tránh lỗi "Public Key Retrieval is not allowed" với MySQL 8).
- Nâng cấp tại chỗ (cách 1 không cần npm): chọn schema `shopdb` → mở `db/nang-cap-shopdb.sql` trong SQL Editor → *Execute SQL Script* (Alt+X). Chỉ chạy một lần; không chắc thì dùng `npm run migrate-db`.
- Làm lại từ file (cách 2): tạo schema mới (ví dụ `shopdb_new`, charset `utf8mb4`) → mở `db/shopdb-aligned.sql` với schema đó đang được chọn → Alt+X → đổi `DB_NAME=shopdb_new` trong `.env`. Dùng schema mới thì không đụng tới bảng cũ.

## Cài mới (database trống)
`mysql -u root -p <tên_db> < db/schema.sql`, hoặc `docker compose up -d` (tạo database `shopdb` và tự chạy `db/init/01_schema.sql`). Sau đó tạo admin: `ADMIN_PASSWORD='...' npm run create-admin -- --username admin --email admin@shop.vn`.

## Kiểm tra
- Khi khởi động, server so database với `db/schema.sql` và in kết quả (`✅ Cấu trúc database khớp với code.` hoặc danh sách điểm lệch kèm cách sửa). Ở `NODE_ENV=production` mà thiếu thứ quan trọng thì server **không khởi động**.
- `npm test` có bộ kiểm tra: mọi câu SQL trong code chỉ dùng bảng/cột/giá trị enum có trong schema, `INSERT` điền đủ cột bắt buộc, giới hạn độ dài nhập ≤ độ rộng cột, và việc nâng cấp từ cấu trúc cũ (lấy từ dump thật) cho ra đúng schema chuẩn.

## Thay đổi cấu trúc về sau
Sửa `db/schema.sql` (giữ kiểu viết như các bảng hiện có, không để comment bên trong ngoặc `CREATE TABLE`), chép sang `../db/init/01_schema.sql`, rồi `npm test`. Người dùng cũ chạy `npm run migrate-db -- --apply` để lên bản mới. Lệnh tự phát hiện cột/chỉ mục/bảng thiếu; đổi tên giá trị enum cần thêm quy tắc vào `VALUE_MAPS` trong `src/config/schema.js`.
