'use strict';

/**
 * Tạo mã VietQR (chuẩn EMVCo của NAPAS 247) ngay trên server — không gọi dịch vụ ngoài.
 * Quét bằng app ngân hàng bất kỳ: tự điền số tài khoản, số tiền và nội dung chuyển khoản.
 */

const QRCode = require('qrcode');

const tlv = (id, value) => {
    const v = String(value);
    return `${id}${String(v.length).padStart(2, '0')}${v}`;
};

/** CRC16-CCITT (0x1021, khởi tạo 0xFFFF) — trường 63 của EMVCo */
function crc16(str) {
    let crc = 0xffff;
    for (const byte of Buffer.from(str, 'utf8')) {
        crc ^= byte << 8;
        for (let i = 0; i < 8; i += 1) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** Nội dung chuyển khoản: chỉ chữ/số không dấu, tối đa 25 ký tự (nhiều ngân hàng bỏ ký tự đặc biệt). */
const sanitizeInfo = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .replace(/[^0-9A-Za-z ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 25);

/**
 * @param {{ bin: string, accountNo: string, amount?: number, addInfo?: string }} p
 * @returns {string} chuỗi dữ liệu QR
 */
function buildPayload({ bin, accountNo, amount, addInfo }) {
    const beneficiary = tlv('00', bin) + tlv('01', accountNo);
    const merchant = tlv('00', 'A000000727') + tlv('01', beneficiary) + tlv('02', 'QRIBFTTA');
    const amt = Number.isFinite(Number(amount)) && Number(amount) > 0 ? String(Math.round(Number(amount))) : '';
    const info = sanitizeInfo(addInfo);
    let payload = tlv('00', '01') + tlv('01', amt ? '12' : '11') + tlv('38', merchant) + tlv('53', '704')
        + (amt ? tlv('54', amt) : '') + tlv('58', 'VN') + (info ? tlv('62', tlv('08', info)) : '');
    payload += '6304';
    return payload + crc16(payload);
}

/** Ảnh PNG (data URL) của mã QR. */
const toDataUrl = (payload) => QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 2, width: 360 });

module.exports = { buildPayload, toDataUrl, crc16, sanitizeInfo };
