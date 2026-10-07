const express = require('express');
const CouponController = require('../controllers/couponController');
const { authenticate, authorizeStaff, authorizeAdmin } = require('../middlewares/auth');
const rateLimit = require('../middlewares/rateLimit');

const router = express.Router();

// Công khai: khách thử mã ở trang thanh toán — giới hạn tần suất để không dò được danh sách mã
router.post(
    '/check',
    rateLimit({ windowMs: 10 * 60 * 1000, max: 20, message: 'Bạn thử mã giảm giá quá nhiều lần, vui lòng thử lại sau ít phút.' }),
    CouponController.check
);

// Nhân viên xem được; tạo / sửa / xóa mã (ảnh hưởng trực tiếp tới tiền) chỉ dành cho admin
router.get('/', authenticate, authorizeStaff, CouponController.list);
router.post('/', authenticate, authorizeAdmin, CouponController.create);
router.put('/:id', authenticate, authorizeAdmin, CouponController.update);
router.delete('/:id', authenticate, authorizeAdmin, CouponController.remove);

module.exports = router;
