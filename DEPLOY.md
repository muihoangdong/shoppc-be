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
- File `render.yaml` là Blueprint cho backend trên Render (vùng Singapore). Dùng TiDB Cloud Starter tương thích MySQL cho database `shopdb`. Với database mới, tạo schema `shopdb` trên TiDB Cloud rồi chạy `npm run migrate-db -- --apply` từ máy local với `.env` trỏ tới TiDB Cloud. Với database đang chạy trên Aiven, làm theo các bước bên dưới trước khi đổi biến môi trường trên Render.
- `shoppc-fe` và `shoppc-admin` deploy riêng lên Vercel (Framework: Vite, output `dist`).
- Bắt buộc ở backend: `NODE_ENV=production`, `JWT_SECRET`, thông tin DB, `CORS_ORIGINS` = domain của cửa hàng và trang admin, `TRUST_PROXY=1`.
- Backend có `Dockerfile` nếu muốn chạy bằng Docker; health check: `/health` (sống) và `/health/ready` (kết nối được DB).
- Frontend: đặt `VITE_API_URL` trỏ về backend. File `public/_redirects` (Netlify) và `vercel.json` (Vercel) đã có rewrite để F5 ở đường dẫn sâu không bị 404.
- **Realtime chạy trong bộ nhớ một tiến trình: chỉ chạy 1 instance backend.** Muốn chạy nhiều instance cần chuyển `src/realtime/hub.js` sang Redis Pub/Sub.
- Proxy phía trước phải cho phép kết nối SSE mở lâu (Render/Nginx mặc định ổn; server tự gửi heartbeat 25 giây/lần). Nếu tự dựng Nginx: `proxy_buffering off;` cho `/api/realtime/stream`.

## Chuyển dữ liệu từ Aiven sang TiDB Cloud

1. Trong [TiDB Cloud Console](https://tidbcloud.com/), mở instance tương thích MySQL, lấy thông tin ở **Connect → Public Endpoint** và tạo database đích trống. Dùng đúng hostname và username đầy đủ có tiền tố như trong hộp thoại Connect.

   ```sql
   CREATE DATABASE shopdb CHARACTER SET utf8mb4;
   ```

2. Dùng MySQL CLI để thử xuất và nhập trước khi chuyển production. Nếu nguồn có trigger, event hoặc stored procedure ngoài schema của dự án, rà soát trước vì TiDB không hỗ trợ các đối tượng này. Cho lần chuyển chính thức, dừng mọi tác vụ ghi vào Aiven, gồm backend và tác vụ nền, trước khi xuất bản cuối. Giữ chế độ bảo trì đến khi xác nhận Render đã dùng TiDB Cloud. Dùng các lệnh dưới đây trong PowerShell với MySQL CLI 8, thay các biến bằng thông tin từ hai dashboard. `$aivenCa` là CA của dự án Aiven, `$tidbCa` là đường dẫn tới [CA gốc của endpoint TiDB Cloud](https://docs.pingcap.com/tidbcloud/secure-connections-to-serverless-clusters/). `-p` hỏi mật khẩu khi chạy. Dùng đường dẫn tuyệt đối có dấu `/` cho `$dumpPath` (ví dụ `C:/Users/you/backup-shopdb-aiven.sql`), lưu dump ở nơi riêng tư vì chứa dữ liệu khách hàng.

   ```powershell
   mysqldump -h $aivenHost -P $aivenPort -u $aivenUser -p --ssl-mode=VERIFY_IDENTITY --ssl-ca=$aivenCa `
     --single-transaction --quick --set-gtid-purged=OFF --no-tablespaces --skip-triggers `
     --skip-add-locks --skip-add-drop-table --default-character-set=utf8mb4 --result-file=$dumpPath shopdb
   ```

   Kiểm tra `$LASTEXITCODE` bằng `0` sau mỗi lệnh. Chỉ nhập dump khi xuất thành công và database đích còn trống.

   ```powershell
   mysql --comments -h $tidbHost -P $tidbPort -u $tidbUser -p --ssl-mode=VERIFY_IDENTITY --ssl-ca=$tidbCa `
     --default-character-set=utf8mb4 --database=shopdb --execute="SOURCE $dumpPath"
   ```

3. So sánh danh sách bảng và số dòng của từng bảng trên hai database trước khi nâng cấp schema. Từ thư mục `shoppc-be`, đặt cấu hình TiDB Cloud bên dưới trong `.env`, rồi chạy `npm run migrate-db` để xem các bước nâng cấp. Nếu có thay đổi, chạy `npm run migrate-db -- --apply` trên database đích và kiểm tra lại.

   ```dotenv
   DB_HOST=<host từ TiDB Connect>
   DB_PORT=4000
   DB_USER=<username đầy đủ từ TiDB Connect>
   DB_PASSWORD=<mật khẩu TiDB>
   DB_NAME=shopdb
   DB_SSL=verify-identity
   ```

   Dùng port trong TiDB Connect nếu khác `4000`. `verify-identity` dùng TLS và xác minh chứng chỉ cùng hostname. Node.js dùng CA tích hợp cho TiDB Cloud Starter/Essential. Giá trị `DB_SSL=true` vẫn dùng được với kết nối Aiven hiện tại trong lúc chuẩn bị chuyển.

4. Trên Render, mở service `shoppc-be` → **Environment**, đổi sáu biến `DB_*` theo cấu hình trên rồi **Save, rebuild, and deploy** với commit đã có chế độ `verify-identity`. Với service đang tồn tại, cập nhật các biến trong dashboard. Kiểm tra log khởi động báo phiên bản TiDB, `/health/ready` trả HTTP 200 và dữ liệu sản phẩm, đơn hàng cũ hiển thị đúng trước khi mở lại ghi. Giữ Aiven và bản sao lưu để đối chiếu. Nếu phải quay về Aiven sau khi TiDB đã nhận ghi, đối soát các thay đổi phát sinh trước khi chuyển lại.

## Kiểm thử
`npm test` trong `shoppc-be` — chạy toàn bộ test không cần MySQL, mạng hay API key (dùng database và AI giả). CI mẫu: `.github/workflows/ci.yml`.

## Giới hạn đã biết
- Việc nâng cấp database được kiểm thử bằng bộ mô phỏng MySQL và bằng cách đối chiếu mọi câu SQL trong code với schema; **chưa được chạy thử trên MySQL thật** trong quá trình phát triển — hãy sao lưu trước khi chạy `migrate-db --apply`.
- Giới hạn tần suất (đăng nhập, đặt hàng, chat…) cũng lưu trong bộ nhớ: khởi động lại server là reset.
- Gửi email (quên mật khẩu) cần `npm install nodemailer` + cấu hình `SMTP_*`.
