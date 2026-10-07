const features = require('../services/ai/features');
const { isConfigured, modelName } = require('../services/ai/anthropic');
const { sendError } = require('../utils/http');
const v = require('../utils/validate');

class AiController {
    /** Giao diện dùng để ẩn/hiện các nút AI. Không lộ API key hay tên model nhạy cảm. */
    static status(req, res) {
        res.json({ success: true, data: { enabled: isConfigured(), model: isConfigured() ? modelName() : null } });
    }

    static async suggestReply(req, res) {
        try {
            const id = v.idParam((req.body || {}).conversation_id, 'conversation_id');
            res.json({ success: true, data: { suggestion: await features.suggestReply(id) } });
        } catch (error) {
            sendError(res, error);
        }
    }

    static async productDescription(req, res) {
        try {
            const b = req.body || {};
            res.json({ success: true, data: { description: await features.productDescription({ name: b.name, category: b.category, specs: b.specs, current: b.current }) } });
        } catch (error) {
            sendError(res, error);
        }
    }

    static async insights(req, res) {
        try {
            res.json({ success: true, data: { insights: await features.insights() } });
        } catch (error) {
            sendError(res, error);
        }
    }
}

module.exports = AiController;
