'use strict';

/**
 * Nghiệp vụ chat hỗ trợ khách hàng <-> nhân viên (realtime qua SSE) + trợ lý AI tự trả lời.
 *
 * Quy tắc AI:
 *  - Chỉ trả lời khi hội thoại còn mở, AI đang bật và khách chưa yêu cầu gặp nhân viên.
 *  - Nhân viên trả lời lần đầu => AI tự tắt cho hội thoại đó (người thật đã tiếp quản).
 *  - Nếu có nhân viên đang trực tuyến thì chờ SUPPORT_AI_DELAY_MS (mặc định 45s) cho họ trả lời trước;
 *    nếu không có ai trực tuyến thì AI trả lời gần như ngay (SUPPORT_AI_OFFLINE_DELAY_MS, mặc định 1.2s).
 *  - Giới hạn SUPPORT_AI_MAX_PER_HOUR (mặc định 20) tin AI / hội thoại / giờ để kiểm soát chi phí.
 */

const Support = require('../../models/Support');
const { hub } = require('../../realtime/hub');
const Events = require('../../realtime/events');
const { ValidationError } = require('../../utils/http');
const { isConfigured } = require('../ai/anthropic');
const assistant = require('./customerAssistant');

const MAX_LEN = 2000;
const AI_NAME = 'Trợ lý AI';
const HOUR = 60 * 60 * 1000;

const num = (v, def) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : def);
const pendingAi = new Map(); // conversationId -> timer
const trackLookups = new Map(); // conversationId -> [timestamps]
let assistantFn = assistant.reply; // thay được khi kiểm thử

const cleanText = (v, max, label = 'Tin nhắn') => {
    if (typeof v !== 'string') throw new ValidationError(`${label} không hợp lệ`);
    const s = v.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
    if (!s) throw new ValidationError(`${label} không được để trống`);
    if (s.length > max) throw new ValidationError(`${label} quá dài (tối đa ${max} ký tự)`);
    return s;
};

const optionalName = (v) => {
    if (v === undefined || v === null || v === '') return undefined;
    return cleanText(v, 100, 'Họ tên');
};
const optionalPhone = (v) => {
    if (v === undefined || v === null || v === '') return undefined;
    const s = cleanText(v, 20, 'Số điện thoại');
    if (!/^[0-9+\s().-]{8,20}$/.test(s)) throw new ValidationError('Số điện thoại không hợp lệ');
    return s;
};

const publicMessage = (m) => ({
    id: Number(m.id),
    conversation_id: Number(m.conversation_id),
    sender_type: m.sender_type,
    sender_name: m.sender_name,
    content: m.content,
    created_at: m.created_at
});

/** Những gì khách được thấy về hội thoại của mình (không lộ thông tin nội bộ của nhân viên). */
const customerView = (c) =>
    c && {
        id: Number(c.id),
        status: c.status,
        ai_enabled: !!c.ai_enabled,
        needs_human: !!c.needs_human,
        unread_customer: Number(c.unread_customer),
        customer_name: c.customer_name
    };

const aiAvailable = () => isConfigured();
const staffOnline = () => hub.countStaffOnline();

function broadcastMessage(conversation, message) {
    const m = publicMessage(message);
    Events.to('staff', 'chat:message', { conversation: Support.brief(conversation), message: m });
    Events.to(`visitor:${conversation.visitor_id}`, 'chat:message', { conversation: customerView(conversation), message: m });
}

// ───────────────────────── Khách hàng ─────────────────────────

/** Trả về hội thoại + tin nhắn gần nhất của khách (để khôi phục khung chat khi mở lại trang). */
async function getVisitorState(visitorId, limit = 50) {
    const conversation = await Support.getConversationByVisitor(visitorId);
    const messages = conversation ? (await Support.getMessages(conversation.id, { limit })).map(publicMessage) : [];
    return {
        conversation: customerView(conversation) || null,
        messages,
        staff_online: staffOnline(),
        ai_available: aiAvailable()
    };
}

async function postCustomerMessage({ visitorId, user, content, name, phone }) {
    const text = cleanText(content, MAX_LEN);
    const displayName = optionalName(name) || (user && user.full_name) || undefined;
    const phoneNumber = optionalPhone(phone);

    let conversation = await Support.getConversationByVisitor(visitorId);
    if (!conversation) {
        conversation = await Support.createConversation({
            visitor_id: visitorId,
            user_id: user ? user.id : null,
            customer_name: displayName || null,
            customer_phone: phoneNumber || null,
            ai_enabled: aiAvailable()
        });
    } else {
        const patch = {};
        if (user && conversation.user_id !== user.id) patch.user_id = user.id;
        if (displayName && displayName !== conversation.customer_name) patch.customer_name = displayName;
        if (phoneNumber && phoneNumber !== conversation.customer_phone) patch.customer_phone = phoneNumber;
        if (Object.keys(patch).length) conversation = await Support.update(conversation.id, patch);
    }

    const { message, conversation: updated } = await Support.addMessage({
        conversation_id: conversation.id,
        sender_type: 'customer',
        sender_id: user ? user.id : null,
        sender_name: senderLabel(conversation, displayName),
        content: text
    });
    broadcastMessage(updated, message);
    scheduleAiReply(updated, message.id);
    return { message: publicMessage(message), conversation: customerView(updated) };
}

