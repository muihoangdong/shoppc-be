'use strict';

/** Lỗi do dữ liệu đầu vào không hợp lệ: thông báo an toàn để hiển thị cho người dùng. */
class ValidationError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
        this.expose = true;
    }
}

/**
 * Trả lỗi cho client mà KHÔNG lộ chi tiết nội bộ:
 *  - lỗi nghiệp vụ / kiểm tra dữ liệu (expose)  -> đúng mã HTTP + thông báo tiếng Việt
 *  - ràng buộc khóa ngoại MySQL                  -> 409 "đang được sử dụng"
 *  - còn lại                                     -> log + 500 thông báo chung
 */
function sendError(res, error, fallback = 'Đã xảy ra lỗi, vui lòng thử lại sau') {
    if (error && error.expose) {
        return res.status(error.status || 400).json({ success: false, message: error.message });
    }
    if (error && (error.code === 'ER_ROW_IS_REFERENCED_2' || error.code === 'ER_ROW_IS_REFERENCED')) {
        return res.status(409).json({
            success: false,
            message: 'Không thể xóa vì dữ liệu này đang được sử dụng ở nơi khác (ví dụ sản phẩm đã có trong đơn hàng)'
        });
    }
    console.error('API error:', error);
    return res.status(500).json({ success: false, message: fallback });
}

module.exports = { ValidationError, sendError };
