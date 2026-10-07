const db = require('../config/database');

class Product {
    static normalizeProduct(row) {
        if (!row) return row;

        // MySQL JSON tự parse thành object, nhưng xử lý thêm cho chắc
        const parse = (v) => {
            if (typeof v !== 'string') return v;
            try {
                return JSON.parse(v);
            } catch {
                return null;
            }
        };

        return {
            ...row,
            specs: parse(row.specs) || {},
            ...(row.build_specs !== undefined ? { build_specs: parse(row.build_specs) || null } : {})
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

    /** Linh kiện cho trang Build PC theo loại (rẻ trước). */
    static async getBuilderParts(partType) {
        const rows = await db.query(
            `SELECT p.id, p.name, p.price, p.stock, p.image_url, p.part_type, p.build_specs, p.specs, c.name AS category_name
             FROM products p
             LEFT JOIN categories c ON p.category_id = c.id
             WHERE p.part_type = ?
             ORDER BY p.price ASC`,
            [partType]
        );
        return rows.map(this.normalizeProduct);
    }

    /** Lấy nhiều linh kiện theo id (để kiểm tra một cấu hình). */
    static async getBuilderPartsByIds(ids) {
        if (!ids.length) return [];
        const rows = await db.query(
            `SELECT p.id, p.name, p.price, p.stock, p.image_url, p.part_type, p.build_specs, p.specs
             FROM products p
             WHERE p.id IN (${ids.map(() => '?').join(', ')})`,
            ids
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
            specs = {},
            part_type = null,
            build_specs = null
        } = productData;

        const [result] = await db.pool.query(
            `INSERT INTO products (
                name, description, price, stock,
                category_id, image_url, specs, part_type, build_specs
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                name,
                description,
                price,
                stock,
                category_id,
                image_url,
                JSON.stringify(specs || {}),
                part_type || null,
                build_specs ? JSON.stringify(build_specs) : null
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
            'specs',
            'part_type',
            'build_specs'
        ];

        const entries = Object.entries(productData)
            .filter(([key, value]) =>
                allowed.includes(key) && value !== undefined
            )
            .map(([key, value]) => {
                if (key === 'specs') return [key, JSON.stringify(value || {})];
                if (key === 'build_specs') return [key, value ? JSON.stringify(value) : null];
                if (key === 'part_type') return [key, value || null];
                return [key, value];
            });

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