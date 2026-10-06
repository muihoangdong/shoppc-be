'use strict';

/**
 * Cấu trúc database: đọc file chuẩn (db/schema.sql), đọc cấu trúc database đang chạy (information_schema),
 * so sánh, và sinh ra các lệnh nâng cấp AN TOÀN.
 *
 * Nguyên tắc an toàn: chỉ THÊM (bảng, cột, chỉ mục, khóa ngoại) hoặc MỞ RỘNG/ĐỔI TÊN giá trị của cột enum kèm chuyển dữ liệu.
 * Không bao giờ DROP bảng/cột và không xóa dòng nào. Giá trị enum cũ chỉ bị bỏ khi không còn dòng nào dùng.
 */

const fs = require('fs');
const path = require('path');

const SCHEMA_PATH = path.join(__dirname, '..', '..', 'db', 'schema.sql');

/**
 * Giá trị cũ -> giá trị mới của cột enum trạng thái đơn. Database cũ dùng "confirmed"/"shipping";
 * code (và giao diện) dùng "processing"/"shipped". Các cột `companions` lưu trạng thái dạng chữ nên đổi theo.
 */
const VALUE_MAPS = [
    {
        table: 'orders',
        column: 'status',
        map: { confirmed: 'processing', shipping: 'shipped' },
        companions: [
            { table: 'order_status_history', column: 'old_status' },
            { table: 'order_status_history', column: 'new_status' }
        ]
    }
];

// ───────────────────────── Đọc DDL (định dạng giống mysqldump) ─────────────────────────

const stripComments = (sql) => sql.replace(/\r/g, '').split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
const cols = (s) => [...s.matchAll(/`(\w+)`/g)].map((m) => m[1]);
const enumValues = (type) => {
    const m = /^enum\((.*)\)$/i.exec(type.trim());
    return m ? [...m[1].matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1].replace(/''/g, "'")) : null;
};
const quote = (v) => `'${String(v).replace(/'/g, "''")}'`;

/** Chuẩn hóa kiểu cột để so sánh (bỏ độ rộng hiển thị của int cũ: int(11) -> int, trừ tinyint(1)). */
const normType = (t) => {
    let s = String(t).toLowerCase().replace(/\s+/g, ' ').replace(/, /g, ',').trim();
    s = s.replace(/^(smallint|mediumint|int|bigint)\(\d+\)/, '$1');
    return s;
};

function parseDdl(sql) {
    const text = stripComments(String(sql));
    const tables = {};
    const order = [];
    const re = /CREATE TABLE(?: IF NOT EXISTS)? `(\w+)` \(\n([\s\S]*?)\n\)\s*ENGINE[^;]*;/g;
    let m;
    while ((m = re.exec(text))) {
        const t = { name: m[1], columns: [], indexes: [], foreignKeys: [], ddl: m[0].replace(/;$/, '') };
        for (const raw of m[2].split('\n')) {
            const line = raw.trim().replace(/,$/, '');
            if (!line) continue;
            let k;
            if ((k = /^PRIMARY KEY \((.+)\)$/.exec(line))) {
                t.indexes.push({ name: 'PRIMARY', unique: true, primary: true, columns: cols(k[1]), text: line });
            } else if ((k = /^(UNIQUE )?KEY `(\w+)` \((.+)\)$/.exec(line))) {
                t.indexes.push({ name: k[2], unique: !!k[1], primary: false, columns: cols(k[3]), text: line });
            } else if ((k = /^CONSTRAINT `(\w+)` FOREIGN KEY \(`(\w+)`\) REFERENCES `(\w+)` \(`(\w+)`\)(?: ON DELETE (RESTRICT|CASCADE|SET NULL|NO ACTION))?$/.exec(line))) {
                t.foreignKeys.push({ name: k[1], column: k[2], refTable: k[3], refColumn: k[4], onDelete: k[5] || 'RESTRICT', text: line });
            } else if ((k = /^`(\w+)` (.+)$/.exec(line))) {
                const type = /^([a-z]+(?:\([^)]*\))?(?: unsigned)?)/i.exec(k[2])[1];
                const full = /^enum\(((?:'(?:[^']|'')*',?)+)\)/i.exec(k[2]);
                t.columns.push({ name: k[1], type: full ? `enum(${full[1]})` : type, enumValues: enumValues(full ? `enum(${full[1]})` : type), def: line });
            } else {
                throw new Error(`Không đọc được dòng trong bảng ${m[1]}: ${line}`);
            }
        }
        tables[t.name] = t;
        order.push(t.name);
    }
    return { tables, order };
}

