'use strict';
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const dns = require('dns').promises;
async function main() {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shoppc-background-test-'));
    process.env.UPLOAD_DIR = directory; process.env.PUBLIC_API_URL = 'https://api.example.com';
    const oldFetch = global.fetch, oldResolve = dns.resolve4;
    const name = '11111111-1111-4111-8111-111111111111.png';
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
    const source = `${process.env.PUBLIC_API_URL}/api/uploads/files/${name}`;
    await fs.writeFile(path.join(directory, name), png);
    const Product = require('../src/models/Product');
    const product = { id: 9, name: 'PC test', image_url: source, image_urls: [source, 'https://images.example.com/side.jpg'] };
    let updates = 0, requests = 0;
    Product.getProductById = async (id) => ({ ...product, id: Number(id) });
    Product.updateProduct = async (_id, data) => { updates++; assert.equal(data.image_urls[1], source); assert.equal(data.image_urls[2], product.image_urls[1]); };
    const bg = require('../src/services/ai/backgroundRemoval');
    const Tools = require('../src/services/ai/tools');
    const remove = Tools.getTool('remove_product_background'), apply = Tools.getTool('apply_background_removed_image');
    const ctx = { user: { id: 55, username: 'staff', role: 'staff' } };
    try {
        delete process.env.PHOTOROOM_API_KEY;
        await assert.rejects(remove.describe(remove.parse({ product_id: 9 })), /PHOTOROOM_API_KEY/);
        process.env.PHOTOROOM_API_KEY = 'fake-test-key';
        global.fetch = async (url, options) => {
            requests++; assert.equal(url, 'https://sdk.photoroom.com/v1/segment'); assert.equal(options.headers['x-api-key'], 'fake-test-key');
            assert.equal(options.body.get('format'), 'png'); assert.equal(options.body.get('image_file').size, png.length);
            return new Response(png, { headers: { 'Content-Type': 'image/png' } });
        };
        const p = remove.parse({ product_id: 9 });
        assert((await remove.describe(p)).includes('Photoroom'));
        assert.equal(requests, 0); assert.equal(updates, 0);
        const output = await remove.run(p, ctx);
        assert.equal(requests, 1); assert.equal(updates, 0, 'Xử lý chỉ lưu file xem trước, không sửa sản phẩm');
        assert(output.preview.image_url.startsWith('https://api.example.com/api/uploads/files/'));
        const stored = path.basename(new URL(output.preview.image_url).pathname);
        assert.deepEqual(await fs.readFile(path.join(directory, stored)), png);
        const change = apply.parse({ product_id: 9, result_id: output.preview.result_id });
        assert((await apply.describe(change, ctx)).includes('Không gọi AI'));
        await assert.rejects(apply.describe(change, { user: { id: 56 } }), /không thuộc/);
        await assert.rejects(apply.describe({ ...change, product_id: 10 }, ctx), /không thuộc/);
        await apply.run(change, ctx); assert.equal(updates, 1); assert.equal(requests, 1);
        product.image_url = 'https://images.example.com/new.jpg';
        await assert.rejects(apply.run(change, ctx), /đã thay đổi/); product.image_url = source;
        const clock = Date.now; Date.now = () => clock() + 31 * 60000;
        try { await assert.rejects(apply.run(change, ctx), /hết hạn/); } finally { Date.now = clock; }
        for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '172.16.0.1', '100.64.1.1', '224.0.0.1', '::1']) assert.equal(bg.safeIPv4(ip), false);
        assert(bg.safeIPv4('8.8.8.8'));
        dns.resolve4 = async () => ['127.0.0.1'];
        await assert.rejects(bg.processImage({ id: 10, image_url: 'https://image.example.com/pc.jpg' }, 'https://image.example.com/pc.jpg', 60), /nội bộ/);
        const failures = { 401: /không hợp lệ/, 402: /hạn mức/, 429: /giới hạn/ };
        for (const [status, pattern] of Object.entries(failures)) {
            global.fetch = async () => new Response('', { status: Number(status) });
            await assert.rejects(bg.processImage(product, source, Number(status)), pattern);
        }
        global.fetch = async () => new Response('not png', { headers: { 'Content-Type': 'image/png' } });
        await assert.rejects(bg.processImage(product, source, 70), /không khớp/);
        assert.equal(updates, 1);
        assert.equal(remove.write, true); assert.equal(apply.write, true); assert(!Tools.canUse(remove, 'customer'));
        console.log('✓ Tách nền: thiếu key, xác nhận trước API, PNG preview, cách ly tài khoản, giữ ảnh gốc, dữ liệu cũ, hết hạn, SSRF và lỗi nhà cung cấp');
    } finally {
        global.fetch = oldFetch; dns.resolve4 = oldResolve;
        for (const filename of await fs.readdir(directory)) await fs.unlink(path.join(directory, filename));
        await fs.rmdir(directory);
    }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
