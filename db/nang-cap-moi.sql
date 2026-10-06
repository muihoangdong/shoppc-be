-- Nâng cấp database đang dùng (ví dụ shopdb) cho các tính năng mới:
--   1) Xác nhận email bằng mã OTP khi đăng ký và khi đổi email  -> bảng email_otps
--   2) Trang Build PC (tự chọn cấu hình, kiểm tra tương thích)   -> cột products.part_type, products.build_specs
--   3) Mã giảm giá                                                -> bảng coupons, cột orders.coupon_code
-- Cách dễ nhất (tự phát hiện bước nào còn thiếu, chạy lại không sao):  cd shoppc-be && npm run migrate-db -- --apply
-- Hoặc chạy file này trong DBeaver / MySQL Workbench. Nên sao lưu trước: mysqldump -u root -p shopdb > backup.sql
-- Không xóa dữ liệu nào.

-- 1. Bảng mã OTP (bỏ qua nếu đã có)
CREATE TABLE IF NOT EXISTS `email_otps` (
  `id` int NOT NULL AUTO_INCREMENT,
  `email` varchar(150) NOT NULL,
  `purpose` enum('register','change_email') NOT NULL DEFAULT 'register',
  `code_hash` char(64) NOT NULL,
  `payload` json DEFAULT NULL,
  `attempts` int NOT NULL DEFAULT '0',
  `send_count` int NOT NULL DEFAULT '1',
  `send_window_start` datetime NOT NULL,
  `last_sent_at` datetime NOT NULL,
  `expires_at` datetime NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_email_otps_email_purpose` (`email`,`purpose`),
  KEY `idx_email_otps_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Bảng đã tạo từ bản trước (chỉ có 'register'): thêm 'change_email'. Chạy lại không sao.
ALTER TABLE `email_otps` MODIFY COLUMN `purpose` enum('register','change_email') NOT NULL DEFAULT 'register';

-- 2. Cột cho Build PC. CHỈ CHẠY MỘT LẦN: nếu báo "Duplicate column name" nghĩa là đã có rồi, bỏ qua 3 lệnh này.
ALTER TABLE `products` ADD COLUMN `part_type` enum('cpu','mainboard','ram','vga','storage','psu','case','cooler') DEFAULT NULL;
ALTER TABLE `products` ADD COLUMN `build_specs` json DEFAULT NULL;
ALTER TABLE `products` ADD KEY `idx_products_part_type` (`part_type`);

-- 3. Mã giảm giá. Bảng: bỏ qua nếu đã có. Cột + chỉ mục: CHỈ CHẠY MỘT LẦN ("Duplicate column name" = đã có, bỏ qua).
CREATE TABLE IF NOT EXISTS `coupons` (
  `id` int NOT NULL AUTO_INCREMENT,
  `code` varchar(50) NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  `type` enum('percentage','fixed') NOT NULL DEFAULT 'percentage',
  `value` decimal(15,2) NOT NULL,
  `min_order_value` decimal(15,2) NOT NULL DEFAULT '0.00',
  `max_discount` decimal(15,2) DEFAULT NULL,
  `usage_limit` int DEFAULT NULL,
  `used_count` int NOT NULL DEFAULT '0',
  `once_per_customer` tinyint(1) NOT NULL DEFAULT '0',
  `starts_on` date DEFAULT NULL,
  `expires_on` date DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_coupons_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
ALTER TABLE `orders` ADD COLUMN `coupon_code` varchar(50) DEFAULT NULL AFTER `discount`;
ALTER TABLE `orders` ADD KEY `idx_orders_coupon` (`coupon_code`);

-- Kiểm tra
SHOW TABLES LIKE 'email_otps';
SHOW TABLES LIKE 'coupons';
SHOW COLUMNS FROM products LIKE 'part_type';
