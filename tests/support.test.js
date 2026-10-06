// Kiểm thử chat hỗ trợ khách ↔ nhân viên (realtime) + trợ lý AI tự trả lời. Không cần MySQL/mạng/package ngoài.
// Chạy:  node tests/support.test.js
const assert = require('assert');
const H = require('./helpers/harness');
const { src } = H;
delete process.env.NODE_ENV;
process.env.SUPPORT_AI_OFFLINE_DELAY_MS = '0';
process.env.SUPPORT_AI_DELAY_MS = '120';

// ───────────── mini DB cho bảng chat ─────────────
let W;
const reset = () => { W = { convs: [], msgs: [], nextConv: 1, nextMsg: 1 }; };
reset();
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const norm = (s) => s.replace(/\s+/g, ' ').trim();
function run(s, p = []) {
    let m;
    if (/^INSERT INTO support_conversations/.test(s)) {
        const c = { id: W.nextConv++, visitor_id: p[0], user_id: p[1], customer_name: p[2], customer_phone: p[3], status: 'open', assigned_to: null, ai_enabled: p[4], needs_human: 0, unread_staff: 0, unread_customer: 0, last_message_at: null, last_message_preview: null, created_at: new Date().toISOString() };
        W.convs.push(c); return { result: { insertId: c.id } };
    }
    if (/^SELECT \* FROM support_conversations WHERE id = \?$/.test(s)) return { rows: clone([W.convs.find((c) => c.id === Number(p[0]))].filter(Boolean)) };
    if (/^SELECT \* FROM support_conversations WHERE visitor_id = \? ORDER BY id DESC LIMIT 1/.test(s)) return { rows: clone([...W.convs].filter((c) => c.visitor_id === p[0]).sort((a, b) => b.id - a.id).slice(0, 1)) };
    if (/^INSERT INTO support_messages/.test(s)) {
        const msg = { id: W.nextMsg++, conversation_id: p[0], sender_type: p[1], sender_id: p[2], sender_name: p[3], content: p[4], created_at: new Date() };
        W.msgs.push(msg); return { result: { insertId: msg.id } };
    }
    if (/^UPDATE support_conversations SET last_message_at/.test(s)) {
        const c = W.convs.find((x) => x.id === Number(p[1]));
        c.last_message_at = new Date().toISOString(); c.last_message_preview = p[0];
        if (/unread_staff = unread_staff \+ 1/.test(s)) { c.unread_staff++; c.status = 'open'; }
        if (/unread_customer = unread_customer \+ 1/.test(s)) c.unread_customer++;
        return { result: { affectedRows: 1 } };
    }
    if (/^SELECT \* FROM support_messages WHERE id = \?$/.test(s)) return { rows: clone([W.msgs.find((x) => x.id === Number(p[0]))]) };
    if (/^SELECT \* FROM support_messages WHERE conversation_id = \? AND id > \?/.test(s)) return { rows: clone(W.msgs.filter((x) => x.conversation_id === Number(p[0]) && x.id > p[1]).slice(0, p[2])) };
    if (/^SELECT \* FROM support_messages WHERE conversation_id = \? AND id < \?/.test(s)) return { rows: clone(W.msgs.filter((x) => x.conversation_id === Number(p[0]) && x.id < p[1]).sort((a, b) => b.id - a.id).slice(0, p[2])) };
    if (/^SELECT \* FROM support_messages WHERE conversation_id = \? ORDER BY id DESC LIMIT \?/.test(s)) return { rows: clone(W.msgs.filter((x) => x.conversation_id === Number(p[0])).sort((a, b) => b.id - a.id).slice(0, p[1])) };
    if ((m = /^UPDATE support_conversations SET unread_(staff|customer) = 0 WHERE id = \?/.exec(s))) { W.convs.find((x) => x.id === Number(p[0]))[`unread_${m[1]}`] = 0; return { result: {} }; }
    if ((m = /^UPDATE support_conversations SET (.+) WHERE id = \?$/.exec(s))) {
        const keys = m[1].split(',').map((x) => x.trim().replace(' = ?', '')); const c = W.convs.find((x) => x.id === Number(p[keys.length]));
        keys.forEach((k, i) => { c[k] = p[i]; }); return { result: {} };
    }
    if (/SELECT COUNT\(\*\) AS n FROM support_conversations/.test(s)) return { rows: [{ n: filterConvs(s, p).length }] };
    if (/^SELECT \* FROM support_conversations .*ORDER BY/.test(s)) { const lim = p[p.length - 2], off = p[p.length - 1]; return { rows: clone(filterConvs(s, p.slice(0, -2)).sort((a, b) => (b.unread_staff > 0) - (a.unread_staff > 0) || String(b.last_message_at || b.created_at).localeCompare(String(a.last_message_at || a.created_at))).slice(off, off + lim)) }; }
    if (/SUM\(unread_staff\)/.test(s)) return { rows: [{ n: W.convs.filter((c) => c.status === 'open').reduce((t, c) => t + c.unread_staff, 0) }] };
    if (/sender_type = 'ai' AND created_at >= DATE_SUB/.test(s)) return { rows: [{ n: W.msgs.filter((x) => x.conversation_id === Number(p[0]) && x.sender_type === 'ai' && Date.now() - new Date(x.created_at) <= p[1] * 1000).length }] };
    if (/sender_type = 'staff' ORDER BY id DESC LIMIT 1/.test(s)) return { rows: clone(W.msgs.filter((x) => x.conversation_id === Number(p[0]) && x.sender_type === 'staff').slice(-1).map((x) => ({ id: x.id }))) };
    throw new Error('mini DB: chưa mô phỏng: ' + s.slice(0, 100));
}
function filterConvs(s, p) {
    let rows = [...W.convs]; let i = 0;
    if (/status = \?/.test(s)) { const st = p[i++]; rows = rows.filter((c) => c.status === st); }
    if (/needs_human = 1/.test(s)) rows = rows.filter((c) => c.needs_human);
    if (/customer_name LIKE \?/.test(s)) { const q = String(p[i]).replace(/^%|%$/g, '').replace(/\\(.)/g, '$1').toLowerCase(); rows = rows.filter((c) => [c.customer_name, c.customer_phone, c.last_message_preview].some((f) => String(f || '').toLowerCase().includes(q))); }
    return rows;
}
const client = {
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {},
    query: async (sql, p) => { const r = run(norm(sql), p); return [r.rows !== undefined ? r.rows : r.result]; },
};
const db = {
    getClient: async () => client,
    query: async (sql, p) => { const r = run(norm(sql), p); return r.rows !== undefined ? r.rows : r.result; },
    pool: { query: async (sql, p) => { const r = run(norm(sql), p); return [r.rows !== undefined ? r.rows : r.result]; } },
};

