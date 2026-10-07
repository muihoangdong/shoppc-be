const OrderModel = require('../models/Order');
const { getAnalytics, RangeInputError } = require('../services/analytics');
const Events = require('../realtime/events');
const Payments = require('../services/payments');
const UserModel = require('../models/User');

const isStr = (v) => typeof v === 'string';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[0-9+\s().-]{8,20}$/;
const digits = (v) => String(v || '').replace(/\D/g, '');

/**
 * Lỗi nghiệp vụ (có `expose`) -> trả đúng mã + thông báo.
 * Lỗi khác (SQL, bug...) -> ghi log và trả thông báo chung, KHÔNG lộ chi tiết nội bộ.
 */
const sendError = (res, error, fallback = 'Đã xảy ra lỗi, vui lòng thử lại sau') => {
    if (error && (error.expose || error instanceof RangeInputError)) {
        return res.status(error.status || 400).json({ success: false, message: error.message });
    }
    console.error('Order API error:', error);
    return res.status(500).json({ success: false, message: fallback });
};

// Các trường khách được phép gửi khi đặt hàng, kèm độ dài tối đa. KHÔNG có phí ship/giảm giá/tổng tiền:
// những thứ đó do server tính.
const ORDER_FIELDS = {
    customer_name: 100,
    customer_email: 150,
    customer_phone: 20,
    customer_address: 255,
    customer_ward: 100,
    customer_district: 100,
    customer_city: 100,
    note: 500
};

function buildOrderPayload(req) {
    const body = req.body || {};
    const session_id = body.session_id || req.headers['x-session-id'];
    if (!isStr(session_id) || !session_id || session_id.length > 100) {
        return { error: 'Thiếu mã giỏ hàng (session_id)' };
    }

    const payload = { session_id, user_id: req.user?.id || null };
    for (const [field, max] of Object.entries(ORDER_FIELDS)) {
        const v = body[field];
        if (v === undefined || v === null || v === '') continue;
        if (!isStr(v)) return { error: `Trường ${field} không hợp lệ` };
        if (v.trim().length > max) return { error: `Trường ${field} quá dài (tối đa ${max} ký tự)` };
        payload[field] = v.trim();
    }

    for (const required of ['customer_name', 'customer_email', 'customer_phone', 'customer_address', 'customer_city']) {
        if (!payload[required]) return { error: 'Thiếu thông tin đặt hàng bắt buộc' };
    }
    if (!EMAIL_RE.test(payload.customer_email)) return { error: 'Email không hợp lệ' };
    if (!PHONE_RE.test(payload.customer_phone) || digits(payload.customer_phone).length < 8) {
        return { error: 'Số điện thoại không hợp lệ' };
    }

    if (body.payment_method !== undefined) {
        if (!isStr(body.payment_method)) return { error: 'Phương thức thanh toán không hợp lệ' };
        payload.payment_method = body.payment_method;
    }
    if (body.coupon_code !== undefined && body.coupon_code !== null && body.coupon_code !== '') {
        if (!isStr(body.coupon_code) || body.coupon_code.length > 50) return { error: 'Mã giảm giá không hợp lệ' };
        payload.coupon_code = body.coupon_code;
    }
    return { payload };
}

class OrderController {
    static async createOrder(req, res) {
        try {
            const { payload, error } = buildOrderPayload(req);
            if (error) return res.status(400).json({ success: false, message: error });

            const order = await OrderModel.createOrderFromCart(payload);
            Events.orderNew(order); // báo realtime cho nhân viên đang mở dashboard
            Events.productChanged(); // tồn kho vừa bị trừ
            res.status(201).json({ success: true, message: 'Đặt hàng thành công', data: order });
        } catch (error) {
            // Lỗi cơ sở dữ liệu có `code`/`sqlState`; lỗi nghiệp vụ (giỏ trống, hết hàng...) là Error thường với thông báo tiếng Việt
            if (error && (error.code || error.sqlState)) {
                console.error('Create order DB error:', error);
                return res.status(500).json({ success: false, message: 'Không thể tạo đơn hàng, vui lòng thử lại sau' });
            }
            res.status(error.status || 400).json({ success: false, message: error.message });
        }
    }

    /**
     * Không có `page`/`limit`: trả toàn bộ (tương thích cũ, chatbot/trang cũ).
     * Có `page` hoặc `limit`: lọc + phân trang phía server, kèm `meta` (tổng, số trang, đếm theo trạng thái).
     */
    static async getOrders(req, res) {
        try {
            const q = req.query || {};
            if (q.page !== undefined || q.limit !== undefined) {
                const result = await OrderModel.getOrdersPaged(q);
                const { orders, ...meta } = result;
                return res.json({ success: true, data: orders, meta });
            }
            const legacy = {};
            if (isStr(q.status)) legacy.status = q.status;
            if (isStr(q.payment_status)) legacy.payment_status = q.payment_status;
            const orders = await OrderModel.getOrders(legacy);
            res.json({ success: true, data: orders });
        } catch (error) {
            sendError(res, error);
        }
    }

