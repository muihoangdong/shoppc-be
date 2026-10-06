const express = require('express');
const BuilderController = require('../controllers/builderController');
const { builderAiLimiter } = require('../middlewares/limiters');

const router = express.Router();

// Công khai (storefront). Gợi ý bằng AI tốn tiền gọi API nên có giới hạn tần suất theo IP.
router.get('/config', BuilderController.config);
router.get('/parts/:type', BuilderController.parts);
router.post('/check', BuilderController.check);
router.post('/suggest', builderAiLimiter, BuilderController.suggest);

module.exports = router;
