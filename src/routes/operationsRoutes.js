'use strict';

const express = require('express');
const { authenticate, authorizeStaff, authorizeAdmin } = require('../middlewares/auth');
const rateLimit = require('../middlewares/rateLimit');
const { sendError } = require('../utils/http');
const c = require('../services/operationsCommon');
const catalog = require('../services/operationsCatalog');
const inventory = require('../services/operationsInventory');
const warranty = require('../services/operationsWarranty');
const aftersales = require('../services/operationsAftersales');
const bulk = require('../services/operationsBulk');
const router = express.Router();
router.use(authenticate, authorizeStaff, express.json({ limit: '2mb' }));
router.use((req, res, next) => c.ledger.isReady() ? next() : res.status(503).json({ success: false, message: 'Chưa nâng cấp nghiệp vụ kho/bảo hành. Hãy chạy migrate-db và khởi động lại backend.' }));
const writeLimit = rateLimit({ windowMs: 60000, max: 60, message: 'Quá nhiều thao tác. Vui lòng thử lại sau.' });
router.use((req, res, next) => req.method === 'GET' ? next() : writeLimit(req, res, next));
const endpoint = (fn, status = 200) => async (req, res) => {
    try { res.status(status).json({ success: true, data: await fn(req) }); }
    catch (err) { sendError(res, err, 'Không thực hiện được nghiệp vụ'); }
};

router.get('/lookups', endpoint(() => catalog.lookups()));
router.get('/orders/:id/items', endpoint((req) => catalog.orderItems(req.params.id)));
for (const kind of ['suppliers', 'brands', 'templates']) {
    router.get(`/${kind}`, endpoint((req) => catalog.catalogList(kind, req.query)));
    router.post(`/${kind}`, authorizeAdmin, endpoint((req) => catalog.saveCatalog(kind, null, req.body, req.user), 201));
    router.put(`/${kind}/:id`, authorizeAdmin, endpoint((req) => catalog.saveCatalog(kind, req.params.id, req.body, req.user)));
}
router.get('/receipts', endpoint((req) => inventory.receipts(req.query)));
router.get('/receipts/:id', endpoint((req) => inventory.receiptDetail(req.params.id)));
router.post('/receipts', endpoint((req) => inventory.saveReceipt(null, req.body, req.user), 201));
router.put('/receipts/:id', endpoint((req) => inventory.saveReceipt(req.params.id, req.body, req.user)));
router.post('/receipts/:id/receive', authorizeAdmin, endpoint((req) => inventory.receiveReceipt(req.params.id, req.user)));
router.post('/receipts/:id/cancel', endpoint((req) => inventory.cancelReceipt(req.params.id, req.user)));
router.get('/movements', endpoint((req) => inventory.movements(req.query)));
router.post('/adjustments', authorizeAdmin, endpoint((req) => inventory.adjustStock(req.body.product_id, req.body.stock, req.user, req.body.reason)));
router.get('/serials', endpoint((req) => warranty.serials(req.query)));
router.post('/serials', endpoint((req) => warranty.registerSerials(req.body, req.user), 201));
router.post('/serials/:id/assign', endpoint((req) => warranty.assignSerial(req.params.id, req.body, req.user)));
router.post('/serials/:id/retire', authorizeAdmin, endpoint((req) => warranty.retireSerial(req.params.id, req.body, req.user)));
router.get('/warranties', endpoint((req) => warranty.warranties(req.query)));
router.post('/warranties', endpoint((req) => warranty.createWarranty(req.body, req.user), 201));
router.patch('/warranties/:id', endpoint((req) => warranty.updateWarranty(req.params.id, req.body, req.user)));
router.get('/returns', endpoint((req) => aftersales.returns(req.query)));
router.post('/returns', endpoint((req) => aftersales.createReturn(req.body, req.user), 201));
router.patch('/returns/:id', endpoint((req) => aftersales.updateReturn(req.params.id, req.body, req.user)));
router.get('/shipments', endpoint((req) => aftersales.shipments(req.query)));
router.post('/shipments', endpoint((req) => aftersales.createShipment(req.body, req.user), 201));
router.patch('/shipments/:id', endpoint((req) => aftersales.updateShipment(req.params.id, req.body, req.user)));
router.get('/audit', authorizeAdmin, endpoint((req) => {
    const conditions = [], values = [];
    c.search(req.query, ['t.actor_name', 't.action', 't.summary', 't.entity_id'], conditions, values);
    c.range(req.query, 't.created_at', conditions, values);
    if (req.query.entity_type) { conditions.push('t.entity_type = ?'); values.push(c.text(req.query.entity_type, 'Đối tượng', 50)); }
    return c.list('t.*', 'FROM audit_logs t', conditions, values, req.query).then((result) => ({ ...result, items: result.items.map((r) => ({ ...r, changes: c.parse(r.changes) })) }));
}));
router.post('/bulk/preview', authorizeAdmin, endpoint((req) => bulk.previewRows(req.body.rows)));
router.post('/bulk/apply', authorizeAdmin, endpoint((req) => bulk.applyRows(req.body, req.user)));
router.get('/bulk/products.csv', authorizeAdmin, async (req, res) => {
    try { res.set('Content-Disposition', 'attachment; filename="products.csv"').type('text/csv; charset=utf-8').send(await bulk.exportProducts()); }
    catch (err) { sendError(res, err); }
});

module.exports = router;
