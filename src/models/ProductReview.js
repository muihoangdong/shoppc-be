const db = require('../config/database');

const toApi = (r) => r && {
    ...r,
    rating: Number(r.rating)
};

class ProductReview {
    /**
     * Các đơn (chưa hủy) của khách có sản phẩm này. Đơn đặt khi chưa đăng nhập vẫn tính nếu cùng email với tài khoản
     * (email tài khoản đã được xác nhận bằng mã OTP lúc đăng ký nên chắc chắn là của khách).
     */
    static async purchasesOf(productId, userId, email) {
        return db.query(
            `SELECT o.id, o.status
             FROM orders o
             JOIN order_items oi ON oi.order_id = o.id
             WHERE oi.product_id = ?
               AND o.status <> 'cancelled'
               AND (o.user_id = ? OR (o.user_id IS NULL AND LOWER(o.customer_email) = LOWER(?)))
             ORDER BY o.id DESC`,
            [productId, userId, email || '']
        );
    }

    /** Điểm trung bình + số đánh giá theo từng mức sao (chỉ đánh giá đang hiện). */
    static async summary(productId) {
        const rows = await db.query(
            `SELECT rating, COUNT(*) AS n FROM product_reviews
             WHERE product_id = ? AND status = 'visible'
             GROUP BY rating`,
            [productId]
        );
        const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        let count = 0;
        let sum = 0;
        for (const r of rows) {
            const star = Number(r.rating);
            const n = Number(r.n);
            if (distribution[star] === undefined) continue;
            distribution[star] = n;
            count += n;
            sum += star * n;
        }
        return { average: count ? Math.round((sum / count) * 10) / 10 : 0, count, distribution };
    }

    static async listVisible(productId, { limit, offset, rating }) {
        const params = [productId];
        let filter = '';
        if (rating) {
            filter = ' AND r.rating = ?';
            params.push(rating);
        }
        const rows = await db.query(
            `SELECT r.id, r.rating, r.comment, r.admin_reply, r.replied_at, r.created_at, r.updated_at,
                    u.full_name AS customer_name
             FROM product_reviews r
             JOIN users u ON u.id = r.user_id
             WHERE r.product_id = ? AND r.status = 'visible'${filter}
             ORDER BY r.created_at DESC, r.id DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );
        return rows.map(toApi);
    }

    static async mine(productId, userId) {
        const rows = await db.query(
            `SELECT id, product_id, rating, comment, status, admin_reply, replied_at, created_at, updated_at
             FROM product_reviews WHERE product_id = ? AND user_id = ?`,
            [productId, userId]
        );
        return toApi(rows[0]) || null;
    }

    /** Mỗi khách 1 đánh giá / sản phẩm: gửi lại thì sửa đánh giá cũ (giữ nguyên trạng thái ẩn/hiện do cửa hàng đặt). */
    static async upsert({ productId, userId, orderId, rating, comment }) {
        const update = () => db.query(
            'UPDATE product_reviews SET rating = ?, comment = ?, order_id = ? WHERE product_id = ? AND user_id = ?',
            [rating, comment, orderId, productId, userId]
        );
        if (await this.mine(productId, userId)) {
            await update();
        } else {
            try {
                await db.query(
                    'INSERT INTO product_reviews (product_id, user_id, order_id, rating, comment) VALUES (?, ?, ?, ?, ?)',
                    [productId, userId, orderId, rating, comment]
                );
            } catch (error) {
                if (error.code !== 'ER_DUP_ENTRY') throw error;
                await update(); // gửi 2 lần cùng lúc: lần sau thành sửa
            }
        }
        return this.mine(productId, userId);
    }

    static async removeMine(productId, userId) {
        const result = await db.query('DELETE FROM product_reviews WHERE product_id = ? AND user_id = ?', [productId, userId]);
        return result.affectedRows > 0;
    }

    // ───── Quản trị ─────
    static async adminList({ status, rating, search, limit, offset }) {
        const conds = [];
        const params = [];
        if (rating) { conds.push('r.rating = ?'); params.push(rating); }
        if (search) {
            const like = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
            conds.push('(p.name LIKE ? OR u.full_name LIKE ? OR u.email LIKE ? OR r.comment LIKE ?)');
            params.push(like, like, like, like);
        }
        const from = `FROM product_reviews r
             JOIN users u ON u.id = r.user_id
             JOIN products p ON p.id = r.product_id`;
        const baseWhere = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
        const countRows = await db.query(`SELECT r.status, COUNT(*) AS n ${from} ${baseWhere} GROUP BY r.status`, params);
        const counts = { all: 0, visible: 0, hidden: 0 };
        for (const c of countRows) {
            counts[c.status] = Number(c.n);
            counts.all += Number(c.n);
        }
        const where = status ? `WHERE ${[...conds, 'r.status = ?'].join(' AND ')}` : baseWhere;
        const rows = await db.query(
            `SELECT r.id, r.product_id, p.name AS product_name, p.image_url AS product_image, r.user_id,
                    u.full_name AS customer_name, u.email AS customer_email, r.order_id, r.rating, r.comment,
                    r.status, r.admin_reply, r.replied_at, r.created_at, r.updated_at
             ${from} ${where}
             ORDER BY r.created_at DESC, r.id DESC
             LIMIT ? OFFSET ?`,
            [...(status ? [...params, status] : params), limit, offset]
        );
        return { items: rows.map(toApi), counts, total: status ? counts[status] : counts.all };
    }

    static async getById(id) {
        const rows = await db.query(
            `SELECT id, product_id, user_id, rating, comment, status, admin_reply, replied_at, created_at, updated_at
             FROM product_reviews WHERE id = ?`,
            [id]
        );
        return toApi(rows[0]) || null;
    }

    static async setStatus(id, status) {
        await db.query('UPDATE product_reviews SET status = ? WHERE id = ?', [status, id]);
    }

    /** reply = null: xóa phản hồi. */
    static async setReply(id, reply) {
        if (reply) {
            await db.query('UPDATE product_reviews SET admin_reply = ?, replied_at = CURRENT_TIMESTAMP WHERE id = ?', [reply, id]);
        } else {
            await db.query('UPDATE product_reviews SET admin_reply = NULL, replied_at = NULL WHERE id = ?', [id]);
        }
    }

    static async remove(id) {
        const result = await db.query('DELETE FROM product_reviews WHERE id = ?', [id]);
        return result.affectedRows > 0;
    }
}

module.exports = ProductReview;
