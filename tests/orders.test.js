// Kiểm thử luồng đơn hàng, thống kê, kiểm tra dữ liệu, các lớp bảo vệ và wiring của route.
// Chạy:  node tests/orders.test.js   (không cần MySQL / mạng / package ngoài)
//
// Model Order, service analytics, controller, middleware, route là code THẬT.
// Database là một "mini DB" trong bộ nhớ có transaction (rollback khôi phục dữ liệu).
const Module = require('module');
const path = require('path');
const assert = require('assert');

const BE = path.join(__dirname, '..', 'src');
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123456';
process.env.APP_TIMEZONE = 'Asia/Ho_Chi_Minh';
delete process.env.NODE_ENV;
delete process.env.CORS_ORIGINS;
delete process.env.FREE_SHIP_THRESHOLD;
delete process.env.SHIPPING_FEE;

// ───────────── mini DB trong bộ nhớ ─────────────
const clone = (x) => JSON.parse(JSON.stringify(x));
const freshWorld = () => ({
    products: {
        1: { id: 1, name: 'Laptop', price: '20000000.00', stock: 5, image_url: null },
        2: { id: 2, name: 'RAM 16GB', price: '1000000.00', stock: 10, image_url: null },
    },
    cart: {
        s_ram: [{ product_id: 2, quantity: 2 }],
        s_laptop: [{ product_id: 1, quantity: 1 }],
        s_big: [{ product_id: 1, quantity: 99 }],
        s_empty: [],
    },
    orders: [], items: [], history: [], nextId: 1,
});
let W = freshWorld();
let snapshot = null;
const sqlLog = [];
let dashboardCfg = {};
let pagedCfg = { counts: [], orders: [] };
let failHistoryQuery = false;

const norm = (sql) => sql.replace(/\s+/g, ' ').trim();

// Trả về { rows } (SELECT) hoặc { result } (INSERT/UPDATE/DELETE)
function run(s, p = []) {
    sqlLog.push({ sql: s, params: p });
    let m;
    if (/FROM cart_items ci JOIN products p/.test(s)) {
        return { rows: (W.cart[p[0]] || []).map((c) => ({ ...c, ...W.products[c.product_id] })).map(({ id, ...r }) => r) };
    }
    if (/^SELECT id, stock FROM products WHERE id = \? FOR UPDATE/.test(s)) return { rows: W.products[p[0]] ? [clone(W.products[p[0]])] : [] };
    if (/^INSERT INTO orders/.test(s)) {
        const o = {
            id: W.nextId++, order_code: p[0], user_id: p[1], customer_name: p[2], customer_email: p[3], customer_phone: p[4],
            customer_address: p[5], customer_ward: p[6], customer_district: p[7], customer_city: p[8], note: p[9],
            subtotal: p[10], discount: p[11], shipping_fee: p[12], total_amount: p[13], payment_method: p[14],
            payment_status: 'pending', status: 'pending', created_at: new Date(),
        };
        W.orders.push(o);
        return { result: { insertId: o.id, affectedRows: 1 } };
    }
    if (/^INSERT INTO order_items/.test(s)) {
        W.items.push({ id: W.items.length + 1, order_id: p[0], product_id: p[1], product_name: p[2], quantity: p[4], price: p[5], total: p[6] });
        return { result: { affectedRows: 1 } };
    }
    if (/^UPDATE products SET stock = stock - \?,.* AND stock >= \?/.test(s)) {
        const pr = W.products[p[1]];
        if (!pr || pr.stock < p[2]) return { result: { affectedRows: 0 } };
        pr.stock -= p[0];
        return { result: { affectedRows: 1 } };
    }
    if (/^UPDATE products SET stock = stock \+ \?/.test(s)) { W.products[p[1]].stock += p[0]; return { result: { affectedRows: 1 } }; }
    if (/^INSERT INTO order_status_history/.test(s)) {
        W.history.push(p.length === 2
            ? { order_id: p[0], old_status: null, new_status: 'pending', changed_by: p[1], note: 'Tạo đơn hàng' }
            : { order_id: p[0], old_status: p[1], new_status: p[2], changed_by: p[3], note: p[4] });
        return { result: { affectedRows: 1 } };
    }
    if (/^DELETE FROM cart_items/.test(s)) { delete W.cart[p[0]]; return { result: { affectedRows: 1 } }; }
    if (/^SELECT \* FROM orders WHERE id = \?( FOR UPDATE)?$/.test(s)) { const o = W.orders.find((x) => x.id === Number(p[0])); return { rows: o ? [clone(o)] : [] }; }
    if (/^SELECT \* FROM orders WHERE order_code = \?/.test(s)) { const o = W.orders.find((x) => x.order_code === p[0]); return { rows: o ? [clone(o)] : [] }; }
    if (/^SELECT product_id, quantity FROM order_items WHERE order_id/.test(s)) return { rows: W.items.filter((i) => i.order_id === Number(p[0])).map(({ product_id, quantity }) => ({ product_id, quantity })) };
    if (/^SELECT \* FROM order_items WHERE order_id/.test(s)) return { rows: clone(W.items.filter((i) => i.order_id === Number(p[0]))) };
    if ((m = /^UPDATE orders SET status = \?, (payment_status = 'paid', )?updated_at/.exec(s))) {
        const o = W.orders.find((x) => x.id === Number(p[1]));
        o.status = p[0]; if (m[1]) o.payment_status = 'paid';
        return { result: { affectedRows: 1 } };
    }
    if (/^UPDATE orders SET payment_status = \?/.test(s)) { W.orders.find((x) => x.id === Number(p[2])).payment_status = p[0]; return { result: { affectedRows: 1 } }; }
    if (/FROM order_status_history h/.test(s)) {
        if (failHistoryQuery) throw new Error("Unknown column 'h.created_at'");
        return { rows: W.history.filter((h) => h.order_id === Number(p[0])).map((h, i) => ({ id: i + 1, old_status: h.old_status, new_status: h.new_status, note: h.note, created_at: new Date(), changed_by: h.changed_by, changed_by_name: h.changed_by ? 'Nhân Viên' : null })) }; // đúng các cột của câu SELECT thật
    }
    if (/^SELECT \* FROM orders WHERE 1=1/.test(s)) return { rows: clone(W.orders) }; // getOrders() kiểu cũ
    if (/^SELECT status, COUNT\(\*\) AS n FROM orders/.test(s)) return { rows: pagedCfg.counts };
    if (/^SELECT \* FROM orders .*LIMIT \? OFFSET \?/.test(s)) return { rows: pagedCfg.orders };
    // ── dashboard + analytics (trả dữ liệu cấu hình sẵn)
    if (/COUNT\(\*\) AS count FROM products WHERE stock <= 10/.test(s)) return { rows: [{ count: dashboardCfg.low ?? 2 }] };
    if (/COUNT\(\*\) AS count FROM products/.test(s)) return { rows: [{ count: 7 }] };
    if (/COUNT\(\*\) AS count FROM orders WHERE status = 'pending'/.test(s)) return { rows: [{ count: 4 }] };
    if (/COUNT\(\*\) AS count FROM orders/.test(s)) return { rows: [{ count: 30 }] };
    if (/SUM\(total_amount\), 0\) AS total FROM orders/.test(s)) return { rows: [{ total: '123000000.00' }] };
    if (/COUNT\(\*\) AS orders, COALESCE\(SUM\(total_amount\), 0\) AS sales/.test(s)) return { rows: [{ orders: 3, sales: '5000000' }] };
    if (/DATE_FORMAT\(created_at, '%Y-%m'\) AS month/.test(s)) return { rows: dashboardCfg.monthly || [] };
    if (/^SELECT id, name, stock FROM products WHERE stock <= 10/.test(s)) return { rows: [{ id: 9, name: 'Chuột', stock: 0 }, { id: 8, name: 'Phím', stock: 3 }] };
    if (/^SELECT id, order_code, customer_name, total_amount, status, created_at FROM orders/.test(s)) return { rows: [{ id: 5, order_code: 'ORD-5', customer_name: 'A', total_amount: '1000', status: 'pending', created_at: new Date() }] };
    if (/GROUP BY oi.product_id, oi.product_name/.test(s)) return { rows: [{ product_id: 1, product_name: 'Laptop', quantity_sold: '3', revenue: '60000000' }] };
    if (/GROUP BY status/.test(s)) return { rows: [{ status: 'completed', orders: 2, amount: '30000000' }, { status: 'cancelled', orders: 1, amount: '1200000' }, { status: 'pending', orders: 1, amount: '500000' }] };
    if (/GROUP BY payment_method/.test(s)) return { rows: [{ payment_method: 'cod', orders: 2, amount: '30500000' }] };
    if (/GROUP BY bucket/.test(s)) return { rows: dashboardCfg.series || [] };
    if (/GROUP BY c.id, c.name/.test(s)) return { rows: [{ category: 'Laptop', quantity: '3', revenue: '60000000' }] };
    throw new Error('mini DB: câu SQL chưa được mô phỏng: ' + s.slice(0, 90));
}

