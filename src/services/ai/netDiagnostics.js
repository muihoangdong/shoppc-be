'use strict';

/**
 * Chẩn đoán lỗi mạng khi gọi dịch vụ AI. `fetch` của Node chỉ báo chung chung "fetch failed"; nguyên nhân thật
 * (DNS, tường lửa, chứng chỉ, IPv6, proxy...) nằm trong `err.cause`. Ở đây dịch nguyên nhân đó ra lời khuyên tiếng Việt
 * để người quản trị biết sửa gì, thay vì chỉ thấy "không kết nối được".
 */

const CERT_CODES = new Set([
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'ERR_TLS_CERT_ALTNAME_INVALID'
]);

const hostOf = (url) => {
    try {
        return new URL(url).host;
    } catch {
        return String(url || 'dịch vụ AI');
    }
};

const isLocalHost = (url) => {
    try {
        const h = new URL(url).hostname;
        return ['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal'].includes(h);
    } catch {
        return false;
    }
};

/** Lấy mã lỗi gốc của lỗi fetch (undici bọc nguyên nhân thật trong err.cause, có khi lồng nhiều tầng / AggregateError). */
function rootCause(err) {
    let cur = err;
    for (let i = 0; i < 5 && cur && cur.cause; i += 1) cur = cur.cause;
    if (cur && Array.isArray(cur.errors) && cur.errors.length) cur = cur.errors[0]; // AggregateError (thử cả IPv4 lẫn IPv6)
    return cur || err || {};
}

/**
 * @returns {{code: string, reason: string, message: string}}
 *  message: câu hiển thị cho quản trị viên (đã gồm mã lỗi để tra cứu)
 */
function explainFetchError(err, { url, provider } = {}) {
    const host = hostOf(url);
    const cause = rootCause(err);
    const code = String(cause.code || cause.errno || (err && err.code) || '').toUpperCase();
    const text = `${(err && err.message) || ''} ${cause.message || ''}`;
    const proxyEnv = process.env.HTTPS_PROXY || process.env.https_proxy;
    let reason;

    if (/fetch is not defined|fetch is not a function/i.test(text)) {
        reason = `Phiên bản Node.js (${process.version}) quá cũ, chưa có sẵn fetch. Hãy cài Node.js 18 trở lên.`;
    } else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
        reason = `Không tìm được địa chỉ của ${host} (lỗi DNS). Kiểm tra kết nối Internet; thử đổi DNS máy sang 8.8.8.8 hoặc 1.1.1.1; nếu mạng chặn dịch vụ của Google thì bật VPN.`;
    } else if (['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_HEADERS_TIMEOUT'].includes(code)) {
        reason = `Kết nối tới ${host} quá thời gian hoặc không tới được. Thường do tường lửa/mạng chặn, hoặc mạng IPv6 bị lỗi. Hãy thử: bật VPN, hoặc dùng proxy (đặt AI_PROXY_URL và chạy "npm install undici").`;
    } else if (CERT_CODES.has(code)) {
        reason = `Chứng chỉ bảo mật của ${host} không được tin cậy. Thường do phần mềm diệt virus hoặc proxy công ty chèn chứng chỉ riêng` +
            (code === 'CERT_HAS_EXPIRED' || code === 'CERT_NOT_YET_VALID' ? ' (hoặc đồng hồ máy đang sai giờ)' : '') +
            '. Hãy đặt biến NODE_EXTRA_CA_CERTS trỏ tới file chứng chỉ gốc của phần mềm đó. Không nên tắt kiểm tra chứng chỉ.';
    } else if (code === 'ECONNREFUSED') {
        reason = `${host} từ chối kết nối (không có dịch vụ nào đang lắng nghe, hoặc proxy/tường lửa từ chối).`;
    } else if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || code === 'EPIPE') {
        reason = `Kết nối tới ${host} bị ngắt giữa chừng (mạng không ổn định, hoặc phần mềm bảo mật/proxy cắt kết nối).`;
    } else {
        reason = `Lỗi mạng khi gọi ${host}${text.trim() ? `: ${text.trim().slice(0, 120)}` : ''}.`;
    }

    // Node KHÔNG tự dùng biến HTTPS_PROXY: đây là nguyên nhân rất hay gặp ở mạng công ty/trường học
    if (proxyEnv && !isLocalHost(url) && !process.env.AI_PROXY_URL && code !== '') {
        reason += ' Lưu ý: máy đang đặt HTTPS_PROXY nhưng Node không tự dùng nó — hãy cài undici (npm install undici) và đặt AI_PROXY_URL cùng giá trị.';
    }
    return {
        code: code || 'UNKNOWN',
        reason,
        message: `Không kết nối được tới dịch vụ AI${provider ? ` (${provider})` : ''}. ${reason} [mã lỗi: ${code || 'không rõ'}]`
    };
}

/** Có proxy cần dùng cho URL này không (AI_PROXY_URL luôn dùng; HTTPS_PROXY chỉ dùng cho địa chỉ không phải máy cục bộ). */
function proxyFor(url) {
    const explicit = process.env.AI_PROXY_URL;
    if (explicit) return { url: explicit, explicit: true };
    const implicit = process.env.HTTPS_PROXY || process.env.https_proxy;
    if (!implicit || isLocalHost(url)) return null;
    const noProxy = String(process.env.NO_PROXY || process.env.no_proxy || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (noProxy.some((n) => hostOf(url).endsWith(n.replace(/^\./, '')))) return null;
    return { url: implicit, explicit: false };
}

let cache = { key: '', agent: null, fetch: null };

/**
 * Trả về { fetch, dispatcher } nếu cần đi qua proxy. Dùng thư viện `undici` (cài thêm) vì `fetch` có sẵn của Node không đọc biến proxy.
 * Chưa cài undici: nếu đặt AI_PROXY_URL thì báo lỗi rõ ràng; nếu chỉ có HTTPS_PROXY thì bỏ qua (giữ hành vi cũ).
 */
function proxyTransport(url, makeError) {
    const proxy = proxyFor(url);
    if (!proxy) return null;
    if (cache.key === proxy.url && cache.agent) return { fetch: cache.fetch, dispatcher: cache.agent };
    let undici;
    try {
        undici = require('undici');
    } catch {
        if (proxy.explicit) throw makeError(503, 'Đã đặt AI_PROXY_URL nhưng chưa cài thư viện undici. Hãy chạy: npm install undici');
        return null;
    }
    cache = { key: proxy.url, agent: new undici.ProxyAgent(proxy.url), fetch: undici.fetch };
    return { fetch: cache.fetch, dispatcher: cache.agent };
}

module.exports = { explainFetchError, rootCause, proxyFor, proxyTransport, hostOf, isLocalHost, _resetProxyCache: () => { cache = { key: '', agent: null, fetch: null }; } };
