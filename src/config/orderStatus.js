'use strict';

/**
 * Vòng đời đơn hàng (nguồn duy nhất cho backend, chatbot và dashboard).
 *
 *   pending ──► processing ──► shipped ──► delivered ──► completed
 *      │            │             │
 *      └────────────┴─────────────┴──► cancelled   (hủy => hoàn lại tồn kho)
 *
 * `completed` và `cancelled` là trạng thái cuối, không đổi tiếp được.
 */

const ORDER_STATUSES = ['pending', 'processing', 'shipped', 'delivered', 'completed', 'cancelled'];

const STATUS_LABELS = {
    pending: 'Chờ xử lý',
    processing: 'Đang xử lý',
    shipped: 'Đang giao',
    delivered: 'Đã giao',
    completed: 'Hoàn tất',
    cancelled: 'Đã hủy'
};

const TRANSITIONS = {
    pending: ['processing', 'cancelled'],
    processing: ['shipped', 'cancelled'],
    shipped: ['delivered', 'cancelled'],
    delivered: ['completed'],
    completed: [],
    cancelled: []
};

// Đơn ở các trạng thái này được tính là doanh thu thực
const REVENUE_STATUSES = ['delivered', 'completed'];

const PAYMENT_METHODS = ['cod', 'banking'];
const PAYMENT_STATUSES = ['pending', 'paid'];

const canTransition = (from, to) =>
    Object.prototype.hasOwnProperty.call(TRANSITIONS, from) && TRANSITIONS[from].includes(to);

module.exports = {
    ORDER_STATUSES,
    STATUS_LABELS,
    TRANSITIONS,
    REVENUE_STATUSES,
    PAYMENT_METHODS,
    PAYMENT_STATUSES,
    canTransition
};
