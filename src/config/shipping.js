'use strict';

/**
 * Phí vận chuyển do SERVER tính (client không được tự gửi phí ship / giảm giá lên nữa).
 * Mặc định khớp với trang thanh toán của storefront: miễn phí từ 5.000.000đ, ngược lại 30.000đ.
 * Có thể đổi bằng biến môi trường FREE_SHIP_THRESHOLD và SHIPPING_FEE (nhớ cập nhật cả trang thanh toán).
 */

const num = (v, def) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : def);

const computeShippingFee = (subtotal) => {
    const threshold = num(process.env.FREE_SHIP_THRESHOLD, 5000000);
    const fee = num(process.env.SHIPPING_FEE, 30000);
    return Number(subtotal) >= threshold ? 0 : fee;
};

module.exports = { computeShippingFee };
