// Kiểm thử các bản vá bảo mật (không cần MySQL / mạng / package ngoài).
// Chạy:  node tests/security.test.js
//
// Lưu ý: express / jsonwebtoken / bcryptjs được thay bằng bản giả tối giản bên dưới để chạy được ở bất kỳ đâu.
// Logic của dự án (route, middleware, controller, config) là code thật.
const Module = require('module');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const BE = path.join(__dirname, '..', 'src');
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123456';
delete process.env.NODE_ENV;

// ───────────── bản giả của thư viện ─────────────
const b64 = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');
const hmac = (data, secret) => crypto.createHmac('sha256', secret).update(data).digest('base64url');
const ttl = (s) => ({ m: 60, h: 3600, d: 86400 }[s.slice(-1)] * parseInt(s, 10));
const fakeJwt = {
    sign(payload, secret, opts = {}) {
        const now = Math.floor(Date.now() / 1000);
        const body = { ...payload, iat: now, ...(opts.expiresIn ? { exp: now + ttl(opts.expiresIn) } : {}) };
        const head = b64({ alg: 'HS256', typ: 'JWT' });
        const data = `${head}.${b64(body)}`;
        return `${data}.${hmac(data, secret)}`;
    },
    verify(token, secret) {
        const [h, p, s] = String(token).split('.');
        if (!h || !p || !s || hmac(`${h}.${p}`, secret) !== s) throw new Error('invalid signature');
        const body = JSON.parse(Buffer.from(p, 'base64url').toString());
        if (body.exp && body.exp < Math.floor(Date.now() / 1000)) throw new Error('jwt expired');
        return body;
    },
    decode(token) {
        try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString()); } catch { return null; }
    },
};
let hashCounter = 0;
const fakeBcrypt = {
    hash: async (p) => `hash:${p}:${++hashCounter}`,
    compare: async (p, h) => typeof h === 'string' && h.split(':')[1] === p,
};
const routes = [];
const fakeExpress = () => ({});
fakeExpress.Router = () => {
    const r = { routes: [] };
    for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
        r[m] = (p, ...handlers) => r.routes.push({ method: m, path: p, handlers });
    }
    r.use = () => {};
    return r;
};