const client = {
    beginTransaction: async () => { snapshot = clone(W); },
    commit: async () => { snapshot = null; },
    rollback: async () => { if (snapshot) { W = snapshot; snapshot = null; } },
    release() {},
    query: async (sql, p) => { const r = run(norm(sql), p); return [r.rows !== undefined ? r.rows : r.result]; },
};
const db = {
    getClient: async () => client,
    query: async (sql, p) => { const r = run(norm(sql), p); return r.rows !== undefined ? r.rows : r.result; },
    pool: { query: async (sql, p) => { const r = run(norm(sql), p); return [r.rows !== undefined ? r.rows : r.result]; } },
};

// ───────────── bản giả của thư viện / model khác ─────────────
const b64 = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');
const crypto = require('crypto');
const fakeJwt = {
    sign: (payload, secret) => { const d = `${b64({ alg: 'HS256' })}.${b64(payload)}`; return `${d}.${crypto.createHmac('sha256', secret).update(d).digest('base64url')}`; },
    verify: () => ({}), decode: () => ({}),
};
const fakeExpress = () => ({});
fakeExpress.Router = () => {
    const r = { routes: [] };
    for (const m of ['get', 'post', 'put', 'patch', 'delete']) r[m] = (pth, ...handlers) => r.routes.push({ method: m, path: pth, handlers });
    r.use = () => {};
    return r;
};
const corsCalls = [];
const fakeCors = (opts) => { corsCalls.push(opts); return { __cors: true, opts }; };

const Product = { __calls: [] };
const Category = {};
const stubs = new Map([
    [path.join(BE, 'config/database.js'), db],
    [path.join(BE, 'models/User.js'), {}],
    [path.join(BE, 'models/Product.js'), Product],
    [path.join(BE, 'models/Category.js'), Category],
    [path.join(BE, 'models/Cart.js'), {}],
]);
const external = { express: fakeExpress, jsonwebtoken: fakeJwt, bcryptjs: {}, dotenv: { config() {} }, cors: fakeCors };
const origLoad = Module._load;
Module._load = function (request, parent) {
    if (Object.prototype.hasOwnProperty.call(external, request)) return external[request];
    if (parent && request.startsWith('.')) {
        const resolved = require.resolve(path.resolve(path.dirname(parent.filename), request));
        if (stubs.has(resolved)) return stubs.get(resolved);
    }
    return origLoad.apply(this, arguments);
};

const OrderStatus = require(path.join(BE, 'config/orderStatus.js'));
const Order = require(path.join(BE, 'models/Order.js'));
const Analytics = require(path.join(BE, 'services/analytics.js'));
const OrderCtl = require(path.join(BE, 'controllers/orderController.js'));
const ProductCtl = require(path.join(BE, 'controllers/productController.js'));
const CategoryCtl = require(path.join(BE, 'controllers/categoryController.js'));
const rateLimit = require(path.join(BE, 'middlewares/rateLimit.js'));
const Sec = require(path.join(BE, 'middlewares/security.js'));
const errorHandler = require(path.join(BE, 'middlewares/errorHandler.js'));
const Limiters = require(path.join(BE, 'middlewares/limiters.js'));
const Auth = require(path.join(BE, 'middlewares/auth.js'));
const orderRoutes = require(path.join(BE, 'routes/orderRoutes.js'));
const authRoutes = require(path.join(BE, 'routes/authRoutes.js'));
const userRoutes = require(path.join(BE, 'routes/userRoutes.js'));
const productRoutes = require(path.join(BE, 'routes/productRoutes.js'));

// ───────────── tiện ích test ─────────────
const mkRes = () => {
    const r = { statusCode: 200, code: 200, body: null, headers: {},
        status(c) { r.code = c; r.statusCode = c; return r; },
        json(b) { r.body = b; return r; },
        set(k, v) { if (typeof k === 'object') Object.assign(r.headers, k); else r.headers[k] = v; return r; } };
    return r;
};
const call = async (fn, req = {}) => { const res = mkRes(); await fn({ body: {}, params: {}, query: {}, headers: {}, ...req }, res); return res; };
const capture = async (fn) => {
    const logs = []; const o = [console.log, console.warn, console.error];
    console.log = console.warn = console.error = (...a) => logs.push(a.join(' '));
    try { return { result: await fn(), logs }; } finally { [console.log, console.warn, console.error] = o; }
};
const buyer = (extra = {}) => ({ session_id: 's_ram', customer_name: 'Nguyễn Văn A', customer_email: 'a@x.vn', customer_phone: '0901234567', customer_address: '1 Lê Lợi', customer_city: 'HCM', ...extra });
const expectErr = async (promise, status, re) => {
    try { await promise; } catch (e) { assert.strictEqual(e.expose, true, 'lỗi phải có expose'); assert.strictEqual(e.status, status, `mã ${e.status}: ${e.message}`); if (re) assert(re.test(e.message), e.message); return; }
    assert.fail('đáng ra phải ném lỗi');
};
const find = (router, method, p) => router.routes.find((r) => r.method === method && r.path === p);

let passed = 0;
const test = async (name, fn) => {
    W = freshWorld(); snapshot = null; sqlLog.length = 0; dashboardCfg = {}; pagedCfg = { counts: [], orders: [] }; failHistoryQuery = false;
    delete process.env.FREE_SHIP_THRESHOLD; delete process.env.SHIPPING_FEE; delete process.env.NODE_ENV;
    try { await fn(); passed++; console.log('  ✓', name); }
    catch (e) { console.log('  ✗', name, '\n   ', e.stack.split('\n').slice(0, 4).join('\n    ')); process.exitCode = 1; }
};

