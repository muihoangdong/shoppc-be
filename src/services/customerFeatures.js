'use strict';

const { db, id, text, fail, parse } = require('./operationsCommon');
const Product = require('../models/Product');
const mailer = require('./mailer');
const Aftersales = require('./operationsAftersales');

async function state(user) {
    const [wishlist, alerts, users] = await Promise.all([
        db.query('SELECT product_id FROM wishlists WHERE user_id = ?', [user.id]),
        db.query("SELECT product_id FROM stock_alerts WHERE user_id = ? AND status = 'pending'", [user.id]),
        db.query('SELECT email FROM users WHERE id = ?', [user.id])
    ]);
    return { wishlist: wishlist.map((r) => r.product_id), alerts: alerts.map((r) => r.product_id), email: users[0]?.email || '', mail_available: mailer.isConfigured() };
}

async function wishlist(user) {
    return (await db.query(`SELECT p.*, c.name AS category_name, c.type AS category_type, b.name AS brand_name
        FROM wishlists w JOIN products p ON p.id = w.product_id LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN brands b ON b.id = p.brand_id WHERE w.user_id = ? ORDER BY w.created_at DESC`, [user.id])).map(Product.normalizeProduct);
}

async function setWishlist(user, productId, enabled) {
    const pid = id(productId);
    if (enabled) {
        const product = await Product.getProductById(pid);
        if (!product) fail('Sản phẩm không tồn tại', 404);
        await db.query('INSERT IGNORE INTO wishlists (user_id, product_id) VALUES (?, ?)', [user.id, pid]);
    } else await db.query('DELETE FROM wishlists WHERE user_id = ? AND product_id = ?', [user.id, pid]);
    return { product_id: pid, enabled };
}

async function setAlert(user, productId, enabled) {
    const pid = id(productId);
    if (!enabled) {
        await db.query("UPDATE stock_alerts SET status = 'cancelled' WHERE user_id = ? AND product_id = ?", [user.id, pid]);
        return { product_id: pid, enabled: false };
    }
    if (!mailer.isConfigured()) fail('Cửa hàng chưa cấu hình gửi email báo hàng về. Vui lòng thử lại sau.', 503);
    const client = await db.getClient();
    try {
        await client.beginTransaction();
        const [products] = await client.query('SELECT id, stock FROM products WHERE id = ? FOR UPDATE', [pid]);
        if (!products[0]) fail('Sản phẩm không tồn tại', 404);
        if (Number(products[0].stock) > 0) fail('Sản phẩm hiện đang còn hàng', 409);
        await client.query(`INSERT INTO stock_alerts (user_id, product_id) VALUES (?, ?)
            ON DUPLICATE KEY UPDATE status = 'pending', attempts = 0, next_attempt_at = NULL, notified_at = NULL`, [user.id, pid]);
        await client.commit();
    } catch (err) { await client.rollback(); throw err; }
    finally { client.release(); }
    return { product_id: pid, enabled: true };
}

async function alerts(user) {
    return db.query(`SELECT a.product_id, a.status, a.created_at, a.notified_at, p.name, p.image_url, p.stock
        FROM stock_alerts a JOIN products p ON p.id = a.product_id WHERE a.user_id = ? AND a.status <> 'cancelled'
        ORDER BY a.updated_at DESC`, [user.id]);
}

