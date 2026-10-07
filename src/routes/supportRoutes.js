const express = require('express');
const SupportController = require('../controllers/supportController');
const { authenticate, authorizeStaff } = require('../middlewares/auth');
const { requireVisitor, optionalUser } = require('../middlewares/supportIdentity');
const rateLimit = require('../middlewares/rateLimit');

const router = express.Router();

const MIN = 60 * 1000;
const visitorKey = (req) => (req.visitor ? `v:${req.visitor.id}` : req.ip);

const sessionLimiter = rateLimit({ windowMs: 60 * MIN, max: 30, message: 'Bạn mở chat quá nhiều lần, vui lòng thử lại sau.' });
const sendLimiter = rateLimit({ windowMs: MIN, max: 15, keyGenerator: visitorKey, message: 'Bạn nhắn quá nhanh, vui lòng chờ một chút.' });
const typingLimiter = rateLimit({ windowMs: MIN, max: 60, keyGenerator: visitorKey, message: 'Quá nhiều yêu cầu.' });
const staffTypingLimiter = rateLimit({ windowMs: MIN, max: 120, keyGenerator: (req) => `s:${req.user ? req.user.id : req.ip}`, message: 'Quá nhiều yêu cầu.' });

// ── Khách hàng (đăng nhập hoặc ẩn danh) ──
router.post('/session', sessionLimiter, SupportController.session);
router.get('/conversation', requireVisitor, SupportController.conversation);
router.get('/messages', requireVisitor, SupportController.messages);
router.post('/messages', requireVisitor, sendLimiter, optionalUser, SupportController.send);
router.post('/read', requireVisitor, typingLimiter, SupportController.read);
router.post('/typing', requireVisitor, typingLimiter, SupportController.typing);
router.post('/request-human', requireVisitor, sendLimiter, SupportController.requestHuman);
router.post('/ticket', requireVisitor, sessionLimiter, SupportController.ticket);

// ── Nhân viên / admin ──
router.use('/staff', authenticate, authorizeStaff);
router.get('/staff/unread', SupportController.unread);
router.get('/staff/conversations', SupportController.listConversations);
router.get('/staff/conversations/:id(\\d+)', SupportController.getConversation);
router.get('/staff/conversations/:id(\\d+)/messages', SupportController.conversationMessages);
router.post('/staff/conversations/:id(\\d+)/messages', staffTypingLimiter, SupportController.reply);
router.post('/staff/conversations/:id(\\d+)/read', staffTypingLimiter, SupportController.staffRead);
router.post('/staff/conversations/:id(\\d+)/typing', staffTypingLimiter, SupportController.staffTyping);
router.patch('/staff/conversations/:id(\\d+)', SupportController.update);

module.exports = router;
