'use strict';

const crypto = require('crypto');
const Payments = require('../services/payments');

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

module.exports = PaymentController;
