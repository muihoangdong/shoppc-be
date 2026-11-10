'use strict';
const router = require('express').Router();
const { authenticate } = require('../middlewares/auth');
const rateLimit = require('../middlewares/rateLimit');
const { sendError } = require('../utils/http');
const service = require('../services/customerFeatures');
const endpoint = (fn) => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { res.json({ success: true, data: await fn(req) }); }
    catch (err) { sendError(res, err, 'Không thực hiện được yêu cầu'); }
};
router.get('/spec-fields', endpoint(() => service.specFields()));
router.use(authenticate);
router.use(rateLimit({ windowMs: 60000, max: 120, message: 'Bạn thao tác quá nhanh. Vui lòng thử lại sau.' }));
router.get('/state', endpoint((r) => service.state(r.user)));
router.get('/wishlist', endpoint((r) => service.wishlist(r.user)));
router.put('/wishlist/:id', endpoint((r) => service.setWishlist(r.user, r.params.id, true)));
router.delete('/wishlist/:id', endpoint((r) => service.setWishlist(r.user, r.params.id, false)));
router.get('/stock-alerts', endpoint((r) => service.alerts(r.user)));
router.put('/stock-alerts/:id', endpoint((r) => service.setAlert(r.user, r.params.id, true)));
router.delete('/stock-alerts/:id', endpoint((r) => service.setAlert(r.user, r.params.id, false)));
router.get('/warranties', endpoint((r) => service.warranties(r.user, r.query)));
router.get('/return-items', endpoint((r) => service.returnItems(r.user, r.query)));
router.get('/returns', endpoint((r) => service.returns(r.user)));
router.post('/returns', endpoint((r) => service.createReturn(r.user, r.body)));
router.post('/returns/:id/cancel', endpoint((r) => service.cancelReturn(r.user, r.params.id)));
module.exports = router;