async function warranties(user, query) {
    const search = text(query.search, 'Serial hoặc mã đơn', 150);
    const serials = await db.query(`SELECT s.id, s.serial_number, s.status, s.sold_at, s.warranty_expires_at,
        p.name AS product_name, p.image_url, o.order_code
        FROM product_serials s JOIN order_items oi ON oi.id = s.order_item_id JOIN orders o ON o.id = oi.order_id
        JOIN products p ON p.id = s.product_id WHERE o.user_id = ?
        AND (s.serial_number LIKE ? OR o.order_code LIKE ?) ORDER BY s.id DESC LIMIT 100`, [user.id, `%${search}%`, `%${search}%`]);
    const tickets = serials.length ? await db.query(`SELECT t.id, t.ticket_code, t.serial_id, t.issue, t.status, t.covered_by_warranty, t.resolution, t.created_at, t.completed_at
        FROM warranty_tickets t JOIN order_items oi ON oi.id = t.order_item_id JOIN orders o ON o.id = oi.order_id
        JOIN product_serials s ON s.id = t.serial_id AND s.order_item_id = t.order_item_id
        WHERE o.user_id = ? AND t.serial_id IN (${serials.map(() => '?').join(',')}) ORDER BY t.id DESC`, [user.id, ...serials.map((s) => s.id)]) : [];
    return serials.map((s) => ({ ...s, tickets: tickets.filter((t) => t.serial_id === s.id) }));
}

async function returnItems(user, query) {
    const orderCode = text(query.order, 'Mã đơn', 30);
    const result = await db.query(`SELECT oi.id, oi.product_id, oi.product_name, oi.quantity, oi.price, o.order_code,
        (oi.quantity - (SELECT COALESCE(SUM(r.quantity),0) FROM return_requests r WHERE r.order_item_id = oi.id AND r.status NOT IN ('rejected','cancelled'))) AS available_quantity
        FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.user_id = ? AND o.status IN ('delivered','completed')
        ${orderCode ? 'AND o.order_code = ?' : ''} ORDER BY o.id DESC, oi.id DESC LIMIT 200`, [user.id, ...(orderCode ? [orderCode] : [])]);
    return result.filter((r) => Number(r.available_quantity) > 0);
}

async function returns(user) {
    return db.query(`SELECT r.id, r.return_code, r.order_item_id, r.quantity, r.reason, r.status, r.refund_amount, r.restock,
        r.created_at, r.received_at, r.refunded_at, oi.product_name, o.order_code
        FROM return_requests r JOIN orders o ON o.id = r.order_id JOIN order_items oi ON oi.id = r.order_item_id
        WHERE o.user_id = ? ORDER BY r.id DESC LIMIT 200`, [user.id]);
}

async function createReturn(user, body) {
    // Whitelist payload and force customer ownership even if a staff account visits the storefront.
    return Aftersales.createReturn({ order_item_id: body.order_item_id, quantity: body.quantity, reason: body.reason }, { ...user, role: 'customer' });
}

async function cancelReturn(user, requestId) {
    const client = await db.getClient();
    try {
        await client.beginTransaction();
        const [requests] = await client.query('SELECT order_id FROM return_requests WHERE id = ?', [id(requestId)]);
        if (!requests[0]) fail('Không tìm thấy yêu cầu', 404);
        const [orders] = await client.query('SELECT user_id FROM orders WHERE id = ? FOR UPDATE', [requests[0].order_id]);
        if (Number(orders[0]?.user_id) !== Number(user.id)) fail('Không tìm thấy yêu cầu', 404);
        const [requestsLocked] = await client.query('SELECT * FROM return_requests WHERE id = ? FOR UPDATE', [id(requestId)]);
        if (requestsLocked[0].status !== 'requested') fail('Chỉ hủy được yêu cầu đang chờ duyệt', 409);
        await client.query("UPDATE return_requests SET status = 'cancelled' WHERE id = ?", [id(requestId)]);
        await require('./operationsLedger').audit(client, user, 'return.cancelled', 'return', requestId, 'Khách hủy yêu cầu đổi trả');
        await client.commit();
        return { id: Number(requestId) };
    } catch (err) { await client.rollback(); throw err; }
    finally { client.release(); }
}

async function specFields() {
    return (await db.query('SELECT id, name, category_id, fields FROM spec_templates ORDER BY id')).map((t) => ({ ...t, fields: parse(t.fields, []) }));
}

module.exports = { state, wishlist, setWishlist, alerts, setAlert, warranties, returnItems, returns, createReturn, cancelReturn, specFields };
