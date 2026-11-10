'use strict';

const c = require('./operationsCommon');
const { db, fail, text, int, id, parse, rows, one, code, transaction, list, search, range, ledger } = c;

function serialNumbers(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > 1000) fail('Danh sách serial tối đa 1.000 số');
    const result = value.map((s) => text(s, 'Serial', 150, true).toUpperCase());
    if (result.some((s) => /[\x00-\x1f]/.test(s))) fail('Serial không được chứa ký tự điều khiển');
    if (new Set(result).size !== result.length) fail('Serial bị trùng trong danh sách');
    return result;
}

function receiptPayload(b) {
    const supplier_id = id(b.supplier_id);
    if (!Array.isArray(b.items) || !b.items.length || b.items.length > 100) fail('Phiếu nhập cần từ 1 đến 100 dòng');
    const items = b.items.map((i) => ({ product_id: id(i.product_id), quantity: int(i.quantity, 'Số lượng', 1, 10000), unit_cost: int(i.unit_cost, 'Giá nhập', 0, 1e12), serial_numbers: serialNumbers(i.serial_numbers) }));
    if (new Set(items.map((i) => i.product_id)).size !== items.length) fail('Một sản phẩm chỉ có một dòng trong phiếu nhập');
    const serials = items.flatMap((i) => i.serial_numbers);
    if (new Set(serials).size !== serials.length) fail('Serial bị trùng giữa các dòng');
    if (items.some((i) => i.serial_numbers.length && i.serial_numbers.length !== i.quantity)) fail('Số serial phải khớp số lượng nhập');
    if (items.reduce((sum, i) => sum + i.quantity * i.unit_cost, 0) > 1e12) fail('Tổng phiếu nhập vượt giới hạn 1.000 tỷ');
    return { supplier_id, note: text(b.note, 'Ghi chú', 2000), items };
}

async function receipts(q) {
    const cond = [], values = [];
    search(q, ['t.receipt_code', 's.name'], cond, values);
    range(q, 't.created_at', cond, values);
    if (q.status) { cond.push('t.status = ?'); values.push(text(q.status, 'Trạng thái', 30)); }
    return list('t.*, s.name AS supplier_name, (SELECT COALESCE(SUM(i.quantity * i.unit_cost),0) FROM purchase_receipt_items i WHERE i.receipt_id = t.id) AS total',
        'FROM purchase_receipts t JOIN suppliers s ON s.id = t.supplier_id', cond, values, q);
}

async function receiptDetail(receiptId) {
    const receipt = (await db.query('SELECT r.*, s.name AS supplier_name FROM purchase_receipts r JOIN suppliers s ON s.id = r.supplier_id WHERE r.id = ?', [id(receiptId)]))[0];
    if (!receipt) fail('Không tìm thấy phiếu nhập', 404);
    receipt.items = (await db.query('SELECT i.*, p.name AS product_name FROM purchase_receipt_items i JOIN products p ON p.id = i.product_id WHERE i.receipt_id = ? ORDER BY i.id', [receipt.id]))
        .map((i) => ({ ...i, serial_numbers: parse(i.serial_numbers, []) }));
    return receipt;
}

async function saveReceipt(receiptId, b, actor) {
    const data = receiptPayload(b);
    return transaction(actor, receiptId ? 'receipt.update' : 'receipt.create', 'receipt', async (client) => {
        if (receiptId) {
            const old = await one(client, 'SELECT * FROM purchase_receipts WHERE id = ? FOR UPDATE', [id(receiptId)], 'Phiếu nhập');
            if (old.status !== 'draft') fail('Chỉ sửa được phiếu nhập nháp', 409);
        }
        await one(client, 'SELECT id FROM suppliers WHERE id = ? AND is_active = 1', [data.supplier_id], 'Nhà cung cấp đang hoạt động');
        for (const item of data.items) await one(client, 'SELECT id FROM products WHERE id = ?', [item.product_id], 'Sản phẩm');
        let result;
        if (receiptId) {
            await client.query('UPDATE purchase_receipts SET supplier_id = ?, note = ? WHERE id = ?', [data.supplier_id, data.note, receiptId]);
            await client.query('DELETE FROM purchase_receipt_items WHERE receipt_id = ?', [receiptId]);
        } else {
            [result] = await client.query('INSERT INTO purchase_receipts (receipt_code, supplier_id, note, created_by) VALUES (?, ?, ?, ?)', [code('PN'), data.supplier_id, data.note, actor.id]);
            receiptId = result.insertId;
        }
        for (const item of data.items) await client.query('INSERT INTO purchase_receipt_items (receipt_id, product_id, quantity, unit_cost, serial_numbers) VALUES (?, ?, ?, ?, ?)',
            [receiptId, item.product_id, item.quantity, item.unit_cost, JSON.stringify(item.serial_numbers)]);
        return { id: receiptId, summary: 'Lưu phiếu nhập nháp', changes: data };
    });
}

