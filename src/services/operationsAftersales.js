'use strict';

const c = require('./operationsCommon');
const { fail, text, int, id, bool, parse, rows, one, code, day, transaction, list, search, range, ledger } = c;

const SHIP_NEXT = { created: ['picked_up', 'cancelled'], picked_up: ['in_transit', 'delivered', 'failed'], in_transit: ['delivered', 'failed', 'returned'], failed: ['in_transit', 'delivered', 'returned'], delivered: [], returned: [], cancelled: [] };
const RETURN_NEXT = { requested: ['approved', 'rejected', 'cancelled'], approved: ['received', 'cancelled'], received: ['refunded', 'closed'], refunded: [], closed: [], rejected: [], cancelled: [] };

async function shipments(q) {
    const cond = [], values = [];
    search(q, ['t.tracking_number', 't.carrier', 'o.order_code', 'o.customer_name'], cond, values);
    range(q, 't.created_at', cond, values);
    if (q.status) { cond.push('t.status = ?'); values.push(text(q.status, 'Trạng thái', 30)); }
    const result = await list('t.*, o.order_code, o.customer_name, o.customer_phone, o.customer_address, o.customer_city, o.status AS order_status',
        'FROM shipping_tracking t JOIN orders o ON o.id = t.order_id', cond, values, q);
    result.items = result.items.map((s) => ({ ...s, tracking_data: parse(s.tracking_data, []) }));
    return result;
}

