'use strict';

/**
 * Đánh giá sản phẩm — quy tắc thuần (không đụng database):
 *  - Chỉ khách ĐÃ NHẬN HÀNG (đơn "Đã giao" hoặc "Hoàn tất" có sản phẩm này) mới được đánh giá.
 *  - Mỗi khách 1 đánh giá cho mỗi sản phẩm; gửi lại là sửa.
 */

const v = require('../utils/validate');

const RECEIVED = ['delivered', 'completed'];
const COMMENT_MAX = 1000;

const REASONS = {
    login: 'Đăng nhập để đánh giá sản phẩm bạn đã mua.',
    waiting: 'Bạn có thể đánh giá sau khi đã nhận được hàng.',
    not_bought: 'Chỉ khách đã mua sản phẩm này mới được đánh giá.'
};

/**
 * @param {{id:number, status:string}[]} purchases  các đơn chưa hủy của khách có sản phẩm này
 * @returns {{can_review: boolean, reason: string|null, code: string|null, order_id: number|null}}
 */
function eligibility(purchases) {
    const received = (purchases || []).find((o) => RECEIVED.includes(o.status));
    if (received) return { can_review: true, reason: null, code: null, order_id: received.id };
    if (purchases && purchases.length) return { can_review: false, reason: REASONS.waiting, code: 'waiting', order_id: null };
    return { can_review: false, reason: REASONS.not_bought, code: 'not_bought', order_id: null };
}

// Bỏ ký tự điều khiển (trừ xuống dòng), gộp nhiều dòng trống
const cleanText = (s) => s.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '').replace(/\n{3,}/g, '\n\n').trim();

function parseReview(body) {
    const b = body && typeof body === 'object' ? body : {};
    const rating = v.int(b.rating, 'Số sao', { min: 1, max: 5 });
    let comment = null;
    if (b.comment !== undefined && b.comment !== null) {
        if (typeof b.comment !== 'string') v.fail('Nội dung đánh giá phải là chữ');
        comment = cleanText(b.comment);
        if (comment.length > COMMENT_MAX) v.fail(`Nội dung đánh giá tối đa ${COMMENT_MAX} ký tự`);
        if (!comment) comment = null;
    }
    return { rating, comment };
}

function parseReply(value) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') v.fail('Phản hồi phải là chữ');
    const reply = cleanText(value);
    if (reply.length > COMMENT_MAX) v.fail(`Phản hồi tối đa ${COMMENT_MAX} ký tự`);
    return reply || null;
}

module.exports = { RECEIVED, REASONS, COMMENT_MAX, eligibility, parseReview, parseReply };
