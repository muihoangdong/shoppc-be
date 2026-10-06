// Xử lý lỗi chung. Lỗi 4xx (ví dụ JSON gửi lên sai định dạng) trả thông báo ngắn;
// lỗi 5xx ở production KHÔNG lộ chi tiết, stack chỉ hiện khi NODE_ENV=development.
const errorHandler = (err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    const isProd = process.env.NODE_ENV === 'production';

    if (status >= 500) console.error(err.stack || err);

    let message = err.message || 'Internal Server Error';
    if (status >= 500 && isProd) message = 'Đã xảy ra lỗi hệ thống, vui lòng thử lại sau';
    if (err.type === 'entity.parse.failed') message = 'Dữ liệu gửi lên không phải JSON hợp lệ';
    if (err.type === 'entity.too.large') message = 'Dữ liệu gửi lên quá lớn';

    res.status(status).json({
        success: false,
        message,
        error: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
};

module.exports = errorHandler;
