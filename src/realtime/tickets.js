'use strict';

/**
 * "Vé" kết nối SSE. Trình duyệt không gửi được header Authorization cho EventSource, nên client xin vé qua
 * REST (có xác thực) rồi mở luồng với ?ticket=. Vé: hết hạn sau 60 giây, dùng được ĐÚNG MỘT LẦN,
 * và các kênh được quyết định ở server lúc cấp vé (client không tự chọn kênh).
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { getSecret } = require('../config/jwt');

const TTL_SECONDS = 60;
const used = new Map(); // jti -> thời điểm hết hạn (ms)

const secret = () => `${getSecret()}:sse`;

function sweep(now = Date.now()) {
    for (const [jti, exp] of used) if (exp <= now) used.delete(jti);
}
setInterval(sweep, 60 * 1000).unref();

/** @param {{type:'staff'|'user'|'visitor', id:string|number, channels:string[]}} claims */
function issueTicket({ type, id, channels }) {
    return jwt.sign({ t: type, sub: String(id), ch: channels, jti: crypto.randomUUID(), purpose: 'sse' }, secret(), {
        expiresIn: TTL_SECONDS,
        algorithm: 'HS256'
    });
}

/** Trả về { type, id, channels } hoặc null nếu vé sai / hết hạn / đã dùng. */
function consumeTicket(token) {
    try {
        const d = jwt.verify(token, secret(), { algorithms: ['HS256'] });
        if (d.purpose !== 'sse' || !d.jti || !Array.isArray(d.ch)) return null;
        sweep();
        if (used.has(d.jti)) return null;
        used.set(d.jti, d.exp * 1000);
        return { type: d.t, id: d.sub, channels: d.ch };
    } catch {
        return null;
    }
}

module.exports = { issueTicket, consumeTicket, TTL_SECONDS, _used: used };
