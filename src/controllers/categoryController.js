const CategoryModel = require('../models/Category');

class CategoryController {
    // Lấy tất cả danh mục
    static async getAllCategories(req, res) {
        try {
            const categories = await CategoryModel.getAllCategories();
            res.json({
                success: true,
                data: categories
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: error.message
            });
        }
    }

    // Lấy danh mục theo ID
    static async getCategoryById(req, res) {
        try {
            const { id } = req.params;
            const category = await CategoryModel.getCategoryById(id);
            
            if (!category) {
                return res.status(404).json({
                    success: false,
                    message: 'Không tìm thấy danh mục'
                });
            }
            
            // Lấy danh mục con
            const subCategories = await CategoryModel.getSubCategories(id);
            
            res.json({
                success: true,
                data: {
                    ...category,
                    sub_categories: subCategories
                }
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: error.message
            });
        }
    }

    // Tạo danh mục mới
    static async createCategory(req, res) {
        try {
            const { name, type, parent_id } = req.body;
            
            if (!name || !type) {
                return res.status(400).json({
                    success: false,
                    message: 'Vui lòng nhập đầy đủ thông tin'
                });
            }
            
            const id = await CategoryModel.createCategory({ name, type, parent_id });
            
            res.status(201).json({
                success: true,
                message: 'Tạo danh mục thành công',
                data: { id }
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: error.message
            });
        }
    }

    // Cập nhật danh mục
    static async updateCategory(req, res) {
        try {
            const { id } = req.params;
            const { name, type, parent_id } = req.body;
            
            const affectedRows = await CategoryModel.updateCategory(id, { name, type, parent_id });
            
            if (affectedRows === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Không tìm thấy danh mục'
                });
            }
            
            res.json({
                success: true,
                message: 'Cập nhật danh mục thành công'
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: error.message
            });
        }
    }

    // Xóa danh mục
    static async deleteCategory(req, res) {
        try {
            const { id } = req.params;
            
            // Kiểm tra xem có sản phẩm nào thuộc danh mục này không
            const affectedRows = await CategoryModel.deleteCategory(id);
            
            if (affectedRows === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Không tìm thấy danh mục'
                });
            }
            
            res.json({
                success: true,
                message: 'Xóa danh mục thành công'
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: error.message
            });
        }
    }
}

module.exports = CategoryController;