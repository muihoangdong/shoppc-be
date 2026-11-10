'use strict';

const c = require('./operationsCommon');
const { fail, text, id, rows, one, code, transaction, list, search, range, ledger } = c;
const { serialNumbers } = require('./operationsInventory');

const WARRANTY_NEXT = { received: ['diagnosing', 'rejected'], diagnosing: ['repairing', 'resolved', 'rejected'], repairing: ['resolved', 'rejected'], resolved: [], rejected: [] };

async function serials(q) {
    const cond = [], values = [];
    search(q, ['t.serial_number', 'p.name', 'o.order_code'], cond, values);
    if (q.product_id) { cond.push('t.product_id = ?'); values.push(id(q.product_id)); }
    if (q.order_item_id) { cond.push('t.order_item_id = ?'); values.push(id(q.order_item_id)); }
    if (q.status) { cond.push('t.status = ?'); values.push(text(q.status, 'Trạng thái', 30)); }
    return list('t.*, p.name AS product_name, p.sku, o.order_code, o.customer_name',
        'FROM product_serials t JOIN products p ON p.id = t.product_id LEFT JOIN order_items oi ON oi.id = t.order_item_id LEFT JOIN orders o ON o.id = oi.order_id', cond, values, q);
}

async function registerSerials(b, actor) {
    const productId = id(b.product_id);
    const numbers = serialNumbers(b.serial_numbers);
    if (!numbers.length) fail('Hãy nhập ít nhất một serial');
    return transaction(actor, 'serial.register', 'product', async (client) => {
        const p = await one(client, 'SELECT * FROM products WHERE id = ? FOR UPDATE', [productId], 'Sản phẩm');
        const [count] = await rows(client, "SELECT COUNT(*) AS total FROM product_serials WHERE product_id = ? AND status = 'in_stock'", [p.id]);
        if (Number(count.total) + numbers.length > Number(p.stock)) fail('Số serial trong kho vượt tồn khả dụng. Hãy nhập kho trước hoặc kiểm tra đơn đang giữ hàng.');
        for (const serial of numbers) await client.query('INSERT INTO product_serials (product_id, serial_number) VALUES (?, ?)', [p.id, serial]);
        return { id: p.id, summary: `Đăng ký ${numbers.length} serial cho hàng đang có; không cộng tồn lần nữa`, changes: { serial_numbers: numbers } };
    });
}

async function assignSerial(serialId, b, actor) {
    const itemId = id(b.order_item_id);
    return transaction(actor, 'serial.assign', 'serial', async (client) => {
        const item = await one(client, 'SELECT * FROM order_items WHERE id = ?', [itemId], 'Dòng đơn hàng');
        const order = await one(client, 'SELECT * FROM orders WHERE id = ? FOR UPDATE', [item.order_id], 'Đơn hàng');
        if (!['processing', 'shipped', 'delivered', 'completed'].includes(order.status)) fail('Chỉ gán serial cho đơn đang xử lý, đang giao hoặc đã giao');
        await one(client, 'SELECT id FROM order_items WHERE id = ? FOR UPDATE', [itemId]);
        const p = await one(client, 'SELECT * FROM products WHERE id = ? FOR UPDATE', [item.product_id], 'Sản phẩm');
        const serial = await one(client, 'SELECT * FROM product_serials WHERE id = ? FOR UPDATE', [id(serialId)], 'Serial');
        if (serial.product_id !== item.product_id || serial.status !== 'in_stock') fail('Serial không thuộc sản phẩm hoặc không còn trong kho', 409);
        const [count] = await rows(client, "SELECT COUNT(*) AS total FROM product_serials WHERE order_item_id = ? AND status IN ('sold','repair')", [itemId]);
        const [returned] = await rows(client, "SELECT COALESCE(SUM(quantity),0) AS total FROM return_requests WHERE order_item_id = ? AND status IN ('received','refunded','closed')", [itemId]);
        if (Number(count.total) >= Number(item.quantity) - Number(returned.total)) fail('Dòng đơn hàng đã được gán đủ serial hoặc hàng đã được trả', 409);
        await client.query("UPDATE product_serials SET order_item_id = ?, status = 'sold', sold_at = NOW(), warranty_expires_at = DATE_ADD(NOW(), INTERVAL ? MONTH) WHERE id = ?", [itemId, Number(p.warranty_months), serial.id]);
        return { id: serial.id, summary: `Gán ${serial.serial_number} vào ${order.order_code}`, changes: { order_item_id: itemId, warranty_months: p.warranty_months }, orderId: order.id };
    });
}

