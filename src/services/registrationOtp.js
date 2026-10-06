'use strict';

/**
 * Đăng ký tài khoản có xác nhận email bằng mã OTP 6 số.
 *
 *  1) start()  : kiểm tra trùng tên đăng nhập/email, băm mật khẩu, lưu tạm vào email_otps và gửi mã qua email.
 *                Tài khoản CHƯA được tạo => email giả/sai không bao giờ thành tài khoản.
 *  2) verify() : nhập đúng mã => trả về dữ liệu để tạo tài khoản, xóa yêu cầu.
 *  3) resend() : gửi mã mới (có thời gian chờ + giới hạn số lần mỗi giờ).
 * Quy tắc an toàn chung (băm mã, hết hạn, số lần sai...) nằm ở otpCore.js. Mật khẩu chỉ lưu dạng đã băm bcrypt.
 */

const bcrypt = require('bcryptjs');
const EmailOtp = require('../models/EmailOtp');
const UserModel = require('../models/User');
const { sendRegisterOtp } = require('./mailer');
const { ValidationError } = require('../utils/http');
const Otp = require('./otpCore');

const PURPOSE = 'register';
const NOT_FOUND = 'Không tìm thấy yêu cầu đăng ký cho email này. Vui lòng đăng ký lại.';

async function ensureAvailable(username, email) {
    if (await UserModel.getUserByUsername(username)) throw new ValidationError('Tên đăng nhập đã tồn tại');
    if (await UserModel.getUserByEmail(email)) throw new ValidationError('Email đã được sử dụng');
}

const issue = (existing, email, payload, now) =>
    Otp.issueCode({
        purpose: PURPOSE, email, payload, existing, now,
        send: (code, ttlMinutes) => sendRegisterOtp({ email, name: payload.full_name, code, ttlMinutes })
    });

/** Bước 1: nhận thông tin đăng ký (đã kiểm tra định dạng ở controller), gửi mã OTP. */
async function start({ username, password, email, full_name }, now = new Date()) {
    const mail = Otp.normalizeEmail(email);
    await ensureAvailable(username, mail);
    Otp.purgeOld(now);

    const existing = await EmailOtp.find(mail, PURPOSE);
    const payload = { username, full_name, password_hash: await bcrypt.hash(password, 10) };
    return issue(existing, mail, payload, now);
}

/** Gửi lại mã cho yêu cầu đăng ký đang chờ. */
async function resend(email, now = new Date()) {
    const mail = Otp.normalizeEmail(email);
    const existing = await EmailOtp.find(mail, PURPOSE);
    if (!existing || !existing.payload) throw new ValidationError(NOT_FOUND, 404);
    return issue(existing, mail, existing.payload, now);
}

/** Bước 2: đúng mã => trả về { username, email, full_name, password_hash } để tạo tài khoản. */
async function verify(email, code, now = new Date()) {
    const mail = Otp.normalizeEmail(email);
    const row = await Otp.consumeCode({ purpose: PURPOSE, email: mail, code, now, notFound: NOT_FOUND });
    return { email: mail, username: row.payload.username, full_name: row.payload.full_name, password_hash: row.payload.password_hash };
}

module.exports = {
    start, resend, verify,
    maskEmail: Otp.maskEmail, normalizeEmail: Otp.normalizeEmail,
    _hashCode: (email, code) => Otp.hashCode(PURPOSE, email, code)
};
