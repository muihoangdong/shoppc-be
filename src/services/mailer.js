'use strict';

/**
 * Gửi email: đặt lại mật khẩu, mã OTP xác nhận đăng ký.
 *
 * Để gửi mail thật:
 *   1) npm install nodemailer
 *   2) đặt SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS (và tùy chọn MAIL_FROM) trong .env
 *      Gmail: SMTP_HOST=smtp.gmail.com, SMTP_PORT=465, SMTP_USER=<địa chỉ gmail>, SMTP_PASS=<Mật khẩu ứng dụng 16 ký tự>
 *
 * Khi chưa cấu hình:
 *   - môi trường phát triển : in liên kết / mã OTP ra console của server (để thử nghiệm);
 *   - production            : đặt lại mật khẩu chỉ ghi cảnh báo (không lộ token); đăng ký báo lỗi "chưa cấu hình gửi email".
 */

const { ValidationError } = require('../utils/http');

let cachedTransport;
let warnedNoPass = false;

function loadTransport() {
    if (!process.env.SMTP_HOST) return null;
    // Có tài khoản mà chưa có mật khẩu (ví dụ chưa tạo Mật khẩu ứng dụng Gmail): coi như chưa cấu hình, không cố gửi rồi báo lỗi
    if (process.env.SMTP_USER && !process.env.SMTP_PASS) {
        if (!warnedNoPass) console.warn('[mailer] Có SMTP_USER nhưng SMTP_PASS đang trống: chưa gửi được email, mã OTP chỉ in ra đây. Kiểm tra: npm run mail-check');
        warnedNoPass = true;
        return null;
    }
    if (cachedTransport) return cachedTransport;
    try {
        const nodemailer = require('nodemailer'); // eslint-disable-line global-require
        cachedTransport = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: Number(process.env.SMTP_PORT) || 587,
            secure: Number(process.env.SMTP_PORT) === 465,
            // Gmail hiển thị mật khẩu ứng dụng dạng "abcd efgh ijkl mnop": bỏ dấu cách nếu lỡ dán nguyên
            auth: process.env.SMTP_USER
                ? { user: process.env.SMTP_USER, pass: /gmail/i.test(process.env.SMTP_HOST) ? process.env.SMTP_PASS.replace(/\s+/g, '') : process.env.SMTP_PASS }
                : undefined,
        });
        return cachedTransport;
    } catch {
        console.warn('[mailer] Đã đặt SMTP_HOST nhưng chưa cài nodemailer (chạy: npm install nodemailer).');
        return null;
    }
}

const isConfigured = () => !!loadTransport();
const fromAddress = () => process.env.MAIL_FROM || process.env.SMTP_USER;

