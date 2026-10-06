const express = require('express');
const UserController = require('../controllers/userController');
const { loginLimiter, registerLimiter, forgotLimiter } = require('../middlewares/limiters');

const router = express.Router();

// Public routes - Không cần xác thực
// Giới hạn tần suất theo IP để chống dò mật khẩu / spam tài khoản (xem middlewares/limiters.js)
router.post('/login', loginLimiter, UserController.login);
router.post('/register', registerLimiter, UserController.register);

// Optional: Các routes bổ sung nếu cần
router.post('/refresh-token', UserController.refreshToken);
router.post('/forgot-password', forgotLimiter, UserController.forgotPassword);
router.post('/reset-password', forgotLimiter, UserController.resetPassword);
router.post('/logout', UserController.logout);

module.exports = router;