# Bản vá bảo mật

Tài liệu này mô tả các lỗ hổng đã được vá, việc bạn cần làm khi nâng cấp, và những điểm còn tồn tại.
Kiểm thử: `npm run test:security` (không cần DB, mạng hay API key).

## Đã vá

### 1. API sản phẩm / danh mục không yêu cầu đăng nhập
Trước đây ai cũng có thể tạo, sửa, đổi tồn kho, **xóa** sản phẩm và danh mục chỉ bằng một request.

| Route | Quyền |
|---|---|
| `GET /api/products...`, `GET /api/categories...` | Công khai (storefront cần) |
| `POST/PUT /api/products`, `PATCH /api/products/:id/stock`, `POST/PUT /api/categories` | Nhân viên hoặc admin đã đăng nhập |
| `DELETE /api/products/:id`, `DELETE /api/categories/:id` | **Chỉ admin** |

Nhân viên bấm xóa trên dashboard sẽ nhận thông báo lỗi (HTTP 403). Muốn cho nhân viên xóa, đổi `authorizeAdmin` thành `authorizeStaff` ở hai file route.

### 2. Đăng ký tự chọn quyền / mọi khách hàng là "staff"
- `/api/auth/register` (và `/api/users/register`) **bỏ qua** `role` do client gửi; luôn tạo vai trò **`customer`**.
- Trước đây vai trò mặc định là `staff`, nên **mọi khách đăng ký từ storefront đều đang có quyền nhân viên** (xem đơn hàng của mọi người, đổi trạng thái đơn...).
- Tài khoản nhân viên/quản trị chỉ tạo qua API mới dành cho admin: `POST /api/users`
  ```bash
  curl -X POST http://localhost:3000/api/users \
    -H "Authorization: Bearer <TOKEN_ADMIN>" -H "Content-Type: application/json" \
    -d '{"username":"nhanvien1","password":"matkhau123","email":"nv1@shop.vn","full_name":"Nhân viên 1","role":"staff"}'
  ```
  `role` nhận `admin`, `staff` hoặc `customer` (mặc định `staff`).
- Trang admin từ chối đăng nhập bằng tài khoản `customer`.
- Admin không thể hạ quyền admin duy nhất.
- Kiểm tra đầu vào đăng ký (độ dài, định dạng email, kiểu dữ liệu).

### 3. Quên mật khẩu trả token trong response
- `/api/auth/forgot-password` **không bao giờ** trả token; luôn trả cùng một thông báo dù email có tồn tại hay không (chống dò email). Tài khoản bị khóa không nhận email.
- Token đặt lại mật khẩu hết hạn sau 30 phút, **dùng được đúng một lần** (tự vô hiệu khi mật khẩu đổi) và **không dùng được** làm token đăng nhập (trước đây dùng được vì cùng secret).
- Lỗi đặt lại mật khẩu trả HTTP 400 thay vì 401 để không làm frontend tưởng hết phiên đăng nhập.

### Sửa kèm theo
- `JWT_SECRET` không còn giá trị dự phòng cố định `your-secret-key-change-this` (ai biết giá trị này đều tự ký được token admin). Production thiếu `JWT_SECRET` → server không khởi động; môi trường khác → dùng secret ngẫu nhiên tạm thời và cảnh báo.
- Đăng nhập: kiểm tra mật khẩu trước khi báo "tài khoản bị khóa" (không lộ tài khoản nào tồn tại).
- Đổi mật khẩu / đặt lại mật khẩu có kiểm tra độ dài; `refresh-token` từ chối tài khoản bị khóa.

## Việc BẠN cần làm khi nâng cấp

1. **Sửa vai trò trong database** bằng `npm run fix-roles` (sao lưu trước; hướng dẫn chi tiết ở `ROLES.md`). Script thêm giá trị `customer` vào cột `users.role` và hạ quyền các tài khoản đã đăng ký từ storefront. Nếu bỏ qua, khách hàng sẽ không đăng ký được (server in cảnh báo khi khởi động).
2. **Rà soát tài khoản `staff` cũ**: các khách đã đăng ký từ storefront trước đây vẫn đang là `staff` cho tới khi bạn chạy lệnh trên với `--keep <username nhân viên thật>`. (File `migrations/001_customer_role.sql` làm tương tự bằng SQL thủ công.)
3. **Đặt `JWT_SECRET`** (chuỗi ngẫu nhiên >= 32 ký tự) trong `.env` **và trong biến môi trường trên nơi deploy (Render...)**. Nếu deploy với `NODE_ENV=production` mà thiếu biến này, server sẽ không chạy. Nên đổi secret mới để vô hiệu hóa mọi token cũ.
4. Nên đổi mật khẩu các tài khoản admin/staff nếu hệ thống từng bị công khai ra internet.
5. (Tùy chọn) Bật gửi email quên mật khẩu: `npm install nodemailer` và điền `SMTP_*` trong `.env`.

## Chưa xử lý (nên làm tiếp)
- **Chưa có trang "Quên mật khẩu / Đặt lại mật khẩu" ở storefront.** Link `/forgot-password` trên trang đăng nhập hiện chưa dẫn tới trang nào. Backend đã sẵn sàng (`POST /api/auth/forgot-password`, `POST /api/auth/reset-password`).
- **Tra cứu đơn hàng công khai:** `GET /api/orders/track/:orderCode` không cần đăng nhập, mà mã đơn có dạng `ORD-<timestamp>` rất dễ đoán, nên có thể dò ra tên, SĐT, địa chỉ khách. Nên yêu cầu kèm số điện thoại/email của đơn, hoặc dùng mã đơn ngẫu nhiên dài.
- **Chưa giới hạn số lần đăng nhập sai** (brute-force) và chưa giới hạn tần suất `forgot-password`.
- `docker-compose.yml` dùng mật khẩu MySQL `123456` và mở cổng 3306 ra ngoài; chỉ nên dùng khi phát triển.
- CORS đang mở cho mọi domain (`cors()`); khi lên production nên giới hạn về domain của storefront/admin.
