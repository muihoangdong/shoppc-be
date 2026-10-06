const express = require('express');
const PaymentController = require('../controllers/paymentController');

const router = express.Router();

// SePay báo có tiền vào tài khoản (xác thực bằng API key, xem controllers/paymentController.js)
router.post('/sepay', PaymentController.sepayWebhook);

module.exports = router;
