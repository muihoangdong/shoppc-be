const express = require('express');
const UserController = require('../controllers/userController');

const router = express.Router();

// Public routes - Không cần xác thực
router.post('/login', UserController.login);
router.post('/register', UserController.register);

// Optional: Các routes bổ sung nếu cần
router.post('/refresh-token', UserController.refreshToken);
router.post('/forgot-password', UserController.forgotPassword);
router.post('/reset-password', UserController.resetPassword);
router.post('/logout', UserController.logout);

module.exports = router;