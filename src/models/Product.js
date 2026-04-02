const db = require('../config/database');

class Product {
    static normalizeProduct(row) {
        if (!row) return row;
        let specs = row.specs;
        if (typeof specs === 'string') {
            try {
                specs = JSON.parse(specs);
            } catch {
                specs = {};
            }
        }
        return { ...row, specs: specs || {} };
    }

    static async getAllProducts(filters = {}) {
        let query = `
            SELECT p.*, c.name as category_name, c.type as category_type
            FROM products p
            LEFT JOIN categories c ON p.category_id = c.id
            WHERE 1=1
        `;
        const values = [];

        if (filters.category_id) {
            query += ' AND p.category_id = ?';
            values.push(filters.category_id);
        }

        if (filters.type) {
            query += ' AND c.type = ?';
            values.push(filters.type);
        }

        if (filters.search) {
            query += ' AND (p.name LIKE ? OR p.description LIKE ?)';
            values.push(`%${filters.search}%`, `%${filters.search}%`);
        }

        query += ' ORDER BY p.created_at DESC';
        const [rows] = await db.query(query, values);
        return rows.map(this.normalizeProduct);
    }

    static async getProductById(id) {
        const [rows] = await db.query(
            `SELECT p.*, c.name as category_name, c.type as category_type
             FROM products p
             LEFT JOIN categories c ON p.category_id = c.id
             WHERE p.id = ?`,
            [id]
        );
        return this.normalizeProduct(rows[0]);
    }

    static async getProductsByCategory(categoryId) {
        const [rows] = await db.query(
            `SELECT p.*, c.name as category_name, c.type as category_type
             FROM products p LEFT JOIN categories c ON p.category_id = c.id
             WHERE p.category_id = ? ORDER BY p.created_at DESC`,
            [categoryId]
        );
        return rows.map(this.normalizeProduct);
    }

    static async getProductsByType(type) {
        const [rows] = await db.query(
            `SELECT p.*, c.name as category_name, c.type as category_type
             FROM products p
             LEFT JOIN categories c ON p.category_id = c.id
             WHERE c.type = ?
             ORDER BY p.created_at DESC`,
            [type]
        );
        return rows.map(this.normalizeProduct);
    }

    static async createProduct(productData) {
        const { name, description = null, price, stock = 0, category_id, image_url = null, specs = {} } = productData;
        const [result] = await db.query(
            `INSERT INTO products (name, description, price, stock, category_id, image_url, specs)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [name, description, price, stock, category_id, image_url, JSON.stringify(specs || {})]
        );
        return result.insertId;
    }

    static async updateProduct(id, productData) {
        const allowed = ['name', 'description', 'price', 'stock', 'category_id', 'image_url', 'specs'];
        const entries = Object.entries(productData)
            .filter(([key, value]) => allowed.includes(key) && value !== undefined)
            .map(([key, value]) => [key, key === 'specs' ? JSON.stringify(value || {}) : value]);

        if (entries.length === 0) return 0;
        const setClause = entries.map(([key]) => `${key} = ?`).join(', ');
        const values = entries.map(([, value]) => value);
        values.push(id);
        const [result] = await db.query(`UPDATE products SET ${setClause}, updated_at = NOW() WHERE id = ?`, values);
        return result.affectedRows;
    }

    static async setStock(id, stock) {
        const [result] = await db.query('UPDATE products SET stock = ?, updated_at = NOW() WHERE id = ?', [stock, id]);
        return result.affectedRows;
    }

    static async updateStock(id, quantity, connection = db) {
        const [result] = await connection.query(
            'UPDATE products SET stock = stock - ?, updated_at = NOW() WHERE id = ? AND stock >= ?',
            [quantity, id, quantity]
        );
        return result.affectedRows;
    }

    static async deleteProduct(id) {
        const [result] = await db.query('DELETE FROM products WHERE id = ?', [id]);
        return result.affectedRows;
    }
}

module.exports = Product;