const loadTarget = (file = SCHEMA_PATH) => parseDdl(fs.readFileSync(file, 'utf8'));

// ───────────────────────── Đọc cấu trúc database đang chạy ─────────────────────────

const SQL_COLUMNS =
    'SELECT table_name AS table_name, column_name AS column_name, column_type AS column_type ' +
    'FROM information_schema.columns WHERE table_schema = DATABASE() ORDER BY table_name, ordinal_position';
const SQL_INDEXES =
    'SELECT table_name AS table_name, index_name AS index_name, non_unique AS non_unique, seq_in_index AS seq, column_name AS column_name ' +
    'FROM information_schema.statistics WHERE table_schema = DATABASE() ORDER BY table_name, index_name, seq_in_index';
const SQL_FKS =
    'SELECT k.table_name AS table_name, k.constraint_name AS constraint_name, k.column_name AS column_name, ' +
    'k.referenced_table_name AS ref_table, k.referenced_column_name AS ref_column, r.delete_rule AS delete_rule ' +
    'FROM information_schema.key_column_usage k ' +
    'JOIN information_schema.referential_constraints r ON r.constraint_schema = k.constraint_schema AND r.constraint_name = k.constraint_name ' +
    'WHERE k.table_schema = DATABASE() AND k.referenced_table_name IS NOT NULL';

/** Dựng "ảnh chụp" cấu trúc từ các dòng information_schema (tách riêng để kiểm thử được mà không cần MySQL). */
function snapshotFromRows(columnRows, indexRows, fkRows) {
    const tables = {};
    const T = (n) => (tables[n] ||= { name: n, columns: [], indexes: [], foreignKeys: [] });
    for (const r of columnRows) {
        const type = String(r.column_type);
        T(r.table_name).columns.push({ name: r.column_name, type, enumValues: enumValues(type) });
    }
    const idx = {};
    for (const r of indexRows) {
        const key = `${r.table_name}\u0000${r.index_name}`;
        (idx[key] ||= { table: r.table_name, name: r.index_name, unique: Number(r.non_unique) === 0, primary: r.index_name === 'PRIMARY', columns: [] }).columns.push(r.column_name);
    }
    for (const i of Object.values(idx)) T(i.table).indexes.push({ name: i.name, unique: i.unique, primary: i.primary, columns: i.columns });
    for (const r of fkRows) {
        T(r.table_name).foreignKeys.push({ name: r.constraint_name, column: r.column_name, refTable: r.ref_table, refColumn: r.ref_column, onDelete: r.delete_rule === 'NO ACTION' ? 'RESTRICT' : r.delete_rule });
    }
    return { tables, order: Object.keys(tables) };
}

async function readSnapshot(db) {
    const [columns, indexes, fks] = [await db.query(SQL_COLUMNS), await db.query(SQL_INDEXES), await db.query(SQL_FKS)];
    return snapshotFromRows(columns, indexes, fks);
}

// ───────────────────────── So sánh và lập kế hoạch ─────────────────────────

