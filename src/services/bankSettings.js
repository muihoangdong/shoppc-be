'use strict';

/**
 * Tài khoản nhận chuyển khoản đang dùng: admin nhập ở trang Cài đặt → Thanh toán (lưu bảng shop_settings),
 * chưa nhập thì lấy từ .env (BANK_CODE, BANK_ACCOUNT_NO, BANK_ACCOUNT_NAME). Đọc database có bộ nhớ đệm ngắn.
 */

const ShopSetting = require('../models/ShopSetting');
const { bankAccount, resolveBank } = require('../config/bank');

const KEYS = ['bank_code', 'bank_account_no', 'bank_account_name'];
const CACHE_MS = 30 * 1000;
let cache = null; // { at, value: { raw, account } }

async function loadFromDb() {
    try {
        const raw = await ShopSetting.getMany(KEYS);
        return { raw, account: resolveBank({ code: raw.bank_code, accountNo: raw.bank_account_no, accountName: raw.bank_account_name }) };
    } catch (error) {
        // Database chưa có bảng shop_settings (chưa nâng cấp): chỉ dùng .env
        if (!/shop_settings/.test(String(error && error.message))) console.warn('[payments] Không đọc được cài đặt ngân hàng:', error.message);
        return { raw: {}, account: null };
    }
}

async function current() {
    if (!cache || Date.now() - cache.at > CACHE_MS) cache = { at: Date.now(), value: await loadFromDb() };
    return cache.value;
}

/** Tài khoản đang dùng + nguồn ('settings' | 'env' | null). */
async function getBankAccount() {
    const { account } = await current();
    if (account) return { ...account, source: 'settings' };
    const env = bankAccount();
    return env ? { ...env, source: 'env' } : null;
}

async function getRawSettings() {
    return (await current()).raw;
}

async function saveBankSettings({ bank_code, bank_account_no, bank_account_name }) {
    await ShopSetting.setMany({ bank_code, bank_account_no, bank_account_name });
    cache = null;
}

const _clearCache = () => { cache = null; };

module.exports = { KEYS, getBankAccount, getRawSettings, saveBankSettings, _clearCache };
