'use strict';

const crypto = require('crypto');

/**
 * Log mỗi request một dòng: mã request, phương thức, đường dẫn (KHÔNG kèm query để tránh lộ vé/token), mã trả về, thời gian.
 * Gắn header X-Request-Id để đối chiếu lỗi người dùng báo với log server. Tắt bằng LOG_REQUESTS=false.
 */
function requestLog(req, res, next) {
    const id = crypto.randomUUID().slice(0, 8);
    req.id = id;
    res.setHeader('X-Request-Id', id);
    if (process.env.LOG_REQUESTS === 'false') return next();
    const start = process.hrtime.bigint();
    res.on('finish', () => {
        const path = (req.originalUrl || req.url || '').split('?')[0];
        if (path === '/health' || path === '/health/ready') return; // health check của nơi deploy gọi liên tục
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        const line = `[${new Date().toISOString()}] ${id} ${req.method} ${path} ${res.statusCode} ${ms.toFixed(0)}ms`;
        if (res.statusCode >= 500) console.error(line);
        else console.log(line);
    });
    return next();
}

module.exports = requestLog;