// ───────────── model & DB giả ─────────────
const H = (p) => `hash:${p}:0`;
const users = [
    { id: 1, username: 'admin', password: H('adminpw1'), email: 'admin@x.vn', full_name: 'Admin', role: 'admin', status: 'active' },
    { id: 2, username: 'nv', password: H('staffpw1'), email: 'nv@x.vn', full_name: 'Nhân viên', role: 'staff', status: 'active' },
    { id: 3, username: 'khach', password: H('khachpw1'), email: 'khach@x.vn', full_name: 'Khách', role: 'customer', status: 'active' },
    { id: 4, username: 'locked', password: H('lockedpw1'), email: 'locked@x.vn', full_name: 'Bị khóa', role: 'customer', status: 'inactive' },
];
const pub = (u) => (u ? { id: u.id, username: u.username, email: u.email, full_name: u.full_name, role: u.role, status: u.status } : undefined);
const state = { created: [], failRoleColumn: false, updated: [] };
const User = {
    getAllUsers: async () => users.map(pub),
    getUserById: async (id) => pub(users.find((u) => u.id === Number(id))),
    getUserAuthById: async (id) => users.find((u) => u.id === Number(id)),
    getUserByUsername: async (n) => users.find((u) => u.username === n),
    getUserByEmail: async (e) => users.find((u) => u.email === e),
    createUser: async (d) => {
        if (state.failRoleColumn) throw Object.assign(new Error('Data truncated for column role'), { code: 'WARN_DATA_TRUNCATED' });
        state.created.push(d);
        const u = { id: 100 + state.created.length, ...d, password: d.password_hash || await fakeBcrypt.hash(d.password), status: 'active' };
        users.push(u);
        return u.id;
    },
    updateUser: async (id, d) => { state.updated.push([id, d]); return 1; },
    updatePassword: async (id, pw) => { users.find((u) => u.id === Number(id)).password = await fakeBcrypt.hash(pw); return 1; },
    updateLastLogin: async () => 1,
    verifyPassword: async (u, pw) => fakeBcrypt.compare(pw, u.password),
    deleteUser: async () => 1,
};
const dbState = { roleType: "enum('admin','staff')", staffCount: 3 };
const db = {
    query: async (sql) => {
        if (/SHOW COLUMNS/.test(sql)) return [{ Type: dbState.roleType }];
        if (/COUNT\(\*\)/.test(sql)) return [{ n: dbState.staffCount }];
        return [];
    },
    pool: { query: async () => [{}] },
};
const noModel = {};
// Bảng email_otps + mailer giả: lưu trong bộ nhớ, ghi lại mã OTP đã "gửi"
const otpRows = [];
let otpSeq = 0;
const EmailOtp = {
    find: async (email, purpose) => otpRows.find((r) => r.email === email && r.purpose === purpose) || null,
    create: async (r) => { const row = { id: ++otpSeq, attempts: 0, send_count: 1, created_at: new Date(), ...r }; otpRows.push(row); return row.id; },
    replaceCode: async (id, r) => Object.assign(otpRows.find((x) => x.id === id), { ...r, attempts: 0 }),
    incrementAttempts: async (id) => { otpRows.find((x) => x.id === id).attempts += 1; },
    remove: async (id) => { const i = otpRows.findIndex((x) => x.id === id); if (i >= 0) otpRows.splice(i, 1); },
    purgeOlderThan: async () => {},
};
const sentOtps = [];
// Chỉ thay hàm gửi OTP; gửi mail đặt lại mật khẩu vẫn là code thật (các test quên mật khẩu bên dưới dùng nó)
const mailer = { ...require(path.join(BE, 'services/mailer.js')), sendRegisterOtp: async (m) => { sentOtps.push(m); return { delivered: true }; } };
const stubs = new Map([
    [path.join(BE, 'models/User.js'), User],
    [path.join(BE, 'models/Product.js'), noModel],
    [path.join(BE, 'models/Category.js'), noModel],
    [path.join(BE, 'models/Order.js'), noModel],
    [path.join(BE, 'models/Cart.js'), noModel],
    [path.join(BE, 'config/database.js'), db],
    [path.join(BE, 'models/EmailOtp.js'), EmailOtp],
    [path.join(BE, 'services/mailer.js'), mailer],
]);
const external = { express: fakeExpress, jsonwebtoken: fakeJwt, bcryptjs: fakeBcrypt, dotenv: { config() {} } };
const origLoad = Module._load;
Module._load = function (request, parent) {
    if (Object.prototype.hasOwnProperty.call(external, request)) return external[request];
    if (parent && request.startsWith('.')) {
        const resolved = require.resolve(path.resolve(path.dirname(parent.filename), request));
        if (stubs.has(resolved)) return stubs.get(resolved);
    }
    return origLoad.apply(this, arguments);
};

const Auth = require(path.join(BE, 'middlewares/auth.js'));
const Jwt = require(path.join(BE, 'config/jwt.js'));
const Ctl = require(path.join(BE, 'controllers/userController.js'));
const productRoutes = require(path.join(BE, 'routes/productRoutes.js'));
const categoryRoutes = require(path.join(BE, 'routes/categoryRoutes.js'));
const userRoutes = require(path.join(BE, 'routes/userRoutes.js'));
const authRoutes = require(path.join(BE, 'routes/authRoutes.js'));

// ───────────── tiện ích test ─────────────
const mkRes = () => {
    const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } };
    return r;
};
const call = async (fn, body = {}, extra = {}) => { const res = mkRes(); await fn({ body, params: {}, headers: {}, ...extra }, res); return res; };
const capture = async (fn) => {
    const logs = []; const o = [console.log, console.warn, console.error];
    console.log = console.warn = console.error = (...a) => logs.push(a.join(' '));
    try { return { result: await fn(), logs }; } finally { [console.log, console.warn, console.error] = o; }
};
const runAuth = async (token) => {
    const res = mkRes(); const req = { headers: token ? { authorization: `Bearer ${token}` } : {} };
    let nexted = false; await Auth.authenticate(req, res, () => { nexted = true; });
    return { nexted, res, req };
};
const find = (router, method, p) => router.routes.find((r) => r.method === method && r.path === p);

