// Kiểm thử mã giảm giá: quy tắc tính tiền, kiểm tra dữ liệu admin nhập, API "Áp dụng" ở trang thanh toán, phân quyền route.
// (Phần trừ lượt / trả lượt trong transaction đặt hàng nằm ở tests/orders.test.js.)
// Chạy:  node tests/coupons.test.js
const assert = require('assert');
const H = require('./helpers/harness');
const { src } = H;
delete process.env.NODE_ENV;
delete process.env.FREE_SHIP_THRESHOLD;
delete process.env.SHIPPING_FEE;
process.env.APP_TIMEZONE = 'Asia/Ho_Chi_Minh';

const coupons = [];
const usedOrders = [];
const carts = {};
const CouponStub = {
    COLUMNS: '*',
    list: async () => coupons,
    getById: async (id) => coupons.find((c) => c.id === id) || null,
    getByCode: async (code) => coupons.find((c) => c.code === code) || null,
    ordersUsing: async (code) => usedOrders.filter((o) => o.code === code),
    create: async (d) => { if (coupons.some((c) => c.code === d.code)) { const e = new Error('dup'); e.code = 'ER_DUP_ENTRY'; throw e; } const id = coupons.length + 1; coupons.push({ id, used_count: 0, ...d }); return id; },
    update: async (id, d) => Object.assign(coupons.find((c) => c.id === id), d),
    remove: async (id) => { const i = coupons.findIndex((c) => c.id === id); if (i < 0) return false; coupons.splice(i, 1); return true; },
};
const CartStub = {
    getCart: async (sid) => { const items = carts[sid] || []; return { items, total: items.reduce((s, i) => s + i.price * i.quantity, 0) }; },
};
H.install(new Map([
    [src('config/database.js'), { query: async () => [], pool: {} }],
    [src('models/Coupon.js'), CouponStub],
    [src('models/Cart.js'), CartStub],
    [src('models/User.js'), {}],
]));

const C = require(src('services/coupons.js'));
const Ctl = require(src('controllers/couponController.js'));
const routes = require(src('routes/couponRoutes.js'));
const Auth = require(src('middlewares/auth.js'));
const { test, done } = H.runner();

const base = { id: 1, code: 'GIAM10', type: 'percentage', value: 10, min_order_value: 0, max_discount: null, usage_limit: null, used_count: 0, once_per_customer: false, starts_on: null, expires_on: null, is_active: true };
const reset = () => {
    coupons.length = 0; usedOrders.length = 0;
    for (const k of Object.keys(carts)) delete carts[k];
    coupons.push(
        { ...base },
        { ...base, id: 2, code: 'BOT200K', type: 'fixed', value: 200000, min_order_value: 1000000, once_per_customer: true },
        { ...base, id: 3, code: 'TAMNGUNG', is_active: false },
    );
    carts.s1 = [{ product_id: 1, price: 1500000, quantity: 2 }];
    carts.empty = [];
};