function senderLabel(conversation, displayName) {
    return displayName || conversation.customer_name || 'Khách';
}

async function customerRead(visitorId) {
    const conversation = await Support.getConversationByVisitor(visitorId);
    if (!conversation) return null;
    const updated = await Support.markRead(conversation.id, 'customer');
    Events.to('staff', 'chat:read', { conversation: Support.brief(updated), by: 'customer' });
    return customerView(updated);
}

async function customerTyping(visitorId, typing) {
    const conversation = await Support.getConversationByVisitor(visitorId);
    if (!conversation) return;
    Events.to('staff', 'chat:typing', { conversation_id: Number(conversation.id), sender: 'customer', typing: !!typing });
}

/** Khách muốn gặp nhân viên (nút "Gặp nhân viên" hoặc do AI gọi request_human). */
async function requestHuman(conversationId, { reason = '', by = 'customer' } = {}) {
    const conversation = await Support.getConversationById(conversationId);
    if (!conversation) throw new ValidationError('Không tìm thấy hội thoại', 404);
    if (conversation.needs_human && !conversation.ai_enabled) return customerView(conversation); // đã chuyển rồi
    let updated = await Support.update(conversation.id, { needs_human: 1, ai_enabled: 0 });
    const note = staffOnline() > 0
        ? 'Mình đã chuyển cuộc trò chuyện cho nhân viên. Nhân viên sẽ phản hồi bạn trong ít phút.'
        : 'Hiện chưa có nhân viên trực tuyến. Mình đã ghi nhận yêu cầu, nhân viên sẽ phản hồi ngay khi có thể.';
    const { message, conversation: withMsg } = await Support.addMessage({
        conversation_id: conversation.id, sender_type: 'system', sender_name: 'Hệ thống', content: note
    });
    updated = withMsg;
    cancelAiReply(conversation.id);
    broadcastMessage(updated, message);
    Events.to('staff', 'chat:handoff', { conversation: Support.brief(updated), reason: reason || null, by });
    return customerView(updated);
}

// ───────────────────────── Nhân viên ─────────────────────────

async function postStaffMessage({ conversationId, staff, content }) {
    const text = cleanText(content, MAX_LEN);
    const conversation = await Support.getConversationById(conversationId);
    if (!conversation) throw new ValidationError('Không tìm thấy hội thoại', 404);
    await Support.update(conversation.id, {
        ai_enabled: 0, // người thật đã tiếp quản
        needs_human: 0,
        assigned_to: conversation.assigned_to || staff.id
    });
    cancelAiReply(conversation.id);
    const { message, conversation: updated } = await Support.addMessage({
        conversation_id: conversation.id,
        sender_type: 'staff',
        sender_id: staff.id,
        sender_name: staff.full_name || staff.username || 'Nhân viên',
        content: text
    });
    broadcastMessage(updated, message);
    return { message: publicMessage(message), conversation: Support.brief(updated) };
}

async function staffRead(conversationId) {
    const conversation = await Support.getConversationById(conversationId);
    if (!conversation) throw new ValidationError('Không tìm thấy hội thoại', 404);
    const updated = await Support.markRead(conversation.id, 'staff');
    Events.to(`visitor:${conversation.visitor_id}`, 'chat:read', { conversation_id: Number(conversation.id), by: 'staff' });
    Events.to('staff', 'chat:read', { conversation: Support.brief(updated), by: 'staff' }); // các tab/nhân viên khác cập nhật số chưa đọc
    return Support.brief(updated);
}

async function staffTyping(conversationId, typing, staff) {
    const conversation = await Support.getConversationById(conversationId);
    if (!conversation) return;
    Events.to(`visitor:${conversation.visitor_id}`, 'chat:typing', {
        conversation_id: Number(conversation.id), sender: 'staff', typing: !!typing, name: staff.full_name || staff.username
    });
}

async function updateConversation(conversationId, patch, staff) {
    const conversation = await Support.getConversationById(conversationId);
    if (!conversation) throw new ValidationError('Không tìm thấy hội thoại', 404);
    const fields = {};
    if (patch.status !== undefined) {
        if (!['open', 'closed'].includes(patch.status)) throw new ValidationError('Trạng thái không hợp lệ');
        fields.status = patch.status;
    }
    if (patch.assign_to_me === true) fields.assigned_to = staff.id;
    if (patch.assign_to_me === false) fields.assigned_to = null;
    if (patch.ai_enabled !== undefined) {
        if (typeof patch.ai_enabled !== 'boolean') throw new ValidationError('ai_enabled phải là true/false');
        if (patch.ai_enabled && !aiAvailable()) throw new ValidationError('AI chưa được cấu hình trên server');
        fields.ai_enabled = patch.ai_enabled ? 1 : 0;
        if (patch.ai_enabled) fields.needs_human = 0;
    }
    if (!Object.keys(fields).length) throw new ValidationError('Không có gì để cập nhật');
    const updated = await Support.update(conversation.id, fields);
    if (!updated.ai_enabled) cancelAiReply(conversation.id);
    if (fields.status === 'closed') {
        const { message, conversation: withMsg } = await Support.addMessage({
            conversation_id: conversation.id, sender_type: 'system', sender_name: 'Hệ thống',
            content: 'Nhân viên đã kết thúc cuộc trò chuyện. Bạn có thể nhắn tin để mở lại bất cứ lúc nào.'
        });
        broadcastMessage(withMsg, message);
        Events.to('staff', 'chat:conversation', { conversation: Support.brief(withMsg) });
        return Support.brief(withMsg);
    }
    Events.to('staff', 'chat:conversation', { conversation: Support.brief(updated) });
    Events.to(`visitor:${updated.visitor_id}`, 'chat:conversation', { conversation: customerView(updated) });
    return Support.brief(updated);
}

