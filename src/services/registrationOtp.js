'use strict';

/**
 * Đăng ký tài khoản có xác nhận email bằng mã OTP 6 số.
 *
 *  1) start()  : kiểm tra trùng tên đăng nhập/email, băm mật khẩu, lưu tạm vào email_otps và gửi mã qua email.
 *                Tài khoản CHƯA được tạo => email giả/sai không bao giờ thành tài khoản.
 *  2) verify() : nhập đúng mã => trả về dữ liệu để tạo tài khoản, xóa yêu cầu.
 *  3) resend() : gửi mã mới (có thời gian chờ + giới hạn số lần mỗi giờ).
 *
 * An toàn: chỉ lưu HMAC-SHA256 của mã (khóa = JWT_SECRET); so sánh hằng thời gian; tối đa OTP_MAX_ATTEMPTS lần nhập sai
 * cho mỗi mã; mã hết hạn sau OTP_TTL_MINUTES phút; mật khẩu chỉ lưu dạng đã băm bcrypt.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const EmailOtp = require('../models/EmailOtp');
const UserModel = require('../models/User');
const { sendRegisterOtp } = require('./mailer');
const { getSecret } = require('../config/jwt');
const { ValidationError } = require('../utils/http');

const PURPOSE = 'register';
const num = (v, def) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : def);
const ttlMinutes = () => num(process.env.OTP_TTL_MINUTES, 10);
const resendCooldownSec = () => num(process.env.OTP_RESEND_SECONDS, 60);
const maxSendsPerHour = () => num(process.env.OTP_MAX_SENDS_PER_HOUR, 5);
const maxAttempts = () => num(process.env.OTP_MAX_ATTEMPTS, 5);
const HOUR_MS = 60 * 60 * 1000;
const PENDING_MAX_AGE_MS = 24 * HOUR_MS; // yêu cầu đăng ký bỏ dở quá 1 ngày thì xóa

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();
const generateCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const hashCode = (email, code) => crypto.createHmac('sha256', getSecret()).update(`${PURPOSE}:${email}:${code}`).digest('hex');
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

async function ensureAvailable(username, email) {
    if (await UserModel.getUserByUsername(username)) throw new ValidationError('Tên đăng nhập đã tồn tại');
    if (await UserModel.getUserByEmail(email)) throw new ValidationError('Email đã được sử dụng');
}

/**
 * Lưu mã mới và gửi email. Áp dụng thời gian chờ giữa 2 lần gửi và giới hạn số lần gửi mỗi giờ.
 * Gửi email thất bại thì khôi phục trạng thái cũ (xóa yêu cầu mới tạo) để người dùng thử lại được ngay.
 */
async function issueCode(existing, { email, payload, now }) {
    if (existing) {
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
        code_hash: hashCode(email, code),
        payload,
        send_count: sendCount,
        send_window_start: windowFresh ? new Date(existing.send_window_start) : now,
        last_sent_at: now,
        expires_at: new Date(now.getTime() + ttlMinutes() * 60 * 1000)
    };

    let createdId = null;
    if (existing) await EmailOtp.replaceCode(existing.id, record);
    else createdId = await EmailOtp.create({ email, purpose: PURPOSE, ...record });

    try {
        await sendRegisterOtp({ email, name: payload.full_name, code, ttlMinutes: ttlMinutes() });
    } catch (error) {
        if (createdId) await EmailOtp.remove(createdId).catch(() => {});
        else if (existing) await EmailOtp.replaceCode(existing.id, existing).catch(() => {});
        throw error;
    }
    return publicInfo(email, now, record.last_sent_at, record.expires_at);
}

/** Bước 1: nhận thông tin đăng ký (đã kiểm tra định dạng ở controller), gửi mã OTP. */
async function start({ username, password, email, full_name }, now = new Date()) {
    const mail = normalizeEmail(email);
    await ensureAvailable(username, mail);
    EmailOtp.purgeOlderThan(new Date(now.getTime() - PENDING_MAX_AGE_MS)).catch(() => {});

    const existing = await EmailOtp.find(mail, PURPOSE);
    const payload = { username, full_name, password_hash: await bcrypt.hash(password, 10) };
    return issueCode(existing, { email: mail, payload, now });
}

/** Gửi lại mã cho yêu cầu đăng ký đang chờ. */
async function resend(email, now = new Date()) {
    const mail = normalizeEmail(email);
    const existing = await EmailOtp.find(mail, PURPOSE);
    if (!existing || !existing.payload) {
        throw new ValidationError('Không tìm thấy yêu cầu đăng ký cho email này. Vui lòng đăng ký lại.', 404);
    }
    return issueCode(existing, { email: mail, payload: existing.payload, now });
}

/**
 * Bước 2: kiểm tra mã. Đúng => trả về dữ liệu tạo tài khoản { username, email, full_name, password_hash } và xóa yêu cầu.
 * Sai => tăng số lần nhập sai; quá giới hạn thì phải gửi mã mới.
 */
async function verify(email, code, now = new Date()) {
    const mail = normalizeEmail(email);
    const input = String(code || '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(input)) throw new ValidationError('Mã xác nhận gồm 6 chữ số.');

    const row = await EmailOtp.find(mail, PURPOSE);
    if (!row || !row.payload) throw new ValidationError('Không tìm thấy yêu cầu đăng ký cho email này. Vui lòng đăng ký lại.', 404);
    if (Number(row.attempts) >= maxAttempts()) {
        throw new ValidationError('Bạn đã nhập sai quá nhiều lần. Vui lòng bấm "Gửi lại mã" để nhận mã mới.', 429);
    }
    if (new Date(row.expires_at).getTime() <= now.getTime()) {
        throw new ValidationError('Mã xác nhận đã hết hạn. Vui lòng bấm "Gửi lại mã" để nhận mã mới.', 410);
    }
    if (!sameHash(row.code_hash, hashCode(mail, input))) {
        const left = maxAttempts() - Number(row.attempts) - 1; // tính trước khi ghi (không phụ thuộc dữ liệu đã đọc)
        await EmailOtp.incrementAttempts(row.id);
        throw new ValidationError(
            left > 0 ? `Mã xác nhận không đúng. Bạn còn ${left} lần thử.` : 'Mã xác nhận không đúng. Vui lòng bấm "Gửi lại mã" để nhận mã mới.',
            left > 0 ? 400 : 429
        );
    }

    await EmailOtp.remove(row.id);
    return { email: mail, username: row.payload.username, full_name: row.payload.full_name, password_hash: row.payload.password_hash };
}

module.exports = { start, resend, verify, maskEmail, normalizeEmail, _hashCode: hashCode };
