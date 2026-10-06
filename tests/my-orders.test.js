// Kiểm thử "Đơn hàng của tôi": khách đăng nhập xem lịch sử / theo dõi đơn của mình, tự hủy đơn chưa xác nhận.
// Truy vấn SQL thật được kiểm tra bằng tests/schema.test.js (đúng bảng/cột) và chạy thử trên MySQL.
// Chạy:  node tests/my-orders.test.js
const assert = require('assert');
const H = require('./helpers/harness');
const { src } = H;
delete process.env.NODE_ENV;

const users = { 1: { id: 1, email: 'an@x.vn', full_name: 'An', username: 'an' }, 2: { id: 2, email: 'binh@x.vn', full_name: 'Bình', username: 'binh' } };
let orders;
const calls = [];
const events = [];
const reset = () => {
    calls.length = 0; events.length = 0;
    orders = [
        { id: 10, order_code: 'ORD-10', user_id: 1, customer_email: 'an@x.vn', status: 'pending', payment_status: 'pending', admin_note: 'khách khó tính', payment_id: 'sepay:1' },
        { id: 11, order_code: 'ORD-11', user_id: 1, customer_email: 'an@x.vn', status: 'processing', payment_status: 'pending' },
        { id: 12, order_code: 'ORD-12', user_id: 1, customer_email: 'an@x.vn', status: 'pending', payment_status: 'paid' },
        { id: 13, order_code: 'ORD-13', user_id: null, customer_email: 'AN@x.vn', status: 'pending', payment_status: 'pending' }, // đặt lúc chưa đăng nhập
        { id: 20, order_code: 'ORD-20', user_id: 2, customer_email: 'binh@x.vn', status: 'pending', payment_status: 'pending' },
    ];
};
// Mô phỏng đúng quy tắc "đơn của khách" của SQL thật: user_id khớp, hoặc đơn khách vãng lai cùng email
const mine = (userId, email) => orders.filter((o) => o.user_id === userId || (o.user_id === null && o.customer_email.toLowerCase() === String(email).toLowerCase()));
let OrderReal;
const OrderStub = {
    getCustomerOrders: async (userId, email, opts) => { calls.push(['list', userId, email, opts]); const list = mine(userId, email); return { orders: list.map((o) => OrderReal.publicOrder(o)), counts: { all: list.length }, total: list.length, page: opts.page, limit: opts.limit, pages: 1 }; },
    getCustomerOrder: async (userId, email, code) => { const o = mine(userId, email).find((x) => x.order_code === code); return o ? { ...OrderReal.publicOrder(o), items: [], history: [] } : null; },
    cancelOrder: async (id, by, note) => { calls.push(['cancel', id, by, note]); const o = orders.find((x) => x.id === id); o.status = 'cancelled'; return { ...o }; },
    publicOrder: (o) => OrderReal.publicOrder(o),
};
H.install(new Map([
    [src('config/database.js'), { query: async () => [], pool: {}, getClient: async () => ({}) }],
    [src('models/User.js'), { getUserById: async (id) => users[id] || null }],
    [src('realtime/events.js'), { orderUpdated: (o, by) => events.push(['order', o.order_code, o.status, by && by.name]), productChanged: () => events.push(['product']), orderNew() {} }],
]));
OrderReal = require(src('models/Order.js'));
const Ctl = (() => {
    // controller dùng model thật, thay các hàm truy vấn bằng bản giả ở trên
    Object.assign(OrderReal, { getCustomerOrders: OrderStub.getCustomerOrders, getCustomerOrder: OrderStub.getCustomerOrder, cancelOrder: OrderStub.cancelOrder });
    return require(src('controllers/orderController.js'));
})();
const routes = require(src('routes/orderRoutes.js'));
const Auth = require(src('middlewares/auth.js'));
const { test, done } = H.runner();
const as = (id) => ({ id, username: users[id].username, role: 'customer' });

