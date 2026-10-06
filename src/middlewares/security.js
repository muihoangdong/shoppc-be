'use strict';

const cors = require('cors');

/** Header bảo mật cơ bản cho API (không cần thư viện helmet). */
function securityHeaders(req, res, next) {
    res.set({
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'X-DNS-Prefetch-Control': 'off',
        'Cross-Origin-Opener-Policy': 'same-origin'
    });
    if (process.env.NODE_ENV === 'production') {
        res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }
    // Dữ liệu cá nhân / quản trị không được lưu cache (trình duyệt, proxy)
    if (/^\/api\/(auth|users|orders|chat|support|realtime|ai)(\/|$)/.test(req.path)) {
        res.set('Cache-Control', 'no-store');
    }
    next();
}

/**
 * CORS: đặt CORS_ORIGINS="https://shop.example.com,https://admin.example.com" để chỉ cho phép các domain đó.
 * Không đặt => cho phép mọi domain (giữ hành vi cũ; startupChecks cảnh báo ở production).
 * Request không có header Origin (curl, server-to-server) luôn được qua vì CORS chỉ là cơ chế của trình duyệt.
 */
function corsMiddleware() {
    const list = (process.env.CORS_ORIGINS || '')
        .split(',')
        .map((s) => s.trim().replace(/\/$/, ''))
        .filter(Boolean);
    if (!list.length) return cors();
    return cors({
        origin(origin, callback) {
            if (!origin || list.includes(origin.replace(/\/$/, ''))) return callback(null, true);
            return callback(null, false); // trình duyệt sẽ chặn vì thiếu header Access-Control-Allow-Origin
        }
    });
}

/**
 * Ở production, lỗi 500 từ controller (có thể chứa thông báo SQL/stack) được thay bằng thông báo chung;
 * chi tiết chỉ ghi vào log của server.
 */
function hideServerErrors(req, res, next) {
    const original = res.json.bind(res);
    res.json = (body) => {
        if (res.statusCode === 500 && body && typeof body === 'object' && process.env.NODE_ENV === 'production') {
            console.error(`[500] ${req.method} ${req.originalUrl} - ${body.message}`);
            body = { ...body, message: 'Đã xảy ra lỗi hệ thống, vui lòng thử lại sau', error: undefined };
        }
        return original(body);
    };
    next();
}

module.exports = { securityHeaders, corsMiddleware, hideServerErrors };
