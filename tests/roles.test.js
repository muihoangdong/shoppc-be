// Kiểm thử mô hình vai trò, model User và script sửa dữ liệu cũ (không cần MySQL).
// Chạy:  node tests/roles.test.js
const Module = require('module');
const path = require('path');
const assert = require('assert');
const BE = path.join(__dirname, '..');

// ───────────── bản giả: DB + bcryptjs (model User thật được nạp) ─────────────
const inserts = [];
const fakeDb = {
    pool: { query: async (sql, params) => { inserts.push({ sql, params }); return [{ insertId: 7 }]; } },
    query: async () => [],
};
const origLoad = Module._load;
Module._load = function (request, parent) {
    if (request === 'bcryptjs') return { hash: async (p) => `h:${p}`, compare: async () => true };
    if (request === 'dotenv') return { config() {} };
    if (parent && request.startsWith('.') && require.resolve(path.resolve(path.dirname(parent.filename), request)) === path.join(BE, 'src/config/database.js')) return fakeDb;
    return origLoad.apply(this, arguments);
};
const Roles = require(path.join(BE, 'src/config/roles.js'));
const User = require(path.join(BE, 'src/models/User.js'));
const FixRoles = require(path.join(BE, 'scripts/fix-roles.js'));

let passed = 0;
const test = async (name, fn) => {
    try { await fn(); passed++; console.log('  ✓', name); }
    catch (e) { console.log('  ✗', name, '\n   ', e.stack.split('\n').slice(0, 4).join('\n    ')); process.exitCode = 1; }
};

// ───────────── fake DB cho fix-roles ─────────────
const makeDb = ({ type = "enum('admin','staff')", def = 'staff', users }) => {
    const log = [];
    const query = async (sql, params) => {
        log.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        if (/^SHOW COLUMNS/.test(sql)) return [{ Type: type, Default: def }];
        if (/^SELECT id, username/.test(sql)) return users.map((u) => ({ ...u }));
        return { affectedRows: 1 };
    };
    const writes = () => log.filter((l) => /^(ALTER|UPDATE)/.test(l.sql));
    return { query, log, writes };
};
const base = [
    { id: 1, username: 'admin', email: 'a@x', full_name: 'A', role: 'admin', status: 'active' },
    { id: 2, username: 'NhanVien1', email: 'n1@x', full_name: 'N1', role: 'staff', status: 'active' },
    { id: 3, username: 'khach_a', email: 'k1@x', full_name: 'K1', role: 'staff', status: 'active' },
    { id: 4, username: 'khach_b', email: 'k2@x', full_name: 'K2', role: 'staff', status: 'active' },
    { id: 5, username: 'real_customer', email: 'k3@x', full_name: 'K3', role: 'customer', status: 'active' },
];
const quiet = () => { const lines = []; return { log: (...a) => lines.push(a.join(' ')), lines }; };

