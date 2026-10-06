'use strict';

/**
 * Phần lõi dùng chung cho mọi mã OTP gửi qua email (đăng ký, đổi email...), lưu ở bảng email_otps.
 *
 * An toàn: chỉ lưu HMAC-SHA256 của mã (khóa = JWT_SECRET, gắn với mục đích + email nên mã của việc này không dùng được cho
 * việc khác); so sánh hằng thời gian; tối đa OTP_MAX_ATTEMPTS lần nhập sai mỗi mã; mã hết hạn sau OTP_TTL_MINUTES phút;
 * chờ OTP_RESEND_SECONDS giây giữa 2 lần gửi; tối đa OTP_MAX_SENDS_PER_HOUR lần gửi mỗi giờ cho mỗi email.
 */

const crypto = require('crypto');
const EmailOtp = require('../models/EmailOtp');
const { getSecret } = require('../config/jwt');
const { ValidationError } = require('../utils/http');

const num = (v, def) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : def);
const ttlMinutes = () => num(process.env.OTP_TTL_MINUTES, 10);
const resendCooldownSec = () => num(process.env.OTP_RESEND_SECONDS, 60);
const maxSendsPerHour = () => num(process.env.OTP_MAX_SENDS_PER_HOUR, 5);
const maxAttempts = () => num(process.env.OTP_MAX_ATTEMPTS, 5);
const HOUR_MS = 60 * 60 * 1000;
const PENDING_MAX_AGE_MS = 24 * HOUR_MS; // yêu cầu bỏ dở quá 1 ngày thì xóa

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();
const generateCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const hashCode = (purpose, email, code) => crypto.createHmac('sha256', getSecret()).update(`${purpose}:${email}:${code}`).digest('hex');
const sameHash = (a, b) => {
    const x = Buffer.from(String(a), 'hex');
    const y = Buffer.from(String(b), 'hex');
    return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};
const secondsBetween = (later, earlier) => Math.ceil((new Date(later).getTime() - new Date(earlier).getTime()) / 1000);

/** Che bớt email để hiển thị: muihoangdong@gmail.com -> mu**********@gmail.com */
function maskEmail(email) {
    const [name, domain] = String(email).split('@');
    if (!domain) return email;
    const keep = name.length <= 2 ? 1 : 2;
    return `${name.slice(0, keep)}${'*'.repeat(Math.max(1, name.length - keep))}@${domain}`;
}

const publicInfo = (email, now, lastSentAt, expiresAt) => ({
    otp_required: true,
    email,
    masked_email: maskEmail(email),
    expires_in: Math.max(0, secondsBetween(expiresAt, now)),
    resend_in: Math.max(0, resendCooldownSec() - secondsBetween(now, lastSentAt))
});

const purgeOld = (now) => EmailOtp.purgeOlderThan(new Date(now.getTime() - PENDING_MAX_AGE_MS)).catch(() => {});

/**
 * Tạo mã mới, lưu (thay mã cũ nếu có) rồi gửi bằng `send(code, ttlMinutes)`.
 * Áp dụng thời gian chờ giữa 2 lần gửi và giới hạn số lần gửi mỗi giờ.
 * Gửi thất bại thì khôi phục trạng thái cũ để người dùng thử lại được ngay.
 */
async function issueCode({ purpose, email, payload, existing: found, now, send }) {
    // Yêu cầu cũ có giờ gửi "ở tương lai" (database đem từ máy khác múi giờ, đổi giờ máy...): coi như yêu cầu đã cũ,
    // không bắt người dùng chờ hàng giờ. (Trước đây: "Vui lòng đợi 23337 giây...")
    const existing = found && secondsBetween(now, found.last_sent_at) < -60 ? { ...found, send_count: 0, send_window_start: new Date(0) } : found;
    if (existing && existing === found) {
        const waited = secondsBetween(now, existing.last_sent_at);
        if (waited < resendCooldownSec()) {
            throw new ValidationError(`Vui lòng đợi ${resendCooldownSec() - waited} giây trước khi gửi lại mã.`, 429);
        }
    }
    const windowFresh = existing && now - new Date(existing.send_window_start).getTime() < HOUR_MS;
    const sendCount = windowFresh ? Number(existing.send_count) + 1 : 1;
    if (windowFresh && sendCount > maxSendsPerHour()) {
        throw new ValidationError('Bạn đã yêu cầu gửi mã quá nhiều lần. Vui lòng thử lại sau 1 giờ.', 429);
    }

    const code = generateCode();
    const record = {
        code_hash: hashCode(purpose, email, code),
        payload,
        send_count: sendCount,
        send_window_start: windowFresh ? new Date(existing.send_window_start) : now,
        last_sent_at: now,
        expires_at: new Date(now.getTime() + ttlMinutes() * 60 * 1000)
    };

    let createdId = null;
    if (existing) await EmailOtp.replaceCode(existing.id, record);
    else createdId = await EmailOtp.create({ email, purpose, ...record });

    let sent;
    try {
        sent = await send(code, ttlMinutes());
    } catch (error) {
        if (createdId) await EmailOtp.remove(createdId).catch(() => {});
        else if (found) await EmailOtp.replaceCode(found.id, found).catch(() => {});
        throw error;
    }
    const info = publicInfo(email, now, record.last_sent_at, record.expires_at);
    // Chưa cấu hình gửi email (chỉ khi chạy thử, không phải production): kèm mã để trang web hiện ra
    return sent && sent.dev_code ? { ...info, dev_code: sent.dev_code } : info;
}

/**
 * Kiểm tra mã. Đúng => xóa yêu cầu và trả về dòng (kèm payload). Sai => tăng số lần nhập sai; quá giới hạn phải gửi mã mới.
 * `notFound` là thông báo khi không có yêu cầu nào đang chờ cho email này.
 */
async function consumeCode({ purpose, email, code, now, notFound }) {
    const input = String(code || '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(input)) throw new ValidationError('Mã xác nhận gồm 6 chữ số.');

    const row = await EmailOtp.find(email, purpose);
    if (!row || !row.payload) throw new ValidationError(notFound, 404);
    if (Number(row.attempts) >= maxAttempts()) {
        throw new ValidationError('Bạn đã nhập sai quá nhiều lần. Vui lòng bấm "Gửi lại mã" để nhận mã mới.', 429);
    }
    if (new Date(row.expires_at).getTime() <= now.getTime()) {
        throw new ValidationError('Mã xác nhận đã hết hạn. Vui lòng bấm "Gửi lại mã" để nhận mã mới.', 410);
    }
    if (!sameHash(row.code_hash, hashCode(purpose, email, input))) {
        const left = maxAttempts() - Number(row.attempts) - 1; // tính trước khi ghi (không phụ thuộc dữ liệu đã đọc)
        await EmailOtp.incrementAttempts(row.id);
        throw new ValidationError(
            left > 0 ? `Mã xác nhận không đúng. Bạn còn ${left} lần thử.` : 'Mã xác nhận không đúng. Vui lòng bấm "Gửi lại mã" để nhận mã mới.',
            left > 0 ? 400 : 429
        );
    }
    await EmailOtp.remove(row.id);
    return row;
}

module.exports = { issueCode, consumeCode, purgeOld, normalizeEmail, maskEmail, hashCode };
