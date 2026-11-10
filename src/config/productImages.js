'use strict';

/** Ordered image gallery; first image is also the legacy image_url cover. */
function parseProductImages(value, fail) {
    if (value === undefined) return undefined;
    if (value === null) return [];
    if (!Array.isArray(value) || value.length > 20) fail('Thư viện sản phẩm phải là danh sách tối đa 20 ảnh');
    const urls = value.map((url) => {
        if (typeof url !== 'string') fail('Mỗi ảnh phải là một đường dẫn');
        const s = url.trim();
        if (!s || s.length > 500 || !/^(https?:\/\/|\/(?!\/))/i.test(s)) fail('Link ảnh phải bắt đầu bằng http://, https:// hoặc /, tối đa 500 ký tự');
        return s;
    });
    return [...new Set(urls)];
}

module.exports = { parseProductImages };
