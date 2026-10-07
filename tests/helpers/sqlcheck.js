'use strict';

/**
 * Kiểm tra TĨNH mọi câu SQL trong mã nguồn so với schema: bảng có tồn tại không, cột có tồn tại không, giá trị enum
 * được so sánh có hợp lệ không. Không cần chạy code hay database.
 */

const fs = require('fs');
const path = require('path');

// ───────── Lấy chuỗi SQL ra khỏi mã JavaScript ─────────
function extractStrings(src) {
    const out = [];
    let i = 0;
    let lastSig = '';
    const n = src.length;
    const regexAllowedAfter = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
    while (i < n) {
        const c = src[i];
        if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i += 1; continue; }
        if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); i = i < 0 ? n : i + 2; continue; }
        if (c === "'" || c === '"') {
            let j = i + 1; let s = '';
            while (j < n && src[j] !== c) { if (src[j] === '\\') { s += src[j + 1]; j += 2; } else { s += src[j]; j += 1; } }
            out.push(s); i = j + 1; lastSig = c; continue;
        }
        if (c === '`') {
            let j = i + 1; let s = ''; let depth = 0;
            while (j < n && !(src[j] === '`' && depth === 0)) {
                if (src[j] === '\\') { s += src[j + 1]; j += 2; continue; }
                if (src[j] === '$' && src[j + 1] === '{') { depth += 1; if (depth === 1) s += '__X__'; j += 2; continue; }
                if (depth > 0) { if (src[j] === '{') depth += 1; else if (src[j] === '}') depth -= 1; j += 1; continue; }
                s += src[j]; j += 1;
            }
            out.push(s); i = j + 1; lastSig = '`'; continue;
        }
        if (c === '/' && regexAllowedAfter.has(lastSig)) { // regex literal
            let j = i + 1; let inClass = false;
            while (j < n && (src[j] !== '/' || inClass)) { if (src[j] === '\\') j += 1; else if (src[j] === '[') inClass = true; else if (src[j] === ']') inClass = false; j += 1; }
            i = j + 1; lastSig = ')'; continue;
        }
        if (!/\s/.test(c)) lastSig = c;
        i += 1;
    }
    return out;
}

const SQL_START = /^\s*(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\b/i;
const norm = (s) => s.replace(/\s+/g, ' ').trim();

function extractSql(file) {
    return extractStrings(fs.readFileSync(file, 'utf8'))
        .map(norm)
        .filter((s) => SQL_START.test(s) && s.length > 12 && /\b(FROM|INTO|UPDATE)\b/i.test(s))
        .map((sql) => ({ file, sql }));
}

function walk(dir, files = []) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) walk(p, files);
        else if (f.name.endsWith('.js')) files.push(p);
    }
    return files;
}

// ───────── Kiểm tra từng câu ─────────
const WORDS = new Set(`select from where and or not in is null like between exists as on join left right inner outer cross natural group by order asc desc limit offset
having distinct union all insert into values update set delete case when then else end interval day days month months year hour minute second week true false default
current_timestamp duplicate key escape using for regexp rlike binary unsigned signed cast char date datetime decimal with rollup over partition row rows count sum avg min max
coalesce ifnull if concat concat_ws lower upper trim date_format date_sub date_add now curdate convert_tz round floor ceil length char_length substring json_extract
json_unquote json_object json_arrayagg lpad replace nullif abs greatest least timestampdiff unix_timestamp from_unixtime last_insert_id row_count found_rows database
group_concat separator collate extract to_days datediff date_trunc dayofweek weekday ignore force use index lock share mode nowait skip locked straight_join
current_date utc_timestamp timestamp time varchar text json int integer bigint tinyint boolean exists any some div mod xor sql_calc_found_rows quarter yearweek
dayname monthname yearmonth literal nulls first last window using unix_timestamp field`.split(/\s+/));

