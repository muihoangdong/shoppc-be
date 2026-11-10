'use strict';
const assert = require('node:assert/strict');
const service = require('../src/services/ai/productImageSearch');
const Product = require('../src/models/Product');
const Tools = require('../src/services/ai/tools');
const originalFetch = global.fetch;
const commons = { query: { pages: { 1: { title: 'File:RAM Kingston.jpg', imageinfo: [{ mime: 'image/jpeg', url: 'https://upload.wikimedia.org/ram.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:RAM.jpg', extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' }, Artist: { value: '<b>Author</b>' } } }] } } } };
async function main() {
    delete process.env.BRAVE_SEARCH_API_KEY;
    let updates = [];
    Product.getProductById = async (id) => Number(id) === 7 ? { id: 7, name: 'RAM Kingston 16GB', image_url: '/uploads/old.jpg', image_urls: ['/uploads/old.jpg', '/uploads/side.jpg'] } : null;
    Product.updateProduct = async (...args) => { updates.push(args); return 1; };
    global.fetch = async (url, options) => {
        assert.equal(new URL(url).hostname, 'commons.wikimedia.org');
        assert.equal(new URL(url).searchParams.get('gsrsearch'), 'RAM Kingston 16GB');
        assert.equal(options.redirect, 'error');
        return Response.json(commons);
    };
    const user = { id: 42, role: 'staff', username: 'tester' }, ctx = { user };
    const search = Tools.getTool('search_product_images'), apply = Tools.getTool('apply_searched_product_image');
    assert.equal(search.write, false); assert.equal(apply.write, true);
    assert(!Tools.canUse(search, 'customer')); assert(Tools.canUse(search, 'staff'));
    const found = await search.run({ product_id: 7 }, ctx);
    assert.equal(found.results.length, 1); assert.equal(found.results[0].author, 'Author');
    assert.equal(updates.length, 0, 'Tìm ảnh không sửa database');
    const p = apply.parse({ product_id: 7, image_url: found.results[0].url });
    assert((await apply.describe(p, ctx)).includes(found.results[0].source_url));
    assert.equal(updates.length, 0, 'Chuẩn bị xác nhận không sửa database');
    await assert.rejects(apply.describe(p, { user: { id: 43 } }), /chưa được tìm/);
    await assert.rejects(apply.describe({ ...p, product_id: 8 }, ctx), /không tồn tại|Không tìm thấy/);
    await assert.rejects(apply.run({ ...p, image_url: 'https://invented.example/wrong.jpg' }, ctx), /chưa được tìm/);
    await apply.run(p, ctx);
    assert.deepEqual(updates[0][1].image_urls, [found.results[0].url, '/uploads/old.jpg', '/uploads/side.jpg']);
    assert.equal(updates[0][2], user);
    for (const url of ['http://example.com/a.jpg', 'https://localhost/a.jpg', 'https://127.0.0.1/a.jpg', 'https://[::1]/a.jpg', 'https://user:pass@example.com/a.jpg', 'https://files.internal/a.jpg', 'javascript:alert(1)']) assert.equal(service.publicUrl(url), null);
    global.fetch = async () => Response.json({ query: { pages: {} } });
    assert.equal((await service.search({ product: { id: 7, name: 'RAM' }, userId: 50 })).results.length, 0);
    process.env.BRAVE_SEARCH_API_KEY = 'test-key';
    global.fetch = async (url, options) => {
        assert.equal(new URL(url).hostname, 'api.search.brave.com'); assert.equal(options.headers['X-Subscription-Token'], 'test-key');
        return Response.json({ results: [{ title: 'RAM', url: 'https://vendor.example/product', properties: { url: 'https://cdn.example/ram.jpg' } }] });
    };
    assert.equal((await service.search({ product: { id: 7, name: 'RAM' }, userId: 51 })).results[0].url, 'https://cdn.example/ram.jpg');
    global.fetch = async () => new Response('', { status: 429 });
    await assert.rejects(service.search({ product: { id: 7, name: 'RAM' }, userId: 52 }), /giới hạn/);
    global.fetch = async () => { throw new Error('network'); };
    await assert.rejects(service.search({ product: { id: 7, name: 'RAM' }, userId: 53 }), /Không kết nối/);
    const clock = Date.now; Date.now = () => clock() + 16 * 60000;
    try { await assert.rejects(apply.run(p, ctx), /hết hạn/); } finally { Date.now = clock; }
    console.log('✓ Tìm ảnh: hai nguồn, không ghi trước xác nhận, ràng buộc tài khoản/sản phẩm, giữ ảnh cũ, URL không an toàn, hết hạn và lỗi mạng');
}
main().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => { global.fetch = originalFetch; });
