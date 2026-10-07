const CouponModel = require('../models/Coupon');
const CartModel = require('../models/Cart');
const Coupons = require('../services/coupons');
const { computeShippingFee } = require('../config/shipping');
const v = require('../utils/validate');
const { sendError } = require('../utils/http');

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_MONEY = 1e12;

const isSet = (x) => x !== undefined && x !== null && x !== '';
const bool = (x, label) => {
    if (x === undefined) return undefined;
    if (typeof x === 'boolean') return x ? 1 : 0;
    if (x === 0 || x === 1 || x === '0' || x === '1') return Number(x);
    return v.fail(`${label} phải là true/false`);
};
const money = (x, label, { optional = true, min = 0 } = {}) => {
    if (!isSet(x)) return optional ? undefined : v.fail(`Thiếu ${label}`);
    const n = typeof x === 'string' ? Number(x) : x;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > MAX_MONEY) v.fail(`${label} không hợp lệ`);
    return Math.round(n);
};
const date = (x, label) => {
    if (x === undefined) return undefined;
    if (x === null || x === '') return null;
    if (typeof x !== 'string' || !YMD_RE.test(x) || Number.isNaN(Date.parse(x))) v.fail(`${label} phải có dạng YYYY-MM-DD`);
    return x;
};

/** Kiểm tra dữ liệu admin gửi lên. `current` = mã đang sửa (để kiểm tra chéo khi chỉ gửi một phần). */
function parseCoupon(body, current = null) {
    const b = body && typeof body === 'object' ? body : {};
    const partial = !!current;
    const out = {};

    if (!partial || b.code !== undefined) {
        const code = Coupons.normalizeCode(b.code);
        if (!code) v.fail('Mã giảm giá phải dài 3–30 ký tự, chỉ gồm chữ không dấu, số, "-" hoặc "_"');
        out.code = code;
    }
    if (b.description !== undefined) out.description = v.str(b.description, 'Mô tả', { max: 255, optional: true, allowEmpty: true }) || null;
    out.type = v.oneOf(b.type, 'Loại giảm giá', Coupons.COUPON_TYPES, { optional: partial });
    out.value = money(b.value, 'Mức giảm', { optional: partial, min: 1 });
    out.min_order_value = money(b.min_order_value, 'Giá trị đơn tối thiểu');
    if (b.min_order_value === null || b.min_order_value === '') out.min_order_value = 0;
    if (b.max_discount !== undefined) out.max_discount = isSet(b.max_discount) ? money(b.max_discount, 'Giảm tối đa', { min: 1 }) : null;
    if (b.usage_limit !== undefined) out.usage_limit = isSet(b.usage_limit) ? v.int(b.usage_limit, 'Số lượt sử dụng', { min: 1, max: 1e7 }) : null;
    out.once_per_customer = bool(b.once_per_customer, 'Mỗi khách 1 lần');
    out.is_active = bool(b.is_active, 'Trạng thái');
    out.starts_on = date(b.starts_on, 'Ngày bắt đầu');
    out.expires_on = date(b.expires_on, 'Ngày hết hạn');
    Object.keys(out).forEach((k) => out[k] === undefined && delete out[k]);
    if (partial && Object.keys(out).length === 0) v.fail('Không có trường nào cần cập nhật');

    // Kiểm tra chéo trên dữ liệu sau khi gộp
    const m = { ...(current || {}), ...out };
    if (m.type === 'percentage' && Number(m.value) > 100) v.fail('Giảm theo % chỉ được từ 1 đến 100');
    if (m.type === 'fixed' && Number(m.min_order_value) > 0 && Number(m.value) > Number(m.min_order_value)) {
        v.fail('Mức giảm không được lớn hơn giá trị đơn tối thiểu');
    }
    if (m.starts_on && m.expires_on && m.starts_on > m.expires_on) v.fail('Ngày hết hạn phải sau ngày bắt đầu');
    if (current && m.usage_limit !== null && m.usage_limit !== undefined && m.usage_limit < current.used_count) {
        v.fail(`Số lượt không được nhỏ hơn số lượt đã dùng (${current.used_count})`);
    }
    return out;
}