const users = { 5: { id: 5, username: 'khach5', full_name: 'Khách Năm', role: 'customer', status: 'active' } };
const stubs = new Map([
    [src('config/database.js'), db],
    [src('models/User.js'), { getUserById: async (id) => users[id] }],
    [src('models/Product.js'), {}], [src('models/Category.js'), {}], [src('models/Order.js'), {}],
]);
H.install(stubs);

const { hub } = require(src('realtime/hub.js'));
const Support = require(src('models/Support.js'));
const visitor = require(src('services/support/visitor.js'));
const service = require(src('services/support/supportService.js'));
const Ctl = require(src('controllers/supportController.js'));
const { requireVisitor, optionalUser } = require(src('middlewares/supportIdentity.js'));
const Auth = require(src('middlewares/auth.js'));
const supportRoutes = require(src('routes/supportRoutes.js'));
const { issueTicket, consumeTicket } = require(src('realtime/tickets.js'));
const { mkRes, call, mkSse, sleep, capture } = H;
const { test, done } = H.runner();

const connect = (channels, identity) => { const c = mkSse(); hub.add({ req: c.req, res: c.res, channels, identity }); return c; };
const staffUser = { id: 2, username: 'nv', full_name: 'Nhân Viên', role: 'staff' };
const V = () => visitor.create();
const fresh = async () => { reset(); service.shutdown(); service._setAssistant(null); delete process.env.ANTHROPIC_API_KEY; hub.closeAll(); };
const withAi = (fn) => { process.env.ANTHROPIC_API_KEY = 'k'; service._setAssistant(fn); };

