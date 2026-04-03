const db = require('../config/database');

class CartModel {
    // Lấy giỏ hàng theo session_id
    static async getCart(sessionId) {
        const result = await db.query(
            `SELECT ci.*, p.name, p.price, p.image_url, p.stock
             FROM cart_items ci
             JOIN products p ON ci.product_id = p.id
             WHERE ci.session_id = $1`,
            [sessionId]
        );
        
        const rows = result.rows; // PostgreSQL trả về rows
        
        // Tính tổng tiền
        const total = rows.reduce((sum, item) => sum + (parseFloat(item.price) * item.quantity), 0);
        
        return {
            items: rows,
            total: total,
            total_items: rows.reduce((sum, item) => sum + item.quantity, 0)
        };
    }

    // Thêm sản phẩm vào giỏ
    static async addToCart(sessionId, productId, quantity = 1) {
        // Kiểm tra sản phẩm đã có trong giỏ chưa
        const existing = await db.query(
            'SELECT * FROM cart_items WHERE session_id = $1 AND product_id = $2',
            [sessionId, productId]
        );

        if (existing.rows.length > 0) {
            // Cập nhật số lượng
            const result = await db.query(
                'UPDATE cart_items SET quantity = quantity + $1, updated_at = CURRENT_TIMESTAMP WHERE session_id = $2 AND product_id = $3',
                [quantity, sessionId, productId]
            );
            return result.rowCount; // rowCount thay cho affectedRows
        } else {
            // Thêm mới
            const result = await db.query(
                'INSERT INTO cart_items (session_id, product_id, quantity) VALUES ($1, $2, $3) RETURNING id',
                [sessionId, productId, quantity]
            );
            return result.rows[0].id;
        }
    }

    // Cập nhật số lượng sản phẩm trong giỏ
    static async updateCartItem(sessionId, productId, quantity) {
        if (quantity <= 0) {
            return this.removeFromCart(sessionId, productId);
        }
        
        const result = await db.query(
            'UPDATE cart_items SET quantity = $1, updated_at = CURRENT_TIMESTAMP WHERE session_id = $2 AND product_id = $3',
            [quantity, sessionId, productId]
        );
        return result.rowCount;
    }

    // Xóa sản phẩm khỏi giỏ
    static async removeFromCart(sessionId, productId) {
        const result = await db.query(
            'DELETE FROM cart_items WHERE session_id = $1 AND product_id = $2',
            [sessionId, productId]
        );
        return result.rowCount;
    }

    // Xóa toàn bộ giỏ hàng
    static async clearCart(sessionId) {
        const result = await db.query(
            'DELETE FROM cart_items WHERE session_id = $1',
            [sessionId]
        );
        return result.rowCount;
    }

    // Kiểm tra tồn kho trước khi thanh toán
    static async checkStock(sessionId) {
        const result = await db.query(
            `SELECT ci.product_id, ci.quantity, p.stock, p.name
             FROM cart_items ci
             JOIN products p ON ci.product_id = p.id
             WHERE ci.session_id = $1`,
            [sessionId]
        );
        
        const items = result.rows;
        const outOfStock = items.filter(item => item.quantity > item.stock);
        return {
            valid: outOfStock.length === 0,
            outOfStock: outOfStock
        };
    }

    // Chuyển giỏ hàng từ session sang user (khi đăng nhập)
    static async mergeCart(sessionId, userId) {
        // Lấy cart items từ session
        const sessionCart = await db.query(
            'SELECT * FROM cart_items WHERE session_id = $1',
            [sessionId]
        );

        for (const item of sessionCart.rows) {
            // Kiểm tra xem user đã có sản phẩm này trong giỏ chưa
            const existing = await db.query(
                'SELECT * FROM cart_items WHERE session_id = $1 AND product_id = $2',
                [userId.toString(), item.product_id]
            );

            if (existing.rows.length > 0) {
                // Cập nhật số lượng
                await db.query(
                    'UPDATE cart_items SET quantity = quantity + $1 WHERE session_id = $2 AND product_id = $3',
                    [item.quantity, userId.toString(), item.product_id]
                );
            } else {
                // Chuyển item sang user
                await db.query(
                    'UPDATE cart_items SET session_id = $1 WHERE id = $2',
                    [userId.toString(), item.id]
                );
            }
        }

        // Xóa session cart cũ
        await db.query('DELETE FROM cart_items WHERE session_id = $1', [sessionId]);
        
        return true;
    }
}

module.exports = CartModel;