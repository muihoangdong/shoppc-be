'use strict';

const db = require('../config/database');

/**
 * Bảng email_otps: mã OTP gửi qua email (hiện dùng cho đăng ký tài khoản mới).
 * Mỗi (email, purpose) chỉ có tối đa 1 dòng; gửi lại mã thì cập nhật dòng đó.
 * Chỉ lưu MÃ ĐÃ BĂM (code_hash), không lưu mã gốc. Thời gian tính bằng giờ của server Node (Date của JS).
 */

const parsePayload = (v) => {
    if (!v) return null;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return null; }
};

class EmailOtp {
    static async find(email, purpose = 'register') {
        const [rows] = await db.pool.query(
            `SELECT id, email, purpose, code_hash, payload, attempts, send_count, send_window_start, last_sent_at, expires_at, created_at
             FROM email_otps WHERE email = ? AND purpose = ? LIMIT 1`,
            [email, purpose]
        );
        const row = rows[0];
        return row ? { ...row, payload: parsePayload(row.payload) } : null;
    }

    static async create({ email, purpose = 'register', code_hash, payload, send_window_start, last_sent_at, expires_at }) {
        const [result] = await db.pool.query(
            `INSERT INTO email_otps (email, purpose, code_hash, payload, attempts, send_count, send_window_start, last_sent_at, expires_at)
             VALUES (?, ?, ?, ?, 0, 1, ?, ?, ?)`,
            [email, purpose, code_hash, JSON.stringify(payload || null), send_window_start, last_sent_at, expires_at]
        );
        return result.insertId;
    }

    /** Mã mới (gửi lần đầu lại hoặc gửi lại): đặt lại số lần nhập sai. */
    static async replaceCode(id, { code_hash, payload, send_count, send_window_start, last_sent_at, expires_at }) {
        await db.pool.query(
            `UPDATE email_otps
             SET code_hash = ?, payload = ?, attempts = 0, send_count = ?, send_window_start = ?, last_sent_at = ?, expires_at = ?
             WHERE id = ?`,
            [code_hash, JSON.stringify(payload || null), send_count, send_window_start, last_sent_at, expires_at, id]
        );
    }

    static async incrementAttempts(id) {
        await db.pool.query('UPDATE email_otps SET attempts = attempts + 1 WHERE id = ?', [id]);
    }

    static async remove(id) {
        await db.pool.query('DELETE FROM email_otps WHERE id = ?', [id]);
    }

    /** Dọn các yêu cầu đăng ký bỏ dở quá lâu. */
    static async purgeOlderThan(date) {
        await db.pool.query('DELETE FROM email_otps WHERE created_at < ?', [date]);
    }
}

module.exports = EmailOtp;
