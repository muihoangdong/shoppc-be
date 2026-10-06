-- Thêm bảng lưu mã OTP xác nhận email khi đăng ký (chạy MỘT lần trên database đang dùng, ví dụ shopdb).
-- Cách khác cho cùng kết quả: cd shoppc-be && npm run migrate-db -- --apply
-- Chạy lại nhiều lần không sao (IF NOT EXISTS). Không đụng tới dữ liệu cũ.

CREATE TABLE IF NOT EXISTS `email_otps` (
  `id` int NOT NULL AUTO_INCREMENT,
  `email` varchar(150) NOT NULL,
  `purpose` enum('register') NOT NULL DEFAULT 'register',
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

-- Kiểm tra: phải thấy 1 dòng email_otps
SHOW TABLES LIKE 'email_otps';
