// Kiểm thử đánh giá sản phẩm: chỉ khách đã nhận hàng mới được đánh giá, mỗi khách 1 đánh giá / sản phẩm,
// nhân viên ẩn/hiện + trả lời, phân quyền route.
// Chạy:  node tests/reviews.test.js
const assert = require('assert');
const H = require('./helpers/harness');
const { src } = H;
delete process.env.NODE_ENV;

// "Database" trong bộ nhớ
let users, orders, reviews, nextId;
const events = [];
const reset = () => {
    users = {
        1: { id: 1, email: 'an@x.vn', full_name: 'Nguyễn An', role: 'customer', status: 'active' },
        2: { id: 2, email: 'binh@x.vn', full_name: 'Trần Bình', role: 'customer', status: 'active' },
        3: { id: 3, email: 'chi@x.vn', full_name: 'Lê Chi', role: 'customer', status: 'active' },
    };
    // product 10: An đã nhận hàng; Bình mới đặt (chờ giao); Chi đặt khi chưa đăng nhập (user_id null, cùng email) và đã giao
    orders = [
        { id: 100, user_id: 1, customer_email: 'an@x.vn', status: 'completed', products: [10, 11] },
        { id: 101, user_id: 2, customer_email: 'binh@x.vn', status: 'shipped', products: [10] },
        { id: 102, user_id: null, customer_email: 'CHI@x.vn', status: 'delivered', products: [10] },
        { id: 103, user_id: 2, customer_email: 'binh@x.vn', status: 'cancelled', products: [11] },
    ];
    reviews = [];
    events.length = 0;
    nextId = 1;
};
const ReviewStub = {
    purchasesOf: async (productId, userId, email) => orders
        .filter((o) => o.products.includes(productId) && o.status !== 'cancelled' && (o.user_id === userId || (o.user_id === null && o.customer_email.toLowerCase() === String(email).toLowerCase())))
        .map(({ id, status }) => ({ id, status })),
    summary: async (productId) => {
        const vis = reviews.filter((r) => r.product_id === productId && r.status === 'visible');
        const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        vis.forEach((r) => { distribution[r.rating] += 1; });
        return { average: vis.length ? Math.round((vis.reduce((s, r) => s + r.rating, 0) / vis.length) * 10) / 10 : 0, count: vis.length, distribution };
    },
    listVisible: async (productId, { limit, offset, rating }) => reviews
        .filter((r) => r.product_id === productId && r.status === 'visible' && (!rating || r.rating === rating))
        .slice(offset, offset + limit).map((r) => ({ ...r, customer_name: users[r.user_id].full_name })),
    mine: async (productId, userId) => reviews.find((r) => r.product_id === productId && r.user_id === userId) || null,
    upsert: async ({ productId, userId, orderId, rating, comment }) => {
        let r = reviews.find((x) => x.product_id === productId && x.user_id === userId);
        if (r) Object.assign(r, { rating, comment, order_id: orderId });
        else { r = { id: nextId++, product_id: productId, user_id: userId, order_id: orderId, rating, comment, status: 'visible', admin_reply: null }; reviews.push(r); }
        return { ...r };
    },
    removeMine: async (productId, userId) => { const i = reviews.findIndex((r) => r.product_id === productId && r.user_id === userId); if (i < 0) return false; reviews.splice(i, 1); return true; },
    adminList: async ({ status }) => { const items = reviews.filter((r) => !status || r.status === status); return { items, counts: { all: reviews.length, visible: reviews.filter((r) => r.status === 'visible').length, hidden: reviews.filter((r) => r.status === 'hidden').length }, total: items.length }; },
    getById: async (id) => reviews.find((r) => r.id === id) || null,
    setStatus: async (id, status) => { reviews.find((r) => r.id === id).status = status; },
    setReply: async (id, reply) => { Object.assign(reviews.find((r) => r.id === id), { admin_reply: reply }); },
    remove: async (id) => { const i = reviews.findIndex((r) => r.id === id); if (i < 0) return false; reviews.splice(i, 1); return true; },
};
H.install(new Map([
    [src('config/database.js'), { query: async () => [], pool: {} }],
    [src('models/ProductReview.js'), ReviewStub],
    [src('models/User.js'), { getUserById: async (id) => users[id] || null }],
    [src('realtime/events.js'), { reviewChanged: (r) => events.push(r), orderNew() {}, orderUpdated() {}, productChanged() {} }],
]));

