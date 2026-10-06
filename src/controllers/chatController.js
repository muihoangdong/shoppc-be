const ChatService = require('../services/ai/chatService');

const MAX_HISTORY = 20; // số tin nhắn gần nhất gửi lên AI
const MAX_CONTENT_CHARS = 4000;
const MAX_CONFIRM_IDS = 25;

// Giới hạn tần suất theo user (trong bộ nhớ): tránh vô tình đốt hết hạn mức API
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = Number(process.env.AI_RATE_LIMIT_PER_MIN) || 20;
const hits = new Map();

function checkRate(userId) {
    const now = Date.now();
    const recent = (hits.get(userId) || []).filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length >= RATE_MAX) {
        hits.set(userId, recent);
        return false;
    }
    recent.push(now);
    hits.set(userId, recent);
    return true;
}

function sanitizeMessages(raw) {
    if (!Array.isArray(raw)) return null;
    let msgs = raw
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map((m) => ({ role: m.role, content: m.content.trim().slice(0, MAX_CONTENT_CHARS) }))
        .filter((m) => m.content);

    msgs = msgs.slice(-MAX_HISTORY);
    while (msgs.length && msgs[0].role !== 'user') msgs.shift(); // API yêu cầu bắt đầu bằng tin của user
    if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return null;
    return msgs;
}

/** Ngữ cảnh trang: chỉ nhận đường dẫn /admin/... và chuỗi query ngắn; giá trị cụ thể được kiểm tra lại ở chatService. */
function sanitizeContext(raw) {
    if (!raw || typeof raw !== 'object') return undefined;
    const page = typeof raw.page === 'string' && /^\/admin(\/[a-z]+)?$/.test(raw.page) ? raw.page : undefined;
    if (!page) return undefined;
    const search = typeof raw.search === 'string' ? raw.search.slice(0, 200) : '';
    return { page, search };
}

function sanitizeIds(raw) {
    if (!Array.isArray(raw)) return null;
    const ids = [...new Set(raw.filter((x) => typeof x === 'string' && x.length <= 64))];
    return ids.length && ids.length <= MAX_CONFIRM_IDS ? ids : null;
}

function sendError(res, error) {
    if (error && error.status) {
        return res.status(error.status).json({ success: false, message: error.message });
    }
    console.error('[chatbot] Unexpected error:', error);
    return res.status(500).json({ success: false, message: 'Đã xảy ra lỗi khi xử lý yêu cầu chatbot' });
}

class ChatController {
    static async chat(req, res) {
        try {
            if (!checkRate(req.user.id)) {
                return res.status(429).json({ success: false, message: `Bạn gửi quá nhanh, vui lòng thử lại sau ít giây (tối đa ${RATE_MAX} tin/phút).` });
            }
            const messages = sanitizeMessages(req.body && req.body.messages);
            if (!messages) {
                return res.status(400).json({ success: false, message: 'Tin nhắn không hợp lệ' });
            }
            const data = await ChatService.runChat({ messages, user: req.user, context: sanitizeContext(req.body && req.body.context) });
            res.json({ success: true, data });
        } catch (error) {
            sendError(res, error);
        }
    }

    static async confirm(req, res) {
        try {
            const ids = sanitizeIds(req.body && req.body.action_ids);
            if (!ids) return res.status(400).json({ success: false, message: 'Danh sách thao tác không hợp lệ' });
            const results = await ChatService.confirmActions({ ids, user: req.user });
            res.json({ success: true, data: { results } });
        } catch (error) {
            sendError(res, error);
        }
    }

    static async cancel(req, res) {
        try {
            const ids = sanitizeIds(req.body && req.body.action_ids);
            if (!ids) return res.status(400).json({ success: false, message: 'Danh sách thao tác không hợp lệ' });
            const cancelled = ChatService.cancelActions({ ids, user: req.user });
            res.json({ success: true, data: { cancelled } });
        } catch (error) {
            sendError(res, error);
        }
    }
}

module.exports = ChatController;
module.exports._test = { sanitizeMessages, sanitizeIds, checkRate, sanitizeContext };
