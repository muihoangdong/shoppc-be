const db = require('../config/database');

class OrderModel {
    static async createOrderFromCart(orderData) {
        const client = await db.getClient();
        try {
            await client.query('BEGIN');
            
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

            // Lấy giỏ hàng
            const cartResult = await client.query(
                `SELECT ci.product_id, ci.quantity, p.name, p.price, p.stock, p.image_url
                 FROM cart_items ci
                 JOIN products p ON ci.product_id = p.id
                 WHERE ci.session_id = $1`,
                [session_id]
            );

            const cartItems = cartResult.rows;

            if (!cartItems.length) {
                throw new Error('Giỏ hàng đang trống');
            }

            // Kiểm tra tồn kho với row lock
            for (const item of cartItems) {
                const productResult = await client.query(
                    'SELECT id, stock FROM products WHERE id = $1 FOR UPDATE',
                    [item.product_id]
                );
                const product = productResult.rows[0];
                if (!product || product.stock < item.quantity) {
                    throw new Error(`Sản phẩm ${item.name} không đủ tồn kho`);
                }
            }

            // Tính toán
            const subtotal = cartItems.reduce((sum, item) => sum + parseFloat(item.price) * parseInt(item.quantity), 0);
            const total_amount = subtotal - parseFloat(discount || 0) + parseFloat(shipping_fee || 0);
            const order_code = `ORD-${Date.now()}`;

            // Tạo đơn hàng
            const orderResult = await client.query(
                `INSERT INTO orders (
                    order_code, user_id, customer_name, customer_email, customer_phone,
                    customer_address, customer_ward, customer_district, customer_city,
                    note, subtotal, discount, shipping_fee, total_amount,
                    payment_method, payment_status, status
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'pending', 'pending')
                RETURNING id`,
                [
                    order_code, user_id, customer_name, customer_email, customer_phone,
                    customer_address, customer_ward, customer_district, customer_city,
                    note, subtotal, discount, shipping_fee, total_amount, payment_method
                ]
            );

            const orderId = orderResult.rows[0].id;

            // Thêm order items và cập nhật stock
            for (const item of cartItems) {
                const total = parseFloat(item.price) * parseInt(item.quantity);
                await client.query(
                    `INSERT INTO order_items (order_id, product_id, product_name, product_image, quantity, price, total)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [orderId, item.product_id, item.name, item.image_url, item.quantity, item.price, total]
                );
                
                const stockResult = await client.query(
                    'UPDATE products SET stock = stock - $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND stock >= $3 RETURNING id',
                    [item.quantity, item.product_id, item.quantity]
                );
                
                if (stockResult.rowCount === 0) {
                    throw new Error(`Không thể cập nhật tồn kho cho ${item.name}`);
                }
            }

            // Ghi lịch sử
            await client.query(
                `INSERT INTO order_status_history (order_id, old_status, new_status, changed_by, note)
                 VALUES ($1, NULL, 'pending', $2, 'Tạo đơn hàng')`,
                [orderId, user_id]
            );

            // Xóa giỏ hàng
            await client.query('DELETE FROM cart_items WHERE session_id = $1', [session_id]);
            
            await client.query('COMMIT');
            return await this.getOrderById(orderId);
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    static async getOrders(filters = {}) {
        let sql = 'SELECT * FROM orders WHERE 1=1';
        const values = [];
        let paramCount = 1;
        
        if (filters.status) {
            sql += ` AND status = $${paramCount++}`;
            values.push(filters.status);
        }
        if (filters.payment_status) {
            sql += ` AND payment_status = $${paramCount++}`;
            values.push(filters.payment_status);
        }
        if (filters.user_id) {
            sql += ` AND user_id = $${paramCount++}`;
            values.push(filters.user_id);
        }
        
        sql += ' ORDER BY created_at DESC';
        const result = await db.query(sql, values);
        return result.rows;
    }

    static async getOrderById(id) {
        const result = await db.query('SELECT * FROM orders WHERE id = $1', [id]);
        return result.rows[0];
    }

    static async getOrderByCode(orderCode) {
        const result = await db.query('SELECT * FROM orders WHERE order_code = $1', [orderCode]);
        return result.rows[0];
    }

    static async getOrderItems(orderId) {
        const result = await db.query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id', [orderId]);
        return result.rows;
    }

    static async getOrderWithItems(orderId) {
        const order = await this.getOrderById(orderId);
        if (!order) return null;
        
        const items = await this.getOrderItems(orderId);
        return { ...order, items };
    }

    static async updateOrderStatus(id, newStatus, changedBy = null, note = null) {
        const client = await db.getClient();
        try {
            await client.query('BEGIN');
            
            const orderResult = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id]);
            const order = orderResult.rows[0];
            if (!order) throw new Error('Không tìm thấy đơn hàng');

            await client.query(
                'UPDATE orders SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                [newStatus, id]
            );
            
            await client.query(
                `INSERT INTO order_status_history (order_id, old_status, new_status, changed_by, note)
                 VALUES ($1, $2, $3, $4, $5)`,
                [id, order.status, newStatus, changedBy, note]
            );
            
            await client.query('COMMIT');
            return await this.getOrderById(id);
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    static async updatePaymentStatus(id, paymentStatus, paymentId = null) {
        const result = await db.query(
            'UPDATE orders SET payment_status = $1, payment_id = COALESCE($2, payment_id), updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *',
            [paymentStatus, paymentId, id]
        );
        return result.rows[0];
    }

    static async cancelOrder(id, changedBy = null, reason = null) {
        return await this.updateOrderStatus(id, 'cancelled', changedBy, reason || 'Đơn hàng bị hủy');
    }

    static async getDashboardStats() {
        // Tổng số sản phẩm
        const totalProductsResult = await db.query('SELECT COUNT(*) AS count FROM products');
        const totalProducts = parseInt(totalProductsResult.rows[0].count);
        
        // Tổng số đơn hàng
        const totalOrdersResult = await db.query('SELECT COUNT(*) AS count FROM orders');
        const totalOrders = parseInt(totalOrdersResult.rows[0].count);
        
        // Tổng doanh thu
        const totalRevenueResult = await db.query(
            `SELECT COALESCE(SUM(total_amount), 0) AS total 
             FROM orders 
             WHERE status IN ('delivered', 'completed')`
        );
        const totalRevenue = parseFloat(totalRevenueResult.rows[0].total);
        
        // Sản phẩm tồn kho thấp
        const lowStockResult = await db.query('SELECT COUNT(*) AS count FROM products WHERE stock <= 10');
        const lowStockProducts = parseInt(lowStockResult.rows[0].count);
        
        // Đơn hàng chờ xử lý
        const pendingResult = await db.query("SELECT COUNT(*) AS count FROM orders WHERE status = 'pending'");
        const pendingOrders = parseInt(pendingResult.rows[0].count);
        
        // Doanh thu theo tháng (6 tháng gần nhất)
        const monthlyRevenueResult = await db.query(
            `SELECT 
                TO_CHAR(created_at, 'YYYY-MM') AS month,
                COALESCE(SUM(total_amount), 0) AS revenue
             FROM orders
             WHERE created_at >= CURRENT_DATE - INTERVAL '6 months'
             GROUP BY TO_CHAR(created_at, 'YYYY-MM')
             ORDER BY month`
        );
        
        return {
            totalProducts,
            totalOrders,
            totalRevenue,
            lowStockProducts,
            pendingOrders,
            monthlyRevenue: monthlyRevenueResult.rows
        };
    }

    // Thống kê nâng cao
    static async getAdvancedStats(startDate, endDate) {
        const result = await db.query(
            `SELECT 
                COUNT(*) as total_orders,
                COUNT(DISTINCT user_id) as unique_customers,
                SUM(total_amount) as total_revenue,
                AVG(total_amount) as avg_order_value,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_orders,
                SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_orders,
                SUM(CASE WHEN payment_status = 'paid' THEN total_amount ELSE 0 END) as paid_revenue,
                MODE() WITHIN GROUP (ORDER BY payment_method) as most_used_payment
             FROM orders
             WHERE created_at BETWEEN $1 AND $2`,
            [startDate, endDate]
        );
        return result.rows[0];
    }

    // Lấy đơn hàng theo user
    static async getOrdersByUser(userId, limit = 10, offset = 0) {
        const result = await db.query(
            `SELECT * FROM orders 
             WHERE user_id = $1 
             ORDER BY created_at DESC 
             LIMIT $2 OFFSET $3`,
            [userId, limit, offset]
        );
        return result.rows;
    }

    // Đếm số đơn hàng theo user
    static async countOrdersByUser(userId) {
        const result = await db.query(
            'SELECT COUNT(*) as count FROM orders WHERE user_id = $1',
            [userId]
        );
        return parseInt(result.rows[0].count);
    }
}

module.exports = OrderModel;