'use strict';

const { createHash } = require('crypto');
const c = require('./operationsCommon');
const { db, fail, text, int, id, bool, parse, rows, one, transaction, ledger } = c;
const { validateProductMetadata } = require('./operationsCatalog');
const { parseProductImages } = require('../config/productImages');

const HEADERS = ['id', 'sku', 'name', 'category_id', 'brand_id', 'spec_template_id', 'price', 'stock', 'warranty_months', 'serial_required', 'description', 'image_url', 'image_urls', 'specs'];
const readJson = (v, label) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { fail(`${label} phải là JSON hợp lệ`); } };

function normalizeRow(b) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) fail('Dòng dữ liệu không hợp lệ');
    const sku = text(b.sku, 'SKU', 100, true).toUpperCase();
    if (!/^[A-Z0-9._-]+$/.test(sku)) fail('SKU chỉ gồm chữ, số, dấu chấm, gạch ngang và gạch dưới');
    const specs = b.specs ? readJson(b.specs, 'Thông số') : {};
    if (!specs || typeof specs !== 'object' || Array.isArray(specs) || JSON.stringify(specs).length > 10000) fail('Thông số không hợp lệ hoặc quá lớn');
    if (Object.entries(specs).some(([k, v]) => k.length > 100 || !['string', 'number'].includes(typeof v) || String(v).length > 500)) fail('Mỗi thông số cần tên ≤100 và giá trị ≤500 ký tự');
    const image = text(b.image_url, 'Link ảnh', 500);
    if (image && !/^(https?:\/\/|\/(?!\/))/i.test(image)) fail('Link ảnh không hợp lệ');
    const images = b.image_urls ? parseProductImages(readJson(b.image_urls, 'Thư viện ảnh'), fail) : undefined;
    return {
        id: b.id ? id(b.id) : null, sku, name: text(b.name, 'Tên sản phẩm', 255, true), category_id: id(b.category_id),
        brand_id: b.brand_id ? id(b.brand_id) : null, spec_template_id: b.spec_template_id ? id(b.spec_template_id) : null,
        price: int(b.price, 'Giá', 0, 1e12), stock: int(b.stock, 'Tồn kho', 0),
        warranty_months: b.warranty_months === undefined || b.warranty_months === '' ? 12 : int(b.warranty_months, 'Tháng bảo hành', 0, 120),
        serial_required: b.serial_required === undefined || b.serial_required === '' ? false : bool(b.serial_required),
        description: text(b.description, 'Mô tả', 5000), image_url: images === undefined ? image : images[0] || '',
        ...(images === undefined ? {} : { image_urls: images }), specs
    };
}

