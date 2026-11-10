'use strict';

const assert = require('node:assert/strict');
const { parseProductImages } = require('../src/config/productImages');
const { fail } = require('../src/utils/validate');

async function main() {
    assert.equal(parseProductImages(undefined, fail), undefined);
    assert.deepEqual(parseProductImages(null, fail), []);
    assert.deepEqual(parseProductImages([' /a.png ', 'https://shop.test/b.png', '/a.png'], fail), ['/a.png', 'https://shop.test/b.png']);
    for (const bad of ['x', {}, [1], [''], ['//host/image'], ['javascript:alert(1)'], Array(21).fill('/a')]) {
        assert.throws(() => parseProductImages(bad, fail));
    }
    console.log('✓ Kiểm tra giới hạn, đường dẫn an toàn, bỏ trùng và giữ thứ tự');

    const writes = [];
    let row = { id: 1, image_url: '/old.png', image_urls: '["/a.png","/b.png"]', specs: '{}' };
    const dbPath = require.resolve('../src/config/database');
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
        query: async () => [row], pool: { query: async (sql, values) => { writes.push({ sql, values }); return [{ insertId: 1, affectedRows: 1 }]; } }
    } };
    const Product = require('../src/models/Product');
    assert.deepEqual(Product.normalizeProduct(row).image_urls, ['/a.png', '/b.png']);
    assert.deepEqual(Product.normalizeProduct({ image_url: '/old.png' }).image_urls, []);
    assert.deepEqual(Product.normalizeProduct({ image_urls: 'bad-json' }).image_urls, []);
    assert.deepEqual(Product.normalizeProduct({ image_urls: ['/a'] }).image_urls, ['/a']);
    await Product.createProduct({ name: 'PC', price: 100, category_id: 1, image_urls: ['/a', '/b'] });
    assert.match(writes[0].sql, /image_urls/);
    assert(writes[0].values.includes('["/a","/b"]'));
    await Product.updateProduct(1, { image_urls: ['/b', '/a'] });
    assert.deepEqual(writes[1].values, ['["/b","/a"]', 1]);
    await Product.updateProduct(1, { name: 'New name' });
    assert(!writes[2].sql.includes('image_urls'), 'Cập nhật trường khác không xóa thư viện');
    console.log('✓ Model đọc JSON/DB cũ, lưu thứ tự và giữ nguyên ảnh khi cập nhật trường khác');

    const catPath = require.resolve('../src/models/Category');
    const eventsPath = require.resolve('../src/realtime/events');
    require.cache[catPath] = { id: catPath, filename: catPath, loaded: true, exports: { getCategoryById: async () => ({ id: 1 }) } };
    require.cache[eventsPath] = { id: eventsPath, filename: eventsPath, loaded: true, exports: { productChanged: () => {} } };
    const Controller = require('../src/controllers/productController');
    const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
    await Controller.updateProduct({ params: { id: '1' }, body: { image_urls: ['/cover.png', '/detail.png'] } }, res);
    const update = writes.at(-1);
    assert.match(update.sql, /image_url = \?/);
    assert(update.values.includes('/cover.png'));
    assert(update.values.includes('["/cover.png","/detail.png"]'));
    await Controller.updateProduct({ params: { id: '1' }, body: { image_urls: [] } }, res);
    assert(writes.at(-1).values.includes(''));
    const count = writes.length;
    await Controller.updateProduct({ params: { id: '1' }, body: { image_urls: ['data:text/html,test'] } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(writes.length, count);
    row = { id: 1, image_url: '/cover.png', image_urls: [] };
    console.log('✓ Controller đồng bộ ảnh chính, xóa thư viện và từ chối dữ liệu không hợp lệ trước khi ghi DB');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