(async () => {
    console.log('Quy tắc tính giảm giá');
    await test('chuẩn hóa mã khách gõ: bỏ khoảng trắng, chữ hoa; ký tự lạ / quá ngắn / không phải chuỗi -> null', () => {
        assert.strictEqual(C.normalizeCode(' giam 10 '), 'GIAM10');
        assert.strictEqual(C.normalizeCode('tet-2027_vip'), 'TET-2027_VIP');
        for (const bad of ['ab', 'GIẢM10', "x' OR 1=1", 'A'.repeat(31), 123, null, { $ne: 1 }]) assert.strictEqual(C.normalizeCode(bad), null, String(bad));
    });
    await test('% có trần, % không trần, số tiền cố định; luôn là số nguyên và không vượt quá tiền hàng', () => {
        assert.strictEqual(C.computeDiscount({ type: 'percentage', value: '10.00', max_discount: '150000.00' }, 3000000), 150000);
        assert.strictEqual(C.computeDiscount({ type: 'percentage', value: 10, max_discount: null }, 3000000), 300000);
        assert.strictEqual(C.computeDiscount({ type: 'percentage', value: 7, max_discount: null }, 1234567), 86419, 'làm tròn xuống, không ra số lẻ');
        assert.strictEqual(C.computeDiscount({ type: 'fixed', value: '200000.00', max_discount: '1.00' }, 3000000), 200000, 'trần chỉ áp dụng cho loại %');
        assert.strictEqual(C.computeDiscount({ type: 'fixed', value: 500000 }, 300000), 300000);
        assert.strictEqual(C.computeDiscount({ type: 'percentage', value: 100 }, 300000), 300000);
    });
    await test('lý do không dùng được: ngừng áp dụng, chưa tới ngày, hết hạn (ngày cuối vẫn dùng được), hết lượt, chưa đủ tối thiểu, đã dùng', () => {
        const r = (c, ctx = {}) => C.unusableReason({ ...base, ...c }, { subtotal: 3000000, today: '2026-10-06', ...ctx });
        assert.strictEqual(r({}), null);
        assert.match(C.unusableReason(null, { subtotal: 1 }), /không tồn tại/);
        assert.match(r({ is_active: 0 }), /không tồn tại hoặc đã ngừng/);
        assert.match(r({ starts_on: '2026-10-07' }), /áp dụng từ ngày 07\/10\/2026/);
        assert.strictEqual(r({ starts_on: '2026-10-06', expires_on: '2026-10-06' }), null, 'tính cả ngày bắt đầu và ngày hết hạn');
        assert.match(r({ expires_on: '2026-10-05' }), /hết hạn/);
        assert.match(r({ usage_limit: 5, used_count: 5 }), /hết lượt/);
        assert.strictEqual(r({ usage_limit: 5, used_count: 4 }), null);
        assert.match(r({ min_order_value: 5000000 }), /tối thiểu 5\.000\.000₫.*còn thiếu 2\.000\.000₫/);
        assert.strictEqual(r({ once_per_customer: 1 }, { usedByCustomer: true }) !== null, true);
        assert.strictEqual(r({ once_per_customer: 0 }, { usedByCustomer: true }), null);
    });
    await test('ngày dạng Date (mysql2) được đọc theo ngày, không lệch múi giờ', () => {
        assert.strictEqual(C.ymd(new Date(2026, 9, 6)), '2026-10-06');
        assert.strictEqual(C.ymd('2026-10-06'), '2026-10-06');
        assert.strictEqual(C.ymd(null), null);
    });
    await test('khách đã dùng mã: so SĐT theo phần số, email không phân biệt hoa thường', () => {
        const prev = [{ customer_phone: '0901 234 567', customer_email: 'A@x.vn' }];
        assert.strictEqual(C.customerHasUsed(prev, { phone: '+84? no', email: '' }), false);
        assert.strictEqual(C.customerHasUsed(prev, { phone: '0901-234-567', email: '' }), true);
        assert.strictEqual(C.customerHasUsed(prev, { phone: '', email: ' a@X.vn ' }), true);
        assert.strictEqual(C.customerHasUsed(prev, { phone: '', email: '' }), false);
    });
    await test('mô tả ngắn hiển thị cho khách', () => {
        assert.strictEqual(C.summary({ type: 'percentage', value: '10.00', max_discount: '500000.00', min_order_value: '0.00' }), 'Giảm 10% (tối đa 500.000₫)');
        assert.strictEqual(C.summary({ type: 'fixed', value: 200000, min_order_value: 1000000 }), 'Giảm 200.000₫ cho đơn từ 1.000.000₫');
    });

    console.log('Admin tạo / sửa / xóa mã');
    await test('tạo mã hợp lệ: chuẩn hóa mã, ô trống thành "không giới hạn"', async () => {
        reset();
        const r = await H.call(Ctl.create, { body: { code: 'tet2027', type: 'percentage', value: '15', max_discount: '', usage_limit: '', min_order_value: '', starts_on: '2027-01-20', expires_on: '2027-02-10', once_per_customer: true, is_active: true } });
        assert.strictEqual(r.code, 201, JSON.stringify(r.body));
        const c = coupons.find((x) => x.code === 'TET2027');
        assert.deepStrictEqual([c.value, c.max_discount, c.usage_limit, c.min_order_value, c.once_per_customer, c.is_active], [15, null, null, 0, 1, 1]);
    });
    await test('dữ liệu sai bị từ chối với thông báo rõ ràng', async () => {
        reset();
        const bad = async (body, re) => { const r = await H.call(Ctl.create, { body: { code: 'MOI01', type: 'fixed', value: 100000, ...body } }); assert.strictEqual(r.code, 400, JSON.stringify(body)); assert.match(r.body.message, re); };
        await bad({ code: 'a b!' }, /3–30 ký tự/);
        await bad({ type: 'free' }, /Loại giảm giá không hợp lệ/);
        await bad({ value: 0 }, /Mức giảm không hợp lệ/);
        await bad({ value: -5 }, /Mức giảm không hợp lệ/);
        await bad({ type: 'percentage', value: 120 }, /từ 1 đến 100/);
        await bad({ value: 600000, min_order_value: 500000 }, /không được lớn hơn giá trị đơn tối thiểu/);
        await bad({ starts_on: '2027-02-10', expires_on: '2027-01-01' }, /Ngày hết hạn phải sau ngày bắt đầu/);
        await bad({ expires_on: '10/02/2027' }, /YYYY-MM-DD/);
        await bad({ usage_limit: 0 }, /Số lượt sử dụng/);
        await bad({ once_per_customer: 'có' }, /true\/false/);
        const dup = await H.call(Ctl.create, { body: { code: 'giam10', type: 'fixed', value: 1000 } });
        assert.strictEqual(dup.code, 409); assert.match(dup.body.message, /đã tồn tại/);
    });
    await test('sửa một phần: kiểm tra chéo với dữ liệu hiện có; không cho đặt số lượt nhỏ hơn số đã dùng; tạm ngưng mã', async () => {
        reset(); coupons[0].used_count = 7;
        let r = await H.call(Ctl.update, { params: { id: '1' }, body: { value: 150 } });
        assert.strictEqual(r.code, 400); assert.match(r.body.message, /từ 1 đến 100/);
        r = await H.call(Ctl.update, { params: { id: '1' }, body: { usage_limit: 5 } });
        assert.strictEqual(r.code, 400); assert.match(r.body.message, /đã dùng \(7\)/);
        r = await H.call(Ctl.update, { params: { id: '1' }, body: { is_active: false } });
        assert.strictEqual(r.code, 200); assert.strictEqual(coupons[0].is_active, 0);
        r = await H.call(Ctl.update, { params: { id: '1' }, body: {} });
        assert.strictEqual(r.code, 400);
        r = await H.call(Ctl.update, { params: { id: '99' }, body: { value: 5 } });
        assert.strictEqual(r.code, 404);
        r = await H.call(Ctl.update, { params: { id: 'abc' }, body: { value: 5 } });
        assert.strictEqual(r.code, 400);
    });
    await test('xóa mã', async () => {
        reset();
        assert.strictEqual((await H.call(Ctl.remove, { params: { id: '3' } })).code, 200);
        assert.strictEqual((await H.call(Ctl.remove, { params: { id: '3' } })).code, 404);
    });

    console.log('Khách bấm "Áp dụng" ở trang thanh toán');
    await test('mã hợp lệ: trả về số tiền giảm, phí ship và tổng mới tính từ giỏ hàng THẬT (không tin số tiền client gửi)', async () => {
        reset();
        const r = await H.call(Ctl.check, { body: { code: ' giam10 ', session_id: 's1', subtotal: 999999999 } });
        assert.strictEqual(r.code, 200, JSON.stringify(r.body));
        assert.deepStrictEqual({ ...r.body.data, summary: undefined, description: undefined }, { code: 'GIAM10', summary: undefined, description: undefined, subtotal: 3000000, discount: 300000, shipping_fee: 30000, total_amount: 2730000 });
        assert.match(r.body.message, /giảm 300\.000₫/);
    });
    await test('mã sai / tạm ngưng / giỏ trống / thiếu giỏ: báo lỗi 400', async () => {
        reset();
        const msg = async (body) => { const r = await H.call(Ctl.check, { body }); assert.strictEqual(r.code, 400); return r.body.message; };
        assert.match(await msg({ code: 'KHONGCO', session_id: 's1' }), /không tồn tại/);
        assert.match(await msg({ code: 'TAMNGUNG', session_id: 's1' }), /ngừng áp dụng/);
        assert.match(await msg({ code: '!', session_id: 's1' }), /không hợp lệ/);
        assert.match(await msg({ code: 'GIAM10', session_id: 'empty' }), /Giỏ hàng đang trống/);
        assert.match(await msg({ code: 'GIAM10' }), /session_id/);
        carts.small = [{ product_id: 1, price: 300000, quantity: 1 }];
        assert.match(await msg({ code: 'BOT200K', session_id: 'small' }), /còn thiếu 700\.000₫/);
    });
    await test('"mỗi khách 1 lần": báo trước nếu khách đã nhập SĐT/email trùng đơn cũ', async () => {
        reset(); usedOrders.push({ code: 'BOT200K', customer_phone: '0901234567', customer_email: 'a@x.vn' });
        const ok = await H.call(Ctl.check, { body: { code: 'BOT200K', session_id: 's1' } });
        assert.strictEqual(ok.code, 200, 'chưa nhập SĐT thì chưa biết');
        const no = await H.call(Ctl.check, { body: { code: 'BOT200K', session_id: 's1', customer_phone: '090.123.4567' } });
        assert.strictEqual(no.code, 400); assert.match(no.body.message, /đã dùng/);
    });

    console.log('Phân quyền route');
    await test('/check công khai nhưng có giới hạn tần suất; xem danh sách = nhân viên; tạo/sửa/xóa = chỉ admin', () => {
        const find = (m, p) => routes.routes.find((r) => r.method === m && r.path === p);
        const check = find('post', '/check');
        assert.strictEqual(check.handlers.length, 2); assert.notStrictEqual(check.handlers[0], Auth.authenticate);
        assert.deepStrictEqual(find('get', '/').handlers.slice(0, 2), [Auth.authenticate, Auth.authorizeStaff]);
        for (const [m, p] of [['post', '/'], ['put', '/:id'], ['delete', '/:id']]) assert.deepStrictEqual(find(m, p).handlers.slice(0, 2), [Auth.authenticate, Auth.authorizeAdmin], `${m} ${p}`);
        assert(routes.routes.findIndex((r) => r.path === '/check') < routes.routes.findIndex((r) => r.method === 'post' && r.path === '/'));
    });

    done();
})();
