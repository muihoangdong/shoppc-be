'use strict';

/**
 * Thanh toán chuyển khoản bằng VietQR + tự xác nhận qua webhook SePay (https://sepay.vn).
 *
 *  - paymentInfo(order): thông tin hiển thị cho khách (số tiền, tài khoản, nội dung chuyển khoản, ảnh QR).
 *  - handleSepayWebhook(body): SePay gọi mỗi khi tài khoản nhận tiền. Tìm mã đơn trong nội dung chuyển khoản,
 *    đối chiếu số tiền + số tài khoản rồi đánh dấu đơn "Đã thanh toán". Mỗi giao dịch SePay chỉ được tính một lần
 *    (lưu "sepay:<id giao dịch>" vào orders.payment_id).
 */

const Order = require('../models/Order');
const Events = require('../realtime/events');
const { bankAccount } = require('../config/bank');
const { buildPayload, toDataUrl } = require('./vietqr');

/** Nội dung chuyển khoản = mã đơn bỏ dấu gạch (ngân hàng hay tự bỏ ký tự đặc biệt): ORD-1791176872988 -> ORD1791176872988 */
const transferContent = (orderCode) => String(orderCode || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();

/** Tìm mã đơn trong nội dung chuyển khoản (chấp nhận có/không có dấu gạch, chữ hoa/thường, chữ khác xung quanh). */
function findOrderCode(text) {
    const m = String(text || '').match(/ORD-?\s?(\d{10,16})/i);
    return m ? `ORD-${m[1]}` : null;
}

async function paymentInfo(order) {
    const bank = bankAccount();
    const amount = Math.round(Number(order.total_amount) || 0);
    const content = transferContent(order.order_code);
    const showQr = order.payment_method === 'banking' && order.payment_status !== 'paid' && order.status !== 'cancelled' && !!bank;
    return {
        order_code: order.order_code,
        total_amount: amount,
        payment_method: order.payment_method,
        payment_status: order.payment_status,
        status: order.status,
        transfer_content: content,
        bank: order.payment_method === 'banking' && bank
            ? { bank_name: bank.bank_name, account_no: bank.account_no, account_name: bank.account_name }
            : null,
        qr_data_url: showQr
            ? await toDataUrl(buildPayload({ bin: bank.bin, accountNo: bank.account_no, amount, addInfo: content }))
            : null,
        auto_confirm: !!process.env.SEPAY_WEBHOOK_KEY
    };
}

/**
 * @returns {Promise<{ matched: boolean, reason: string, order_code?: string }>}
 */
async function handleSepayWebhook(body, by = { id: null, name: 'SePay (tự động)' }) {
    const b = body && typeof body === 'object' ? body : {};
    if (b.transferType !== 'in') return { matched: false, reason: 'not_incoming' };

    const bank = bankAccount();
    if (bank && b.accountNumber && String(b.accountNumber).replace(/\s+/g, '') !== bank.account_no) {
        return { matched: false, reason: 'other_account' };
    }

    const code = findOrderCode(`${b.code || ''} ${b.content || ''} ${b.description || ''}`);
    if (!code) return { matched: false, reason: 'no_order_code' };
    const order = await Order.getOrderByCode(code);
    if (!order) return { matched: false, reason: 'order_not_found', order_code: code };

    const txId = `sepay:${b.id}`;
    if (order.payment_id === txId || order.payment_status === 'paid') return { matched: true, reason: 'already_paid', order_code: code };
    if (order.payment_method !== 'banking') return { matched: false, reason: 'not_banking', order_code: code };
    if (order.status === 'cancelled') return { matched: false, reason: 'cancelled', order_code: code };

    const amount = Number(b.transferAmount) || 0;
    const total = Math.round(Number(order.total_amount) || 0);
    if (amount < total) {
        console.warn(`[payments] Đơn ${code}: nhận ${amount}₫ nhưng cần ${total}₫ — chưa đánh dấu đã thanh toán, nhân viên kiểm tra thủ công.`);
        return { matched: false, reason: 'amount_short', order_code: code };
    }

    const updated = await Order.updatePaymentStatus(order.id, 'paid', txId);
    Events.orderUpdated(updated, by);
    console.log(`[payments] Đơn ${code} đã thanh toán ${amount}₫ (giao dịch SePay #${b.id}).`);
    return { matched: true, reason: 'paid', order_code: code };
}

module.exports = { paymentInfo, handleSepayWebhook, transferContent, findOrderCode };
