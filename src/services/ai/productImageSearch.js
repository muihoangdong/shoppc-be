'use strict';

// Only public product names are sent. Never fetch arbitrary URLs supplied by the model.
const recent = new Map(), limits = new Map();
const TTL = 15 * 60000;
class ImageSearchError extends Error {}
const plain = (value) => String(value || '').replace(/<[^>]*>/g, '').replace(/[\r\n]+/g, ' ').slice(0, 250);
function publicUrl(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || url.port || url.href.length > 500) return null;
        if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(url.hostname) || /\.(local|localhost|internal|test|invalid)$/i.test(url.hostname)) return null;
        url.hash = ''; return url.href;
    } catch { return null; }
}
function clean() {
    const now = Date.now();
    for (const [key, value] of recent) if (value.expires <= now) recent.delete(key);
    for (const [key, value] of limits) if (value.until <= now) limits.delete(key);
}
async function json(url, headers) {
    let response;
    try { response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(10000) }); }
    catch { throw new ImageSearchError('Không kết nối được nguồn tìm ảnh. Vui lòng thử lại.'); }
    if (!response.ok) throw new ImageSearchError(response.status === 429 ? 'Nguồn tìm ảnh đang giới hạn lượt gọi. Hãy thử lại sau.' : 'Nguồn tìm ảnh từ chối yêu cầu. Kiểm tra cấu hình dịch vụ hoặc thử lại sau.');
    const reader = response.body.getReader(); let size = 0; const chunks = [];
    try {
        while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 1000000) throw new ImageSearchError('Kết quả tìm ảnh quá lớn. Hãy tìm bằng tên sản phẩm cụ thể hơn.'); chunks.push(Buffer.from(value)); }
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (result.error) throw new ImageSearchError('Nguồn tìm ảnh không xử lý được từ khóa. Hãy dùng tên/model sản phẩm.');
        return result;
    } catch (error) { if (error instanceof ImageSearchError) throw error; throw new ImageSearchError('Không đọc được kết quả từ nguồn tìm ảnh.'); }
    finally { await reader.cancel().catch(() => {}); }
}
async function search({ product, userId, query }) {
    clean();
    const limit = limits.get(userId) || { count: 0, until: Date.now() + 60000 };
    if (limit.count >= 6) throw new ImageSearchError('Mỗi tài khoản tìm ảnh tối đa 6 lần/phút. Hãy thử lại sau.');
    limit.count++; limits.set(userId, limit);
    const q = (query || product.name).trim();
    if (!q || q.length > 200) throw new ImageSearchError('Từ khóa tìm ảnh cần từ 1 đến 200 ký tự.');
    const key = process.env.BRAVE_SEARCH_API_KEY;
    let results, provider;
    if (key) {
        provider = 'Brave Image Search';
        const url = new URL('https://api.search.brave.com/res/v1/images/search');
        url.search = new URLSearchParams({ q, count: '8', safesearch: 'strict', spellcheck: 'false' }).toString();
        const data = await json(url, { 'X-Subscription-Token': key, Accept: 'application/json' });
        results = (data.results || []).map((r) => ({ title: plain(r.title), url: publicUrl(r.properties?.url), source_url: publicUrl(r.url), license: 'Xem quyền sử dụng tại trang nguồn' }));
    } else {
        provider = 'Wikimedia Commons';
        const url = new URL('https://commons.wikimedia.org/w/api.php');
        url.search = new URLSearchParams({ action: 'query', format: 'json', generator: 'search', gsrsearch: q, gsrnamespace: '6', gsrlimit: '8', prop: 'imageinfo', iiprop: 'url|mime|extmetadata' }).toString();
        const data = await json(url, { 'User-Agent': 'ShopPC-ProductImages/1.0 (product image lookup)', Accept: 'application/json' });
        results = Object.values(data.query?.pages || {}).map((page) => {
            const i = page.imageinfo?.[0] || {};
            return { title: plain(page.title), url: /image\/(jpeg|png|webp)/.test(i.mime || '') ? publicUrl(i.url) : null, source_url: publicUrl(i.descriptionurl), license: plain(i.extmetadata?.LicenseShortName?.value), author: plain(i.extmetadata?.Artist?.value) };
        });
    }
    const seen = new Set();
    results = results.filter((r) => r.url && r.source_url && !seen.has(r.url) && seen.add(r.url)).slice(0, 8);
    for (const r of results) {
        if (recent.size >= 2000) recent.delete(recent.keys().next().value);
        recent.set(`${userId}:${product.id}:${r.url}`, { ...r, expires: Date.now() + TTL });
    }
    return { product_id: product.id, product_name: product.name, query: q, provider, results, message: results.length ? 'Ảnh gợi ý, chưa xác minh đúng model. Hiển thị URL ảnh và trang nguồn cho người dùng kiểm tra trước khi đề xuất cập nhật.' : 'Không tìm thấy ảnh phù hợp tại nguồn này. Không bịa URL hoặc lấy ảnh khác model. Có thể thử từ khóa model ngắn gọn hơn; Brave mở rộng nguồn nếu được cấu hình.' };
}
function candidate(userId, productId, url) {
    clean();
    const result = recent.get(`${userId}:${productId}:${url}`);
    if (!result) throw new ImageSearchError('Ảnh chưa được tìm cho sản phẩm này, đã hết hạn hoặc backend vừa khởi động lại. Hãy tìm ảnh lại trước khi cập nhật.');
    return result;
}
module.exports = { search, candidate, publicUrl, ImageSearchError };
