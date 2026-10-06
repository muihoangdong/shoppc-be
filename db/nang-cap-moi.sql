-- =====================================================================
-- Nâng cấp database đang dùng (ví dụ shopdb) cho TẤT CẢ tính năng mới:
--   1) Xác nhận email bằng mã OTP (đăng ký, đổi email)        -> bảng email_otps
--   2) Trang Build PC (tự chọn cấu hình, kiểm tra tương thích) -> cột products.part_type, products.build_specs
--   3) Mã giảm giá                                             -> bảng coupons, cột orders.coupon_code
--   4) Đánh giá sản phẩm (chỉ khách đã nhận hàng)              -> bảng product_reviews
--
-- Cách dùng: mở file này trong MySQL Workbench / DBeaver / HeidiSQL, chọn database (VD shopdb) rồi chạy CẢ FILE.
--   Dòng lệnh:  mysql -u root -p shopdb < nang-cap-moi.sql
-- Hoặc dùng lệnh tự động (cùng kết quả):  cd shoppc-be && npm run migrate-db -- --apply
--
-- AN TOÀN: chỉ THÊM bảng / cột / chỉ mục, không xóa hay sửa dữ liệu nào. Phần nào đã có thì tự bỏ qua,
-- nên chạy lại bao nhiêu lần cũng được. Nên sao lưu trước: mysqldump -u root -p shopdb > backup.sql
-- =====================================================================

SET NAMES utf8mb4;

-- ───────────── 1. Bảng mã OTP xác nhận email ─────────────
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

-- Bảng tạo từ bản cũ (chỉ có 'register'): thêm 'change_email'. Chạy lại không sao.
ALTER TABLE `email_otps` MODIFY COLUMN `purpose` enum('register','change_email') NOT NULL DEFAULT 'register';

-- ───────────── 2. Build PC: cột loại linh kiện + thông số ─────────────
SET @has := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'products' AND column_name = 'part_type');
SET @sql := IF(@has = 0,
  "ALTER TABLE `products` ADD COLUMN `part_type` enum('cpu','mainboard','ram','vga','storage','psu','case','cooler') DEFAULT NULL",
  'SELECT ''products.part_type: đã có, bỏ qua'' AS ket_qua');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

SET @has := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'products' AND column_name = 'build_specs');
SET @sql := IF(@has = 0,
  'ALTER TABLE `products` ADD COLUMN `build_specs` json DEFAULT NULL',
  'SELECT ''products.build_specs: đã có, bỏ qua'' AS ket_qua');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

SET @has := (SELECT COUNT(*) FROM information_schema.statistics
             WHERE table_schema = DATABASE() AND table_name = 'products' AND index_name = 'idx_products_part_type');
SET @sql := IF(@has = 0,
  'ALTER TABLE `products` ADD KEY `idx_products_part_type` (`part_type`)',
  'SELECT ''idx_products_part_type: đã có, bỏ qua'' AS ket_qua');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- ───────────── 3. Mã giảm giá ─────────────
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

SET @has := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'orders' AND column_name = 'coupon_code');
SET @sql := IF(@has = 0,
  'ALTER TABLE `orders` ADD COLUMN `coupon_code` varchar(50) DEFAULT NULL AFTER `discount`',
  'SELECT ''orders.coupon_code: đã có, bỏ qua'' AS ket_qua');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

SET @has := (SELECT COUNT(*) FROM information_schema.statistics
             WHERE table_schema = DATABASE() AND table_name = 'orders' AND index_name = 'idx_orders_coupon');
SET @sql := IF(@has = 0,
  'ALTER TABLE `orders` ADD KEY `idx_orders_coupon` (`coupon_code`)',
  'SELECT ''idx_orders_coupon: đã có, bỏ qua'' AS ket_qua');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- ───────────── 4. Đánh giá sản phẩm ─────────────
CREATE TABLE IF NOT EXISTS `product_reviews` (
  `id` int NOT NULL AUTO_INCREMENT,
  `product_id` int NOT NULL,
  `user_id` int NOT NULL,
  `order_id` int DEFAULT NULL,
  `rating` tinyint NOT NULL,
  `comment` text,
  `status` enum('visible','hidden') NOT NULL DEFAULT 'visible',
  `admin_reply` text,
  `replied_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_reviews_product_user` (`product_id`,`user_id`),
  KEY `idx_reviews_product_status` (`product_id`,`status`,`created_at`),
  KEY `fk_reviews_user` (`user_id`),
  KEY `fk_reviews_order` (`order_id`),
  CONSTRAINT `fk_reviews_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_reviews_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_reviews_order` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ───────────── Kiểm tra: mọi dòng phải là "có" ─────────────
SELECT 'bảng email_otps' AS hang_muc, IF(COUNT(*) > 0, 'có', 'THIẾU') AS trang_thai FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'email_otps'
UNION ALL SELECT 'bảng coupons', IF(COUNT(*) > 0, 'có', 'THIẾU') FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'coupons'
UNION ALL SELECT 'bảng product_reviews', IF(COUNT(*) > 0, 'có', 'THIẾU') FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'product_reviews'
UNION ALL SELECT 'cột products.part_type', IF(COUNT(*) > 0, 'có', 'THIẾU') FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'products' AND column_name = 'part_type'
UNION ALL SELECT 'cột products.build_specs', IF(COUNT(*) > 0, 'có', 'THIẾU') FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'products' AND column_name = 'build_specs'
UNION ALL SELECT 'cột orders.coupon_code', IF(COUNT(*) > 0, 'có', 'THIẾU') FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'orders' AND column_name = 'coupon_code';
