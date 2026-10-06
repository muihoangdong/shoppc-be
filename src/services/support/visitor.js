'use strict';

/**
 * Danh tính khách ẩn danh của chat hỗ trợ. Token được KÝ bằng secret của server nên không thể giả mạo hay đoán
 * để đọc hội thoại của người khác. Khác secret với token đăng nhập và vé SSE nên không dùng lẫn được.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { getSecret } = require('../../config/jwt');

const secret = () => `${getSecret()}:visitor`;

const issue = (visitorId) => jwt.sign({ v: visitorId, purpose: 'visitor' }, secret(), { expiresIn: '365d', algorithm: 'HS256' });

/** Trả về visitorId hợp lệ hoặc null. */
const verify = (token) => {
    try {
        const d = jwt.verify(token, secret(), { algorithms: ['HS256'] });
        return d.purpose === 'visitor' && typeof d.v === 'string' && d.v.length >= 8 ? d.v : null;
    } catch {
        return null;
    }
};

const create = () => {
    const id = crypto.randomUUID();
    return { id, token: issue(id) };
};

module.exports = { issue, verify, create };
