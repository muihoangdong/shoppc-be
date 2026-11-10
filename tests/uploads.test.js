'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const createRouter = require('../src/routes/uploadRoutes');
const { validateFile, IMAGE_LIMIT } = require('../src/services/productUploads');
const { corsMiddleware, securityHeaders } = require('../src/middlewares/security');

async function main() {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shoppc-upload-test-'));
    const app = express();
    process.env.CORS_ORIGINS = 'https://shop.example';
    app.use(securityHeaders, corsMiddleware());
    // Stand-in identity middleware: verify router gates without touching the real DB.
    app.use('/api/uploads', createRouter({ directory,
        authenticate: (req, res, next) => req.headers.authorization ? next() : res.sendStatus(401),
        authorizeStaff: (req, res, next) => req.headers.authorization === 'staff' ? next() : res.sendStatus(403)
    }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
    const post = (kind, filename, data, auth = 'staff') => fetch(`${base}/api/uploads/${kind}?filename=${encodeURIComponent(filename)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...(auth ? { Authorization: auth } : {}) }, body: data
    });
    try {
        assert.equal((await post('image', 'x.png', png, '')).status, 401);
        assert.equal((await post('image', 'x.png', png, 'customer')).status, 403);
        assert.equal((await fs.readdir(directory)).length, 0);
        console.log('✓ Chặn upload chưa đăng nhập/không có quyền, không ghi file');

        assert.equal((await post('image', 'bad.png', Buffer.from('<script>alert(1)</script>'))).status, 400);
        assert.equal((await post('image', 'bad.svg', png)).status, 400);
        assert.throws(() => validateFile('image', 'big.png', Buffer.alloc(IMAGE_LIMIT + 1)), /10 MB/);
        const oversized = await post('image', 'big.png', Buffer.alloc(IMAGE_LIMIT + 1));
        assert.equal(oversized.status, 413);
        console.log('✓ Chặn sai đuôi, nội dung giả và file vượt dung lượng (HTTP 413)');

        const response = await post('image', '../../x.PNG', png);
        assert.equal(response.status, 201);
        const image = (await response.json()).data;
        assert.match(image.url, /^\/api\/uploads\/files\/[0-9a-f-]+\.png$/);
        const get = await fetch(base + image.url);
        assert.equal(get.status, 200);
        assert.equal(get.headers.get('content-type'), 'image/png');
        assert.equal(get.headers.get('x-content-type-options'), 'nosniff');
        assert.deepEqual(Buffer.from(await get.arrayBuffer()), png);
        assert.equal((await fetch(base + '/api/uploads/files/arbitrary.png')).status, 404);
        const range = await fetch(base + image.url, { headers: { Range: 'bytes=0-7' } });
        assert.equal(range.status, 206);
        console.log('✓ URL công khai đọc đúng nội dung, tên ngẫu nhiên, không thoát thư mục, hỗ trợ Range');

        const doc = { asset: { version: '2.0' }, buffers: [{ byteLength: 0, uri: 'data:application/octet-stream;base64,' }] };
        assert.equal((await post('model', 'embedded.gltf', Buffer.from(JSON.stringify(doc)))).status, 201);
        doc.buffers[0].uri = 'https://example.com/private.bin';
        assert.equal((await post('model', 'external.gltf', Buffer.from(JSON.stringify(doc)))).status, 400);
        assert.equal((await post('model', 'broken.glb', Buffer.from('glTF'))).status, 400);
        console.log('✓ Nhận GLTF tự chứa; chặn tham chiếu ngoài và GLB hỏng');

        // A real minimal GLB: empty scene, padded JSON chunk.
        let json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{}] }));
        json = Buffer.concat([json, Buffer.alloc((-json.length >>> 0) % 4, 32)]);
        const header = Buffer.alloc(20);
        header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + json.length, 8);
        header.writeUInt32LE(json.length, 12); header.write('JSON', 16);
        const glb = Buffer.concat([header, json]);
        const modelResponse = await post('model', 'pc.glb', glb);
        assert.equal(modelResponse.status, 201);
        const model = (await modelResponse.json()).data;
        const modelGet = await fetch(base + model.url);
        assert.equal(modelGet.headers.get('content-type'), 'model/gltf-binary');
        assert.deepEqual(Buffer.from(await modelGet.arrayBuffer()), glb);
        console.log('✓ Upload/tải GLB thật giữ nguyên bytes và MIME');

        const usdz = Buffer.from('UEsDBBQAAAAAAAAAIQDYT4/vNwAAADcAAAAKABgAbW9kZWwudXNkYYYZFAAAAAAAAAAAAAAAAAAAAAAAAAAAACN1c2RhIDEuMAooIGRlZmF1bHRQcmltID0gIlJvb3QiICkKZGVmIFhmb3JtICJSb290IiB7fQpQSwECFAAUAAAAAAAAACEA2E+P7zcAAAA3AAAACgAYAAAAAAAAAAAAgAEAAAAAbW9kZWwudXNkYYYZFAAAAAAAAAAAAAAAAAAAAAAAAAAAAFBLBQYAAAAAAQABAFAAAAB3AAAAAAA=', 'base64');
        const arResponse = await post('model', 'pc.usdz', usdz);
        assert.equal(arResponse.status, 201);
        const ar = (await arResponse.json()).data;
        const arGet = await fetch(base + ar.url, { headers: { Origin: 'https://shop.example' } });
        assert.equal(arGet.headers.get('content-type'), 'model/vnd.usdz+zip');
        assert.equal(arGet.headers.get('access-control-allow-origin'), 'https://shop.example');
        assert.deepEqual(Buffer.from(await arGet.arrayBuffer()), usdz);
        assert.equal((await post('model', 'broken.usdz', Buffer.from('PK'))).status, 400);
        console.log('✓ Nhận USDZ đúng cấu trúc, tải nguyên file, MIME AR và CORS đúng domain storefront');
    } finally {
        await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
        // Only delete the verified test-owned temp directory.
        await fs.rm(directory, { recursive: true, force: true });
    }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