async function retireSerial(serialId, b, actor) {
    const reason = text(b.reason, 'Lý do thu hồi', 500, true);
    return transaction(actor, 'serial.retire', 'serial', async (client) => {
        const existing = await one(client, 'SELECT product_id FROM product_serials WHERE id = ?', [id(serialId)], 'Serial');
        const p = await one(client, 'SELECT * FROM products WHERE id = ? FOR UPDATE', [existing.product_id]);
        const serial = await one(client, 'SELECT * FROM product_serials WHERE id = ? FOR UPDATE', [id(serialId)]);
        if (serial.status !== 'in_stock') fail('Chỉ thu hồi serial đang trong kho', 409);
        if (Number(p.stock) < 1) fail('Không thể thu hồi: hàng đang được đơn mua giữ tồn');
        await client.query('UPDATE products SET stock = stock - 1 WHERE id = ?', [p.id]);
        await client.query("UPDATE product_serials SET status = 'retired' WHERE id = ?", [serial.id]);
        await ledger.movement(client, p.id, -1, 'adjustment', 'serial', serial.id, actor.id, reason);
        return { id: serial.id, summary: `Thu hồi ${serial.serial_number}: ${reason}`, productIds: [p.id] };
    });
}

async function warranties(q) {
    const cond = [], values = [];
    search(q, ['t.ticket_code', 's.serial_number', 'p.name', 't.customer_name', 't.phone'], cond, values);
    range(q, 't.created_at', cond, values);
    if (q.status) { cond.push('t.status = ?'); values.push(text(q.status, 'Trạng thái', 30)); }
    return list('t.*, s.serial_number, s.warranty_expires_at, p.name AS product_name',
        'FROM warranty_tickets t JOIN product_serials s ON s.id = t.serial_id JOIN products p ON p.id = s.product_id', cond, values, q);
}

async function createWarranty(b, actor) {
    const serialId = id(b.serial_id), issue = text(b.issue, 'Mô tả lỗi', 3000, true);
    return transaction(actor, 'warranty.create', 'warranty', async (client) => {
        const serial = await one(client, 'SELECT * FROM product_serials WHERE id = ? FOR UPDATE', [serialId], 'Serial');
        if (serial.status !== 'sold' || !serial.order_item_id) fail('Chỉ tiếp nhận bảo hành cho serial đã bán và gắn vào đơn hàng');
        const item = await one(client, 'SELECT o.* FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.id = ?', [serial.order_item_id]);
        if (!['delivered', 'completed'].includes(item.status)) fail('Đơn bán phải đã giao hoặc hoàn tất trước khi tiếp nhận bảo hành');
        const covered = !!serial.warranty_expires_at && new Date(serial.warranty_expires_at).getTime() >= Date.now();
        const [result] = await client.query('INSERT INTO warranty_tickets (ticket_code, serial_id, customer_name, phone, issue, covered_by_warranty, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [code('BH'), serial.id, text(b.customer_name || item.customer_name, 'Khách hàng', 150, true), text(b.phone || item.customer_phone, 'Điện thoại', 30), issue, covered, actor.id]);
        await client.query("UPDATE product_serials SET status = 'repair' WHERE id = ?", [serial.id]);
        return { id: result.insertId, summary: `Tiếp nhận bảo hành ${serial.serial_number}${covered ? '' : ' (ngoài hạn)'}`, changes: { serial_id: serial.id, covered_by_warranty: covered } };
    });
}

async function updateWarranty(ticketId, b, actor) {
    const status = text(b.status, 'Trạng thái', 30, true);
    const resolution = text(b.resolution, 'Kết quả xử lý', 3000, ['resolved', 'rejected'].includes(status));
    return transaction(actor, 'warranty.status', 'warranty', async (client) => {
        const existing = await one(client, 'SELECT serial_id FROM warranty_tickets WHERE id = ?', [id(ticketId)], 'Phiếu bảo hành');
        await one(client, 'SELECT id FROM product_serials WHERE id = ? FOR UPDATE', [existing.serial_id]);
        const ticket = await one(client, 'SELECT * FROM warranty_tickets WHERE id = ? FOR UPDATE', [id(ticketId)]);
        if (!WARRANTY_NEXT[ticket.status]?.includes(status)) fail('Không thể chuyển sang trạng thái bảo hành này', 409);
        const finished = ['resolved', 'rejected'].includes(status);
        await client.query(`UPDATE warranty_tickets SET status = ?, resolution = ?, completed_at = ${finished ? 'NOW()' : 'NULL'} WHERE id = ?`, [status, resolution, ticket.id]);
        if (finished) await client.query("UPDATE product_serials SET status = 'sold' WHERE id = ? AND status = 'repair'", [ticket.serial_id]);
        return { id: ticket.id, summary: `Bảo hành ${ticket.ticket_code}: ${ticket.status} → ${status}`, changes: { status, resolution } };
    });
}

module.exports = { WARRANTY_NEXT, serials, registerSerials, assignSerial, retireSerial, warranties, createWarranty, updateWarranty };
