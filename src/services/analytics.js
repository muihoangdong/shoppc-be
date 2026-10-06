'use strict';

/**
 * Thống kê kinh doanh — dùng chung cho trang Thống kê (GET /api/orders/analytics),
 * trang Tổng quan và chatbot, để mọi nơi cùng một định nghĩa số liệu:
 *
 *   - "Doanh thu" = tổng tiền các đơn delivered/completed (doanh thu thực).
 *   - Số đơn / top sản phẩm / theo thanh toán / theo danh mục: KHÔNG tính đơn đã hủy.
 *   - Phân bổ theo trạng thái: tính tất cả đơn (để thấy cả đơn hủy).
 */

const db = require('../config/database');
const { REVENUE_STATUSES, STATUS_LABELS } = require('../config/orderStatus');

/** Lỗi do khoảng thời gian không hợp lệ (người gọi tự quyết định hiển thị như thế nào). */
class RangeInputError extends Error {}

const timezone = () => process.env.APP_TIMEZONE || 'Asia/Ho_Chi_Minh';
const todayYmd = () => new Date().toLocaleDateString('sv-SE', { timeZone: timezone() });

const addDays = (ymd, n) => {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

const isYmd = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

const PERIODS = ['today', '7d', '30d', 'this_month', 'last_month', 'this_year'];

/** Quy đổi `period` hoặc from/to thành khoảng ngày [from, to] (YYYY-MM-DD, gồm cả hai đầu). */
function resolveRange({ period, from, to } = {}) {
    const today = todayYmd();
    if (from || to) {
        if (from && !isYmd(from)) throw new RangeInputError('from phải có dạng YYYY-MM-DD');
        if (to && !isYmd(to)) throw new RangeInputError('to phải có dạng YYYY-MM-DD');
        const f = from || '2000-01-01';
        const t = to || today;
        if (f > t) throw new RangeInputError('Ngày bắt đầu phải trước ngày kết thúc');
        return { from: f, to: t, label: `${f} → ${t}` };
    }
    const [y, m] = today.split('-').map(Number);
    const pad = (n) => String(n).padStart(2, '0');
    switch (period || '30d') {
        case 'today':
            return { from: today, to: today, label: 'Hôm nay' };
        case '7d':
            return { from: addDays(today, -6), to: today, label: '7 ngày gần nhất' };
        case '30d':
            return { from: addDays(today, -29), to: today, label: '30 ngày gần nhất' };
        case 'this_month':
            return { from: `${y}-${pad(m)}-01`, to: today, label: `Tháng ${m}/${y}` };
        case 'last_month': {
            const first = new Date(Date.UTC(y, m - 2, 1));
            const last = new Date(Date.UTC(y, m - 1, 0));
            return {
                from: first.toISOString().slice(0, 10),
                to: last.toISOString().slice(0, 10),
                label: `Tháng ${first.getUTCMonth() + 1}/${first.getUTCFullYear()}`
            };
        }
        case 'this_year':
            return { from: `${y}-01-01`, to: today, label: `Năm ${y}` };
        default:
            throw new RangeInputError(`period không hợp lệ. Giá trị cho phép: ${PERIODS.join(', ')}`);
    }
}

const bounds = (range) => ({ start: `${range.from} 00:00:00`, end: `${addDays(range.to, 1)} 00:00:00` });

/** Điền 0 cho những ngày/tháng không có đơn để biểu đồ liên tục. */
function fillSeries(rows, range, granularity) {
    const map = new Map(rows.map((r) => [r.bucket, r]));
    const out = [];
    if (granularity === 'day') {
        for (let d = range.from; d <= range.to; d = addDays(d, 1)) {
            const r = map.get(d);
            out.push({ bucket: d, orders: r ? Number(r.orders) : 0, revenue: r ? Number(r.revenue) : 0 });
        }
    } else {
        const [fy, fm] = range.from.split('-').map(Number);
        const [ty, tm] = range.to.split('-').map(Number);
        for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m += 1) {
            if (m > 12) { m = 1; y += 1; }
            const key = `${y}-${String(m).padStart(2, '0')}`;
            const r = map.get(key);
            out.push({ bucket: key, orders: r ? Number(r.orders) : 0, revenue: r ? Number(r.revenue) : 0 });
        }
    }
    return out;
}