async function previewRows(input, client = db.pool, lock = false) {
    if (!Array.isArray(input) || !input.length || input.length > 500) fail('Mỗi lần nhập từ 1 đến 500 sản phẩm');
    const items = [], seenSku = new Set(), seenIds = new Set();
    // Lock imports in deterministic SKU order while preserving user row order in the result.
    const ordered = input.map((data, index) => ({ data, index })).sort((a, b) => String(a.data?.sku).localeCompare(String(b.data?.sku)));
    for (const { data, index } of ordered) {
        try {
            const p = normalizeRow(data);
            if (seenSku.has(p.sku) || p.id && seenIds.has(p.id)) fail('SKU hoặc ID bị trùng trong file');
            seenSku.add(p.sku); if (p.id) seenIds.add(p.id);
            const existing = p.id
                ? (await rows(client, `SELECT * FROM products WHERE id = ?${lock ? ' FOR UPDATE' : ''}`, [p.id]))[0]
                : (await rows(client, `SELECT * FROM products WHERE sku = ?${lock ? ' FOR UPDATE' : ''}`, [p.sku]))[0];
            if (p.id && !existing) fail('ID sản phẩm không tồn tại');
            const duplicate = await rows(client, 'SELECT id FROM products WHERE sku = ? AND id <> ? LIMIT 1', [p.sku, existing?.id || 0]);
            if (duplicate.length) fail('SKU thuộc về một sản phẩm khác');
            await one(client, 'SELECT id FROM categories WHERE id = ?', [p.category_id], 'Danh mục');
            await validateProductMetadata(client, p);
            if ((Number(existing?.serial_required) || p.serial_required) && Number(existing?.stock || 0) !== p.stock) fail('Hàng theo serial: tồn kho chỉ thay đổi qua phiếu nhập hoặc thu hồi serial');
            if (existing) {
                const [count] = await rows(client, 'SELECT COUNT(*) AS total FROM product_serials WHERE product_id = ?', [existing.id]);
                if (Number(count.total) && Number(existing.stock) !== p.stock) fail('Sản phẩm đã có serial: tồn kho chỉ thay đổi qua phiếu nhập hoặc thu hồi serial');
                if (Number(count.total) && Number(existing.serial_required) !== Number(p.serial_required)) fail('Không đổi chế độ serial của sản phẩm đã có serial');
            }
            items.push({ row: index + 2, action: existing ? 'update' : 'create', data: { ...p, id: existing?.id || null }, version: existing ? createHash('sha256').update(JSON.stringify(existing)).digest('hex') : null, before_stock: Number(existing?.stock || 0), error: '' });
        } catch (err) {
            if (!err.expose) throw err;
            items.push({ row: index + 2, action: 'error', data: null, error: err.message });
        }
    }
    items.sort((a, b) => a.row - b.row);
    const fingerprint = createHash('sha256').update(JSON.stringify(items)).digest('hex');
    return { items, fingerprint, valid: items.every((i) => !i.error), creates: items.filter((i) => i.action === 'create').length, updates: items.filter((i) => i.action === 'update').length };
}

async function applyRows(b, actor) {
    const reason = text(b.reason, 'Lý do nhập dữ liệu', 500, true);
    return transaction(actor, 'bulk.products', 'product', async (client) => {
        const preview = await previewRows(b.rows, client, true);
        if (!preview.valid) fail('File có dòng không hợp lệ. Hãy xem trước và sửa lỗi trước khi nhập');
        if (typeof b.fingerprint !== 'string' || b.fingerprint !== preview.fingerprint) fail('Dữ liệu sản phẩm đã thay đổi sau lần xem trước. Vui lòng xem trước lại.', 409);
        const ids = [];
        for (const item of preview.items) {
            const { id: productId, ...data } = item.data;
            const values = { ...data, specs: JSON.stringify(data.specs), ...(data.image_urls === undefined ? {} : { image_urls: JSON.stringify(data.image_urls) }) };
            const keys = Object.keys(values);
            let pid = productId;
            if (pid) await client.query(`UPDATE products SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...Object.values(values), pid]);
            else {
                const extras = keys.filter((k) => !['name', 'category_id'].includes(k));
                const [r] = await client.query(`INSERT INTO products (name, category_id, ${extras.join(', ')}) VALUES (?, ?, ${extras.map(() => '?').join(', ')})`, [values.name, values.category_id, ...extras.map((k) => values[k])]);
                pid = r.insertId;
            }
            await ledger.movement(client, pid, data.stock - item.before_stock, 'import', 'bulk', null, actor.id, reason);
            ids.push(pid);
        }
        return { id: null, summary: `Nhập CSV: ${preview.creates} mới, ${preview.updates} cập nhật`, changes: { product_ids: ids, reason }, productIds: ids };
    });
}

const csvCell = (value) => {
    let s = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
};

async function exportProducts() {
    const products = await db.query('SELECT * FROM products ORDER BY id LIMIT 10001');
    if (products.length > 10000) fail('Có hơn 10.000 sản phẩm; cần chia đợt xuất trước khi tiếp tục');
    return '\ufeff' + HEADERS.join(',') + '\r\n' + products.map((p) => HEADERS.map((h) => csvCell(['specs', 'image_urls'].includes(h) ? parse(p[h], h === 'specs' ? {} : []) : p[h])).join(',')).join('\r\n');
}

module.exports = { HEADERS, normalizeRow, previewRows, applyRows, csvCell, exportProducts };