async function sendPasswordReset(user, token) {
    const base = (process.env.FRONTEND_URL || 'http://localhost:3001').replace(/\/$/, '');
    const link = `${base}/reset-password?token=${encodeURIComponent(token)}`;

    const transport = loadTransport();
    if (transport) {
        await transport.sendMail({
            from: fromAddress(),
            to: user.email,
            subject: 'Đặt lại mật khẩu Shoppc',
            text: `Bạn (hoặc ai đó) đã yêu cầu đặt lại mật khẩu.\n\nMở liên kết sau trong 30 phút để đặt mật khẩu mới:\n${link}\n\nNếu không phải bạn, hãy bỏ qua email này.`,
        });
        return { delivered: true };
    }

    if (process.env.NODE_ENV === 'production') {
        console.warn(`[mailer] Chưa cấu hình SMTP: không gửi được email đặt lại mật khẩu cho user #${user.id}.`);
    } else {
        console.log(`[mailer] (DEV) Liên kết đặt lại mật khẩu cho ${user.email}:\n         ${link}`);
    }
    return { delivered: false };
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Gửi email chứa mã OTP. Ném ValidationError (hiển thị được cho người dùng) nếu không gửi được,
 * để không tạo yêu cầu "treo".
 *  - action      : việc cần xác nhận, ví dụ "đăng ký tài khoản" (dùng trong tiêu đề và nội dung)
 *  - ignoreLine  : câu cuối email cho người không yêu cầu
 *  - unconfigured: thông báo khi production chưa cấu hình SMTP
 */
async function sendOtpEmail({ email, name, code, ttlMinutes, action, ignoreLine, unconfigured }) {
    const transport = loadTransport();
    if (!transport) {
        if (process.env.NODE_ENV === 'production') {
            console.error(`[mailer] Chưa cấu hình SMTP: không gửi được mã OTP (${action}). Đặt SMTP_HOST/SMTP_USER/SMTP_PASS trong .env.`);
            throw new ValidationError(unconfigured, 503);
        }
        console.log(`[mailer] (DEV - chưa cấu hình SMTP) Mã OTP ${action} cho ${email}: ${code}  (hết hạn sau ${ttlMinutes} phút)`);
        // Chạy thử trên máy (chưa có email gửi đi): trả mã về để trang web hiện ngay, không phải mở cửa sổ backend.
        // Tắt bằng OTP_DEV_SHOW_CODE=false. Production (NODE_ENV=production) không bao giờ tới đây.
        return process.env.OTP_DEV_SHOW_CODE === 'false' ? { delivered: false } : { delivered: false, dev_code: code };
    }

    const hello = name ? `Chào ${name},` : 'Chào bạn,';
    const text = `${hello}\n\nMã xác nhận ${action} Shoppc của bạn là: ${code}\n\nMã có hiệu lực trong ${ttlMinutes} phút. ` +
        `Tuyệt đối không chia sẻ mã này cho bất kỳ ai, kể cả nhân viên Shoppc.\n\n${ignoreLine}`;
    const html = `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;padding:32px">
<tr><td style="font-size:22px;font-weight:800;letter-spacing:1px;color:#1e1b4b">SHOP<span style="color:#4f46e5">PC</span></td></tr>
<tr><td style="padding-top:20px;font-size:15px;line-height:1.6">${escapeHtml(hello)}<br>Mã xác nhận ${escapeHtml(action)} của bạn là:</td></tr>
<tr><td align="center" style="padding:20px 0"><div style="display:inline-block;background:#eef2ff;color:#3730a3;border-radius:12px;padding:14px 24px;font-size:32px;font-weight:700;letter-spacing:8px;font-family:'Courier New',monospace">${code}</div></td></tr>
<tr><td style="font-size:14px;line-height:1.6;color:#334155">Mã có hiệu lực trong <b>${ttlMinutes} phút</b>. Tuyệt đối không chia sẻ mã này cho bất kỳ ai, kể cả nhân viên Shoppc.</td></tr>
<tr><td style="padding-top:16px;font-size:13px;color:#64748b">${escapeHtml(ignoreLine)}</td></tr>
</table></td></tr></table></body></html>`;

    try {
        await transport.sendMail({ from: fromAddress(), to: email, subject: `${code} là mã xác nhận ${action} Shoppc`, text, html });
    } catch (error) {
        console.error('[mailer] Gửi mã OTP thất bại:', error.code || '', error.message);
        console.error('[mailer] Chạy "npm run mail-check -- <email của bạn>" để xem nguyên nhân và cách sửa.');
        throw new ValidationError('Không gửi được email xác nhận. Vui lòng kiểm tra lại địa chỉ email hoặc thử lại sau ít phút.', 502);
    }
    return { delivered: true };
}

/** Mã OTP xác nhận email khi đăng ký tài khoản mới. */
const sendRegisterOtp = ({ email, name, code, ttlMinutes }) =>
    sendOtpEmail({
        email, name, code, ttlMinutes,
        action: 'đăng ký tài khoản',
        ignoreLine: 'Nếu bạn không đăng ký tài khoản Shoppc, hãy bỏ qua email này.',
        unconfigured: 'Hệ thống chưa cấu hình gửi email nên chưa đăng ký được. Vui lòng liên hệ cửa hàng.'
    });

/** Mã OTP gửi tới email MỚI khi khách đổi email tài khoản. */
const sendEmailChangeOtp = ({ email, name, code, ttlMinutes }) =>
    sendOtpEmail({
        email, name, code, ttlMinutes,
        action: 'đổi email',
        ignoreLine: 'Nếu bạn không yêu cầu đổi email tài khoản Shoppc sang địa chỉ này, hãy bỏ qua email này.',
        unconfigured: 'Hệ thống chưa cấu hình gửi email nên chưa đổi email được. Vui lòng liên hệ cửa hàng.'
    });

module.exports = { sendPasswordReset, sendRegisterOtp, sendEmailChangeOtp, isConfigured };
