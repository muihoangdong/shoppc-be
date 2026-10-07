'use strict';

/**
 * Khách đổi email tài khoản: phải nhập mật khẩu hiện tại, rồi xác nhận bằng mã OTP gửi tới EMAIL MỚI.
 * Nhờ vậy email trong tài khoản luôn là email thật của chủ tài khoản (giống lúc đăng ký), và người mượn máy
 * đang đăng nhập sẵn cũng không đổi được email để chiếm tài khoản (qua "Quên mật khẩu").
 */

const EmailOtp = require('../models/EmailOtp');
const UserModel = require('../models/User');
const { sendEmailChangeOtp } = require('./mailer');
const { ValidationError } = require('../utils/http');
const Otp = require('./otpCore');

const PURPOSE = 'change_email';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NOT_FOUND = 'Không tìm thấy yêu cầu đổi email nào đang chờ. Vui lòng thực hiện lại.';

const issue = (existing, email, payload, name, now) =>
    Otp.issueCode({
        purpose: PURPOSE, email, payload, existing, now,
        send: (code, ttlMinutes) => sendEmailChangeOtp({ email, name, code, ttlMinutes })
    });

/** Bước 1: kiểm tra mật khẩu + email mới, gửi mã tới email mới. */
async function start(userId, { new_email, current_password }, now = new Date()) {
    if (typeof new_email !== 'string' || typeof current_password !== 'string' || !new_email.trim() || !current_password) {
        throw new ValidationError('Vui lòng nhập email mới và mật khẩu hiện tại');
    }
    const mail = Otp.normalizeEmail(new_email);
    if (!EMAIL_RE.test(mail) || mail.length > 150) throw new ValidationError('Email không hợp lệ');

    const user = await UserModel.getUserAuthById(userId);
    if (!user || user.status !== 'active') throw new ValidationError('Tài khoản không hợp lệ', 401);
    if (!(await UserModel.verifyPassword(user, current_password))) throw new ValidationError('Mật khẩu hiện tại không đúng');
    if (Otp.normalizeEmail(user.email) === mail) throw new ValidationError('Email mới trùng với email hiện tại');
    const taken = await UserModel.getUserByEmail(mail);
    if (taken && taken.id !== user.id) throw new ValidationError('Email đã được sử dụng');

    Otp.purgeOld(now);
    const existing = await EmailOtp.find(mail, PURPOSE);
    // Người khác cũng đang chờ đổi sang email này: yêu cầu mới thay thế (mã cũ hết tác dụng), không để lộ là có người khác
    return issue(existing, mail, { user_id: user.id }, user.full_name, now);
}

/** Gửi lại mã tới email mới (chỉ chủ của yêu cầu mới gửi lại được). */
async function resend(userId, newEmail, now = new Date()) {
    const mail = Otp.normalizeEmail(newEmail);
    const existing = await EmailOtp.find(mail, PURPOSE);
    if (!existing || !existing.payload || existing.payload.user_id !== userId) throw new ValidationError(NOT_FOUND, 404);
    const user = await UserModel.getUserById(userId);
    return issue(existing, mail, existing.payload, user && user.full_name, now);
}

/** Bước 2: đúng mã => đổi email. Trả về email mới. */
async function verify(userId, newEmail, code, now = new Date()) {
    const mail = Otp.normalizeEmail(newEmail);
    const pending = await EmailOtp.find(mail, PURPOSE);
    // Yêu cầu của người khác: trả lời như không có (không tiêu hao lượt thử của họ)
    if (!pending || !pending.payload || pending.payload.user_id !== userId) throw new ValidationError(NOT_FOUND, 404);

    await Otp.consumeCode({ purpose: PURPOSE, email: mail, code, now, notFound: NOT_FOUND });

    const taken = await UserModel.getUserByEmail(mail);
    if (taken && taken.id !== userId) throw new ValidationError('Email vừa được tài khoản khác sử dụng', 409);
    await UserModel.updateUser(userId, { email: mail });
    return mail;
}

module.exports = { start, resend, verify, PURPOSE };
