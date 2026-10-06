const CartModel = require('../models/Cart');

class CartController {
    // Lấy giỏ hàng
    static async getCart(req, res) {
        try {
            const sessionId = req.headers['x-session-id'] || req.query.session_id;
            
            if (!sessionId) {
                return res.status(400).json({
                    success: false,
                    message: 'Thiếu session_id'
                });
            }
            
            const cart = await CartModel.getCart(sessionId);
            
            res.json({
                success: true,
                data: cart
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: error.message
            });
        }
    }

    // Thêm vào giỏ hàng
    static async addToCart(req, res) {
        try {
            const sessionId = req.headers['x-session-id'] || req.body.session_id;
            const { product_id, quantity = 1 } = req.body;
            
            if (!sessionId || !product_id) {
                return res.status(400).json({
                    success: false,
                    message: 'Thiếu thông tin bắt buộc'
                });
            }
            
            if (quantity <= 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Số lượng phải lớn hơn 0'
                });
            }
            
            const result = await CartModel.addToCart(sessionId, product_id, quantity);
            
            res.json({
                success: true,
                message: 'Đã thêm vào giỏ hàng',
                data: result
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: error.message
            });
        }
    }

    // Cập nhật giỏ hàng
    static async updateCartItem(req, res) {
        try {
            const sessionId = req.headers['x-session-id'] || req.body.session_id;
            const { product_id, quantity } = req.body;
            
            if (!sessionId || !product_id || quantity === undefined) {
                return res.status(400).json({
                    success: false,
                    message: 'Thiếu thông tin bắt buộc'
                });
            }
            
            const result = await CartModel.updateCartItem(sessionId, product_id, quantity);
            
            if (result === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Không tìm thấy sản phẩm trong giỏ hàng'
                });
            }
            
            res.json({
                success: true,
                message: 'Cập nhật giỏ hàng thành công'
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: error.message
            });
        }
    }

    // Xóa khỏi giỏ hàng
    static async removeFromCart(req, res) {
        try {
            const sessionId = req.headers['x-session-id'] || req.body.session_id;
            const { product_id } = req.params;
            
            if (!sessionId) {
                return res.status(400).json({
                    success: false,
                    message: 'Thiếu session_id'
                });
            }
            
            const result = await CartModel.removeFromCart(sessionId, product_id);
            
            if (result === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Không tìm thấy sản phẩm trong giỏ hàng'
                });
            }
            
            res.json({
                success: true,
                message: 'Đã xóa sản phẩm khỏi giỏ hàng'
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: error.message
            });
        }
    }

    // Xóa toàn bộ giỏ hàng
    static async clearCart(req, res) {
        try {
            const sessionId = req.headers['x-session-id'] || req.body.session_id;
            
            if (!sessionId) {
                return res.status(400).json({
                    success: false,
                    message: 'Thiếu session_id'
                });
            }
            
            await CartModel.clearCart(sessionId);
            
            res.json({
                success: true,
                message: 'Đã xóa toàn bộ giỏ hàng'
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: error.message
            });
        }
    }
    
    // Kiểm tra tồn kho
    static async checkStock(req, res) {
        try {
            const sessionId = req.headers['x-session-id'] || req.query.session_id;
            
            if (!sessionId) {
                return res.status(400).json({
                    success: false,
                    message: 'Thiếu session_id'
                });
            }
            
            const stockCheck = await CartModel.checkStock(sessionId);
            
            res.json({
                success: true,
                data: stockCheck
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: error.message
            });
        }
    }
}

module.exports = CartController;