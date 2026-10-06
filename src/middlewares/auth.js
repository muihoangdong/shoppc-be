const UserModel = require('../models/User');
const { verifyAccessToken } = require('../config/jwt');
const { hasRole } = require('../config/roles');

// Middleware xác thực token
const authenticate = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                success: false,
                message: 'Không có token xác thực'
            });
        }
        
        const token = authHeader.split(' ')[1];
        
        try {
            const decoded = verifyAccessToken(token);
            const user = await UserModel.getUserById(decoded.id);
            
            if (!user) {
                return res.status(401).json({
                    success: false,
                    message: 'Token không hợp lệ'
                });
            }
            
            if (user.status !== 'active') {
                return res.status(401).json({
                    success: false,
                    message: 'Tài khoản đã bị khóa'
                });
            }
            
            req.user = {
                id: user.id,
                username: user.username,
                role: user.role
            };
            
            next();
        } catch (error) {
            return res.status(401).json({
                success: false,
                message: 'Token không hợp lệ hoặc đã hết hạn'
            });
        }
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/**
 * Đăng nhập KHÔNG bắt buộc: có token hợp lệ thì gắn req.user, không có / sai / hết hạn thì coi như khách vãng lai
 * (không trả 401). Dùng cho route công khai cần biết "ai đang xem", ví dụ đặt hàng, xem đánh giá.
 */
const optionalAuth = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return next();
    try {
        const decoded = verifyAccessToken(authHeader.split(' ')[1]);
        const user = await UserModel.getUserById(decoded.id);
        if (user && user.status === 'active') {
            req.user = { id: user.id, username: user.username, role: user.role };
        }
    } catch (error) {
        // token hỏng / hết hạn: bỏ qua
    }
    return next();
};

// Middleware kiểm tra quyền admin
const authorizeAdmin = (req, res, next) => {
    if (req.user && hasRole(req.user.role, 'admin')) {
        next();
    } else {
        res.status(403).json({
            success: false,
            message: 'Bạn không có quyền thực hiện hành động này'
        });
    }
};

// Middleware kiểm tra quyền staff hoặc admin
const authorizeStaff = (req, res, next) => {
    if (req.user && hasRole(req.user.role, 'staff')) {
        next();
    } else {
        res.status(403).json({
            success: false,
            message: 'Bạn không có quyền thực hiện hành động này'
        });
    }
};

module.exports = {
    authenticate,
    optionalAuth,
    authorizeAdmin,
    authorizeStaff
};