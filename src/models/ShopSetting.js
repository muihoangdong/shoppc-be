const db = require('../config/database');

/** Cài đặt của cửa hàng dạng khóa → giá trị (VD tài khoản nhận chuyển khoản), admin sửa được trên dashboard. */
class ShopSetting {
    static async getMany(keys) {
        if (!keys.length) return {};
        const rows = await db.query(
            `SELECT setting_key, setting_value FROM shop_settings WHERE setting_key IN (${keys.map(() => '?').join(', ')})`,
            keys
        );
        return Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value]));
    }

    /** values: { khóa: giá trị | null } — null thì xóa khóa đó. */
    static async setMany(values) {
        for (const [key, value] of Object.entries(values)) {
            await db.query('DELETE FROM shop_settings WHERE setting_key = ?', [key]);
            if (value !== null && value !== undefined && value !== '') {
                await db.query('INSERT INTO shop_settings (setting_key, setting_value) VALUES (?, ?)', [key, String(value)]);
            }
        }
    }
}

module.exports = ShopSetting;
