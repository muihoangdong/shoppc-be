const CategoryModel = require('../models/Category');

class CategoryController {
    static async getAllCategories(req, res) {
        try {
            const categories = await CategoryModel.getAllCategories();
            res.json({ success: true, data: categories });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async getCategoryById(req, res) {
        try {
            const category = await CategoryModel.getCategoryById(req.params.id);
            if (!category) return res.status(404).json({ success: false, message: 'Không tìm thấy danh mục' });
            const subCategories = await CategoryModel.getSubCategories(req.params.id);
            res.json({ success: true, data: { ...category, sub_categories: subCategories } });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async createCategory(req, res) {
        try {
            const { name, type } = req.body;
            if (!name || !type) return res.status(400).json({ success: false, message: 'Vui lòng nhập đầy đủ thông tin' });
            const id = await CategoryModel.createCategory(req.body);
            const category = await CategoryModel.getCategoryById(id);
            res.status(201).json({ success: true, message: 'Tạo danh mục thành công', data: category });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async updateCategory(req, res) {
        try {
            const affectedRows = await CategoryModel.updateCategory(req.params.id, req.body);
            if (affectedRows === 0) return res.status(404).json({ success: false, message: 'Không tìm thấy danh mục hoặc không có dữ liệu cập nhật' });
            const category = await CategoryModel.getCategoryById(req.params.id);
            res.json({ success: true, message: 'Cập nhật danh mục thành công', data: category });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async deleteCategory(req, res) {
        try {
            const affectedRows = await CategoryModel.deleteCategory(req.params.id);
            if (affectedRows === 0) return res.status(404).json({ success: false, message: 'Không tìm thấy danh mục' });
            res.json({ success: true, message: 'Xóa danh mục thành công' });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    }
}

module.exports = CategoryController;