// ───────────────────────── Trợ lý AI tự trả lời ─────────────────────────

function cancelAiReply(conversationId) {
    const t = pendingAi.get(Number(conversationId));
    if (t) {
        clearTimeout(t);
        pendingAi.delete(Number(conversationId));
    }
}

function scheduleAiReply(conversation, triggerMessageId) {
    if (!aiAvailable()) return;
    if (!conversation.ai_enabled || conversation.needs_human || conversation.status !== 'open') return;
    const id = Number(conversation.id);
    if (pendingAi.has(id)) return; // đã có lượt chờ: lượt đó sẽ đọc tin mới nhất khi chạy
    const delay = staffOnline() > 0 ? num(process.env.SUPPORT_AI_DELAY_MS, 45000) : num(process.env.SUPPORT_AI_OFFLINE_DELAY_MS, 1200);
    const timer = setTimeout(() => {
        pendingAi.delete(id);
        runAiReply(id, triggerMessageId).catch((e) => console.error('[support-ai] Lỗi:', e.message));
    }, delay);
    timer.unref();
    pendingAi.set(id, timer);
}

function allowTrackLookup(conversationId) {
    const now = Date.now();
    const list = (trackLookups.get(conversationId) || []).filter((t) => now - t < HOUR);
    if (list.length >= 5) { trackLookups.set(conversationId, list); return false; }
    list.push(now);
    trackLookups.set(conversationId, list);
    return true;
}

async function runAiReply(conversationId) {
    let conversation = await Support.getConversationById(conversationId);
    if (!conversation || !conversation.ai_enabled || conversation.needs_human || conversation.status !== 'open') return null;

    const maxPerHour = num(process.env.SUPPORT_AI_MAX_PER_HOUR, 20);
    if ((await Support.countAiMessagesSince(conversationId, HOUR)) >= maxPerHour) {
        await requestHuman(conversationId, { reason: 'Đã đạt giới hạn tin nhắn AI trong giờ', by: 'system' });
        return null;
    }

    const history = await Support.getMessages(conversationId, { limit: 20 });
    if (!history.length || history[history.length - 1].sender_type !== 'customer') return null; // đã có người/AI trả lời sau tin này

    Events.to(`visitor:${conversation.visitor_id}`, 'chat:typing', { conversation_id: Number(conversationId), sender: 'ai', typing: true });
    let text = '';
    let failed = false;
    try {
        text = await assistantFn({
            history,
            requestHuman: (reason) => requestHuman(conversationId, { reason, by: 'ai' }),
            trackLimiter: () => allowTrackLookup(conversationId)
        });
    } catch (error) {
        failed = true;
        console.error('[support-ai] Trợ lý AI lỗi:', error.message);
    } finally {
        Events.to(`visitor:${conversation.visitor_id}`, 'chat:typing', { conversation_id: Number(conversationId), sender: 'ai', typing: false });
    }

    conversation = await Support.getConversationById(conversationId);
    if (!conversation) return null;
    // Trong lúc AI suy nghĩ, nếu NHÂN VIÊN đã vào trả lời (AI bị tắt mà không có cờ needs_human) thì bỏ câu trả lời của AI.
    // Nếu chính AI vừa gọi request_human (needs_human = 1) thì vẫn gửi câu báo cho khách.
    if (!conversation.ai_enabled && !conversation.needs_human) return null;
    if (failed || !text) {
        if (!conversation.needs_human) await requestHuman(conversationId, { reason: 'Trợ lý AI không phản hồi được', by: 'system' });
        return null;
    }
    const { message, conversation: updated } = await Support.addMessage({
        conversation_id: conversationId, sender_type: 'ai', sender_name: AI_NAME, content: text.slice(0, MAX_LEN)
    });
    broadcastMessage(updated, message);
    return publicMessage(message);
}

function shutdown() {
    for (const t of pendingAi.values()) clearTimeout(t);
    pendingAi.clear();
}

module.exports = {
    getVisitorState, postCustomerMessage, customerRead, customerTyping, requestHuman,
    postStaffMessage, staffRead, staffTyping, updateConversation,
    runAiReply, scheduleAiReply, shutdown,
    publicMessage, customerView,
    _setAssistant: (fn) => { assistantFn = fn || assistant.reply; },
    _pendingAi: pendingAi, _cleanText: cleanText
};
