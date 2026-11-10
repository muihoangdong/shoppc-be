'use strict';

const db = require('../config/database');
let ready = false;

async function initialize() {
    const rows = await db.query("SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('inventory_movements','audit_logs','product_serials','purchase_receipts','purchase_receipt_items','suppliers','brands','spec_templates','warranty_tickets','return_requests')");
    ready = Number(rows[0]?.count) === 10;
    if (!ready) console.warn('[operations] Chưa đủ bảng nghiệp vụ: chạy npm run migrate-db -- --apply và khởi động lại backend.');
    return ready;
}

async function audit(client, actor, action, entity, id, summary, changes = null) {
    await client.query('INSERT INTO audit_logs (actor_id, actor_name, action, entity_type, entity_id, summary, changes) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [actor?.id || null, actor?.username || actor?.full_name || 'Hệ thống', action, entity, id == null ? null : String(id), summary.slice(0, 500), changes == null ? null : JSON.stringify(changes)]);
}

async function movement(client, productId, delta, kind, referenceType, referenceId, actorId, reason) {
    if (!delta) return;
    await client.query(`INSERT INTO inventory_movements (product_id, kind, quantity, before_stock, after_stock, reference_type, reference_id, actor_id, reason)
        SELECT id, ?, ?, stock - ?, stock, ?, ?, ?, ? FROM products WHERE id = ?`,
    [kind, delta, delta, referenceType || null, referenceId == null ? null : String(referenceId), actorId || null, reason || null, productId]);
}

async function orderMovement(client, productId, delta, kind, orderId, actorId) {
    if (ready) await movement(client, productId, delta, kind, 'order', orderId, actorId, kind === 'sale' ? 'Giữ/trừ tồn khi đặt hàng' : 'Hoàn tồn khi hủy đơn');
}

async function cancelSerials(client, orderId) {
    if (!ready) return;
    await client.query(`UPDATE product_serials s JOIN order_items oi ON s.order_item_id = oi.id
        SET s.status = 'in_stock', s.order_item_id = NULL, s.sold_at = NULL, s.warranty_expires_at = NULL
        WHERE oi.order_id = ? AND s.status = 'sold'`, [orderId]);
}

async function orderStatus(client, orderId, status, actorId) {
    if (!ready) return;
    if (status === 'shipped') {
        const [items] = await client.query(`SELECT oi.id, oi.quantity, (SELECT COUNT(*) FROM product_serials s WHERE s.order_item_id = oi.id AND s.status = 'sold') AS assigned
            FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ? AND p.serial_required = 1`, [orderId]);
        if (items.some((i) => Number(i.quantity) !== Number(i.assigned))) {
            const { ValidationError } = require('../utils/http');
            throw new ValidationError('Cần gán đủ serial trước khi chuyển đơn sang đang giao');
        }
    }
    const mapped = { shipped: 'in_transit', delivered: 'delivered', cancelled: 'cancelled' }[status];
    if (mapped) {
        const [shipments] = await client.query("SELECT * FROM shipping_tracking WHERE order_id = ? AND (status IS NULL OR status NOT IN ('delivered','returned','cancelled')) FOR UPDATE", [orderId]);
        for (const shipment of shipments) {
            let history = shipment.tracking_data;
            if (typeof history === 'string') { try { history = JSON.parse(history); } catch { history = []; } }
            if (!Array.isArray(history)) history = [];
            history.push({ status: mapped, at: new Date().toISOString(), note: 'Đồng bộ từ xử lý đơn hàng', by: actorId });
            await client.query(`UPDATE shipping_tracking SET status = ?, tracking_data = ?, actual_delivery = ${mapped === 'delivered' ? 'NOW()' : 'actual_delivery'} WHERE id = ?`, [mapped, JSON.stringify(history), shipment.id]);
        }
    }
}

function middleware(req, res, next) {
    res.on('finish', () => {
        if (!ready || !['admin', 'staff'].includes(req.user?.role) || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || res.statusCode >= 400 || req.originalUrl.startsWith('/api/operations')) return;
        // Never record request bodies, passwords, tokens, payment details, chat text or upload bytes.
        const resource = req.originalUrl.split('?')[0].replace(/^\/api\//, '');
        const parts = resource.split('/');
        if (['auth', 'realtime', 'chatbot'].includes(parts[0])) return;
        void audit(db.pool, req.user, `${req.method} ${parts[0]}`, parts[0], /^\d+$/.test(parts[1] || '') ? parts[1] : null,
            `${req.method} /api/${resource} (${res.statusCode})`).catch((err) => console.error('[audit] Không ghi được nhật ký:', err.message));
    });
    next();
}

module.exports = { initialize, isReady: () => ready, audit, movement, orderMovement, cancelSerials, orderStatus, middleware };
