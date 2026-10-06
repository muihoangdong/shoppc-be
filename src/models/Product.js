const db = require('../config/database');

class Product {
    static normalizeProduct(row) {
        if (!row) return row;

        let specs = row.specs;

        // MySQL JSON tự parse thành object, nhưng xử lý thêm cho chắc
        if (typeof specs === 'string') {
            try {
                specs = JSON.parse(specs);
            } catch {
                specs = {};
            }
        }

        return {
            ...row,
            specs: specs || {}
        };
    }

    static async getAllProducts(filters = {}) {
        let sql = `
            SELECT p.*, c.name AS category_name, c.type AS category_type
            FROM products p
            LEFT JOIN categories c ON p.category_id = c.id
            WHERE 1=1
        `;

        const values = [];

        if (filters.category_id) {
            sql += ' AND p.category_id = ?';
            values.push(filters.category_id);
        }

        if (filters.type) {
            sql += ' AND c.type = ?';
            values.push(filters.type);
        }

        if (filters.search) {
            sql += ' AND (p.name LIKE ? OR p.description LIKE ?)';
            values.push(`%${filters.search}%`, `%${filters.search}%`);
        }

        if (filters.min_price) {
            sql += ' AND p.price >= ?';
            values.push(filters.min_price);
        }

        if (filters.max_price) {
            sql += ' AND p.price <= ?';
            values.push(filters.max_price);
        }

        if (filters.in_stock === true) {
            sql += ' AND p.stock > 0';
        }

        sql += ' ORDER BY p.created_at DESC';

        if (filters.limit) {
            sql += ' LIMIT ?';
            values.push(Number(filters.limit));
        }

        if (filters.offset) {
            sql += ' OFFSET ?';
            values.push(Number(filters.offset));
        }

        const rows = await db.query(sql, values);

        return rows.map(this.normalizeProduct);
    }

    static async getProductById(id) {
        const rows = await db.query(
            `SELECT p.*, c.name AS category_name, c.type AS category_type
             FROM products p
             LEFT JOIN categories c ON p.category_id = c.id
             WHERE p.id = ?`,
            [id]
        );

        return this.normalizeProduct(rows[0]);
    }

    static async getProductsByCategory(categoryId) {
        const rows = await db.query(
            `SELECT p.*, c.name AS category_name, c.type AS category_type
             FROM products p
             LEFT JOIN categories c ON p.category_id = c.id
             WHERE p.category_id = ?
             ORDER BY p.created_at DESC`,
            [categoryId]
        );

        return rows.map(this.normalizeProduct);
    }

    static async getProductsByType(type) {
        const rows = await db.query(
            `SELECT p.*, c.name AS category_name, c.type AS category_type
             FROM products p
             LEFT JOIN categories c ON p.category_id = c.id
             WHERE c.type = ?
             ORDER BY p.created_at DESC`,
            [type]
        );

        return rows.map(this.normalizeProduct);
    }

    static async getFeaturedProducts(limit = 8) {
        const rows = await db.query(
            `SELECT p.*, c.name AS category_name
             FROM products p
             LEFT JOIN categories c ON p.category_id = c.id
             WHERE p.stock > 0
             ORDER BY p.created_at DESC
             LIMIT ?`,
            [Number(limit)]
        );

        return rows.map(this.normalizeProduct);
    }

    static async getRelatedProducts(productId, categoryId, limit = 4) {
        const rows = await db.query(
            `SELECT p.*, c.name AS category_name
             FROM products p
             LEFT JOIN categories c ON p.category_id = c.id
             WHERE p.category_id = ? AND p.id != ? AND p.stock > 0
             ORDER BY p.created_at DESC
             LIMIT ?`,
            [categoryId, productId, Number(limit)]
        );

        return rows.map(this.normalizeProduct);
    }

    static async createProduct(productData) {
        const {
            name,
            description = null,
            price,
            stock = 0,
            category_id,
            image_url = null,
            specs = {}
        } = productData;

        const [result] = await db.pool.query(
            `INSERT INTO products (
                name, description, price, stock,
                category_id, image_url, specs
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                name,
                description,
                price,
                stock,
                category_id,
                image_url,
                JSON.stringify(specs || {})
            ]
        );

        return result.insertId;
    }

    static async updateProduct(id, productData) {
        const allowed = [
            'name',
            'description',
            'price',
            'stock',
            'category_id',
            'image_url',
            'specs'
        ];

        const entries = Object.entries(productData)
            .filter(([key, value]) =>
                allowed.includes(key) && value !== undefined
            )
            .map(([key, value]) => [
                key,
                key === 'specs'
                    ? JSON.stringify(value || {})
                    : value
            ]);

        if (entries.length === 0) return 0;

        const setClause = entries
            .map(([key]) => `${key} = ?`)
            .join(', ');

        const values = entries.map(([, value]) => value);

        values.push(id);

        const [result] = await db.pool.query(
            `UPDATE products
             SET ${setClause},
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            values
        );

        return result.affectedRows;
    }

    static async setStock(id, stock) {
        const [result] = await db.pool.query(
            `UPDATE products
             SET stock = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [stock, id]
        );

        return result.affectedRows;
    }

    static async updateStock(id, quantity, connection = db.pool) {
        const [result] = await connection.query(
            `UPDATE products
             SET stock = stock - ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND stock >= ?`,
            [quantity, id, quantity]
        );

        return result.affectedRows;
    }

    static async deleteProduct(id) {
        const [result] = await db.pool.query(
            'DELETE FROM products WHERE id = ?',
            [id]
        );

        return result.affectedRows;
    }

    static async countProducts(filters = {}) {
        let sql = `
            SELECT COUNT(*) AS count
            FROM products p
            LEFT JOIN categories c ON p.category_id = c.id
            WHERE 1=1
        `;

        const values = [];

        if (filters.category_id) {
            sql += ' AND p.category_id = ?';
            values.push(filters.category_id);
        }

        if (filters.type) {
            sql += ' AND c.type = ?';
            values.push(filters.type);
        }

        if (filters.search) {
            sql += ' AND (p.name LIKE ? OR p.description LIKE ?)';
            values.push(`%${filters.search}%`, `%${filters.search}%`);
        }

        const rows = await db.query(sql, values);

        return parseInt(rows[0].count);
    }

    // Tìm kiếm theo specs JSON
    static async searchBySpecs(specsFilter) {
        let sql = `
            SELECT p.*, c.name AS category_name
            FROM products p
            LEFT JOIN categories c ON p.category_id = c.id
            WHERE 1=1
        `;

        const values = [];

        for (const [key, value] of Object.entries(specsFilter)) {
            sql += ` AND JSON_EXTRACT(p.specs, '$.${key}') = ?`;
            values.push(value);
        }

        const rows = await db.query(sql, values);

        return rows.map(this.normalizeProduct);
    }
}

module.exports = Product;