const ProductModel = require('../models/Product');

class ProductController {
    static async getAllProducts(req, res) {
        try {
            const { category_id, type, search } = req.query;
            const products = await ProductModel.getAllProducts({ category_id, type, search });
            res.json({ success: true, data: products });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async getProductById(req, res) {
        try {
            const product = await ProductModel.getProductById(req.params.id);
            if (!product) return res.status(404).json({ success: false, message: 'Không tìm thấy sản phẩm' });
            res.json({ success: true, data: product });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async getProductsByCategory(req, res) {
        try {
            const products = await ProductModel.getProductsByCategory(req.params.categoryId);
            res.json({ success: true, data: products });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async getProductsByType(req, res) {
        try {
            const products = await ProductModel.getProductsByType(req.params.type);
            res.json({ success: true, data: products });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async createProduct(req, res) {
        try {
            const { name, price, category_id } = req.body;
            if (!name || price === undefined || !category_id) {
                return res.status(400).json({ success: false, message: 'Vui lòng nhập đầy đủ thông tin bắt buộc' });
            }
            const id = await ProductModel.createProduct(req.body);
            const product = await ProductModel.getProductById(id);
            res.status(201).json({ success: true, message: 'Tạo sản phẩm thành công', data: product });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async updateProduct(req, res) {
        try {
            const affectedRows = await ProductModel.updateProduct(req.params.id, req.body);
            if (affectedRows === 0) return res.status(404).json({ success: false, message: 'Không tìm thấy sản phẩm hoặc không có dữ liệu cập nhật' });
            const product = await ProductModel.getProductById(req.params.id);
            res.json({ success: true, message: 'Cập nhật sản phẩm thành công', data: product });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async updateStock(req, res) {
        try {
            const { quantity } = req.body;
            if (quantity === undefined || Number(quantity) < 0) {
                return res.status(400).json({ success: false, message: 'Số lượng tồn kho không hợp lệ' });
            }
            const affectedRows = await ProductModel.setStock(req.params.id, Number(quantity));
            if (affectedRows === 0) return res.status(404).json({ success: false, message: 'Không tìm thấy sản phẩm' });
            const product = await ProductModel.getProductById(req.params.id);
            res.json({ success: true, message: 'Cập nhật tồn kho thành công', data: product });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async deleteProduct(req, res) {
        try {
            const affectedRows = await ProductModel.deleteProduct(req.params.id);
            if (affectedRows === 0) return res.status(404).json({ success: false, message: 'Không tìm thấy sản phẩm' });
            res.json({ success: true, message: 'Xóa sản phẩm thành công' });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    }
}

module.exports = ProductController;