const R = require(src('services/reviews.js'));
const Ctl = require(src('controllers/reviewController.js'));
const routes = require(src('routes/reviewRoutes.js'));
const orderRoutes = require(src('routes/orderRoutes.js'));
const Auth = require(src('middlewares/auth.js'));
const Jwt = require(src('config/jwt.js'));
const { test, done } = H.runner();
const as = (id) => (id ? { id, username: `u${id}`, role: users[id].role } : undefined);
const list = (productId, user, query = {}) => H.call(Ctl.listForProduct, { params: { productId: String(productId) }, query, user: as(user) });
const send = (productId, user, body) => H.call(Ctl.submit, { params: { productId: String(productId) }, body, user: as(user) });

(async () => {
    console.log('Ai được đánh giá');
    await test('quy tắc: đơn "Đã giao"/"Hoàn tất" mới được; đơn đang xử lý → chờ nhận hàng; chưa mua → không', () => {
        assert.deepStrictEqual(R.eligibility([{ id: 5, status: 'shipped' }, { id: 4, status: 'delivered' }]), { can_review: true, reason: null, code: null, order_id: 4 });
        assert.strictEqual(R.eligibility([{ id: 5, status: 'completed' }]).can_review, true);
        for (const s of ['pending', 'processing', 'shipped']) assert.strictEqual(R.eligibility([{ id: 1, status: s }]).code, 'waiting', s);
        assert.strictEqual(R.eligibility([]).code, 'not_bought');
    });
    await test('trang sản phẩm: khách chưa đăng nhập vẫn xem được đánh giá, được nhắc đăng nhập', async () => {
        reset();
        const r = await list(10, null);
        assert.strictEqual(r.code, 200);
        assert.deepStrictEqual(r.body.data.viewer, { logged_in: false, can_review: false, reason: R.REASONS.login, code: 'login', my_review: null });
        assert.deepStrictEqual(r.body.data.summary, { average: 0, count: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } });
    });
    await test('đã nhận hàng → được đánh giá; đang giao → "sau khi nhận hàng"; chưa mua → "chỉ khách đã mua"; đơn đã hủy không tính', async () => {
        reset();
        assert.strictEqual((await list(10, 1)).body.data.viewer.can_review, true);
        assert.strictEqual((await list(10, 2)).body.data.viewer.code, 'waiting');
        assert.strictEqual((await list(12, 1)).body.data.viewer.code, 'not_bought');
        assert.strictEqual((await list(11, 2)).body.data.viewer.code, 'not_bought', 'đơn đã hủy không được tính là đã mua');
        assert(!('order_id' in (await list(10, 1)).body.data.viewer), 'không lộ mã đơn ra trình duyệt');
    });
    await test('đơn đặt lúc chưa đăng nhập nhưng cùng email tài khoản (không phân biệt hoa thường) vẫn được tính', async () => {
        reset();
        const r = await send(10, 3, { rating: 4, comment: 'Ổn' });
        assert.strictEqual(r.code, 201); assert.strictEqual(reviews[0].order_id, 102);
    });

    console.log('Gửi / sửa / xóa đánh giá');
    await test('chưa đủ điều kiện → 403 kèm lý do, không ghi gì', async () => {
        reset();
        let r = await send(10, 2, { rating: 5 });
        assert.strictEqual(r.code, 403); assert.strictEqual(r.body.code, 'waiting'); assert.match(r.body.message, /sau khi đã nhận được hàng/);
        r = await send(12, 1, { rating: 5 });
        assert.strictEqual(r.code, 403); assert.match(r.body.message, /Chỉ khách đã mua/);
        assert.strictEqual(reviews.length, 0); assert.strictEqual(events.length, 0);
    });
    await test('đánh giá lần đầu 201; gửi lại = sửa (200), vẫn chỉ 1 đánh giá; điểm trung bình cập nhật', async () => {
        reset(); events.length = 0;
        let r = await send(10, 1, { rating: 5, comment: '  Máy chạy  êm\n\n\n\nGiao nhanh  ' });
        assert.strictEqual(r.code, 201); assert.match(r.body.message, /Cảm ơn/);
        assert.strictEqual(reviews[0].comment, 'Máy chạy  êm\n\nGiao nhanh', 'cắt khoảng trắng, gộp dòng trống');
        assert.strictEqual(r.body.data.summary.average, 5);
        await send(10, 3, { rating: 2, comment: 'Hộp móp' });
        r = await send(10, 1, { rating: 4, comment: 'Sửa lại: 4 sao' });
        assert.strictEqual(r.code, 200); assert.match(r.body.message, /cập nhật/);
        assert.strictEqual(reviews.filter((x) => x.user_id === 1).length, 1);
        assert.deepStrictEqual(r.body.data.summary, { average: 3, count: 2, distribution: { 1: 0, 2: 1, 3: 0, 4: 1, 5: 0 } });
        assert.strictEqual(events.length, 3, 'báo realtime cho nhân viên');
    });
    await test('dữ liệu sai: số sao ngoài 1–5 / không phải số nguyên, nội dung quá dài hoặc không phải chữ → 400', async () => {
        reset();
        for (const body of [{}, { rating: 0 }, { rating: 6 }, { rating: 4.5 }, { rating: 'năm' }, { rating: 5, comment: 'x'.repeat(1001) }, { rating: 5, comment: { a: 1 } }]) {
            const r = await send(10, 1, body);
            assert.strictEqual(r.code, 400, JSON.stringify(body).slice(0, 40));
        }
        const ok = await send(10, 1, { rating: '5', comment: '   ' });
        assert.strictEqual(ok.code, 201); assert.strictEqual(reviews[0].comment, null, 'chỉ chấm sao, không cần viết');
    });
    await test('khách xóa đánh giá của mình', async () => {
        reset(); await send(10, 1, { rating: 5 });
        const del = (u) => H.call(Ctl.removeMine, { params: { productId: '10' }, user: as(u) });
        assert.strictEqual((await del(3)).code, 404, 'không xóa được đánh giá của người khác');
        assert.strictEqual(reviews.length, 1);
        assert.strictEqual((await del(1)).code, 200); assert.strictEqual(reviews.length, 0);
    });
    await test('danh sách công khai: chỉ đánh giá đang hiện, lọc theo số sao, phân trang 5/trang', async () => {
        reset();
        for (let i = 0; i < 7; i += 1) reviews.push({ id: 50 + i, product_id: 10, user_id: 1 + (i % 3), rating: i < 6 ? 5 : 1, comment: `#${i}`, status: i === 0 ? 'hidden' : 'visible' });
        let r = await list(10, null);
        assert.strictEqual(r.body.data.items.length, 5); assert.strictEqual(r.body.data.pages, 2); assert.strictEqual(r.body.data.summary.count, 6);
        assert(r.body.data.items.every((x) => x.status === 'visible'));
        r = await list(10, null, { rating: '1' });
        assert.strictEqual(r.body.data.items.length, 1); assert.strictEqual(r.body.data.pages, 1);
        assert.strictEqual((await list(10, null, { rating: '9' })).code, 400);
        assert.strictEqual((await H.call(Ctl.listForProduct, { params: { productId: 'abc' } })).code, 400);
    });
    await test('khách vẫn thấy đánh giá của mình khi bị ẩn (kèm trạng thái) để biết vì sao không hiện công khai', async () => {
        reset(); await send(10, 1, { rating: 1, comment: 'spam' }); reviews[0].status = 'hidden';
        const r = await list(10, 1);
        assert.strictEqual(r.body.data.items.length, 0); assert.strictEqual(r.body.data.viewer.my_review.status, 'hidden');
        await send(10, 1, { rating: 2, comment: 'sửa lại' });
        assert.strictEqual(reviews[0].status, 'hidden', 'sửa đánh giá không tự bỏ ẩn');
    });

    console.log('Nhân viên quản lý đánh giá');
    await test('ẩn/hiện + trả lời (bỏ trống = xóa phản hồi); dữ liệu sai 400; không có 404', async () => {
        reset(); await send(10, 1, { rating: 3 });
        const upd = (id, body) => H.call(Ctl.update, { params: { id: String(id) }, body });
        let r = await upd(1, { status: 'hidden', admin_reply: '  Cảm ơn anh, shop sẽ liên hệ.  ' });
        assert.strictEqual(r.code, 200); assert.strictEqual(reviews[0].status, 'hidden'); assert.strictEqual(reviews[0].admin_reply, 'Cảm ơn anh, shop sẽ liên hệ.');
        r = await upd(1, { admin_reply: '' }); assert.strictEqual(reviews[0].admin_reply, null);
        assert.strictEqual((await upd(1, { status: 'deleted' })).code, 400);
        assert.strictEqual((await upd(1, {})).code, 400);
        assert.strictEqual((await upd(1, { admin_reply: 'x'.repeat(1001) })).code, 400);
        assert.strictEqual((await upd(99, { status: 'visible' })).code, 404);
        const l = await H.call(Ctl.adminList, { query: { status: 'hidden' } });
        assert.strictEqual(l.body.data.length, 1); assert.deepStrictEqual(Object.keys(l.body.meta).sort(), ['counts', 'limit', 'page', 'pages', 'total']);
        assert.strictEqual((await H.call(Ctl.adminList, { query: { status: 'xyz' } })).code, 400);
        assert.strictEqual((await H.call(Ctl.remove, { params: { id: '1' } })).code, 200);
        assert.strictEqual((await H.call(Ctl.remove, { params: { id: '1' } })).code, 404);
    });

    console.log('Phân quyền route + đăng nhập không bắt buộc');
    await test('xem: công khai (đăng nhập không bắt buộc); gửi/xóa của mình: cần đăng nhập + giới hạn tần suất; quản lý: nhân viên; xóa hẳn: admin', () => {
        const find = (m, p) => routes.routes.find((r) => r.method === m && r.path === p).handlers;
        assert.deepStrictEqual(find('get', '/product/:productId(\\d+)').slice(0, 1), [Auth.optionalAuth]);
        const post = find('post', '/product/:productId(\\d+)');
        assert.strictEqual(post[0], Auth.authenticate); assert.strictEqual(post.length, 3, 'có giới hạn tần suất');
        assert.strictEqual(find('delete', '/product/:productId(\\d+)/mine')[0], Auth.authenticate);
        assert.deepStrictEqual(find('get', '/').slice(0, 2), [Auth.authenticate, Auth.authorizeStaff]);
        assert.deepStrictEqual(find('patch', '/:id(\\d+)').slice(0, 2), [Auth.authenticate, Auth.authorizeStaff]);
        assert.deepStrictEqual(find('delete', '/:id(\\d+)').slice(0, 2), [Auth.authenticate, Auth.authorizeAdmin]);
        assert(orderRoutes.routes.find((r) => r.method === 'post' && r.path === '/').handlers.includes(Auth.optionalAuth), 'đặt hàng gắn đơn vào tài khoản đang đăng nhập');
    });
    await test('optionalAuth: không token / token sai / tài khoản bị khóa → khách vãng lai (không 401); token đúng → req.user', async () => {
        reset();
        const run = async (authorization) => { const req = { headers: authorization ? { authorization } : {} }; let nexted = false; const res = H.mkRes(); await Auth.optionalAuth(req, res, () => { nexted = true; }); return { req, res, nexted }; };
        for (const h of [null, 'Bearer abc.def.ghi', 'Basic xyz']) { const r = await run(h); assert(r.nexted && !r.req.user && r.res.body === null, String(h)); }
        const ok = await run(`Bearer ${Jwt.signAccessToken(users[1])}`);
        assert.deepStrictEqual(ok.req.user, { id: 1, username: undefined, role: 'customer' });
        users[1].status = 'inactive';
        assert.strictEqual((await run(`Bearer ${Jwt.signAccessToken(users[1])}`)).req.user, undefined);
    });

    done();
})();
