

const db = require('../config/database');
const {
    ORDER_STATUSES,
    STATUS_LABELS,
    REVENUE_STATUSES,
    PAYMENT_METHODS,
    PAYMENT_STATUSES,
    canTransition,
    TRANSITIONS
} = require('../config/orderStatus');
const { computeShippingFee } = require('../config/shipping');
const { getTopProducts, resolveRange, todayYmd, addDays } = require('../services/analytics');

/** Lỗi nghiệp vụ có mã HTTP; `expose` = thông báo an toàn để hiển thị cho người dùng. */
class OrderError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
        this.expose = true;
    }
}

const isStr = (v) => typeof v === 'string';
const isYmd = (v) => isStr(v) && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

class OrderModel {
    static async createOrderFromCart(orderData) {
        const client = await db.getClient();

        try {
            // Bắt đầu transaction MySQL
            await client.beginTransaction();

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
            } = orderData;

            // Phí ship và giảm giá do SERVER quyết định: mọi giá trị client gửi lên đều bị bỏ qua
            if (!PAYMENT_METHODS.includes(payment_method)) {
                throw new OrderError('Phương thức thanh toán không hợp lệ');
            }

            // Lấy giỏ hàng
            const [cartItems] = await client.query(
                `SELECT ci.product_id, ci.quantity, p.name, p.price, p.stock, p.image_url
                 FROM cart_items ci
                 JOIN products p ON ci.product_id = p.id
                 WHERE ci.session_id = ?`,
                [session_id]
            );

            if (!cartItems.length) {
                throw new Error('Giỏ hàng đang trống');
            }

            // Kiểm tra tồn kho
            for (const item of cartItems) {
                const [products] = await client.query(
                    'SELECT id, stock FROM products WHERE id = ? FOR UPDATE',
                    [item.product_id]
                );

                const product = products[0];

                if (!product || product.stock < item.quantity) {
                    throw new Error(`Sản phẩm ${item.name} không đủ tồn kho`);
                }
            }

            // Tính toán
            const subtotal = cartItems.reduce(
                (sum, item) =>
                    sum + parseFloat(item.price) * parseInt(item.quantity),
                0
            );

            const discount = 0;
            const shipping_fee = computeShippingFee(subtotal);
            const total_amount = subtotal - discount + shipping_fee;

            const order_code = `ORD-${Date.now()}`;

            // Tạo đơn hàng
            const [orderResult] = await client.query(
                `INSERT INTO orders (
                    order_code, user_id, customer_name, customer_email, customer_phone,
                    customer_address, customer_ward, customer_district, customer_city,
                    note, subtotal, discount, shipping_fee, total_amount,
                    payment_method, payment_status, status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending')`,
                [
                    order_code,
                    user_id,
                    customer_name,
                    customer_email,
                    customer_phone,
                    customer_address,
                    customer_ward,
                    customer_district,
                    customer_city,
                    note,
                    subtotal,
                    discount,
                    shipping_fee,
                    total_amount,
                    payment_method,
                ]
            );

            const orderId = orderResult.insertId;

            // Thêm order items và cập nhật stock
            for (const item of cartItems) {
                const total =
                    parseFloat(item.price) * parseInt(item.quantity);

                await client.query(
                    `INSERT INTO order_items (
                        order_id, product_id, product_name, product_image,
                        quantity, price, total
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [
                        orderId,
                        item.product_id,
                        item.name,
                        item.image_url,
                        item.quantity,
                        item.price,
                        total,
                    ]
                );

                const [stockResult] = await client.query(
                    `UPDATE products
                     SET stock = stock - ?,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = ? AND stock >= ?`,
                    [item.quantity, item.product_id, item.quantity]
                );

                if (stockResult.affectedRows === 0) {
                    throw new Error(
                        `Không thể cập nhật tồn kho cho ${item.name}`
                    );
                }
            }

            // Ghi lịch sử trạng thái
            await client.query(
                `INSERT INTO order_status_history (
                    order_id, old_status, new_status, changed_by, note
                ) VALUES (?, NULL, 'pending', ?, 'Tạo đơn hàng')`,
                [orderId, user_id]
            );

            // Xóa giỏ hàng
            await client.query(
                'DELETE FROM cart_items WHERE session_id = ?',
                [session_id]
            );

            // Commit transaction
            await client.commit();

            return await this.getOrderById(orderId);

        } catch (error) {
            // Rollback nếu có lỗi
            await client.rollback();
            throw error;

        } finally {
            client.release();
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

        if (filters.user_id) {
            sql += ' AND user_id = ?';
            values.push(filters.user_id);
        }

        sql += ' ORDER BY created_at DESC';

        const rows = await db.query(sql, values);

        return rows;
    }

    static async getOrderById(id) {
    const rows = await db.query(
        'SELECT * FROM orders WHERE id = ?',
        [id]
    );

    return rows[0];
}

static async getOrderByCode(orderCode) {
    const rows = await db.query(
        'SELECT * FROM orders WHERE order_code = ?',
        [orderCode]
    );

    return rows[0];
}

static async getOrderItems(orderId) {
    const rows = await db.query(
        'SELECT * FROM order_items WHERE order_id = ? ORDER BY id',
        [orderId]
    );

    return rows;
}

static async getOrderWithItems(orderId) {
    const order = await this.getOrderById(orderId);

    if (!order) return null;

    const items = await this.getOrderItems(orderId);

    return { ...order, items };
}

static async updateOrderStatus(id, newStatus, changedBy = null, note = null) {
    if (!ORDER_STATUSES.includes(newStatus)) {
        throw new OrderError('Trạng thái đơn hàng không hợp lệ');
    }

    const client = await db.getClient();

    try {
        await client.beginTransaction();

        const [orders] = await client.query(
            'SELECT * FROM orders WHERE id = ? FOR UPDATE',
            [id]
        );

        const order = orders[0];

        if (!order) {
            throw new OrderError('Không tìm thấy đơn hàng', 404);
        }

        if (order.status === newStatus) {
            throw new OrderError(`Đơn hàng đã ở trạng thái "${STATUS_LABELS[newStatus]}"`, 409);
        }

        if (!canTransition(order.status, newStatus)) {
            const next = (TRANSITIONS[order.status] || []).map((x) => `"${STATUS_LABELS[x]}"`).join(', ');
            throw new OrderError(
                `Không thể chuyển đơn từ "${STATUS_LABELS[order.status] || order.status}" sang "${STATUS_LABELS[newStatus]}". ` +
                    (next ? `Chỉ có thể chuyển sang: ${next}.` : 'Đây là trạng thái cuối.'),
                409
            );
        }

        // Hủy đơn => hoàn lại tồn kho (tồn kho đã bị trừ lúc đặt hàng)
        if (newStatus === 'cancelled') {
            const [items] = await client.query(
                'SELECT product_id, quantity FROM order_items WHERE order_id = ?',
                [id]
            );
            for (const item of items) {
                if (item.product_id) {
                    await client.query(
                        'UPDATE products SET stock = stock + ? WHERE id = ?',
                        [item.quantity, item.product_id]
                    );
                }
            }
        }

        // Đơn COD giao thành công => đã thu tiền
        const markPaid =
            newStatus === 'delivered' &&
            order.payment_method === 'cod' &&
            order.payment_status !== 'paid';

        await client.query(
            `UPDATE orders SET status = ?, ${markPaid ? "payment_status = 'paid', " : ''}updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [newStatus, id]
        );

        await client.query(
            `INSERT INTO order_status_history (
                order_id, old_status, new_status, changed_by, note
            ) VALUES (?, ?, ?, ?, ?)`,
            [id, order.status, newStatus, changedBy, note]
        );

        await client.commit();

        return await this.getOrderById(id);

    } catch (error) {
        await client.rollback();
        throw error;

    } finally {
        client.release();
    }
}

static async updatePaymentStatus(id, paymentStatus, paymentId = null) {
    if (!PAYMENT_STATUSES.includes(paymentStatus)) {
        throw new OrderError('Trạng thái thanh toán không hợp lệ');
    }
    const existing = await this.getOrderById(id);
    if (!existing) throw new OrderError('Không tìm thấy đơn hàng', 404);
    if (existing.status === 'cancelled') {
        throw new OrderError('Không thể đổi trạng thái thanh toán của đơn đã hủy', 409);
    }

    await db.pool.query(
        `UPDATE orders
         SET payment_status = ?,
             payment_id = COALESCE(?, payment_id),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [paymentStatus, paymentId, id]
    );

    return await this.getOrderById(id);
}

static async cancelOrder(id, changedBy = null, reason = null) {
    return await this.updateOrderStatus(
        id,
        'cancelled',
        changedBy,
        reason || 'Đơn hàng bị hủy'
    );
}

static async getDashboardStats() {
    const realized = REVENUE_STATUSES.map((x) => `'${x}'`).join(', ');

    const [
        productsR, ordersR, revenueR, lowR, pendingR, todayR, monthlyRows, lowList, recent
    ] = await Promise.all([
        db.query('SELECT COUNT(*) AS count FROM products'),
        db.query('SELECT COUNT(*) AS count FROM orders'),
        db.query(`SELECT COALESCE(SUM(total_amount), 0) AS total FROM orders WHERE status IN (${realized})`),
        db.query('SELECT COUNT(*) AS count FROM products WHERE stock <= 10'),
        db.query("SELECT COUNT(*) AS count FROM orders WHERE status = 'pending'"),
        db.query(
            `SELECT COUNT(*) AS orders, COALESCE(SUM(total_amount), 0) AS sales
             FROM orders WHERE created_at >= CURDATE() AND status <> 'cancelled'`
        ),
        // Doanh thu thực (delivered/completed) 6 tháng gần nhất, gồm tháng hiện tại
        db.query(
            `SELECT DATE_FORMAT(created_at, '%Y-%m') AS month,
                    COALESCE(SUM(total_amount), 0) AS revenue
             FROM orders
             WHERE created_at >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 5 MONTH), '%Y-%m-01')
               AND status IN (${realized})
             GROUP BY DATE_FORMAT(created_at, '%Y-%m')
             ORDER BY month`
        ),
        db.query('SELECT id, name, stock FROM products WHERE stock <= 10 ORDER BY stock ASC, id ASC LIMIT 5'),
        db.query(
            `SELECT id, order_code, customer_name, total_amount, status, created_at
             FROM orders ORDER BY created_at DESC, id DESC LIMIT 5`
        )
    ]);

    // Điền 0 cho tháng không có doanh thu để biểu đồ đủ 6 tháng
    const [cy, cm] = todayYmd().split('-').map(Number);
    const byMonth = new Map(monthlyRows.map((r) => [r.month, Number(r.revenue)]));
    const monthlyRevenue = [];
    for (let i = 5; i >= 0; i -= 1) {
        const d = new Date(Date.UTC(cy, cm - 1 - i, 1));
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        monthlyRevenue.push({ month: key, revenue: byMonth.get(key) || 0 });
    }

    const topProducts = await getTopProducts(resolveRange({ period: '30d' }), 5);

    return {
        totalProducts: parseInt(productsR[0].count, 10),
        totalOrders: parseInt(ordersR[0].count, 10),
        totalRevenue: parseFloat(revenueR[0].total),
        lowStockProducts: parseInt(lowR[0].count, 10),
        pendingOrders: parseInt(pendingR[0].count, 10),
        todayOrders: parseInt(todayR[0].orders, 10),
        todaySales: parseFloat(todayR[0].sales),
        monthlyRevenue,
        topProducts,
        lowStockList: lowList.map((p) => ({ id: p.id, name: p.name, stock: Number(p.stock) })),
        recentOrders: recent.map((o) => ({ ...o, total_amount: Number(o.total_amount) }))
    };
}

// Thống kê nâng cao
static async getAdvancedStats(startDate, endDate) {
    const rows = await db.query(
        `SELECT
            COUNT(*) AS total_orders,
            COUNT(DISTINCT user_id) AS unique_customers,
            COALESCE(SUM(total_amount), 0) AS total_revenue,
            COALESCE(AVG(total_amount), 0) AS avg_order_value,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_orders,
            SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_orders,
            SUM(CASE WHEN payment_status = 'paid' THEN total_amount ELSE 0 END) AS paid_revenue
         FROM orders
         WHERE created_at BETWEEN ? AND ?`,
        [startDate, endDate]
    );

    return rows[0];
}

// Danh sách đơn có lọc + phân trang phía server (trang Đơn hàng của dashboard)
static async getOrdersPaged(filters = {}) {
    const { status, payment_status, search, from, to } = filters;

    for (const [k, v] of Object.entries({ status, payment_status, search, from, to })) {
        if (v !== undefined && v !== '' && !isStr(v)) throw new OrderError(`Tham số ${k} không hợp lệ`);
    }
    if (status && !ORDER_STATUSES.includes(status)) throw new OrderError('Trạng thái đơn hàng không hợp lệ');
    if (payment_status && !PAYMENT_STATUSES.includes(payment_status)) throw new OrderError('Trạng thái thanh toán không hợp lệ');
    if (from && !isYmd(from)) throw new OrderError('from phải có dạng YYYY-MM-DD');
    if (to && !isYmd(to)) throw new OrderError('to phải có dạng YYYY-MM-DD');
    if (from && to && from > to) throw new OrderError('Ngày bắt đầu phải trước ngày kết thúc');

    const limit = Math.min(Math.max(parseInt(filters.limit, 10) || 10, 1), 100);
    const page = Math.max(parseInt(filters.page, 10) || 1, 1);

    // Điều kiện chung (không gồm trạng thái) để đếm số đơn theo từng trạng thái
    const conds = [];
    const params = [];
    if (payment_status) { conds.push('payment_status = ?'); params.push(payment_status); }
    if (from) { conds.push('created_at >= ?'); params.push(`${from} 00:00:00`); }
    if (to) { conds.push('created_at < ?'); params.push(`${addDays(to, 1)} 00:00:00`); }
    if (search && search.trim()) {
        const like = `%${search.trim().replace(/[\\%_]/g, '\\$&')}%`;
        conds.push('(order_code LIKE ? OR customer_name LIKE ? OR customer_phone LIKE ? OR customer_email LIKE ?)');
        params.push(like, like, like, like);
    }
    const commonWhere = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const countRows = await db.query(
        `SELECT status, COUNT(*) AS n FROM orders ${commonWhere} GROUP BY status`,
        params
    );
    const counts = { all: 0 };
    ORDER_STATUSES.forEach((x) => { counts[x] = 0; });
    countRows.forEach((r) => {
        counts[r.status] = Number(r.n);
        counts.all += Number(r.n);
    });

    const dataConds = status ? [...conds, 'status = ?'] : conds;
    const dataParams = status ? [...params, status] : params;
    const dataWhere = dataConds.length ? `WHERE ${dataConds.join(' AND ')}` : '';
    const total = status ? counts[status] || 0 : counts.all;

    const orders = await db.query(
        `SELECT * FROM orders ${dataWhere} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...dataParams, limit, (page - 1) * limit]
    );

    return { orders, total, page, limit, pages: Math.max(Math.ceil(total / limit), 1), counts };
}

