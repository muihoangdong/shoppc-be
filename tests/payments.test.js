// Kiểm thử thanh toán chuyển khoản: mã VietQR (EMVCo/NAPAS), trang thanh toán, webhook SePay tự xác nhận.
// Chạy:  node tests/payments.test.js
const assert = require('assert');
const H = require('./helpers/harness');
const { src } = H;
delete process.env.NODE_ENV;

const orders = [];
const updates = [];
const OrderStub = {
    getOrderByCode: async (code) => orders.find((o) => o.order_code === code) || null,
    updatePaymentStatus: async (id, status, paymentId) => {
        const o = orders.find((x) => x.id === id);
        Object.assign(o, { payment_status: status, payment_id: paymentId || o.payment_id });
        updates.push([id, status, paymentId]);
        return { ...o };
    },
    getOrderById: async (id) => { const o = orders.find((x) => x.id === id); return o ? { ...o } : null; },
    markPaymentClaimed: async (id, quiet) => {
        const o = orders.find((x) => x.id === id);
        const fresh = !o.payment_claimed_at || Date.now() - new Date(o.payment_claimed_at).getTime() > quiet * 60000;
        if (fresh) o.payment_claimed_at = new Date();
        return { order: { ...o }, fresh };
    },
    clearPaymentClaim: async (id) => { const o = orders.find((x) => x.id === id); o.payment_claimed_at = null; return { ...o }; },
    publicOrder: (o) => o,
};
const events = [];
const notices = []; // sự kiện mới: payment:claimed / payment:received
const mails = [];
const settings = {}; // bảng shop_settings giả
H.install(new Map([
    [src('config/database.js'), { query: async () => [], pool: {} }],
    [src('models/Order.js'), OrderStub],
    [src('models/User.js'), {}],
    [src('models/ShopSetting.js'), {
        getMany: async (keys) => Object.fromEntries(keys.filter((k) => k in settings).map((k) => [k, settings[k]])),
        setMany: async (vals) => { for (const [k, v] of Object.entries(vals)) { if (v === null || v === undefined || v === '') delete settings[k]; else settings[k] = String(v); } },
    }],
    [src('services/mailer.js'), {
        sendPaymentClaimToShop: async (o) => { mails.push(['shop', o.order_code]); return { delivered: true }; },
        sendPaymentReceivedToCustomer: async (o) => { mails.push(['customer', o.order_code, o.customer_email]); return { delivered: true }; },
    }],
    [src('realtime/events.js'), {
        orderUpdated: (o, by) => events.push([o.order_code, o.payment_status, by && by.name]), orderNew() {}, productChanged() {},
        paymentClaimed: (o) => notices.push(['claimed', o.order_code]),
        paymentReceived: (o, by) => notices.push(['received', o.order_code, by && by.name]),
    }],
]));

const Q = require(src('services/vietqr.js'));
const Bank = require(src('config/bank.js'));
const Pay = require(src('services/payments.js'));
const PayCtl = require(src('controllers/paymentController.js'));
const OrderCtl = require(src('controllers/orderController.js'));
const BankSettings = require(src('services/bankSettings.js'));
const orderRoutes = require(src('routes/orderRoutes.js'));
const paymentRoutes = require(src('routes/paymentRoutes.js'));
const Auth = require(src('middlewares/auth.js'));
const { test, done } = H.runner();

