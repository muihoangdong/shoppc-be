-- =====================================================================
-- Migration 001: thêm vai trò 'customer' và hạ quyền khách hàng
--
-- BỐI CẢNH: trước đây mọi tài khoản đăng ký từ storefront đều nhận vai trò 'staff'
-- (và client còn tự gửi được role=admin), nên khách hàng có quyền truy cập API quản trị.
-- Từ nay đăng ký công khai chỉ tạo 'customer'.
--
-- CÁCH DỄ HƠN: dùng script tự động  `npm run fix-roles -- --keep nv1,nv2 --apply`  (xem ROLES.md);
-- nó làm đúng các bước dưới đây, có chế độ xem trước và các chốt an toàn.
--
-- Hoặc chạy file này MỘT LẦN trên database (ví dụ: mysql -u root -p shoppc < migrations/001_customer_role.sql).
-- Nên sao lưu database trước khi chạy.
-- =====================================================================

-- Bước 1: cho phép giá trị 'customer' trong cột role.
-- (Nếu cột `role` của bạn đã là VARCHAR thì có thể bỏ qua bước này.)
ALTER TABLE users
    MODIFY COLUMN role ENUM('admin', 'staff', 'customer') NOT NULL DEFAULT 'customer';

-- Bước 2: XEM các tài khoản đang là 'staff' để xác định ai là khách hàng thật sự.
-- Nhân viên thật thường chỉ có vài người; khách đăng ký từ storefront sẽ có created_at rải rác theo thời gian.
SELECT id, username, email, full_name, role, status, last_login, created_at
FROM users
WHERE role = 'staff'
ORDER BY created_at;

-- Bước 3: HẠ QUYỀN các tài khoản là khách hàng. Thay danh sách id bằng kết quả bạn đã rà soát ở bước 2,
-- rồi bỏ dấu "--" ở đầu dòng để chạy.
-- UPDATE users SET role = 'customer' WHERE id IN (3, 4, 5);

-- Bước 4 (khuyến nghị): nếu từng có người lạ biết/đoán được tài khoản, hãy đổi JWT_SECRET trong .env
-- để toàn bộ token cũ mất hiệu lực, và đổi mật khẩu các tài khoản admin/staff.
