// Kiểm thử đăng ký có xác nhận email bằng mã OTP (không cần MySQL / mạng / SMTP thật).
// Chạy:  node tests/otp.test.js
const assert = require('assert');
const H = require('./helpers/harness');
const { src } = H;
delete process.env.NODE_ENV;

// ── DB giả: bảng email_otps + users ──
const otpRows = [];
let seq = 0;
const EmailOtp = {
    find: async (email, purpose) => otpRows.find((r) => r.email === email && r.purpose === purpose) || null,
    create: async (r) => { const row = { id: ++seq, attempts: 0, send_count: 1, created_at: new Date(), ...JSON.parse(JSON.stringify(r)) }; otpRows.push(row); return row.id; },
    replaceCode: async (id, r) => Object.assign(otpRows.find((x) => x.id === id), JSON.parse(JSON.stringify(r)), { attempts: 0 }),
    incrementAttempts: async (id) => { otpRows.find((x) => x.id === id).attempts += 1; },
    remove: async (id) => { const i = otpRows.findIndex((x) => x.id === id); if (i >= 0) otpRows.splice(i, 1); },
    purgeOlderThan: async () => {},
};
const users = [{ id: 1, username: 'admin', email: 'admin@shoppc.com' }];
const User = {
    getUserByUsername: async (n) => users.find((u) => u.username === n),
    getUserByEmail: async (e) => users.find((u) => u.email.toLowerCase() === String(e).toLowerCase()),
};
const sent = [];
let mailFail = false;
const mailer = {
    sendRegisterOtp: async (m) => {
        if (mailFail) { const e = new Error('Không gửi được email xác nhận.'); e.status = 502; e.expose = true; throw e; }
        sent.push(m); return { delivered: true };
    },
};
H.install(new Map([
    [src('config/database.js'), { pool: { query: async () => [[]] } }],
    [src('models/EmailOtp.js'), EmailOtp],
    [src('models/User.js'), User],
    [src('services/mailer.js'), mailer],
]));

const Otp = require(src('services/registrationOtp.js'));
const { test, done } = H.runner();

const T0 = new Date('2026-10-06T08:00:00Z');
const at = (sec) => new Date(T0.getTime() + sec * 1000);
const reset = () => { otpRows.length = 0; sent.length = 0; mailFail = false; };
const data = (patch = {}) => ({ username: 'khachmoi', password: 'matkhau123', email: 'KhachMoi@Gmail.com ', full_name: 'Khách Mới', ...patch });
const rejects = async (p, status, re) => {
    try { await p; } catch (e) { assert.strictEqual(e.status, status, e.message); if (re) assert(re.test(e.message), e.message); return e; }
    throw new Error('lẽ ra phải báo lỗi');
};