const setBank = (env) => {
    for (const k of ['BANK_CODE', 'BANK_BIN', 'BANK_ACCOUNT_NO', 'BANK_ACCOUNT_NAME', 'BANK_NAME']) delete process.env[k];
    Object.assign(process.env, env);
};
const reset = () => {
    orders.length = 0; updates.length = 0; events.length = 0; notices.length = 0; mails.length = 0;
    for (const k of Object.keys(settings)) delete settings[k];
    BankSettings._clearCache();
    orders.push(
        { id: 1, order_code: 'ORD-1791176872988', customer_phone: '0354 334 944', total_amount: '36030000.00', payment_method: 'banking', payment_status: 'pending', payment_id: null, status: 'pending' },
        { id: 2, order_code: 'ORD-1791176872999', customer_phone: '0900000000', total_amount: '500000.00', payment_method: 'cod', payment_status: 'pending', payment_id: null, status: 'pending' },
        { id: 3, order_code: 'ORD-1791176873000', customer_phone: '0900000001', total_amount: '500000.00', payment_method: 'banking', payment_status: 'pending', payment_id: null, status: 'cancelled' },
    );
};
// Đọc lại chuỗi EMVCo thành cây {id: value} để kiểm tra
const parse = (s) => {
    const out = {}; let i = 0;
    while (i < s.length) { const id = s.slice(i, i + 2); const len = Number(s.slice(i + 2, i + 4)); out[id] = s.slice(i + 4, i + 4 + len); i += 4 + len; }
    return out;
};

