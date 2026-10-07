-- =====================================================================
-- NÂNG CẤP CHO TÍNH NĂNG THANH TOÁN CHUYỂN KHOẢN (mã QR + "Tôi đã chuyển khoản")
-- Chọn database shopdb, rồi chạy TỪNG LỆNH: đặt con trỏ vào lệnh → Ctrl+Enter (DBeaver).
-- An toàn: chỉ thêm 1 bảng + 1 cột, không xóa / sửa dữ liệu.
-- Không chạy file này cũng được: backend có AUTO_MIGRATE=true sẽ tự thêm khi khởi động.
-- =====================================================================


-- LỆNH 1. Bảng lưu tài khoản ngân hàng nhận tiền (đã có thì tự bỏ qua, không báo lỗi)
CREATE TABLE IF NOT EXISTS `shop_settings` (
  `setting_key` varchar(64) NOT NULL,
  `setting_value` text,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`setting_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- LỆNH 2. Cột ghi lúc khách bấm "Tôi đã chuyển khoản"
-- Báo lỗi "1060 Duplicate column name" nghĩa là cột ĐÃ CÓ → bỏ qua, chạy lệnh 3.
ALTER TABLE `orders` ADD COLUMN `payment_claimed_at` timestamp NULL DEFAULT NULL;


-- LỆNH 3. Kiểm tra: cả 2 dòng phải là "có". Xong thì tắt và bật lại backend.
SELECT 'bảng shop_settings' AS hang_muc, IF(COUNT(*) > 0, 'có', 'THIẾU') AS trang_thai FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'shop_settings'
UNION ALL SELECT 'cột orders.payment_claimed_at', IF(COUNT(*) > 0, 'có', 'THIẾU') FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'orders' AND column_name = 'payment_claimed_at';
