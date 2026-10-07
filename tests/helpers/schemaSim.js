'use strict';

/**
 * Mô phỏng MySQL ở mức đủ để chạy kế hoạch nâng cấp: giữ cấu trúc + một ít dữ liệu, trả lời các truy vấn information_schema,
 * và THỰC THI các lệnh ALTER/UPDATE/CREATE theo đúng quy tắc quan trọng của MySQL (ví dụ: đổi enum mà còn dòng dùng giá trị bị bỏ
 * => lỗi "Data truncated"; khóa ngoại trỏ tới bảng chưa có => lỗi; trùng tên chỉ mục => lỗi). Lệnh lạ => lỗi, nên cũng là
 * bước kiểm tra "mọi câu lệnh sinh ra đều thuộc các dạng đã biết".
 */

const Schema = require('../../src/config/schema');

const clone = (x) => JSON.parse(JSON.stringify(x));

function createSim(initialSchema, rows = {}) {
    const state = { tables: clone(initialSchema.tables), rows: clone(rows), log: [] };

    const infoColumns = () => Object.values(state.tables).flatMap((t) => t.columns.map((c) => ({ table_name: t.name, column_name: c.name, column_type: c.type })));
    const infoIndexes = () => Object.values(state.tables).flatMap((t) => t.indexes.flatMap((ix) => ix.columns.map((c, i) => ({ table_name: t.name, index_name: ix.name, non_unique: ix.unique ? 0 : 1, seq: i + 1, column_name: c }))));
    const infoFks = () => Object.values(state.tables).flatMap((t) => t.foreignKeys.map((f) => ({ table_name: t.name, constraint_name: f.name, column_name: f.column, ref_table: f.refTable, ref_column: f.refColumn, delete_rule: f.onDelete })));

    const sqlq = (s) => s.replace(/`/g, '');

    function exec(sql) {
        const s = sql.trim();
        if (s === Schema._sql.SQL_COLUMNS) return infoColumns();
        if (s === Schema._sql.SQL_INDEXES) return infoIndexes();
        if (s === Schema._sql.SQL_FKS) return infoFks();
        let m;
        if ((m = /^SELECT COUNT\(\*\) AS n FROM `(\w+)` WHERE `(\w+)` IN \((.*)\)$/.exec(s))) {
            const vals = [...m[3].matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1]);
            return [{ n: (state.rows[m[1]] || []).filter((r) => vals.includes(r[m[2]])).length }];
        }
        if ((m = /^UPDATE `(\w+)` SET `(\w+)` = '([^']*)'(, `updated_at` = `updated_at`)? WHERE `(\w+)` = '([^']*)'$/.exec(s))) {
            if (m[2] !== m[5]) throw new Error('mô phỏng: SET và WHERE khác cột');
            const t = state.tables[m[1]];
            if (!t) throw new Error(`Table '${m[1]}' doesn't exist`);
            const col = t.columns.find((c) => c.name === m[2]);
            if (col && col.enumValues && !col.enumValues.includes(m[3])) throw new Error(`Data truncated for column '${m[2]}'`);
            if (m[4] && !t.columns.some((c) => c.name === 'updated_at')) throw new Error("Unknown column 'updated_at'");
            let n = 0;
            for (const r of state.rows[m[1]] || []) if (r[m[2]] === m[6]) { r[m[2]] = m[3]; n += 1; }
            state.log.push({ sql: s, affected: n });
            return { affectedRows: n };
        }
        if ((m = /^ALTER TABLE `(\w+)` MODIFY COLUMN (.+)$/.exec(s))) {
            const t = state.tables[m[1]];
            const name = /^`(\w+)`/.exec(m[2])[1];
            const idx = t.columns.findIndex((c) => c.name === name);
            if (idx < 0) throw new Error(`Unknown column '${name}'`);
            const type = /^`\w+` (enum\((?:'(?:[^']|'')*',?)+\)|[a-z]+(?:\([^)]*\))?)/i.exec(m[2])[1];
            const vals = Schema.enumValues(type);
            if (vals) for (const r of state.rows[m[1]] || []) if (r[name] != null && !vals.includes(r[name])) throw new Error(`Data truncated for column '${name}' at row 1`);
            t.columns[idx] = { name, type, enumValues: vals };
            state.log.push({ sql: s });
            return {};
        }
        if ((m = /^ALTER TABLE `(\w+)` ADD COLUMN `(\w+)` (.+)$/.exec(s))) {
            const t = state.tables[m[1]];
            if (t.columns.some((c) => c.name === m[2])) throw new Error(`Duplicate column name '${m[2]}'`);
            const parsed = Schema.parseDdl(`CREATE TABLE \`x\` (\n  \`${m[2]}\` ${m[3]}\n) ENGINE=InnoDB;`).tables.x.columns[0];
            t.columns.push({ name: parsed.name, type: parsed.type, enumValues: parsed.enumValues });
            return {};
        }
        if ((m = /^ALTER TABLE `(\w+)` ADD ((?:UNIQUE )?KEY) `(\w+)` \((.+)\)$/.exec(s))) {
            const t = state.tables[m[1]];
            if (t.indexes.some((i) => i.name === m[3])) throw new Error(`Duplicate key name '${m[3]}'`);
            const cols = [...m[4].matchAll(/`(\w+)`/g)].map((x) => x[1]);
            for (const c of cols) if (!t.columns.some((x) => x.name === c)) throw new Error(`Key column '${c}' doesn't exist in table`);
            t.indexes.push({ name: m[3], unique: m[2].startsWith('UNIQUE'), primary: false, columns: cols });
            return {};
        }
        if ((m = /^ALTER TABLE `(\w+)` ADD CONSTRAINT `(\w+)` FOREIGN KEY \(`(\w+)`\) REFERENCES `(\w+)` \(`(\w+)`\)(?: ON DELETE (RESTRICT|CASCADE|SET NULL))?$/.exec(s))) {
            if (!state.tables[m[4]]) throw new Error('Cannot add foreign key constraint');
            state.tables[m[1]].foreignKeys.push({ name: m[2], column: m[3], refTable: m[4], refColumn: m[5], onDelete: m[6] || 'RESTRICT' });
            return {};
        }
        if (/^CREATE TABLE IF NOT EXISTS `(\w+)` \(/.test(s)) {
            const parsed = Schema.parseDdl(`${s};`);
            const name = parsed.order[0];
            if (state.tables[name]) return {};
            const t = parsed.tables[name];
            for (const f of t.foreignKeys) if (!state.tables[f.refTable] && f.refTable !== name) throw new Error('Cannot add foreign key constraint');
            state.tables[name] = { name, columns: t.columns.map((c) => ({ name: c.name, type: c.type, enumValues: c.enumValues })), indexes: t.indexes.map(({ name: n, unique, primary, columns }) => ({ name: n, unique, primary, columns })), foreignKeys: t.foreignKeys.map(({ name: n, column, refTable, refColumn, onDelete }) => ({ name: n, column, refTable, refColumn, onDelete })) };
            return {};
        }
        throw new Error(`mô phỏng chưa hỗ trợ câu lệnh: ${sqlq(s).slice(0, 90)}`);
    }

    const query = async (sql) => exec(sql);
    return { state, query, pool: { query: async (sql) => [exec(sql)] } };
}

/** Sinh dòng information_schema giống MySQL 8 từ một cấu trúc (để kiểm thử snapshotFromRows với dữ liệu thực tế). */
const rowsFor = (schema) => {
    const sim = createSim(schema);
    return { columns: sim.state && Object.values(sim.state.tables).flatMap((t) => t.columns.map((c) => ({ table_name: t.name, column_name: c.name, column_type: c.type }))) };
};

module.exports = { createSim, rowsFor };
