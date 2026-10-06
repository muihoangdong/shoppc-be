'use strict';

/**
 * Mã giảm giá: các quy tắc thuần (không đụng database) để dùng chung cho
 *  - xem trước khi khách bấm "Áp dụng" ở trang thanh toán (POST /api/coupons/check)
 *  - lúc tạo đơn (models/Order.createOrderFromCart) — đây mới là chỗ quyết định, trong transaction có khóa dòng mã.
 *
 * Giảm giá chỉ tính trên tiền hàng (tạm tính), không trừ vào phí ship. Ngày hiệu lực tính theo APP_TIMEZONE, gồm cả hai đầu.
 */

const { todayYmd } = require('./analytics');

const CODE_RE = /^[A-Z0-9_-]{3,30}$/;
const COUPON_TYPES = ['percentage', 'fixed'];

/** Chuẩn hóa mã khách nhập: bỏ khoảng trắng, chữ hoa. Mã sai định dạng -> null. */
const normalizeCode = (v) => {
    if (typeof v !== 'string') return null;
    const s = v.replace(/\s+/g, '').toUpperCase();
    return CODE_RE.test(s) ? s : null;
};

const money = (n) => `${Math.round(Number(n) || 0).toLocaleString('vi-VN')}₫`;
const dmy = (ymd) => ymd.split('-').reverse().join('/');
/** mysql2 trả cột DATE dạng Date (giờ máy chủ) hoặc chuỗi; đưa về 'YYYY-MM-DD'. */
const ymd = (v) => {
    if (!v) return null;
    if (v instanceof Date) {
        return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
    }
    return String(v).slice(0, 10);
};

/** Số tiền được giảm (đồng, số nguyên), không bao giờ vượt quá tiền hàng. */
function computeDiscount(coupon, subtotal) {
    const base = Math.max(Math.round(Number(subtotal) || 0), 0);
    const value = Number(coupon.value) || 0;
    let d = coupon.type === 'percentage' ? Math.floor((base * value) / 100) : Math.round(value);
    const cap = coupon.max_discount === null || coupon.max_discount === undefined ? null : Number(coupon.max_discount);
    if (coupon.type === 'percentage' && cap !== null && cap > 0) d = Math.min(d, Math.round(cap));
    return Math.min(Math.max(d, 0), base);
}

/**
 * @param {object|null} coupon  dòng trong bảng coupons
 * @param {{subtotal:number, today?:string, usedByCustomer?:boolean}} ctx
 * @returns {string|null} lý do không dùng được (tiếng Việt, hiển thị cho khách) hoặc null nếu dùng được
 */
function unusableReason(coupon, { subtotal, today = todayYmd(), usedByCustomer = false }) {
    if (!coupon || !Number(coupon.is_active)) return 'Mã giảm giá không tồn tại hoặc đã ngừng áp dụng';
    const start = ymd(coupon.starts_on);
    const end = ymd(coupon.expires_on);
    if (start && today < start) return `Mã giảm giá áp dụng từ ngày ${dmy(start)}`;
    if (end && today > end) return 'Mã giảm giá đã hết hạn';
    if (coupon.usage_limit !== null && coupon.usage_limit !== undefined && Number(coupon.used_count) >= Number(coupon.usage_limit)) {
        return 'Mã giảm giá đã hết lượt sử dụng';
    }
    const min = Number(coupon.min_order_value) || 0;
    if (Number(subtotal) < min) {
        return `Đơn hàng cần tối thiểu ${money(min)} tiền hàng để dùng mã này (còn thiếu ${money(min - Number(subtotal))})`;
    }
    if (Number(coupon.once_per_customer) && usedByCustomer) return 'Bạn đã dùng mã giảm giá này rồi (mỗi khách chỉ được dùng 1 lần)';
    return null;
}

const digits = (v) => String(v || '').replace(/\D/g, '');
/** Khách đã dùng mã chưa: so số điện thoại (chỉ phần số) hoặc email với các đơn chưa hủy đã dùng mã. */
function customerHasUsed(previousOrders, { phone, email }) {
    const p = digits(phone);
    const e = String(email || '').trim().toLowerCase();
    return previousOrders.some((o) => (p && digits(o.customer_phone) === p) || (e && String(o.customer_email || '').trim().toLowerCase() === e));
}

/** Mô tả ngắn cho khách: "Giảm 10% (tối đa 500.000₫)" / "Giảm 200.000₫". */
function summary(coupon) {
    const base = coupon.type === 'percentage'
        ? `Giảm ${Number(coupon.value)}%${Number(coupon.max_discount) > 0 ? ` (tối đa ${money(coupon.max_discount)})` : ''}`
        : `Giảm ${money(coupon.value)}`;
    return Number(coupon.min_order_value) > 0 ? `${base} cho đơn từ ${money(coupon.min_order_value)}` : base;
}

module.exports = { CODE_RE, COUPON_TYPES, normalizeCode, computeDiscount, unusableReason, customerHasUsed, summary, ymd };
