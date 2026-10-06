-- =====================================================================
-- SCHEMA CHUẨN của Shoppc (nguồn duy nhất): dùng cho
--   * lần cài mới (docker-compose chạy file này khi tạo database lần đầu; hoặc chạy tay: mysql -u root -p <tên_db> < db/schema.sql)
--   * nâng cấp database đang có:  npm run migrate-db   (so sánh database với file này, chỉ THÊM/SỬA, không xóa dữ liệu)
--
-- Được dựng từ cấu trúc database thật của dự án, thay đổi tối thiểu để khớp code:
--   - orders.status:  pending | processing | shipped | delivered | completed | cancelled
--       (bản cũ là pending | confirmed | processing | shipping | delivered | cancelled nên không lưu được "Đang giao"/"Hoàn tất")
--   - thêm chỉ mục cho các truy vấn thống kê/tìm kiếm đơn hàng, tồn kho thấp, giỏ hàng
--   - thêm bảng chat hỗ trợ khách hàng: support_conversations, support_messages
--   - products.part_type + products.build_specs: loại linh kiện và thông số để kiểm tra tương thích (trang Build PC)
--   - thêm bảng email_otps: mã OTP xác nhận email khi đăng ký (tài khoản chỉ được tạo sau khi nhập đúng mã)
--   - thêm bảng coupons + cột orders.coupon_code: mã giảm giá (theo % hoặc số tiền, đơn tối thiểu, hạn dùng, số lượt)
--   - thêm bảng product_reviews: đánh giá sản phẩm (chỉ khách đã nhận hàng), mỗi khách 1 đánh giá / sản phẩm
--   - GIỮ NGUYÊN các cột/bảng cũ code hiện chưa dùng (tracking_number, admin_note, product_sku, shipping_tracking) để không mất dữ liệu
-- Lưu ý: mỗi bảng KHÔNG có comment bên trong ngoặc CREATE TABLE (bộ phân tích của npm run migrate-db đọc file này).
-- =====================================================================

SET NAMES utf8mb4;


CREATE TABLE IF NOT EXISTS `users` (
  `id` int NOT NULL AUTO_INCREMENT,
  `username` varchar(100) NOT NULL,
  `password` varchar(255) NOT NULL,
  `email` varchar(150) NOT NULL,
  `full_name` varchar(150) NOT NULL,
  `avatar` varchar(255) DEFAULT NULL,
  `role` enum('admin','staff','customer') NOT NULL DEFAULT 'customer',
  `status` enum('active','inactive') NOT NULL DEFAULT 'active',
  `last_login` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_users_username` (`username`),
  UNIQUE KEY `uk_users_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `categories` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(150) NOT NULL,
  `type` enum('pc','component','peripheral') NOT NULL,
  `parent_id` int DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `parent_id` (`parent_id`),
  CONSTRAINT `categories_ibfk_1` FOREIGN KEY (`parent_id`) REFERENCES `categories` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `products` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `description` text,
  `price` decimal(15,2) NOT NULL DEFAULT '0.00',
  `stock` int NOT NULL DEFAULT '0',
  `category_id` int NOT NULL,
  `image_url` text,
  `specs` json DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `part_type` enum('cpu','mainboard','ram','vga','storage','psu','case','cooler') DEFAULT NULL,
  `build_specs` json DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `category_id` (`category_id`),
  CONSTRAINT `products_ibfk_1` FOREIGN KEY (`category_id`) REFERENCES `categories` (`id`),
  KEY `idx_products_stock` (`stock`),
  KEY `idx_products_part_type` (`part_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `cart_items` (
  `id` int NOT NULL AUTO_INCREMENT,
  `session_id` varchar(255) NOT NULL,
  `product_id` int NOT NULL,
  `quantity` int NOT NULL DEFAULT '1',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `product_id` (`product_id`),
  CONSTRAINT `cart_items_ibfk_1` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`),
  KEY `idx_cart_session` (`session_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `orders` (
  `id` int NOT NULL AUTO_INCREMENT,
  `order_code` varchar(50) NOT NULL,
  `user_id` int DEFAULT NULL,
  `customer_name` varchar(150) NOT NULL,
  `customer_email` varchar(150) NOT NULL,
  `customer_phone` varchar(30) NOT NULL,
  `customer_address` varchar(255) NOT NULL,
  `customer_ward` varchar(150) DEFAULT NULL,
  `customer_district` varchar(150) DEFAULT NULL,
  `customer_city` varchar(150) DEFAULT NULL,
  `note` text,
  `subtotal` decimal(15,2) NOT NULL DEFAULT '0.00',
  `discount` decimal(15,2) NOT NULL DEFAULT '0.00',
  `coupon_code` varchar(50) DEFAULT NULL,
  `shipping_fee` decimal(15,2) NOT NULL DEFAULT '0.00',
  `total_amount` decimal(15,2) NOT NULL DEFAULT '0.00',
  `payment_method` enum('cod','banking','momo','zalopay','vnpay') NOT NULL DEFAULT 'cod',
  `payment_status` enum('pending','paid','failed','refunded') NOT NULL DEFAULT 'pending',
  `payment_id` varchar(100) DEFAULT NULL,
  `status` enum('pending','processing','shipped','delivered','completed','cancelled') NOT NULL DEFAULT 'pending',
  `tracking_number` varchar(100) DEFAULT NULL,
  `admin_note` text,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_order_code` (`order_code`),
  KEY `fk_orders_user` (`user_id`),
  CONSTRAINT `fk_orders_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  KEY `idx_orders_status_created` (`status`,`created_at`),
  KEY `idx_orders_created` (`created_at`),
  KEY `idx_orders_phone` (`customer_phone`),
  KEY `idx_orders_coupon` (`coupon_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `order_items` (
  `id` int NOT NULL AUTO_INCREMENT,
  `order_id` int NOT NULL,
  `product_id` int NOT NULL,
  `product_name` varchar(255) NOT NULL,
  `product_image` text,
  `product_sku` varchar(100) DEFAULT NULL,
  `quantity` int NOT NULL,
  `price` decimal(15,2) NOT NULL,
  `total` decimal(15,2) NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `order_id` (`order_id`),
  KEY `product_id` (`product_id`),
  CONSTRAINT `order_items_ibfk_1` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE CASCADE,
  CONSTRAINT `order_items_ibfk_2` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `order_status_history` (
  `id` int NOT NULL AUTO_INCREMENT,
  `order_id` int NOT NULL,
  `old_status` varchar(50) DEFAULT NULL,
  `new_status` varchar(50) NOT NULL,
  `changed_by` int DEFAULT NULL,
  `note` text,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `order_id` (`order_id`),
  KEY `changed_by` (`changed_by`),
  CONSTRAINT `order_status_history_ibfk_1` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE CASCADE,
  CONSTRAINT `order_status_history_ibfk_2` FOREIGN KEY (`changed_by`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `shipping_tracking` (
  `id` int NOT NULL AUTO_INCREMENT,
  `order_id` int NOT NULL,
  `carrier` varchar(100) DEFAULT NULL,
  `tracking_number` varchar(100) DEFAULT NULL,
  `status` varchar(100) DEFAULT NULL,
  `location` varchar(255) DEFAULT NULL,
  `estimated_delivery` timestamp NULL DEFAULT NULL,
  `actual_delivery` timestamp NULL DEFAULT NULL,
  `tracking_data` json DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `order_id` (`order_id`),
  CONSTRAINT `shipping_tracking_ibfk_1` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