const q = (n) => `\`${n}\``;
const sameCols = (a, b) => a.length === b.length && a.every((c, i) => c === b[i]);
const replaceEnum = (def, values) => def.replace(/enum\(((?:'(?:[^']|'')*',?)+)\)/i, `enum(${values.map(quote).join(',')})`);

/**
 * @returns {{ops: object[], warnings: string[]}}
 *  ops: các bước theo thứ tự thực hiện. kind: create-table | add-column | enum-widen | map-values | guard | enum-set | add-index | add-fk
 */
function diff(current, target) {
    const ops = [];
    const warnings = [];
    const addOps = [];
    const enumOps = [];
    const indexOps = [];
    const fkOps = [];

    for (const name of target.order) {
        const want = target.tables[name];
        const have = current.tables[name];
        if (!have) {
            ops.push({ kind: 'create-table', table: name, sql: want.ddl.replace(/^CREATE TABLE(?: IF NOT EXISTS)?/, 'CREATE TABLE IF NOT EXISTS') });
            continue;
        }

        for (const col of want.columns) {
            const cur = have.columns.find((c) => c.name === col.name);
            if (!cur) {
                addOps.push({ kind: 'add-column', table: name, column: col.name, sql: `ALTER TABLE ${q(name)} ADD COLUMN ${col.def}` });
                continue;
            }
            if (col.enumValues && cur.enumValues) {
                const missing = col.enumValues.filter((v) => !cur.enumValues.includes(v));
                const extra = cur.enumValues.filter((v) => !col.enumValues.includes(v));
                if (!missing.length && !extra.length) continue;
                if (!extra.length) {
                    enumOps.push({ kind: 'enum-set', table: name, column: col.name, sql: `ALTER TABLE ${q(name)} MODIFY COLUMN ${col.def}`, note: `thêm giá trị: ${missing.join(', ')}` });
                    continue;
                }
                // Có giá trị cũ không còn trong chuẩn: mở rộng tạm -> đổi dữ liệu -> kiểm tra không còn dòng nào -> thu hẹp
                const union = [...col.enumValues, ...extra];
                const rule = VALUE_MAPS.find((r) => r.table === name && r.column === col.name);
                enumOps.push({ kind: 'enum-widen', table: name, column: col.name, sql: `ALTER TABLE ${q(name)} MODIFY COLUMN ${replaceEnum(col.def, union)}`, note: 'mở rộng tạm để đổi dữ liệu' });
                for (const v of extra) {
                    const to = rule && rule.map[v];
                    if (!to) continue;
                    const targets = [{ table: name, column: col.name }, ...(rule.companions || []).filter((c) => current.tables[c.table])];
                    for (const t of targets) {
                        // Giữ nguyên updated_at (nếu bảng có) để việc đổi tên trạng thái không làm đơn cũ trông như vừa được cập nhật
                        const keepTime = (current.tables[t.table].columns || []).some((c) => c.name === 'updated_at') ? `, ${q('updated_at')} = ${q('updated_at')}` : '';
                        enumOps.push({ kind: 'map-values', table: t.table, column: t.column, from: v, to, sql: `UPDATE ${q(t.table)} SET ${q(t.column)} = ${quote(to)}${keepTime} WHERE ${q(t.column)} = ${quote(v)}`, note: `đổi "${v}" thành "${to}"` });
                    }
                }
                enumOps.push({
                    kind: 'guard', table: name, column: col.name, values: extra,
                    sql: `SELECT COUNT(*) AS n FROM ${q(name)} WHERE ${q(col.name)} IN (${extra.map(quote).join(', ')})`,
                    message: `Cột ${name}.${col.name} còn dòng dùng giá trị cũ (${extra.join(', ')}) mà không có quy tắc đổi sang giá trị mới. Hãy tự chuyển các dòng đó sang một trạng thái hợp lệ (${col.enumValues.join(', ')}) rồi chạy lại.`
                });
                enumOps.push({ kind: 'enum-set', table: name, column: col.name, sql: `ALTER TABLE ${q(name)} MODIFY COLUMN ${col.def}`, note: `bỏ giá trị cũ: ${extra.join(', ')}` });
                continue;
            }
            if (normType(col.type) !== normType(cur.type)) {
                warnings.push(`${name}.${col.name}: kiểu hiện tại "${cur.type}" khác chuẩn "${col.type}" (không tự đổi để tránh mất dữ liệu).`);
            }
        }

        for (const ix of want.indexes) {
            if (ix.primary) continue;
            if (have.indexes.some((h) => h.unique === ix.unique && sameCols(h.columns, ix.columns))) continue;
            if (have.indexes.some((h) => h.name === ix.name)) {
                warnings.push(`${name}: chỉ mục "${ix.name}" đã tồn tại nhưng khác cấu trúc chuẩn (không tự đổi).`);
                continue;
            }
            indexOps.push({ kind: 'add-index', table: name, name: ix.name, sql: `ALTER TABLE ${q(name)} ADD ${ix.text}` });
        }

        for (const fk of want.foreignKeys) {
            if (have.foreignKeys.some((h) => h.column === fk.column && h.refTable === fk.refTable && h.refColumn === fk.refColumn)) continue;
            fkOps.push({ kind: 'add-fk', table: name, name: fk.name, sql: `ALTER TABLE ${q(name)} ADD ${fk.text}` });
        }
    }
    return { ops: [...ops, ...addOps, ...enumOps, ...indexOps, ...fkOps], warnings };
}

// ───────────────────────── Thực hiện và mô tả ─────────────────────────

const KIND_LABEL = {
    'create-table': 'Tạo bảng', 'add-column': 'Thêm cột', 'enum-widen': 'Mở rộng enum', 'map-values': 'Đổi dữ liệu',
    guard: 'Kiểm tra an toàn', 'enum-set': 'Sửa enum', 'add-index': 'Thêm chỉ mục', 'add-fk': 'Thêm khóa ngoại'
};

const describeOp = (op) => {
    const where = op.column ? `${op.table}.${op.column}` : op.table;
    if (op.kind === 'guard') return `${KIND_LABEL.guard}: không còn dòng nào ở ${where} dùng giá trị ${op.values.join(', ')}`;
    return `${KIND_LABEL[op.kind]}: ${op.kind === 'add-index' || op.kind === 'add-fk' ? `${op.table} (${op.name})` : where}${op.note ? ` — ${op.note}` : ''}`;
};

/**
 * Chạy các bước theo thứ tự; dừng ở lỗi đầu tiên. DDL của MySQL tự commit nên không rollback được —
 * nhưng mỗi bước đều kiểm tra lại trạng thái hiện tại nên chạy lại lệnh sẽ tiếp tục từ chỗ dừng.
 * @param {{query: (sql: string) => Promise<any>}} conn  query(sql) trả về mảng dòng (SELECT) hoặc kết quả
 */
async function applyPlan(conn, ops, { log = () => {} } = {}) {
    let done = 0;
    for (const op of ops) {
        if (op.kind === 'guard') {
            const rows = await conn.query(op.sql);
            const n = Number((rows[0] || {}).n || 0);
            if (n > 0) throw new Error(`${op.message} (${n} dòng)`);
            log(`   ✔ ${describeOp(op)}`);
        } else {
            await conn.query(op.sql);
            log(`   ✔ ${describeOp(op)}`);
        }
        done += 1;
    }
    return done;
}

/** Phân loại để kiểm tra khi khởi động: critical = code sẽ lỗi; warning = một tính năng không dùng được; info = chỉ chậm hơn. */
const SUPPORT_TABLES = ['support_conversations', 'support_messages'];
function classify(plan) {
    const issues = [];
    for (const op of plan.ops) {
        if (op.kind === 'guard' || op.kind === 'map-values' || op.kind === 'enum-widen') continue;
        let level = 'critical';
        let message = describeOp(op);
        if (op.kind === 'create-table' && SUPPORT_TABLES.includes(op.table)) {
            level = 'warning';
            message = `Thiếu bảng ${op.table}: chat hỗ trợ khách hàng sẽ báo lỗi.`;
        } else if (op.kind === 'add-index') {
            level = 'info';
            message = `Thiếu chỉ mục ${op.name} trên ${op.table} (chỉ làm truy vấn chậm hơn).`;
        } else if (op.kind === 'enum-set' && op.table === 'orders' && op.column === 'status') {
            message = 'Cột orders.status chưa đúng: không lưu được trạng thái "shipped" (Đang giao) / "completed" (Hoàn tất), bấm chuyển trạng thái sẽ báo lỗi.';
        }
        issues.push({ level, message, op });
    }
    for (const w of plan.warnings) issues.push({ level: 'info', message: w });
    return issues;
}

module.exports = {
    SCHEMA_PATH, VALUE_MAPS, SUPPORT_TABLES,
    parseDdl, loadTarget, snapshotFromRows, readSnapshot, diff, applyPlan, describeOp, classify, normType, enumValues,
    _sql: { SQL_COLUMNS, SQL_INDEXES, SQL_FKS }
};