(async () => {
    console.log('Đơn hàng của tôi');
    await test('danh sách: đúng đơn của khách (theo tài khoản + đơn đặt lúc chưa đăng nhập cùng email), không lẫn đơn người khác', async () => {
        reset();
        const r = await H.call(Ctl.myOrders, { user: as(1), query: { page: '1' } });
        assert.strictEqual(r.code, 200);
        assert.deepStrictEqual(r.body.data.map((o) => o.order_code), ['ORD-10', 'ORD-11', 'ORD-12', 'ORD-13']);
        assert.deepStrictEqual(calls[0], ['list', 1, 'an@x.vn', { group: undefined, page: 1, limit: 10 }], 'email lấy từ tài khoản, không lấy từ client');
        assert.deepStrictEqual(Object.keys(r.body.meta).sort(), ['counts', 'limit', 'page', 'pages', 'total']);
    });
    await test('không trả ghi chú nội bộ của cửa hàng / mã giao dịch / user_id cho khách', async () => {
        reset();
        const r = await H.call(Ctl.myOrders, { user: as(1) });
        for (const o of r.body.data) for (const k of ['admin_note', 'payment_id', 'user_id']) assert(!(k in o), k);
        const d = await H.call(Ctl.myOrderDetail, { user: as(1), params: { orderCode: 'ORD-10' } });
        assert(!('admin_note' in d.body.data));
    });
    await test('chi tiết: đơn của người khác hoặc không tồn tại → 404 như nhau (không lộ đơn có tồn tại hay không)', async () => {
        reset();
        assert.strictEqual((await H.call(Ctl.myOrderDetail, { user: as(1), params: { orderCode: 'ORD-20' } })).code, 404);
        assert.strictEqual((await H.call(Ctl.myOrderDetail, { user: as(1), params: { orderCode: 'ORD-999' } })).code, 404);
        assert.strictEqual((await H.call(Ctl.myOrderDetail, { user: as(1), params: { orderCode: 'ORD-13' } })).code, 200, 'đơn đặt lúc chưa đăng nhập cùng email');
    });
    await test('nhóm lọc sai → 400', async () => {
        reset();
        Object.assign(OrderReal, { getCustomerOrders: async () => { throw new OrderReal.OrderError('Nhóm đơn hàng không hợp lệ'); } });
        const r = await H.call(Ctl.myOrders, { user: as(1), query: { group: 'abc' } });
        assert.strictEqual(r.code, 400);
        Object.assign(OrderReal, { getCustomerOrders: OrderStub.getCustomerOrders });
    });

    console.log('Khách tự hủy đơn');
    const cancel = (u, code, body = {}) => H.call(Ctl.cancelMyOrder, { user: as(u), params: { orderCode: code }, body });
    await test('đơn chờ xác nhận, chưa thanh toán → hủy được; ghi lý do; báo realtime cho nhân viên + cập nhật tồn kho', async () => {
        reset();
        const r = await cancel(1, 'ORD-10', { reason: '  Đặt nhầm sản phẩm  ' });
        assert.strictEqual(r.code, 200); assert.strictEqual(r.body.data.status, 'cancelled');
        assert.deepStrictEqual(calls.at(-1), ['cancel', 10, 1, 'Khách hủy đơn: Đặt nhầm sản phẩm']);
        assert.deepStrictEqual(events, [['order', 'ORD-10', 'cancelled', 'An'], ['product']]);
    });
    await test('đơn đã xác nhận / đã thanh toán → 409 kèm hướng dẫn liên hệ; đơn người khác → 404; không hủy gì', async () => {
        reset();
        let r = await cancel(1, 'ORD-11');
        assert.strictEqual(r.code, 409); assert.match(r.body.message, /đã được cửa hàng xác nhận/);
        r = await cancel(1, 'ORD-12');
        assert.strictEqual(r.code, 409); assert.match(r.body.message, /đã thanh toán/);
        r = await cancel(1, 'ORD-20');
        assert.strictEqual(r.code, 404);
        assert(!calls.some((c) => c[0] === 'cancel')); assert.strictEqual(orders.find((o) => o.id === 20).status, 'pending');
    });
    await test('lý do quá dài bị cắt còn 200 ký tự; lý do không phải chữ bị bỏ qua', async () => {
        reset();
        await cancel(1, 'ORD-10', { reason: 'x'.repeat(500) });
        assert.strictEqual(calls.at(-1)[3].length, 'Khách hủy đơn: '.length + 200);
        reset();
        await cancel(1, 'ORD-13', { reason: { a: 1 } });
        assert.strictEqual(calls.at(-1)[3], 'Khách hủy đơn');
    });

    console.log('Route');
    await test('/mine* cần đăng nhập (không cần quyền nhân viên); đặt trước route của nhân viên; tra cứu công khai không lộ ghi chú nội bộ', async () => {
        const find = (m, p) => routes.routes.find((r) => r.method === m && r.path === p);
        for (const [m, p] of [['get', '/mine'], ['get', '/mine/:orderCode'], ['post', '/mine/:orderCode/cancel']]) {
            const h = find(m, p).handlers;
            assert.strictEqual(h[0], Auth.authenticate, `${m} ${p}`); assert(!h.includes(Auth.authorizeStaff), `${m} ${p}`);
        }
        const order = routes.routes.map((r) => `${r.method} ${r.path}`);
        assert(order.indexOf('get /mine') < order.indexOf('get /'), '/mine trước danh sách của nhân viên');
        assert.deepStrictEqual(Object.keys(OrderReal.publicOrder({ id: 1, admin_note: 'x', payment_id: 'y', user_id: 3, status: 'pending' })), ['id', 'status']);
    });

    done();
})();
