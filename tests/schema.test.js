// Kiểm thử cấu trúc database: schema chuẩn khớp với code, và việc nâng cấp database CŨ (lấy từ dump thật) lên schema chuẩn.
// Không cần MySQL. Chạy:  node tests/schema.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/harness');
const { src } = H;
const { extractSql, walk, validateSql } = require('./helpers/sqlcheck');
const { createSim } = require('./helpers/schemaSim');
delete process.env.NODE_ENV;

const db = { query: async () => [], pool: { query: async () => [[]] }, getClient: async () => ({}) };
H.install(new Map([[src('config/database.js'), db]]));

const Schema = require(src('config/schema.js'));
const OrderStatus = require(src('config/orderStatus.js'));
const Roles = require(src('config/roles.js'));
const Migrate = require('../scripts/migrate-db.js');
const { test, done } = H.runner();

const BE_ROOT = path.join(__dirname, '..');
const target = Schema.loadTarget();
const legacy = Schema.parseDdl(fs.readFileSync(path.join(__dirname, 'fixtures', 'legacy-schema.sql'), 'utf8'));
const ORDER_ROWS = () => ({
    orders: [{ status: 'pending' }, { status: 'confirmed' }, { status: 'shipping' }, { status: 'delivered' }, { status: 'cancelled' }, { status: 'shipping' }],
    order_status_history: [{ old_status: null, new_status: 'pending' }, { old_status: 'pending', new_status: 'confirmed' }, { old_status: 'confirmed', new_status: 'shipping' }, { old_status: 'shipping', new_status: 'delivered' }]
});
const capture = (fn) => H.capture(fn);

