-- =====================================================================
-- NÂNG CẤP CHO TÍNH NĂNG THANH TOÁN CHUYỂN KHOẢN (mã QR + "Tôi đã chuyển khoản")
-- Dán vào DBeaver / Workbench, chọn database shopdb, rồi chạy CẢ FILE:
--   DBeaver: Alt+X        Workbench: Ctrl+Shift+Enter
-- An toàn: chỉ thêm 1 bảng + 1 cột, không xóa / sửa dữ liệu. Chạy lại nhiều lần cũng không sao.
-- (Database cũ thiếu cả các tính năng trước đó thì dùng nang-cap-moi.sql thay cho file này.)
-- =====================================================================
SET NAMES utf8mb4;

-- 1. Bảng lưu tài khoản ngân hàng nhận tiền (nhập trong admin → Cài đặt)
CREATE TABLE IF NOT EXISTS `shop_settings` (
  `setting_key` varchar(64) NOT NULL,
  `setting_value` text,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`setting_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2. Cột ghi lúc khách bấm "Tôi đã chuyển khoản" (đã có thì bỏ qua)
SET @has = (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'orders' AND column_name = 'payment_claimed_at');
SET @sql = IF(@has = 0,
  'ALTER TABLE `orders` ADD COLUMN `payment_claimed_at` timestamp NULL DEFAULT NULL AFTER `payment_id`',
  'SELECT ''orders.payment_claimed_at: đã có, bỏ qua'' AS ket_qua');
PREPARE st FROM @sql;
EXECUTE st;
DEALLOCATE PREPARE st;

-- 3. Kiểm tra: cả 2 dòng phải là "có". Xong thì khởi động lại backend.
SELECT 'bảng shop_settings' AS hang_muc, IF(COUNT(*) > 0, 'có', 'THIẾU') AS trang_thai FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'shop_settings'
UNION ALL SELECT 'cột orders.payment_claimed_at', IF(COUNT(*) > 0, 'có', 'THIẾU') FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'orders' AND column_name = 'payment_claimed_at';
