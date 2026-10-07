#!/usr/bin/env node
/**
 * Kiểm tra cấu hình gửi email (SMTP) và gửi thử 1 email.
 *
 *   npm run mail-check -- ban@gmail.com
 *
 * In ra cấu hình đang đọc được từ .env (KHÔNG in mật khẩu), thử đăng nhập máy chủ SMTP,
 * gửi 1 email thử, và giải thích lỗi thường gặp bằng tiếng Việt.
 */
require('dotenv').config();

const ok = (s) => console.log(`  ✅ ${s}`);
const bad = (s) => console.log(`  ❌ ${s}`);
const tip = (s) => console.log(`     → ${s}`);

/** Lỗi SMTP thường gặp -> giải thích + cách sửa */
function explain(error) {
    const msg = `${error.code || ''} ${error.responseCode || ''} ${error.message || ''}`;
    if (/534|5\.7\.9|Application-specific password/i.test(msg)) {
        return ['Gmail yêu cầu MẬT KHẨU ỨNG DỤNG, không dùng mật khẩu đăng nhập Gmail.',
            'Bật Xác minh 2 bước, rồi tạo tại https://myaccount.google.com/apppasswords và dán 16 ký tự vào SMTP_PASS.'];
    }
    if (/EAUTH|535|5\.7\.8|Username and Password not accepted|Invalid login/i.test(msg)) {
        return ['Sai tài khoản hoặc mật khẩu SMTP.',
            'SMTP_USER phải là đúng địa chỉ Gmail đã tạo mật khẩu ứng dụng; SMTP_PASS là 16 ký tự mật khẩu ứng dụng (tạo lại mật khẩu mới nếu không chắc).'];
    }
    if (/wrong version number|ssl3_get_record|EPROTO/i.test(msg)) {
        return ['Sai cổng/kiểu mã hóa.', 'Gmail: dùng SMTP_PORT=465 (hoặc 587).'];
    }
    if (/ETIMEDOUT|ECONNECTION|ECONNREFUSED|ESOCKET|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN/i.test(msg)) {
        return ['Không kết nối được tới máy chủ email.',
            'Kiểm tra SMTP_HOST (Gmail: smtp.gmail.com), mạng Internet, tường lửa/antivirus có chặn cổng 465 không — thử đổi SMTP_PORT=587.'];
    }
    if (/EENVELOPE|5\.1\.\d|recipient/i.test(msg)) {
        return ['Địa chỉ người nhận hoặc người gửi không hợp lệ.', 'Kiểm tra địa chỉ email nhận và MAIL_FROM (nên để trống để dùng SMTP_USER).'];
    }
    return ['Lỗi không xác định khi gửi email.', 'Gửi nguyên dòng lỗi phía trên để được hỗ trợ.'];
}

(async () => {
    const to = process.argv[2];
    const host = process.env.SMTP_HOST || '';
    const port = Number(process.env.SMTP_PORT) || 587;
    const user = process.env.SMTP_USER || '';
    const rawPass = process.env.SMTP_PASS || '';
    const pass = /gmail/i.test(host) ? rawPass.replace(/\s+/g, '') : rawPass;

    console.log('\n── Cấu hình gửi email đọc từ shoppc-be/.env ──');
    console.log(`  SMTP_HOST = ${host || '(trống)'}`);
    console.log(`  SMTP_PORT = ${process.env.SMTP_PORT || '(trống → 587)'}`);
    console.log(`  SMTP_USER = ${user || '(trống)'}`);
    console.log(`  SMTP_PASS = ${rawPass ? `(đã điền, ${pass.length} ký tự${pass.length !== rawPass.length ? ', đã bỏ dấu cách' : ''})` : '(TRỐNG)'}`);
    console.log(`  MAIL_FROM = ${process.env.MAIL_FROM || '(trống → dùng SMTP_USER)'}`);
    console.log(`  NODE_ENV  = ${process.env.NODE_ENV || '(trống → development)'}\n`);

    let problems = 0;
    if (!host) { bad('Chưa điền SMTP_HOST → hệ thống KHÔNG gửi email, mã OTP hiện ngay trên trang (chế độ chạy thử) và in ra cửa sổ backend.'); tip('Gmail: SMTP_HOST=smtp.gmail.com'); problems += 1; }
    if (!user) { bad('Chưa điền SMTP_USER (địa chỉ Gmail dùng để gửi).'); problems += 1; }
    if (!rawPass) { bad('SMTP_PASS đang trống → hệ thống KHÔNG gửi email, mã OTP hiện ngay trên trang (chế độ chạy thử) và in ra cửa sổ backend.'); tip('Tạo mật khẩu ứng dụng tại https://myaccount.google.com/apppasswords (cần bật Xác minh 2 bước) rồi dán vào SMTP_PASS.'); problems += 1; }
    if (/gmail/i.test(host) && pass && pass.length !== 16) { bad(`Mật khẩu ứng dụng Gmail phải có 16 ký tự (đang có ${pass.length}). Có thể bạn đang dùng mật khẩu đăng nhập Gmail.`); problems += 1; }
    if (/gmail/i.test(host) && user && !/@(gmail|googlemail)\.com$/i.test(user) && !/@/.test(user)) { bad('SMTP_USER phải là địa chỉ email đầy đủ, ví dụ shop@gmail.com.'); problems += 1; }
    if (problems) {
        console.log('\nSửa các mục ❌ trong shoppc-be/.env, lưu file, rồi chạy lại lệnh này. Nhớ khởi động lại backend sau khi sửa .env.\n');
        process.exit(1);
    }

    let nodemailer;
    try {
        nodemailer = require('nodemailer'); // eslint-disable-line global-require
    } catch {
        bad('Chưa cài thư viện nodemailer.'); tip('Chạy: npm install'); process.exit(1);
    }

    const transport = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass }, connectionTimeout: 15000 });
    try {
        await transport.verify();
        ok(`Đăng nhập máy chủ email ${host}:${port} thành công.`);
    } catch (error) {
        bad(`Đăng nhập máy chủ email thất bại: ${error.message}`);
        explain(error).forEach(tip);
        process.exit(1);
    }

    if (!to) {
        console.log('\nCấu hình đúng. Muốn gửi thử 1 email: npm run mail-check -- email-cua-ban@gmail.com\n');
        return;
    }
    try {
        const info = await transport.sendMail({
            from: process.env.MAIL_FROM || user,
            to,
            subject: 'Shoppc: email thử nghiệm',
            text: 'Nếu bạn đọc được email này thì cấu hình gửi email (mã OTP đăng ký, quên mật khẩu) đã hoạt động.',
        });
        ok(`Đã gửi email thử tới ${to} (mã: ${info.messageId}).`);
        tip('Không thấy trong Hộp thư đến? Xem thư mục Spam / Quảng cáo và đợi 1–2 phút.');
        console.log('');
    } catch (error) {
        bad(`Gửi email thất bại: ${error.message}`);
        explain(error).forEach(tip);
        process.exit(1);
    }
})();
