const db = require('../config/database');

// Ngày trả về dạng chuỗi 'YYYY-MM-DD' (không lệch múi giờ khi gửi sang trình duyệt)
const COLUMNS = `id, code, description, type, value, min_order_value, max_discount, usage_limit, used_count,
    once_per_customer, DATE_FORMAT(starts_on, '%Y-%m-%d') AS starts_on, DATE_FORMAT(expires_on, '%Y-%m-%d') AS expires_on,
    is_active, created_at, updated_at`;

const FIELDS = ['code', 'description', 'type', 'value', 'min_order_value', 'max_discount', 'usage_limit', 'once_per_customer', 'starts_on', 'expires_on', 'is_active'];

const toApi = (r) => r && {
    ...r,
    value: Number(r.value),
    min_order_value: Number(r.min_order_value),
    max_discount: r.max_discount === null ? null : Number(r.max_discount),
    usage_limit: r.usage_limit === null ? null : Number(r.usage_limit),
    used_count: Number(r.used_count),
    once_per_customer: !!Number(r.once_per_customer),
    is_active: !!Number(r.is_active)
};

class Coupon {
    static COLUMNS = COLUMNS;

    static async list({ search } = {}) {
        const where = [];
        const params = [];
        if (search) {
            where.push('(code LIKE ? OR description LIKE ?)');
            const like = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
            params.push(like, like);
        }
        const rows = await db.query(
            `SELECT ${COLUMNS} FROM coupons ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC`,
            params
        );
        return rows.map(toApi);
    }

    static async getById(id) {
        const rows = await db.query(`SELECT ${COLUMNS} FROM coupons WHERE id = ?`, [id]);
        return toApi(rows[0]) || null;
    }

    static async getByCode(code) {
        const rows = await db.query(`SELECT ${COLUMNS} FROM coupons WHERE code = ?`, [code]);
        return toApi(rows[0]) || null;
    }

    /** Các đơn chưa hủy đã dùng mã (để kiểm tra "mỗi khách 1 lần"). `conn` = client trong transaction hoặc db. */
    static async ordersUsing(code, conn = null) {
        const sql = "SELECT customer_phone, customer_email FROM orders WHERE coupon_code = ? AND status <> 'cancelled'";
        if (conn) {
            const [rows] = await conn.query(sql, [code]);
            return rows;
        }
        return db.query(sql, [code]);
    }

    static async create(data) {
        const d = { description: null, min_order_value: 0, max_discount: null, usage_limit: null, once_per_customer: 0, starts_on: null, expires_on: null, is_active: 1, ...data };
        const result = await db.query(
            `INSERT INTO coupons (code, description, type, value, min_order_value, max_discount, usage_limit,
                once_per_customer, starts_on, expires_on, is_active)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            FIELDS.map((f) => d[f])
        );
        return result.insertId;
    }

    static async update(id, data) {
        const cols = FIELDS.filter((f) => data[f] !== undefined);
        if (!cols.length) return;
        await db.query(
            `UPDATE coupons SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [...cols.map((c) => data[c]), id]
        );
    }

    static async remove(id) {
        const result = await db.query('DELETE FROM coupons WHERE id = ?', [id]);
        return result.affectedRows > 0;
    }
}

module.exports = Coupon;
module.exports.toApi = toApi;
