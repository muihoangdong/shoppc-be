'use strict';

/**
 * Kho lưu các thao tác ghi dữ liệu đang chờ người dùng xác nhận.
 *
 *  - Mỗi thao tác chỉ thuộc về một user (user khác không thể xác nhận hộ).
 *  - Dùng một lần: lấy ra là xóa luôn (chống bấm xác nhận 2 lần / replay).
 *  - Tự hết hạn sau TTL.
 *
 * Lưu trong bộ nhớ của tiến trình Node. Nếu sau này chạy nhiều instance (cluster / nhiều container),
 * hãy thay Map này bằng Redis hoặc một bảng trong MySQL — giao diện (add/take/discard) giữ nguyên.
 */

const crypto = require('crypto');

const TTL_MS = 10 * 60 * 1000;
const store = new Map();

function sweep() {
    const now = Date.now();
    for (const [id, entry] of store) {
        if (entry.expiresAt <= now) store.delete(id);
    }
}

// Dọn định kỳ; unref() để timer không giữ tiến trình Node sống
setInterval(sweep, 60 * 1000).unref();

function add(userId, { tool, input, summary, danger = false }) {
    sweep();
    const id = crypto.randomUUID();
    store.set(id, { userId, tool, input, summary, danger, expiresAt: Date.now() + TTL_MS });
    return id;
}

/** Lấy và XÓA thao tác. Trả về null nếu không tồn tại / hết hạn / không thuộc về user. */
function take(userId, id) {
    const entry = store.get(id);
    if (!entry || entry.userId !== userId) return null;
    store.delete(id);
    if (entry.expiresAt <= Date.now()) return null;
    return entry;
}

function discard(userId, ids) {
    let n = 0;
    for (const id of ids) {
        const entry = store.get(id);
        if (entry && entry.userId === userId) {
            store.delete(id);
            n += 1;
        }
    }
    return n;
}

module.exports = { add, take, discard, _size: () => store.size, TTL_MS };
