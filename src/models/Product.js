const db = require('../config/database');

class Product {
    static normalizeProduct(row) {
        if (!row) return row;
        let specs = row.specs;
        // PostgreSQL JSONB tự động parse thành object
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
        let paramCount = 1;

        if (filters.category_id) {
            query += ` AND p.category_id = $${paramCount++}`;
            values.push(filters.category_id);
        }

        if (filters.type) {
            query += ` AND c.type = $${paramCount++}`;
            values.push(filters.type);
        }

        if (filters.search) {
            query += ` AND (p.name ILIKE $${paramCount++} OR p.description ILIKE $${paramCount++})`;
            values.push(`%${filters.search}%`, `%${filters.search}%`);
        }

        if (filters.min_price) {
            query += ` AND p.price >= $${paramCount++}`;
            values.push(filters.min_price);
        }

        if (filters.max_price) {
            query += ` AND p.price <= $${paramCount++}`;
            values.push(filters.max_price);
        }

        if (filters.in_stock === true) {
            query += ` AND p.stock > 0`;
        }

        // Pagination
        if (filters.limit) {
            query += ` LIMIT $${paramCount++}`;
            values.push(filters.limit);
        }
        
        if (filters.offset) {
            query += ` OFFSET $${paramCount++}`;
            values.push(filters.offset);
        }

        query += ' ORDER BY p.created_at DESC';
        
        const result = await db.query(query, values);
        return result.rows.map(this.normalizeProduct);
    }

    static async getProductById(id) {
        const result = await db.query(
            `SELECT p.*, c.name as category_name, c.type as category_type
             FROM products p
             LEFT JOIN categories c ON p.category_id = c.id
             WHERE p.id = $1`,
            [id]
        );
        return this.normalizeProduct(result.rows[0]);
    }

    static async getProductsByCategory(categoryId) {
        const result = await db.query(
            `SELECT p.*, c.name as category_name, c.type as category_type
             FROM products p 
             LEFT JOIN categories c ON p.category_id = c.id
             WHERE p.category_id = $1 
             ORDER BY p.created_at DESC`,
            [categoryId]
        );
        return result.rows.map(this.normalizeProduct);
    }

    static async getProductsByType(type) {
        const result = await db.query(
            `SELECT p.*, c.name as category_name, c.type as category_type
             FROM products p
             LEFT JOIN categories c ON p.category_id = c.id
             WHERE c.type = $1
             ORDER BY p.created_at DESC`,
            [type]
        );
        return result.rows.map(this.normalizeProduct);
    }

    static async getFeaturedProducts(limit = 8) {
        const result = await db.query(
            `SELECT p.*, c.name as category_name
             FROM products p
             LEFT JOIN categories c ON p.category_id = c.id
             WHERE p.stock > 0
             ORDER BY p.created_at DESC
             LIMIT $1`,
            [limit]
        );
        return result.rows.map(this.normalizeProduct);
    }

    static async getRelatedProducts(productId, categoryId, limit = 4) {
        const result = await db.query(
            `SELECT p.*, c.name as category_name
             FROM products p
             LEFT JOIN categories c ON p.category_id = c.id
             WHERE p.category_id = $1 AND p.id != $2 AND p.stock > 0
             ORDER BY p.created_at DESC
             LIMIT $3`,
            [categoryId, productId, limit]
        );
        return result.rows.map(this.normalizeProduct);
    }

    static async createProduct(productData) {
        const { name, description = null, price, stock = 0, category_id, image_url = null, specs = {} } = productData;
        const result = await db.query(
            `INSERT INTO products (name, description, price, stock, category_id, image_url, specs)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id`,
            [name, description, price, stock, category_id, image_url, JSON.stringify(specs || {})]
        );
        return result.rows[0].id;
    }

    static async updateProduct(id, productData) {
        const allowed = ['name', 'description', 'price', 'stock', 'category_id', 'image_url', 'specs'];
        const entries = Object.entries(productData)
            .filter(([key, value]) => allowed.includes(key) && value !== undefined)
            .map(([key, value]) => [key, key === 'specs' ? JSON.stringify(value || {}) : value]);

        if (entries.length === 0) return 0;

        const setClause = entries.map(([key], index) => `${key} = $${index + 1}`).join(', ');
        const values = entries.map(([, value]) => value);
        values.push(id);
        
        const result = await db.query(
            `UPDATE products SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = $${values.length} RETURNING id`,
            values
        );
        return result.rowCount;
    }

    static async setStock(id, stock) {
        const result = await db.query(
            'UPDATE products SET stock = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id',
            [stock, id]
        );
        return result.rowCount;
    }

    static async updateStock(id, quantity, connection = db) {
        const result = await connection.query(
            'UPDATE products SET stock = stock - $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND stock >= $3 RETURNING id',
            [quantity, id, quantity]
        );
        return result.rowCount;
    }

    static async deleteProduct(id) {
        const result = await db.query('DELETE FROM products WHERE id = $1 RETURNING id', [id]);
        return result.rowCount;
    }

    static async countProducts(filters = {}) {
        let query = 'SELECT COUNT(*) as count FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE 1=1';
        const values = [];
        let paramCount = 1;

        if (filters.category_id) {
            query += ` AND p.category_id = $${paramCount++}`;
            values.push(filters.category_id);
        }

        if (filters.type) {
            query += ` AND c.type = $${paramCount++}`;
            values.push(filters.type);
        }

        if (filters.search) {
            query += ` AND (p.name ILIKE $${paramCount++} OR p.description ILIKE $${paramCount++})`;
            values.push(`%${filters.search}%`, `%${filters.search}%`);
        }

        const result = await db.query(query, values);
        return parseInt(result.rows[0].count);
    }

    // Tìm kiếm nâng cao với JSONB specs
    static async searchBySpecs(specsFilter) {
        let query = `
            SELECT p.*, c.name as category_name
            FROM products p
            LEFT JOIN categories c ON p.category_id = c.id
            WHERE 1=1
        `;
        const values = [];
        let paramCount = 1;

        for (const [key, value] of Object.entries(specsFilter)) {
            query += ` AND p.specs->>'${key}' = $${paramCount++}`;
            values.push(value);
        }

        const result = await db.query(query, values);
        return result.rows.map(this.normalizeProduct);
    }
}

module.exports = Product;