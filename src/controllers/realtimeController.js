const { hub } = require('../realtime/hub');
const { issueTicket, consumeTicket } = require('../realtime/tickets');
const { hasRole } = require('../config/roles');

class RealtimeController {
    /** Người đã đăng nhập xin vé. Kênh do server quyết định theo vai trò. */
    static ticket(req, res) {
        const { id, role } = req.user;
        const staff = hasRole(role, 'staff');
        const channels = staff ? ['staff', 'public', `user:${id}`] : ['public', `user:${id}`];
        res.json({ success: true, data: { ticket: issueTicket({ type: staff ? 'staff' : 'user', id, channels }) } });
    }

    /** Mở luồng SSE. Vé chỉ dùng được một lần. */
    static stream(req, res) {
        const claims = typeof req.query.ticket === 'string' ? consumeTicket(req.query.ticket) : null;
        if (!claims) {
            return res.status(401).json({ success: false, message: 'Vé kết nối không hợp lệ hoặc đã hết hạn' });
        }
        const client = hub.add({
            req,
            res,
            channels: claims.channels,
            identity: { type: claims.type, id: claims.id }
        });
        if (!client) {
            return res.status(503).json({ success: false, message: 'Máy chủ đang quá tải kết nối realtime, vui lòng thử lại sau' });
        }
        return undefined;
    }
}

module.exports = RealtimeController;
