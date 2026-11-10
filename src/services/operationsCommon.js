'use strict';

const db = require('../config/database');
const { randomUUID } = require('crypto');
const { ValidationError } = require('../utils/http');
const v = require('../utils/validate');
const ledger = require('./operationsLedger');
const Events = require('../realtime/events');

const fail = (message, status = 400) => { throw new ValidationError(message, status); };
const text = (value, label, max = 500, required = false) => v.str(value, label, { max, optional: !required, allowEmpty: !required }) || '';
const int = (value, label, min = 0, max = 1e7) => v.int(value, label, { min, max });
const id = (value) => int(value, 'ID', 1);
const bool = (value) => { if (![true, false, 1, 0, '1', '0'].includes(value)) fail('Giá trị bật/tắt không hợp lệ'); return value === true || value === 1 || value === '1'; };
const parse = (value, fallback = null) => { if (typeof value !== 'string') return value ?? fallback; try { return JSON.parse(value); } catch { return fallback; } };
const code = (prefix) => `${prefix}-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 6).toUpperCase()}`;
const rows = async (client, sql, values = []) => (await client.query(sql, values))[0];
const one = async (client, sql, values = [], label = 'Dữ liệu') => { const result = await rows(client, sql, values); if (!result[0]) fail(`${label} không tồn tại`, 404); return result[0]; };
const day = (value) => { const s = text(value, 'Ngày', 10); if (s && (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s)) || new Date(s).toISOString().slice(0, 10) !== s)) fail('Ngày phải có dạng YYYY-MM-DD hợp lệ'); return s; };

async function transaction(actor, action, entity, fn) {
    const client = await db.getClient();
    let result;
    try {
        await client.beginTransaction();
        result = await fn(client);
        await ledger.audit(client, actor, action, entity, result.id, result.summary || action, result.changes || null);
        await client.commit();
    } catch (err) {
        await client.rollback();
        if (err.code === 'ER_DUP_ENTRY') fail('Mã, tên hoặc serial đã tồn tại', 409);
        throw err;
    } finally { client.release(); }
    if (result.productIds?.length) Events.productChanged(result.productIds);
    if (result.orderId) {
        try { const orders = await db.query('SELECT * FROM orders WHERE id = ?', [result.orderId]); if (orders[0]) Events.orderUpdated(orders[0], actor?.username); }
        catch (err) { console.error('[operations] Không phát được cập nhật đơn:', err.message); }
    }
    return result;
}

function paging(q) {
    const page = q.page === undefined ? 1 : int(q.page, 'Trang', 1, 1e6);
    const limit = q.limit === undefined ? 20 : int(q.limit, 'Số dòng', 1, 100);
    return { page, limit, offset: (page - 1) * limit };
}

async function list(select, from, conditions, values, q, order = 't.id DESC') {
    const p = paging(q);
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const [items, count] = await Promise.all([
        db.query(`SELECT ${select} ${from}${where} ORDER BY ${order} LIMIT ? OFFSET ?`, [...values, p.limit, p.offset]),
        db.query(`SELECT COUNT(*) AS total ${from}${where}`, values)
    ]);
    return { items, total: Number(count[0].total), page: p.page, limit: p.limit };
}

function search(q, fields, conditions, values) {
    const s = text(q.search, 'Từ khóa', 100);
    if (s) { conditions.push(`(${fields.map((f) => `${f} LIKE ?`).join(' OR ')})`); fields.forEach(() => values.push(`%${s}%`)); }
}

function range(q, column, conditions, values) {
    const from = day(q.from), to = day(q.to);
    if (from && to && from > to) fail('Ngày bắt đầu phải trước ngày kết thúc');
    if (from) { conditions.push(`${column} >= ?`); values.push(from); }
    if (to) { conditions.push(`${column} < DATE_ADD(?, INTERVAL 1 DAY)`); values.push(to); }
}

module.exports = { db, fail, text, int, id, bool, parse, code, rows, one, day, transaction, paging, list, search, range, ledger };
