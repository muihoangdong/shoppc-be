const express = require('express');
const ChatController = require('../controllers/chatController');
const { authenticate, authorizeStaff } = require('../middlewares/auth');

const router = express.Router();

// Chatbot chỉ dành cho admin / staff đã đăng nhập
router.use(authenticate, authorizeStaff);

router.post('/', ChatController.chat);
router.post('/confirm', ChatController.confirm);
router.post('/cancel', ChatController.cancel);

module.exports = router;
