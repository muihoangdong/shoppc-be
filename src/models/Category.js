const db = require('../config/database');

class Category {
    static async getAllCategories() {
        const result = await db.query(
            `SELECT c.*, p.name as parent_name
             FROM categories c
             LEFT JOIN categories p ON c.parent_id = p.id
             ORDER BY c.type, c.name`
        );
        return result.rows;
    }

    static async getCategoryById(id) {
        const result = await db.query(
            `SELECT c.*, p.name as parent_name
             FROM categories c
             LEFT JOIN categories p ON c.parent_id = p.id
             WHERE c.id = $1`,
            [id]
        );
        return result.rows[0];
    }

    static async getSubCategories(parentId) {
        const result = await db.query(
            'SELECT * FROM categories WHERE parent_id = $1 ORDER BY name',
            [parentId]
        );
        return result.rows;
    }

    static async getCategoriesByType(type) {
        const result = await db.query(
            'SELECT * FROM categories WHERE type = $1 AND parent_id IS NULL ORDER BY name',
            [type]
        );
        return result.rows;
    }

    static async createCategory(categoryData) {
        const { name, type, parent_id = null } = categoryData;
        const result = await db.query(
            'INSERT INTO categories (name, type, parent_id) VALUES ($1, $2, $3) RETURNING id',
            [name, type, parent_id || null]
        );
        return result.rows[0].id;
    }

    static async updateCategory(id, categoryData) {
        const allowed = ['name', 'type', 'parent_id'];
        const entries = Object.entries(categoryData).filter(([key, value]) => allowed.includes(key) && value !== undefined);
        
        if (entries.length === 0) return 0;
        
        const setClause = entries.map(([key], index) => `${key} = $${index + 1}`).join(', ');
        const values = entries.map(([, value]) => value === '' ? null : value);
        values.push(id);
        
        const result = await db.query(
            `UPDATE categories SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = $${values.length} RETURNING id`,
            values
        );
        return result.rowCount;
    }

    static async deleteCategory(id) {
        // Kiểm tra xem category có subcategories không
        const subCategories = await db.query(
            'SELECT COUNT(*) as count FROM categories WHERE parent_id = $1',
            [id]
        );
        
        if (parseInt(subCategories.rows[0].count) > 0) {
            throw new Error('Cannot delete category with subcategories');
        }
        
        // Kiểm tra xem category có sản phẩm không
        const products = await db.query(
            'SELECT COUNT(*) as count FROM products WHERE category_id = $1',
            [id]
        );
        
        if (parseInt(products.rows[0].count) > 0) {
            throw new Error('Cannot delete category with products');
        }
        
        const result = await db.query('DELETE FROM categories WHERE id = $1 RETURNING id', [id]);
        return result.rowCount;
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
            if (category.parent_id && categoryMap.has(category.parent_id)) {
                categoryMap.get(category.parent_id).children.push(categoryMap.get(category.id));
            } else {
                tree.push(categoryMap.get(category.id));
            }
        });

        return tree;
    }

    // Bulk insert categories
    static async bulkCreateCategories(categories) {
        const client = await db.getClient();
        try {
            await client.query('BEGIN');
            const insertedIds = [];
            
            for (const category of categories) {
                const result = await client.query(
                    'INSERT INTO categories (name, type, parent_id) VALUES ($1, $2, $3) RETURNING id',
                    [category.name, category.type, category.parent_id || null]
                );
                insertedIds.push(result.rows[0].id);
            }
            
            await client.query('COMMIT');
            return insertedIds;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }
}

module.exports = Category;