(async () => {
    console.log('Phiên khách & danh tính');
    await test('token khách ký số: dùng lại được, sai chữ ký/loại token khác đều bị từ chối', async () => {
        const v = V(); assert.strictEqual(visitor.verify(v.token), v.id);
        assert.strictEqual(visitor.verify(v.token + 'x'), null); assert.strictEqual(visitor.verify('abc'), null); assert.strictEqual(visitor.verify(undefined), null);
        const ticket = issueTicket({ type: 'staff', id: 1, channels: ['staff'] }); assert.strictEqual(visitor.verify(ticket), null, 'vé SSE không dùng làm token khách');
        assert.strictEqual(consumeTicket(v.token), null, 'token khách không dùng làm vé SSE');
        assert.strictEqual(Auth.authenticate !== undefined, true);
    }, fresh);
    await test('POST /session: cấp token mới; có token hợp lệ thì giữ nguyên; token rác thì cấp token mới', async () => {
        let res = await call(Ctl.session, { body: {} });
        const t1 = res.body.data.visitor_token; assert(visitor.verify(t1)); assert.strictEqual(res.body.data.conversation, null); assert.deepStrictEqual(res.body.data.messages, []);
        res = await call(Ctl.session, { body: { visitor_token: t1 } }); assert.strictEqual(res.body.data.visitor_token, t1);
        res = await call(Ctl.session, { body: { visitor_token: 'rac' } }); assert.notStrictEqual(res.body.data.visitor_token, t1); assert(visitor.verify(res.body.data.visitor_token));
        res = await call(Ctl.session, { body: { visitor_token: { a: 1 } } }); assert(visitor.verify(res.body.data.visitor_token), 'kiểu dữ liệu lạ không làm hỏng');
    }, fresh);
    await test('requireVisitor chặn thiếu/sai token; optionalUser gắn user hợp lệ và bỏ qua token đăng nhập hỏng', async () => {
        const run = (headers) => { const res = mkRes(); let ok = false; const req = { headers }; requireVisitor(req, res, () => { ok = true; }); return { res, ok, req }; };
        assert.strictEqual(run({}).res.code, 401); assert.strictEqual(run({ 'x-visitor-token': 'x' }).res.code, 401);
        const v = V(); const good = run({ 'x-visitor-token': v.token }); assert(good.ok && good.req.visitor.id === v.id);
        const { signAccessToken } = require(src('config/jwt.js'));
        const req = { headers: { authorization: `Bearer ${signAccessToken(users[5])}` } }; await optionalUser(req, mkRes(), () => {});
        assert.strictEqual(req.user.id, 5); assert.strictEqual(req.user.role, 'customer');
        const bad = { headers: { authorization: 'Bearer rac.rac.rac' } }; await optionalUser(bad, mkRes(), () => {}); assert.strictEqual(bad.user, undefined);
    }, fresh);

    console.log('Khách nhắn tin');
    await test('tin đầu tiên: tạo hội thoại, lưu tin, báo realtime cho nhân viên và cho chính khách; số chưa đọc tăng', async () => {
        const v = V(); const staff = connect(['staff', 'public'], { type: 'staff', id: 2 }); const mine = connect(['public', `visitor:${v.id}`], { type: 'visitor', id: v.id }); const other = connect(['public', 'visitor:khac'], { type: 'visitor', id: 'khac' });
        const r = await service.postCustomerMessage({ visitorId: v.id, user: null, content: '  Xin chào shop  ', name: 'Lan', phone: '0901 234 567' });
        assert.strictEqual(r.message.content, 'Xin chào shop'); assert.strictEqual(r.message.sender_type, 'customer'); assert.strictEqual(r.conversation.status, 'open');
        assert.deepStrictEqual([W.convs.length, W.msgs.length, W.convs[0].unread_staff, W.convs[0].customer_name, W.convs[0].customer_phone], [1, 1, 1, 'Lan', '0901 234 567']);
        const toStaff = staff.of('chat:message')[0]; assert.strictEqual(toStaff.conversation.visitor_id, v.id); assert.strictEqual(toStaff.conversation.unread_staff, 1); assert.strictEqual(toStaff.message.content, 'Xin chào shop');
        const toMine = mine.of('chat:message')[0]; assert(!('visitor_id' in toMine.conversation) && !('assigned_to' in toMine.conversation), 'khách không thấy thông tin nội bộ');
        assert.strictEqual(other.of('chat:message').length, 0, 'khách khác không nhận được');
    }, fresh);
    await test('tin tiếp theo dùng lại hội thoại; đã đóng thì tự mở lại; gắn tài khoản khi khách đăng nhập', async () => {
        const v = V();
        await service.postCustomerMessage({ visitorId: v.id, content: 'một' });
        await service.postCustomerMessage({ visitorId: v.id, user: users[5], content: 'hai' });
        assert.strictEqual(W.convs.length, 1); assert.strictEqual(W.convs[0].user_id, 5); assert.strictEqual(W.convs[0].customer_name, 'Khách Năm'); assert.strictEqual(W.convs[0].unread_staff, 2);
        W.convs[0].status = 'closed';
        const r = await service.postCustomerMessage({ visitorId: v.id, content: 'ba' }); assert.strictEqual(r.conversation.status, 'open'); assert.strictEqual(W.msgs.length, 3);
    }, fresh);
    await test('kiểm tra tin nhắn: trống, quá dài, sai kiểu, ký tự điều khiển, tên/SĐT sai', async () => {
        const v = V(); const bad = async (args, re) => assert.rejects(service.postCustomerMessage({ visitorId: v.id, ...args }), (e) => e.expose && e.status === 400 && re.test(e.message), JSON.stringify(args).slice(0, 60));
        await bad({ content: '   ' }, /không được để trống/); await bad({ content: 'x'.repeat(2001) }, /quá dài/); await bad({ content: { a: 1 } }, /không hợp lệ/); await bad({ content: 123 }, /không hợp lệ/); await bad({ content: undefined }, /không hợp lệ/);
        await bad({ content: 'ok', phone: 'abcdefgh' }, /Số điện thoại/); await bad({ content: 'ok', name: 'x'.repeat(101) }, /quá dài/);
        assert.strictEqual(W.convs.length, 0, 'tin lỗi không tạo hội thoại');
        const r = await service.postCustomerMessage({ visitorId: v.id, content: 'a\u0000b\u0007c\nd' }); assert.strictEqual(r.message.content, 'abc\nd', 'bỏ ký tự điều khiển, giữ xuống dòng');
        assert.strictEqual((await service.postCustomerMessage({ visitorId: v.id, content: 'x'.repeat(2000) })).message.content.length, 2000);
    }, fresh);
    await test('nội dung tin có HTML/script được lưu nguyên văn dạng văn bản (giao diện chịu trách nhiệm hiển thị an toàn)', async () => {
        const v = V(); const r = await service.postCustomerMessage({ visitorId: v.id, content: '<img src=x onerror=alert(1)>' });
        assert.strictEqual(r.message.content, '<img src=x onerror=alert(1)>');
    }, fresh);

    console.log('Nhân viên trả lời');
    await test('nhân viên trả lời: khách nhận realtime; tắt AI, gán người phụ trách, xóa cờ cần nhân viên; số chưa đọc đúng', async () => {
        const v = V(); const mine = connect(['public', `visitor:${v.id}`], { type: 'visitor', id: v.id });
        const first = await service.postCustomerMessage({ visitorId: v.id, content: 'cần hỗ trợ' }); W.convs[0].needs_human = 1;
        const r = await service.postStaffMessage({ conversationId: first.conversation.id, staff: staffUser, content: 'Chào bạn, mình hỗ trợ ngay' });
        assert.strictEqual(r.message.sender_type, 'staff'); assert.strictEqual(r.message.sender_name, 'Nhân Viên');
        assert.deepStrictEqual([W.convs[0].ai_enabled, W.convs[0].assigned_to, W.convs[0].needs_human, W.convs[0].unread_customer], [0, 2, 0, 1]);
        assert.strictEqual(mine.of('chat:message').at(-1).message.content, 'Chào bạn, mình hỗ trợ ngay'); assert.strictEqual(mine.of('chat:message').at(-1).conversation.unread_customer, 1);
        await assert.rejects(service.postStaffMessage({ conversationId: 999, staff: staffUser, content: 'x' }), (e) => e.status === 404);
        await assert.rejects(service.postStaffMessage({ conversationId: 1, staff: staffUser, content: '  ' }), (e) => e.status === 400);
    }, fresh);
    await test('đã đọc: khách đọc → nhân viên thấy; nhân viên đọc → khách thấy và các nhân viên khác cập nhật số chưa đọc', async () => {
        const v = V(); const staff = connect(['staff', 'public'], { type: 'staff', id: 2 }); const mine = connect(['public', `visitor:${v.id}`], { type: 'visitor', id: v.id });
        const first = await service.postCustomerMessage({ visitorId: v.id, content: 'a' }); const cid = first.conversation.id;
        await service.staffRead(cid); assert.strictEqual(W.convs[0].unread_staff, 0);
        assert.strictEqual(mine.of('chat:read').at(-1).by, 'staff'); assert.strictEqual(staff.of('chat:read').at(-1).conversation.unread_staff, 0);
        await service.postStaffMessage({ conversationId: cid, staff: staffUser, content: 'b' });
        const view = await service.customerRead(v.id); assert.strictEqual(view.unread_customer, 0); assert.strictEqual(staff.of('chat:read').at(-1).by, 'customer');
        assert.strictEqual(await service.customerRead('chua-co'), null);
    }, fresh);
    await test('đang gõ: tới đúng người (khách → nhân viên; nhân viên → đúng khách đó)', async () => {
        const a = V(), b = V(); const staff = connect(['staff'], { type: 'staff', id: 2 }); const ca = connect([`visitor:${a.id}`], { type: 'visitor', id: a.id }); const cb = connect([`visitor:${b.id}`], { type: 'visitor', id: b.id });
        const first = await service.postCustomerMessage({ visitorId: a.id, content: 'hi' });
        await service.customerTyping(a.id, true); assert.deepStrictEqual(staff.of('chat:typing').at(-1), { conversation_id: first.conversation.id, sender: 'customer', typing: true });
        await service.staffTyping(first.conversation.id, true, staffUser); assert.strictEqual(ca.of('chat:typing').at(-1).sender, 'staff'); assert.strictEqual(cb.of('chat:typing').length, 0);
        await service.customerTyping('khong-co', true); // không lỗi
    }, fresh);
    await test('đóng/mở hội thoại, gán người phụ trách, giá trị sai bị từ chối; đóng thì thông báo cho khách', async () => {
        const v = V(); const mine = connect([`visitor:${v.id}`], { type: 'visitor', id: v.id });
        const first = await service.postCustomerMessage({ visitorId: v.id, content: 'hi' }); const id = first.conversation.id;
        const closed = await service.updateConversation(id, { status: 'closed' }, staffUser); assert.strictEqual(closed.status, 'closed');
        assert(/kết thúc cuộc trò chuyện/.test(mine.of('chat:message').at(-1).message.content)); assert.strictEqual(mine.of('chat:message').at(-1).message.sender_type, 'system');
        assert.strictEqual((await service.updateConversation(id, { assign_to_me: true }, staffUser)).assigned_to, 2);
        for (const bad of [{ status: 'xoa' }, {}, { ai_enabled: 'yes' }, { ai_enabled: true }]) await assert.rejects(service.updateConversation(id, bad, staffUser), (e) => e.status === 400, JSON.stringify(bad));
        await assert.rejects(service.updateConversation(999, { status: 'open' }, staffUser), (e) => e.status === 404);
    }, fresh);

    console.log('Chuyển cho nhân viên');
    await test('requestHuman: bật cờ, tắt AI, tin hệ thống phù hợp online/offline, báo handoff cho nhân viên, idempotent', async () => {
        const v = V(); const first = await service.postCustomerMessage({ visitorId: v.id, content: 'tôi muốn gặp người thật' }); const id = first.conversation.id;
        const view = await service.requestHuman(id, { by: 'customer' });
        assert.strictEqual(view.needs_human, true); assert.strictEqual(view.ai_enabled, false);
        assert(/chưa có nhân viên trực tuyến/.test(W.msgs.at(-1).content)); assert.strictEqual(W.msgs.at(-1).sender_type, 'system');
        const n = W.msgs.length; await service.requestHuman(id, { by: 'customer' }); assert.strictEqual(W.msgs.length, n, 'gọi lại không tạo thêm tin hệ thống');
        const staff = connect(['staff', 'public'], { type: 'staff', id: 2 });
        const v2 = V(); const f2 = await service.postCustomerMessage({ visitorId: v2.id, content: 'cần gặp' }); await service.requestHuman(f2.conversation.id, { reason: 'khiếu nại đổi trả', by: 'ai' });
        assert(/trong ít phút/.test(W.msgs.at(-1).content)); assert.deepStrictEqual([staff.of('chat:handoff').at(-1).reason, staff.of('chat:handoff').at(-1).by], ['khiếu nại đổi trả', 'ai']);
        await assert.rejects(service.requestHuman(999), (e) => e.status === 404);
    }, fresh);

    console.log('Trợ lý AI tự trả lời');
    const ctxFn = (reply) => async (args) => reply(args);
    await test('không có API key → AI không bao giờ tự trả lời, hội thoại tạo ra với ai_enabled = 0', async () => {
        let called = 0; service._setAssistant(async () => { called++; return 'x'; });
        const v = V(); await service.postCustomerMessage({ visitorId: v.id, content: 'giá laptop?' }); await sleep(60);
        assert.strictEqual(called, 0); assert.strictEqual(W.convs[0].ai_enabled, 0); assert.strictEqual(W.msgs.length, 1);
    }, fresh);
    await test('không ai trực tuyến: AI trả lời gần như ngay, tin có sender_type=ai và báo realtime kèm trạng thái "đang soạn"', async () => {
        withAi(ctxFn(async ({ history }) => `Chào bạn! (đã đọc ${history.length} tin)`));
        const v = V(); const mine = connect([`visitor:${v.id}`], { type: 'visitor', id: v.id }); const staff = connect(['staff'], { type: 'staff', id: 2 }); staff.res.end();
        await service.postCustomerMessage({ visitorId: v.id, content: 'giá laptop?' }); await sleep(80);
        const ai = W.msgs.find((m) => m.sender_type === 'ai'); assert(ai); assert.strictEqual(ai.content, 'Chào bạn! (đã đọc 1 tin)'); assert.strictEqual(ai.sender_name, 'Trợ lý AI'); assert.strictEqual(W.convs[0].unread_customer, 1);
        assert.deepStrictEqual(mine.of('chat:typing').map((t) => [t.sender, t.typing]), [['ai', true], ['ai', false]]);
        assert.strictEqual(mine.of('chat:message').at(-1).message.sender_type, 'ai');
    }, fresh);
    await test('có nhân viên trực tuyến: AI chờ nhường nhân viên; nhân viên trả lời trong thời gian chờ thì AI hủy', async () => {
        let calls = 0; withAi(ctxFn(async () => { calls++; return 'AI trả lời'; }));
        const staff = connect(['staff', 'public'], { type: 'staff', id: 2 });
        const v = V(); const first = await service.postCustomerMessage({ visitorId: v.id, content: 'cần tư vấn' });
        await sleep(40); assert.strictEqual(calls, 0, 'chưa tới giờ'); assert.strictEqual(service._pendingAi.size, 1);
        await service.postStaffMessage({ conversationId: first.conversation.id, staff: staffUser, content: 'Mình đây' });
        assert.strictEqual(service._pendingAi.size, 0, 'nhân viên trả lời → hủy lượt AI'); await sleep(200); assert.strictEqual(calls, 0);
        assert(!W.msgs.some((m) => m.sender_type === 'ai'));
        const v2 = V(); await service.postCustomerMessage({ visitorId: v2.id, content: 'hỏi nữa' }); await sleep(220);
        assert.strictEqual(calls, 1, 'không ai trả lời → AI tự trả lời sau thời gian chờ'); staff.res.end();
    }, fresh);
    await test('AI không trả lời khi: cần nhân viên, AI bị tắt, hội thoại đã đóng; nhiều tin liên tiếp chỉ gây 1 lượt', async () => {
        let calls = 0; withAi(ctxFn(async () => { calls++; return 'trả lời'; }));
        const a = V(); await service.postCustomerMessage({ visitorId: a.id, content: '1' }); await service.postCustomerMessage({ visitorId: a.id, content: '2' }); await service.postCustomerMessage({ visitorId: a.id, content: '3' }); await sleep(80);
        assert.strictEqual(calls, 1, 'gộp thành 1 lượt'); assert.strictEqual(W.msgs.filter((m) => m.sender_type === 'ai').length, 1);
        W.convs[0].needs_human = 1; await service.postCustomerMessage({ visitorId: a.id, content: '4' }); await sleep(60); assert.strictEqual(calls, 1);
        W.convs[0].needs_human = 0; W.convs[0].ai_enabled = 0; await service.postCustomerMessage({ visitorId: a.id, content: '5' }); await sleep(60); assert.strictEqual(calls, 1);
        const direct = await service.runAiReply(W.convs[0].id); assert.strictEqual(direct, null);
    }, fresh);
    await test('AI lỗi hoặc trả lời rỗng → chuyển cho nhân viên (cờ + tin hệ thống), không gửi tin AI', async () => {
        for (const behavior of [async () => { throw new Error('API down'); }, async () => '']) {
            reset(); withAi(behavior);
            const v = V(); await capture(async () => { await service.postCustomerMessage({ visitorId: v.id, content: 'giúp mình' }); await sleep(80); });
            assert.strictEqual(W.convs[0].needs_human, 1); assert.strictEqual(W.convs[0].ai_enabled, 0); assert(!W.msgs.some((m) => m.sender_type === 'ai')); assert.strictEqual(W.msgs.at(-1).sender_type, 'system');
        }
    }, fresh);
    await test('AI gọi request_human: tin báo cho khách VẪN được gửi sau khi chuyển; nhân viên tiếp quản giữa chừng thì bỏ tin AI', async () => {
        withAi(async ({ requestHuman }) => { await requestHuman('khách khiếu nại'); return 'Mình đã chuyển cho nhân viên nhé.'; });
        const v = V(); await service.postCustomerMessage({ visitorId: v.id, content: 'tôi muốn khiếu nại' }); await sleep(80);
        assert.strictEqual(W.convs[0].needs_human, 1); assert(W.msgs.some((m) => m.sender_type === 'ai' && /chuyển cho nhân viên/.test(m.content)));
        reset(); let release; const gate = new Promise((r) => { release = r; });
        withAi(async () => { await gate; return 'AI đến muộn'; });
        const v2 = V(); const first = await service.postCustomerMessage({ visitorId: v2.id, content: 'hỏi' }); await sleep(40);
        await service.postStaffMessage({ conversationId: first.conversation.id, staff: staffUser, content: 'nhân viên vào trước' }); release(); await sleep(40);
        assert(!W.msgs.some((m) => m.sender_type === 'ai'), 'bỏ câu trả lời AI khi nhân viên đã tiếp quản');
    }, fresh);
    await test('giới hạn chi phí: quá số tin AI/giờ → tự chuyển cho nhân viên thay vì gọi AI tiếp', async () => {
        process.env.SUPPORT_AI_MAX_PER_HOUR = '2'; let calls = 0; withAi(ctxFn(async () => { calls++; return 'ok'; }));
        const v = V();
        for (let i = 0; i < 3; i++) { await service.postCustomerMessage({ visitorId: v.id, content: `câu ${i}` }); await sleep(60); }
        delete process.env.SUPPORT_AI_MAX_PER_HOUR;
        assert.strictEqual(calls, 2); assert.strictEqual(W.convs[0].needs_human, 1);
    }, fresh);
    await test('ngữ cảnh AI nhận được: lịch sử đúng thứ tự, AI không nhận tin hệ thống', async () => {
        let seen; withAi(async ({ history }) => { seen = history.map((m) => `${m.sender_type}:${m.content}`); return 'ok'; });
        const v = V(); const first = await service.postCustomerMessage({ visitorId: v.id, content: 'a' }); await sleep(60);
        await service.postCustomerMessage({ visitorId: v.id, content: 'b' }); await sleep(60);
        assert.deepStrictEqual(seen, ['customer:a', 'ai:ok', 'customer:b']);
    }, fresh);

    console.log('Controller & route');
    await test('API khách: gửi tin, đồng bộ sau khi mất kết nối (after_id), tải lịch sử cũ (before_id), id sai bị chặn', async () => {
        const v = V(); const req = (extra) => ({ visitor: { id: v.id }, ...extra });
        for (let i = 1; i <= 4; i++) await call(Ctl.send, req({ body: { content: `tin ${i}` } }));
        let res = await call(Ctl.messages, req({ query: { after_id: '2' } })); assert.deepStrictEqual(res.body.data.map((m) => m.content), ['tin 3', 'tin 4']);
        res = await call(Ctl.messages, req({ query: { before_id: '3' } })); assert.deepStrictEqual(res.body.data.map((m) => m.content), ['tin 1', 'tin 2']);
        for (const q of [{ after_id: 'abc' }, { after_id: '-1' }, { before_id: '0' }, { after_id: { a: 1 } }]) assert.strictEqual((await call(Ctl.messages, req({ query: q }))).code, 400, JSON.stringify(q));
        res = await call(Ctl.conversation, req()); assert.strictEqual(res.body.data.messages.length, 4); assert.strictEqual(res.body.data.conversation.unread_customer, 0);
        assert.deepStrictEqual((await call(Ctl.messages, { visitor: { id: 'chua-co' }, query: {} })).body.data, []);
        assert.strictEqual((await call(Ctl.send, req({ body: { content: '' } }))).code, 400);
        assert.strictEqual((await call(Ctl.requestHuman, { visitor: { id: 'chua-co' } })).code, 400);
    }, fresh);
    await test('khách không đọc được hội thoại của người khác (mỗi token chỉ thấy hội thoại của chính mình)', async () => {
        const a = V(), b = V(); await call(Ctl.send, { visitor: { id: a.id }, body: { content: 'bí mật của A' } });
        const rb = await call(Ctl.conversation, { visitor: { id: b.id } }); assert.strictEqual(rb.body.data.conversation, null); assert.deepStrictEqual(rb.body.data.messages, []);
        assert.deepStrictEqual((await call(Ctl.messages, { visitor: { id: b.id }, query: {} })).body.data, []);
    }, fresh);
    await test('vé SSE của khách chỉ có kênh của chính họ + public (không có kênh staff hay của khách khác)', async () => {
        const v = V(); const res = await call(Ctl.ticket, { visitor: { id: v.id } }); const claims = consumeTicket(res.body.data.ticket);
        assert.deepStrictEqual(claims.channels, ['public', `visitor:${v.id}`]); assert.strictEqual(claims.type, 'visitor');
    }, fresh);
    await test('API nhân viên: danh sách (lọc/tìm kiếm/phân trang, chưa đọc lên đầu), chi tiết, trả lời, đã đọc, cập nhật, bộ đếm', async () => {
        const a = V(), b = V(), c = V();
        await service.postCustomerMessage({ visitorId: a.id, content: 'hỏi về laptop', name: 'An' });
        await service.postCustomerMessage({ visitorId: b.id, content: 'bảo hành RAM', name: 'Bình', phone: '0909000111' });
        await service.postCustomerMessage({ visitorId: c.id, content: 'đã xong', name: 'Chi' }); await service.staffRead(3);
        let res = await call(Ctl.listConversations, { query: {} });
        assert.strictEqual(res.body.data.length, 3); assert.strictEqual(res.body.meta.unread_total, 2); assert.strictEqual(res.body.data[2].customer_name, 'Chi', 'đã đọc xuống cuối');
        assert.deepStrictEqual((await call(Ctl.listConversations, { query: { search: 'bảo hành' } })).body.data.map((x) => x.customer_name), ['Bình']);
        assert.deepStrictEqual((await call(Ctl.listConversations, { query: { search: '0909' } })).body.data.map((x) => x.customer_name), ['Bình']);
        assert.strictEqual((await call(Ctl.listConversations, { query: { limit: '2' } })).body.meta.pages, 2);
        for (const q of [{ status: 'xoa' }, { search: ['a'] }, { page: { a: 1 } }]) assert.strictEqual((await call(Ctl.listConversations, { query: q })).code, 400, JSON.stringify(q));
        res = await call(Ctl.getConversation, { params: { id: '2' } }); assert.strictEqual(res.body.data.messages[0].content, 'bảo hành RAM'); assert.strictEqual(res.body.data.conversation.customer_phone, '0909000111');
        assert.strictEqual((await call(Ctl.getConversation, { params: { id: '99' } })).code, 404); assert.strictEqual((await call(Ctl.getConversation, { params: { id: 'abc' } })).code, 400);
        res = await call(Ctl.reply, { params: { id: '2' }, user: staffUser, body: { content: 'Bên mình bảo hành 36 tháng ạ' } }); assert.strictEqual(res.code, 201);
        assert.strictEqual((await call(Ctl.staffRead, { params: { id: '2' } })).body.data.unread_staff, 0);
        res = await call(Ctl.update, { params: { id: '2' }, user: staffUser, body: { status: 'closed' } }); assert.strictEqual(res.body.data.status, 'closed');
        assert.deepStrictEqual((await call(Ctl.listConversations, { query: { status: 'open' } })).body.data.map((x) => x.customer_name).sort(), ['An', 'Chi']);
        assert.strictEqual((await call(Ctl.unread, {})).body.data.unread_total, 1);
        assert.strictEqual((await call(Ctl.staffTyping, { params: { id: '1' }, user: staffUser, body: { typing: true } })).body.success, true);
    }, fresh);
    await test('wiring route: khách cần X-Visitor-Token, nhân viên cần đăng nhập + quyền nhân viên (trước mọi route /staff)', async () => {
        const find = (m, p) => supportRoutes.routes.find((r) => r.method === m && r.path === p);
        assert.strictEqual(find('post', '/session').handlers.includes(requireVisitor), false, 'session cấp token nên không đòi token');
        for (const [m, p] of [['get', '/conversation'], ['get', '/messages'], ['post', '/messages'], ['post', '/read'], ['post', '/typing'], ['post', '/request-human'], ['post', '/ticket']]) assert(find(m, p).handlers.includes(requireVisitor), `${m} ${p}`);
        assert.strictEqual(find('post', '/messages').handlers.indexOf(requireVisitor) < find('post', '/messages').handlers.indexOf(optionalUser), true);
        const guard = supportRoutes.routes.find((r) => r.method === 'use' && r.path === '/staff');
        assert.deepStrictEqual(guard.handlers, [Auth.authenticate, Auth.authorizeStaff]);
        const order = supportRoutes.routes.map((r) => `${r.method} ${r.path}`);
        for (const r of supportRoutes.routes.filter((x) => x.path.startsWith('/staff/') )) assert(order.indexOf('use /staff') < order.indexOf(`${r.method} ${r.path}`), r.path);
        assert(!supportRoutes.routes.some((r) => r.path.startsWith('/staff') && r.method !== 'use' && r.handlers.includes(requireVisitor)), 'route nhân viên không nhận token khách');
    }, fresh);

    await fresh(); hub.dispose(); done(); setImmediate(() => process.exit(process.exitCode || 0));
})();