(async () => {
    console.log('Schema chuẩn');
    await test('đọc được 12 bảng; mỗi bảng có khóa chính; khóa ngoại trỏ tới bảng/cột có thật', () => {
        assert.deepStrictEqual(target.order, ['users', 'categories', 'products', 'cart_items', 'orders', 'order_items', 'order_status_history', 'shipping_tracking', 'support_conversations', 'support_messages', 'email_otps', 'coupons']);
        for (const t of Object.values(target.tables)) {
            assert(t.indexes.some((i) => i.primary), `${t.name} thiếu khóa chính`);
            for (const f of t.foreignKeys) { assert(target.tables[f.refTable], `${t.name}.${f.column} -> bảng ${f.refTable} không có`); assert(target.tables[f.refTable].columns.some((c) => c.name === f.refColumn)); assert(t.columns.some((c) => c.name === f.column)); }
            for (const i of t.indexes) for (const c of i.columns) assert(t.columns.some((x) => x.name === c), `${t.name}: chỉ mục ${i.name} dùng cột ${c} không có`);
        }
        const order = target.order; for (const t of Object.values(target.tables)) for (const f of t.foreignKeys) assert(order.indexOf(f.refTable) <= order.indexOf(t.name), `${t.name} được tạo trước bảng ${f.refTable} mà nó tham chiếu`);
    });
    await test('kiểu cột của khóa ngoại khớp với cột được tham chiếu (MySQL từ chối nếu lệch kiểu/dấu)', () => {
        for (const t of Object.values(target.tables)) for (const f of t.foreignKeys) {
            const a = t.columns.find((c) => c.name === f.column).type; const b = target.tables[f.refTable].columns.find((c) => c.name === f.refColumn).type;
            assert.strictEqual(Schema.normType(a), Schema.normType(b), `${t.name}.${f.column} (${a}) ≠ ${f.refTable}.${f.refColumn} (${b})`);
        }
    });
    await test('hằng số trong code đều là giá trị hợp lệ của cột enum tương ứng', () => {
        const en = (t, c) => target.tables[t].columns.find((x) => x.name === c).enumValues;
        assert.deepStrictEqual([...OrderStatus.ORDER_STATUSES].sort(), [...en('orders', 'status')].sort(), 'trạng thái đơn trong code = enum orders.status');
        for (const s of OrderStatus.REVENUE_STATUSES) assert(en('orders', 'status').includes(s), s);
        for (const s of ['pending', 'paid']) assert(en('orders', 'payment_status').includes(s)); for (const s of ['cod', 'banking']) assert(en('orders', 'payment_method').includes(s));
        assert.deepStrictEqual([...Roles.ROLES].sort(), [...en('users', 'role')].sort(), 'vai trò trong code = enum users.role');
        assert.deepStrictEqual(en('support_messages', 'sender_type'), ['customer', 'staff', 'ai', 'system']); assert.deepStrictEqual(en('support_conversations', 'status'), ['open', 'closed']);
        assert.deepStrictEqual(en('categories', 'type'), ['pc', 'component', 'peripheral']);
    });
    await test('MỌI câu SQL trong code (src + scripts) chỉ dùng bảng/cột/giá trị enum có trong schema chuẩn', () => {
        const files = [...walk(path.join(BE_ROOT, 'src')), ...walk(path.join(BE_ROOT, 'scripts'))];
        let total = 0; const bad = [];
        for (const f of files) for (const q of extractSql(f)) { total += 1; for (const p of validateSql(q.sql, target)) bad.push(`${path.relative(BE_ROOT, f)}: ${p}\n      ${q.sql.slice(0, 120)}`); }
        assert(total >= 90, `chỉ đọc được ${total} câu SQL — bộ trích xuất có thể hỏng`);
        assert.deepStrictEqual(bad, []);
    });
    await test('bộ kiểm tra SQL tự nó hoạt động: bắt được bảng/cột/enum sai (tránh "xanh giả")', () => {
        for (const sql of ['SELECT nam FROM products', 'SELECT * FROM san_pham', 'UPDATE orders SET tracking = ? WHERE id = ?', "UPDATE orders SET status = 'dang_giao' WHERE id = ?", "SELECT id FROM orders WHERE status IN ('pending','x')", 'SELECT p.gia FROM products p']) assert(validateSql(sql, target).length > 0, sql);
        assert.deepStrictEqual(validateSql("SELECT id FROM orders WHERE status = 'shipped'", target), []);
        // INSERT thiếu cột NOT NULL không có mặc định => MySQL strict báo lỗi 1364
        assert(validateSql('INSERT INTO users (username, email) VALUES (?, ?)', target).some((p) => /thiếu cột bắt buộc: password/.test(p)));
        assert(validateSql('INSERT INTO order_items (order_id, quantity) VALUES (?, ?)', target).some((p) => /thiếu cột bắt buộc: product_id/.test(p)));
        assert.deepStrictEqual(validateSql('INSERT INTO cart_items (session_id, product_id, quantity) VALUES (?, ?, ?)', target), []);
    });
    await test('độ dài tối đa code cho phép nhập ≤ độ rộng cột trong database (tránh lỗi "Data too long" của MySQL strict)', () => {
        const width = (t, c) => Number(/varchar\((\d+)\)/.exec(target.tables[t].columns.find((x) => x.name === c).type)[1]);
        const srcText = fs.readFileSync(path.join(BE_ROOT, 'src/controllers/orderController.js'), 'utf8');
        const limits = new Function(`return ${/const ORDER_FIELDS = (\{[\s\S]*?\});/.exec(srcText)[1]}`)();
        for (const [field, max] of Object.entries(limits)) if (field !== 'note') assert(max <= width('orders', field), `orders.${field}: code cho ${max} > cột ${width('orders', field)}`);
        assert(width('cart_items', 'session_id') >= 100 && width('orders', 'order_code') >= 30);
        // tên khách/nhân viên trong chat lấy từ users.full_name nên cột chat phải rộng ít nhất bằng nó
        assert(width('support_conversations', 'customer_name') >= width('users', 'full_name')); assert(width('support_messages', 'sender_name') >= width('users', 'full_name'));
        assert(width('support_conversations', 'customer_phone') >= 20 && width('products', 'name') >= 255 && width('categories', 'name') >= 100 && width('users', 'email') >= 150);
    });
    await test('file schema.sql ở thư mục gốc dự án (db/init) giống hệt bản trong shoppc-be/db (docker-compose dùng bản đó)', () => {
        const root = path.join(BE_ROOT, '..', 'db', 'init', '01_schema.sql');
        if (!fs.existsSync(root)) return; // chạy riêng backend
        assert.strictEqual(fs.readFileSync(root, 'utf8'), fs.readFileSync(Schema.SCHEMA_PATH, 'utf8'));
    });

    await test('đọc và sinh enum có dấu nháy đơn ("it\'s") và dấu phẩy đúng; enum tạm khi nâng cấp giữ nguyên giá trị đặc biệt', () => {
        const t = Schema.parseDdl("CREATE TABLE `x` (\n  `id` int NOT NULL,\n  `k` enum('a','it''s','b,c') NOT NULL DEFAULT 'a',\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB;");
        assert.deepStrictEqual(t.tables.x.columns[1].enumValues, ['a', "it's", 'b,c']);
        const cur = Schema.parseDdl("CREATE TABLE `x` (\n  `id` int NOT NULL,\n  `k` enum('a','cu','it''s') NOT NULL DEFAULT 'a',\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB;");
        const plan = Schema.diff(cur, t);
        assert(plan.ops.some((o) => o.kind === 'enum-widen' && /'it''s'/.test(o.sql) && /'b,c'/.test(o.sql) && /'cu'/.test(o.sql)), plan.ops.map((o) => o.sql).join(' | '));
        assert.deepStrictEqual(Schema.enumValues("enum('x','y''z')"), ['x', "y'z"]);
    });
    console.log('Database CŨ (lấy từ dump thật) so với code');
    await test('database cũ không lưu được "shipped"/"completed" → bị phân loại NGHIÊM TRỌNG; thiếu bảng chat → cảnh báo; thiếu chỉ mục → thông tin', () => {
        const have = legacy.tables.orders.columns.find((c) => c.name === 'status').enumValues;
        assert.deepStrictEqual(OrderStatus.ORDER_STATUSES.filter((s) => !have.includes(s)).sort(), ['completed', 'shipped']);
        const issues = Schema.classify(Schema.diff(legacy, target));
        const by = (lv) => issues.filter((i) => i.level === lv);
        assert.strictEqual(by('critical').length, 1); assert(/orders\.status.*shipped.*completed/.test(by('critical')[0].message));
        assert.deepStrictEqual(by('warning').map((i) => i.op.table).sort(), ['coupons', 'email_otps', 'orders', 'products', 'products', 'support_conversations', 'support_messages']);
        assert.strictEqual(by('info').length, 7);
        assert.deepStrictEqual(Schema.classify(Schema.diff(target, target)), []);
    });
    await test('kế hoạch nâng cấp: đúng các bước, đúng thứ tự, KHÔNG có lệnh xóa; mọi lệnh thuộc dạng đã biết', () => {
        const plan = Schema.diff(legacy, target); const kinds = plan.ops.map((o) => o.kind);
        assert.deepStrictEqual(plan.warnings, []);
        assert.strictEqual(kinds.filter((k) => k === 'create-table').length, 4); assert.strictEqual(kinds.filter((k) => k === 'add-index').length, 7);
        assert(kinds.indexOf('enum-widen') < kinds.indexOf('map-values') && kinds.indexOf('map-values') < kinds.indexOf('guard') && kinds.indexOf('guard') < kinds.indexOf('enum-set'), 'mở rộng → đổi dữ liệu → kiểm tra → thu hẹp');
        assert(kinds.indexOf('create-table') < kinds.indexOf('enum-widen'));
        for (const op of plan.ops) assert(!/^\s*(DROP|DELETE\s+FROM|TRUNCATE|RENAME)\b/i.test(op.sql) && !/\bALTER TABLE\s+\S+\s+(DROP|RENAME)\b/i.test(op.sql), `lệnh nguy hiểm: ${op.sql}`); // ("ON DELETE SET NULL" trong khóa ngoại là hợp lệ)
        assert(plan.ops.filter((o) => o.kind === 'map-values' && o.table === 'orders').every((o) => /`updated_at` = `updated_at`/.test(o.sql)), 'giữ nguyên updated_at của đơn');
        assert(plan.ops.filter((o) => o.kind === 'map-values' && o.table === 'order_status_history').every((o) => !/updated_at/.test(o.sql)));
        const widen = plan.ops.find((o) => o.kind === 'enum-widen').sql; assert(/'confirmed'/.test(widen) && /'shipping'/.test(widen) && /'shipped'/.test(widen), 'enum tạm chứa cả giá trị cũ lẫn mới');
        const final = plan.ops.find((o) => o.kind === 'enum-set').sql; assert(!/confirmed|shipping/.test(final) && /'completed'/.test(final));
    });
    await test('chạy kế hoạch trên mô phỏng MySQL: dữ liệu đổi đúng (confirmed→processing, shipping→shipped, cả bảng lịch sử), cấu trúc khớp schema chuẩn, chạy lại không còn việc', async () => {
        const sim = createSim(legacy, ORDER_ROWS());
        const plan = Schema.diff(await Schema.readSnapshot(sim), target);
        const n = await Schema.applyPlan(sim, plan.ops);
        assert.strictEqual(n, plan.ops.length);
        assert.deepStrictEqual(sim.state.rows.orders.map((r) => r.status), ['pending', 'processing', 'shipped', 'delivered', 'cancelled', 'shipped']);
        assert.deepStrictEqual(sim.state.rows.order_status_history.map((r) => [r.old_status, r.new_status]), [[null, 'pending'], ['pending', 'processing'], ['processing', 'shipped'], ['shipped', 'delivered']]);
        assert.deepStrictEqual(Schema.diff(await Schema.readSnapshot(sim), target), { ops: [], warnings: [] });
        assert.strictEqual(sim.state.rows.orders.length, 6, 'không mất dòng nào');
    });
    await test('trạng thái lạ không có quy tắc đổi: dừng AN TOÀN ở bước kiểm tra, dữ liệu và enum giữ nguyên (không mất dữ liệu)', async () => {
        const rows = ORDER_ROWS(); rows.orders.push({ status: 'refunded_weird' });
        const sim = createSim({ tables: JSON.parse(JSON.stringify(legacy.tables)) }, rows);
        sim.state.tables.orders.columns.find((c) => c.name === 'status').enumValues.push('refunded_weird');
        sim.state.tables.orders.columns.find((c) => c.name === 'status').type = `enum(${sim.state.tables.orders.columns.find((c) => c.name === 'status').enumValues.map((v) => `'${v}'`).join(',')})`;
        const plan = Schema.diff(await Schema.readSnapshot(sim), target);
        await assert.rejects(Schema.applyPlan(sim, plan.ops), /refunded_weird.*1 dòng/s);
        assert(sim.state.tables.orders.columns.find((c) => c.name === 'status').enumValues.includes('refunded_weird'), 'enum chưa bị thu hẹp');
        assert.strictEqual(sim.state.rows.orders.length, 7);
    });
    await test('mô phỏng đúng quy tắc MySQL: nếu bỏ qua bước đổi dữ liệu mà thu hẹp enum thì MySQL báo Data truncated (chứng tỏ thứ tự các bước là bắt buộc)', async () => {
        const sim = createSim(legacy, ORDER_ROWS()); const plan = Schema.diff(await Schema.readSnapshot(sim), target);
        const withoutMapping = plan.ops.filter((o) => o.kind !== 'map-values' && o.kind !== 'guard');
        await assert.rejects(Schema.applyPlan(sim, withoutMapping), /Data truncated/);
    });
    await test('đọc information_schema đúng với dạng dòng của MySQL 8 (non_unique là số hoặc chuỗi, NO ACTION, kiểu int(11) của MySQL cũ)', async () => {
        const sim = createSim(legacy);
        const fk = Schema._sql; assert(/DATABASE\(\)/.test(fk.SQL_COLUMNS) && /DATABASE\(\)/.test(fk.SQL_INDEXES) && /DATABASE\(\)/.test(fk.SQL_FKS));
        const columns = await sim.query(fk.SQL_COLUMNS); const indexes = (await sim.query(fk.SQL_INDEXES)).map((r) => ({ ...r, non_unique: String(r.non_unique) })); const fks = (await sim.query(fk.SQL_FKS)).map((r) => ({ ...r, delete_rule: r.delete_rule === 'RESTRICT' ? 'NO ACTION' : r.delete_rule }));
        const old = columns.map((c) => ({ ...c, column_type: c.column_type === 'int' ? 'int(11)' : c.column_type }));
        const snap = Schema.snapshotFromRows(old, indexes, fks);
        assert.deepStrictEqual(Schema.diff(snap, target).ops.map((o) => o.kind), Schema.diff(legacy, target).ops.map((o) => o.kind), 'cho cùng kế hoạch dù dạng dòng khác nhau');
        assert.deepStrictEqual(Schema.diff(snap, target).warnings, []);
    });
    await test('cảnh báo (không tự sửa) khi kiểu cột khác chuẩn hoặc chỉ mục trùng tên khác cấu trúc', async () => {
        const sim = createSim(legacy); sim.state.tables.products.columns.find((c) => c.name === 'stock').type = 'bigint';
        sim.state.tables.orders.indexes.push({ name: 'idx_orders_phone', unique: false, primary: false, columns: ['customer_name'] });
        const plan = Schema.diff(await Schema.readSnapshot(sim), target);
        assert(plan.warnings.some((w) => /products\.stock.*bigint.*int/.test(w))); assert(plan.warnings.some((w) => /idx_orders_phone/.test(w)));
        assert(!plan.ops.some((o) => o.kind === 'add-index' && o.name === 'idx_orders_phone'), 'không thêm chỉ mục trùng tên (sẽ lỗi)');
    });
    await test('bảng đã có thiếu cột/khóa ngoại: thêm cột và khóa ngoại', async () => {
        const sim = createSim(legacy); sim.state.tables.users.columns = sim.state.tables.users.columns.filter((c) => c.name !== 'avatar'); sim.state.tables.cart_items.foreignKeys = [];
        const plan = Schema.diff(await Schema.readSnapshot(sim), target);
        assert(plan.ops.some((o) => o.kind === 'add-column' && o.table === 'users' && o.column === 'avatar' && /ADD COLUMN `avatar` varchar\(255\) DEFAULT NULL/.test(o.sql)));
        assert(plan.ops.some((o) => o.kind === 'add-fk' && o.table === 'cart_items'));
        await Schema.applyPlan(sim, plan.ops); assert.deepStrictEqual(Schema.diff(await Schema.readSnapshot(sim), target).ops, []);
    });

    console.log('Lệnh npm run migrate-db');
    await test('xem trước (mặc định) KHÔNG thay đổi gì; --apply thực hiện; chạy lần hai báo đã khớp', async () => {
        const sim = createSim(legacy, ORDER_ROWS()); const out = []; const log = (l) => out.push(l);
        let r = await Migrate.run({ db: sim, args: [], log, target, dbName: 'shopdb' });
        assert.strictEqual(r.dryRun, true); assert.strictEqual(sim.state.log.length, 0, 'xem trước không chạy lệnh nào'); assert(/Cần 23 bước/.test(out.join('\n')) && /migrate-db -- --apply/.test(out.join('\n')) && /mysqldump/.test(out.join('\n')) && /"shopdb"/.test(out.join('\n')));
        assert.deepStrictEqual(sim.state.rows.orders.map((x) => x.status), ['pending', 'confirmed', 'shipping', 'delivered', 'cancelled', 'shipping'], 'dữ liệu chưa bị đụng');
        out.length = 0; r = await Migrate.run({ db: sim, args: ['--apply'], log, target }); assert.strictEqual(r.ok, true); assert.strictEqual(r.applied, 23); assert(/Xong \(23 bước\)/.test(out.join('\n')));
        out.length = 0; r = await Migrate.run({ db: sim, args: ['--apply'], log, target }); assert.strictEqual(r.applied, 0); assert(/đã khớp với code/.test(out.join('\n')));
    });
    await test('lỗi giữa chừng: báo rõ, các bước trước còn nguyên, chạy lại thì tiếp tục từ chỗ dở', async () => {
        const rows = ORDER_ROWS(); rows.orders.push({ status: 'lạ' });
        const sim = createSim(legacy, rows); const status = sim.state.tables.orders.columns.find((c) => c.name === 'status'); status.enumValues.push('lạ'); status.type = `enum(${status.enumValues.map((v) => `'${v}'`).join(',')})`;
        const out = []; const r = await Migrate.run({ db: sim, args: ['--apply'], log: (l) => out.push(l), target });
        assert.strictEqual(r.ok, false); assert(/Dừng ở một bước/.test(out.join('\n')) && /lạ/.test(out.join('\n')) && /chạy lại lệnh này/.test(out.join('\n')));
        assert(sim.state.tables.support_conversations && sim.state.tables.support_messages, 'các bước trước đó đã xong');
        sim.state.rows.orders = sim.state.rows.orders.filter((x) => x.status !== 'lạ'); // người dùng tự xử lý dòng lạ
        const out2 = []; const r2 = await Migrate.run({ db: sim, args: ['--apply'], log: (l) => out2.push(l), target }); assert.strictEqual(r2.ok, true); assert.deepStrictEqual(Schema.diff(await Schema.readSnapshot(sim), target).ops, []);
    });

    console.log('Kiểm tra khi khởi động server');
    const startup = require(src('config/startupChecks.js'));
    const quiet = { log() {}, warn() {} };
    const mkLog = () => { const out = []; return { out, log: (...a) => out.push(a.join(' ')), warn: (...a) => out.push(a.join(' ')) }; };
    const withDb = (sim, fn) => { const keep = [db.query, db.pool]; db.query = sim.query; db.pool = sim.pool; return fn().finally(() => { db.query = keep[0]; db.pool = keep[1]; }); };
    await test('database cũ: cảnh báo rõ (nêu lệnh sửa); ở production thì KHÔNG khởi động; database đúng thì báo khớp', async () => {
        const sim = createSim(legacy, ORDER_ROWS()); const l = mkLog();
        const r = await withDb(sim, () => startup.checkSchema({ log: l })); const txt = l.out.join('\n');
        assert.strictEqual(r.ok, false); assert(/orders\.status/.test(txt) && /support_conversations/.test(txt) && /npm run migrate-db -- --apply/.test(txt));
        process.env.NODE_ENV = 'production';
        try { await assert.rejects(withDb(createSim(legacy), () => startup.checkSchema({ log: quiet })), /migrate-db|AUTO_MIGRATE/); } finally { delete process.env.NODE_ENV; }
        const ok = createSim(target); const l2 = mkLog(); const r2 = await withDb(ok, () => startup.checkSchema({ log: l2 })); assert.strictEqual(r2.ok, true); assert(/khớp với code/.test(l2.out.join('\n')));
    });
    await test('chỉ thiếu chỉ mục (không ảnh hưởng đúng/sai): chỉ nhắc nhẹ, ở production vẫn khởi động', async () => {
        const sim = createSim(target); sim.state.tables.orders.indexes = sim.state.tables.orders.indexes.filter((i) => !/idx_orders/.test(i.name));
        process.env.NODE_ENV = 'production'; const l = mkLog();
        try { const r = await withDb(sim, () => startup.checkSchema({ log: l })); assert.strictEqual(r.ok, true); assert(/chỉ mục khuyến nghị/.test(l.out.join('\n'))); } finally { delete process.env.NODE_ENV; }
    });
    await test('AUTO_MIGRATE=true tự nâng cấp khi khởi động; SKIP_SCHEMA_CHECK=true bỏ qua; không đọc được database thì không chặn server', async () => {
        const sim = createSim(legacy, ORDER_ROWS()); process.env.AUTO_MIGRATE = 'true';
        try { const r = await withDb(sim, () => startup.checkSchema({ log: quiet })); assert.strictEqual(r.migrated, true); } finally { delete process.env.AUTO_MIGRATE; }
        assert.deepStrictEqual(Schema.diff(await Schema.readSnapshot(sim), target).ops, []);
        process.env.SKIP_SCHEMA_CHECK = 'true'; try { assert.strictEqual((await startup.checkSchema({ log: quiet })).skipped, true); } finally { delete process.env.SKIP_SCHEMA_CHECK; }
        const broken = { query: async () => { throw new Error('ECONNRESET'); }, pool: db.pool }; const keep = db.query; db.query = broken.query;
        try { const l = mkLog(); const r = await startup.checkSchema({ log: l }); assert.strictEqual(r.ok, true); assert(/Không kiểm tra được cấu trúc/.test(l.out.join('\n'))); } finally { db.query = keep; }
    });
    done(); setImmediate(() => process.exit(process.exitCode || 0));
})();
