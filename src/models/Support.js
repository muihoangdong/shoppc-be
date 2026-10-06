const db = require('../config/database');

const FIELDS = ['status', 'assigned_to', 'ai_enabled', 'needs_human', 'customer_name', 'customer_phone', 'user_id'];

const like = (term) => `%${String(term).trim().replace(/[\\%_]/g, '\\$&')}%`;

/** Dữ liệu hội thoại gọn để gửi cho nhân viên / hiển thị danh sách. */
const brief = (c) =>
    c && {
        id: c.id,
        visitor_id: c.visitor_id,
        user_id: c.user_id,
        customer_name: c.customer_name,
        customer_phone: c.customer_phone,
        status: c.status,
        assigned_to: c.assigned_to,
        ai_enabled: !!c.ai_enabled,
        needs_human: !!c.needs_human,
        unread_staff: Number(c.unread_staff),
        unread_customer: Number(c.unread_customer),
        last_message_at: c.last_message_at,
        last_message_preview: c.last_message_preview,
        created_at: c.created_at
    };

class Support {
    static brief = brief;

    static async createConversation({ visitor_id, user_id = null, customer_name = null, customer_phone = null, ai_enabled = 1 }) {
        const [result] = await db.pool.query(
            `INSERT INTO support_conversations (visitor_id, user_id, customer_name, customer_phone, ai_enabled)
             VALUES (?, ?, ?, ?, ?)`,
            [visitor_id, user_id, customer_name, customer_phone, ai_enabled ? 1 : 0]
        );
        return this.getConversationById(result.insertId);
    }

    static async getConversationById(id) {
        const rows = await db.query('SELECT * FROM support_conversations WHERE id = ?', [id]);
        return rows[0];
    }

    /** Hội thoại mới nhất của một khách (mỗi khách chỉ dùng 1 hội thoại, mở lại khi nhắn tiếp). */
    static async getConversationByVisitor(visitorId) {
        const rows = await db.query('SELECT * FROM support_conversations WHERE visitor_id = ? ORDER BY id DESC LIMIT 1', [visitorId]);
        return rows[0];
    }

    /** Danh sách cho nhân viên: lọc trạng thái, cần nhân viên, tìm kiếm; chưa đọc lên trước. */
    static async listConversations({ status, needs_human, search, page = 1, limit = 20 } = {}) {
        const conds = [];
        const params = [];
        if (status) { conds.push('status = ?'); params.push(status); }
        if (needs_human) { conds.push('needs_human = 1'); }
        if (search && String(search).trim()) {
            conds.push('(customer_name LIKE ? OR customer_phone LIKE ? OR last_message_preview LIKE ?)');
            const l = like(search);
            params.push(l, l, l);
        }
        const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
        const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
        const pg = Math.max(parseInt(page, 10) || 1, 1);

        const [{ n }] = await db.query(`SELECT COUNT(*) AS n FROM support_conversations ${where}`, params);
        const rows = await db.query(
            `SELECT * FROM support_conversations ${where}
             ORDER BY (unread_staff > 0) DESC, COALESCE(last_message_at, created_at) DESC, id DESC
             LIMIT ? OFFSET ?`,
            [...params, lim, (pg - 1) * lim]
        );
        return { rows, total: Number(n), page: pg, limit: lim, pages: Math.max(Math.ceil(Number(n) / lim), 1) };
    }

    /**
     * Thêm tin nhắn và cập nhật bộ đếm trong cùng một transaction.
     * customer -> nhân viên có thêm 1 tin chưa đọc, hội thoại tự mở lại nếu đã đóng.
     * staff/ai  -> khách có thêm 1 tin chưa đọc. system -> không đổi bộ đếm.
     */
    static async addMessage({ conversation_id, sender_type, sender_id = null, sender_name = null, content }) {
        const client = await db.getClient();
        try {
            await client.beginTransaction();
            const [result] = await client.query(
                `INSERT INTO support_messages (conversation_id, sender_type, sender_id, sender_name, content)
                 VALUES (?, ?, ?, ?, ?)`,
                [conversation_id, sender_type, sender_id, sender_name, content]
            );
            const bump =
                sender_type === 'customer' ? ", unread_staff = unread_staff + 1, status = 'open'"
                : sender_type === 'system' ? ''
                : ', unread_customer = unread_customer + 1';
            await client.query(
                `UPDATE support_conversations
                 SET last_message_at = CURRENT_TIMESTAMP, last_message_preview = ?${bump}
                 WHERE id = ?`,
                [content.slice(0, 255), conversation_id]
            );
            await client.commit();
            const [message] = await db.query('SELECT * FROM support_messages WHERE id = ?', [result.insertId]);
            return { message, conversation: await this.getConversationById(conversation_id) };
        } catch (error) {
            await client.rollback();
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Lấy tin nhắn theo thứ tự cũ -> mới.
     * after_id: chỉ lấy tin MỚI HƠN (đồng bộ lại sau khi mất kết nối).
     * before_id: lấy tin CŨ HƠN (tải thêm lịch sử). Không có cả hai: lấy `limit` tin gần nhất.
     */
    static async getMessages(conversationId, { after_id, before_id, limit = 50 } = {}) {
        const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
        if (after_id) {
            return db.query('SELECT * FROM support_messages WHERE conversation_id = ? AND id > ? ORDER BY id ASC LIMIT ?', [conversationId, Number(after_id), lim]);
        }
        const rows = before_id
            ? await db.query('SELECT * FROM support_messages WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT ?', [conversationId, Number(before_id), lim])
            : await db.query('SELECT * FROM support_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?', [conversationId, lim]);
        return rows.reverse();
    }

    /** side: 'staff' (nhân viên đã đọc tin của khách) hoặc 'customer' (khách đã đọc tin của nhân viên). */
    static async markRead(conversationId, side) {
        const column = side === 'staff' ? 'unread_staff' : 'unread_customer';
        await db.pool.query(`UPDATE support_conversations SET ${column} = 0 WHERE id = ?`, [conversationId]);
        return this.getConversationById(conversationId);
    }

    static async update(id, fields) {
        const sets = [];
        const params = [];
        for (const key of FIELDS) {
            if (fields[key] !== undefined) {
                sets.push(`${key} = ?`);
                params.push(fields[key]);
            }
        }
        if (!sets.length) return this.getConversationById(id);
        await db.pool.query(`UPDATE support_conversations SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
        return this.getConversationById(id);
    }

    static async unreadStaffTotal() {
        const [{ n }] = await db.query("SELECT COALESCE(SUM(unread_staff), 0) AS n FROM support_conversations WHERE status = 'open'");
        return Number(n);
    }

    /** Số tin AI đã trả lời trong khoảng thời gian (để giới hạn chi phí / chống lạm dụng). */
    static async countAiMessagesSince(conversationId, sinceMs) {
        const [{ n }] = await db.query(
            "SELECT COUNT(*) AS n FROM support_messages WHERE conversation_id = ? AND sender_type = 'ai' AND created_at >= DATE_SUB(NOW(), INTERVAL ? SECOND)",
            [conversationId, Math.max(Math.round(sinceMs / 1000), 1)]
        );
        return Number(n);
    }

    /** Id tin nhắn mới nhất của nhân viên (null nếu chưa có). */
    static async lastStaffMessageId(conversationId) {
        const rows = await db.query("SELECT id FROM support_messages WHERE conversation_id = ? AND sender_type = 'staff' ORDER BY id DESC LIMIT 1", [conversationId]);
        return rows[0] ? rows[0].id : null;
    }
}

module.exports = Support;
