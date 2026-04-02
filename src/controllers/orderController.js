const OrderModel = require('../models/Order');

class OrderController {
    static async createOrder(req, res) {
        try {
            const session_id = req.body.session_id || req.headers['x-session-id'];
            const payload = { ...req.body, session_id, user_id: req.user?.id || null };
            if (!session_id || !payload.customer_name || !payload.customer_email || !payload.customer_phone || !payload.customer_address || !payload.customer_city) {
                return res.status(400).json({ success: false, message: 'Thiếu thông tin đặt hàng bắt buộc' });
            }
            const order = await OrderModel.createOrderFromCart(payload);
            res.status(201).json({ success: true, message: 'Đặt hàng thành công', data: order });
        } catch (error) {
            res.status(400).json({ success: false, message: error.message });
        }
    }

    static async getOrders(req, res) {
        try {
            const orders = await OrderModel.getOrders(req.query);
            res.json({ success: true, data: orders });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async getOrderItems(req, res) {
        try {
            const items = await OrderModel.getOrderItems(req.params.id);
            res.json({ success: true, data: items });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async updateOrderStatus(req, res) {
        try {
            const { status, note } = req.body;
            if (!status) return res.status(400).json({ success: false, message: 'Thiếu trạng thái mới' });
            const order = await OrderModel.updateOrderStatus(req.params.id, status, req.user?.id || null, note || null);
            res.json({ success: true, message: 'Cập nhật trạng thái đơn hàng thành công', data: order });
        } catch (error) {
            const statusCode = error.message.includes('Không tìm thấy') ? 404 : 400;
            res.status(statusCode).json({ success: false, message: error.message });
        }
    }

    static async trackOrder(req, res) {
        try {
            const order = await OrderModel.getOrderByCode(req.params.orderCode);
            if (!order) return res.status(404).json({ success: false, message: 'Không tìm thấy đơn hàng' });
            const items = await OrderModel.getOrderItems(order.id);
            res.json({ success: true, data: { ...order, items } });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async getDashboardStats(req, res) {
        try {
            const stats = await OrderModel.getDashboardStats();
            res.json({ success: true, data: stats });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    }
}

module.exports = OrderController;
