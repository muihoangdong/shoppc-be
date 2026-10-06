const express = require('express');
const UserController = require('../controllers/userController');
const { loginLimiter, registerLimiter, otpVerifyLimiter, otpResendLimiter } = require('../middlewares/limiters');
const { authenticate, authorizeAdmin } = require('../middlewares/auth');

const router = express.Router();

router.post('/login', loginLimiter, UserController.login);
router.post('/register', registerLimiter, UserController.register);
router.post('/register/verify', otpVerifyLimiter, UserController.verifyRegistration);
router.post('/register/resend', otpResendLimiter, UserController.resendRegistrationOtp);

router.get('/me', authenticate, UserController.getCurrentUser);
router.put('/me', authenticate, UserController.updateCurrentUser);
router.put('/me/password', authenticate, UserController.updatePassword);
// Đổi email (khách hàng): gửi mã OTP tới email mới -> nhập mã
router.post('/me/email', authenticate, otpResendLimiter, UserController.requestEmailChange);
router.post('/me/email/verify', authenticate, otpVerifyLimiter, UserController.verifyEmailChange);
router.post('/me/email/resend', authenticate, otpResendLimiter, UserController.resendEmailChange);

router.get('/', authenticate, authorizeAdmin, UserController.getAllUsers);
// Chỉ admin mới tạo được tài khoản nhân viên/quản trị (đăng ký công khai chỉ tạo khách hàng)
router.post('/', authenticate, authorizeAdmin, UserController.createUser);
router.get('/:id', authenticate, authorizeAdmin, UserController.getUserById);
router.put('/:id', authenticate, authorizeAdmin, UserController.updateUser);
router.delete('/:id', authenticate, authorizeAdmin, UserController.deleteUser);

module.exports = router;