let passed = 0;
const test = async (name, fn) => {
    try { await fn(); passed++; console.log('  ✓', name); }
    catch (e) { console.log('  ✗', name, '\n   ', e.stack.split('\n').slice(0, 4).join('\n    ')); process.exitCode = 1; }
};

(async () => {
    console.log('Lỗ hổng 1: API sản phẩm / danh mục phải yêu cầu đăng nhập');
    await test('GET sản phẩm/danh mục vẫn công khai (storefront cần)', () => {
        for (const [router, paths] of [[productRoutes, ['/', '/type/:type', '/category/:categoryId', '/:id']], [categoryRoutes, ['/', '/:id']]]) {
            for (const p of paths) assert.strictEqual(find(router, 'get', p).handlers.length, 1, `GET ${p} phải công khai`);
        }
    });
    await test('POST/PUT/PATCH sản phẩm & danh mục: authenticate + authorizeStaff', () => {
        for (const [router, list] of [[productRoutes, [['post', '/'], ['put', '/:id'], ['patch', '/:id/stock']]], [categoryRoutes, [['post', '/'], ['put', '/:id']]]]) {
            for (const [m, p] of list) {
                const h = find(router, m, p).handlers;
                assert.deepStrictEqual(h.slice(0, 2), [Auth.authenticate, Auth.authorizeStaff], `${m.toUpperCase()} ${p}`);
                assert.strictEqual(h.length, 3);
            }
        }
    });
    await test('DELETE sản phẩm & danh mục: chỉ admin', () => {
        for (const router of [productRoutes, categoryRoutes]) {
            assert.deepStrictEqual(find(router, 'delete', '/:id').handlers.slice(0, 2), [Auth.authenticate, Auth.authorizeAdmin]);
        }
    });
    await test('mọi route ghi (post/put/patch/delete) của sản phẩm/danh mục đều có authenticate', () => {
        for (const router of [productRoutes, categoryRoutes]) {
            for (const r of router.routes.filter((x) => x.method !== 'get')) assert(r.handlers.includes(Auth.authenticate), `${r.method} ${r.path}`);
        }
    });
    await test('không token → 401; token khách hàng → 403 ở authorizeStaff; staff → 403 ở authorizeAdmin', async () => {
        assert.strictEqual((await runAuth(null)).res.code, 401);
        const cust = await runAuth(Jwt.signAccessToken(users[2]));
        assert(cust.nexted && cust.req.user.role === 'customer');
        let r = mkRes(), n = false; Auth.authorizeStaff(cust.req, r, () => { n = true; });
        assert(!n && r.code === 403);
        const staff = await runAuth(Jwt.signAccessToken(users[1]));
        assert(staff.nexted); r = mkRes(); n = false; Auth.authorizeStaff(staff.req, r, () => { n = true; }); assert(n);
        r = mkRes(); n = false; Auth.authorizeAdmin(staff.req, r, () => { n = true; }); assert(!n && r.code === 403);
        const admin = await runAuth(Jwt.signAccessToken(users[0])); r = mkRes(); n = false; Auth.authorizeAdmin(admin.req, r, () => { n = true; }); assert(n);
    });
    await test('token giả (ký sai secret) / tài khoản bị khóa đều bị 401', async () => {
        const forged = fakeJwt.sign({ id: 1, username: 'admin', role: 'admin' }, 'your-secret-key-change-this', { expiresIn: '7d' });
        assert.strictEqual((await runAuth(forged)).res.code, 401);
        assert.strictEqual((await runAuth(Jwt.signAccessToken(users[3]))).res.code, 401);
    });

    console.log('Lỗ hổng 2: đăng ký không được tự chọn quyền');
    // Đăng ký 2 bước: gửi mã OTP tới email, nhập đúng mã mới tạo tài khoản
    const registerWithOtp = async (body) => {
        const start = await call(Ctl.register, body);
        if (start.code !== 200) return start;
        const code = sentOtps.at(-1).code;
        return call(Ctl.verifyRegistration, { email: body.email, code, role: 'admin' });
    };
    await test('đăng ký với role=admin / status → luôn tạo "customer"', async () => {
        state.created.length = 0;
        const res = await registerWithOtp({ username: 'hacker', password: 'secret12', email: 'h@x.vn', full_name: 'H', role: 'admin', status: 'active' });
        assert.strictEqual(res.code, 201);
        assert.strictEqual(state.created.length, 1);
        assert.strictEqual(state.created[0].role, 'customer');
        assert(!('status' in state.created[0]));
        assert.strictEqual(Jwt.verifyAccessToken(res.body.data.token).role, 'customer', 'đăng nhập luôn với quyền customer');
    });
    await test('đăng ký thường (không gửi role) cũng là "customer", không còn là "staff"', async () => {
        state.created.length = 0;
        await registerWithOtp({ username: 'binhthuong', password: 'secret12', email: 'bt@x.vn', full_name: 'BT' });
        assert.strictEqual(state.created[0].role, 'customer');
    });
    await test('bước gửi mã CHƯA tạo tài khoản; mật khẩu chỉ lưu dạng băm; mã sai không tạo tài khoản', async () => {
        state.created.length = 0;
        const start = await call(Ctl.register, { username: 'chuaxacnhan', password: 'matkhau99', email: 'cxn@x.vn', full_name: 'C' });
        assert.strictEqual(start.code, 200); assert.strictEqual(start.body.data.otp_required, true);
        assert.strictEqual(state.created.length, 0, 'chưa nhập mã thì chưa có tài khoản');
        const row = otpRows.find((r) => r.email === 'cxn@x.vn');
        assert(!('password' in row.payload) && row.payload.password_hash && row.payload.password_hash !== 'matkhau99', 'chỉ lưu mật khẩu đã băm');
        assert(!JSON.stringify(row).includes(`"${sentOtps.at(-1).code}"`) && /^[0-9a-f]{64}$/.test(row.code_hash), 'chỉ lưu mã đã băm');
        const wrong = sentOtps.at(-1).code === '000000' ? '111111' : '000000';
        const bad = await call(Ctl.verifyRegistration, { email: 'cxn@x.vn', code: wrong });
        assert.strictEqual(bad.code, 400); assert.strictEqual(state.created.length, 0);
    });
    await test('kiểm tra đầu vào đăng ký: thiếu/sai kiểu/quá ngắn/email sai/trùng', async () => {
        const base = { username: 'abcd', password: 'secret12', email: 'a@b.vn', full_name: 'A' };
        for (const [patch, re] of [
            [{ password: '123' }, /ít nhất 6/], [{ email: 'khong-hop-le' }, /Email/], [{ username: 'a b' }, /khoảng trắng/],
            [{ username: { id: 1 } }, /đầy đủ/], [{ password: ['x'] }, /đầy đủ/], [{ full_name: '   ' }, /đầy đủ/],
            [{ username: 'admin' }, /đã tồn tại/], [{ email: 'admin@x.vn' }, /Email đã/], [{ email: 'ADMIN@x.vn' }, /Email đã/],
        ]) {
            const res = await call(Ctl.register, { ...base, ...patch });
            assert.strictEqual(res.code, 400, JSON.stringify(patch)); assert(re.test(res.body.message), res.body.message);
        }
        assert.strictEqual((await call(Ctl.register, undefined)).code, 400);
        assert.strictEqual((await call(Ctl.verifyRegistration, { email: { $ne: 1 }, code: '123456' })).code, 400);
    });
    await test('DB chưa migrate (role không nhận "customer") → 503 chung chung, không lộ chi tiết', async () => {
        state.failRoleColumn = true;
        const { result: res, logs } = await capture(() => registerWithOtp({ username: 'newuser', password: 'secret12', email: 'n@x.vn', full_name: 'N' }));
        state.failRoleColumn = false;
        assert.strictEqual(res.code, 503); assert(!/role|truncat|sql/i.test(res.body.message));
        assert(logs.some((l) => l.includes('fix-roles')));
    });
    await test('khách hàng KHÔNG đổi email trực tiếp qua PUT /users/me (phải qua mã OTP); nhân viên/admin vẫn đổi được; đổi họ tên bình thường', async () => {
        state.updated.length = 0;
        const asUser = (u) => ({ user: { id: u.id, username: u.username, role: u.role } });
        let res = await call(Ctl.updateCurrentUser, { email: 'moi@x.vn' }, asUser(users[2]));
        assert.strictEqual(res.code, 400); assert(/mã/.test(res.body.message)); assert.strictEqual(state.updated.length, 0);
        res = await call(Ctl.updateCurrentUser, { full_name: 'Tên Mới', email: 'KHACH@x.vn' }, asUser(users[2]));
        assert.strictEqual(res.code, 200, 'gửi lại email cũ (khác hoa/thường) kèm họ tên vẫn được');
        res = await call(Ctl.updateCurrentUser, { email: 'nvmoi2@x.vn' }, asUser(users[1]));
        assert.strictEqual(res.code, 200); assert.deepStrictEqual(state.updated.at(-1), [2, { full_name: undefined, email: 'nvmoi2@x.vn', avatar: undefined }]);
        const h = find(userRoutes, 'post', '/me/email').handlers; assert.strictEqual(h[0], Auth.authenticate);
        assert.strictEqual(find(userRoutes, 'post', '/me/email/verify').handlers.at(-1), Ctl.verifyEmailChange);
    });
    await test('route POST /api/users: chỉ admin; tạo staff mặc định, role lạ bị từ chối', async () => {
        const h = find(userRoutes, 'post', '/').handlers;
        assert.deepStrictEqual(h.slice(0, 2), [Auth.authenticate, Auth.authorizeAdmin]);
        state.created.length = 0;
        let res = await call(Ctl.createUser, { username: 'nvmoi', password: 'secret12', email: 'nvmoi@x.vn', full_name: 'NV' });
        assert.strictEqual(res.code, 201); assert.strictEqual(state.created[0].role, 'staff');
        res = await call(Ctl.createUser, { username: 'qtv2', password: 'secret12', email: 'q2@x.vn', full_name: 'Q', role: 'admin' });
        assert.strictEqual(res.code, 201); assert.strictEqual(state.created[1].role, 'admin');
        res = await call(Ctl.createUser, { username: 'sai', password: 'secret12', email: 's@x.vn', full_name: 'S', role: 'superuser' });
        assert.strictEqual(res.code, 400);
    });
    await test('admin đổi role: role lạ bị từ chối; không hạ quyền admin duy nhất', async () => {
        let res = await call(Ctl.updateUser, { role: 'god' }, { params: { id: '2' } });
        assert.strictEqual(res.code, 400);
        const only = users.filter((u) => u.role === 'admin');
        // tại thời điểm này đã có thêm admin 'qtv2' từ test trước -> tạm giữ lại duy nhất admin #1
        const extra = users.filter((u) => u.role === 'admin' && u.id !== 1);
        extra.forEach((u) => { u.role = 'staff'; });
        res = await call(Ctl.updateUser, { role: 'staff' }, { params: { id: '1' } });
        assert.strictEqual(res.code, 400); assert(/admin duy nhất/.test(res.body.message));
        extra.forEach((u) => { u.role = 'admin'; });
        assert(only.length >= 1);
    });
    await test('đăng nhập: thông báo đồng nhất, không lộ tài khoản bị khóa nếu sai mật khẩu', async () => {
        const wrongUser = await call(Ctl.login, { username: 'khong-ton-tai', password: 'x' });
        const wrongPass = await call(Ctl.login, { username: 'admin', password: 'sai' });
        const lockedWrong = await call(Ctl.login, { username: 'locked', password: 'sai' });
        for (const r of [wrongUser, wrongPass, lockedWrong]) { assert.strictEqual(r.code, 401); assert.strictEqual(r.body.message, 'Tên đăng nhập hoặc mật khẩu không đúng'); }
        const lockedRight = await call(Ctl.login, { username: 'locked', password: 'lockedpw1' });
        assert.strictEqual(lockedRight.code, 401); assert(/khóa/.test(lockedRight.body.message));
        assert.strictEqual((await call(Ctl.login, { username: { a: 1 }, password: 'x' })).code, 400);
        const ok = await call(Ctl.login, { username: 'khach', password: 'khachpw1' });
        assert.strictEqual(ok.code, 200); assert.strictEqual(Jwt.verifyAccessToken(ok.body.data.token).role, 'customer');
    });

    console.log('Lỗ hổng 3: quên / đặt lại mật khẩu');
    let resetLink = null;
    const forgot = async (email, env) => {
        const prev = process.env.NODE_ENV; if (env) process.env.NODE_ENV = env; else delete process.env.NODE_ENV;
        try { return await capture(() => call(Ctl.forgotPassword, { email })); } finally { if (prev === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prev; }
    };
    await test('response KHÔNG chứa token và giống hệt nhau dù email có tồn tại hay không', async () => {
        const a = await forgot('khach@x.vn'); const b = await forgot('khong-co@x.vn');
        assert.deepStrictEqual(a.result.body, b.result.body); assert.strictEqual(a.result.code, 200);
        assert(!/token/i.test(JSON.stringify(a.result.body)));
        resetLink = (a.logs.join('\n').match(/reset-password\?token=([\w%.-]+)/) || [])[1];
        assert(resetLink, 'môi trường dev phải in liên kết ra console để thử nghiệm');
        assert(!b.logs.join('\n').includes('reset-password'));
    });
    await test('production: không in token ra log; tài khoản bị khóa không nhận được email', async () => {
        const prod = await forgot('khach@x.vn', 'production');
        assert(!prod.logs.join('\n').includes('token=') && !prod.logs.join('\n').match(/eyJ|\w{20,}\.\w{20,}\.\w{20,}/));
        const locked = await forgot('locked@x.vn');
        assert(!locked.logs.join('\n').includes('reset-password'));
    });
    await test('đầu vào sai kiểu → 400; lỗi nội bộ không lộ ra ngoài', async () => {
        assert.strictEqual((await call(Ctl.forgotPassword, { email: { $ne: 1 } })).code, 400);
        assert.strictEqual((await call(Ctl.forgotPassword, {})).code, 400);
        const orig = User.getUserByEmail; User.getUserByEmail = async () => { throw new Error('DB down: secret info'); };
        const { result } = await capture(() => call(Ctl.forgotPassword, { email: 'khach@x.vn' }));
        User.getUserByEmail = orig;
        assert.strictEqual(result.code, 200); assert(!/DB down/.test(JSON.stringify(result.body)));
    });
    await test('token đặt lại KHÔNG dùng được làm token đăng nhập hay refresh', async () => {
        const token = Jwt.signResetToken(users[2]);
        assert.strictEqual((await runAuth(token)).res.code, 401);
        assert.strictEqual((await call(Ctl.refreshToken, { token })).code, 401);
    });
    await test('đặt lại mật khẩu thành công, đăng nhập được bằng mật khẩu mới, mật khẩu cũ hết hiệu lực', async () => {
        const res = await call(Ctl.resetPassword, { token: decodeURIComponent(resetLink), new_password: 'matkhaumoi1' });
        assert.strictEqual(res.code, 200);
        assert.strictEqual((await call(Ctl.login, { username: 'khach', password: 'matkhaumoi1' })).code, 200);
        assert.strictEqual((await call(Ctl.login, { username: 'khach', password: 'khachpw1' })).code, 401);
    });
    await test('token chỉ dùng được MỘT lần', async () => {
        const res = await call(Ctl.resetPassword, { token: decodeURIComponent(resetLink), new_password: 'lanhai12345' });
        assert.strictEqual(res.code, 400);
        assert.strictEqual((await call(Ctl.login, { username: 'khach', password: 'matkhaumoi1' })).code, 200);
    });
    await test('token hết hạn / bị sửa / ký bằng secret khác / loại token sai đều bị từ chối', async () => {
        const fresh = Jwt.signResetToken(users[1]);
        const realNow = Date.now; Date.now = () => realNow() + 31 * 60 * 1000;
        try { assert.strictEqual((await call(Ctl.resetPassword, { token: fresh, new_password: 'matkhau123' })).code, 400); } finally { Date.now = realNow; }
        const [h, p, s] = fresh.split('.');
        const tampered = `${h}.${b64({ ...fakeJwt.decode(fresh), id: 1 })}.${s}`; // đổi sang id admin
        assert.strictEqual((await call(Ctl.resetPassword, { token: tampered, new_password: 'matkhau123' })).code, 400);
        const otherSecret = fakeJwt.sign({ id: 2, purpose: 'reset' }, 'secret-khac', { expiresIn: '30m' });
        assert.strictEqual((await call(Ctl.resetPassword, { token: otherSecret, new_password: 'matkhau123' })).code, 400);
        const wrongPurpose = fakeJwt.sign({ id: 2, purpose: 'access' }, Jwt.getSecret() + users[1].password, { expiresIn: '30m' });
        assert.strictEqual((await call(Ctl.resetPassword, { token: wrongPurpose, new_password: 'matkhau123' })).code, 400);
        const accessAsReset = Jwt.signAccessToken(users[1]);
        assert.strictEqual((await call(Ctl.resetPassword, { token: accessAsReset, new_password: 'matkhau123' })).code, 400);
        assert.strictEqual((await call(Ctl.resetPassword, { token: 'rac', new_password: 'matkhau123' })).code, 400);
        assert.strictEqual((await call(Ctl.resetPassword, { token: { x: 1 }, new_password: 'matkhau123' })).code, 400);
        assert.strictEqual((await call(Ctl.resetPassword, { token: fresh, new_password: '123' })).code, 400);
        assert(users[1].password === H('staffpw1'), 'mật khẩu staff không được thay đổi');
    });
    await test('tài khoản bị khóa không đặt lại được mật khẩu; refresh-token từ chối tài khoản bị khóa', async () => {
        const t = Jwt.signResetToken(users[3]);
        assert.strictEqual((await call(Ctl.resetPassword, { token: t, new_password: 'matkhau123' })).code, 400);
        assert.strictEqual((await call(Ctl.refreshToken, { token: Jwt.signAccessToken(users[3]) })).code, 401);
        const ok = await call(Ctl.refreshToken, { token: Jwt.signAccessToken(users[1]) });
        assert.strictEqual(ok.code, 200); assert.strictEqual(Jwt.verifyAccessToken(ok.body.data.token).id, 2);
    });
    await test('route quên/đặt lại mật khẩu/đăng ký vẫn công khai (không cần đăng nhập) và trỏ đúng controller', () => {
        for (const [router, p, ctl] of [[authRoutes, '/forgot-password', Ctl.forgotPassword], [authRoutes, '/reset-password', Ctl.resetPassword], [authRoutes, '/register', Ctl.register], [userRoutes, '/register', Ctl.register],
            [authRoutes, '/register/verify', Ctl.verifyRegistration], [userRoutes, '/register/verify', Ctl.verifyRegistration], [authRoutes, '/register/resend', Ctl.resendRegistrationOtp], [userRoutes, '/register/resend', Ctl.resendRegistrationOtp]]) {
            const h = find(router, 'post', p).handlers;
            assert.strictEqual(h.at(-1), ctl, p);
            assert(!h.includes(Auth.authenticate), `${p} phải công khai`);
            assert.strictEqual(h.length, 2, `${p}: bộ giới hạn tần suất + controller`);
        }
    });

    console.log('Cấu hình JWT & kiểm tra khi khởi động');
    const fresh = (rel) => { delete require.cache[require.resolve(path.join(BE, rel))]; return require(path.join(BE, rel)); };
    await test('production thiếu JWT_SECRET → báo lỗi; dev thiếu → secret ngẫu nhiên + cảnh báo', async () => {
        const saved = { s: process.env.JWT_SECRET, e: process.env.NODE_ENV };
        delete process.env.JWT_SECRET;
        try {
            process.env.NODE_ENV = 'production';
            assert.throws(() => fresh('config/jwt.js').getSecret(), /JWT_SECRET/);
            delete process.env.NODE_ENV;
            const { result: secret, logs } = await capture(() => fresh('config/jwt.js').getSecret());
            assert(secret.length >= 64 && secret !== 'your-secret-key-change-this'); assert(logs.some((l) => /JWT_SECRET/.test(l)));
            process.env.JWT_SECRET = 'your-secret-key-change-this';
            const warn = await capture(() => fresh('config/jwt.js').getSecret());
            assert(warn.logs.some((l) => /yếu|mặc định/.test(l)));
        } finally { process.env.JWT_SECRET = saved.s; if (saved.e) process.env.NODE_ENV = saved.e; else delete process.env.NODE_ENV; fresh('config/jwt.js'); }
    });
    await test('startupChecks: cảnh báo khi cột role thiếu "customer"; im lặng khi đã migrate', async () => {
        const { runStartupChecks } = fresh('config/startupChecks.js');
        dbState.roleType = "enum('admin','staff')";
        let { logs } = await capture(runStartupChecks);
        assert(logs.some((l) => /customer/.test(l) && /fix-roles/.test(l)));
        assert(logs.some((l) => /3 tài khoản/.test(l)));
        dbState.roleType = "enum('admin','staff','customer')"; dbState.staffCount = 0;
        ({ logs } = await capture(runStartupChecks));
        assert(!logs.some((l) => /KHÁCH HÀNG SẼ KHÔNG/.test(l)));
        dbState.roleType = 'varchar(20)';
        ({ logs } = await capture(runStartupChecks));
        assert(!logs.some((l) => /KHÁCH HÀNG SẼ KHÔNG/.test(l)));
    });

    console.log('Vai trò hợp lý: admin không tự phá quyền của mình');
    await test('không tự đổi vai trò / tự khóa mình; đặt lại đúng vai trò hiện tại vẫn được', async () => {
        const self = { id: 1, username: 'admin', role: 'admin' };
        let res = await call(Ctl.updateUser, { role: 'staff' }, { params: { id: '1' }, user: self });
        assert.strictEqual(res.code, 400); assert(/tự đổi vai trò/.test(res.body.message));
        res = await call(Ctl.updateUser, { status: 'inactive' }, { params: { id: '1' }, user: self });
        assert.strictEqual(res.code, 400); assert(/tự khóa/.test(res.body.message));
        res = await call(Ctl.updateUser, { role: 'admin', full_name: 'Admin Mới' }, { params: { id: '1' }, user: self });
        assert.strictEqual(res.code, 200);
    });
    await test('admin đổi vai trò người khác hợp lệ; trạng thái/vai trò lạ bị từ chối', async () => {
        const admin = { id: 1, username: 'admin', role: 'admin' };
        state.updated.length = 0;
        let res = await call(Ctl.updateUser, { role: 'staff' }, { params: { id: '3' }, user: admin });
        assert.strictEqual(res.code, 200); assert.strictEqual(state.updated.at(-1)[1].role, 'staff');
        res = await call(Ctl.updateUser, { status: 'banned' }, { params: { id: '3' }, user: admin });
        assert.strictEqual(res.code, 400); assert(/Trạng thái/.test(res.body.message));
        res = await call(Ctl.updateUser, { role: 'owner' }, { params: { id: '3' }, user: admin });
        assert.strictEqual(res.code, 400);
    });
    await test('không tự xóa tài khoản của mình; xóa người khác được', async () => {
        const admin = { id: 1, username: 'admin', role: 'admin' };
        let res = await call(Ctl.deleteUser, {}, { params: { id: '1' }, user: admin });
        assert.strictEqual(res.code, 400); assert(/tự xóa/.test(res.body.message));
        res = await call(Ctl.deleteUser, {}, { params: { id: '3' }, user: admin });
        assert.strictEqual(res.code, 200);
    });

    console.log(`\n${passed} test đạt`);
})();
