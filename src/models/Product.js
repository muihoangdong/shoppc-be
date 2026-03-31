const db = require('../config/database');

class Product {
    // Lấy tất cả sản phẩm với phân loại
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
        return rows;
    }

    // Lấy sản phẩm theo ID
    static async getProductById(id) {
        const [rows] = await db.query(
            `SELECT p.*, c.name as category_name, c.type as category_type 
             FROM products p 
             LEFT JOIN categories c ON p.category_id = c.id 
             WHERE p.id = ?`,
            [id]
        );
        return rows[0];
    }

    // Lấy sản phẩm theo danh mục
    static async getProductsByCategory(categoryId) {
        const [rows] = await db.query(
            'SELECT * FROM products WHERE category_id = ? ORDER BY created_at DESC',
            [categoryId]
        );
        return rows;
    }

    // Lấy sản phẩm theo loại (pc, component)
    static async getProductsByType(type) {
        const [rows] = await db.query(
            `SELECT p.*, c.name as category_name 
             FROM products p 
             LEFT JOIN categories c ON p.category_id = c.id 
             WHERE c.type = ? 
             ORDER BY p.created_at DESC`,
            [type]
        );
        return rows;
    }

    // Tạo sản phẩm mới
    static async createProduct(productData) {
        const { name, description, price, stock, category_id, image_url, specs } = productData;
        const [result] = await db.query(
            `INSERT INTO products (name, description, price, stock, category_id, image_url, specs) 
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [name, description, price, stock, category_id, image_url, JSON.stringify(specs || {})]
        );
        return result.insertId;
    }

    // Cập nhật sản phẩm
    static async updateProduct(id, productData) {
        const { name, description, price, stock, category_id, image_url, specs } = productData;
        const [result] = await db.query(
            `UPDATE products 
             SET name = ?, description = ?, price = ?, stock = ?, 
                 category_id = ?, image_url = ?, specs = ? 
             WHERE id = ?`,
            [name, description, price, stock, category_id, image_url, JSON.stringify(specs || {}), id]
        );
        return result.affectedRows;
    }

    // Cập nhật số lượng tồn kho
    static async updateStock(id, quantity) {
        const [result] = await db.query(
            'UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?',
            [quantity, id, quantity]
        );
        return result.affectedRows;
    }

    // Xóa sản phẩm
    static async deleteProduct(id) {
        const [result] = await db.query('DELETE FROM products WHERE id = ?', [id]);
        return result.affectedRows;
    }
}

module.exports = Product;