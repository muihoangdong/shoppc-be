const express = require('express');
const AiController = require('../controllers/aiController');
const { authenticate, authorizeStaff } = require('../middlewares/auth');
const rateLimit = require('../middlewares/rateLimit');

const router = express.Router();

// Mỗi lần gọi AI tốn tiền: giới hạn theo người dùng (không theo IP để nhiều nhân viên chung văn phòng không ảnh hưởng nhau)
const aiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.AI_FEATURE_RATE_LIMIT_PER_MIN) || 20,
    keyGenerator: (req) => `u:${req.user ? req.user.id : req.ip}`,
    message: 'Bạn dùng AI quá nhanh, vui lòng thử lại sau ít giây.'
});

router.use(authenticate, authorizeStaff);
router.get('/status', AiController.status);
router.post('/suggest-reply', aiLimiter, AiController.suggestReply);
router.post('/product-description', aiLimiter, AiController.productDescription);
router.post('/insights', aiLimiter, AiController.insights);

module.exports = router;