// Lịch sử đổi trạng thái (không làm hỏng trang chi tiết nếu bảng/cột khác dự kiến)
static async getOrderHistory(orderId) {
    try {
        return await db.query(
            `SELECT h.id, h.old_status, h.new_status, h.note, h.created_at, h.changed_by,
                    u.full_name AS changed_by_name
             FROM order_status_history h
             LEFT JOIN users u ON u.id = h.changed_by
             WHERE h.order_id = ?
             ORDER BY h.id ASC`,
            [orderId]
        );
    } catch (error) {
        console.warn('Không đọc được order_status_history:', error.message);
        return [];
    }
}

// Chi tiết đơn: thông tin + sản phẩm + lịch sử trạng thái
static async getOrderDetail(id) {
    const order = await this.getOrderById(id);
    if (!order) return null;
    const [items, history] = await Promise.all([this.getOrderItems(id), this.getOrderHistory(id)]);
    return { ...order, items, history };
}

// Lấy đơn hàng theo user
static async getOrdersByUser(userId, limit = 10, offset = 0) {
    const rows = await db.query(
        `SELECT *
         FROM orders
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
        [userId, Number(limit), Number(offset)]
    );

    return rows;
}

// Đếm số đơn hàng theo user
static async countOrdersByUser(userId) {
    const rows = await db.query(
        'SELECT COUNT(*) AS count FROM orders WHERE user_id = ?',
        [userId]
    );

    return parseInt(rows[0].count);
}
}

OrderModel.OrderError = OrderError;

module.exports = OrderModel;