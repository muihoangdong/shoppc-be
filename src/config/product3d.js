'use strict';

/**
 * Mô hình 3D / AR của sản phẩm (cột products.model_3d, kiểu JSON, có thể NULL).
 *
 * Trang cửa hàng dùng Google <model-viewer> để hiển thị file GLB: xoay 360°, phóng to và xem AR
 * (Android: WebXR / Scene Viewer, iPhone: AR Quick Look). Chỉ sản phẩm CÓ file GLB mới hiện nút xem 3D;
 * sản phẩm không có mô hình vẫn hiển thị ảnh như cũ.
 *
 *   {
 *     "glb_url": "https://cdn.../ryzen-9800x3d.glb",  // bắt buộc để bật 3D (.glb hoặc .gltf)
 *     "usdz_url": "https://cdn.../ryzen-9800x3d.usdz", // tùy chọn: AR trên iPhone/iPad; trống = model-viewer tự chuyển từ GLB
 *     "poster_url": "https://cdn.../poster.webp",       // tùy chọn: ảnh hiện trong lúc tải mô hình (trống = ảnh sản phẩm)
 *     "enabled": true                                   // false = tạm ẩn 3D mà không phải xóa link
 *   }
 *
 * Lưu ý: file GLB đặt ở máy chủ khác phải cho phép CORS (Access-Control-Allow-Origin) thì trình duyệt mới tải được.
 * Đặt file trong thư mục public/models của trang cửa hàng thì dùng link dạng /models/ten-file.glb.
 */

const MAX_URL = 500;

function parseModel3d(input, fail) {
    if (input === undefined) return undefined;
    if (input === null || input === '') return null;
    if (typeof input !== 'object' || Array.isArray(input)) fail('Mô hình 3D phải là một object');

    const url = (value, label, ext) => {
        if (value === undefined || value === null || value === '') return undefined;
        if (typeof value !== 'string' || value.length > MAX_URL) fail(`3D: link ${label} không hợp lệ`);
        const s = value.trim();
        if (!/^(https?:\/\/|\/)/i.test(s) || s.startsWith('//')) fail(`3D: link ${label} phải bắt đầu bằng http://, https:// hoặc /`);
        if (ext && !ext.test(s.split(/[?#]/)[0])) fail(`3D: link ${label} phải là file ${label}`);
        return s;
    };

    const out = {};
    const glb = url(input.glb_url, '.glb/.gltf', /\.(glb|gltf)$/i);
    const usdz = url(input.usdz_url, '.usdz', /\.usdz$/i);
    const poster = url(input.poster_url, 'ảnh chờ');
    if (glb) out.glb_url = glb;
    if (usdz) out.usdz_url = usdz;
    if (poster) out.poster_url = poster;
    if (input.enabled !== undefined) {
        if (typeof input.enabled !== 'boolean') fail('3D: "enabled" phải là true/false');
        out.enabled = input.enabled;
    }
    if ((usdz || poster) && !glb) fail('3D: cần nhập link file GLB trước');

    return out.glb_url ? out : null;
}

/** Sản phẩm có xem 3D được không */
const has3d = (model3d) => !!(model3d && model3d.glb_url && model3d.enabled !== false);

module.exports = { parseModel3d, has3d };