async function receiveReceipt(receiptId, actor) {
    return transaction(actor, 'receipt.receive', 'receipt', async (client) => {
        const receipt = await one(client, 'SELECT * FROM purchase_receipts WHERE id = ? FOR UPDATE', [id(receiptId)], 'Phiếu nhập');
        if (receipt.status !== 'draft') fail('Phiếu này đã nhập kho hoặc đã hủy; không thể nhập lại', 409);
        const items = await rows(client, 'SELECT * FROM purchase_receipt_items WHERE receipt_id = ? ORDER BY product_id', [receipt.id]);
        if (!items.length) fail('Phiếu nhập trống');
        for (const item of items) {
            const p = await one(client, 'SELECT * FROM products WHERE id = ? FOR UPDATE', [item.product_id], 'Sản phẩm');
            const serials = serialNumbers(parse(item.serial_numbers, []));
            if (Number(p.serial_required) && serials.length !== item.quantity) fail(`${p.name}: cần đúng ${item.quantity} serial`);
            if (Number(p.stock) + Number(item.quantity) > 1e7) fail('Tồn kho vượt giới hạn');
            await client.query('UPDATE products SET stock = stock + ? WHERE id = ?', [item.quantity, p.id]);
            await ledger.movement(client, p.id, Number(item.quantity), 'receipt', 'receipt', receipt.id, actor.id, `Nhập ${receipt.receipt_code}`);
            for (const serial of serials) await client.query('INSERT INTO product_serials (product_id, serial_number, receipt_id) VALUES (?, ?, ?)', [p.id, serial, receipt.id]);
        }
        await client.query("UPDATE purchase_receipts SET status = 'received', received_at = NOW() WHERE id = ?", [receipt.id]);
        return { id: receipt.id, summary: `Xác nhận nhập kho ${receipt.receipt_code}`, changes: { items }, productIds: items.map((i) => i.product_id) };
    });
}

async function cancelReceipt(receiptId, actor) {
    return transaction(actor, 'receipt.cancel', 'receipt', async (client) => {
        const receipt = await one(client, 'SELECT * FROM purchase_receipts WHERE id = ? FOR UPDATE', [id(receiptId)], 'Phiếu nhập');
        if (receipt.status !== 'draft') fail('Chỉ hủy được phiếu nhập nháp', 409);
        await client.query("UPDATE purchase_receipts SET status = 'cancelled' WHERE id = ?", [receipt.id]);
        return { id: receipt.id, summary: `Hủy phiếu nháp ${receipt.receipt_code}` };
    });
}

async function movements(q) {
    const cond = [], values = [];
    search(q, ['p.name', 'p.sku', 't.reason', 't.reference_id'], cond, values);
    range(q, 't.created_at', cond, values);
    if (q.product_id) { cond.push('t.product_id = ?'); values.push(id(q.product_id)); }
    if (q.kind) { cond.push('t.kind = ?'); values.push(text(q.kind, 'Loại', 30)); }
    return list('t.*, p.name AS product_name, p.sku, u.full_name AS actor_name',
        'FROM inventory_movements t JOIN products p ON p.id = t.product_id LEFT JOIN users u ON u.id = t.actor_id', cond, values, q);
}

async function adjustStock(productId, value, actor, reason, deltaMode = false) {
    const amount = int(value, 'Tồn kho', deltaMode ? -1e7 : 0, 1e7);
    const note = text(reason, 'Lý do điều chỉnh', 500, true);
    return transaction(actor, 'stock.adjust', 'product', async (client) => {
        const p = await one(client, 'SELECT * FROM products WHERE id = ? FOR UPDATE', [id(productId)], 'Sản phẩm');
        const target = deltaMode ? Number(p.stock) + amount : amount;
        if (target < 0 || target > 1e7) fail('Tồn kho sau điều chỉnh phải nằm trong 0 đến 10 triệu');
        if (target !== Number(p.stock)) {
            const [tracked] = await rows(client, 'SELECT COUNT(*) AS total FROM product_serials WHERE product_id = ?', [p.id]);
            if (Number(p.serial_required) || Number(tracked.total)) fail('Sản phẩm theo serial: dùng phiếu nhập hoặc thu hồi serial để điều chỉnh tồn');
        }
        await client.query('UPDATE products SET stock = ? WHERE id = ?', [target, p.id]);
        await ledger.movement(client, p.id, target - Number(p.stock), 'adjustment', 'product', p.id, actor?.id, note);
        return { id: p.id, summary: note, changes: { before_stock: p.stock, after_stock: target }, productIds: [p.id] };
    });
}

module.exports = { serialNumbers, receiptPayload, receipts, receiptDetail, saveReceipt, receiveReceipt, cancelReceipt, movements, adjustStock };
