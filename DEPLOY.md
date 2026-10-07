# Triển khai Shoppc

Dự án gồm 3 phần: `shoppc-be` (API Node/Express + MySQL), `shoppc-fe` (cửa hàng), `shoppc-admin` (trang quản trị).

## Cài mới từ đầu (máy local)
1. `docker compose up -d` ở thư mục gốc — MySQL tạo database `shopdb` và tự chạy `db/init/01_schema.sql` (bản sao của `shoppc-be/db/schema.sql`) khi tạo lần đầu.
2. `cd shoppc-be && cp .env.example .env`, điền thông tin DB, `JWT_SECRET` (chuỗi ngẫu nhiên ≥ 32 ký tự), `GEMINI_API_KEY` nếu dùng chatbot AI (lấy tại aistudio.google.com; trên Render nhập ở mục Environment, không commit).
3. `npm install && npm run dev`.
4. Tạo admin đầu tiên: `ADMIN_PASSWORD='mat-khau-manh' npm run create-admin -- --username admin --email admin@shop.vn`.
5. `shoppc-fe` và `shoppc-admin`: `npm install && npm run dev` (mặc định cổng 3001 và 3002, `VITE_API_URL=http://localhost:3000/api`).

## Nâng cấp database đang chạy
Xem **`DATABASE.md`**. Tóm tắt: sao lưu, rồi `npm run migrate-db` (xem trước) và `npm run migrate-db -- --apply`. Lệnh này so database với `db/schema.sql` và chỉ thêm/sửa, không xóa dữ liệu. `npm run fix-roles` vẫn dùng riêng để hạ quyền tài khoản (xem `ROLES.md`).

## Lên production (ví dụ Render)
- File `render.yaml` ở thư mục gốc là mẫu Blueprint cho 1 backend + 2 trang tĩnh (có sẵn rewrite SPA).
- Bắt buộc ở backend: `NODE_ENV=production`, `JWT_SECRET`, thông tin DB, `CORS_ORIGINS` = domain của cửa hàng và trang admin, `TRUST_PROXY=1`.
- Backend có `Dockerfile` nếu muốn chạy bằng Docker; health check: `/health` (sống) và `/health/ready` (kết nối được DB).
- Frontend: đặt `VITE_API_URL` trỏ về backend. File `public/_redirects` (Netlify) và `vercel.json` (Vercel) đã có rewrite để F5 ở đường dẫn sâu không bị 404.
- **Realtime chạy trong bộ nhớ một tiến trình: chỉ chạy 1 instance backend.** Muốn chạy nhiều instance cần chuyển `src/realtime/hub.js` sang Redis Pub/Sub.
- Proxy phía trước phải cho phép kết nối SSE mở lâu (Render/Nginx mặc định ổn; server tự gửi heartbeat 25 giây/lần). Nếu tự dựng Nginx: `proxy_buffering off;` cho `/api/realtime/stream`.

## Kiểm thử
`npm test` trong `shoppc-be` — chạy toàn bộ test không cần MySQL, mạng hay API key (dùng database và AI giả). CI mẫu: `.github/workflows/ci.yml`.

## Giới hạn đã biết
- Việc nâng cấp database được kiểm thử bằng bộ mô phỏng MySQL và bằng cách đối chiếu mọi câu SQL trong code với schema; **chưa được chạy thử trên MySQL thật** trong quá trình phát triển — hãy sao lưu trước khi chạy `migrate-db --apply`.
- Giới hạn tần suất (đăng nhập, đặt hàng, chat…) cũng lưu trong bộ nhớ: khởi động lại server là reset.
- Gửi email (quên mật khẩu) cần `npm install nodemailer` + cấu hình `SMTP_*`.
