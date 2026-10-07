'use strict';

const rateLimit = require('./rateLimit');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// Dùng chung cho /api/auth/* và các route trùng lặp ở /api/users/* để cùng một bộ đếm (không né được bằng đường khác).
module.exports = {
    loginLimiter: rateLimit({ windowMs: 15 * MIN, max: 10, message: 'Bạn đăng nhập sai quá nhiều lần, vui lòng thử lại sau 15 phút.' }),
    registerLimiter: rateLimit({ windowMs: HOUR, max: 10, message: 'Bạn đăng ký quá nhiều lần, vui lòng thử lại sau.' }),
    forgotLimiter: rateLimit({ windowMs: HOUR, max: 5, message: 'Bạn yêu cầu đặt lại mật khẩu quá nhiều lần, vui lòng thử lại sau.' }),
    // Xác nhận mã OTP đăng ký: chặn dò mã theo IP (mỗi mã còn giới hạn riêng số lần nhập sai, xem services/registrationOtp.js)
    otpVerifyLimiter: rateLimit({ windowMs: 15 * MIN, max: 20, message: 'Bạn nhập mã quá nhiều lần, vui lòng thử lại sau 15 phút.' }),
    otpResendLimiter: rateLimit({ windowMs: HOUR, max: 10, message: 'Bạn yêu cầu gửi mã quá nhiều lần, vui lòng thử lại sau.' }),
    // Build PC: AI chọn cấu hình (mỗi lần gọi tốn nhiều lượt API)
    builderAiLimiter: rateLimit({ windowMs: 10 * MIN, max: 8, message: 'Bạn nhờ AI chọn cấu hình quá nhiều lần, vui lòng thử lại sau ít phút.' })
};
