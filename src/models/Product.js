const db = require('../config/database');
const ledger = require('../services/operationsLedger');

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
            image_urls: Array.isArray(parse(row.image_urls)) ? parse(row.image_urls) : [],
            ...(row.build_specs !== undefined ? { build_specs: parse(row.build_specs) || null } : {}),
            ...(row.model_3d !== undefined ? { model_3d: parse(row.model_3d) || null } : {})
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

    static async createProduct(productData, actor = null) {
        const {
            name,
            description = null,
            price,
            stock = 0,
            category_id,
            image_url = null,
            specs = {},
            part_type = null,
            build_specs = null,
            original_price = null,
            model_3d = null,
            image_urls = [],
            sku = null, brand_id = null, spec_template_id = null, warranty_months = 12, serial_required = false
        } = productData;

        if (ledger.isReady()) {
            await require('../services/operationsCatalog').validateProductMetadata(db.pool, productData);
            if (serial_required && Number(stock) > 0) require('../services/operationsCommon').fail('Hàng theo serial phải tạo với tồn 0, sau đó nhập kho kèm serial');
        }

        const client = ledger.isReady() ? await db.getClient() : db.pool;
        try {
        if (ledger.isReady()) await client.beginTransaction();
        const [result] = await client.query(
            `INSERT INTO products (
                name, description, price, stock,
                category_id, image_url, specs, part_type, build_specs,
                original_price, model_3d, image_urls, sku, brand_id, spec_template_id, warranty_months, serial_required
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                name,
                description,
                price,
                stock,
                category_id,
                image_url,
                JSON.stringify(specs || {}),
                part_type || null,
                build_specs ? JSON.stringify(build_specs) : null,
                original_price || null,
                model_3d ? JSON.stringify(model_3d) : null,
                JSON.stringify(image_urls), sku, brand_id, spec_template_id, warranty_months, serial_required
            ]
        );

        if (ledger.isReady()) {
            await ledger.movement(client, result.insertId, Number(stock), 'opening', 'product', result.insertId, actor?.id, 'Tồn ban đầu khi tạo sản phẩm');
            await ledger.audit(client, actor, 'product.create', 'product', result.insertId, `Tạo sản phẩm ${name}`, { sku, name, price, stock, category_id, brand_id, warranty_months, serial_required });
            await client.commit();
        }
        return result.insertId;
        } catch (err) {
            if (ledger.isReady()) await client.rollback();
            if (err.code === 'ER_DUP_ENTRY') require('../services/operationsCommon').fail('SKU đã được sử dụng', 409);
            throw err;
        } finally { if (ledger.isReady()) client.release(); }
    }

    static async updateProduct(id, productData, actor = null) {
        const allowed = [
            'name',
            'description',
            'price',
            'stock',
            'category_id',
            'image_url',
            'specs',
            'part_type',
            'build_specs',
            'original_price',
            'model_3d',
            'image_urls', 'sku', 'brand_id', 'spec_template_id', 'warranty_months', 'serial_required'
        ];

        const entries = Object.entries(productData)
            .filter(([key, value]) =>
                allowed.includes(key) && value !== undefined
            )
            .map(([key, value]) => {
                if (key === 'specs') return [key, JSON.stringify(value || {})];
                if (key === 'build_specs') return [key, value ? JSON.stringify(value) : null];
                if (key === 'part_type') return [key, value || null];
                if (key === 'model_3d') return [key, value ? JSON.stringify(value) : null];
                if (key === 'image_urls') return [key, JSON.stringify(value || [])];
                if (key === 'original_price') return [key, value || null];
                return [key, value];
            });

        if (entries.length === 0) return 0;

        if (ledger.isReady()) {
            const client = await db.getClient();
            try {
                await client.beginTransaction();
                const [rows] = await client.query('SELECT * FROM products WHERE id = ? FOR UPDATE', [id]);
                if (!rows[0]) { await client.rollback(); return 0; }
                const before = rows[0];
                const merged = { ...before, ...productData };
                await require('../services/operationsCatalog').validateProductMetadata(client, merged);
                const delta = productData.stock === undefined ? 0 : Number(productData.stock) - Number(before.stock);
                if (delta && (Number(before.serial_required) || Number(merged.serial_required))) require('../services/operationsCommon').fail('Hàng theo serial: dùng phiếu nhập hoặc thu hồi serial để thay đổi tồn');
                if (delta) {
                    const [count] = await client.query('SELECT COUNT(*) AS total FROM product_serials WHERE product_id = ?', [id]);
                    if (Number(count[0].total)) require('../services/operationsCommon').fail('Sản phẩm đã có serial: dùng phiếu nhập hoặc thu hồi serial');
                }
                if (productData.serial_required !== undefined && Number(before.serial_required) !== Number(productData.serial_required)) {
                    const [count] = await client.query('SELECT COUNT(*) AS total FROM product_serials WHERE product_id = ?', [id]);
                    if (Number(count[0].total)) require('../services/operationsCommon').fail('Không đổi chế độ serial của sản phẩm đã có serial');
                }
                const [result] = await client.query(`UPDATE products SET ${entries.map(([key]) => `${key} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [...entries.map(([, value]) => value), id]);
                if (delta) await ledger.movement(client, id, delta, 'adjustment', 'product', id, actor?.id, 'Điều chỉnh tồn khi sửa sản phẩm');
                await ledger.audit(client, actor, 'product.update', 'product', id, `Cập nhật ${merged.name}`, {
                    before: Object.fromEntries(Object.keys(productData).map((k) => [k, before[k]])), after: productData
                });
                await client.commit();
                return result.affectedRows;
            } catch (err) { await client.rollback(); if (err.code === 'ER_DUP_ENTRY') require('../services/operationsCommon').fail('SKU đã được sử dụng', 409); throw err; }
            finally { client.release(); }
        }

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

    static async setStock(id, stock, actor = null) {
        if (ledger.isReady()) { await require('../services/operationsInventory').adjustStock(id, stock, actor, 'Điều chỉnh tồn kho từ quản trị'); return 1; }
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
