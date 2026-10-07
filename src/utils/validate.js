'use strict';

const { ValidationError } = require('./http');

const fail = (message) => {
    throw new ValidationError(message);
};

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function int(v, label, { min = 0, max = 1e9, optional = false } = {}) {
    if (v === undefined || v === null || v === '') {
        if (optional) return undefined;
        fail(`Thiếu ${label}`);
    }
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
        fail(`${label} phải là số nguyên từ ${min} đến ${max}`);
    }
    return n;
}

function str(v, label, { max = 255, optional = false, allowEmpty = false } = {}) {
    if (v === undefined || v === null) {
        if (optional) return undefined;
        fail(`Thiếu ${label}`);
    }
    if (typeof v !== 'string') fail(`${label} phải là chuỗi ký tự`);
    const s = v.trim();
    if (!s && !allowEmpty) {
        if (optional) return undefined;
        fail(`${label} không được để trống`);
    }
    if (s.length > max) fail(`${label} quá dài (tối đa ${max} ký tự)`);
    return s;
}

function oneOf(v, label, values, { optional = false } = {}) {
    if (v === undefined || v === null || v === '') {
        if (optional) return undefined;
        fail(`Thiếu ${label}`);
    }
    if (!values.includes(v)) fail(`${label} không hợp lệ. Giá trị cho phép: ${values.join(', ')}`);
    return v;
}

function imageUrl(v) {
    const s = str(v, 'Link ảnh', { max: 500, optional: true, allowEmpty: true });
    if (s && !/^(https?:\/\/|\/)/i.test(s)) fail('Link ảnh phải bắt đầu bằng http://, https:// hoặc /');
    return s;
}

function specs(v) {
    if (v === undefined) return undefined;
    if (!isPlainObject(v)) fail('Thông số kỹ thuật phải là một object dạng {"tên": "giá trị"}');
    if (JSON.stringify(v).length > 10000) fail('Thông số kỹ thuật quá lớn');
    return v;
}

/** Id trong URL: số nguyên dương, ngược lại 400 (tránh chuỗi lạ chạm tới SQL). */
const idParam = (v, label = 'id') => int(v, label, { min: 1 });

module.exports = { fail, isPlainObject, int, str, oneOf, imageUrl, specs, idParam };
