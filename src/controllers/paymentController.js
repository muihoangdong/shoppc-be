'use strict';

const crypto = require('crypto');
const Payments = require('../services/payments');
const BankSettings = require('../services/bankSettings');
const { BANK_BINS, bankList, normalizeAccountName, bankAccount } = require('../config/bank');
const { buildPayload, toDataUrl } = require('../services/vietqr');
const { sendError } = require('../utils/http');
const v = require('../utils/validate');

/** So sánh hằng thời gian (không lộ độ dài khớp qua thời gian phản hồi). */
const safeEqual = (a, b) => {
    const x = crypto.createHash('sha256').update(String(a)).digest();
    const y = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(x, y);
};

class PaymentController {
    /**
     * Webhook SePay: cấu hình trên my.sepay.vn → Webhooks → URL https://<backend>/api/payments/sepay,
     * kiểu xác thực "API Key" với khóa = SEPAY_WEBHOOK_KEY. SePay gửi header "Authorization: Apikey <khóa>".
     */
    static async sepayWebhook(req, res) {
        const key = process.env.SEPAY_WEBHOOK_KEY;
        if (!key) return res.status(404).json({ success: false, message: 'Webhook chưa được bật' });
        const header = String(req.headers.authorization || '');
        const m = header.match(/^Apikey\s+(.+)$/i);
        if (!m || !safeEqual(m[1].trim(), key)) return res.status(401).json({ success: false, message: 'Sai khóa xác thực' });
        try {
            const result = await Payments.handleSepayWebhook(req.body);
            // Luôn trả thành công khi xác thực đúng (kể cả giao dịch không khớp đơn nào) để SePay không gửi lại mãi
            res.json({ success: true, ...result });
        } catch (error) {
            console.error('[payments] Lỗi xử lý webhook SePay:', error.message);
            res.status(500).json({ success: false, message: 'Lỗi xử lý, SePay sẽ gửi lại sau' });
        }
    }
}

/** Thông tin hiển thị ở trang Cài đặt → Thanh toán (kèm mã QR mẫu 10.000₫ để admin quét thử). */
async function settingsView() {
    const raw = await BankSettings.getRawSettings();
    const active = await BankSettings.getBankAccount();
    return {
        bank_code: raw.bank_code || '',
        account_no: raw.bank_account_no || '',
        account_name: raw.bank_account_name || '',
        active: active ? { bank_name: active.bank_name, account_no: active.account_no, account_name: active.account_name, source: active.source } : null,
        env_configured: !!bankAccount(),
        banks: bankList(),
        auto_confirm: !!process.env.SEPAY_WEBHOOK_KEY,
        sample_qr: active ? await toDataUrl(buildPayload({ bin: active.bin, accountNo: active.account_no, amount: 10000, addInfo: 'SHOPPC TEST' })) : null
    };
}

PaymentController.getSettings = async (req, res) => {
    try {
        res.json({ success: true, data: await settingsView() });
    } catch (error) {
        sendError(res, error);
    }
};

/** Lưu tài khoản nhận tiền. Gửi cả 3 ô trống = xóa (quay về dùng tài khoản trong .env, nếu có). */
PaymentController.saveSettings = async (req, res) => {
    try {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const code = v.str(b.bank_code, 'Ngân hàng', { max: 20, optional: true, allowEmpty: true }) || '';
        const no = (v.str(b.account_no, 'Số tài khoản', { max: 30, optional: true, allowEmpty: true }) || '').replace(/\s+/g, '');
        const name = normalizeAccountName(v.str(b.account_name, 'Tên chủ tài khoản', { max: 60, optional: true, allowEmpty: true }) || '');
        const clearing = !code && !no && !name;
        if (!clearing) {
            if (!BANK_BINS[code.toUpperCase()]) v.fail('Vui lòng chọn ngân hàng');
            if (!/^[0-9]{6,19}$/.test(no)) v.fail('Số tài khoản chỉ gồm 6–19 chữ số');
            if (name.length < 3) v.fail('Nhập tên chủ tài khoản (viết hoa không dấu, đúng như trên app ngân hàng)');
        }
        await BankSettings.saveBankSettings({ bank_code: clearing ? null : code.toUpperCase(), bank_account_no: clearing ? null : no, bank_account_name: clearing ? null : name });
        res.json({ success: true, message: clearing ? 'Đã xóa tài khoản nhận tiền' : 'Đã lưu tài khoản nhận tiền', data: await settingsView() });
    } catch (error) {
        if (error && /shop_settings/.test(String(error.message))) {
            return res.status(503).json({ success: false, message: 'Database chưa có bảng shop_settings. Khởi động lại backend (AUTO_MIGRATE=true) hoặc chạy npm run migrate-db -- --apply.' });
        }
        sendError(res, error);
    }
};

module.exports = PaymentController;
