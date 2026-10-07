const visitor = require('../services/support/visitor');
const UserModel = require('../models/User');
const { verifyAccessToken } = require('../config/jwt');

/** Bắt buộc có token khách hợp lệ (header X-Visitor-Token). */
function requireVisitor(req, res, next) {
    const token = req.headers['x-visitor-token'];
    const id = typeof token === 'string' ? visitor.verify(token) : null;
    if (!id) return res.status(401).json({ success: false, message: 'Phiên chat không hợp lệ, vui lòng tải lại trang' });
    req.visitor = { id };
    return next();
}

/** Nếu khách đang đăng nhập (Authorization: Bearer ...) thì gắn req.user; token sai/hết hạn thì bỏ qua (vẫn chat như khách). */
async function optionalUser(req, res, next) {
    const header = req.headers.authorization;
    if (header && header.startsWith('Bearer ')) {
        try {
            const decoded = verifyAccessToken(header.slice(7));
            const user = await UserModel.getUserById(decoded.id);
            if (user && user.status === 'active') req.user = { id: user.id, username: user.username, role: user.role, full_name: user.full_name };
        } catch {
            /* chat như khách ẩn danh */
        }
    }
    return next();
}

module.exports = { requireVisitor, optionalUser };
