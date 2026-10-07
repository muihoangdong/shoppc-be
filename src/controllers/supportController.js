const Support = require('../models/Support');
const service = require('../services/support/supportService');
const visitor = require('../services/support/visitor');
const { issueTicket } = require('../realtime/tickets');
const { sendError, ValidationError } = require('../utils/http');
const v = require('../utils/validate');

const isStr = (x) => typeof x === 'string';
const asId = (x) => v.idParam(x, 'id');

class SupportController {
    // ─────────── Khách hàng (xác thực bằng X-Visitor-Token) ───────────

    /** Bắt đầu / khôi phục phiên chat. Có token hợp lệ thì dùng lại, không thì cấp token mới. */
    static async session(req, res) {
        try {
            const given = req.body && req.body.visitor_token;
            let id = isStr(given) ? visitor.verify(given) : null;
            let token = given;
            if (!id) {
                const created = visitor.create();
                id = created.id;
                token = created.token;
            }
            const state = await service.getVisitorState(id);
            res.json({ success: true, data: { visitor_token: token, ...state } });
        } catch (error) {
            sendError(res, error);
        }
    }

    static async conversation(req, res) {
        try {
            res.json({ success: true, data: await service.getVisitorState(req.visitor.id) });
        } catch (error) {
            sendError(res, error);
        }
    }

    /** Đồng bộ lại sau khi mất kết nối: chỉ lấy tin mới hơn after_id. */
    static async messages(req, res) {
        try {
            const conversation = await Support.getConversationByVisitor(req.visitor.id);
            if (!conversation) return res.json({ success: true, data: [] });
            const afterId = req.query.after_id !== undefined ? v.int(req.query.after_id, 'after_id', { min: 0, max: Number.MAX_SAFE_INTEGER }) : undefined;
            const beforeId = req.query.before_id !== undefined ? v.int(req.query.before_id, 'before_id', { min: 1, max: Number.MAX_SAFE_INTEGER }) : undefined;
            const rows = await Support.getMessages(conversation.id, { after_id: afterId, before_id: beforeId, limit: 50 });
            res.json({ success: true, data: rows.map(service.publicMessage) });
        } catch (error) {
            sendError(res, error);
        }
    }

    static async send(req, res) {
        try {
            const body = req.body || {};
            const data = await service.postCustomerMessage({
                visitorId: req.visitor.id, user: req.user, content: body.content, name: body.name, phone: body.phone
            });
            res.status(201).json({ success: true, data });
        } catch (error) {
            sendError(res, error);
        }
    }

    static async read(req, res) {
        try {
            res.json({ success: true, data: await service.customerRead(req.visitor.id) });
        } catch (error) {
            sendError(res, error);
        }
    }

    static async typing(req, res) {
        try {
            await service.customerTyping(req.visitor.id, !!(req.body && req.body.typing));
            res.json({ success: true });
        } catch (error) {
            sendError(res, error);
        }
    }

    static async requestHuman(req, res) {
        try {
            const conversation = await Support.getConversationByVisitor(req.visitor.id);
            if (!conversation) throw new ValidationError('Bạn hãy gửi một tin nhắn trước khi yêu cầu gặp nhân viên');
            res.json({ success: true, data: await service.requestHuman(conversation.id, { by: 'customer' }) });
        } catch (error) {
            sendError(res, error);
        }
    }

    /** Vé SSE cho khách: chỉ nhận kênh của chính họ + kênh public (trạng thái nhân viên trực tuyến). */
    static ticket(req, res) {
        const id = req.visitor.id;
        res.json({ success: true, data: { ticket: issueTicket({ type: 'visitor', id, channels: ['public', `visitor:${id}`] }) } });
    }

    // ─────────── Nhân viên (authenticate + authorizeStaff) ───────────

    static async listConversations(req, res) {
        try {
            const q = req.query || {};
            for (const k of ['status', 'search', 'needs_human', 'page', 'limit']) if (q[k] !== undefined && !isStr(q[k])) throw new ValidationError(`Tham số ${k} không hợp lệ`);
            if (q.status && !['open', 'closed'].includes(q.status)) throw new ValidationError('Trạng thái không hợp lệ');
            const result = await Support.listConversations({
                status: q.status, needs_human: q.needs_human === '1' || q.needs_human === 'true', search: q.search, page: q.page, limit: q.limit
            });
            res.json({
                success: true,
                data: result.rows.map(Support.brief),
                meta: { total: result.total, page: result.page, limit: result.limit, pages: result.pages, unread_total: await Support.unreadStaffTotal() }
            });
        } catch (error) {
            sendError(res, error);
        }
    }

    static async getConversation(req, res) {
        try {
            const conversation = await Support.getConversationById(asId(req.params.id));
            if (!conversation) throw new ValidationError('Không tìm thấy hội thoại', 404);
            const messages = (await Support.getMessages(conversation.id, { limit: 100 })).map(service.publicMessage);
            res.json({ success: true, data: { conversation: Support.brief(conversation), messages } });
        } catch (error) {
            sendError(res, error);
        }
    }

    static async conversationMessages(req, res) {
        try {
            const id = asId(req.params.id);
            const afterId = req.query.after_id !== undefined ? v.int(req.query.after_id, 'after_id', { min: 0, max: Number.MAX_SAFE_INTEGER }) : undefined;
            const beforeId = req.query.before_id !== undefined ? v.int(req.query.before_id, 'before_id', { min: 1, max: Number.MAX_SAFE_INTEGER }) : undefined;
            res.json({ success: true, data: (await Support.getMessages(id, { after_id: afterId, before_id: beforeId, limit: 100 })).map(service.publicMessage) });
        } catch (error) {
            sendError(res, error);
        }
    }

    static async reply(req, res) {
        try {
            const data = await service.postStaffMessage({ conversationId: asId(req.params.id), staff: req.user, content: (req.body || {}).content });
            res.status(201).json({ success: true, data });
        } catch (error) {
            sendError(res, error);
        }
    }

    static async staffRead(req, res) {
        try {
            res.json({ success: true, data: await service.staffRead(asId(req.params.id)) });
        } catch (error) {
            sendError(res, error);
        }
    }

    static async staffTyping(req, res) {
        try {
            await service.staffTyping(asId(req.params.id), !!(req.body && req.body.typing), req.user);
            res.json({ success: true });
        } catch (error) {
            sendError(res, error);
        }
    }

    static async update(req, res) {
        try {
            res.json({ success: true, data: await service.updateConversation(asId(req.params.id), req.body || {}, req.user) });
        } catch (error) {
            sendError(res, error);
        }
    }

    static async unread(req, res) {
        try {
            res.json({ success: true, data: { unread_total: await Support.unreadStaffTotal() } });
        } catch (error) {
            sendError(res, error);
        }
    }
}

module.exports = SupportController;
