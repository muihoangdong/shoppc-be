'use strict';

/**
 * Cấu hình JWT tập trung (trước đây mỗi file tự đọc JWT_SECRET và có giá trị dự phòng cố định
 * 'your-secret-key-change-this' — ai biết giá trị này đều có thể tự ký token admin).
 *
 *  - Production (NODE_ENV=production) mà thiếu JWT_SECRET  -> server không khởi động.
 *  - Môi trường khác mà thiếu JWT_SECRET                   -> dùng secret ngẫu nhiên cho mỗi lần chạy
 *    (an toàn nhưng token mất hiệu lực khi restart) và in cảnh báo.
 *  - Secret trùng giá trị mặc định cũ / quá ngắn            -> cảnh báo.
 */

require('dotenv').config();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const LEGACY_DEFAULT = 'your-secret-key-change-this';
const ALGORITHM = 'HS256';

let cachedSecret = null;

function getSecret() {
    if (cachedSecret) return cachedSecret;

    const fromEnv = process.env.JWT_SECRET;
    if (!fromEnv) {
        if (process.env.NODE_ENV === 'production') {
            throw new Error('Thiếu biến môi trường JWT_SECRET (bắt buộc ở môi trường production)');
        }
        console.warn('⚠️  JWT_SECRET chưa được đặt: dùng secret ngẫu nhiên tạm thời (token sẽ mất hiệu lực khi restart server).');
        cachedSecret = crypto.randomBytes(48).toString('hex');
    } else {
        if (fromEnv === LEGACY_DEFAULT || fromEnv.length < 32) {
            console.warn('⚠️  JWT_SECRET đang yếu hoặc là giá trị mặc định. Hãy đặt chuỗi ngẫu nhiên dài >= 32 ký tự.');
        }
        cachedSecret = fromEnv;
    }
    return cachedSecret;
}

const publicPayload = (user) => ({ id: user.id, username: user.username, role: user.role });

/** Token đăng nhập (7 ngày). */
function signAccessToken(user) {
    return jwt.sign(publicPayload(user), getSecret(), { expiresIn: '7d', algorithm: ALGORITHM });
}

function verifyAccessToken(token) {
    return jwt.verify(token, getSecret(), { algorithms: [ALGORITHM] });
}

/**
 * Token đặt lại mật khẩu.
 * Ký bằng (JWT_SECRET + hash mật khẩu hiện tại) nên:
 *  - KHÔNG thể dùng làm token đăng nhập (khác secret),
 *  - tự vô hiệu ngay sau khi mật khẩu đổi (dùng được đúng một lần), không cần lưu DB.
 */
function signResetToken(user) {
    return jwt.sign({ id: user.id, purpose: 'reset' }, getSecret() + user.password, {
        expiresIn: '30m',
        algorithm: ALGORITHM,
    });
}

function verifyResetToken(token, user) {
    const decoded = jwt.verify(token, getSecret() + user.password, { algorithms: [ALGORITHM] });
    if (decoded.purpose !== 'reset') throw new Error('Sai loại token');
    return decoded;
}

module.exports = { getSecret, signAccessToken, verifyAccessToken, signResetToken, verifyResetToken };
