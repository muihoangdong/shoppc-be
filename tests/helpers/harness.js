// Tiện ích dùng chung cho các bộ test: thư viện giả (jsonwebtoken, bcryptjs, express, dotenv) + nạp module có thay thế.
const Module = require('module');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const BE = path.join(__dirname, '..', '..', 'src');
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123456';

const b64 = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');
const hmac = (d, s) => crypto.createHmac('sha256', s).update(d).digest('base64url');
const ttl = (e) => (typeof e === 'number' ? e : { m: 60, h: 3600, d: 86400 }[String(e).slice(-1)] * parseInt(e, 10));
const fakeJwt = {
    sign(payload, secret, opts = {}) {
        const now = Math.floor(Date.now() / 1000);
        const body = { ...payload, iat: now, ...(opts.expiresIn ? { exp: now + ttl(opts.expiresIn) } : {}) };
        const d = `${b64({ alg: 'HS256' })}.${b64(body)}`;
        return `${d}.${hmac(d, secret)}`;
    },
    verify(token, secret) {
        const [h, p, s] = String(token).split('.');
        if (!h || !p || !s || hmac(`${h}.${p}`, secret) !== s) throw new Error('invalid signature');
        const body = JSON.parse(Buffer.from(p, 'base64url').toString());
        if (body.exp && body.exp < Math.floor(Date.now() / 1000)) throw new Error('jwt expired');
        return body;
    },
    decode(token) { try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString()); } catch { return null; } },
};
const fakeExpress = () => ({});
fakeExpress.Router = () => {
    const r = { routes: [] };
    for (const m of ['get', 'post', 'put', 'patch', 'delete']) r[m] = (p, ...handlers) => r.routes.push({ method: m, path: p, handlers });
    r.use = (p, ...handlers) => r.routes.push({ method: 'use', path: typeof p === 'string' ? p : '*', handlers: typeof p === 'string' ? handlers : [p, ...handlers] });
    return r;
};

/** stubs: Map<đường dẫn tuyệt đối trong src, module giả> */
function install(stubs = new Map(), external = {}) {
    const ext = { express: fakeExpress, jsonwebtoken: fakeJwt, bcryptjs: { hash: async (p) => `h:${p}`, compare: async () => true }, dotenv: { config() {} }, cors: () => ({}), ...external };
    const orig = Module._load;
    Module._load = function (request, parent) {
        // Mô phỏng module chưa được cài: global.__blockModules = new Set(['undici'])
        if (global.__blockModules && global.__blockModules.has(request)) {
            const e = new Error(`Cannot find module '${request}'`);
            e.code = 'MODULE_NOT_FOUND';
            throw e;
        }
        if (Object.prototype.hasOwnProperty.call(ext, request)) return ext[request];
        if (parent && request.startsWith('.')) {
            const resolved = require.resolve(path.resolve(path.dirname(parent.filename), request));
            if (stubs.has(resolved)) return stubs.get(resolved);
        }
        return orig.apply(this, arguments);
    };
}
const src = (rel) => path.join(BE, rel);

// res/req giả
const mkRes = () => {
    const r = { code: 200, statusCode: 200, body: null, headers: {}, status(c) { r.code = c; r.statusCode = c; return r; }, json(b) { r.body = b; return r; }, set(k, v) { if (typeof k === 'object') Object.assign(r.headers, k); else r.headers[k] = v; return r; } };
    return r;
};
const call = async (fn, req = {}) => { const res = mkRes(); await fn({ body: {}, params: {}, query: {}, headers: {}, ...req }, res); return res; };

// luồng SSE giả để nghe sự kiện
const mkSse = () => {
    const res = new EventEmitter();
    res.written = []; res.ended = false; res.writableLength = 0;
    res.writeHead = () => {}; res.write = (c) => { if (res.ended) throw new Error('write after end'); res.written.push(c); return true; };
    res.end = () => { res.ended = true; res.emit('close'); };
    const req = new EventEmitter();
    const events = () => [...res.written.join('').matchAll(/event: (\S+)\ndata: (.*)\n/g)].map((m) => [m[1], JSON.parse(m[2])]);
    return { req, res, events, of: (name) => events().filter(([e]) => e === name).map(([, d]) => d) };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const capture = async (fn) => {
    const logs = []; const o = [console.log, console.warn, console.error];
    console.log = console.warn = console.error = (...a) => logs.push(a.join(' '));
    try { return { result: await fn(), logs }; } finally { [console.log, console.warn, console.error] = o; }
};

function runner() {
    let passed = 0;
    const test = async (name, fn, before) => {
        try { if (before) await before(); await fn(); passed++; console.log('  ✓', name); }
        catch (e) { console.log('  ✗', name, '\n   ', e.stack.split('\n').slice(0, 4).join('\n    ')); process.exitCode = 1; }
    };
    return { test, done: () => console.log(`\n${passed} test đạt`) };
}

module.exports = { BE, src, install, fakeJwt, fakeExpress, mkRes, call, mkSse, sleep, capture, runner };