async function createShipment(b, actor) {
    const orderId = id(b.order_id), carrier = text(b.carrier, 'Đơn vị vận chuyển', 100, true), tracking = text(b.tracking_number, 'Mã vận đơn', 100, true);
    const expected = day(b.estimated_delivery);
    return transaction(actor, 'shipment.create', 'shipment', async (client) => {
        const order = await one(client, 'SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId], 'Đơn hàng');
        if (order.status !== 'processing') fail('Chỉ tạo vận đơn cho đơn đang xử lý');
        const existing = await rows(client, "SELECT id FROM shipping_tracking WHERE order_id = ? AND (status IS NULL OR status NOT IN ('cancelled','returned')) LIMIT 1", [orderId]);
        if (existing.length) fail('Đơn đã có vận đơn đang hoạt động', 409);
        const duplicated = await rows(client, 'SELECT id FROM shipping_tracking WHERE carrier = ? AND tracking_number = ? LIMIT 1', [carrier, tracking]);
        if (duplicated.length) fail('Mã vận đơn này đã được sử dụng', 409);
        const history = [{ status: 'created', at: new Date().toISOString(), note: text(b.note, 'Ghi chú', 500), by: actor.username }];
        const [result] = await client.query("INSERT INTO shipping_tracking (order_id, carrier, tracking_number, status, estimated_delivery, tracking_data) VALUES (?, ?, ?, 'created', ?, ?)",
            [order.id, carrier, tracking, expected ? `${expected} 23:59:59` : null, JSON.stringify(history)]);
        await client.query('UPDATE orders SET tracking_number = ? WHERE id = ?', [tracking, order.id]);
        return { id: result.insertId, summary: `Tạo vận đơn ${carrier} ${tracking} cho ${order.order_code}`, orderId: order.id };
    });
}

async function updateShipment(shipmentId, b, actor) {
    const status = text(b.status, 'Trạng thái', 30, true), note = text(b.note, 'Ghi chú', 500);
    return transaction(actor, 'shipment.status', 'shipment', async (client) => {
        const existing = await one(client, 'SELECT order_id FROM shipping_tracking WHERE id = ?', [id(shipmentId)], 'Vận đơn');
        const order = await one(client, 'SELECT * FROM orders WHERE id = ? FOR UPDATE', [existing.order_id]);
        const shipment = await one(client, 'SELECT * FROM shipping_tracking WHERE id = ? FOR UPDATE', [id(shipmentId)]);
        if (!SHIP_NEXT[shipment.status]?.includes(status)) fail('Không thể chuyển sang trạng thái vận chuyển này', 409);
        if (order.status === 'cancelled' && status !== 'cancelled') fail('Đơn hàng đã hủy', 409);
        if (status === 'picked_up') {
            if (order.status !== 'processing') fail('Đơn hàng phải đang xử lý để bàn giao');
            const missing = await rows(client, `SELECT oi.id, oi.product_name, oi.quantity,
                (SELECT COUNT(*) FROM product_serials ps WHERE ps.order_item_id = oi.id AND ps.status = 'sold') AS assigned
                FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ? AND p.serial_required = 1`, [order.id]);
            if (missing.some((i) => Number(i.assigned) !== Number(i.quantity))) fail('Cần gán đủ serial cho hàng theo serial trước khi bàn giao');
        }
        let orderStatus = order.status;
        if (status === 'picked_up') orderStatus = 'shipped';
        if (status === 'delivered') {
            if (order.status !== 'shipped') fail('Chỉ ghi giao thành công cho đơn đang giao');
            orderStatus = 'delivered';
        }
        if (orderStatus !== order.status) {
            await client.query(`UPDATE orders SET status = ?, payment_status = ${status === 'delivered' && order.payment_method === 'cod' ? "'paid'" : 'payment_status'} WHERE id = ?`, [orderStatus, order.id]);
            await client.query('INSERT INTO order_status_history (order_id, old_status, new_status, changed_by, note) VALUES (?, ?, ?, ?, ?)', [order.id, order.status, orderStatus, actor.id, note || `Vận chuyển: ${status}`]);
        }
        const history = parse(shipment.tracking_data, []);
        const events = Array.isArray(history) ? history : [];
        events.push({ status, at: new Date().toISOString(), note, by: actor.username });
        await client.query(`UPDATE shipping_tracking SET status = ?, location = ?, tracking_data = ?, actual_delivery = ${status === 'delivered' ? 'NOW()' : 'actual_delivery'} WHERE id = ?`,
            [status, text(b.location, 'Vị trí', 255), JSON.stringify(events), shipment.id]);
        return { id: shipment.id, summary: `Vận đơn ${shipment.tracking_number}: ${shipment.status} → ${status}`, changes: { status, note }, orderId: order.id };
    });
}

function refundableMaximum(order, item, quantity) {
    const ratio = Number(order.subtotal) > 0 ? Math.max(0, Math.min(1, (Number(order.subtotal) - Number(order.discount)) / Number(order.subtotal))) : 0;
    return Math.max(0, Math.floor(Number(item.price) * quantity * ratio));
}

async function returns(q) {
    const cond = [], values = [];
    search(q, ['t.return_code', 'o.order_code', 'o.customer_name', 'oi.product_name'], cond, values);
    range(q, 't.created_at', cond, values);
    if (q.status) { cond.push('t.status = ?'); values.push(text(q.status, 'Trạng thái', 30)); }
    const result = await list('t.*, o.order_code, o.customer_name, o.payment_status, oi.product_name, oi.product_id',
        'FROM return_requests t JOIN orders o ON o.id = t.order_id JOIN order_items oi ON oi.id = t.order_item_id', cond, values, q);
    result.items = result.items.map((r) => ({ ...r, serial_ids: parse(r.serial_ids, []) }));
    return result;
}

async function createReturn(b, actor) {
    const itemId = id(b.order_item_id), quantity = int(b.quantity, 'Số lượng trả', 1), reason = text(b.reason, 'Lý do trả', 3000, true);
    return transaction(actor, 'return.create', 'return', async (client) => {
        const item = await one(client, 'SELECT * FROM order_items WHERE id = ?', [itemId], 'Dòng đơn hàng');
        const order = await one(client, 'SELECT * FROM orders WHERE id = ? FOR UPDATE', [item.order_id], 'Đơn hàng');
        if (!['delivered', 'completed'].includes(order.status)) fail('Chỉ đổi trả đơn đã giao hoặc hoàn tất');
        const [used] = await rows(client, "SELECT COALESCE(SUM(quantity),0) AS quantity FROM return_requests WHERE order_item_id = ? AND status NOT IN ('rejected','cancelled')", [item.id]);
        if (Number(used.quantity) + quantity > Number(item.quantity)) fail('Số lượng trả vượt số lượng mua còn lại');
        const maximum = refundableMaximum(order, item, quantity);
        const refund = b.refund_amount === undefined ? maximum : int(b.refund_amount, 'Số tiền dự kiến hoàn', 0, 1e12);
        if (refund > maximum) fail(`Số tiền hoàn tối đa sau phân bổ giảm giá: ${maximum} VNĐ (chưa gồm phí ship)`);
        const [result] = await client.query('INSERT INTO return_requests (return_code, order_id, order_item_id, quantity, reason, refund_amount, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [code('DT'), order.id, item.id, quantity, reason, refund, actor.id]);
        return { id: result.insertId, summary: `Tạo đổi trả ${order.order_code}: ${quantity} × ${item.product_name}`, changes: { quantity, refund_amount: refund }, orderId: order.id };
    });
}

async function updateReturn(returnId, b, actor) {
    const status = text(b.status, 'Trạng thái', 30, true);
    if (['approved', 'rejected', 'refunded', 'closed'].includes(status) && actor.role !== 'admin') fail('Chỉ quản trị viên được duyệt hoặc ghi nhận hoàn tiền', 403);
    return transaction(actor, `return.${status}`, 'return', async (client) => {
        const existing = await one(client, 'SELECT order_id FROM return_requests WHERE id = ?', [id(returnId)], 'Phiếu đổi trả');
        const order = await one(client, 'SELECT * FROM orders WHERE id = ? FOR UPDATE', [existing.order_id]);
        const request = await one(client, 'SELECT * FROM return_requests WHERE id = ? FOR UPDATE', [id(returnId)]);
        if (!RETURN_NEXT[request.status]?.includes(status)) fail('Không thể chuyển trạng thái đổi trả này hoặc thao tác đã được thực hiện', 409);
        const item = await one(client, 'SELECT * FROM order_items WHERE id = ?', [request.order_item_id]);
        const note = text(b.note, 'Ghi chú', 2000, ['rejected', 'cancelled'].includes(status));
        let refund = Number(request.refund_amount);
        if (status === 'closed' && refund !== 0) fail('Chỉ đóng không hoàn tiền khi số tiền duyệt bằng 0');
        if (status === 'approved') {
            refund = b.refund_amount === undefined ? refund : int(b.refund_amount, 'Số tiền hoàn', 0, 1e12);
            if (refund > refundableMaximum(order, item, request.quantity)) fail('Tiền hoàn vượt giá trị hàng đã mua sau giảm giá');
        }
        const productIds = [];
        if (status === 'received') {
            const restock = b.restock === undefined ? false : bool(b.restock);
            const product = await one(client, 'SELECT * FROM products WHERE id = ? FOR UPDATE', [item.product_id], 'Sản phẩm');
            if (Number(product.stock) + (restock ? request.quantity : 0) > 1e7) fail('Tồn kho vượt giới hạn');
            const serialIds = b.serial_ids === undefined ? [] : b.serial_ids;
            if (!Array.isArray(serialIds) || serialIds.length > 1000 || new Set(serialIds.map(id)).size !== serialIds.length) fail('Danh sách serial trả không hợp lệ');
            if ((Number(product.serial_required) || serialIds.length) && serialIds.length !== request.quantity) fail('Cần chọn đúng số lượng serial trả');
            for (const sid of serialIds.map(id).sort((a, b) => a - b)) {
                const serial = await one(client, 'SELECT * FROM product_serials WHERE id = ? FOR UPDATE', [sid], 'Serial');
                if (Number(serial.order_item_id) !== Number(item.id) || serial.status !== 'sold') fail('Serial không thuộc dòng hàng trả hoặc đã được nhận trả', 409);
                await client.query(`UPDATE product_serials SET status = ?, order_item_id = ${restock ? 'NULL' : 'order_item_id'}, sold_at = ${restock ? 'NULL' : 'sold_at'}, warranty_expires_at = ${restock ? 'NULL' : 'warranty_expires_at'} WHERE id = ?`, [restock ? 'in_stock' : 'returned', serial.id]);
            }
            if (restock) {
                await client.query('UPDATE products SET stock = stock + ? WHERE id = ?', [request.quantity, product.id]);
                await ledger.movement(client, product.id, Number(request.quantity), 'return', 'return', request.id, actor.id, `Nhận hàng trả ${request.return_code}`);
                productIds.push(product.id);
            }
            await client.query('UPDATE return_requests SET restock = ?, serial_ids = ?, received_at = NOW() WHERE id = ?', [restock, JSON.stringify(serialIds), request.id]);
        }
        if (status === 'refunded') {
            if (order.payment_status !== 'paid') fail('Chỉ ghi nhận hoàn tiền cho đơn đã thanh toán');
            if (refund <= 0) fail('Phiếu này không có số tiền để hoàn');
            const reference = text(b.refund_reference, 'Mã giao dịch/biên nhận hoàn tiền', 150, true);
            const [paid] = await rows(client, "SELECT COALESCE(SUM(refund_amount),0) AS total FROM return_requests WHERE order_id = ? AND status = 'refunded'", [order.id]);
            if (Number(paid.total) + refund > Number(order.total_amount)) fail('Tổng tiền hoàn vượt tổng tiền đơn hàng');
            await client.query('UPDATE return_requests SET refund_reference = ?, refunded_at = NOW() WHERE id = ?', [reference, request.id]);
            if (Number(paid.total) + refund >= Number(order.total_amount)) await client.query("UPDATE orders SET payment_status = 'refunded' WHERE id = ?", [order.id]);
        }
        await client.query('UPDATE return_requests SET status = ?, refund_amount = ?, note = ? WHERE id = ?', [status, refund, note, request.id]);
        return { id: request.id, summary: `Đổi trả ${request.return_code}: ${request.status} → ${status}`, changes: { status, refund_amount: refund, note }, productIds, orderId: order.id };
    });
}

module.exports = { SHIP_NEXT, RETURN_NEXT, refundableMaximum, shipments, createShipment, updateShipment, returns, createReturn, updateReturn };
