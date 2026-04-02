const db = require('../config/database');

class OrderModel {
    static async createOrderFromCart(orderData) {
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();
            const {
                session_id,
                user_id = null,
                customer_name,
                customer_email,
                customer_phone,
                customer_address,
                customer_ward = null,
                customer_district = null,
                customer_city,
                note = null,
                payment_method = 'cod',
                shipping_fee = 0,
                discount = 0,
            } = orderData;

            const [cartItems] = await connection.query(
                `SELECT ci.product_id, ci.quantity, p.name, p.price, p.stock, p.image_url
                 FROM cart_items ci
                 JOIN products p ON ci.product_id = p.id
                 WHERE ci.session_id = ?`,
                [session_id]
            );

            if (!cartItems.length) {
                throw new Error('Giỏ hàng đang trống');
            }

            for (const item of cartItems) {
                const [rows] = await connection.query('SELECT id, stock FROM products WHERE id = ? FOR UPDATE', [item.product_id]);
                const product = rows[0];
                if (!product || product.stock < item.quantity) {
                    throw new Error(`Sản phẩm ${item.name} không đủ tồn kho`);
                }
            }

            const subtotal = cartItems.reduce((sum, item) => sum + Number(item.price) * Number(item.quantity), 0);
            const total_amount = subtotal - Number(discount || 0) + Number(shipping_fee || 0);
            const order_code = `ORD-${Date.now()}`;

            const [orderResult] = await connection.query(
                `INSERT INTO orders (
                    order_code, user_id, customer_name, customer_email, customer_phone,
                    customer_address, customer_ward, customer_district, customer_city,
                    note, subtotal, discount, shipping_fee, total_amount,
                    payment_method, payment_status, status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending')`,
                [
                    order_code, user_id, customer_name, customer_email, customer_phone,
                    customer_address, customer_ward, customer_district, customer_city,
                    note, subtotal, discount, shipping_fee, total_amount, payment_method
                ]
            );

            const orderId = orderResult.insertId;

            for (const item of cartItems) {
                const total = Number(item.price) * Number(item.quantity);
                await connection.query(
                    `INSERT INTO order_items (order_id, product_id, product_name, product_image, quantity, price, total)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [orderId, item.product_id, item.name, item.image_url, item.quantity, item.price, total]
                );
                const [result] = await connection.query(
                    'UPDATE products SET stock = stock - ?, updated_at = NOW() WHERE id = ? AND stock >= ?',
                    [item.quantity, item.product_id, item.quantity]
                );
                if (result.affectedRows === 0) {
                    throw new Error(`Không thể cập nhật tồn kho cho ${item.name}`);
                }
            }

            await connection.query(
                `INSERT INTO order_status_history (order_id, old_status, new_status, changed_by, note)
                 VALUES (?, NULL, 'pending', ?, 'Tạo đơn hàng')`,
                [orderId, user_id]
            );

            await connection.query('DELETE FROM cart_items WHERE session_id = ?', [session_id]);
            await connection.commit();
            return this.getOrderById(orderId);
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    static async getOrders(filters = {}) {
        let sql = 'SELECT * FROM orders WHERE 1=1';
        const values = [];
        if (filters.status) {
            sql += ' AND status = ?';
            values.push(filters.status);
        }
        if (filters.payment_status) {
            sql += ' AND payment_status = ?';
            values.push(filters.payment_status);
        }
        sql += ' ORDER BY created_at DESC';
        const [rows] = await db.query(sql, values);
        return rows;
    }

    static async getOrderById(id) {
        const [rows] = await db.query('SELECT * FROM orders WHERE id = ?', [id]);
        return rows[0];
    }

    static async getOrderByCode(orderCode) {
        const [rows] = await db.query('SELECT * FROM orders WHERE order_code = ?', [orderCode]);
        return rows[0];
    }

    static async getOrderItems(orderId) {
        const [rows] = await db.query('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', [orderId]);
        return rows;
    }

    static async updateOrderStatus(id, newStatus, changedBy = null, note = null) {
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();
            const [rows] = await connection.query('SELECT * FROM orders WHERE id = ? FOR UPDATE', [id]);
            const order = rows[0];
            if (!order) throw new Error('Không tìm thấy đơn hàng');

            await connection.query('UPDATE orders SET status = ?, updated_at = NOW() WHERE id = ?', [newStatus, id]);
            await connection.query(
                `INSERT INTO order_status_history (order_id, old_status, new_status, changed_by, note)
                 VALUES (?, ?, ?, ?, ?)`,
                [id, order.status, newStatus, changedBy, note]
            );
            await connection.commit();
            return this.getOrderById(id);
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    static async getDashboardStats() {
        const [[{ totalProducts }]] = await db.query('SELECT COUNT(*) AS totalProducts FROM products');
        const [[{ totalOrders }]] = await db.query('SELECT COUNT(*) AS totalOrders FROM orders');
        const [[{ totalRevenue }]] = await db.query("SELECT COALESCE(SUM(total_amount), 0) AS totalRevenue FROM orders WHERE status IN ('delivered', 'completed')");
        const [[{ lowStockProducts }]] = await db.query('SELECT COUNT(*) AS lowStockProducts FROM products WHERE stock <= 10');
        const [[{ pendingOrders }]] = await db.query("SELECT COUNT(*) AS pendingOrders FROM orders WHERE status = 'pending'");
        const [monthlyRevenue] = await db.query(
            `SELECT DATE_FORMAT(created_at, '%Y-%m') AS month, COALESCE(SUM(total_amount), 0) AS revenue
             FROM orders
             WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
             GROUP BY DATE_FORMAT(created_at, '%Y-%m')
             ORDER BY month`
        );
        return { totalProducts, totalOrders, totalRevenue, lowStockProducts, pendingOrders, monthlyRevenue };
    }
}

module.exports = OrderModel;
