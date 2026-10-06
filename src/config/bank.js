'use strict';

/**
 * Tài khoản nhận chuyển khoản (VietQR) — đặt trong .env:
 *   BANK_CODE=MB               mã ngân hàng (xem BANK_BINS bên dưới) hoặc đặt thẳng BANK_BIN=970422
 *   BANK_ACCOUNT_NO=0123456789 số tài khoản
 *   BANK_ACCOUNT_NAME=NGUYEN VAN A   tên chủ tài khoản (viết hoa, không dấu — đúng như trên app ngân hàng)
 * Thiếu một trong các giá trị trên thì không hiện mã QR (khách vẫn chọn chuyển khoản, nhân viên liên hệ sau).
 */

// Mã BIN (NAPAS) của các ngân hàng phổ biến
const BANK_BINS = {
    VCB: { bin: '970436', name: 'Vietcombank' },
    MB: { bin: '970422', name: 'MB Bank' },
    TCB: { bin: '970407', name: 'Techcombank' },
    ACB: { bin: '970416', name: 'ACB' },
    VTB: { bin: '970415', name: 'VietinBank' },
    ICB: { bin: '970415', name: 'VietinBank' },
    BIDV: { bin: '970418', name: 'BIDV' },
    AGRIBANK: { bin: '970405', name: 'Agribank' },
    TPB: { bin: '970423', name: 'TPBank' },
    VPB: { bin: '970432', name: 'VPBank' },
    STB: { bin: '970403', name: 'Sacombank' },
    VIB: { bin: '970441', name: 'VIB' },
    OCB: { bin: '970448', name: 'OCB' },
    MSB: { bin: '970426', name: 'MSB' },
    SHB: { bin: '970443', name: 'SHB' },
    HDB: { bin: '970437', name: 'HDBank' },
    SEAB: { bin: '970440', name: 'SeABank' },
    EIB: { bin: '970431', name: 'Eximbank' },
    LPB: { bin: '970449', name: 'LPBank' }
};

const clean = (v) => String(v || '').trim();

/** Thông tin tài khoản nhận tiền, hoặc null nếu chưa cấu hình đủ / sai. */
function bankAccount() {
    const code = clean(process.env.BANK_CODE).toUpperCase();
    const known = BANK_BINS[code];
    const bin = clean(process.env.BANK_BIN) || (known && known.bin) || '';
    const accountNo = clean(process.env.BANK_ACCOUNT_NO).replace(/\s+/g, '');
    const accountName = clean(process.env.BANK_ACCOUNT_NAME).toUpperCase();
    if (!/^\d{6}$/.test(bin) || !/^[0-9A-Za-z]{4,19}$/.test(accountNo) || !accountName) return null;
    const bankName = clean(process.env.BANK_NAME) || (known && known.name)
        || (Object.values(BANK_BINS).find((b) => b.bin === bin) || {}).name || `Ngân hàng (BIN ${bin})`;
    return { bin, account_no: accountNo, account_name: accountName, bank_name: bankName };
}

module.exports = { BANK_BINS, bankAccount };
