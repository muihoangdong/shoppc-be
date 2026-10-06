// Kiểm thử model Category thật với database giả: danh sách danh mục có kèm số sản phẩm.
// Chạy:  node tests/catalog.test.js
const Module = require('module');
const path = require('path');
const assert = require('assert');

const BE = path.join(__dirname, '..', 'src');
const calls = [];
const db = {
    query: async (sql, params) => {
        calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        return [{ id: 1, name: 'Laptop', type: 'pc', parent_id: null, parent_name: null, product_count: 4 }];
    },
    pool: {},
};
const origLoad = Module._load;
Module._load = function (request, parent) {
    if (parent && request.startsWith('.') && require.resolve(path.resolve(path.dirname(parent.filename), request)) === path.join(BE, 'config/database.js')) return db;
    return origLoad.apply(this, arguments);
};
const Category = require(path.join(BE, 'models/Category.js'));

let passed = 0;
const test = async (name, fn) => {
    try { await fn(); passed++; console.log('  ✓', name); }
    catch (e) { console.log('  ✗', name, '\n   ', e.stack.split('\n').slice(0, 4).join('\n    ')); process.exitCode = 1; }
};

(async () => {
    await test('getAllCategories kèm product_count (đếm sản phẩm của đúng danh mục đó) và vẫn giữ parent_name', async () => {
        const rows = await Category.getAllCategories();
        assert.strictEqual(rows[0].product_count, 4);
        const sql = calls[0].sql;
        assert(/\(SELECT COUNT\(\*\) FROM products pr WHERE pr\.category_id = c\.id\) AS product_count/.test(sql), sql);
        assert(/p\.name AS parent_name/.test(sql) && /ORDER BY c\.type, c\.name/.test(sql));
    });
    console.log(`\n${passed} test đạt`);
})();