/** Top sản phẩm bán chạy (không tính đơn hủy) trong khoảng thời gian. */
async function getTopProducts(range, limit = 5) {
    const { start, end } = bounds(range);
    const rows = await db.query(
        `SELECT oi.product_id, oi.product_name,
                SUM(oi.quantity) AS quantity_sold, COALESCE(SUM(oi.total), 0) AS revenue
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
         WHERE o.created_at >= ? AND o.created_at < ? AND o.status <> 'cancelled'
         GROUP BY oi.product_id, oi.product_name
         ORDER BY quantity_sold DESC LIMIT ?`,
        [start, end, Number(limit)]
    );
    return rows.map((r) => ({
        product_id: r.product_id,
        name: r.product_name,
        quantity_sold: Number(r.quantity_sold),
        revenue: Number(r.revenue)
    }));
}

/** @param {{period?:string, from?:string, to?:string}} input */
async function getAnalytics(input = {}) {
    const range = resolveRange(input);
    const { start, end } = bounds(range);
    const days = Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86400000) + 1;
    const granularity = days <= 62 ? 'day' : 'month';
    const bucketFmt = granularity === 'day' ? '%Y-%m-%d' : '%Y-%m';
    const realized = REVENUE_STATUSES.map((s) => `'${s}'`).join(', ');

    const byStatus = await db.query(
        `SELECT status, COUNT(*) AS orders, COALESCE(SUM(total_amount), 0) AS amount
         FROM orders WHERE created_at >= ? AND created_at < ? GROUP BY status`,
        [start, end]
    );
    const byPayment = await db.query(
        `SELECT payment_method, COUNT(*) AS orders, COALESCE(SUM(total_amount), 0) AS amount
         FROM orders WHERE created_at >= ? AND created_at < ? AND status <> 'cancelled'
         GROUP BY payment_method`,
        [start, end]
    );
    const seriesRows = await db.query(
        `SELECT DATE_FORMAT(created_at, '${bucketFmt}') AS bucket, COUNT(*) AS orders,
                COALESCE(SUM(CASE WHEN status IN (${realized}) THEN total_amount ELSE 0 END), 0) AS revenue
         FROM orders WHERE created_at >= ? AND created_at < ? AND status <> 'cancelled'
         GROUP BY bucket ORDER BY bucket`,
        [start, end]
    );
    const byCategory = await db.query(
        `SELECT COALESCE(c.name, 'Khác') AS category, COALESCE(SUM(oi.quantity), 0) AS quantity,
                COALESCE(SUM(oi.total), 0) AS revenue
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
         LEFT JOIN products p ON p.id = oi.product_id
         LEFT JOIN categories c ON c.id = p.category_id
         WHERE o.created_at >= ? AND o.created_at < ? AND o.status <> 'cancelled'
         GROUP BY c.id, c.name ORDER BY revenue DESC LIMIT 8`,
        [start, end]
    );
    const top = await getTopProducts(range, 10);

    const totalOrders = byStatus.reduce((s, r) => s + Number(r.orders), 0);
    const cancelled = byStatus.find((r) => r.status === 'cancelled');
    const realizedTotals = byStatus
        .filter((r) => REVENUE_STATUSES.includes(r.status))
        .reduce((acc, r) => ({ orders: acc.orders + Number(r.orders), amount: acc.amount + Number(r.amount) }), {
            orders: 0,
            amount: 0
        });

    return {
        range,
        granularity,
        total_orders: totalOrders,
        cancelled_orders: cancelled ? Number(cancelled.orders) : 0,
        realized_revenue: realizedTotals.amount,
        realized_orders: realizedTotals.orders,
        avg_realized_order_value: realizedTotals.orders ? Math.round(realizedTotals.amount / realizedTotals.orders) : 0,
        series: fillSeries(seriesRows, range, granularity),
        by_status: byStatus.map((r) => ({
            status: r.status,
            label: STATUS_LABELS[r.status] || r.status,
            orders: Number(r.orders),
            amount: Number(r.amount)
        })),
        by_payment_method_excluding_cancelled: byPayment.map((r) => ({
            payment_method: r.payment_method,
            orders: Number(r.orders),
            amount: Number(r.amount)
        })),
        by_category_excluding_cancelled: byCategory.map((r) => ({
            category: r.category,
            quantity: Number(r.quantity),
            revenue: Number(r.revenue)
        })),
        top_products_excluding_cancelled: top,
        note: 'realized_revenue chỉ tính đơn delivered/completed.'
    };
}

module.exports = { RangeInputError, PERIODS, resolveRange, getAnalytics, getTopProducts, todayYmd, addDays };
