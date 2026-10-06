#!/usr/bin/env node
'use strict';

/**
 * Tạo tài khoản QUẢN TRỊ đầu tiên (đăng ký công khai chỉ tạo khách hàng nên cần cách này khi cài mới).
 *
 *   ADMIN_PASSWORD='mat-khau-manh' npm run create-admin -- --username admin --email admin@shop.vn --name "Chủ cửa hàng"
 *
 * Mật khẩu đọc từ biến môi trường ADMIN_PASSWORD (không truyền qua tham số để khỏi lưu trong lịch sử lệnh).
 */

const parseArgs = (argv) => {
    const out = {};
    for (let i = 0; i < argv.length; i += 1) {
        const key = argv[i];
        if (!['--username', '--email', '--name'].includes(key)) throw new Error(`Tham số không hợp lệ: ${key}`);
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) throw new Error(`${key} cần một giá trị`);
        out[key.slice(2)] = value;
        i += 1;
    }
    return out;
};

async function run(argv, { User, env = process.env, log = console.log }) {
    const a = parseArgs(argv);
    const password = env.ADMIN_PASSWORD || '';
    const username = String(a.username || '').trim();
    const email = String(a.email || '').trim();
    const fullName = String(a.name || 'Quản trị viên').trim();

    if (!/^\S{3,50}$/.test(username)) throw new Error('--username phải từ 3 đến 50 ký tự, không có khoảng trắng');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('--email không hợp lệ');
    if (password.length < 8) throw new Error('Đặt biến môi trường ADMIN_PASSWORD (tối thiểu 8 ký tự) trước khi chạy');
    if (password.length > 72) throw new Error('ADMIN_PASSWORD tối đa 72 ký tự');
    if (await User.getUserByUsername(username)) throw new Error(`Tên đăng nhập "${username}" đã tồn tại`);
    if (await User.getUserByEmail(email)) throw new Error(`Email "${email}" đã được sử dụng`);

    const id = await User.createUser({ username, password, email, full_name: fullName, role: 'admin' });
    log(`✅ Đã tạo tài khoản quản trị "${username}" (#${id}). Hãy đăng nhập trang admin và đổi mật khẩu nếu cần.`);
    return id;
}

module.exports = { run, parseArgs };

if (require.main === module) {
    const User = require('../src/models/User');
    const { closePool } = require('../src/config/database');
    run(process.argv.slice(2), { User })
        .then(() => closePool())
        .catch(async (error) => {
            console.error(`❌ ${error.message}`);
            try { await closePool(); } catch { /* bỏ qua */ }
            process.exit(1);
        });
}
