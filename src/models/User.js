const db = require('../config/database');
const bcrypt = require('bcryptjs');
const { DEFAULT_ROLE } = require('../config/roles');

class UserModel {
    static baseSelect =
        'id, username, email, full_name, avatar, role, status, last_login, created_at, updated_at';

    static async getAllUsers() {
        const rows = await db.query(
            `SELECT ${this.baseSelect}
             FROM users
             ORDER BY created_at DESC`
        );

        return rows;
    }

    static async getUserById(id) {
        const rows = await db.query(
            `SELECT ${this.baseSelect}
             FROM users
             WHERE id = ?`,
            [id]
        );

        return rows[0];
    }

    static async getUserAuthById(id) {
        const rows = await db.query(
            'SELECT * FROM users WHERE id = ?',
            [id]
        );

        return rows[0];
    }

    static async getUserByUsername(username) {
        const rows = await db.query(
            'SELECT * FROM users WHERE username = ?',
            [username]
        );

        return rows[0];
    }

    static async getUserByEmail(email) {
        const rows = await db.query(
            'SELECT * FROM users WHERE email = ?',
            [email]
        );

        return rows[0];
    }

    static async createUser(userData) {
        const {
            username,
            password,
            email,
            full_name,
            avatar = null,
            role = DEFAULT_ROLE,
            status = 'active'
        } = userData;

        const hashedPassword = await bcrypt.hash(password, 10);

        const [result] = await db.pool.query(
            `INSERT INTO users (
                username, password, email, full_name,
                avatar, role, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                username,
                hashedPassword,
                email,
                full_name,
                avatar,
                role,
                status
            ]
        );

        return result.insertId;
    }

    static async updateUser(id, userData) {
        const allowed = [
            'full_name',
            'email',
            'avatar',
            'role',
            'status'
        ];

        const entries = Object.entries(userData)
            .filter(([key, value]) =>
                allowed.includes(key) && value !== undefined
            );

        if (entries.length === 0) return 0;

        const setClause = entries
            .map(([key]) => `${key} = ?`)
            .join(', ');

        const values = entries.map(([, value]) =>
            value === '' ? null : value
        );

        values.push(id);

        const [result] = await db.pool.query(
            `UPDATE users
             SET ${setClause},
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            values
        );

        return result.affectedRows;
    }

    static async updatePassword(id, newPassword) {
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        const [result] = await db.pool.query(
            `UPDATE users
             SET password = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [hashedPassword, id]
        );

        return result.affectedRows;
    }

    static async deleteUser(id) {
        const [result] = await db.pool.query(
            'DELETE FROM users WHERE id = ?',
            [id]
        );

        return result.affectedRows;
    }

    static async updateLastLogin(id) {
        const [result] = await db.pool.query(
            `UPDATE users
             SET last_login = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [id]
        );

        return result.affectedRows;
    }

    static async verifyPassword(user, password) {
        return bcrypt.compare(password, user.password);
    }

    // Lấy users theo role
    static async getUsersByRole(role) {
        const rows = await db.query(
            `SELECT ${this.baseSelect}
             FROM users
             WHERE role = ?
             ORDER BY created_at DESC`,
            [role]
        );

        return rows;
    }

    // Đếm số lượng user theo role
    static async countUsersByRole() {
        const rows = await db.query(
            `SELECT role, COUNT(*) AS count
             FROM users
             GROUP BY role`
        );

        return rows;
    }

    // Tìm kiếm user
    static async searchUsers(keyword) {
        const rows = await db.query(
            `SELECT ${this.baseSelect}
             FROM users
             WHERE username LIKE ?
                OR email LIKE ?
                OR full_name LIKE ?
             ORDER BY created_at DESC`,
            [
                `%${keyword}%`,
                `%${keyword}%`,
                `%${keyword}%`
            ]
        );

        return rows;
    }

    // Cập nhật profile (không thay đổi role và status)
    static async updateProfile(id, profileData) {
        const allowed = ['full_name', 'email', 'avatar'];

        const entries = Object.entries(profileData)
            .filter(([key, value]) =>
                allowed.includes(key) && value !== undefined
            );

        if (entries.length === 0) return 0;

        const setClause = entries
            .map(([key]) => `${key} = ?`)
            .join(', ');

        const values = entries.map(([, value]) =>
            value === '' ? null : value
        );

        values.push(id);

        const [result] = await db.pool.query(
            `UPDATE users
             SET ${setClause},
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            values
        );

        return result.affectedRows;
    }

    // Lấy user với phân trang
    static async getUsersPaginated(limit = 10, offset = 0, filters = {}) {
        let sql = `SELECT ${this.baseSelect} FROM users WHERE 1=1`;

        const values = [];

        if (filters.role) {
            sql += ' AND role = ?';
            values.push(filters.role);
        }

        if (filters.status) {
            sql += ' AND status = ?';
            values.push(filters.status);
        }

        sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';

        values.push(Number(limit), Number(offset));

        const rows = await db.query(sql, values);

        return rows;
    }

    // Đếm tổng số user
    static async countUsers(filters = {}) {
        let sql = 'SELECT COUNT(*) AS count FROM users WHERE 1=1';

        const values = [];

        if (filters.role) {
            sql += ' AND role = ?';
            values.push(filters.role);
        }

        if (filters.status) {
            sql += ' AND status = ?';
            values.push(filters.status);
        }

        const rows = await db.query(sql, values);

        return parseInt(rows[0].count);
    }
}

module.exports = UserModel;