    static async getOrderById(req, res) {
        try {
            const order = await OrderModel.getOrderDetail(Number(req.params.id));
            if (!order) return res.status(404).json({ success: false, message: 'Không tìm thấy đơn hàng' });
            res.json({ success: true, data: order });
        } catch (error) {
            sendError(res, error);
        }
    }

    static async getOrderItems(req, res) {
        try {
            const items = await OrderModel.getOrderItems(req.params.id);
            res.json({ success: true, data: items });
        } catch (error) {
            sendError(res, error);
        }
    }

    static async updateOrderStatus(req, res) {
        try {
            const { status, note } = req.body || {};
            if (!isStr(status) || !status) return res.status(400).json({ success: false, message: 'Thiếu trạng thái mới' });
            if (note !== undefined && note !== null && (!isStr(note) || note.length > 500)) {
                return res.status(400).json({ success: false, message: 'Ghi chú không hợp lệ (tối đa 500 ký tự)' });
            }
            const order = await OrderModel.updateOrderStatus(Number(req.params.id), status, req.user?.id || null, note || null);
            Events.orderUpdated(order, req.user ? { id: req.user.id, name: req.user.username } : null);
            if (status === 'cancelled') Events.productChanged(); // hủy đơn hoàn lại tồn kho
            res.json({ success: true, message: 'Cập nhật trạng thái đơn hàng thành công', data: order });
        } catch (error) {
            sendError(res, error);
        }
    }

    static async updatePaymentStatus(req, res) {
        try {
            const { payment_status } = req.body || {};
            if (!isStr(payment_status)) return res.status(400).json({ success: false, message: 'Thiếu trạng thái thanh toán' });
            const id = Number(req.params.id);
            const before = await OrderModel.getOrderById(id);
            const order = await OrderModel.updatePaymentStatus(id, payment_status);
            const by = req.user ? { id: req.user.id, name: req.user.username } : null;
            Events.orderUpdated(order, by);
            // Vừa xác nhận đã nhận tiền: báo các nhân viên khác + email cảm ơn khách
            if (payment_status === 'paid' && before && before.payment_status !== 'paid') Payments.afterPaid(order, by);
            res.json({ success: true, message: 'Cập nhật thanh toán thành công', data: order });
        } catch (error) {
            sendError(res, error);
        }
    }

    /**
     * Tra cứu đơn công khai. Bắt buộc kèm số điện thoại đặt hàng (?phone=...) để người ngoài
     * không dò được thông tin khách chỉ từ mã đơn. Sai mã hoặc sai SĐT đều trả 404 giống nhau.
     */
    static async trackOrder(req, res) {
        try {
            const notFound = () => res.status(404).json({ success: false, message: 'Không tìm thấy đơn hàng' });
            const phone = req.query && req.query.phone;
            if (!isStr(req.params.orderCode) || !isStr(phone) || digits(phone).length < 8) return notFound();

            const order = await OrderModel.getOrderByCode(req.params.orderCode);
            if (!order || digits(order.customer_phone) !== digits(phone)) return notFound();

            const items = await OrderModel.getOrderItems(order.id);
            res.json({ success: true, data: { ...OrderModel.publicOrder(order), items } });
        } catch (error) {
            sendError(res, error);
        }
    }

    /** Khách bấm "Tôi đã chuyển khoản" (công khai, cần đúng SĐT đặt hàng như trang thanh toán). */
    static async claimPayment(req, res) {
        try {
            const notFound = () => res.status(404).json({ success: false, message: 'Không tìm thấy đơn hàng' });
            const phone = req.query && req.query.phone;
            if (!isStr(req.params.orderCode) || !isStr(phone) || digits(phone).length < 8) return notFound();
            const order = await OrderModel.getOrderByCode(req.params.orderCode);
            if (!order || digits(order.customer_phone) !== digits(phone)) return notFound();
            const { order: updated } = await Payments.claimPayment(order);
            res.json({ success: true, message: 'Đã báo cửa hàng. Đơn sẽ được xác nhận ngay khi cửa hàng nhận được tiền.', data: await Payments.paymentInfo(updated) });
        } catch (error) {
            sendError(res, error);
        }
    }

