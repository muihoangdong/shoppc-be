#!/usr/bin/env node
'use strict';

/**
 * Nâng cấp cấu trúc database cho khớp với code (so với db/schema.sql).
 *
 *   npm run migrate-db                 xem trước: liệt kê các bước sẽ làm, KHÔNG thay đổi gì
 *   npm run migrate-db -- --apply      thực hiện
 *
 * An toàn: chỉ thêm bảng/cột/chỉ mục hoặc sửa enum kèm đổi dữ liệu; không xóa bảng, cột hay dòng nào.
 * Chạy lại nhiều lần không sao (mỗi lần so sánh lại với trạng thái hiện tại). NÊN sao lưu trước:
 *   mysqldump -u <user> -p <tên_database> > backup.sql
 */

const Schema = require('../src/config/schema');

async function run({ db, args = [], log = console.log, target = Schema.loadTarget(), dbName = '' }) {
    const apply = args.includes('--apply');
    log(`\n── Kiểm tra cấu trúc database${dbName ? ` "${dbName}"` : ''} ──────────────────`);

    const current = await Schema.readSnapshot(db);
    const plan = Schema.diff(current, target);
    for (const w of plan.warnings) log(`⚠️  ${w}`);

    if (!plan.ops.length) {
        log('✅ Cấu trúc database đã khớp với code. Không cần làm gì.\n');
        return { ok: true, applied: 0, ops: [] };
    }

    log(`Cần ${plan.ops.length} bước:`);
    plan.ops.forEach((op, i) => log(` ${String(i + 1).padStart(2)}. ${Schema.describeOp(op)}`));

    if (!apply) {
        log('\nĐây mới chỉ là xem trước, chưa thay đổi gì.');
        log('Nên sao lưu trước:  mysqldump -u <user> -p <tên_database> > backup.sql');
        log('Rồi thực hiện:      npm run migrate-db -- --apply\n');
        return { ok: true, applied: 0, ops: plan.ops, dryRun: true };
    }

    log('\nĐang thực hiện...');
    let applied = 0;
    try {
        applied = await Schema.applyPlan(db, plan.ops, { log });
    } catch (error) {
        log(`\n❌ Dừng ở một bước: ${error.message}`);
        log('   Các bước trước đó đã xong. Hãy sửa nguyên nhân rồi chạy lại lệnh này — nó sẽ tiếp tục từ chỗ dở.\n');
        return { ok: false, applied, error, ops: plan.ops };
    }

    const left = Schema.diff(await Schema.readSnapshot(db), target).ops;
    if (left.length) {
        log(`\n⚠️  Đã chạy ${applied} bước nhưng vẫn còn ${left.length} điểm chưa khớp:`);
        left.forEach((op) => log(`   - ${Schema.describeOp(op)}`));
        return { ok: false, applied, left };
    }
    log(`\n✅ Xong (${applied} bước). Cấu trúc database đã khớp với code. Hãy khởi động lại backend.\n`);
    return { ok: true, applied };
}

module.exports = { run };

if (require.main === module) {
    require('dotenv').config();
    const dbModule = require('../src/config/database');
    const conn = { query: (sql) => dbModule.pool.query(sql).then(([rows]) => rows) };
    run({ db: conn, args: process.argv.slice(2), dbName: process.env.DB_NAME })
        .then(async (r) => {
            await dbModule.closePool();
            process.exit(r.ok ? 0 : 1);
        })
        .catch(async (error) => {
            console.error(`\n❌ ${error.message}`);
            try { await dbModule.closePool(); } catch { /* bỏ qua */ }
            process.exit(1);
        });
}