(async () => {
    console.log('Vòng đời đơn hàng (config)');
    await test('mỗi bước hợp lệ được phép, mọi bước khác bị chặn; khóa lạ không lọt qua', () => {
        const allowed = { pending: ['processing', 'cancelled'], processing: ['shipped', 'cancelled'], shipped: ['delivered', 'cancelled'], delivered: ['completed'], completed: [], cancelled: [] };
        for (const from of OrderStatus.ORDER_STATUSES) for (const to of OrderStatus.ORDER_STATUSES) {
            assert.strictEqual(OrderStatus.canTransition(from, to), allowed[from].includes(to), `${from}->${to}`);
        }
        for (const bad of ['constructor', '__proto__', 'toString', undefined, null, '']) assert.strictEqual(OrderStatus.canTransition(bad, 'pending'), false);
    });

    console.log('Tạo đơn: server quyết định tiền');
    await test('đơn nhỏ (2.000.000đ): server tính phí ship 30.000đ, không giảm giá', async () => {
        const o = await Order.createOrderFromCart(buyer());
        assert.strictEqual(Number(o.subtotal), 2000000); assert.strictEqual(Number(o.shipping_fee), 30000);
        assert.strictEqual(Number(o.discount), 0); assert.strictEqual(Number(o.total_amount), 2030000);
    });
    await test('đơn lớn (20.000.000đ): miễn phí ship, tổng = tạm tính', async () => {
        const o = await Order.createOrderFromCart(buyer({ session_id: 's_laptop' }));
        assert.strictEqual(Number(o.shipping_fee), 0); assert.strictEqual(Number(o.total_amount), 20000000);
    });
    await test('client gửi discount / shipping_fee / total_amount giả → bị bỏ qua hoàn toàn', async () => {
        const o = await Order.createOrderFromCart(buyer({ discount: 2000000, shipping_fee: -5000000, total_amount: 1, subtotal: 1 }));
        assert.strictEqual(Number(o.discount), 0); assert.strictEqual(Number(o.shipping_fee), 30000);
        assert.strictEqual(Number(o.subtotal), 2000000); assert.strictEqual(Number(o.total_amount), 2030000);
        const o2 = await Order.createOrderFromCart(buyer({ session_id: 's_laptop', discount: 50000000 }));
        assert.strictEqual(Number(o2.total_amount), 20000000, 'không thể ra đơn 0đ hay âm');
    });
    await test('ngưỡng/ phí ship cấu hình được bằng biến môi trường', async () => {
        process.env.FREE_SHIP_THRESHOLD = '1000000'; process.env.SHIPPING_FEE = '50000';
        const o = await Order.createOrderFromCart(buyer());
        assert.strictEqual(Number(o.shipping_fee), 0);
        process.env.FREE_SHIP_THRESHOLD = '30000000';
        const o2 = await Order.createOrderFromCart(buyer({ session_id: 's_laptop' }));
        assert.strictEqual(Number(o2.shipping_fee), 50000);
    });
    await test('thành công: trừ tồn kho, xóa giỏ, ghi lịch sử "Tạo đơn hàng"', async () => {
        await Order.createOrderFromCart(buyer());
        assert.strictEqual(W.products[2].stock, 8); assert.strictEqual(W.cart.s_ram, undefined);
        assert.strictEqual(W.history.length, 1); assert.strictEqual(W.history[0].new_status, 'pending');
        assert.strictEqual(W.items[0].quantity, 2);
    });
    await test('phương thức thanh toán lạ bị từ chối, dữ liệu không đổi (rollback)', async () => {
        await assert.rejects(Order.createOrderFromCart(buyer({ payment_method: 'bitcoin' })), /Phương thức thanh toán/);
        assert.strictEqual(W.orders.length, 0); assert.strictEqual(W.products[2].stock, 10); assert(W.cart.s_ram);
        for (const m of ['cod', 'banking']) await Order.createOrderFromCart(buyer({ session_id: 's_laptop', payment_method: m })).then(() => { W.cart.s_laptop = [{ product_id: 1, quantity: 1 }]; W.products[1].stock = 5; });
    });
    await test('hết hàng / giỏ trống: báo lỗi và không thay đổi gì', async () => {
        await assert.rejects(Order.createOrderFromCart(buyer({ session_id: 's_big' })), /không đủ tồn kho/);
        await assert.rejects(Order.createOrderFromCart(buyer({ session_id: 's_empty' })), /Giỏ hàng đang trống/);
        assert.strictEqual(W.orders.length, 0); assert.strictEqual(W.products[1].stock, 5);
    });

    console.log('Đổi trạng thái đơn');
    const mkOrder = async (session = 's_ram', extra = {}) => Order.createOrderFromCart(buyer({ session_id: session, ...extra }));
    await test('chuỗi trạng thái hợp lệ đi hết vòng đời; mỗi bước có lịch sử (người đổi + ghi chú)', async () => {
        const o = await mkOrder();
        for (const st of ['processing', 'shipped', 'delivered', 'completed']) {
            const r = await Order.updateOrderStatus(o.id, st, 7, `ghi chú ${st}`);
            assert.strictEqual(r.status, st);
        }
        const hist = W.history.filter((h) => h.order_id === o.id);
        assert.deepStrictEqual(hist.map((h) => h.new_status), ['pending', 'processing', 'shipped', 'delivered', 'completed']);
        assert.deepStrictEqual(hist.at(-1), { order_id: o.id, old_status: 'delivered', new_status: 'completed', changed_by: 7, note: 'ghi chú completed' });
    });
    await test('bước sai: nhảy cóc, quay lui, trạng thái cuối, trùng, không tồn tại → lỗi đúng mã, không ghi gì', async () => {
        const o = await mkOrder();
        const before = clone(W);
        await expectErr(Order.updateOrderStatus(o.id, 'completed'), 409, /Chỉ có thể chuyển sang: "Đang xử lý", "Đã hủy"/);
        await expectErr(Order.updateOrderStatus(o.id, 'pending'), 409, /đã ở trạng thái/);
        await expectErr(Order.updateOrderStatus(o.id, 'giao-tan-noi'), 400, /không hợp lệ/);
        await expectErr(Order.updateOrderStatus(999, 'processing'), 404, /Không tìm thấy/);
        await Order.updateOrderStatus(o.id, 'cancelled');
        await expectErr(Order.updateOrderStatus(o.id, 'pending'), 409, /trạng thái cuối/);
        await expectErr(Order.updateOrderStatus(o.id, 'processing'), 409, /trạng thái cuối/);
        const o2 = await mkOrder('s_laptop');
        for (const st of ['processing', 'shipped', 'delivered', 'completed']) await Order.updateOrderStatus(o2.id, st);
        await expectErr(Order.updateOrderStatus(o2.id, 'cancelled'), 409, /trạng thái cuối/);
        assert.strictEqual(before.orders.length + 1, W.orders.length);
    });
    await test('hủy đơn hoàn lại đúng tồn kho (từ pending, processing và shipped); hủy lần 2 không hoàn thêm', async () => {
        for (const path_ of [[], ['processing'], ['processing', 'shipped']]) {
            W = freshWorld();
            const o = await mkOrder();
            assert.strictEqual(W.products[2].stock, 8);
            for (const st of path_) await Order.updateOrderStatus(o.id, st);
            await Order.updateOrderStatus(o.id, 'cancelled', 1, 'Khách đổi ý');
            assert.strictEqual(W.products[2].stock, 10, `hủy sau ${path_.join('>') || 'pending'}`);
            await expectErr(Order.updateOrderStatus(o.id, 'cancelled'), 409);
            assert.strictEqual(W.products[2].stock, 10, 'không hoàn tồn kho hai lần');
        }
    });
    await test('COD giao thành công → tự đánh dấu đã thanh toán; chuyển khoản thì không', async () => {
        const cod = await mkOrder('s_ram');
        const bank = await mkOrder('s_laptop', { payment_method: 'banking' });
        for (const id of [cod.id, bank.id]) for (const st of ['processing', 'shipped']) await Order.updateOrderStatus(id, st);
        const a = await Order.updateOrderStatus(cod.id, 'delivered');
        const b = await Order.updateOrderStatus(bank.id, 'delivered');
        assert.strictEqual(a.payment_status, 'paid'); assert.strictEqual(b.payment_status, 'pending');
    });
    await test('lỗi giữa chừng → rollback toàn bộ (tồn kho không bị hoàn một nửa)', async () => {
        const o = await mkOrder();
        const orig = client.query;
        client.query = async (sql, p) => { if (/INSERT INTO order_status_history/.test(sql)) throw new Error('boom'); return orig(sql, p); };
        try { await assert.rejects(Order.updateOrderStatus(o.id, 'cancelled'), /boom/); } finally { client.query = orig; }
        assert.strictEqual(W.products[2].stock, 8); assert.strictEqual(W.orders[0].status, 'pending');
    });
    await test('đổi trạng thái thanh toán: hợp lệ, giá trị lạ, đơn đã hủy, không tồn tại', async () => {
        const o = await mkOrder();
        assert.strictEqual((await Order.updatePaymentStatus(o.id, 'paid')).payment_status, 'paid');
        assert.strictEqual((await Order.updatePaymentStatus(o.id, 'pending')).payment_status, 'pending');
        await expectErr(Order.updatePaymentStatus(o.id, 'refunded'), 400, /không hợp lệ/);
        await expectErr(Order.updatePaymentStatus(999, 'paid'), 404);
        await Order.updateOrderStatus(o.id, 'cancelled');
        await expectErr(Order.updatePaymentStatus(o.id, 'paid'), 409, /đã hủy/);
    });

    console.log('Danh sách / chi tiết / tổng quan');
    await test('getOrdersPaged: câu SQL và tham số đúng (lọc, tìm kiếm có escape, ngày, phân trang)', async () => {
        pagedCfg = { counts: [{ status: 'pending', n: 4 }, { status: 'completed', n: 6 }], orders: [{ id: 1 }, { id: 2 }] };
        const r = await Order.getOrdersPaged({ status: 'pending', payment_status: 'paid', search: ' 50%_x ', from: '2026-10-01', to: '2026-10-03', page: '3', limit: '5' });
        const count = sqlLog.find((l) => /GROUP BY status/.test(l.sql)); const data = sqlLog.find((l) => /LIMIT \? OFFSET \?/.test(l.sql));
        assert(/WHERE payment_status = \? AND created_at >= \? AND created_at < \? AND \(order_code LIKE/.test(count.sql));
        assert(!/status = \? AND/.test(count.sql.replace('payment_status = ?', '')), 'đếm theo trạng thái không được lọc theo trạng thái');
        assert.deepStrictEqual(count.params, ['paid', '2026-10-01 00:00:00', '2026-10-04 00:00:00', '%50\\%\\_x%', '%50\\%\\_x%', '%50\\%\\_x%', '%50\\%\\_x%']);
        assert(/AND status = \?/.test(data.sql)); assert.deepStrictEqual(data.params.slice(-3), ['pending', 5, 10]);
        assert.strictEqual(r.total, 4); assert.strictEqual(r.pages, 1); assert.strictEqual(r.page, 3);
        assert.deepStrictEqual(r.counts, { all: 10, pending: 4, processing: 0, shipped: 0, delivered: 0, completed: 6, cancelled: 0 });
    });
    await test('getOrdersPaged: mặc định, giới hạn limit/page, tổng khi không lọc trạng thái', async () => {
        pagedCfg = { counts: [{ status: 'pending', n: 25 }], orders: [] };
        let r = await Order.getOrdersPaged({});
        assert.strictEqual(r.limit, 10); assert.strictEqual(r.page, 1); assert.strictEqual(r.total, 25); assert.strictEqual(r.pages, 3);
        r = await Order.getOrdersPaged({ limit: '1000', page: '-4' }); assert.strictEqual(r.limit, 100); assert.strictEqual(r.page, 1);
        r = await Order.getOrdersPaged({ limit: 'abc' }); assert.strictEqual(r.limit, 10);
        const data = sqlLog.filter((l) => /LIMIT \? OFFSET \?/.test(l.sql)).at(-1); assert.deepStrictEqual(data.params, [10, 0]);
        assert(!/WHERE/.test(data.sql));
    });
    await test('getOrdersPaged: tham số xấu bị từ chối (trạng thái lạ, mảng/object, ngày sai)', async () => {
        for (const bad of [{ status: 'xyz' }, { payment_status: 'abc' }, { status: ['a'] }, { search: { a: 1 } }, { from: '2026-13-45x' }, { to: 'hôm nay' }, { from: '2026-10-05', to: '2026-10-01' }]) {
            await expectErr(Order.getOrdersPaged(bad), 400);
        }
        assert.strictEqual(sqlLog.length, 0, 'không được chạm DB khi tham số sai');
    });
    await test('chi tiết đơn: kèm sản phẩm + lịch sử; lịch sử lỗi cột không làm hỏng trang', async () => {
        const o = await mkOrder(); await Order.updateOrderStatus(o.id, 'processing', 1, 'ok');
        let d = await Order.getOrderDetail(o.id);
        assert.strictEqual(d.items.length, 1); assert.deepStrictEqual(d.history.map((h) => h.new_status), ['pending', 'processing']);
        assert.strictEqual(d.history[1].changed_by_name, 'Nhân Viên');
        failHistoryQuery = true;
        const { result } = await capture(() => Order.getOrderDetail(o.id));
        assert.strictEqual(result.id, o.id); assert.deepStrictEqual(result.history, []);
        assert.strictEqual(await Order.getOrderDetail(999), null);
    });
    await test('getDashboardStats: số liệu thật, doanh thu không tính đơn hủy, đủ 6 tháng (điền 0)', async () => {
        const [cy, cm] = Analytics.todayYmd().split('-').map(Number);
        const key = (back) => { const d = new Date(Date.UTC(cy, cm - 1 - back, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
        dashboardCfg = { monthly: [{ month: key(0), revenue: '9000000' }, { month: key(3), revenue: '1500000' }] };
        const s = await Order.getDashboardStats();
        assert.deepStrictEqual([s.totalProducts, s.totalOrders, s.totalRevenue, s.lowStockProducts, s.pendingOrders, s.todayOrders, s.todaySales], [7, 30, 123000000, 2, 4, 3, 5000000]);
        assert.deepStrictEqual(s.monthlyRevenue.map((m) => m.month), [key(5), key(4), key(3), key(2), key(1), key(0)]);
        assert.deepStrictEqual(s.monthlyRevenue.map((m) => m.revenue), [0, 0, 1500000, 0, 0, 9000000]);
        assert.deepStrictEqual(s.topProducts, [{ product_id: 1, name: 'Laptop', quantity_sold: 3, revenue: 60000000 }]);
        assert.deepStrictEqual(s.lowStockList.map((p) => p.stock), [0, 3]);
        assert.strictEqual(s.recentOrders[0].total_amount, 1000);
        const monthlySql = sqlLog.find((l) => /AS month/.test(l.sql)).sql;
        assert(/status IN \('delivered', 'completed'\)/.test(monthlySql), 'doanh thu theo tháng phải loại đơn hủy');
        assert(/DATE_FORMAT\(DATE_SUB\(CURDATE\(\), INTERVAL 5 MONTH\), '%Y-%m-01'\)/.test(monthlySql));
    });

    console.log('Thống kê (analytics)');
    await test('resolveRange: các mốc, khoảng tùy chọn và lỗi', () => {
        const r = Analytics.resolveRange({ period: '7d' });
        assert.strictEqual(Analytics.addDays(r.from, 6), r.to);
        const lm = Analytics.resolveRange({ period: 'last_month' }); assert(/^\d{4}-\d{2}-01$/.test(lm.from) && lm.to > lm.from);
        assert.strictEqual(Analytics.resolveRange({ from: '2026-01-05', to: '2026-01-09' }).label, '2026-01-05 → 2026-01-09');
        for (const bad of [{ from: '2026-1-5' }, { to: 'x' }, { from: '2026-02-01', to: '2026-01-01' }, { period: 'forever' }]) {
            assert.throws(() => Analytics.resolveRange(bad), (e) => e instanceof Analytics.RangeInputError, JSON.stringify(bad));
        }
    });
    await test('getAnalytics: chuỗi theo ngày điền 0, doanh thu thực, theo danh mục, tham số ngày đúng', async () => {
        dashboardCfg = { series: [{ bucket: '2026-10-02', orders: 2, revenue: '3000000' }] };
        const a = await Analytics.getAnalytics({ from: '2026-10-01', to: '2026-10-04' });
        assert.strictEqual(a.granularity, 'day');
        assert.deepStrictEqual(a.series, [
            { bucket: '2026-10-01', orders: 0, revenue: 0 }, { bucket: '2026-10-02', orders: 2, revenue: 3000000 },
            { bucket: '2026-10-03', orders: 0, revenue: 0 }, { bucket: '2026-10-04', orders: 0, revenue: 0 }]);
        assert.deepStrictEqual([a.total_orders, a.cancelled_orders, a.realized_revenue, a.realized_orders, a.avg_realized_order_value], [4, 1, 30000000, 2, 15000000]);
        assert.deepStrictEqual(a.by_category_excluding_cancelled, [{ category: 'Laptop', quantity: 3, revenue: 60000000 }]);
        const q = sqlLog.find((l) => /GROUP BY status/.test(l.sql)); assert.deepStrictEqual(q.params, ['2026-10-01 00:00:00', '2026-10-05 00:00:00']);
    });
    await test('khoảng dài (> 62 ngày) gộp theo tháng, liền mạch qua năm mới', async () => {
        dashboardCfg = { series: [{ bucket: '2026-01', orders: 5, revenue: '1000' }] };
        const a = await Analytics.getAnalytics({ from: '2025-11-15', to: '2026-02-20' });
        assert.strictEqual(a.granularity, 'month');
        assert.deepStrictEqual(a.series.map((s) => s.bucket), ['2025-11', '2025-12', '2026-01', '2026-02']);
        assert.strictEqual(a.series[2].revenue, 1000);
    });

    console.log('Controller đơn hàng (chạy qua model thật)');
    await test('đặt hàng: chỉ chuyển tiếp trường cho phép; user_id lấy từ đăng nhập, không từ body', async () => {
        const res = await call(OrderCtl.createOrder, { body: buyer({ discount: 9e9, shipping_fee: -1, total_amount: 0, status: 'completed', payment_status: 'paid', user_id: 1, role: 'admin' }), user: { id: 42 } });
        assert.strictEqual(res.code, 201);
        const o = W.orders[0];
        assert.deepStrictEqual([o.discount, o.status, o.payment_status, o.user_id], [0, 'pending', 'pending', 42]);
        assert.strictEqual(Number(o.total_amount), 2030000);
        const anon = await call(OrderCtl.createOrder, { body: buyer({ session_id: 's_laptop', user_id: 1 }) });
        assert.strictEqual(W.orders[1].user_id, null); assert.strictEqual(anon.code, 201);
    });
    await test('đặt hàng: kiểm tra đầu vào (thiếu, sai kiểu, quá dài, email, SĐT, session)', async () => {
        for (const [patch, re] of [
            [{ customer_name: '' }, /Thiếu thông tin/], [{ customer_city: undefined }, /Thiếu thông tin/], [{ customer_email: 'abc' }, /Email/],
            [{ customer_phone: 'abcdefgh' }, /Số điện thoại/], [{ customer_phone: '12' }, /Số điện thoại/], [{ customer_name: { a: 1 } }, /không hợp lệ/],
            [{ note: 'x'.repeat(501) }, /quá dài/], [{ payment_method: ['cod'] }, /Phương thức/], [{ session_id: '' }, /session_id/], [{ session_id: 'x'.repeat(101) }, /session_id/],
        ]) {
            const res = await call(OrderCtl.createOrder, { body: buyer(patch) });
            assert.strictEqual(res.code, 400, JSON.stringify(patch)); assert(re.test(res.body.message), res.body.message);
        }
        const viaHeader = await call(OrderCtl.createOrder, { body: buyer({ session_id: undefined }), headers: { 'x-session-id': 's_ram' } });
        assert.strictEqual(viaHeader.code, 201);
        assert.strictEqual(W.orders.length, 1, 'đơn lỗi không được tạo');
    });
    await test('đặt hàng: lỗi nghiệp vụ → 400 có thông báo; lỗi database → 500 chung chung, không lộ SQL', async () => {
        let res = await call(OrderCtl.createOrder, { body: buyer({ session_id: 's_big' }) });
        assert.strictEqual(res.code, 400); assert(/không đủ tồn kho/.test(res.body.message));
        const orig = client.query;
        client.query = async () => { throw Object.assign(new Error("Table 'shoppc.orders' doesn't exist"), { code: 'ER_NO_SUCH_TABLE', sqlState: '42S02' }); };
        try { res = (await capture(() => call(OrderCtl.createOrder, { body: buyer() }))).result; } finally { client.query = orig; }
        assert.strictEqual(res.code, 500); assert(!/Table|shoppc|ER_/.test(JSON.stringify(res.body)));
    });
    await test('tra cứu đơn công khai: cần đúng SĐT; sai mã/sai SĐT/thiếu SĐT đều 404 như nhau', async () => {
        const o = await mkOrder();
        const track = (code, phone) => call(OrderCtl.trackOrder, { params: { orderCode: code }, query: phone === undefined ? {} : { phone } });
        const ok = await track(o.order_code, '0901-234-567'); assert.strictEqual(ok.code, 200); assert.strictEqual(ok.body.data.items.length, 1);
        assert.strictEqual((await track(o.order_code, '+84 901 234 567')).code, 404, 'đầu số khác thì không khớp');
        const misses = [await track(o.order_code, '0999999999'), await track(o.order_code), await track(o.order_code, '123'), await track('ORD-0', '0901234567'), await track(o.order_code, ['0901234567'])];
        for (const m of misses) { assert.strictEqual(m.code, 404); assert.deepStrictEqual(m.body, misses[0].body); }
    });
    await test('GET /orders: không page → toàn bộ (tương thích); có page → có meta; object injection bị bỏ', async () => {
        pagedCfg = { counts: [{ status: 'pending', n: 2 }], orders: [{ id: 1 }, { id: 2 }] };
        W.orders.push({ id: 1, status: 'pending', created_at: new Date() }, { id: 2, status: 'completed', created_at: new Date() });
        let res = await call(OrderCtl.getOrders, { query: { status: { a: 1 }, payment_status: ['x'] } });
        assert.strictEqual(res.body.meta, undefined); assert(Array.isArray(res.body.data));
        const legacySql = sqlLog.at(-1).sql; assert(!/status = /.test(legacySql), 'object/array không được vào SQL: ' + legacySql);
        res = await call(OrderCtl.getOrders, { query: { page: '1', limit: '2', status: 'pending' } });
        assert.strictEqual(res.body.data.length, 2); assert.strictEqual(res.body.meta.total, 2); assert.strictEqual(res.body.meta.counts.pending, 2);
        assert.strictEqual((await call(OrderCtl.getOrders, { query: { page: '1', status: 'xyz' } })).code, 400);
    });
    await test('đổi trạng thái / thanh toán / chi tiết / thống kê qua controller: mã lỗi đúng, không lộ nội bộ', async () => {
        const o = await mkOrder(); const staff = { id: 3 };
        let res = await call(OrderCtl.updateOrderStatus, { params: { id: String(o.id) }, body: { status: 'processing' }, user: staff });
        assert.strictEqual(res.code, 200); assert.strictEqual(res.body.data.status, 'processing');
        assert.deepStrictEqual([W.history.at(-1).changed_by], [3]);
        res = await call(OrderCtl.updateOrderStatus, { params: { id: String(o.id) }, body: { status: 'completed' } }); assert.strictEqual(res.code, 409);
        res = await call(OrderCtl.updateOrderStatus, { params: { id: '999' }, body: { status: 'shipped' } }); assert.strictEqual(res.code, 404);
        res = await call(OrderCtl.updateOrderStatus, { params: { id: String(o.id) }, body: {} }); assert.strictEqual(res.code, 400);
        res = await call(OrderCtl.updateOrderStatus, { params: { id: String(o.id) }, body: { status: 'shipped', note: 'x'.repeat(501) } }); assert.strictEqual(res.code, 400);
        res = await call(OrderCtl.updatePaymentStatus, { params: { id: String(o.id) }, body: { payment_status: 'paid' } }); assert.strictEqual(res.body.data.payment_status, 'paid');
        res = await call(OrderCtl.updatePaymentStatus, { params: { id: String(o.id) }, body: { payment_status: 5 } }); assert.strictEqual(res.code, 400);
        res = await call(OrderCtl.getOrderById, { params: { id: String(o.id) } }); assert.strictEqual(res.body.data.items.length, 1);
        assert.strictEqual((await call(OrderCtl.getOrderById, { params: { id: '999' } })).code, 404);
        res = await call(OrderCtl.getAnalytics, { query: { period: 'forever' } }); assert.strictEqual(res.code, 400); assert(/period/.test(res.body.message));
        res = await call(OrderCtl.getAnalytics, { query: { period: ['7d'] } }); assert.strictEqual(res.code, 200, 'mảng bị bỏ qua, dùng mặc định 30d');
        const orig = db.query; db.query = async () => { throw new Error("You have an error in your SQL syntax near 'orders'"); };
        try { res = (await capture(() => call(OrderCtl.getDashboardStats))).result; } finally { db.query = orig; }
        assert.strictEqual(res.code, 500); assert(!/SQL|syntax/.test(JSON.stringify(res.body)));
    });

    console.log('Hợp đồng dữ liệu với dashboard (frontend)');
    const fs = require('fs');
    const FE_TYPES = path.join(BE, '..', '..', 'shoppc-admin', 'src', 'types', 'index.ts');
    const feKeys = (name) => {
        const src = fs.readFileSync(FE_TYPES, 'utf8').replace(/\r/g, '');
        const m = new RegExp(`export interface ${name}[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(src);
        assert(m, `không tìm thấy interface ${name} trong frontend`);
        return [...m[1].matchAll(/^ {2}(\w+)\??:/gm)].map((x) => x[1]).sort();
    };
    const hasFrontend = fs.existsSync(FE_TYPES);
    const contractTest = (name, fn) => (hasFrontend ? test(name, fn) : console.log('  - bỏ qua (không có thư mục shoppc-admin):', name));
    const selectList = (re) => { const q = sqlLog.find((l) => re.test(l.sql)); assert(q, 'không thấy câu SQL'); return [...q.sql.replace(/\s+/g, ' ').match(/SELECT (.*?) FROM/)[1].split(',')].map((c) => c.trim().split(/ AS |\./).pop()).sort(); };

    await contractTest('DashboardStats: backend trả đúng các trường mà frontend khai báo (không thừa, không thiếu)', async () => {
        const s = await Order.getDashboardStats();
        assert.deepStrictEqual(Object.keys(s).sort(), feKeys('DashboardStats'));
        assert.deepStrictEqual(Object.keys(s.monthlyRevenue[0]).sort(), ['month', 'revenue']);
        assert.deepStrictEqual(Object.keys(s.topProducts[0]).sort(), feKeys('TopProduct'));
        assert.deepStrictEqual(Object.keys(s.lowStockList[0]).sort(), ['id', 'name', 'stock']);
        const recent = selectList(/FROM orders ORDER BY created_at DESC, id DESC LIMIT 5/);
        assert.deepStrictEqual(recent, ['created_at', 'customer_name', 'id', 'order_code', 'status', 'total_amount'], 'recentOrders: các cột SQL khớp Pick<Order,…> ở frontend');
    });
    await contractTest('Analytics: backend trả đúng các trường mà frontend khai báo', async () => {
        const a = await Analytics.getAnalytics({ period: '7d' });
        assert.deepStrictEqual(Object.keys(a).filter((k) => k !== 'note').sort(), feKeys('Analytics'));
        assert.deepStrictEqual(Object.keys(a.range).sort(), ['from', 'label', 'to']);
        assert.deepStrictEqual(Object.keys(a.by_status[0]).sort(), ['amount', 'label', 'orders', 'status']);
    });
    await contractTest('Danh sách đơn phân trang & chi tiết đơn: meta, items, history khớp kiểu ở frontend', async () => {
        const o = await mkOrder(); await Order.updateOrderStatus(o.id, 'processing', 1, 'ok');
        pagedCfg = { counts: [{ status: 'pending', n: 1 }], orders: [o] };
        const res = await call(OrderCtl.getOrders, { query: { page: '1', limit: '10' } });
        assert.deepStrictEqual(Object.keys(res.body.meta).sort(), ['counts', 'limit', 'page', 'pages', 'total']);
        assert.deepStrictEqual(Object.keys(res.body.meta.counts).sort(), ['all', ...OrderStatus.ORDER_STATUSES].sort());
        const detail = (await call(OrderCtl.getOrderById, { params: { id: String(o.id) } })).body.data;
        assert(Array.isArray(detail.items) && Array.isArray(detail.history));
        assert.deepStrictEqual(Object.keys(detail.history[0]).sort(), feKeys('OrderHistoryEntry'));
        const feItem = feKeys('OrderItem').filter((k) => !['product_image', 'created_at'].includes(k)); // trường tùy chọn ở frontend
        for (const k of feItem) assert(k in detail.items[0], `OrderItem thiếu ${k}`);
        const feOrder = feKeys('Order').filter((k) => !['note', 'updated_at', 'customer_ward', 'customer_district', 'customer_city'].includes(k));
        for (const k of feOrder) assert(k in detail, `Order thiếu ${k}`);
        assert.deepStrictEqual(selectList(/FROM order_status_history h/), ['changed_by', 'changed_by_name', 'created_at', 'id', 'new_status', 'note', 'old_status']);
    });
    await contractTest('trạng thái đơn ở frontend (types) đúng bằng danh sách của backend', () => {
        const src = fs.readFileSync(path.join(BE, '..', '..', 'shoppc-admin', 'src', 'utils', 'orderStatus.ts'), 'utf8');
        const m = /export const ORDER_STATUSES: OrderStatus\[\] = \[(.*?)\]/.exec(src);
        assert.deepStrictEqual([...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]), OrderStatus.ORDER_STATUSES);
    });

    console.log('Kiểm tra dữ liệu sản phẩm / danh mục');
    const resetProduct = () => { Product.__calls = []; Object.assign(Product, {
        createProduct: async (d) => { Product.__calls.push(['create', d]); return 11; },
        updateProduct: async (id, d) => { Product.__calls.push(['update', id, d]); return id === 404 ? 0 : 1; },
        setStock: async (id, q) => { Product.__calls.push(['stock', id, q]); return id === 404 ? 0 : 1; },
        deleteProduct: async (id) => { Product.__calls.push(['delete', id]); if (id === 13) throw Object.assign(new Error('Cannot delete or update a parent row: a foreign key constraint fails'), { code: 'ER_ROW_IS_REFERENCED_2' }); return id === 404 ? 0 : 1; },
        getProductById: async (id) => ({ id: Number(id), name: 'P' }),
        getAllProducts: async (f) => { Product.__calls.push(['list', f]); return []; },
    }); Object.assign(Category, {
        getCategoryById: async (id) => ({ 1: { id: 1, parent_id: null }, 2: { id: 2, parent_id: 1 }, 3: { id: 3, parent_id: 2 } })[id],
        createCategory: async (d) => { Category.__last = d; return 9; },
        updateCategory: async (id, d) => { Category.__last = [id, d]; return id === 404 ? 0 : 1; },
        deleteCategory: async (id) => { if (id === 1) throw new Error('Cannot delete category with subcategories'); if (id === 2) throw new Error('Cannot delete category with products'); return 1; },
    }); };
    await test('tạo sản phẩm: dữ liệu hợp lệ được chuẩn hóa; sai thì 400 và không gọi DB', async () => {
        resetProduct();
        let res = await call(ProductCtl.createProduct, { body: { name: '  Laptop  ', price: '15000000', category_id: '1', stock: '5', extra: 'x', id: 99, specs: { RAM: '16GB' }, image_url: '/img/a.png' } });
        assert.strictEqual(res.code, 201);
        assert.deepStrictEqual(Product.__calls[0][1], { name: 'Laptop', price: 15000000, stock: 5, category_id: 1, specs: { RAM: '16GB' }, image_url: '/img/a.png' });
        Product.__calls.length = 0;
        for (const [patch, re] of [[{ name: '' }, /Tên sản phẩm/], [{ name: { a: 1 } }, /Tên sản phẩm/], [{ price: 1.5 }, /Giá phải là số nguyên/], [{ price: -1 }, /Giá/], [{ price: undefined }, /Thiếu Giá/],
            [{ stock: -3 }, /Tồn kho/], [{ category_id: 'abc' }, /Danh mục/], [{ category_id: 99 }, /Danh mục không tồn tại/], [{ image_url: 'javascript:alert(1)' }, /Link ảnh/], [{ specs: [1] }, /Thông số/], [{ description: 'x'.repeat(5001) }, /quá dài/]]) {
            res = await call(ProductCtl.createProduct, { body: { name: 'A', price: 1000, category_id: 1, ...patch } });
            assert.strictEqual(res.code, 400, JSON.stringify(patch)); assert(re.test(res.body.message), res.body.message);
        }
        assert.strictEqual(Product.__calls.length, 0);
    });
    await test('sửa / tồn kho / xóa sản phẩm: một phần dữ liệu, 404, khóa ngoại → 409, id lạ → 400', async () => {
        resetProduct();
        let res = await call(ProductCtl.updateProduct, { params: { id: '5' }, body: { price: 900000, junk: 1 } });
        assert.strictEqual(res.code, 200); assert.deepStrictEqual(Product.__calls[0], ['update', 5, { price: 900000 }]);
        assert.strictEqual((await call(ProductCtl.updateProduct, { params: { id: '5' }, body: { junk: 1 } })).code, 400);
        assert.strictEqual((await call(ProductCtl.updateProduct, { params: { id: '404' }, body: { price: 1 } })).code, 404);
        assert.strictEqual((await call(ProductCtl.updateProduct, { params: { id: '1 OR 1=1' }, body: { price: 1 } })).code, 400);
        assert.strictEqual((await call(ProductCtl.updateStock, { params: { id: '5' }, body: { quantity: '12' } })).code, 200);
        for (const q of [-1, 1.5, 'abc', undefined, 1e9]) assert.strictEqual((await call(ProductCtl.updateStock, { params: { id: '5' }, body: { quantity: q } })).code, 400, String(q));
        assert.strictEqual((await call(ProductCtl.deleteProduct, { params: { id: '404' } })).code, 404);
        res = await call(ProductCtl.deleteProduct, { params: { id: '13' } });
        assert.strictEqual(res.code, 409); assert(!/foreign key|parent row/i.test(res.body.message));
    });
    await test('GET /products công khai: ?category_id[a]=1 (object injection) bị chặn; giá trị hợp lệ được chuyển tiếp', async () => {
        resetProduct();
        for (const q of [{ category_id: { a: '1' } }, { type: { a: 1 } }, { search: ['x'] }, { type: 'laptop' }, { category_id: 'abc' }]) {
            const res = await call(ProductCtl.getAllProducts, { query: q });
            assert.strictEqual(res.code, 400, JSON.stringify(q));
        }
        assert.strictEqual(Product.__calls.length, 0);
        await call(ProductCtl.getAllProducts, { query: { category_id: '3', type: 'pc', search: 'dell' } });
        assert.deepStrictEqual(Product.__calls[0], ['list', { category_id: 3, type: 'pc', search: 'dell' }]);
    });
    await test('danh mục: kiểm tra tên/loại, danh mục cha tồn tại, không tạo vòng lặp, xóa trả thông báo rõ', async () => {
        resetProduct();
        let res = await call(CategoryCtl.createCategory, { body: { name: ' RAM ', type: 'component', parent_id: 1 } });
        assert.strictEqual(res.code, 201); assert.deepStrictEqual(Category.__last, { name: 'RAM', type: 'component', parent_id: 1 });
        for (const [b, re] of [[{ name: '', type: 'pc' }, /Tên danh mục/], [{ name: 'A', type: 'laptop' }, /Loại danh mục/], [{ name: 'A', type: 'pc', parent_id: 77 }, /Danh mục cha không tồn tại/], [{ name: 'A', type: 'pc', parent_id: 'x' }, /Danh mục cha/]]) {
            res = await call(CategoryCtl.createCategory, { body: b }); assert.strictEqual(res.code, 400, JSON.stringify(b)); assert(re.test(res.body.message), res.body.message);
        }
        res = await call(CategoryCtl.updateCategory, { params: { id: '1' }, body: { parent_id: 1 } }); assert.strictEqual(res.code, 400); assert(/chính nó/.test(res.body.message));
        res = await call(CategoryCtl.updateCategory, { params: { id: '1' }, body: { parent_id: 3 } }); assert.strictEqual(res.code, 400, 'cha là cháu của chính nó => vòng lặp');
        res = await call(CategoryCtl.updateCategory, { params: { id: '3' }, body: { parent_id: null } }); assert.strictEqual(res.code, 200); assert.deepStrictEqual(Category.__last, [3, { parent_id: null }]);
        assert.strictEqual((await call(CategoryCtl.updateCategory, { params: { id: '3' }, body: {} })).code, 400);
        assert.strictEqual((await call(CategoryCtl.deleteCategory, { params: { id: '1' } })).code, 409);
        res = await call(CategoryCtl.deleteCategory, { params: { id: '2' } }); assert.strictEqual(res.code, 409); assert(/còn sản phẩm/.test(res.body.message));
        assert.strictEqual((await call(CategoryCtl.deleteCategory, { params: { id: '3' } })).code, 200);
    });

    console.log('Lớp bảo vệ (middleware)');
    await test('rateLimit: chặn sau max, có Retry-After, tách theo IP, hết cửa sổ thì cho qua', async () => {
        const lim = rateLimit({ windowMs: 60000, max: 3, message: 'Chậm lại' });
        const hit = (ip) => { const res = mkRes(); let next = false; lim({ ip }, res, () => { next = true; }); return { res, next }; };
        for (let i = 0; i < 3; i++) assert(hit('1.1.1.1').next);
        const blocked = hit('1.1.1.1');
        assert(!blocked.next && blocked.res.code === 429 && blocked.res.body.message === 'Chậm lại' && Number(blocked.res.headers['Retry-After']) > 0);
        assert(hit('2.2.2.2').next, 'IP khác không bị ảnh hưởng');
        const real = Date.now; Date.now = () => real() + 61000;
        try { assert(hit('1.1.1.1').next, 'hết cửa sổ thời gian thì được qua'); } finally { Date.now = real; }
    });
    await test('securityHeaders: header cơ bản; HSTS chỉ ở production; no-store cho API nhạy cảm (kể cả có query)', () => {
        const run = (reqPath) => { const res = mkRes(); Sec.securityHeaders({ path: reqPath }, res, () => {}); return res.headers; };
        let h = run('/api/products');
        assert.strictEqual(h['X-Content-Type-Options'], 'nosniff'); assert.strictEqual(h['X-Frame-Options'], 'DENY'); assert.strictEqual(h['Strict-Transport-Security'], undefined);
        assert.strictEqual(h['Cache-Control'], undefined);
        for (const p of ['/api/orders', '/api/orders/12/status', '/api/auth/login', '/api/users/me', '/api/chat']) assert.strictEqual(run(p)['Cache-Control'], 'no-store', p);
        process.env.NODE_ENV = 'production'; h = run('/api/products'); assert(/max-age=\d+/.test(h['Strict-Transport-Security']));
    });
    await test('CORS: có CORS_ORIGINS thì chỉ cho domain trong danh sách (bỏ dấu / cuối); không đặt thì cho tất cả', () => {
        corsCalls.length = 0; process.env.CORS_ORIGINS = ' https://shop.vn/ , https://admin.vn ';
        Sec.corsMiddleware();
        const origin = corsCalls.at(-1).origin; const check = (o) => { let out; origin(o, (e, ok) => { out = ok; }); return out; };
        assert.strictEqual(check('https://shop.vn'), true); assert.strictEqual(check('https://admin.vn/'), true);
        assert.strictEqual(check('https://evil.com'), false); assert.strictEqual(check(undefined), true);
        delete process.env.CORS_ORIGINS; Sec.corsMiddleware(); assert.strictEqual(corsCalls.at(-1), undefined, 'không giới hạn khi không cấu hình');
    });
    await test('hideServerErrors: production che thông báo 500, môi trường khác & mã 4xx giữ nguyên', async () => {
        const send = async (status, env) => {
            if (env) process.env.NODE_ENV = env; else delete process.env.NODE_ENV;
            const res = mkRes(); Sec.hideServerErrors({ method: 'GET', originalUrl: '/x' }, res, () => {});
            res.status(status).json({ success: false, message: "ER_BAD_FIELD_ERROR: Unknown column 'x'", error: 'stack...' }); return res.body;
        };
        let b; ({ result: b } = await capture(() => send(500, 'production')));
        assert(!/ER_|column/.test(b.message) && b.error === undefined);
        assert(/ER_BAD_FIELD/.test((await send(500, undefined)).message));
        assert(/ER_BAD_FIELD/.test((await send(400, 'production')).message));
        assert(/ER_BAD_FIELD/.test((await send(503, 'production')).message), 'lỗi 503 có chủ đích giữ nguyên');
    });
    await test('errorHandler: 5xx che ở production; JSON hỏng / quá lớn có thông báo tiếng Việt', async () => {
        const handle = (err, env) => { if (env) process.env.NODE_ENV = env; else delete process.env.NODE_ENV; const res = mkRes(); errorHandler(err, {}, res, () => {}); return res; };
        const { result: p } = await capture(async () => handle(new Error('secret SQL'), 'production'));
        assert.strictEqual(p.code, 500); assert(!/secret/.test(p.body.message)); assert.strictEqual(p.body.error, undefined);
        const parse = handle(Object.assign(new SyntaxError('Unexpected token'), { status: 400, type: 'entity.parse.failed' }), 'production');
        assert.strictEqual(parse.code, 400); assert(/JSON/.test(parse.body.message));
        assert(/quá lớn/.test(handle(Object.assign(new Error('x'), { status: 413, type: 'entity.too.large' })).body.message));
        const { result: d } = await capture(async () => handle(new Error('chi tiết'), 'development')); assert(/chi tiết/.test(d.body.message) && d.body.error);
    });

    console.log('Wiring của route');
    await test('route đơn hàng: công khai có giới hạn tần suất; còn lại cần đăng nhập + nhân viên; /analytics trước /:id', () => {
        const publicRoutes = [['get', '/track/:orderCode'], ['post', '/']];
        for (const [m, p] of publicRoutes) { const h = find(orderRoutes, m, p).handlers; assert.strictEqual(h.length, 2, `${m} ${p}`); assert(!h.includes(Auth.authenticate)); }
        const staffRoutes = [['get', '/'], ['get', '/dashboard/stats'], ['get', '/analytics'], ['get', '/:id(\\d+)'], ['get', '/:id(\\d+)/items'], ['patch', '/:id(\\d+)/status'], ['patch', '/:id(\\d+)/payment']];
        for (const [m, p] of staffRoutes) assert.deepStrictEqual(find(orderRoutes, m, p).handlers.slice(0, 2), [Auth.authenticate, Auth.authorizeStaff], `${m} ${p}`);
        const order = orderRoutes.routes.map((r) => `${r.method} ${r.path}`);
        assert(order.indexOf('get /analytics') < order.indexOf('get /:id(\\d+)'));
        assert.strictEqual(find(orderRoutes, 'patch', '/:id(\\d+)/status').handlers.at(-1), OrderCtl.updateOrderStatus);
    });
    await test('đăng nhập/đăng ký/quên mật khẩu có giới hạn tần suất dùng CHUNG ở /api/auth và /api/users (không né được)', () => {
        assert.strictEqual(find(authRoutes, 'post', '/login').handlers[0], Limiters.loginLimiter);
        assert.strictEqual(find(userRoutes, 'post', '/login').handlers[0], Limiters.loginLimiter);
        assert.strictEqual(find(authRoutes, 'post', '/register').handlers[0], Limiters.registerLimiter);
        assert.strictEqual(find(userRoutes, 'post', '/register').handlers[0], Limiters.registerLimiter);
        assert.strictEqual(find(authRoutes, 'post', '/forgot-password').handlers[0], Limiters.forgotLimiter);
        assert.strictEqual(find(authRoutes, 'post', '/reset-password').handlers[0], Limiters.forgotLimiter);
    });
    await test('route sản phẩm: GET công khai vẫn không cần đăng nhập (storefront)', () => {
        for (const p of ['/', '/:id']) assert.strictEqual(find(productRoutes, 'get', p).handlers.length, 1);
    });

    console.log(`\n${passed} test đạt`);
})();
