'use strict';
const fs = require('fs/promises');
const path = require('path');
const https = require('https');
const dns = require('dns').promises;
const { randomUUID } = require('crypto');
const { publicUrl } = require('./productImageSearch');
const uploads = require('../productUploads');
const results = new Map(), active = new Set(), quotas = new Map();
class BackgroundError extends Error {}
const fail = (s) => { throw new BackgroundError(s); };
const imageList = (product) => [...new Set([product.image_url, ...(product.image_urls || [])].filter(Boolean))];
function configured() { if (!process.env.PHOTOROOM_API_KEY) fail('Chưa cấu hình PHOTOROOM_API_KEY ở backend. Hãy thêm key Photoroom trong Environment trước khi tách nền.'); }
function safeIPv4(ip) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
    const [a, b] = parts;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && [0, 168].includes(b) || a === 100 && b >= 64 && b <= 127 || a === 198 && [18, 19, 51].includes(b) || a === 203 && b === 0);
}
async function download(url) {
    if (!publicUrl(url)) fail('Ảnh bên ngoài phải có URL HTTPS công khai hợp lệ.');
    let addresses, timer;
    try { addresses = await Promise.race([dns.resolve4(new URL(url).hostname), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DNS timeout')), 5000); })]); }
    catch { fail('Không phân giải được địa chỉ máy chủ ảnh.'); }
    finally { clearTimeout(timer); }
    if (!addresses.length || addresses.some((ip) => !safeIPv4(ip))) fail('Không được tải ảnh từ mạng nội bộ hoặc địa chỉ dành riêng.');
    // Pin the checked address to the actual TLS request: no DNS rebinding, proxy or redirect follow.
    return new Promise((resolve, reject) => {
        const req = https.get(url, { agent: false, lookup: (_host, opts, cb) => opts.all ? cb(null, [{ address: addresses[0], family: 4 }]) : cb(null, addresses[0], 4) }, (res) => {
            if (res.statusCode !== 200) { res.resume(); reject(new BackgroundError('Không tải được ảnh nguồn (URL chuyển hướng hoặc bị chặn). Hãy tải ảnh lên admin trước.')); return; }
            const type = String(res.headers['content-type'] || '').split(';')[0];
            const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[type];
            if (!ext) { res.destroy(); reject(new BackgroundError('Ảnh nguồn cần là PNG/JPEG/WebP.')); return; }
            let size = 0; const chunks = [];
            res.on('data', (chunk) => { size += chunk.length; if (size > uploads.IMAGE_LIMIT) { res.destroy(new BackgroundError('Ảnh nguồn vượt 10 MB.')); return; } chunks.push(chunk); });
            res.on('end', () => resolve({ data: Buffer.concat(chunks), ext })); res.on('error', reject);
        });
        const timer = setTimeout(() => req.destroy(new BackgroundError('Tải ảnh quá thời gian cho phép.')), 12000);
        req.on('close', () => clearTimeout(timer)); req.on('error', reject);
    });
}
async function inputImage(source) {
    let pathname = source;
    if (/^https?:/i.test(source)) {
        const url = new URL(source);
        const roots = [process.env.PUBLIC_API_URL, process.env.RENDER_EXTERNAL_URL, `http://localhost:${process.env.PORT || 3000}`].filter(Boolean);
        if (!roots.some((base) => new URL(base).origin === url.origin)) return download(source);
        pathname = url.pathname;
    }
    const match = /^\/api\/uploads\/files\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpe?g|webp))$/.exec(pathname);
    if (!match) fail('Ảnh nội bộ cần được tải lên bằng form sản phẩm; đường dẫn ảnh không được hỗ trợ.');
    const file = path.join(uploads.UPLOAD_DIR, match[1]);
    const stat = await fs.lstat(file).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) fail('Không tìm thấy file ảnh nguồn.');
    if (stat.size > uploads.IMAGE_LIMIT) fail('Ảnh nguồn vượt 10 MB.');
    return { data: await fs.readFile(file), ext: path.extname(file) };
}
function sweep() {
    const now = Date.now();
    for (const [id, item] of results) if (item.expires <= now) results.delete(id);
    for (const [id, item] of quotas) if (item.until <= now) quotas.delete(id);
}
async function processImage(product, source, userId) {
    configured(); sweep();
    if (!imageList(product).includes(source)) fail('Ảnh nguồn đã thay đổi hoặc không thuộc sản phẩm. Hãy kiểm tra lại sản phẩm.');
    const key = `${userId}:${product.id}`;
    if (active.has(key)) fail('Ảnh của sản phẩm này đang được tách nền. Hãy đợi kết quả.');
    const quota = quotas.get(userId) || { count: 0, until: Date.now() + 60000 };
    if (quota.count >= 3) fail('Mỗi tài khoản tách nền tối đa 3 ảnh/phút.');
    if (results.size >= 200) fail('Đang có quá nhiều ảnh chờ áp dụng. Hãy thử lại sau.');
    quota.count++; quotas.set(userId, quota); active.add(key);
    try {
        const { data, ext } = await inputImage(source);
        uploads.validateFile('image', `source${ext}`, data);
        const form = new FormData();
        form.append('image_file', new Blob([data], { type: uploads.MIME[ext] }), `source${ext}`);
        form.append('format', 'png');
        let response;
        try { response = await fetch('https://sdk.photoroom.com/v1/segment', { method: 'POST', headers: { 'x-api-key': process.env.PHOTOROOM_API_KEY }, body: form, signal: AbortSignal.timeout(35000), redirect: 'error' }); }
        catch { fail('Không nhận được kết quả Photoroom. Chưa cập nhật sản phẩm; kiểm tra hạn mức trước khi thử lại vì yêu cầu có thể đã được xử lý.'); }
        if (!response.ok) { await response.body?.cancel(); fail(({ 401: 'Key Photoroom không hợp lệ.', 402: 'Tài khoản Photoroom không đủ hạn mức.', 429: 'Photoroom đang giới hạn lượt gọi, hãy thử lại sau.' })[response.status] || 'Photoroom không xử lý được ảnh. Chưa thay đổi sản phẩm.'); }
        if (!/image\/png/i.test(response.headers.get('content-type') || '')) { await response.body?.cancel(); fail('Photoroom không trả ảnh PNG hợp lệ.'); }
        const chunks = []; let size = 0; const reader = response.body.getReader();
        try { while (true) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > uploads.IMAGE_LIMIT) fail('Ảnh kết quả vượt giới hạn lưu 10 MB.'); chunks.push(Buffer.from(item.value)); } }
        finally { await reader.cancel().catch(() => {}); }
        const stored = await uploads.saveFile('image', 'background-removed.png', Buffer.concat(chunks));
        const base = process.env.PUBLIC_API_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
        const url = new URL(stored.url, base).href;
        const id = randomUUID();
        const item = { result_id: id, product_id: product.id, image_url: url, original_url: source, cover_url: product.image_url || '', userId, expires: Date.now() + 30 * 60000 };
        results.set(id, item);
        return { result_id: id, product_id: product.id, image_url: url, original_url: source };
    } finally { active.delete(key); }
}
function getResult(id, product, userId) {
    sweep(); const item = results.get(id);
    if (!item || item.userId !== userId || item.product_id !== product.id) fail('Kết quả tách nền không tồn tại, hết hạn hoặc không thuộc tài khoản/sản phẩm.');
    if (item.cover_url !== (product.image_url || '') || !imageList(product).includes(item.original_url)) fail('Ảnh sản phẩm đã thay đổi. Hãy tách nền lại từ ảnh hiện tại.');
    return item;
}
module.exports = { configured, processImage, getResult, imageList, BackgroundError, safeIPv4 };
