const express = require('express');
const ReviewController = require('../controllers/reviewController');
const { authenticate, optionalAuth, authorizeStaff, authorizeAdmin } = require('../middlewares/auth');
const rateLimit = require('../middlewares/rateLimit');

const router = express.Router();

// Khách: xem công khai (đăng nhập thì biết thêm mình có được đánh giá không); gửi/xóa đánh giá của mình cần đăng nhập
router.get('/product/:productId(\\d+)', optionalAuth, ReviewController.listForProduct);
router.post(
    '/product/:productId(\\d+)',
    authenticate,
    rateLimit({ windowMs: 60 * 60 * 1000, max: 20, message: 'Bạn gửi đánh giá quá nhiều lần, vui lòng thử lại sau.' }),
    ReviewController.submit
);
router.delete('/product/:productId(\\d+)/mine', authenticate, ReviewController.removeMine);

// Nhân viên: xem, ẩn/hiện, trả lời. Xóa hẳn: chỉ admin
router.get('/', authenticate, authorizeStaff, ReviewController.adminList);
router.patch('/:id(\\d+)', authenticate, authorizeStaff, ReviewController.update);
router.delete('/:id(\\d+)', authenticate, authorizeAdmin, ReviewController.remove);

module.exports = router;
