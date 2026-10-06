const db = require('../config/database');

class CartModel {
    // Lấy giỏ hàng theo session_id
    static async getCart(sessionId) {
        const rows = await db.query(
            `SELECT ci.*, p.name, p.price, p.image_url, p.stock
             FROM cart_items ci
             JOIN products p ON ci.product_id = p.id
             WHERE ci.session_id = ?`,
            [sessionId]
        );

        // Tính tổng tiền
        const total = rows.reduce(
            (sum, item) => sum + (parseFloat(item.price) * item.quantity),
            0
        );

        return {
            items: rows,
            total,
            total_items: rows.reduce((sum, item) => sum + item.quantity, 0)
        };
    }

    // Thêm sản phẩm vào giỏ
    static async addToCart(sessionId, productId, quantity = 1) {
        // Kiểm tra sản phẩm đã có trong giỏ chưa
        const existing = await db.query(
            'SELECT * FROM cart_items WHERE session_id = ? AND product_id = ?',
            [sessionId, productId]
        );

        if (existing.length > 0) {
            // Cập nhật số lượng
            const result = await db.query(
                `UPDATE cart_items
                 SET quantity = quantity + ?,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE session_id = ? AND product_id = ?`,
                [quantity, sessionId, productId]
            );

            return result.affectedRows || 1;
        } else {
            // Thêm mới
            const result = await db.pool.query(
                'INSERT INTO cart_items (session_id, product_id, quantity) VALUES (?, ?, ?)',
                [sessionId, productId, quantity]
            );

            return result[0].insertId;
        }
    }

    // Cập nhật số lượng sản phẩm trong giỏ
    static async updateCartItem(sessionId, productId, quantity) {
        if (quantity <= 0) {
            return this.removeFromCart(sessionId, productId);
        }

        const result = await db.pool.query(
            `UPDATE cart_items
             SET quantity = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE session_id = ? AND product_id = ?`,
            [quantity, sessionId, productId]
        );

        return result[0].affectedRows;
    }

    // Xóa sản phẩm khỏi giỏ
    static async removeFromCart(sessionId, productId) {
        const result = await db.pool.query(
            'DELETE FROM cart_items WHERE session_id = ? AND product_id = ?',
            [sessionId, productId]
        );

        return result[0].affectedRows;
    }

    // Xóa toàn bộ giỏ hàng
    static async clearCart(sessionId) {
        const result = await db.pool.query(
            'DELETE FROM cart_items WHERE session_id = ?',
            [sessionId]
        );

        return result[0].affectedRows;
    }

    // Kiểm tra tồn kho trước khi thanh toán
    static async checkStock(sessionId) {
        const items = await db.query(
            `SELECT ci.product_id, ci.quantity, p.stock, p.name
             FROM cart_items ci
             JOIN products p ON ci.product_id = p.id
             WHERE ci.session_id = ?`,
            [sessionId]
        );

        const outOfStock = items.filter(
            item => item.quantity > item.stock
        );

        return {
            valid: outOfStock.length === 0,
            outOfStock
        };
    }

    // Chuyển giỏ hàng từ session sang user (khi đăng nhập)
    static async mergeCart(sessionId, userId) {
        // Lấy cart items từ session
        const sessionCart = await db.query(
            'SELECT * FROM cart_items WHERE session_id = ?',
            [sessionId]
        );

        for (const item of sessionCart) {
            // Kiểm tra xem user đã có sản phẩm này trong giỏ chưa
            const existing = await db.query(
                'SELECT * FROM cart_items WHERE session_id = ? AND product_id = ?',
                [userId.toString(), item.product_id]
            );

            if (existing.length > 0) {
                // Cập nhật số lượng
                await db.pool.query(
                    `UPDATE cart_items
                     SET quantity = quantity + ?
                     WHERE session_id = ? AND product_id = ?`,
                    [item.quantity, userId.toString(), item.product_id]
                );
            } else {
                // Chuyển item sang user
                await db.pool.query(
                    'UPDATE cart_items SET session_id = ? WHERE id = ?',
                    [userId.toString(), item.id]
                );
            }
        }

        // Xóa session cart cũ
        await db.pool.query(
            'DELETE FROM cart_items WHERE session_id = ?',
            [sessionId]
        );

        return true;
    }
}

module.exports = CartModel;