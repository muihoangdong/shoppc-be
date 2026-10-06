const express = require('express');
const RealtimeController = require('../controllers/realtimeController');
const { authenticate } = require('../middlewares/auth');
const rateLimit = require('../middlewares/rateLimit');

const router = express.Router();

const ticketLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, message: 'Bạn kết nối lại quá nhanh, vui lòng thử lại sau ít giây.' });

router.post('/ticket', ticketLimiter, authenticate, RealtimeController.ticket);
router.get('/stream', ticketLimiter, RealtimeController.stream);

module.exports = router;
