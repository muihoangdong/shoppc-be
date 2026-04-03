const db = require('../config/database');
const bcrypt = require('bcryptjs');

class UserModel {
    static baseSelect = 'id, username, email, full_name, avatar, role, status, last_login, created_at, updated_at';

    static async getAllUsers() {
        const result = await db.query(
            `SELECT ${this.baseSelect} FROM users ORDER BY created_at DESC`
        );
        return result.rows;
    }

    static async getUserById(id) {
        const result = await db.query(
            `SELECT ${this.baseSelect} FROM users WHERE id = $1`,
            [id]
        );
        return result.rows[0];
    }

    static async getUserAuthById(id) {
        const result = await db.query('SELECT * FROM users WHERE id = $1', [id]);
        return result.rows[0];
    }

    static async getUserByUsername(username) {
        const result = await db.query('SELECT * FROM users WHERE username = $1', [username]);
        return result.rows[0];
    }

    static async getUserByEmail(email) {
        const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
        return result.rows[0];
    }

    static async createUser(userData) {
        const { username, password, email, full_name, avatar = null, role = 'staff', status = 'active' } = userData;
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await db.query(
            `INSERT INTO users (username, password, email, full_name, avatar, role, status) 
             VALUES ($1, $2, $3, $4, $5, $6, $7) 
             RETURNING id`,
            [username, hashedPassword, email, full_name, avatar, role, status]
        );
        return result.rows[0].id;
    }

    static async updateUser(id, userData) {
        const allowed = ['full_name', 'email', 'avatar', 'role', 'status'];
        const entries = Object.entries(userData).filter(([key, value]) => allowed.includes(key) && value !== undefined);

        if (entries.length === 0) return 0;

        const setClause = entries.map(([key], index) => `${key} = $${index + 1}`).join(', ');
        const values = entries.map(([, value]) => value === '' ? null : value);
        values.push(id);

        const result = await db.query(
            `UPDATE users SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = $${values.length} RETURNING id`,
            values
        );
        return result.rowCount;
    }

    static async updatePassword(id, newPassword) {
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        const result = await db.query(
            'UPDATE users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id',
            [hashedPassword, id]
        );
        return result.rowCount;
    }

    static async deleteUser(id) {
        const result = await db.query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);
        return result.rowCount;
    }

    static async updateLastLogin(id) {
        const result = await db.query(
            'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1 RETURNING id',
            [id]
        );
        return result.rowCount;
    }

    static async verifyPassword(user, password) {
        return bcrypt.compare(password, user.password);
    }

    // Lấy users theo role
    static async getUsersByRole(role) {
        const result = await db.query(
            `SELECT ${this.baseSelect} FROM users WHERE role = $1 ORDER BY created_at DESC`,
            [role]
        );
        return result.rows;
    }

    // Đếm số lượng user theo role
    static async countUsersByRole() {
        const result = await db.query(
            `SELECT role, COUNT(*) as count FROM users GROUP BY role`
        );
        return result.rows;
    }

    // Tìm kiếm user
    static async searchUsers(keyword) {
        const result = await db.query(
            `SELECT ${this.baseSelect} FROM users 
             WHERE username ILIKE $1 
                OR email ILIKE $1 
                OR full_name ILIKE $1
             ORDER BY created_at DESC`,
            [`%${keyword}%`]
        );
        return result.rows;
    }

    // Cập nhật profile (không thay đổi role và status)
    static async updateProfile(id, profileData) {
        const allowed = ['full_name', 'email', 'avatar'];
        const entries = Object.entries(profileData).filter(([key, value]) => allowed.includes(key) && value !== undefined);

        if (entries.length === 0) return 0;

        const setClause = entries.map(([key], index) => `${key} = $${index + 1}`).join(', ');
        const values = entries.map(([, value]) => value === '' ? null : value);
        values.push(id);

        const result = await db.query(
            `UPDATE users SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = $${values.length} RETURNING id`,
            values
        );
        return result.rowCount;
    }

    // Lấy user với phân trang
    static async getUsersPaginated(limit = 10, offset = 0, filters = {}) {
        let query = `SELECT ${this.baseSelect} FROM users WHERE 1=1`;
        const values = [];
        let paramCount = 1;

        if (filters.role) {
            query += ` AND role = $${paramCount++}`;
            values.push(filters.role);
        }

        if (filters.status) {
            query += ` AND status = $${paramCount++}`;
            values.push(filters.status);
        }

        query += ` ORDER BY created_at DESC LIMIT $${paramCount++} OFFSET $${paramCount++}`;
        values.push(limit, offset);

        const result = await db.query(query, values);
        return result.rows;
    }

    // Đếm tổng số user
    static async countUsers(filters = {}) {
        let query = 'SELECT COUNT(*) as count FROM users WHERE 1=1';
        const values = [];
        let paramCount = 1;

        if (filters.role) {
            query += ` AND role = $${paramCount++}`;
            values.push(filters.role);
        }

        if (filters.status) {
            query += ` AND status = $${paramCount++}`;
            values.push(filters.status);
        }

        const result = await db.query(query, values);
        return parseInt(result.rows[0].count);
    }
}

module.exports = UserModel;