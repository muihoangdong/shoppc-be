// Kiểm thử cấu hình mô hình 3D / AR của sản phẩm (products.model_3d) — không cần database.
// Chạy:  node tests/product3d.test.js
const path = require('path');
const assert = require('assert');

const { parseModel3d, has3d } = require(path.join(__dirname, '..', 'src', 'config', 'product3d.js'));

const fail = (m) => {
    const e = new Error(m);
    e.expose = true;
    throw e;
};
const throws = (fn, re) => assert.throws(fn, (e) => re.test(e.message));

let passed = 0;
const test = async (name, fn) => {
    try { await fn(); passed++; console.log('  ✓', name); }
    catch (e) { console.log('  ✗', name, '\n   ', e.stack.split('\n').slice(0, 4).join('\n    ')); process.exitCode = 1; }
};

(async () => {
    console.log('Mô hình 3D (products.model_3d)');
    await test('không gửi = không đổi; null / "" / không có GLB = không có mô hình', () => {
        assert.strictEqual(parseModel3d(undefined, fail), undefined);
        assert.strictEqual(parseModel3d(null, fail), null);
        assert.strictEqual(parseModel3d('', fail), null);
        assert.strictEqual(parseModel3d({}, fail), null);
        assert.strictEqual(parseModel3d({ glb_url: '' }, fail), null);
    });
    await test('nhận link GLB/USDZ/ảnh chờ hợp lệ (tuyệt đối hoặc /models/...), bỏ trường trống', () => {
        assert.deepStrictEqual(
            parseModel3d({ glb_url: ' https://cdn.x/a.glb?v=2 ', usdz_url: '', poster_url: '/models/a.webp', enabled: true }, fail),
            { glb_url: 'https://cdn.x/a.glb?v=2', poster_url: '/models/a.webp', enabled: true }
        );
        assert.deepStrictEqual(parseModel3d({ glb_url: '/models/cpu.gltf', usdz_url: '/models/cpu.usdz' }, fail), { glb_url: '/models/cpu.gltf', usdz_url: '/models/cpu.usdz' });
    });
    await test('từ chối dữ liệu sai: sai đuôi, sai giao thức, link "//", thiếu GLB, enabled không phải boolean', () => {
        throws(() => parseModel3d([], fail), /object/);
        throws(() => parseModel3d({ glb_url: 'https://cdn.x/a.png' }, fail), /\.glb/);
        throws(() => parseModel3d({ glb_url: 'javascript:alert(1)//a.glb' }, fail), /http/);
        throws(() => parseModel3d({ glb_url: '//evil.x/a.glb' }, fail), /http/);
        throws(() => parseModel3d({ glb_url: 'https://cdn.x/a.glb', usdz_url: 'https://cdn.x/a.glb' }, fail), /\.usdz/);
        throws(() => parseModel3d({ usdz_url: 'https://cdn.x/a.usdz' }, fail), /GLB/);
        throws(() => parseModel3d({ glb_url: 'https://cdn.x/a.glb', enabled: 'yes' }, fail), /enabled/);
        throws(() => parseModel3d({ glb_url: `https://cdn.x/${'a'.repeat(600)}.glb` }, fail), /không hợp lệ/);
    });
    await test('has3d: chỉ bật khi có GLB và không bị tắt', () => {
        assert.strictEqual(has3d(null), false);
        assert.strictEqual(has3d({ glb_url: '/m.glb' }), true);
        assert.strictEqual(has3d({ glb_url: '/m.glb', enabled: false }), false);
    });

    console.log(`\n${passed} test đạt`);
})();
