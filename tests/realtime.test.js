// Kiểm thử lõi realtime (SSE hub, vé kết nối, sự kiện, controller) — không cần mạng hay package ngoài.
// Chạy:  node tests/realtime.test.js
const Module = require('module');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const BE = path.join(__dirname, '..', 'src');
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123456';
delete process.env.NODE_ENV;

const b64 = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');
const fakeJwt = {
    sign(payload, secret, opts = {}) {
        const now = Math.floor(Date.now() / 1000);
        const body = { ...payload, iat: now, ...(opts.expiresIn ? { exp: now + opts.expiresIn } : {}) };
        const d = `${b64({ alg: 'HS256' })}.${b64(body)}`;
        return `${d}.${crypto.createHmac('sha256', secret).update(d).digest('base64url')}`;
    },
    verify(token, secret) {
        const [h, p, s] = String(token).split('.');
        if (!h || !p || !s || crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url') !== s) throw new Error('invalid signature');
        const body = JSON.parse(Buffer.from(p, 'base64url').toString());
        if (body.exp && body.exp < Math.floor(Date.now() / 1000)) throw new Error('jwt expired');
        return body;
    },
    decode: () => null,
};
const origLoad = Module._load;
Module._load = function (request) {
    if (request === 'jsonwebtoken') return fakeJwt;
    if (request === 'dotenv') return { config() {} };
    return origLoad.apply(this, arguments);
};

const { Hub } = require(path.join(BE, 'realtime/hub.js'));
const Tickets = require(path.join(BE, 'realtime/tickets.js'));
const RealtimeController = require(path.join(BE, 'controllers/realtimeController.js'));
const hubModule = require(path.join(BE, 'realtime/hub.js'));
const Events = require(path.join(BE, 'realtime/events.js'));

// res/req giả của SSE: ghi lại những gì được ghi ra
const mkSse = () => {
    const res = new EventEmitter();
    res.written = []; res.ended = false; res.head = null; res.writableLength = 0;
    res.writeHead = (c, h) => { res.head = { code: c, headers: h }; };
    res.write = (chunk) => { if (res.ended) throw new Error('write after end'); res.written.push(chunk); return true; };
    res.end = () => { res.ended = true; res.emit('close'); };
    const req = new EventEmitter();
    return { req, res, text: () => res.written.join(''), events: () => [...res.written.join('').matchAll(/event: (\S+)\ndata: (.*)\n/g)].map((m) => [m[1], JSON.parse(m[2])]) };
};
const mkRes = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };

let passed = 0;
const test = async (name, fn) => {
    try { await fn(); passed++; console.log('  ✓', name); }
    catch (e) { console.log('  ✗', name, '\n   ', e.stack.split('\n').slice(0, 4).join('\n    ')); process.exitCode = 1; }
};
const newHub = (o) => new Hub({ heartbeatMs: 1e9, ...o });
const connect = (hub, channels, identity) => { const c = mkSse(); const client = hub.add({ req: c.req, res: c.res, channels, identity }); return { ...c, client }; };

