'use strict';

/**
 * Tài khoản nhận chuyển khoản (VietQR). Ưu tiên tài khoản admin nhập ở trang Cài đặt → Thanh toán (lưu trong database,
 * xem services/bankSettings.js); chưa nhập thì dùng .env:
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
/** Tên chủ tài khoản đúng như app ngân hàng: IN HOA, không dấu, chỉ chữ + khoảng trắng. */
const normalizeAccountName = (v) => clean(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'D')
    .toUpperCase().replace(/[^A-Z ]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Ghép thông tin tài khoản từ các giá trị thô (lấy từ .env hoặc từ trang Cài đặt của admin).
 * Trả về null nếu chưa đủ / sai.
 */
function resolveBank({ code, bin, accountNo, accountName, bankName } = {}) {
    const known = BANK_BINS[clean(code).toUpperCase()];
    const b = clean(bin) || (known && known.bin) || '';
    const no = clean(accountNo).replace(/\s+/g, '');
    const name = normalizeAccountName(accountName);
    if (!/^\d{6}$/.test(b) || !/^[0-9A-Za-z]{4,19}$/.test(no) || !name) return null;
    const label = clean(bankName) || (known && known.name)
        || (Object.values(BANK_BINS).find((x) => x.bin === b) || {}).name || `Ngân hàng (BIN ${b})`;
    return { bin: b, account_no: no, account_name: name, bank_name: label };
}

/** Tài khoản đặt trong .env (dự phòng khi admin chưa nhập ở trang Cài đặt), hoặc null. */
function bankAccount() {
    return resolveBank({
        code: process.env.BANK_CODE,
        bin: process.env.BANK_BIN,
        accountNo: process.env.BANK_ACCOUNT_NO,
        accountName: process.env.BANK_ACCOUNT_NAME,
        bankName: process.env.BANK_NAME
    });
}

/** Danh sách ngân hàng cho ô chọn ở trang Cài đặt (bỏ mã trùng BIN). */
const bankList = () => {
    const seen = new Set();
    return Object.entries(BANK_BINS)
        .filter(([, b]) => (seen.has(b.bin) ? false : seen.add(b.bin)))
        .map(([code, b]) => ({ code, name: b.name, bin: b.bin }));
};

module.exports = { BANK_BINS, bankAccount, resolveBank, normalizeAccountName, bankList };
