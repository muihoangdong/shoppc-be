'use strict';

/**
 * Các sự kiện nghiệp vụ phát ra realtime. Mọi hàm đều "nuốt" lỗi: realtime hỏng không bao giờ được làm hỏng
 * request chính (đặt hàng, cập nhật sản phẩm...).
 */

const { hub } = require('./hub');

const safe = (fn) => (...args) => {
    try {
        return fn(...args);
    } catch (error) {
        console.error('[realtime] Lỗi phát sự kiện:', error.message);
        return 0;
    }
};

const orderBrief = (o) => ({
    id: o.id,
    order_code: o.order_code,
    customer_name: o.customer_name,
    total_amount: Number(o.total_amount),
    status: o.status,
    payment_status: o.payment_status,
    created_at: o.created_at
});

module.exports = {
    /** Đơn hàng mới -> mọi nhân viên (toast + làm mới danh sách/thống kê). */
    orderNew: safe((order) => {
        hub.publish('staff', 'order:new', orderBrief(order));
        hub.publish('staff', 'stats:dirty', { reason: 'order:new' });
    }),
    orderUpdated: safe((order, by) => {
        hub.publish('staff', 'order:updated', { ...orderBrief(order), by: by || null });
        hub.publish('staff', 'stats:dirty', { reason: 'order:updated' });
    }),
    /** Sản phẩm/tồn kho đổi -> trang Sản phẩm tự cập nhật. `ids` có thể rỗng nghĩa là "nhiều sản phẩm". */
    productChanged: safe((ids = []) => {
        hub.publish('staff', 'product:changed', { ids: [...ids].filter(Boolean) });
        hub.publish('staff', 'stats:dirty', { reason: 'product:changed' });
    }),
    categoryChanged: safe(() => hub.publish('staff', 'category:changed', {})),
    /** Khách bấm "Tôi đã chuyển khoản" -> mọi nhân viên (toast + âm báo + chuông thông báo). */
    paymentClaimed: safe((order) => {
        hub.publish('staff', 'payment:claimed', { ...orderBrief(order), payment_claimed_at: order.payment_claimed_at || new Date() });
        hub.publish('staff', 'stats:dirty', { reason: 'payment:claimed' });
    }),
    /** Đơn vừa được xác nhận đã thanh toán (nhân viên bấm hoặc SePay tự xác nhận). */
    paymentReceived: safe((order, by) => {
        hub.publish('staff', 'payment:received', { ...orderBrief(order), by: by || null });
        hub.publish('staff', 'stats:dirty', { reason: 'payment:received' });
    }),
    /** Khách gửi / sửa đánh giá -> trang Đánh giá của nhân viên tự làm mới. */
    reviewChanged: safe((review) => hub.publish('staff', 'review:changed', review ? { id: review.id, product_id: review.product_id, rating: review.rating } : {})),
    /** Gửi sự kiện tùy ý tới một kênh. */
    to: safe((channel, event, data) => hub.publish(channel, event, data)),
    _orderBrief: orderBrief
};
