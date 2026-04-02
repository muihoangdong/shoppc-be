const jwt = require('jsonwebtoken');
const UserModel = require('../models/User');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';

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
            const decoded = jwt.verify(token, JWT_SECRET);
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

// Middleware kiểm tra quyền admin
const authorizeAdmin = (req, res, next) => {
    if (req.user && req.user.role === 'admin') {
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
    if (req.user && (req.user.role === 'admin' || req.user.role === 'staff')) {
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
    authorizeAdmin,
    authorizeStaff
};