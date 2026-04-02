const db = require('../config/database');

class Category {
    static async getAllCategories() {
        const [rows] = await db.query(
            `SELECT c.*, p.name as parent_name
             FROM categories c
             LEFT JOIN categories p ON c.parent_id = p.id
             ORDER BY c.type, c.name`
        );
        return rows;
    }

    static async getCategoryById(id) {
        const [rows] = await db.query(
            `SELECT c.*, p.name as parent_name
             FROM categories c
             LEFT JOIN categories p ON c.parent_id = p.id
             WHERE c.id = ?`,
            [id]
        );
        return rows[0];
    }

    static async getSubCategories(parentId) {
        const [rows] = await db.query('SELECT * FROM categories WHERE parent_id = ? ORDER BY name', [parentId]);
        return rows;
    }

    static async createCategory(categoryData) {
        const { name, type, parent_id = null } = categoryData;
        const [result] = await db.query(
            'INSERT INTO categories (name, type, parent_id) VALUES (?, ?, ?)',
            [name, type, parent_id || null]
        );
        return result.insertId;
    }

    static async updateCategory(id, categoryData) {
        const allowed = ['name', 'type', 'parent_id'];
        const entries = Object.entries(categoryData).filter(([key, value]) => allowed.includes(key) && value !== undefined);
        if (entries.length === 0) return 0;
        const setClause = entries.map(([key]) => `${key} = ?`).join(', ');
        const values = entries.map(([, value]) => value === '' ? null : value);
        values.push(id);
        const [result] = await db.query(`UPDATE categories SET ${setClause}, updated_at = NOW() WHERE id = ?`, values);
        return result.affectedRows;
    }

    static async deleteCategory(id) {
        const [result] = await db.query('DELETE FROM categories WHERE id = ?', [id]);
        return result.affectedRows;
    }
}

module.exports = Category;