(async () => {
    console.log('Mã VietQR');
    await test('CRC16-CCITT đúng chuẩn; chuỗi QR đúng cấu trúc NAPAS: BIN, số TK, số tiền, nội dung, mã kiểm tra', () => {
        assert.strictEqual(Q.crc16('123456789'), '29B1', 'giá trị kiểm tra chuẩn của CRC-16/CCITT-FALSE');
        const p = Q.buildPayload({ bin: '970422', accountNo: '0354334944', amount: 36030000, addInfo: 'ORD1791176872988' });
        const t = parse(p);
        assert.strictEqual(t['00'], '01'); assert.strictEqual(t['01'], '12', 'QR động (có số tiền)');
        const m = parse(t['38']); assert.strictEqual(m['00'], 'A000000727'); assert.strictEqual(m['02'], 'QRIBFTTA');
        assert.deepStrictEqual(parse(m['01']), { '00': '970422', '01': '0354334944' });
        assert.strictEqual(t['53'], '704'); assert.strictEqual(t['54'], '36030000'); assert.strictEqual(t['58'], 'VN');
        assert.deepStrictEqual(parse(t['62']), { '08': 'ORD1791176872988' });
        assert.strictEqual(t['63'], Q.crc16(p.slice(0, -4)), 'mã kiểm tra khớp');
        assert.strictEqual(parse(Q.buildPayload({ bin: '970422', accountNo: '1234' }))['01'], '11', 'không có số tiền -> QR tĩnh');
    });
    await test('nội dung chuyển khoản: bỏ dấu tiếng Việt và ký tự đặc biệt, tối đa 25 ký tự', () => {
        assert.strictEqual(Q.sanitizeInfo('Thanh toán đơn #ORD-123!'), 'Thanh toan don ORD123');
        assert.strictEqual(Q.sanitizeInfo('x'.repeat(40)).length, 25);
    });
    await test('cấu hình ngân hàng: mã ngân hàng → BIN; tên viết hoa; thiếu/sai → không hiện QR', () => {
        setBank({ BANK_CODE: 'mb', BANK_ACCOUNT_NO: '0354 334 944', BANK_ACCOUNT_NAME: 'Mui Hoang Dong' });
        assert.deepStrictEqual(Bank.bankAccount(), { bin: '970422', account_no: '0354334944', account_name: 'MUI HOANG DONG', bank_name: 'MB Bank' });
        setBank({ BANK_BIN: '970436', BANK_ACCOUNT_NO: '1', BANK_ACCOUNT_NAME: 'A' }); assert.strictEqual(Bank.bankAccount(), null, 'số TK quá ngắn');
        setBank({ BANK_CODE: 'KHONGCO', BANK_ACCOUNT_NO: '123456', BANK_ACCOUNT_NAME: 'A' }); assert.strictEqual(Bank.bankAccount(), null);
        setBank({ BANK_BIN: '970436', BANK_ACCOUNT_NO: '123456', BANK_ACCOUNT_NAME: 'A' }); assert.strictEqual(Bank.bankAccount().bank_name, 'Vietcombank');
    });

    console.log('Trang thanh toán của khách');
    await test('đơn chuyển khoản chưa trả: có tài khoản, nội dung = mã đơn bỏ gạch, ảnh QR; đã trả / đã hủy / COD: không có QR', async () => {
        reset(); setBank({ BANK_CODE: 'MB', BANK_ACCOUNT_NO: '0354334944', BANK_ACCOUNT_NAME: 'SHOPPC' });
        let info = await Pay.paymentInfo(orders[0]);
        assert.strictEqual(info.total_amount, 36030000); assert.strictEqual(info.transfer_content, 'ORD1791176872988');
        assert.deepStrictEqual(info.bank, { bank_name: 'MB Bank', account_no: '0354334944', account_name: 'SHOPPC' });
        assert(/^data:image\/png;base64,/.test(info.qr_data_url) && info.qr_data_url.length > 1000);
        info = await Pay.paymentInfo({ ...orders[0], payment_status: 'paid' }); assert.strictEqual(info.qr_data_url, null);
        info = await Pay.paymentInfo(orders[2]); assert.strictEqual(info.qr_data_url, null);
        info = await Pay.paymentInfo(orders[1]); assert.strictEqual(info.bank, null); assert.strictEqual(info.qr_data_url, null);
        setBank({}); info = await Pay.paymentInfo(orders[0]); assert.strictEqual(info.qr_data_url, null, 'chưa cấu hình ngân hàng');
    });
    await test('API công khai cần đúng mã đơn + SĐT (sai SĐT hay sai mã đều 404 giống nhau)', async () => {
        reset(); setBank({ BANK_CODE: 'MB', BANK_ACCOUNT_NO: '0354334944', BANK_ACCOUNT_NAME: 'SHOPPC' });
        let res = await H.call(OrderCtl.getPayment, { params: { orderCode: 'ORD-1791176872988' }, query: { phone: '0354334944' } });
        assert.strictEqual(res.code, 200); assert.strictEqual(res.body.data.order_code, 'ORD-1791176872988');
        res = await H.call(OrderCtl.getPayment, { params: { orderCode: 'ORD-1791176872988' }, query: { phone: '0999999999' } }); assert.strictEqual(res.code, 404);
        res = await H.call(OrderCtl.getPayment, { params: { orderCode: 'ORD-1' }, query: { phone: '0354334944' } }); assert.strictEqual(res.code, 404);
        res = await H.call(OrderCtl.getPayment, { params: { orderCode: 'ORD-1791176872988' }, query: {} }); assert.strictEqual(res.code, 404);
    });

    console.log('Webhook SePay (tự xác nhận đã thanh toán)');
    const tx = (patch = {}) => ({ id: 92704, gateway: 'MBBank', transactionDate: '2026-10-06 14:02:37', accountNumber: '0354334944', code: null, content: 'MUI HOANG DONG chuyen tien ORD1791176872988', transferType: 'in', transferAmount: 36030000, accumulated: 99000000, subAccount: null, referenceCode: 'FT123', description: '', ...patch });
    await test('nhận diện mã đơn trong nội dung: có/không gạch, chữ thường, có khoảng trắng, lẫn chữ khác', () => {
        for (const s of ['ORD1791176872988', 'ck ord-1791176872988 cam on', 'ORD 1791176872988', 'MBVCB.123.ORD1791176872988.CT tu 0123']) assert.strictEqual(Pay.findOrderCode(s), 'ORD-1791176872988', s);
        assert.strictEqual(Pay.findOrderCode('chuyen tien mua hang'), null);
    });
    await test('đủ tiền đúng đơn → đánh dấu đã thanh toán (lưu id giao dịch) + báo realtime; gửi lại cùng giao dịch → không xử lý lần 2', async () => {
        reset(); setBank({ BANK_CODE: 'MB', BANK_ACCOUNT_NO: '0354334944', BANK_ACCOUNT_NAME: 'SHOPPC' });
        let r = await Pay.handleSepayWebhook(tx());
        assert.deepStrictEqual(r, { matched: true, reason: 'paid', order_code: 'ORD-1791176872988' });
        assert.deepStrictEqual(updates, [[1, 'paid', 'sepay:92704']]); assert.deepStrictEqual(events, [['ORD-1791176872988', 'paid', 'SePay (tự động)']]);
        assert.deepStrictEqual(notices, [['received', 'ORD-1791176872988', 'SePay (tự động)']], 'báo nhân viên đã nhận tiền');
        assert.deepStrictEqual(mails.map((m) => m[0]), ['customer'], 'email cảm ơn khách');
        r = await Pay.handleSepayWebhook(tx()); assert.strictEqual(r.reason, 'already_paid'); assert.strictEqual(updates.length, 1);
    });
    await test('không xác nhận khi: tiền ra, thiếu tiền, sai tài khoản, không có mã đơn, đơn COD, đơn đã hủy, mã đơn không tồn tại', async () => {
        reset(); setBank({ BANK_CODE: 'MB', BANK_ACCOUNT_NO: '0354334944', BANK_ACCOUNT_NAME: 'SHOPPC' });
        const cases = [
            [tx({ transferType: 'out' }), 'not_incoming'], [tx({ transferAmount: 36000000 }), 'amount_short'],
            [tx({ accountNumber: '9999999999' }), 'other_account'], [tx({ content: 'chuyen tien' }), 'no_order_code'],
            [tx({ content: 'ORD1791176872999', transferAmount: 500000 }), 'not_banking'], [tx({ content: 'ORD1791176873000', transferAmount: 500000 }), 'cancelled'],
            [tx({ content: 'ORD1111111111111' }), 'order_not_found'],
        ];
        for (const [body, reason] of cases) {
            const { result } = await H.capture(() => Pay.handleSepayWebhook(body));
            assert.strictEqual(result.reason, reason, JSON.stringify(body).slice(0, 80)); assert.strictEqual(result.matched, false);
        }
        assert.strictEqual(updates.length, 0); assert.strictEqual(events.length, 0);
        const over = await H.capture(() => Pay.handleSepayWebhook(tx({ transferAmount: 36100000, id: 5 })));
        assert.strictEqual(over.result.reason, 'paid', 'chuyển dư vẫn tính đã thanh toán');
    });
    await test('xác thực webhook: chưa bật → 404; sai/thiếu khóa → 401; đúng khóa → 200 (kể cả giao dịch không khớp đơn)', async () => {
        reset(); setBank({ BANK_CODE: 'MB', BANK_ACCOUNT_NO: '0354334944', BANK_ACCOUNT_NAME: 'SHOPPC' });
        delete process.env.SEPAY_WEBHOOK_KEY;
        let res = await H.call(PayCtl.sepayWebhook, { body: tx(), headers: { authorization: 'Apikey abc' } }); assert.strictEqual(res.code, 404);
        process.env.SEPAY_WEBHOOK_KEY = 'khoa-bi-mat-123';
        res = await H.call(PayCtl.sepayWebhook, { body: tx(), headers: { authorization: 'Apikey sai' } }); assert.strictEqual(res.code, 401);
        res = await H.call(PayCtl.sepayWebhook, { body: tx(), headers: {} }); assert.strictEqual(res.code, 401);
        assert.strictEqual(updates.length, 0, 'sai khóa thì không đụng tới đơn');
        res = await H.call(PayCtl.sepayWebhook, { body: tx({ content: 'khong lien quan' }), headers: { authorization: 'Apikey khoa-bi-mat-123' } });
        assert.strictEqual(res.code, 200); assert.strictEqual(res.body.matched, false);
        res = await H.capture(() => H.call(PayCtl.sepayWebhook, { body: { ...tx(), transferAmount: '36030000', id: '777' }, headers: { authorization: 'apikey  khoa-bi-mat-123' } }));
        assert.strictEqual(res.result.code, 200); assert.strictEqual(res.result.body.reason, 'paid', 'dữ liệu dạng form (chuỗi) vẫn đọc được');
        delete process.env.SEPAY_WEBHOOK_KEY;
    });

    console.log('Khách báo "Tôi đã chuyển khoản"');
    const claim = (code, phone) => H.call(OrderCtl.claimPayment, { params: { orderCode: code }, query: { phone } });
    await test('đơn chuyển khoản chưa trả: ghi nhận + báo nhân viên (realtime) + email cửa hàng; trang thanh toán trả về thời điểm báo', async () => {
        reset(); setBank({ BANK_CODE: 'VCB', BANK_ACCOUNT_NO: '1012345678', BANK_ACCOUNT_NAME: 'SHOPPC' });
        const r = await claim('ORD-1791176872988', '0354.334.944');
        assert.strictEqual(r.code, 200, JSON.stringify(r.body)); assert.match(r.body.message, /Đã báo cửa hàng/);
        assert(r.body.data.payment_claimed_at, 'có thời điểm báo');
        assert.deepStrictEqual(notices, [['claimed', 'ORD-1791176872988']]); assert.deepStrictEqual(mails, [['shop', 'ORD-1791176872988']]);
        assert.strictEqual(orders[0].payment_status, 'pending', 'chưa tự đánh dấu đã thanh toán: phải chờ cửa hàng xác nhận');
    });
    await test('bấm lại trong 10 phút: không làm phiền nhân viên thêm; sai SĐT → 404; COD / đã hủy / đã trả → 409', async () => {
        reset();
        await claim('ORD-1791176872988', '0354334944'); await claim('ORD-1791176872988', '0354334944');
        assert.strictEqual(notices.length, 1); assert.strictEqual(mails.length, 1);
        orders[0].payment_claimed_at = new Date(Date.now() - 11 * 60000); // báo lại sau hơn 10 phút: báo nhân viên lần nữa
        await claim('ORD-1791176872988', '0354334944');
        assert.strictEqual(notices.length, 2); assert.strictEqual(mails.length, 2);
        notices.length = 1; mails.length = 1;
        assert.strictEqual((await claim('ORD-1791176872988', '0900000000')).code, 404);
        let r = await claim('ORD-1791176872999', '0900000000'); assert.strictEqual(r.code, 409); assert.match(r.body.message, /không thanh toán bằng chuyển khoản/);
        r = await claim('ORD-1791176873000', '0900000001'); assert.strictEqual(r.code, 409); assert.match(r.body.message, /đã bị hủy/);
        orders[0].payment_status = 'paid'; r = await claim('ORD-1791176872988', '0354334944'); assert.strictEqual(r.code, 409);
        assert.strictEqual(notices.length, 1);
    });
    await test('nhân viên: "Chưa nhận được tiền" → bỏ trạng thái báo; "Xác nhận đã nhận tiền" → đã thanh toán + báo + email khách (chỉ khi vừa chuyển sang đã trả)', async () => {
        reset(); await claim('ORD-1791176872988', '0354334944'); notices.length = 0; mails.length = 0;
        let r = await H.call(OrderCtl.rejectPaymentClaim, { params: { id: '1' }, user: { id: 7, username: 'admin' } });
        assert.strictEqual(r.code, 200); assert.strictEqual(orders[0].payment_claimed_at, null);
        assert.strictEqual((await H.call(OrderCtl.rejectPaymentClaim, { params: { id: '99' } })).code, 404);
        const Order = require(src('models/Order.js'));
        Order.updatePaymentStatus = OrderStub.updatePaymentStatus;
        r = await H.call(OrderCtl.updatePaymentStatus, { params: { id: '1' }, body: { payment_status: 'paid' }, user: { id: 7, username: 'admin' } });
        assert.strictEqual(r.code, 200); assert.deepStrictEqual(notices, [['received', 'ORD-1791176872988', 'admin']]); assert.deepStrictEqual(mails.map((m) => m[0]), ['customer']);
        await H.call(OrderCtl.updatePaymentStatus, { params: { id: '1' }, body: { payment_status: 'paid' }, user: { id: 7, username: 'admin' } });
        assert.strictEqual(notices.length, 1, 'đã trả rồi thì không báo / email lại');
    });

    console.log('Cài đặt tài khoản nhận tiền (admin)');
    const save = (body) => H.call(PayCtl.saveSettings, { body, user: { id: 7, role: 'admin' } });
    await test('lưu tài khoản: chọn ngân hàng, số TK chỉ gồm số, tên tự viết hoa bỏ dấu; dữ liệu sai → 400', async () => {
        reset();
        let r = await save({ bank_code: 'vcb', account_no: '1012 3456 78', account_name: 'Mùi Hoàng Đông' });
        assert.strictEqual(r.code, 200, JSON.stringify(r.body));
        assert.deepStrictEqual(settings, { bank_code: 'VCB', bank_account_no: '1012345678', bank_account_name: 'MUI HOANG DONG' });
        assert.strictEqual(r.body.data.active.bank_name, 'Vietcombank'); assert.strictEqual(r.body.data.active.source, 'settings');
        assert.match(r.body.data.sample_qr, /^data:image\/png;base64,/);
        for (const [body, re] of [[{ bank_code: 'XYZ', account_no: '1012345678', account_name: 'AN' }, /chọn ngân hàng/], [{ bank_code: 'VCB', account_no: '12ab', account_name: 'MUI HOANG DONG' }, /chữ số/], [{ bank_code: 'VCB', account_no: '1012345678', account_name: '!!' }, /tên chủ tài khoản/i]]) {
            r = await save(body); assert.strictEqual(r.code, 400, JSON.stringify(body)); assert.match(r.body.message, re);
        }
    });
    await test('tài khoản nhập ở trang Cài đặt được ưu tiên hơn .env; xóa (để trống cả 3 ô) thì quay về .env; mã QR của đơn dùng đúng tài khoản', async () => {
        reset(); setBank({ BANK_CODE: 'MB', BANK_ACCOUNT_NO: '0354334944', BANK_ACCOUNT_NAME: 'SHOPPC ENV' });
        let info = await Pay.paymentInfo(orders[0]); assert.strictEqual(info.bank.account_no, '0354334944');
        await save({ bank_code: 'VCB', account_no: '1012345678', account_name: 'MUI HOANG DONG' });
        info = await Pay.paymentInfo(orders[0]);
        assert.deepStrictEqual(info.bank, { bank_name: 'Vietcombank', account_no: '1012345678', account_name: 'MUI HOANG DONG' });
        await save({ bank_code: '', account_no: '', account_name: '' });
        assert.deepStrictEqual(settings, {}); info = await Pay.paymentInfo(orders[0]); assert.strictEqual(info.bank.account_no, '0354334944');
        setBank({}); BankSettings._clearCache();
        const view = await H.call(PayCtl.getSettings, { user: { id: 7, role: 'admin' } });
        assert.strictEqual(view.body.data.active, null); assert.strictEqual(view.body.data.sample_qr, null); assert(view.body.data.banks.some((b) => b.code === 'VCB'));
    });
    await test('quyền: xem/lưu tài khoản nhận tiền chỉ admin; "đã chuyển khoản" công khai có giới hạn tần suất; "chưa nhận được tiền" cần nhân viên', () => {
        const find = (r, m, p) => r.routes.find((x) => x.method === m && x.path === p).handlers;
        for (const m of ['get', 'put']) assert.deepStrictEqual(find(paymentRoutes, m, '/settings').slice(0, 2), [Auth.authenticate, Auth.authorizeAdmin]);
        const c = find(orderRoutes, 'post', '/payment/:orderCode/claim'); assert.strictEqual(c.length, 2); assert(!c.includes(Auth.authenticate));
        assert.deepStrictEqual(find(orderRoutes, 'patch', '/:id(\\d+)/payment-claim').slice(0, 2), [Auth.authenticate, Auth.authorizeStaff]);
    });

    done(); setImmediate(() => process.exit(process.exitCode || 0));
})();
