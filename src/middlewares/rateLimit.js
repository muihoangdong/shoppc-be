'use strict';

/**
 * Giới hạn tần suất theo IP, lưu trong bộ nhớ (không cần thư viện ngoài).
 * Đủ cho 1 instance; nếu chạy nhiều instance hãy chuyển sang Redis (express-rate-limit + rate-limit-redis).
 *
 * Lưu ý: phía sau proxy/Render phải bật `trust proxy` (xem app.js) để req.ip là IP thật của người dùng.
 */

function rateLimit({ windowMs, max, message = 'Bạn thao tác quá nhanh, vui lòng thử lại sau.', keyGenerator } = {}) {
    const hits = new Map();

    setInterval(() => {
        const now = Date.now();
        for (const [key, list] of hits) {
            const fresh = list.filter((t) => now - t < windowMs);
            if (fresh.length) hits.set(key, fresh);
            else hits.delete(key);
        }
    }, Math.max(windowMs, 60 * 1000)).unref();

    return (req, res, next) => {
        const now = Date.now();
        const key = keyGenerator ? keyGenerator(req) : req.ip || 'unknown';
        const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);

        if (recent.length >= max) {
            hits.set(key, recent);
            res.set('Retry-After', String(Math.ceil((windowMs - (now - recent[0])) / 1000)));
            return res.status(429).json({ success: false, message });
        }

        recent.push(now);
        hits.set(key, recent);
        return next();
    };
}

module.exports = rateLimit;