function validateSql(sql, schema) {
    const problems = [];
    const raw = sql;
    let s = raw.replace(/'(?:[^'\\]|\\.|'')*'/g, "''").replace(/`/g, '').toLowerCase();
    s = s.replace(/\?/g, ' ').replace(/__x__/g, ' __x__ ');

    const KW_ALIAS = new Set(['where', 'set', 'left', 'right', 'inner', 'outer', 'join', 'on', 'group', 'order', 'limit', 'values', 'using', 'union', 'select', 'as', 'and', 'or',
        'cross', 'natural', 'straight_join', 'having', 'for', 'lock', 'offset', 'use', 'force', 'ignore', 'not', 'in', 'is', 'like', 'between', 'when', 'then', 'else', 'end', 'by']);
    const aliasToTable = {};
    const tables = new Set();
    const re = /\b(from|join|update|into)\s+([a-z_][a-z0-9_]*)(\.[a-z_][a-z0-9_]*)?(?:\s+(?:as\s+)?([a-z_][a-z0-9_]*))?/g;
    let m;
    while ((m = re.exec(s))) {
        if (m[3]) continue; // schema.table (information_schema...)
        const t = m[2];
        if (t === '__x__') continue;
        if (!schema.tables[t]) { problems.push(`bảng không tồn tại: ${t}`); continue; }
        tables.add(t);
        aliasToTable[t] = t;
        if (m[4] && !KW_ALIAS.has(m[4]) && m[4] !== '__x__') aliasToTable[m[4]] = t;
    }
    if (!tables.size) return problems;

    const free = new Set([...s.matchAll(/\bas\s+([a-z_][a-z0-9_]*)/g)].map((x) => x[1]));
    const colsOf = (t) => new Set(schema.tables[t].columns.map((c) => c.name));
    const allCols = new Set([...tables].flatMap((t) => [...colsOf(t)]));

    // cột có chỉ rõ bảng/alias: a.col
    s = s.replace(/\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*|\*)/g, (all, a, c) => {
        if (a === 'information_schema') return ' ';
        const t = aliasToTable[a];
        if (!t) return ' '; // bảng dẫn xuất / alias của truy vấn con
        if (c !== '*' && !colsOf(t).has(c)) problems.push(`cột không tồn tại: ${a}.${c} (bảng ${t})`);
        return ' ';
    });

    for (const tok of s.match(/\b[a-z_][a-z0-9_]*\b/g) || []) {
        if (WORDS.has(tok) || tok === '__x__' || free.has(tok) || aliasToTable[tok] || allCols.has(tok)) continue;
        if (/^(utf8|latin)/.test(tok)) continue;
        problems.push(`cột/từ không nhận ra: ${tok}`);
    }

    // INSERT phải điền đủ mọi cột NOT NULL không có DEFAULT (MySQL ở chế độ strict báo lỗi 1364 nếu thiếu)
    const ins = /^\s*insert\s+into\s+([a-z_][a-z0-9_]*)\s*\(([^)]*)\)/i.exec(raw.replace(/`/g, ''));
    if (ins && schema.tables[ins[1].toLowerCase()]) {
        const given = new Set(ins[2].split(',').map((x) => x.trim().toLowerCase()));
        for (const c of schema.tables[ins[1].toLowerCase()].columns) {
            if (/\bNOT NULL\b/i.test(c.def) && !/\bDEFAULT\b/i.test(c.def) && !/\bAUTO_INCREMENT\b/i.test(c.def) && !given.has(c.name)) problems.push(`INSERT ${ins[1]} thiếu cột bắt buộc: ${c.name}`);
        }
    }

    // giá trị enum được so sánh trong SQL
    const lit = raw.replace(/`/g, '');
    const enumOk = (col, value) => [...tables].some((t) => { const c = schema.tables[t].columns.find((x) => x.name === col); return c && c.enumValues && c.enumValues.includes(value); });
    const isEnumCol = (col) => [...tables].some((t) => { const c = schema.tables[t].columns.find((x) => x.name === col); return c && c.enumValues; });
    for (const e of lit.matchAll(/\b(?:[a-z_]+\.)?([a-z_]+)\s*(?:=|!=|<>)\s*'([^']*)'/gi)) if (isEnumCol(e[1].toLowerCase()) && !enumOk(e[1].toLowerCase(), e[2])) problems.push(`giá trị enum không hợp lệ: ${e[1]} = '${e[2]}'`);
    for (const e of lit.matchAll(/\b(?:[a-z_]+\.)?([a-z_]+)\s+IN\s*\(([^)]*)\)/gi)) {
        if (!isEnumCol(e[1].toLowerCase())) continue;
        for (const v of e[2].matchAll(/'([^']*)'/g)) if (!enumOk(e[1].toLowerCase(), v[1])) problems.push(`giá trị enum không hợp lệ: ${e[1]} IN (... '${v[1]}' ...)`);
    }
    return problems;
}

module.exports = { extractStrings, extractSql, walk, validateSql };
