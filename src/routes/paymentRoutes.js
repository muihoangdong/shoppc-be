const express = require('express');
const PaymentController = require('../controllers/paymentController');
const { authenticate, authorizeAdmin } = require('../middlewares/auth');

const router = express.Router();

// SePay báo có tiền vào tài khoản (xác thực bằng API key, xem controllers/paymentController.js)
router.post('/sepay', PaymentController.sepayWebhook);

// Tài khoản nhận chuyển khoản (trang Cài đặt → Thanh toán): chỉ admin
router.get('/settings', authenticate, authorizeAdmin, PaymentController.getSettings);
router.put('/settings', authenticate, authorizeAdmin, PaymentController.saveSettings);

module.exports = router;
