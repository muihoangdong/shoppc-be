'use strict';

const path = require('path');
const fs = require('fs/promises');
const { randomUUID } = require('crypto');
const { ValidationError } = require('../utils/http');

const IMAGE_LIMIT = 10 * 1024 * 1024;
const MODEL_LIMIT = 50 * 1024 * 1024;
const GLB_LIMIT = 100 * 1024 * 1024;
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads/products'));
const MIME = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.usdz': 'model/vnd.usdz+zip'
};
const fail = (message, status = 400) => { throw new ValidationError(message, status); };

function getUploadLimit(kind, filename) {
    if (kind === 'image') return IMAGE_LIMIT;
    return typeof filename === 'string' && path.extname(filename).toLowerCase() === '.glb' ? GLB_LIMIT : MODEL_LIMIT;
}

function validateFile(kind, filename, data) {
    if (!Buffer.isBuffer(data) || !data.length) fail('Chưa chọn file hoặc file rỗng');
    if (typeof filename !== 'string' || filename.length > 255) fail('Tên file không hợp lệ');
    const ext = path.extname(filename).toLowerCase();
    const allowed = kind === 'image' ? ['.png', '.jpg', '.jpeg', '.webp'] : ['.glb', '.gltf', '.usdz'];
    if (!allowed.includes(ext)) fail(kind === 'image' ? 'Chỉ nhận ảnh PNG, JPG, JPEG, WEBP' : 'Chỉ nhận mô hình GLB, GLTF hoặc USDZ');
    const max = getUploadLimit(kind, filename);
    if (data.length > max) fail(`File vượt quá ${max / 1024 / 1024} MB`, 413);
    let valid = false;
    if (ext === '.png') valid = data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (ext === '.jpg' || ext === '.jpeg') valid = data.length >= 4 && data[0] === 255 && data[1] === 216 && data[2] === 255;
    if (ext === '.webp') valid = data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
    if (ext === '.usdz') {
        valid = data.length >= 30 && data.readUInt32LE(0) === 0x04034b50;
        if (valid) {
            const nameLen = data.readUInt16LE(26);
            const extraLen = data.readUInt16LE(28);
            const name = data.toString('utf8', 30, 30 + nameLen);
            const eocd = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
            valid = data.readUInt16LE(8) === 0 && (data.readUInt16LE(6) & 1) === 0
                && /\.(usd|usda|usdc)$/i.test(name) && !name.includes('..') && !name.startsWith('/')
                && (30 + nameLen + extraLen) % 64 === 0
                && eocd >= 0 && eocd + 22 <= data.length;
        }
    }
    if (ext === '.glb' || ext === '.gltf') {
        let doc;
        try {
            if (ext === '.glb') {
                if (data.length < 20 || data.toString('ascii', 0, 4) !== 'glTF' || data.readUInt32LE(4) !== 2 || data.readUInt32LE(8) !== data.length || data.toString('ascii', 16, 20) !== 'JSON') fail('File GLB không hợp lệ');
                const jsonLength = data.readUInt32LE(12);
                if (20 + jsonLength > data.length) fail('File GLB bị thiếu dữ liệu');
                doc = JSON.parse(data.toString('utf8', 20, 20 + jsonLength));
            } else doc = JSON.parse(data.toString('utf8'));
        } catch { fail('Không đọc được mô hình GLB/GLTF'); }
        if (!doc || doc.asset?.version !== '2.0') fail('Chỉ hỗ trợ glTF phiên bản 2.0');
        // Single-file uploads cannot resolve companion .bin / textures. Prevent external fetches too.
        const resources = [...(Array.isArray(doc.buffers) ? doc.buffers : []), ...(Array.isArray(doc.images) ? doc.images : [])];
        if (resources.some((r) => r?.uri !== undefined && (typeof r.uri !== 'string' || !/^data:/i.test(r.uri)))) {
            fail('Mô hình tham chiếu file bên ngoài. Hãy xuất GLB đóng gói cả texture, hoặc GLTF nhúng dữ liệu');
        }
        valid = true;
    }
    if (!valid) fail('Nội dung file không khớp định dạng hoặc file bị hỏng');
    return ext;
}

async function saveFile(kind, filename, data, directory = UPLOAD_DIR) {
    const ext = validateFile(kind, filename, data);
    const storedName = `${randomUUID()}${ext}`;
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, storedName), data, { flag: 'wx' });
    return { url: `/api/uploads/files/${storedName}`, filename: path.basename(filename), size: data.length, type: ext.slice(1) };
}

module.exports = { IMAGE_LIMIT, MODEL_LIMIT, GLB_LIMIT, UPLOAD_DIR, MIME, getUploadLimit, validateFile, saveFile };