(async () => {
    console.log('Hub SSE');
    await test('mở luồng: header SSE đúng, có retry + sự kiện ready; không lộ kênh "public"', () => {
        const hub = newHub(); const c = connect(hub, ['staff', 'public', 'user:1'], { type: 'staff', id: 1 });
        assert.strictEqual(c.res.head.code, 200);
        assert(/text\/event-stream/.test(c.res.head.headers['Content-Type']) && /no-cache/.test(c.res.head.headers['Cache-Control']) && c.res.head.headers['X-Accel-Buffering'] === 'no');
        assert(c.text().startsWith('retry: 3000'));
        const ready = c.events().find(([e]) => e === 'ready')[1];
        assert.deepStrictEqual(ready.channels, ['staff', 'user:1']); hub.dispose();
    });
    await test('publish chỉ tới đúng kênh; dữ liệu là JSON hợp lệ kể cả tiếng Việt và ký tự xuống dòng', () => {
        const hub = newHub();
        const staff = connect(hub, ['staff'], { type: 'staff', id: 1 }); const visitor = connect(hub, ['visitor:abc'], { type: 'visitor', id: 'abc' }); const other = connect(hub, ['visitor:xyz'], { type: 'visitor', id: 'xyz' });
        assert.strictEqual(hub.publish('visitor:abc', 'chat:message', { content: 'Xin chào\nDòng 2 "trích dẫn" 😀' }), 1);
        assert.strictEqual(hub.publish('staff', 'order:new', { id: 5 }), 1);
        assert.strictEqual(hub.publish('khong-co', 'x', {}), 0);
        const msg = visitor.events().find(([e]) => e === 'chat:message');
        assert.strictEqual(msg[1].content, 'Xin chào\nDòng 2 "trích dẫn" 😀');
        assert(!visitor.text().includes('order:new') && !other.text().includes('chat:message') && staff.events().some(([e]) => e === 'order:new'));
        assert(!/data: .*\n.*\n\n$/.test('') ); hub.dispose();
    });
    await test('đếm nhân viên trực tuyến theo NGƯỜI (nhiều tab = 1) và phát presence cho kênh public', () => {
        const hub = newHub();
        const guest = connect(hub, ['public', 'visitor:a'], { type: 'visitor', id: 'a' });
        assert.deepStrictEqual(guest.events().filter(([e]) => e === 'presence').at(-1)?.[1] ?? { staff_online: 0 }, { staff_online: 0 });
        const t1 = connect(hub, ['staff', 'public'], { type: 'staff', id: 7 }); const t2 = connect(hub, ['staff', 'public'], { type: 'staff', id: 7 }); const other = connect(hub, ['staff', 'public'], { type: 'staff', id: 8 });
        assert.strictEqual(hub.countStaffOnline(), 2);
        assert.deepStrictEqual(guest.events().filter(([e]) => e === 'presence').at(-1)[1], { staff_online: 2 });
        t1.res.end(); assert.strictEqual(hub.countStaffOnline(), 2, 'còn tab thứ hai của nhân viên 7');
        t2.res.end(); other.res.end();
        assert.strictEqual(hub.countStaffOnline(), 0); assert.deepStrictEqual(guest.events().filter(([e]) => e === 'presence').at(-1)[1], { staff_online: 0 }); hub.dispose();
    });
    await test('ngắt kết nối (close) thì dọn client; ghi lỗi thì tự loại client hỏng, các client khác vẫn nhận', () => {
        const hub = newHub(); const a = connect(hub, ['staff'], { type: 'staff', id: 1 }); const b = connect(hub, ['staff'], { type: 'staff', id: 2 });
        a.res.write = () => { throw new Error('EPIPE'); };
        assert.strictEqual(hub.publish('staff', 'x', {}), 1); assert.strictEqual(hub.stats().connections, 1);
        b.req.emit('close'); assert.strictEqual(hub.stats().connections, 0); hub.dispose();
    });
    await test('giới hạn kết nối: mỗi danh tính tối đa N (ngắt cái cũ nhất); tổng tối đa maxClients', () => {
        const hub = newHub({ maxPerIdentity: 2, maxClients: 3 });
        const c1 = connect(hub, ['staff'], { type: 'staff', id: 1 }), c2 = connect(hub, ['staff'], { type: 'staff', id: 1 }), c3 = connect(hub, ['staff'], { type: 'staff', id: 1 });
        assert(c1.res.ended && !c2.res.ended && !c3.res.ended, 'tab cũ nhất bị ngắt');
        connect(hub, ['staff'], { type: 'staff', id: 2 });
        const over = mkSse(); assert.strictEqual(hub.add({ req: over.req, res: over.res, channels: ['staff'], identity: { type: 'staff', id: 3 } }), null); hub.dispose();
    });
    await test('client đọc quá chậm (bộ đệm quá lớn) bị ngắt để không tốn bộ nhớ', () => {
        const hub = newHub(); const c = connect(hub, ['staff'], { type: 'staff', id: 1 }); c.res.writableLength = 5 * 1024 * 1024;
        hub.publish('staff', 'x', {}); assert.strictEqual(hub.stats().connections, 0); assert(c.res.ended); hub.dispose();
    });
    await test('heartbeat giữ kết nối sống; closeAll báo shutdown rồi đóng hết', () => {
        const hub = newHub(); const c = connect(hub, ['staff'], { type: 'staff', id: 1 });
        hub.heartbeat(); assert(c.text().includes(': ping')); hub.closeAll();
        assert(c.text().includes('event: shutdown') && c.res.ended && hub.stats().connections === 0); hub.dispose();
    });

    console.log('Vé kết nối');
    await test('vé dùng được đúng MỘT lần; kênh do server quyết định; sai/hết hạn/loại khác đều bị từ chối', () => {
        const ticket = Tickets.issueTicket({ type: 'staff', id: 3, channels: ['staff', 'public'] });
        assert.deepStrictEqual(Tickets.consumeTicket(ticket), { type: 'staff', id: '3', channels: ['staff', 'public'] });
        assert.strictEqual(Tickets.consumeTicket(ticket), null, 'dùng lần hai bị từ chối');
        for (const bad of ['', 'abc', 'a.b.c', undefined, null, 123]) assert.strictEqual(Tickets.consumeTicket(bad), null);
        const forged = fakeJwt.sign({ t: 'staff', sub: '1', ch: ['staff'], jti: 'x', purpose: 'sse' }, 'secret-khac', { expiresIn: 60 });
        assert.strictEqual(Tickets.consumeTicket(forged), null);
        const wrongPurpose = fakeJwt.sign({ t: 'staff', sub: '1', ch: ['staff'], jti: 'y', purpose: 'visitor' }, `${process.env.JWT_SECRET}:sse`, { expiresIn: 60 });
        assert.strictEqual(Tickets.consumeTicket(wrongPurpose), null);
        const accessToken = fakeJwt.sign({ id: 1, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: 60 });
        assert.strictEqual(Tickets.consumeTicket(accessToken), null, 'token đăng nhập không dùng làm vé được');
        const fresh = Tickets.issueTicket({ type: 'user', id: 1, channels: [] }); // phát hành TRƯỚC khi dịch đồng hồ
        const real = Date.now; Date.now = () => real() + 61000;
        try { assert.strictEqual(Tickets.consumeTicket(fresh), null, 'hết hạn sau 60s'); } finally { Date.now = real; }
    });

    console.log('Controller');
    await test('xin vé: nhân viên nhận kênh staff; khách hàng KHÔNG nhận kênh staff', () => {
        const get = (user) => { const res = mkRes(); RealtimeController.ticket({ user }, res); return Tickets.consumeTicket(res.body.data.ticket); };
        assert.deepStrictEqual(get({ id: 1, role: 'admin' }).channels, ['staff', 'public', 'user:1']);
        assert.strictEqual(get({ id: 2, role: 'staff' }).type, 'staff');
        const cust = get({ id: 9, role: 'customer' }); assert.deepStrictEqual(cust.channels, ['public', 'user:9']); assert.strictEqual(cust.type, 'user');
    });
    await test('stream: vé sai → 401; vé đúng → mở luồng đúng kênh; dùng lại vé → 401', () => {
        const bad = mkRes(); RealtimeController.stream({ query: { ticket: 'rac' } }, bad); assert.strictEqual(bad.code, 401);
        assert.strictEqual((() => { const r = mkRes(); RealtimeController.stream({ query: {} }, r); return r.code; })(), 401);
        assert.strictEqual((() => { const r = mkRes(); RealtimeController.stream({ query: { ticket: ['a'] } }, r); return r.code; })(), 401);
        const t = Tickets.issueTicket({ type: 'staff', id: 5, channels: ['staff', 'public'] });
        const c = mkSse(); RealtimeController.stream({ ...c.req, query: { ticket: t }, on: c.req.on.bind(c.req) }, c.res);
        assert.strictEqual(c.res.head.code, 200); assert(hubModule.hub.clients.size >= 1);
        const again = mkRes(); RealtimeController.stream({ query: { ticket: t } }, again); assert.strictEqual(again.code, 401);
        c.res.end();
    });

    console.log('Sự kiện nghiệp vụ');
    await test('orderNew/orderUpdated/productChanged tới nhân viên (không tới khách); lỗi realtime không làm hỏng request', () => {
        const staff = connect(hubModule.hub, ['staff'], { type: 'staff', id: 41 }); const guest = connect(hubModule.hub, ['public', 'visitor:q'], { type: 'visitor', id: 'q' });
        Events.orderNew({ id: 7, order_code: 'ORD-7', customer_name: 'A', total_amount: '2030000.00', status: 'pending', payment_status: 'pending', created_at: 'now', customer_phone: '0901', customer_address: 'bí mật' });
        Events.orderUpdated({ id: 7, order_code: 'ORD-7', customer_name: 'A', total_amount: 5, status: 'processing' }, { id: 1, name: 'admin' });
        Events.productChanged([3, undefined, 4]);
        const ev = staff.events();
        const created = ev.find(([e]) => e === 'order:new')[1];
        assert.deepStrictEqual(Object.keys(created).sort(), ['created_at', 'customer_name', 'id', 'order_code', 'payment_status', 'status', 'total_amount'], 'không rò số điện thoại/địa chỉ');
        assert.strictEqual(created.total_amount, 2030000);
        assert.deepStrictEqual(ev.find(([e]) => e === 'product:changed')[1], { ids: [3, 4] });
        assert(ev.filter(([e]) => e === 'stats:dirty').length === 3);
        assert(!guest.events().some(([e]) => /order|product|stats/.test(e)), 'khách không nhận sự kiện của nhân viên');
        const orig = hubModule.hub.publish; hubModule.hub.publish = () => { throw new Error('boom'); };
        const quiet = console.error; console.error = () => {};
        try { assert.doesNotThrow(() => Events.orderNew({ id: 1 })); } finally { hubModule.hub.publish = orig; console.error = quiet; }
        staff.res.end(); guest.res.end();
    });

    console.log(`\n${passed} test đạt`);
    hubModule.hub.dispose(); setImmediate(() => process.exit(process.exitCode || 0));
})();
