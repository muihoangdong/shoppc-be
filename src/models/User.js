const db = require('../config/database');
const bcrypt = require('bcryptjs');

class UserModel {
    static baseSelect = 'id, username, email, full_name, avatar, role, status, last_login, created_at, updated_at';

    static async getAllUsers() {
        const [rows] = await db.query(
            `SELECT ${this.baseSelect} FROM users ORDER BY created_at DESC`
        );
        return rows;
    }

    static async getUserById(id) {
        const [rows] = await db.query(
            `SELECT ${this.baseSelect} FROM users WHERE id = ?`,
            [id]
        );
        return rows[0];
    }

    static async getUserAuthById(id) {
        const [rows] = await db.query('SELECT * FROM users WHERE id = ?', [id]);
        return rows[0];
    }

    static async getUserByUsername(username) {
        const [rows] = await db.query('SELECT * FROM users WHERE username = ?', [username]);
        return rows[0];
    }

    static async getUserByEmail(email) {
        const [rows] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
        return rows[0];
    }

    static async createUser(userData) {
        const { username, password, email, full_name, avatar = null, role = 'staff', status = 'active' } = userData;
        const hashedPassword = await bcrypt.hash(password, 10);
        const [result] = await db.query(
            `INSERT INTO users (username, password, email, full_name, avatar, role, status) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [username, hashedPassword, email, full_name, avatar, role, status]
        );
        return result.insertId;
    }

    static async updateUser(id, userData) {
        const allowed = ['full_name', 'email', 'avatar', 'role', 'status'];
        const entries = Object.entries(userData).filter(([key, value]) => allowed.includes(key) && value !== undefined);

        if (entries.length === 0) return 0;

        const setClause = entries.map(([key]) => `${key} = ?`).join(', ');
        const values = entries.map(([, value]) => value === '' ? null : value);
        values.push(id);

        const [result] = await db.query(`UPDATE users SET ${setClause}, updated_at = NOW() WHERE id = ?`, values);
        return result.affectedRows;
    }

    static async updatePassword(id, newPassword) {
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        const [result] = await db.query('UPDATE users SET password = ?, updated_at = NOW() WHERE id = ?', [hashedPassword, id]);
        return result.affectedRows;
    }

    static async deleteUser(id) {
        const [result] = await db.query('DELETE FROM users WHERE id = ?', [id]);
        return result.affectedRows;
    }

    static async updateLastLogin(id) {
        const [result] = await db.query('UPDATE users SET last_login = NOW() WHERE id = ?', [id]);
        return result.affectedRows;
    }

    static async verifyPassword(user, password) {
        return bcrypt.compare(password, user.password);
    }
}

module.exports = UserModel;
