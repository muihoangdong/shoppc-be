'use strict';

const express = require('express');
const path = require('path');
const rateLimit = require('../middlewares/rateLimit');
const { sendError } = require('../utils/http');
const { IMAGE_LIMIT, MODEL_LIMIT, UPLOAD_DIR, MIME, saveFile } = require('../services/productUploads');

/** Raw binary body avoids base64 overhead and multipart dependencies. Auth runs before buffering. */
function createUploadRouter({ authenticate, authorizeStaff, directory = UPLOAD_DIR }) {
    const router = express.Router();
    router.get('/files/:filename', (req, res) => {
        const name = req.params.filename;
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpe?g|webp|glb|gltf|usdz)$/.test(name)) {
            return res.status(404).json({ success: false, message: 'Không tìm thấy file' });
        }
        res.type(MIME[path.extname(name)]);
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Content-Security-Policy', "default-src 'none'; sandbox");
        res.sendFile(name, { root: directory, maxAge: '30d', dotfiles: 'deny' }, (err) => {
            if (err && !res.headersSent) res.status(err.status === 404 ? 404 : 500).type('application/json').json({ success: false, message: 'Không tải được file' });
        });
    });
    const limiter = rateLimit({ windowMs: 60 * 1000, max: 20, message: 'Bạn tải quá nhiều file. Vui lòng thử lại sau một phút.' });
    for (const kind of ['image', 'model']) {
        router.post(`/${kind}`, authenticate, authorizeStaff, limiter,
            express.raw({ type: 'application/octet-stream', limit: kind === 'image' ? IMAGE_LIMIT : MODEL_LIMIT, inflate: false }),
            async (req, res) => {
                try {
                    const data = await saveFile(kind, req.query.filename, req.body, directory);
                    res.status(201).json({ success: true, data });
                } catch (error) { sendError(res, error, 'Không lưu được file tải lên'); }
            });
    }
    router.use((err, req, res, next) => {
        if (err.type === 'entity.too.large') return res.status(413).json({ success: false, message: 'File quá lớn (ảnh tối đa 10 MB, mô hình tối đa 50 MB)' });
        next(err);
    });
    return router;
}

module.exports = createUploadRouter;
