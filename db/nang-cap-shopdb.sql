-- =====================================================================
-- NÂNG CẤP TẠI CHỖ database shopdb (giữ nguyên dữ liệu) — dùng cho DBeaver / Workbench khi không chạy được npm.
-- Đây đúng là 16 bước mà "npm run migrate-db -- --apply" sẽ làm với database ở trạng thái của file dump 2026-10-05.
-- CHỈ CHẠY MỘT LẦN. Chạy lại sẽ báo lỗi "Duplicate key name" ở các lệnh ADD KEY (vô hại, nhưng nên dùng npm run migrate-db nếu không chắc).
-- Sao lưu trước. Cách chạy trong DBeaver: chọn schema shopdb -> mở file này trong SQL Editor -> Execute SQL Script (Alt+X).
-- Không có lệnh nào xóa bảng, cột hay dòng dữ liệu.
-- =====================================================================

SET NAMES utf8mb4;

-- 1. Tạo bảng: support_conversations
CREATE TABLE IF NOT EXISTS `support_conversations` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `visitor_id` varchar(64) NOT NULL,
  `user_id` int DEFAULT NULL,
  `customer_name` varchar(150) DEFAULT NULL,
  `customer_phone` varchar(20) DEFAULT NULL,
  `status` enum('open','closed') NOT NULL DEFAULT 'open',
  `assigned_to` int DEFAULT NULL,
  `ai_enabled` tinyint(1) NOT NULL DEFAULT '1',
  `needs_human` tinyint(1) NOT NULL DEFAULT '0',
  `unread_staff` int NOT NULL DEFAULT '0',
  `unread_customer` int NOT NULL DEFAULT '0',
  `last_message_at` timestamp NULL DEFAULT NULL,
  `last_message_preview` varchar(255) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_support_visitor` (`visitor_id`),
  KEY `idx_support_user` (`user_id`),
  KEY `idx_support_assigned` (`assigned_to`),
  KEY `idx_support_status_last` (`status`,`last_message_at`),
  CONSTRAINT `fk_support_conv_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_support_conv_staff` FOREIGN KEY (`assigned_to`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2. Tạo bảng: support_messages
CREATE TABLE IF NOT EXISTS `support_messages` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `conversation_id` bigint NOT NULL,
  `sender_type` enum('customer','staff','ai','system') NOT NULL,
  `sender_id` int DEFAULT NULL,
  `sender_name` varchar(150) DEFAULT NULL,
  `content` text NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_support_msg_conv` (`conversation_id`,`id`),
  CONSTRAINT `fk_support_msg_conv` FOREIGN KEY (`conversation_id`) REFERENCES `support_conversations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3. Mở rộng enum: orders.status — mở rộng tạm để đổi dữ liệu
ALTER TABLE `orders` MODIFY COLUMN `status` enum('pending','processing','shipped','delivered','completed','cancelled','confirmed','shipping') NOT NULL DEFAULT 'pending';

-- 4. Đổi dữ liệu: orders.status — đổi "confirmed" thành "processing"
UPDATE `orders` SET `status` = 'processing', `updated_at` = `updated_at` WHERE `status` = 'confirmed';

-- 5. Đổi dữ liệu: order_status_history.old_status — đổi "confirmed" thành "processing"
UPDATE `order_status_history` SET `old_status` = 'processing' WHERE `old_status` = 'confirmed';

-- 6. Đổi dữ liệu: order_status_history.new_status — đổi "confirmed" thành "processing"
UPDATE `order_status_history` SET `new_status` = 'processing' WHERE `new_status` = 'confirmed';

-- 7. Đổi dữ liệu: orders.status — đổi "shipping" thành "shipped"
UPDATE `orders` SET `status` = 'shipped', `updated_at` = `updated_at` WHERE `status` = 'shipping';

-- 8. Đổi dữ liệu: order_status_history.old_status — đổi "shipping" thành "shipped"
UPDATE `order_status_history` SET `old_status` = 'shipped' WHERE `old_status` = 'shipping';

-- 9. Đổi dữ liệu: order_status_history.new_status — đổi "shipping" thành "shipped"
UPDATE `order_status_history` SET `new_status` = 'shipped' WHERE `new_status` = 'shipping';

-- 10. Kiểm tra an toàn: không còn dòng nào ở orders.status dùng giá trị confirmed, shipping
-- (Kiểm tra: kết quả n phải bằng 0. Nếu khác 0 thì DỪNG, các bước sau sẽ lỗi "Data truncated" — báo lại để được hướng dẫn.)
SELECT COUNT(*) AS n FROM `orders` WHERE `status` IN ('confirmed', 'shipping');

-- 11. Sửa enum: orders.status — bỏ giá trị cũ: confirmed, shipping
ALTER TABLE `orders` MODIFY COLUMN `status` enum('pending','processing','shipped','delivered','completed','cancelled') NOT NULL DEFAULT 'pending';

-- 12. Thêm chỉ mục: products (idx_products_stock)
ALTER TABLE `products` ADD KEY `idx_products_stock` (`stock`);

-- 13. Thêm chỉ mục: cart_items (idx_cart_session)
ALTER TABLE `cart_items` ADD KEY `idx_cart_session` (`session_id`);

-- 14. Thêm chỉ mục: orders (idx_orders_status_created)
ALTER TABLE `orders` ADD KEY `idx_orders_status_created` (`status`,`created_at`);

-- 15. Thêm chỉ mục: orders (idx_orders_created)
ALTER TABLE `orders` ADD KEY `idx_orders_created` (`created_at`);

-- 16. Thêm chỉ mục: orders (idx_orders_phone)
ALTER TABLE `orders` ADD KEY `idx_orders_phone` (`customer_phone`);

-- 17. Tạo bảng: email_otps (mã OTP xác nhận email khi đăng ký)
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

-- 18. Thêm cột: products.part_type, products.build_specs (trang Build PC)
ALTER TABLE `products` ADD COLUMN `part_type` enum('cpu','mainboard','ram','vga','storage','psu','case','cooler') DEFAULT NULL;
ALTER TABLE `products` ADD COLUMN `build_specs` json DEFAULT NULL;
ALTER TABLE `products` ADD KEY `idx_products_part_type` (`part_type`);

-- Kiểm tra sau khi chạy (kết quả cột Type phải là enum('pending','processing','shipped','delivered','completed','cancelled')):
SHOW COLUMNS FROM orders LIKE 'status';
SHOW TABLES LIKE 'support_%';
SHOW TABLES LIKE 'email_otps';
