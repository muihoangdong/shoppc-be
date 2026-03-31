const db = require('../config/database');

class Category {
    // Lấy tất cả danh mục
    static async getAllCategories() {
        const [rows] = await db.query('SELECT * FROM categories ORDER BY parent_id, id');
        return rows;
    }

    // Lấy danh mục theo ID
    static async getCategoryById(id) {
        const [rows] = await db.query('SELECT * FROM categories WHERE id = ?', [id]);
        return rows[0];
    }

    // Lấy danh mục con
    static async getSubCategories(parentId) {
        const [rows] = await db.query('SELECT * FROM categories WHERE parent_id = ?', [parentId]);
        return rows;
    }

    // Tạo danh mục mới
    static async createCategory(categoryData) {
        const { name, type, parent_id = null } = categoryData;
        const [result] = await db.query(
            'INSERT INTO categories (name, type, parent_id) VALUES (?, ?, ?)',
            [name, type, parent_id]
        );
        return result.insertId;
    }

    // Cập nhật danh mục
    static async updateCategory(id, categoryData) {
        const { name, type, parent_id } = categoryData;
        const [result] = await db.query(
            'UPDATE categories SET name = ?, type = ?, parent_id = ? WHERE id = ?',
            [name, type, parent_id, id]
        );
        return result.affectedRows;
    }

    // Xóa danh mục
    static async deleteCategory(id) {
        const [result] = await db.query('DELETE FROM categories WHERE id = ?', [id]);
        return result.affectedRows;
    }
}

module.exports = Category;