const duplicate = (error) => error && error.code === 'ER_DUP_ENTRY';

class CouponController {
    // ───── Quản trị ─────
    static async list(req, res) {
        try {
            const search = typeof req.query?.search === 'string' ? req.query.search.trim().slice(0, 50) : '';
            res.json({ success: true, data: await CouponModel.list({ search }) });
        } catch (error) {
            sendError(res, error);
        }
    }

    static async create(req, res) {
        try {
            const data = parseCoupon(req.body);
            const id = await CouponModel.create(data);
            res.status(201).json({ success: true, message: 'Đã tạo mã giảm giá', data: await CouponModel.getById(id) });
        } catch (error) {
            if (duplicate(error)) return res.status(409).json({ success: false, message: 'Mã giảm giá này đã tồn tại' });
            sendError(res, error);
        }
    }

    static async update(req, res) {
        try {
            const id = v.idParam(req.params.id);
            const current = await CouponModel.getById(id);
            if (!current) return res.status(404).json({ success: false, message: 'Không tìm thấy mã giảm giá' });
            const data = parseCoupon(req.body, current);
            await CouponModel.update(id, data);
            res.json({ success: true, message: 'Đã cập nhật mã giảm giá', data: await CouponModel.getById(id) });
        } catch (error) {
            if (duplicate(error)) return res.status(409).json({ success: false, message: 'Mã giảm giá này đã tồn tại' });
            sendError(res, error);
        }
    }

    static async remove(req, res) {
        try {
            const id = v.idParam(req.params.id);
            if (!(await CouponModel.remove(id))) return res.status(404).json({ success: false, message: 'Không tìm thấy mã giảm giá' });
            res.json({ success: true, message: 'Đã xóa mã giảm giá' });
        } catch (error) {
            sendError(res, error);
        }
    }

    // ───── Khách: xem trước khi bấm "Áp dụng" (đơn hàng vẫn được kiểm tra lại lúc đặt) ─────
    static async check(req, res) {
        try {
            const b = req.body && typeof req.body === 'object' ? req.body : {};
            const code = Coupons.normalizeCode(b.code);
            if (!code) return res.status(400).json({ success: false, message: 'Mã giảm giá không hợp lệ' });
            const session = b.session_id || req.headers['x-session-id'];
            if (typeof session !== 'string' || !session || session.length > 100) {
                return res.status(400).json({ success: false, message: 'Thiếu mã giỏ hàng (session_id)' });
            }

            const cart = await CartModel.getCart(session);
            if (!cart.items.length) return res.status(400).json({ success: false, message: 'Giỏ hàng đang trống' });
            const subtotal = Math.round(cart.total);

            const coupon = await CouponModel.getByCode(code);
            const phone = typeof b.customer_phone === 'string' ? b.customer_phone : '';
            const email = typeof b.customer_email === 'string' ? b.customer_email : '';
            const usedByCustomer = coupon && coupon.once_per_customer && (phone || email)
                ? Coupons.customerHasUsed(await CouponModel.ordersUsing(code), { phone, email })
                : false;
            const reason = Coupons.unusableReason(coupon, { subtotal, usedByCustomer });
            if (reason) return res.status(400).json({ success: false, message: reason });

            const discount = Coupons.computeDiscount(coupon, subtotal);
            const shipping_fee = computeShippingFee(subtotal);
            res.json({
                success: true,
                message: `Đã áp dụng mã ${code}: giảm ${discount.toLocaleString('vi-VN')}₫`,
                data: {
                    code,
                    summary: Coupons.summary(coupon),
                    description: coupon.description,
                    subtotal,
                    discount,
                    shipping_fee,
                    total_amount: subtotal - discount + shipping_fee
                }
            });
        } catch (error) {
            sendError(res, error);
        }
    }
}

module.exports = CouponController;
module.exports.parseCoupon = parseCoupon;