(async () => {
    console.log('Gửi mã');
    await test('gửi mã 6 số tới email (đã chuẩn hóa chữ thường), trả về thời hạn + thời gian chờ; email hiển thị được che bớt', async () => {
        reset();
        const info = await Otp.start(data(), T0);
        assert.strictEqual(sent.length, 1); assert.match(sent[0].code, /^\d{6}$/); assert.strictEqual(sent[0].email, 'khachmoi@gmail.com');
        assert.strictEqual(sent[0].name, 'Khách Mới'); assert.strictEqual(sent[0].ttlMinutes, 10);
        assert.deepStrictEqual(info, { otp_required: true, email: 'khachmoi@gmail.com', masked_email: 'kh******@gmail.com', expires_in: 600, resend_in: 60 });
        const row = otpRows[0];
        assert.strictEqual(row.payload.username, 'khachmoi'); assert(!('password' in row.payload)); assert.notStrictEqual(row.payload.password_hash, 'matkhau123');
        assert.strictEqual(row.code_hash, Otp._hashCode('khachmoi@gmail.com', sent[0].code)); assert(!JSON.stringify(row).includes(`"${sent[0].code}"`));
    });
    await test('tên đăng nhập / email đã có tài khoản → báo ngay, không gửi mã', async () => {
        reset();
        await rejects(Otp.start(data({ username: 'admin' }), T0), 400, /Tên đăng nhập đã tồn tại/);
        await rejects(Otp.start(data({ email: 'ADMIN@shoppc.com' }), T0), 400, /Email đã được sử dụng/);
        assert.strictEqual(sent.length, 0); assert.strictEqual(otpRows.length, 0);
    });
    await test('gửi email thất bại → không để lại yêu cầu treo, thử lại được ngay', async () => {
        reset(); mailFail = true;
        await rejects(Otp.start(data(), T0), 502);
        assert.strictEqual(otpRows.length, 0);
        mailFail = false; await Otp.start(data(), at(1)); assert.strictEqual(sent.length, 1);
    });

    console.log('Gửi lại mã');
    await test('phải chờ 60 giây giữa 2 lần gửi; gửi lại thì mã cũ hết tác dụng', async () => {
        reset();
        await Otp.start(data(), T0); const first = sent[0].code;
        await rejects(Otp.resend('khachmoi@gmail.com', at(30)), 429, /đợi 30 giây/);
        const info = await Otp.resend(' KHACHMOI@gmail.com', at(61)); assert.strictEqual(info.resend_in, 60); assert.strictEqual(sent.length, 2);
        const second = sent[1].code;
        if (first !== second) await rejects(Otp.verify('khachmoi@gmail.com', first, at(62)), 400, /không đúng/);
        const ok = await Otp.verify('khachmoi@gmail.com', second, at(63)); assert.strictEqual(ok.username, 'khachmoi');
    });
    await test('tối đa 5 lần gửi mỗi giờ; sang giờ mới thì gửi tiếp được', async () => {
        reset();
        await Otp.start(data(), T0);
        for (let i = 1; i <= 4; i += 1) await Otp.resend('khachmoi@gmail.com', at(i * 61));
        assert.strictEqual(sent.length, 5);
        await rejects(Otp.resend('khachmoi@gmail.com', at(6 * 61)), 429, /quá nhiều lần/);
        await Otp.resend('khachmoi@gmail.com', at(3601)); assert.strictEqual(sent.length, 6);
    });
    await test('gửi lại cho email chưa đăng ký → 404', async () => {
        reset(); await rejects(Otp.resend('khongco@x.vn', T0), 404, /đăng ký lại/);
    });

    console.log('Nhập mã');
    await test('mã đúng (cho phép có khoảng trắng) → trả dữ liệu tạo tài khoản (mật khẩu đã băm) và xóa yêu cầu; dùng lại mã → không còn', async () => {
        reset();
        await Otp.start(data(), T0); const code = sent[0].code;
        const res = await Otp.verify('khachmoi@gmail.com', `${code.slice(0, 3)} ${code.slice(3)}`, at(30));
        assert.deepStrictEqual(Object.keys(res).sort(), ['email', 'full_name', 'password_hash', 'username']);
        assert.strictEqual(res.email, 'khachmoi@gmail.com'); assert.strictEqual(otpRows.length, 0);
        await rejects(Otp.verify('khachmoi@gmail.com', code, at(31)), 404);
    });
    await test('mã sai → báo số lần còn lại; sai 5 lần thì khóa mã (kể cả nhập đúng sau đó) cho tới khi gửi mã mới', async () => {
        reset();
        await Otp.start(data(), T0); const code = sent[0].code; const wrong = code === '000000' ? '111111' : '000000';
        for (let left = 4; left >= 1; left -= 1) await rejects(Otp.verify('khachmoi@gmail.com', wrong, at(10)), 400, new RegExp(`còn ${left} lần`));
        await rejects(Otp.verify('khachmoi@gmail.com', wrong, at(10)), 429, /Gửi lại mã/);
        await rejects(Otp.verify('khachmoi@gmail.com', code, at(11)), 429, /sai quá nhiều lần/);
        await Otp.resend('khachmoi@gmail.com', at(70));
        assert.strictEqual((await Otp.verify('khachmoi@gmail.com', sent[1].code, at(71))).username, 'khachmoi');
    });
    await test('mã hết hạn sau 10 phút; mã không phải 6 chữ số bị từ chối ngay (không tính lần sai)', async () => {
        reset();
        await Otp.start(data(), T0); const code = sent[0].code;
        await rejects(Otp.verify('khachmoi@gmail.com', '12ab56', at(5)), 400, /6 chữ số/);
        assert.strictEqual(otpRows[0].attempts, 0);
        await rejects(Otp.verify('khachmoi@gmail.com', code, at(601)), 410, /hết hạn/);
    });
    await test('OTP_TTL_MINUTES / OTP_RESEND_SECONDS / OTP_MAX_ATTEMPTS đổi được qua .env', async () => {
        reset();
        Object.assign(process.env, { OTP_TTL_MINUTES: '5', OTP_RESEND_SECONDS: '30', OTP_MAX_ATTEMPTS: '2' });
        try {
            const info = await Otp.start(data(), T0); assert.strictEqual(info.expires_in, 300); assert.strictEqual(info.resend_in, 30);
            const wrong = sent[0].code === '000000' ? '111111' : '000000';
            await rejects(Otp.verify('khachmoi@gmail.com', wrong, at(1)), 400, /còn 1 lần/);
            await rejects(Otp.verify('khachmoi@gmail.com', wrong, at(2)), 429);
        } finally { delete process.env.OTP_TTL_MINUTES; delete process.env.OTP_RESEND_SECONDS; delete process.env.OTP_MAX_ATTEMPTS; }
    });
    await test('che email: tên ngắn vẫn che được, chuỗi không phải email giữ nguyên', () => {
        assert.strictEqual(Otp.maskEmail('ab@x.vn'), 'a*@x.vn'); assert.strictEqual(Otp.maskEmail('muihoangdong@gmail.com'), 'mu**********@gmail.com'); assert.strictEqual(Otp.maskEmail('abc'), 'abc');
    });

    console.log('Gửi email thật (mailer)');
    await test('chưa cấu hình SMTP: dev in mã ra console; production báo 503 rõ ràng, không lộ mã', async () => {
        delete require.cache[require.resolve(src('services/mailer.js'))];
        const Module = require('module');
        const real = Module._load(src('services/mailer.js'), null); // nạp bản thật (bỏ qua bản giả dùng cho service)
        delete process.env.SMTP_HOST;
        const dev = await H.capture(() => real.sendRegisterOtp({ email: 'a@b.vn', code: '123456', ttlMinutes: 10 }));
        assert.deepStrictEqual(dev.result, { delivered: false }); assert(dev.logs.some((l) => /123456/.test(l) && /a@b\.vn/.test(l)));
        process.env.NODE_ENV = 'production';
        try {
            const { result: e, logs } = await H.capture(() => real.sendRegisterOtp({ email: 'a@b.vn', code: '654321', ttlMinutes: 10 }).catch((x) => x));
            assert.strictEqual(e.status, 503); assert(/chưa cấu hình gửi email/.test(e.message)); assert(!logs.some((l) => /654321/.test(l)), 'production không in mã');
        } finally { delete process.env.NODE_ENV; }
    });

    done(); setImmediate(() => process.exit(process.exitCode || 0));
})();
