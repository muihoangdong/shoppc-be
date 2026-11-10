'use strict';

const c = require('./operationsCommon');
const { db, fail, text, int, id, bool, parse, one, transaction, list, search } = c;

function templateFields(value) {
    if (!Array.isArray(value) || !value.length || value.length > 40) fail('Mẫu thông số cần từ 1 đến 40 trường');
    const seen = new Set();
    return value.map((f) => {
        if (!f || typeof f !== 'object') fail('Trường thông số không hợp lệ');
        const key = text(f.key, 'Tên thông số', 100, true);
        if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('Tên thông số không được phép');
        if (seen.has(key.toLowerCase())) fail('Tên thông số bị trùng');
        seen.add(key.toLowerCase());
        const type = f.type || 'text';
        if (!['text', 'number', 'select'].includes(type)) fail('Kiểu thông số không hợp lệ');
        const options = type === 'select' ? (Array.isArray(f.options) ? [...new Set(f.options.map((o) => text(o, 'Lựa chọn', 100, true)))] : []) : [];
        if (type === 'select' && (!options.length || options.length > 50)) fail('Danh sách chọn cần từ 1 đến 50 lựa chọn');
        return { key, type, unit: text(f.unit, 'Đơn vị', 30), required: f.required === undefined ? false : bool(f.required), options };
    });
}

function validateSpecs(fields, specs) {
    if (!specs || typeof specs !== 'object' || Array.isArray(specs)) fail('Thông số sản phẩm phải là object');
    for (const f of fields) {
        const value = specs[f.key];
        const empty = value === undefined || value === null || String(value).trim() === '';
        if (f.required && empty) fail(`Thiếu thông số bắt buộc: ${f.key}`);
        if (empty) continue;
        if (f.type === 'number' && (!Number.isFinite(Number(value)) || Number(value) < 0)) fail(`${f.key} phải là số không âm`);
        if (f.type === 'select' && !f.options.includes(String(value))) fail(`${f.key} không thuộc danh sách cho phép`);
    }
}

async function validateProductMetadata(client, p) {
    if (p.brand_id) await one(client, 'SELECT id FROM brands WHERE id = ?', [p.brand_id], 'Thương hiệu');
    if (p.spec_template_id) {
        const template = await one(client, 'SELECT * FROM spec_templates WHERE id = ?', [p.spec_template_id], 'Mẫu thông số');
        if (Number(template.category_id) !== Number(p.category_id)) fail('Mẫu thông số không thuộc danh mục sản phẩm');
        validateSpecs(parse(template.fields, []), parse(p.specs, {}));
    }
}

function supplierPayload(b) {
    const out = { code: text(b.code, 'Mã nhà cung cấp', 50, true).toUpperCase(), name: text(b.name, 'Tên nhà cung cấp', 150, true),
        contact_name: text(b.contact_name, 'Người liên hệ', 150), phone: text(b.phone, 'Điện thoại', 30), email: text(b.email, 'Email', 150),
        address: text(b.address, 'Địa chỉ', 255), tax_code: text(b.tax_code, 'Mã số thuế', 50), notes: text(b.notes, 'Ghi chú', 2000), is_active: b.is_active === undefined ? true : bool(b.is_active) };
    if (!/^[A-Z0-9_-]+$/.test(out.code)) fail('Mã nhà cung cấp chỉ gồm chữ, số, gạch ngang và gạch dưới');
    if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) fail('Email không hợp lệ');
    return out;
}

async function catalogList(kind, q) {
    const cond = [], values = [];
    if (kind === 'suppliers') { search(q, ['t.name', 't.code', 't.phone'], cond, values); return list('t.*', 'FROM suppliers t', cond, values, q); }
    if (kind === 'brands') { search(q, ['t.name'], cond, values); return list('t.*', 'FROM brands t', cond, values, q); }
    search(q, ['t.name', 'cat.name'], cond, values);
    const result = await list('t.*, cat.name AS category_name', 'FROM spec_templates t JOIN categories cat ON cat.id = t.category_id', cond, values, q);
    result.items = result.items.map((r) => ({ ...r, fields: parse(r.fields, []) }));
    return result;
}

async function saveCatalog(kind, itemId, b, actor) {
    let data;
    if (kind === 'suppliers') data = supplierPayload(b);
    else if (kind === 'brands') {
        data = { name: text(b.name, 'Thương hiệu', 150, true), website: text(b.website, 'Website', 255), is_active: b.is_active === undefined ? true : bool(b.is_active) };
        if (data.website && !/^https?:\/\//i.test(data.website)) fail('Website phải bắt đầu bằng http(s)://');
    } else {
        data = { name: text(b.name, 'Tên mẫu', 150, true), category_id: id(b.category_id), fields: JSON.stringify(templateFields(b.fields)) };
    }
    const table = { suppliers: 'suppliers', brands: 'brands', templates: 'spec_templates' }[kind];
    if (!table) fail('Danh mục không hợp lệ');
    return transaction(actor, itemId ? 'update' : 'create', kind, async (client) => {
        const before = itemId ? await one(client, `SELECT * FROM ${table} WHERE id = ? FOR UPDATE`, [id(itemId)]) : null;
        if (kind === 'templates') {
            await one(client, 'SELECT id FROM categories WHERE id = ?', [data.category_id], 'Danh mục');
            if (itemId) {
                const [usage] = await client.query('SELECT COUNT(*) AS total FROM products WHERE spec_template_id = ?', [itemId]);
                if (Number(usage[0].total) > 0 && (Number(before.category_id) !== data.category_id || JSON.stringify(parse(before.fields, [])) !== data.fields)) fail('Mẫu đang dùng bởi sản phẩm. Hãy tạo bản mẫu mới để đổi cấu trúc.', 409);
            }
        }
        const keys = Object.keys(data);
        let result;
        if (itemId) [result] = await client.query(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...Object.values(data), itemId]);
        else [result] = await client.query(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, Object.values(data));
        return { id: itemId || result.insertId, summary: `${itemId ? 'Cập nhật' : 'Tạo'} ${data.name}`, changes: { before, after: data } };
    });
}

async function lookups() {
    const [products, suppliers, brands, templates, categories, orders] = await Promise.all([
        db.query('SELECT id, name, sku, price, stock, brand_id, serial_required, warranty_months FROM products ORDER BY name LIMIT 2000'),
        db.query('SELECT id, code, name, is_active FROM suppliers ORDER BY name LIMIT 2000'),
        db.query('SELECT * FROM brands ORDER BY name LIMIT 2000'),
        db.query('SELECT * FROM spec_templates ORDER BY name LIMIT 2000'),
        db.query('SELECT id, name, type FROM categories ORDER BY name'),
        db.query('SELECT id, order_code, customer_name, status, payment_status FROM orders ORDER BY id DESC LIMIT 500')
    ]);
    return { products, suppliers, brands, templates: templates.map((t) => ({ ...t, fields: parse(t.fields, []) })), categories, orders };
}

async function orderItems(orderId) {
    return db.query(`SELECT oi.*, o.order_code, o.status AS order_status, o.payment_status,
        p.serial_required, p.warranty_months FROM order_items oi JOIN orders o ON o.id = oi.order_id
        LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ? ORDER BY oi.id`, [id(orderId)]);
}

module.exports = { templateFields, validateSpecs, validateProductMetadata, supplierPayload, catalogList, saveCatalog, lookups, orderItems };
