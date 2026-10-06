#!/usr/bin/env node
'use strict';

/**
 * Sửa vai trò sai trong database: các khách đã đăng ký từ storefront trước đây đang mang vai trò 'staff'.
 * Script không thể tự biết ai là nhân viên thật, nên BẠN phải nêu rõ danh sách tài khoản cần GIỮ là nhân viên.
 *
 *   node scripts/fix-roles.js                       Xem trước: liệt kê admin/staff hiện có (không ghi gì)
 *   node scripts/fix-roles.js --keep nv1,nv2        Xem trước: staff KHÔNG nằm trong danh sách sẽ bị hạ xuống 'customer'
 *   node scripts/fix-roles.js --keep nv1,nv2 --apply   Thực hiện thay đổi
 *   node scripts/fix-roles.js --keep none --apply      Hạ TẤT CẢ staff (giữ nguyên admin)
 *
 * An toàn: mặc định chỉ xem trước; không bao giờ đổi vai trò 'admin'; từ chối chạy nếu không còn admin nào;
 * tự thêm giá trị 'customer' vào cột users.role nếu thiếu; gán 'customer' cho vai trò rỗng/không hợp lệ.
 * Nên sao lưu database trước khi dùng --apply.
 */

const { ROLES, DEFAULT_ROLE } = require('../src/config/roles');

const parseArgs = (argv) => {
    const args = { apply: false, keep: null };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--apply') args.apply = true;
        else if (argv[i] === '--keep') {
            const raw = argv[i + 1];
            if (raw === undefined || raw.startsWith('--')) throw new Error('--keep cần một giá trị, ví dụ: --keep nv1,nv2 (hoặc --keep none)');
            args.keep = raw.toLowerCase() === 'none' ? [] : raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
            i += 1;
        } else throw new Error(`Tham số không hợp lệ: ${argv[i]}`);
    }
    return args;
};

const enumValues = (type) => {
    const m = /^enum\((.*)\)$/i.exec(String(type || ''));
    return m ? [...m[1].matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1].replace(/''/g, "'")) : null;
};
const enumSql = (values) => values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');

/** @param {string[]} argv @param {{query:Function, log?:Function}} deps */
async function run(argv, { query, log = console.log }) {
    const args = parseArgs(argv);
    const out = { changes: [], alterations: [], applied: false };

    // 1) Cột role đã hỗ trợ 'customer' chưa?
    const cols = await query("SHOW COLUMNS FROM users LIKE 'role'");
    const type = cols[0] ? String(cols[0].Type) : '';
    const current = enumValues(type);
    let widened = null;
    if (current && !current.includes(DEFAULT_ROLE)) {
        widened = [...current, DEFAULT_ROLE];
        out.alterations.push(`ALTER TABLE users MODIFY COLUMN role ENUM(${enumSql(widened)}) NOT NULL DEFAULT '${DEFAULT_ROLE}'`);
    }

    // 2) Lập kế hoạch thay đổi
    const users = await query('SELECT id, username, email, full_name, role, status FROM users ORDER BY id');
    const keep = args.keep ? new Set(args.keep) : null;
    const admins = users.filter((u) => u.role === 'admin');
    if (!admins.length) throw new Error('Không có tài khoản admin nào trong database. Dừng lại để tránh khóa hệ thống.');

    for (const u of users) {
        if (u.role === 'admin' || u.role === DEFAULT_ROLE) continue;
        if (!ROLES.includes(u.role)) {
            out.changes.push({ ...u, to: DEFAULT_ROLE, reason: 'vai trò rỗng/không hợp lệ' });
        } else if (u.role === 'staff' && keep && !keep.has(String(u.username).toLowerCase())) {
            out.changes.push({ ...u, to: DEFAULT_ROLE, reason: 'không nằm trong danh sách --keep' });
        }
    }
    if (keep) {
        const known = new Set(users.map((u) => String(u.username).toLowerCase()));
        const unknown = [...keep].filter((k) => !known.has(k));
        if (unknown.length) log(`⚠️  Không tìm thấy tài khoản trong --keep: ${unknown.join(', ')} (kiểm tra lại chính tả)`);
    }

    // 3) In báo cáo
    const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
    log('\nTài khoản đang có quyền quản trị/nhân viên:');
    log(`${pad('ID', 5)}${pad('Username', 20)}${pad('Email', 30)}${pad('Vai trò', 10)}Trạng thái`);
    for (const u of users.filter((x) => x.role !== DEFAULT_ROLE)) {
        const change = out.changes.find((c) => c.id === u.id);
        log(`${pad(u.id, 5)}${pad(u.username, 20)}${pad(u.email, 30)}${pad(u.role, 10)}${pad(u.status, 9)}${change ? `  → ${change.to}  (${change.reason})` : ''}`);
    }
    if (out.alterations.length) log(`\nSẽ sửa cột: ${out.alterations.join(';\n')}`);
    log(`\n${out.changes.length} tài khoản sẽ đổi sang '${DEFAULT_ROLE}'.`);
    if (!keep) {
        log("\nℹ️  Chưa có --keep nên chưa hạ quyền staff nào. Hãy xem danh sách ở trên, rồi chạy lại với --keep <các username là nhân viên thật>.");
    }

    // 4) Thực hiện
    if (!args.apply) {
        log('\n(Chế độ xem trước — chưa ghi gì. Thêm --apply để thực hiện.)');
        return out;
    }
    for (const sql of out.alterations) await query(sql);
    if (out.changes.length) {
        await query('UPDATE users SET role = ? WHERE id IN (?)', [DEFAULT_ROLE, out.changes.map((c) => c.id)]);
    }
    // Thu gọn cột về đúng 3 vai trò chuẩn nếu từng chứa giá trị lạ, hoặc đặt mặc định 'customer' nếu chưa phải
    // (mọi giá trị lạ trong dữ liệu đã được đổi sang 'customer' ở trên nên bước này không làm mất dữ liệu).
    const needsStrict = current && current.some((v) => !ROLES.includes(v));
    const needsDefault = current && current.includes(DEFAULT_ROLE) && cols[0].Default !== DEFAULT_ROLE;
    if (needsStrict || needsDefault) {
        const sql = `ALTER TABLE users MODIFY COLUMN role ENUM(${enumSql(ROLES)}) NOT NULL DEFAULT '${DEFAULT_ROLE}'`;
        out.alterations.push(sql);
        await query(sql);
    }
    out.applied = true;
    log(`\n✅ Đã áp dụng: ${out.changes.length} tài khoản đổi vai trò${out.alterations.length ? `, ${out.alterations.length} thay đổi cấu trúc cột` : ''}.`);
    return out;
}

module.exports = { run, parseArgs, enumValues };

if (require.main === module) {
    const db = require('../src/config/database');
    run(process.argv.slice(2), { query: db.query })
        .then(() => db.closePool())
        .catch(async (error) => {
            console.error(`\n❌ ${error.message}`);
            try { await db.closePool(); } catch { /* bỏ qua */ }
            process.exit(1);
        });
}
