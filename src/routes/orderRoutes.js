const express = require('express');
const OrderController = require('../controllers/orderController');
const { authenticate, authorizeStaff } = require('../middlewares/auth');
const rateLimit = require('../middlewares/rateLimit');

const router = express.Router();

const HOUR = 60 * 60 * 1000;

// Công khai: tra cứu đơn (cần kèm số điện thoại) và đặt hàng — có giới hạn tần suất chống dò mã đơn / spam đơn giả
router.get(
    '/track/:orderCode',
    rateLimit({ windowMs: 10 * 60 * 1000, max: 30, message: 'Bạn tra cứu quá nhiều lần, vui lòng thử lại sau ít phút.' }),
    OrderController.trackOrder
);
router.post(
    '/',
    rateLimit({ windowMs: HOUR, max: 15, message: 'Bạn đã đặt quá nhiều đơn trong thời gian ngắn, vui lòng thử lại sau.' }),
    OrderController.createOrder
);

// Dành cho nhân viên / admin
router.get('/', authenticate, authorizeStaff, OrderController.getOrders);
router.get('/dashboard/stats', authenticate, authorizeStaff, OrderController.getDashboardStats);
router.get('/analytics', authenticate, authorizeStaff, OrderController.getAnalytics);
router.get('/:id(\\d+)', authenticate, authorizeStaff, OrderController.getOrderById);
router.get('/:id(\\d+)/items', authenticate, authorizeStaff, OrderController.getOrderItems);
router.patch('/:id(\\d+)/status', authenticate, authorizeStaff, OrderController.updateOrderStatus);
router.patch('/:id(\\d+)/payment', authenticate, authorizeStaff, OrderController.updatePaymentStatus);

module.exports = router;
