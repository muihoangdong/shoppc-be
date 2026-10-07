'use strict';

/**
 * API trang Build PC (công khai, không cần đăng nhập):
 *   GET  /api/builder/config          loại linh kiện + thông số + AI có bật không
 *   GET  /api/builder/parts/:type     linh kiện của một loại, đánh dấu lắp được/không với các món đang chọn (?cpu=1&mainboard=2...)
 *   POST /api/builder/check           kiểm tra một cấu hình { parts: { cpu: id, ... } }
 *   POST /api/builder/suggest         AI chọn cấu hình theo { budget, purpose, note }
 */

const Product = require('../models/Product');
const { PART_TYPES, PART_KEYS } = require('../config/pcParts');
const { checkBuild, markCandidates } = require('../services/pcBuilder');
const PcAi = require('../services/ai/pcBuildAssistant');
const { isConfigured } = require('../services/ai/anthropic');
const v = require('../utils/validate');
const { sendError } = require('../utils/http');

const publicPart = (p) => ({
    id: Number(p.id), name: p.name, price: Number(p.price), stock: Number(p.stock), image_url: p.image_url || null,
    part_type: p.part_type, build_specs: p.build_specs || {}, specs: p.specs || {}
});

/** { cpu: '3', mainboard: 5 } -> { cpu: product, mainboard: product }. Sai loại / không tồn tại => lỗi rõ ràng. */
async function loadSelection(raw) {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const ids = {};
    for (const key of PART_KEYS) {
        if (src[key] === undefined || src[key] === null || src[key] === '') continue;
        ids[key] = v.int(src[key], key, { min: 1 });
    }
    const rows = await Product.getBuilderPartsByIds([...new Set(Object.values(ids))]);
    const byId = new Map(rows.map((p) => [Number(p.id), p]));
    const parts = {};
    for (const [key, id] of Object.entries(ids)) {
        const p = byId.get(id);
        const def = PART_TYPES.find((t) => t.key === key);
        if (!p) v.fail(`Không tìm thấy sản phẩm #${id}`);
        if (p.part_type !== key) v.fail(`"${p.name}" không phải ${def.label}`);
        parts[key] = p;
    }
    return parts;
}

class BuilderController {
    static config(req, res) {
        res.json({ success: true, data: { part_types: PART_TYPES, purposes: PcAi.PURPOSES, ai_enabled: isConfigured(), min_budget: PcAi.MIN_BUDGET, max_budget: PcAi.MAX_BUDGET } });
    }

    static async parts(req, res) {
        try {
            const type = v.oneOf(req.params.type, 'Loại linh kiện', PART_KEYS);
            const selected = await loadSelection(req.query);
            delete selected[type];
            const candidates = (await Product.getBuilderParts(type)).map(publicPart);
            res.json({ success: true, data: markCandidates(type, candidates, selected) });
        } catch (error) {
            sendError(res, error);
        }
    }

    static async check(req, res) {
        try {
            const parts = await loadSelection((req.body || {}).parts);
            res.json({ success: true, data: checkBuild(parts) });
        } catch (error) {
            sendError(res, error);
        }
    }

    static async suggest(req, res) {
        try {
            if (!isConfigured()) return res.status(503).json({ success: false, message: 'Tính năng AI chưa được bật trên máy chủ.' });
            const b = req.body || {};
            const result = await PcAi.suggest({ budget: b.budget, purpose: b.purpose, note: b.note });
            res.json({ success: true, data: result });
        } catch (error) {
            sendError(res, error, 'AI chưa chọn được cấu hình, vui lòng thử lại');
        }
    }
}

module.exports = BuilderController;
