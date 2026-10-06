'use strict';

/**
 * Gửi email đặt lại mật khẩu.
 *
 * Dự án chưa có thư viện gửi mail. Để bật gửi mail thật:
 *   1) npm install nodemailer
 *   2) đặt SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS (và tùy chọn MAIL_FROM) trong .env
 *
 * Khi chưa cấu hình:
 *   - môi trường phát triển : in liên kết đặt lại mật khẩu ra console của server (để thử nghiệm);
 *   - production            : chỉ ghi cảnh báo, TUYỆT ĐỐI không in/không trả token ra ngoài.
 */

function loadTransport() {
    if (!process.env.SMTP_HOST) return null;
    try {
        const nodemailer = require('nodemailer'); // eslint-disable-line global-require
        return nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: Number(process.env.SMTP_PORT) || 587,
            secure: Number(process.env.SMTP_PORT) === 465,
            auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
        });
    } catch {
        console.warn('[mailer] Đã đặt SMTP_HOST nhưng chưa cài nodemailer (chạy: npm install nodemailer).');
        return null;
    }
}

async function sendPasswordReset(user, token) {
    const base = (process.env.FRONTEND_URL || 'http://localhost:3001').replace(/\/$/, '');
    const link = `${base}/reset-password?token=${encodeURIComponent(token)}`;

    const transport = loadTransport();
    if (transport) {
        await transport.sendMail({
            from: process.env.MAIL_FROM || process.env.SMTP_USER,
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

module.exports = { sendPasswordReset };
