-- =====================================================================
-- NÂNG CẤP DATABASE — CHẠY TỪNG LỆNH (DBeaver: đặt con trỏ vào lệnh rồi bấm Ctrl+Enter)
--
-- Chọn đúng database (VD shopdb) trước. Chạy lần lượt BƯỚC 0 → BƯỚC 10, mỗi lần một lệnh.
-- Mỗi lệnh đứng riêng, không phụ thuộc lệnh khác.
--
-- Nếu một lệnh "ADD COLUMN" / "ADD KEY" báo:
--     1060 Duplicate column name ...   hoặc   1061 Duplicate key name ...
-- nghĩa là phần đó ĐÃ CÓ RỒI -> bỏ qua, chạy tiếp bước sau.
-- Các lệnh CREATE TABLE IF NOT EXISTS không bao giờ báo lỗi khi bảng đã có.
--
-- An toàn: chỉ thêm bảng / cột / chỉ mục, không xóa hay sửa dữ liệu nào.
-- (Muốn chạy một lần cho cả file thì dùng nang-cap-moi.sql với Alt+X.)
-- =====================================================================


-- BƯỚC 0. Xem database đang thiếu gì (cột trang_thai = "THIẾU" là cần chạy bước tương ứng)
SELECT 'B1 bảng email_otps' AS buoc, IF(COUNT(*) > 0, 'có', 'THIẾU') AS trang_thai FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'email_otps'
UNION ALL SELECT 'B3 cột products.part_type', IF(COUNT(*) > 0, 'có', 'THIẾU') FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'products' AND column_name = 'part_type'
UNION ALL SELECT 'B4 cột products.build_specs', IF(COUNT(*) > 0, 'có', 'THIẾU') FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'products' AND column_name = 'build_specs'
UNION ALL SELECT 'B5 chỉ mục idx_products_part_type', IF(COUNT(*) > 0, 'có', 'THIẾU') FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'products' AND index_name = 'idx_products_part_type'
UNION ALL SELECT 'B6 bảng coupons', IF(COUNT(*) > 0, 'có', 'THIẾU') FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'coupons'
UNION ALL SELECT 'B7 cột orders.coupon_code', IF(COUNT(*) > 0, 'có', 'THIẾU') FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'orders' AND column_name = 'coupon_code'
UNION ALL SELECT 'B8 chỉ mục idx_orders_coupon', IF(COUNT(*) > 0, 'có', 'THIẾU') FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'orders' AND index_name = 'idx_orders_coupon'
UNION ALL SELECT 'B9 bảng product_reviews', IF(COUNT(*) > 0, 'có', 'THIẾU') FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'product_reviews';


-- BƯỚC 1. Bảng mã OTP xác nhận email (đăng ký, đổi email)
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


-- BƯỚC 2. Cho phép mã OTP "đổi email" (chạy lại không sao)
ALTER TABLE `email_otps` MODIFY COLUMN `purpose` enum('register','change_email') NOT NULL DEFAULT 'register';


-- BƯỚC 3. Build PC: loại linh kiện   (lỗi 1060 = đã có, bỏ qua)
ALTER TABLE `products` ADD COLUMN `part_type` enum('cpu','mainboard','ram','vga','storage','psu','case','cooler') DEFAULT NULL;


-- BƯỚC 4. Build PC: thông số linh kiện   (lỗi 1060 = đã có, bỏ qua)
ALTER TABLE `products` ADD COLUMN `build_specs` json DEFAULT NULL;


-- BƯỚC 5. Build PC: chỉ mục   (lỗi 1061 = đã có, bỏ qua)
ALTER TABLE `products` ADD KEY `idx_products_part_type` (`part_type`);


-- BƯỚC 6. Bảng mã giảm giá
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


-- BƯỚC 7. Đơn hàng ghi mã giảm giá đã dùng   (lỗi 1060 = đã có, bỏ qua)
ALTER TABLE `orders` ADD COLUMN `coupon_code` varchar(50) DEFAULT NULL AFTER `discount`;


-- BƯỚC 8. Chỉ mục cho mã giảm giá   (lỗi 1061 = đã có, bỏ qua)
ALTER TABLE `orders` ADD KEY `idx_orders_coupon` (`coupon_code`);


-- BƯỚC 9. Bảng đánh giá sản phẩm
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


-- BƯỚC 10. Kiểm tra lại: chạy lại lệnh ở BƯỚC 0 — mọi dòng phải là "có". Xong thì khởi động lại backend.
