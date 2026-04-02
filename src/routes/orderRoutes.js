const express = require('express');
const OrderController = require('../controllers/orderController');
const { authenticate, authorizeStaff } = require('../middlewares/auth');

const router = express.Router();

router.get('/track/:orderCode', OrderController.trackOrder);
router.post('/', OrderController.createOrder);
router.get('/', authenticate, authorizeStaff, OrderController.getOrders);
router.get('/dashboard/stats', authenticate, authorizeStaff, OrderController.getDashboardStats);
router.get('/:id/items', authenticate, authorizeStaff, OrderController.getOrderItems);
router.patch('/:id/status', authenticate, authorizeStaff, OrderController.updateOrderStatus);

module.exports = router;