(async () => {
    console.log('Mô hình vai trò');
    await test('thứ bậc: admin ⊇ staff ⊇ customer; vai trò lạ không có quyền gì', () => {
        const can = (r, min) => Roles.hasRole(r, min);
        assert(can('admin', 'admin') && can('admin', 'staff') && can('admin', 'customer'));
        assert(!can('staff', 'admin') && can('staff', 'staff') && can('staff', 'customer'));
        assert(!can('customer', 'admin') && !can('customer', 'staff') && can('customer', 'customer'));
        for (const bad of [undefined, null, '', 'owner', 'ADMIN', 'constructor', '__proto__', 'toString', 1, {}]) {
            assert.strictEqual(can(bad, 'customer'), false, `vai trò lạ: ${String(bad)}`);
        }
        assert.deepStrictEqual(Roles.ROLES, ['customer', 'staff', 'admin']);
        assert.strictEqual(Roles.DEFAULT_ROLE, 'customer');
        for (const r of Roles.ROLES) assert(Roles.ROLE_LABELS[r]);
    });
    await test('model User: tạo tài khoản mà không nêu vai trò -> "customer" (trước đây là "staff")', async () => {
        inserts.length = 0;
        await User.createUser({ username: 'u', password: 'secret1', email: 'u@x', full_name: 'U' });
        assert.strictEqual(inserts[0].params[5], 'customer');
        await User.createUser({ username: 'v', password: 'secret1', email: 'v@x', full_name: 'V', role: 'staff' });
        assert.strictEqual(inserts[1].params[5], 'staff');
    });

    console.log('Script sửa dữ liệu cũ (fix-roles)');
    await test('xem trước không --keep: không ghi gì, không hạ staff nào, hướng dẫn dùng --keep', async () => {
        const db = makeDb({ users: base }); const q = quiet();
        const out = await FixRoles.run([], { query: db.query, log: q.log });
        assert.strictEqual(db.writes().length, 0); assert.strictEqual(out.changes.length, 0);
        assert(q.lines.join('\n').includes('--keep'));
    });
    await test('xem trước với --keep: liệt kê đúng người sẽ bị hạ (không phân biệt hoa thường), vẫn không ghi', async () => {
        const db = makeDb({ users: base }); const q = quiet();
        const out = await FixRoles.run(['--keep', 'nhanvien1'], { query: db.query, log: q.log });
        assert.deepStrictEqual(out.changes.map((c) => c.id), [3, 4]);
        assert.strictEqual(db.writes().length, 0);
        assert(q.lines.join('\n').includes('Chế độ xem trước'));
    });
    await test('--apply: mở rộng cột trước, rồi hạ đúng 2 khách; admin & nhân viên giữ nguyên', async () => {
        const db = makeDb({ users: base });
        const out = await FixRoles.run(['--keep', 'NhanVien1', '--apply'], { query: db.query, log: () => {} });
        const w = db.writes();
        assert.strictEqual(w.length, 2);
        assert(/^ALTER TABLE users MODIFY COLUMN role ENUM\('admin', 'staff', 'customer'\)/.test(w[0].sql) && /DEFAULT 'customer'/.test(w[0].sql));
        assert.strictEqual(w[1].sql, 'UPDATE users SET role = ? WHERE id IN (?)');
        assert.deepStrictEqual(w[1].params, ['customer', [3, 4]]);
        assert(out.applied);
    });
    await test('cột đã có customer + mặc định customer: chỉ UPDATE, không ALTER thừa', async () => {
        const db = makeDb({ type: "enum('admin','staff','customer')", def: 'customer', users: base });
        await FixRoles.run(['--keep', 'nhanvien1', '--apply'], { query: db.query, log: () => {} });
        assert.deepStrictEqual(db.writes().map((x) => x.sql.split(' ')[0]), ['UPDATE']);
    });
    await test('cột đã có customer nhưng mặc định cũ là staff: chỉnh mặc định về customer', async () => {
        const db = makeDb({ type: "enum('admin','staff','customer')", def: 'staff', users: base });
        await FixRoles.run(['--apply'], { query: db.query, log: () => {} });
        const w = db.writes(); assert.strictEqual(w.length, 1); assert(/DEFAULT 'customer'/.test(w[0].sql));
    });
    await test('--keep none hạ mọi staff nhưng không đụng admin; không có thay đổi thì không UPDATE', async () => {
        let db = makeDb({ type: "enum('admin','staff','customer')", def: 'customer', users: base });
        const out = await FixRoles.run(['--keep', 'none', '--apply'], { query: db.query, log: () => {} });
        assert.deepStrictEqual(out.changes.map((c) => c.id), [2, 3, 4]);
        db = makeDb({ type: "enum('admin','staff','customer')", def: 'customer', users: [base[0], base[4]] });
        await FixRoles.run(['--apply'], { query: db.query, log: () => {} });
        assert.strictEqual(db.writes().length, 0);
    });
    await test('vai trò rỗng/lạ -> customer và cột được thu gọn về đúng 3 vai trò', async () => {
        const users = [base[0], { id: 9, username: 'cu', email: 'c@x', full_name: 'C', role: 'user', status: 'active' }, { id: 10, username: 'cu2', email: 'c2@x', full_name: 'C2', role: '', status: 'active' }];
        const db = makeDb({ type: "enum('admin','staff','user')", def: 'user', users });
        const out = await FixRoles.run(['--apply'], { query: db.query, log: () => {} });
        assert.deepStrictEqual(out.changes.map((c) => c.id), [9, 10]);
        const w = db.writes().map((x) => x.sql);
        assert(/ENUM\('admin', 'staff', 'user', 'customer'\)/.test(w[0]), w[0]);
        assert(w[1].startsWith('UPDATE'));
        assert(/ENUM\('customer', 'staff', 'admin'\)/.test(w[2]), w[2]);
    });
    await test('từ chối chạy khi không còn admin; tham số sai báo lỗi rõ ràng; cảnh báo username gõ sai', async () => {
        const noAdmin = makeDb({ users: base.slice(1) });
        await assert.rejects(FixRoles.run(['--apply'], { query: noAdmin.query, log: () => {} }), /admin/);
        assert.strictEqual(noAdmin.writes().length, 0);
        assert.throws(() => FixRoles.parseArgs(['--keep']), /--keep cần/);
        assert.throws(() => FixRoles.parseArgs(['--xoa-het']), /không hợp lệ/);
        const q = quiet(); const db = makeDb({ users: base });
        await FixRoles.run(['--keep', 'nhanvien1,gotsai'], { query: db.query, log: q.log });
        assert(q.lines.join('\n').includes('gotsai'));
    });
    await test('enumValues đọc đúng kiểu enum', () => {
        assert.deepStrictEqual(FixRoles.enumValues("enum('admin','staff')"), ['admin', 'staff']);
        assert.strictEqual(FixRoles.enumValues('varchar(20)'), null);
    });

    console.log('Script tạo admin đầu tiên (create-admin)');
    const CreateAdmin = require(path.join(BE, 'scripts/create-admin.js'));
    const userStub = (existing = {}) => { const created = []; return { created, getUserByUsername: async (u) => existing.username === u, getUserByEmail: async (e) => existing.email === e, createUser: async (d) => { created.push(d); return 7; } }; };
    await test('create-admin: tạo vai trò admin; mật khẩu lấy từ biến môi trường; kiểm tra đầu vào và trùng lặp', async () => {
        const U = userStub(); const args = ['--username', 'chu', '--email', 'chu@shop.vn', '--name', 'Chủ'];
        assert.strictEqual(await CreateAdmin.run(args, { User: U, env: { ADMIN_PASSWORD: 'matkhau-manh' }, log: () => {} }), 7);
        assert.deepStrictEqual(U.created[0], { username: 'chu', password: 'matkhau-manh', email: 'chu@shop.vn', full_name: 'Chủ', role: 'admin' });
        await assert.rejects(CreateAdmin.run(args, { User: userStub(), env: {}, log: () => {} }), /ADMIN_PASSWORD/);
        await assert.rejects(CreateAdmin.run(args, { User: userStub(), env: { ADMIN_PASSWORD: 'ngan' }, log: () => {} }), /tối thiểu 8/);
        await assert.rejects(CreateAdmin.run(['--username', 'a b', '--email', 'x@y.vn'], { User: userStub(), env: { ADMIN_PASSWORD: 'matkhau-manh' }, log: () => {} }), /username/);
        await assert.rejects(CreateAdmin.run(['--username', 'chu', '--email', 'sai'], { User: userStub(), env: { ADMIN_PASSWORD: 'matkhau-manh' }, log: () => {} }), /email/);
        await assert.rejects(CreateAdmin.run(args, { User: userStub({ username: 'chu' }), env: { ADMIN_PASSWORD: 'matkhau-manh' }, log: () => {} }), /đã tồn tại/);
        await assert.rejects(CreateAdmin.run(args, { User: userStub({ email: 'chu@shop.vn' }), env: { ADMIN_PASSWORD: 'matkhau-manh' }, log: () => {} }), /đã được sử dụng/);
        assert.throws(() => CreateAdmin.parseArgs(['--password', 'x']), /không hợp lệ/); assert.throws(() => CreateAdmin.parseArgs(['--username']), /cần một giá trị/);
    });

    console.log(`\n${passed} test đạt`);
})();
