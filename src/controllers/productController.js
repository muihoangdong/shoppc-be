const ProductModel = require('../models/Product');

class ProductController {
    // Lấy tất cả sản phẩm
    static async getAllProducts(req, res) {
        try {
            const { category_id, type, search } = req.query;
            const products = await ProductModel.getAllProducts({ category_id, type, search });
            
            res.json({
                success: true,
                data: products
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: error.message
            });
        }
    }

    // Lấy sản phẩm theo ID
    static async getProductById(req, res) {
        try {
            const { id } = req.params;
            const product = await ProductModel.getProductById(id);
            
            if (!product) {
                return res.status(404).json({
                    success: false,
                    message: 'Không tìm thấy sản phẩm'
                });
            }
            
            res.json({
                success: true,
                data: product
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: error.message
            });
        }
    }

    // Lấy sản phẩm theo danh mục
    static async getProductsByCategory(req, res) {
        try {
            const { categoryId } = req.params;
            const products = await ProductModel.getProductsByCategory(categoryId);
            
            res.json({
                success: true,
                data: products
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: error.message
            });
        }
    }

    // Lấy sản phẩm theo loại
    static async getProductsByType(req, res) {
        try {
            const { type } = req.params;
            const products = await ProductModel.getProductsByType(type);
            
            res.json({
                success: true,
                data: products
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: error.message
            });
        }
    }

    // Tạo sản phẩm mới
    static async createProduct(req, res) {
        try {
            const { name, description, price, stock, category_id, image_url, specs } = req.body;
            
            if (!name || !price || !category_id) {
                return res.status(400).json({
                    success: false,
                    message: 'Vui lòng nhập đầy đủ thông tin bắt buộc'
                });
            }
            
            const id = await ProductModel.createProduct({
                name, description, price, stock, category_id, image_url, specs
            });
            
            res.status(201).json({
                success: true,
                message: 'Tạo sản phẩm thành công',
                data: { id }
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: error.message
            });
        }
    }

    // Cập nhật sản phẩm
    static async updateProduct(req, res) {
        try {
            const { id } = req.params;
            const { name, description, price, stock, category_id, image_url, specs } = req.body;
            
            const affectedRows = await ProductModel.updateProduct(id, {
                name, description, price, stock, category_id, image_url, specs
            });
            
            if (affectedRows === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Không tìm thấy sản phẩm'
                });
            }
            
            res.json({
                success: true,
                message: 'Cập nhật sản phẩm thành công'
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: error.message
            });
        }
    }

    // Xóa sản phẩm
    static async deleteProduct(req, res) {
        try {
            const { id } = req.params;
            
            const affectedRows = await ProductModel.deleteProduct(id);
            
            if (affectedRows === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Không tìm thấy sản phẩm'
                });
            }
            
            res.json({
                success: true,
                message: 'Xóa sản phẩm thành công'
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: error.message
            });
        }
    }
}

module.exports = ProductController;