    /** Nhân viên chưa thấy tiền về: bỏ trạng thái "khách báo đã chuyển khoản" (khách sẽ thấy và báo lại được). */
    static async rejectPaymentClaim(req, res) {
        try {
            const id = Number(req.params.id);
            const order = await OrderModel.getOrderById(id);
            if (!order) return res.status(404).json({ success: false, message: 'Không tìm thấy đơn hàng' });
            const updated = await OrderModel.clearPaymentClaim(id);
            Events.orderUpdated(updated, req.user ? { id: req.user.id, name: req.user.username } : null);
            res.json({ success: true, message: 'Đã ghi nhận: chưa nhận được tiền', data: updated });
        } catch (error) {
            sendError(res, error);
        }
    }

    /**
     * Thông tin thanh toán của đơn (công khai, cần kèm SĐT như tra cứu đơn): số tiền, tài khoản nhận,
     * nội dung chuyển khoản và mã VietQR. Trang của khách gọi lại định kỳ để biết đã nhận tiền chưa.
     */
    static async getPayment(req, res) {
        try {
            const notFound = () => res.status(404).json({ success: false, message: 'Không tìm thấy đơn hàng' });
            const phone = req.query && req.query.phone;
            if (!isStr(req.params.orderCode) || !isStr(phone) || digits(phone).length < 8) return notFound();
            const order = await OrderModel.getOrderByCode(req.params.orderCode);
            if (!order || digits(order.customer_phone) !== digits(phone)) return notFound();
            res.json({ success: true, data: await Payments.paymentInfo(order) });
        } catch (error) {
            sendError(res, error);
        }
    }

    // ───── Khách đã đăng nhập: lịch sử và theo dõi đơn của mình ─────
    static async myOrders(req, res) {
        try {
            const q = req.query || {};
            const group = isStr(q.group) && q.group ? q.group : undefined;
            const page = Math.min(Math.max(parseInt(q.page, 10) || 1, 1), 1000);
            const user = await UserModel.getUserById(req.user.id);
            const result = await OrderModel.getCustomerOrders(req.user.id, user?.email, { group, page, limit: 10 });
            const { orders, ...meta } = result;
            res.json({ success: true, data: orders, meta });
        } catch (error) {
            sendError(res, error);
        }
    }

    static async myOrderDetail(req, res) {
        try {
            const user = await UserModel.getUserById(req.user.id);
            const order = isStr(req.params.orderCode) ? await OrderModel.getCustomerOrder(req.user.id, user?.email, req.params.orderCode) : null;
            if (!order) return res.status(404).json({ success: false, message: 'Không tìm thấy đơn hàng' });
            res.json({ success: true, data: order });
        } catch (error) {
            sendError(res, error);
        }
    }

    /** Khách tự hủy đơn: chỉ khi cửa hàng chưa xác nhận và chưa thanh toán. Hoàn tồn kho + lượt mã giảm giá như khi nhân viên hủy. */
    static async cancelMyOrder(req, res) {
        try {
            const user = await UserModel.getUserById(req.user.id);
            const order = isStr(req.params.orderCode) ? await OrderModel.getCustomerOrder(req.user.id, user?.email, req.params.orderCode) : null;
            if (!order) return res.status(404).json({ success: false, message: 'Không tìm thấy đơn hàng' });
            if (order.status !== 'pending') {
                return res.status(409).json({ success: false, message: 'Đơn đã được cửa hàng xác nhận nên không tự hủy được. Vui lòng liên hệ cửa hàng (chat hỗ trợ) để được giúp.' });
            }
            if (order.payment_status === 'paid') {
                return res.status(409).json({ success: false, message: 'Đơn đã thanh toán. Vui lòng liên hệ cửa hàng để hủy và hoàn tiền.' });
            }
            const reason = req.body && isStr(req.body.reason) ? req.body.reason.trim().slice(0, 200) : '';
            const updated = await OrderModel.cancelOrder(order.id, req.user.id, `Khách hủy đơn${reason ? `: ${reason}` : ''}`);
            Events.orderUpdated(updated, { id: req.user.id, name: user?.full_name || req.user.username });
            Events.productChanged(); // hủy đơn hoàn lại tồn kho
            res.json({ success: true, message: 'Đã hủy đơn hàng', data: await OrderModel.getCustomerOrder(req.user.id, user?.email, order.order_code) });
        } catch (error) {
            sendError(res, error);
        }
    }

    static async getDashboardStats(req, res) {
        try {
            const stats = await OrderModel.getDashboardStats();
            res.json({ success: true, data: stats });
        } catch (error) {
            sendError(res, error);
        }
    }

    static async getAnalytics(req, res) {
        try {
            const { period, from, to } = req.query || {};
            const data = await getAnalytics({
                period: isStr(period) ? period : undefined,
                from: isStr(from) ? from : undefined,
                to: isStr(to) ? to : undefined
            });
            res.json({ success: true, data });
        } catch (error) {
            sendError(res, error);
        }
    }
}

module.exports = OrderController;
