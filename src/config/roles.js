'use strict';

/**
 * Định nghĩa vai trò TẬP TRUNG cho toàn backend. Ba vai trò theo thứ bậc quyền tăng dần:
 *
 *   customer  Khách hàng. Mua hàng trên storefront, quản lý hồ sơ của chính mình.
 *             KHÔNG vào được API/trang quản trị.
 *   staff     Nhân viên. Dùng dashboard: xem/tạo/sửa sản phẩm & danh mục, đổi tồn kho,
 *             xử lý đơn hàng, xem thống kê, dùng chatbot. KHÔNG xóa sản phẩm/danh mục,
 *             KHÔNG quản lý người dùng.
 *   admin     Quản trị viên. Toàn quyền: gồm xóa sản phẩm/danh mục và quản lý tài khoản
 *             (tạo nhân viên, đổi vai trò, khóa/mở khóa, xóa).
 *
 * Đăng ký công khai chỉ tạo `customer`. `staff`/`admin` chỉ do admin cấp.
 */

const ROLES = ['customer', 'staff', 'admin'];
const RANK = { customer: 0, staff: 1, admin: 2 };

const DEFAULT_ROLE = 'customer';
const USER_STATUSES = ['active', 'inactive'];

const ROLE_LABELS = {
    customer: 'Khách hàng',
    staff: 'Nhân viên',
    admin: 'Quản trị viên'
};

/** Vai trò `role` có đạt tối thiểu mức `min` không (admin >= staff >= customer). Vai trò lạ/null => false. */
const hasRole = (role, min) =>
    Object.prototype.hasOwnProperty.call(RANK, role) && RANK[role] >= RANK[min];

const isValidRole = (role) => ROLES.includes(role);

module.exports = { ROLES, RANK, DEFAULT_ROLE, USER_STATUSES, ROLE_LABELS, hasRole, isValidRole };
