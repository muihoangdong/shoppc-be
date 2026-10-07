const db = require('../config/database');

class Category {
    static async getAllCategories() {
        const rows = await db.query(
            `SELECT c.*, p.name AS parent_name,
                    (SELECT COUNT(*) FROM products pr WHERE pr.category_id = c.id) AS product_count
             FROM categories c
             LEFT JOIN categories p ON c.parent_id = p.id
             ORDER BY c.type, c.name`
        );
        return rows;
    }

    static async getCategoryById(id) {
        const rows = await db.query(
            `SELECT c.*, p.name AS parent_name
             FROM categories c
             LEFT JOIN categories p ON c.parent_id = p.id
             WHERE c.id = ?`,
            [id]
        );
        return rows[0];
    }

    static async getSubCategories(parentId) {
        const rows = await db.query(
            'SELECT * FROM categories WHERE parent_id = ? ORDER BY name',
            [parentId]
        );
        return rows;
    }

    static async getCategoriesByType(type) {
        const rows = await db.query(
            'SELECT * FROM categories WHERE type = ? AND parent_id IS NULL ORDER BY name',
            [type]
        );
        return rows;
    }

    static async createCategory(categoryData) {
        const { name, type, parent_id = null } = categoryData;

        const [result] = await db.pool.query(
            'INSERT INTO categories (name, type, parent_id) VALUES (?, ?, ?)',
            [name, type, parent_id || null]
        );

        return result.insertId;
    }

    static async updateCategory(id, categoryData) {
        const allowed = ['name', 'type', 'parent_id'];

        const entries = Object.entries(categoryData)
            .filter(([key, value]) =>
                allowed.includes(key) && value !== undefined
            );

        if (entries.length === 0) return 0;

        const setClause = entries.map(([key]) => `${key} = ?`).join(', ');

        const values = entries.map(([, value]) =>
            value === '' ? null : value
        );

        values.push(id);

        const [result] = await db.pool.query(
            `UPDATE categories
             SET ${setClause},
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            values
        );

        return result.affectedRows;
    }

    static async deleteCategory(id) {
        // Kiểm tra xem category có subcategories không
        const subCategories = await db.query(
            'SELECT COUNT(*) AS count FROM categories WHERE parent_id = ?',
            [id]
        );

        if (parseInt(subCategories[0].count) > 0) {
            throw new Error('Cannot delete category with subcategories');
        }

        // Kiểm tra xem category có sản phẩm không
        const products = await db.query(
            'SELECT COUNT(*) AS count FROM products WHERE category_id = ?',
            [id]
        );

        if (parseInt(products[0].count) > 0) {
            throw new Error('Cannot delete category with products');
        }

        const [result] = await db.pool.query(
            'DELETE FROM categories WHERE id = ?',
            [id]
        );

        return result.affectedRows;
    }

    // Lấy category tree
    static async getCategoryTree() {
        const categories = await this.getAllCategories();

        const categoryMap = new Map();
        const tree = [];

        // Tạo map
        categories.forEach(category => {
            categoryMap.set(category.id, {
                ...category,
                children: []
            });
        });

        // Xây dựng tree
        categories.forEach(category => {
            if (
                category.parent_id &&
                categoryMap.has(category.parent_id)
            ) {
                categoryMap
                    .get(category.parent_id)
                    .children.push(categoryMap.get(category.id));
            } else {
                tree.push(categoryMap.get(category.id));
            }
        });

        return tree;
    }

    // Bulk insert categories
    static async bulkCreateCategories(categories) {
        const connection = await db.getClient();

        try {
            await connection.beginTransaction();

            const insertedIds = [];

            for (const category of categories) {
                const [result] = await connection.query(
                    'INSERT INTO categories (name, type, parent_id) VALUES (?, ?, ?)',
                    [category.name, category.type, category.parent_id || null]
                );

                insertedIds.push(result.insertId);
            }

            await connection.commit();

            return insertedIds;

        } catch (error) {
            await connection.rollback();
            throw error;

        } finally {
            connection.release();
        }
    }
}

module.exports = Category;