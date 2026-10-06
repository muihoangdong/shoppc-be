# Vai trò và phân quyền

Có **3 vai trò**, định nghĩa ở một nơi duy nhất: `src/config/roles.js` (admin dashboard có bản sao tương ứng ở `shoppc-admin/src/utils/roles.ts`, storefront ở `shoppc-fe/src/utils/roles.ts`).

| Vai trò | Dành cho | Làm được |
|---|---|---|
| **customer** (Khách hàng) | Người mua trên storefront | Đặt hàng, xem/sửa hồ sơ và đổi mật khẩu của chính mình. **Không** vào được trang quản trị / API quản trị |
| **staff** (Nhân viên) | Nhân viên cửa hàng | Tất cả trang dashboard: tạo/sửa sản phẩm & danh mục, đổi tồn kho, xử lý đơn hàng, thống kê, chatbot. **Không** xóa sản phẩm/danh mục, **không** quản lý tài khoản |
| **admin** (Quản trị viên) | Chủ cửa hàng | Toàn quyền: gồm xóa sản phẩm/danh mục và trang **Tài khoản** (tạo nhân viên, đổi vai trò, khóa/mở khóa, xóa) |

Thứ bậc: `admin ⊇ staff ⊇ customer`. Vai trò rỗng/không hợp lệ không có quyền gì.

## Quy tắc

- **Đăng ký công khai luôn tạo `customer`.** Trường `role` do client gửi bị bỏ qua. Mặc định của model `User.createUser` cũng là `customer`.
- Tài khoản `staff`/`admin` chỉ do admin tạo (trang **Tài khoản** hoặc `POST /api/users`; không nêu vai trò thì mặc định là `staff`).
- Admin **không thể** tự đổi vai trò, tự khóa hoặc tự xóa chính mình; không thể hạ quyền/xóa admin cuối cùng.
- Trang admin chặn đúng vai trò (`ProtectedRoute`): chưa đăng nhập → trang đăng nhập; khách hàng → "Không có quyền"; nhân viên vào trang admin-only → "Không có quyền". Nút xóa sản phẩm/danh mục chỉ hiện với admin. (Quyền thật luôn do backend kiểm tra.)

## Sửa tài khoản cũ đang sai vai trò

Trước đây mọi khách đăng ký từ storefront bị gán `staff`. Script sẽ sửa (nên sao lưu database trước):

```bash
cd shoppc-be
npm run fix-roles                                       # 1) Xem danh sách admin/staff hiện có (không ghi gì)
npm run fix-roles -- --keep nhanvien1,nhanvien2         # 2) Xem trước: ai sẽ bị hạ xuống customer
npm run fix-roles -- --keep nhanvien1,nhanvien2 --apply # 3) Thực hiện
```

- `--keep` là danh sách **username nhân viên thật** cần giữ. Ai mang vai trò `staff` mà không có trong danh sách sẽ thành `customer`. `--keep none` hạ tất cả staff.
- Script **không bao giờ** đổi vai trò admin, từ chối chạy nếu không có admin nào, tự thêm giá trị `customer` vào cột `users.role` nếu thiếu và đặt mặc định cột là `customer`.
- Kiểm thử (không cần DB): `npm run test:roles`.
