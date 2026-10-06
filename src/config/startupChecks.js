'use strict';

const db = require('./database');
const { getSecret } = require('./jwt');
const Schema = require('./schema');

/**
 * So cấu trúc database với db/schema.sql. Không khớp thì in hướng dẫn; ở production mà thiếu thứ quan trọng thì không khởi động
 * (tránh chạy với database sai rồi lỗi từng chút một). AUTO_MIGRATE=true: tự nâng cấp (an toàn, chỉ thêm/sửa, không xóa dữ liệu).
 * SKIP_SCHEMA_CHECK=true: bỏ qua bước này.
 */
async function checkSchema({ log = console } = {}) {
    if (process.env.SKIP_SCHEMA_CHECK === 'true') return { ok: true, skipped: true };
    let plan;
    try {
        plan = Schema.diff(await Schema.readSnapshot(db), Schema.loadTarget());
    } catch (error) {
        log.warn('⚠️  Không kiểm tra được cấu trúc database:', error.message);
        return { ok: true, error };
    }
    let issues = Schema.classify(plan);
    if (!issues.length) {
        log.log('✅ Cấu trúc database khớp với code.');
        return { ok: true, issues };
    }

    if (process.env.AUTO_MIGRATE === 'true') {
        log.log(`🔧 AUTO_MIGRATE: đang nâng cấp cấu trúc database (${plan.ops.length} bước)...`);
        await Schema.applyPlan({ query: (sql) => db.pool.query(sql).then(([rows]) => rows) }, plan.ops, { log: (l) => log.log(l) });
        plan = Schema.diff(await Schema.readSnapshot(db), Schema.loadTarget());
        issues = Schema.classify(plan);
        if (!issues.length) {
            log.log('✅ Đã nâng cấp xong, cấu trúc database khớp với code.');
            return { ok: true, migrated: true, issues };
        }
    }

    const critical = issues.filter((i) => i.level === 'critical');
    const warnings = issues.filter((i) => i.level === 'warning');
    const infos = issues.filter((i) => i.level === 'info');
    if (critical.length || warnings.length) {
        log.warn('\n⚠️  Cấu trúc database CHƯA khớp với code:');
        for (const i of critical) log.warn(`   ❌ ${i.message}`);
        for (const i of warnings) log.warn(`   ⚠️  ${i.message}`);
        log.warn('   Cách sửa (an toàn, không xóa dữ liệu — nên sao lưu trước):  npm run migrate-db -- --apply   (xem DATABASE.md)\n');
    } else {
        log.log(`ℹ️  Có ${infos.length} chỉ mục khuyến nghị chưa tạo (chỉ làm truy vấn chậm hơn): npm run migrate-db -- --apply`);
    }
    if (critical.length && process.env.NODE_ENV === 'production') {
        throw new Error('Cấu trúc database chưa khớp với code (xem danh sách ở trên). Chạy "npm run migrate-db -- --apply" hoặc đặt AUTO_MIGRATE=true.');
    }
    return { ok: critical.length === 0, issues };
}

/**
 * Chạy khi server khởi động (sau khi đã kết nối DB):
 *  1) Kiểm tra JWT_SECRET (production mà thiếu -> ném lỗi, server không chạy).
 *  2) Cảnh báo nếu cột users.role chưa hỗ trợ 'customer' và nếu còn tài khoản 'staff' cần rà soát.
 * Các kiểm tra ở bước 2 chỉ cảnh báo, không chặn server.
 */
async function runStartupChecks() {
    getSecret();

    if (process.env.NODE_ENV === 'production' && !process.env.CORS_ORIGINS) {
        console.warn(
            '⚠️  CORS_ORIGINS chưa được đặt: API đang cho phép MỌI website gọi từ trình duyệt. ' +
            'Hãy đặt CORS_ORIGINS=https://shop-cua-ban.com,https://admin-cua-ban.com'
        );
    }

    await checkSchema();

    try {
        const cols = await db.query("SHOW COLUMNS FROM users LIKE 'role'");
        const type = cols[0] ? String(cols[0].Type) : '';
        if (/^enum/i.test(type) && !/'customer'/i.test(type)) {
            console.warn(
                '\n⚠️  Cột users.role chưa có giá trị \'customer\' => KHÁCH HÀNG SẼ KHÔNG ĐĂNG KÝ ĐƯỢC.\n' +
                '   Chạy:  npm run fix-roles -- --keep <username nhân viên thật> --apply   (xem ROLES.md)\n'
            );
        }

        const rows = await db.query("SELECT COUNT(*) AS n FROM users WHERE role = 'staff'");
        const staff = Number(rows[0] && rows[0].n);
        if (staff > 0) {
            console.log(
                `ℹ️  Có ${staff} tài khoản vai trò 'staff'. Nếu trong đó có khách hàng đã đăng ký từ storefront trước đây, ` +
                'hãy hạ họ xuống \'customer\': npm run fix-roles (xem ROLES.md).'
            );
        }
    } catch (error) {
        console.warn('⚠️  Không kiểm tra được cột users.role:', error.message);
    }
}

module.exports = { runStartupChecks, checkSchema };
