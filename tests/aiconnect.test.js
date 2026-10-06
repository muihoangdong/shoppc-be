// Kiểm thử "không kết nối được chatbot AI": chẩn đoán lỗi mạng, yêu cầu gửi Gemini đúng chuẩn, proxy, công cụ ai:check.
// Chạy:  node tests/aiconnect.test.js
const assert = require('assert');
const H = require('./helpers/harness');
const { src } = H;
delete process.env.NODE_ENV;

class FakeProxyAgent { constructor(url) { this.url = url; } }
const undiciFetchLog = [];
const undici = { ProxyAgent: FakeProxyAgent, fetch: async (url, opts) => { undiciFetchLog.push({ url, opts }); return { ok: true, status: 200, json: async () => oaText('qua proxy') }; } };
H.install(new Map([
    [src('config/database.js'), { query: async () => [], pool: {}, getClient: async () => ({}) }],
    [src('models/Product.js'), {}], [src('models/Category.js'), {}], [src('models/Order.js'), {}], [src('models/User.js'), {}], [src('models/Support.js'), {}],
]), { undici });

const AI = require(src('services/ai/anthropic.js'));
const C = require(src('services/ai/openaiCompat.js'));
const Net = require(src('services/ai/netDiagnostics.js'));
const Tools = require(src('services/ai/tools.js'));
const AiCheck = require('../scripts/ai-check.js');
const CS = require(src('services/support/customerAssistant.js'));
const { test, done } = H.runner();

const ENV_KEYS = ['AI_PROVIDER', 'AI_BASE_URL', 'AI_API_KEY', 'GEMINI_API_KEY', 'AI_MODEL', 'ANTHROPIC_API_KEY', 'AI_TIMEOUT_MS', 'AI_PROXY_URL', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'AI_REASONING_EFFORT'];
const setEnv = (env = {}) => { ENV_KEYS.forEach((k) => delete process.env[k]); Object.assign(process.env, env); queue = []; log = []; Net._resetProxyCache(); };
let queue = [], log = [];
global.fetch = async (url, opts) => {
    log.push({ url, headers: opts.headers, body: JSON.parse(opts.body), dispatcher: opts.dispatcher });
    const next = queue.shift(); if (!next) throw new Error('fetch hết kịch bản');
    if (next.throw) throw next.throw;
    if (next.status) return { ok: false, status: next.status, text: async () => next.body || '' };
    return { ok: true, status: 200, json: async () => next };
};
const oaText = (t) => ({ choices: [{ message: { role: 'assistant', content: t }, finish_reason: 'stop' }] });
// Lỗi giống hệt cách Node/undici báo: TypeError("fetch failed") với nguyên nhân thật nằm trong .cause
const fetchFailed = (code, message = code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(message), { code }) });
const gem = () => setEnv({ AI_PROVIDER: 'gemini-openai', GEMINI_API_KEY: 'AQ.fake-key', AI_MODEL: 'gemini-2.5-flash' });
const capture = async (fn) => (await H.capture(() => fn().catch((e) => e))).result;

(async () => {
    console.log('Chẩn đoán lỗi mạng (thay cho "fetch failed" chung chung)');
    await test('mỗi nguyên nhân thật cho ra đúng lời khuyên tiếng Việt kèm mã lỗi', async () => {
        const cases = [
            ['ENOTFOUND', /DNS/, /8\.8\.8\.8|VPN/], ['EAI_AGAIN', /DNS/, /Internet/],
            ['UND_ERR_CONNECT_TIMEOUT', /quá thời gian/, /VPN|proxy/], ['ETIMEDOUT', /quá thời gian/, /IPv6|tường lửa/], ['ENETUNREACH', /không tới được/, /VPN/],
            ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', /chứng chỉ/i, /NODE_EXTRA_CA_CERTS/], ['SELF_SIGNED_CERT_IN_CHAIN', /diệt virus|proxy công ty/, /NODE_EXTRA_CA_CERTS/], ['CERT_HAS_EXPIRED', /đồng hồ/, /NODE_EXTRA_CA_CERTS/],
            ['ECONNRESET', /ngắt giữa chừng/, /bảo mật|proxy/], ['ECONNREFUSED', /từ chối kết nối/, /generativelanguage/],
        ];
        for (const [code, re1, re2] of cases) {
            gem(); queue = [{ throw: fetchFailed(code) }];
            const e = await capture(() => AI.callModel({ system: 's', messages: [] }));
            assert.strictEqual(e.status, 502, code); assert(re1.test(e.message), `${code}: ${e.message}`); assert(re2.test(e.message), `${code}: ${e.message}`);
            assert(e.message.includes(`[mã lỗi: ${code}]`), code); assert(e.message.includes('generativelanguage.googleapis.com'), 'nêu rõ tên máy chủ');
            assert(!/AQ\.fake-key/.test(e.message), 'không lộ key');
        }
    });
    await test('đọc được nguyên nhân dù bị bọc nhiều tầng hoặc là AggregateError (thử cả IPv4 lẫn IPv6)', async () => {
        const inner = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
        const agg = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new AggregateError([inner, inner], 'all attempts failed'), { code: undefined }) });
        assert.strictEqual(Net.explainFetchError(agg, { url: 'https://x.com' }).code, 'ETIMEDOUT');
        const nested = Object.assign(new Error('a'), { cause: Object.assign(new Error('b'), { cause: Object.assign(new Error('c'), { code: 'ENOTFOUND' }) }) });
        assert.strictEqual(Net.explainFetchError(nested, { url: 'https://x.com' }).code, 'ENOTFOUND');
        const unknown = Net.explainFetchError(new Error('lạ hoắc'), { url: 'https://x.com' }); assert.strictEqual(unknown.code, 'UNKNOWN'); assert(/lạ hoắc/.test(unknown.message));
        assert(/Node\.js 18/.test(Net.explainFetchError(new ReferenceError('fetch is not defined'), { url: 'https://x.com' }).message));
    });
    await test('máy có HTTPS_PROXY: nhắc rằng Node không tự dùng proxy; không nhắc với Ollama chạy cục bộ', async () => {
        global.__blockModules = new Set(['undici']); // máy chưa cài undici (trường hợp thật)
        try {
            setEnv({ AI_PROVIDER: 'gemini-openai', GEMINI_API_KEY: 'k', HTTPS_PROXY: 'http://proxy.cty:8080' }); queue = [{ throw: fetchFailed('ETIMEDOUT') }];
            const e = await capture(() => AI.callModel({ system: 's', messages: [] })); assert(/HTTPS_PROXY.*undici.*AI_PROXY_URL/.test(e.message), e.message);
        } finally { global.__blockModules = null; }
        const n = Net.explainFetchError(fetchFailed('ECONNREFUSED'), { url: 'http://localhost:11434/v1' }); assert(!/HTTPS_PROXY/.test(n.message));
    });
    await test('nguyên nhân lỗi được ghi vào log của server (trước đây chỉ có "fetch failed")', async () => {
        gem(); queue = [{ throw: fetchFailed('UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'unable to verify the first certificate') }];
        const { logs } = await H.capture(() => AI.callModel({ system: 's', messages: [] }).catch(() => {}));
        assert(logs.some((l) => /UNABLE_TO_VERIFY_LEAF_SIGNATURE/.test(l) && /unable to verify the first certificate/.test(l) && /generativelanguage/.test(l)), logs.join('|'));
    });
    await test('Ollama chưa bật vẫn nhận lời nhắc riêng "ollama serve"', async () => {
        setEnv({ AI_PROVIDER: 'ollama' }); queue = [{ throw: fetchFailed('ECONNREFUSED') }];
        const e = await capture(() => AI.callModel({ system: 's', messages: [] })); assert(/ollama serve/.test(e.message));
        setEnv({ AI_PROVIDER: 'ollama' }); queue = [{ status: 400, body: 'registry.ollama.ai/library/gemma does not support tools' }];
        const t = await capture(() => AI.callModel({ system: 's', messages: [] })); assert(/không hỗ trợ gọi công cụ/.test(t.message));
    });

    console.log('Yêu cầu gửi Gemini đúng chuẩn');
    await test('công cụ không tham số bị bỏ trường parameters (Gemini từ chối properties rỗng); các từ khóa lạ bị lược; công cụ có tham số giữ nguyên', async () => {
        const out = C.toOpenAITools([
            { name: 'a', description: 'd', input_schema: { type: 'object', properties: {} } },
            { name: 'b', description: 'd', input_schema: { type: 'object' } },
            { name: 'c', description: 'd', input_schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'integer', minimum: 1, default: 5 }, tags: { type: 'array', items: { type: 'string', title: 'x' } } }, required: ['id'] } },
        ]);
        assert.deepStrictEqual(out[0], { type: 'function', function: { name: 'a', description: 'd' } }); assert.deepStrictEqual(out[1].function, { name: 'b', description: 'd' });
        assert.deepStrictEqual(out[2].function.parameters, { type: 'object', properties: { id: { type: 'integer', minimum: 1 }, tags: { type: 'array', items: { type: 'string' } } }, required: ['id'] });
    });
    await test('bộ công cụ THẬT của chatbot admin và trợ lý khách: không công cụ nào còn properties rỗng/từ khóa bị từ chối sau khi chuyển đổi', async () => {
        const defs = [...Tools.getToolsForRole('admin'), ...CS.TOOLS].map(({ name, description, input_schema }) => ({ name, description, input_schema }));
        assert(defs.length >= 20); const converted = C.toOpenAITools(defs);
        const walk = (o, path) => { if (!o || typeof o !== 'object') return; for (const [k, v] of Object.entries(o)) { assert(!['additionalProperties', 'default', '$schema'].includes(k), `${path}.${k}`); if (k === 'properties') assert(Object.keys(v).length > 0, `${path} có properties rỗng`); walk(v, `${path}.${k}`); } };
        converted.forEach((t) => walk(t.function.parameters, t.function.name));
        assert(converted.some((t) => !t.function.parameters), 'có công cụ không tham số'); assert(JSON.stringify(converted).length > 1000);
    });
    await test('Gemini: gửi cả Bearer lẫn x-goog-api-key; tắt "suy nghĩ" cho 2.5-flash; ghi tên công cụ vào kết quả công cụ', async () => {
        gem(); queue = [oaText('ok')];
        await AI.callModel({ system: 's', tools: [{ name: 'get_x', description: 'd', input_schema: { type: 'object', properties: { id: { type: 'integer' } } } }], messages: [
            { role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'get_x', input: { id: 1 } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{}' }] }] });
        assert.strictEqual(log[0].headers.authorization, 'Bearer AQ.fake-key'); assert.strictEqual(log[0].headers['x-goog-api-key'], 'AQ.fake-key');
        assert.strictEqual(log[0].body.reasoning_effort, 'none'); assert.deepStrictEqual(log[0].body.messages.at(-1), { role: 'tool', tool_call_id: 't1', name: 'get_x', content: '{}' });
        setEnv({ AI_PROVIDER: 'ollama' }); queue = [oaText('ok')]; await AI.callModel({ system: 's', messages: [] });
        assert(!('reasoning_effort' in log[0].body), 'không gửi cho Ollama'); assert(!('x-goog-api-key' in log[0].headers));
        setEnv({ AI_PROVIDER: 'gemini-openai', GEMINI_API_KEY: 'k', AI_MODEL: 'gemini-2.5-pro' }); queue = [oaText('ok')]; await AI.callModel({ system: 's', messages: [] }); assert(!('reasoning_effort' in log[0].body));
        setEnv({ AI_PROVIDER: 'gemini-openai', GEMINI_API_KEY: 'k', AI_REASONING_EFFORT: 'low' }); queue = [oaText('ok')]; await AI.callModel({ system: 's', messages: [] }); assert.strictEqual(log[0].body.reasoning_effort, 'low');
        setEnv({ AI_PROVIDER: 'gemini-openai', GEMINI_API_KEY: 'k', AI_REASONING_EFFORT: ' ' }); queue = [oaText('ok')]; await AI.callModel({ system: 's', messages: [] }); assert(!('reasoning_effort' in log[0].body), 'đặt rỗng = không gửi');
    });
    await test('nhà cung cấp không nhận reasoning_effort → tự gửi lại không có tham số đó (một lần)', async () => {
        gem(); queue = [{ status: 400, body: '{"error":{"message":"Unknown field reasoning_effort"}}' }, oaText('đã được')];
        const r = await AI.callModel({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
        assert.strictEqual(log.length, 2); assert.strictEqual(log[0].body.reasoning_effort, 'none'); assert(!('reasoning_effort' in log[1].body)); assert.strictEqual(r.content[0].text, 'đã được');
    });
    await test('lỗi Google trả về được dịch đúng: key sai, model sai, khai báo công cụ bị từ chối (kèm chi tiết thật, không nói dối "không hỗ trợ công cụ")', async () => {
        const cases = [
            [{ status: 400, body: '{"error":{"message":"API key not valid"}}' }, /GEMINI_API_KEY.*aistudio/], [{ status: 403, body: 'Method doesn\'t allow unregistered callers (callers without established identity)' }, /Dịch vụ AI từ chối|GEMINI_API_KEY/],
            [{ status: 404, body: 'models/gemini-9 is not found' }, /gemini-2\.5-flash.*không tồn tại|AI_MODEL/],
            [{ status: 400, body: '{"error":{"message":"tools[0].function_declarations[3].parameters.properties: should be non-empty for OBJECT type"}}' }, /khai báo công cụ.*should be non-empty/],
            [{ status: 418, body: 'teapot' }, /mã 418/],
        ];
        for (const [resp, re] of cases) { gem(); queue = [resp]; const e = await capture(() => AI.callModel({ system: 's', messages: [] })); assert(re.test(e.message), `${resp.status}: ${e.message}`); assert(!/AQ\.fake-key/.test(e.message)); }
    });

    console.log('Proxy (mạng công ty/trường học)');
    await test('AI_PROXY_URL: đi qua undici (fetch + ProxyAgent); chưa cài undici thì báo rõ cách cài; HTTPS_PROXY một mình không làm hỏng khi thiếu undici', async () => {
        setEnv({ AI_PROVIDER: 'gemini-openai', GEMINI_API_KEY: 'k', AI_PROXY_URL: 'http://proxy:8080' });
        const r = await AI.callModel({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
        assert.strictEqual(r.content[0].text, 'qua proxy'); assert.strictEqual(undiciFetchLog.at(-1).opts.dispatcher.url, 'http://proxy:8080'); assert.strictEqual(log.length, 0, 'không dùng fetch thường');
        global.__blockModules = new Set(['undici']);
        try {
            setEnv({ AI_PROVIDER: 'gemini-openai', GEMINI_API_KEY: 'k', AI_PROXY_URL: 'http://proxy:8080' });
            const miss = await capture(() => AI.callModel({ system: 's', messages: [] })); assert.strictEqual(miss.status, 503); assert(/npm install undici/.test(miss.message), miss.message);
            setEnv({ AI_PROVIDER: 'gemini-openai', GEMINI_API_KEY: 'k', HTTPS_PROXY: 'http://proxy:8080' }); queue = [oaText('vẫn chạy như cũ')];
            assert.strictEqual((await AI.callModel({ system: 's', messages: [] })).content[0].text, 'vẫn chạy như cũ', 'chỉ có HTTPS_PROXY mà thiếu undici: không làm hỏng, đi thẳng như trước');
        } finally { global.__blockModules = null; }
        setEnv({ AI_PROVIDER: 'ollama', HTTPS_PROXY: 'http://proxy:8080' }); queue = [oaText('cục bộ')]; await AI.callModel({ system: 's', messages: [] }); assert.strictEqual(log.length, 1, 'địa chỉ cục bộ không đi qua proxy');
        setEnv({ AI_PROVIDER: 'gemini-openai', GEMINI_API_KEY: 'k', HTTPS_PROXY: 'http://proxy:8080', NO_PROXY: 'googleapis.com' }); queue = [oaText('bỏ qua proxy')]; await AI.callModel({ system: 's', messages: [] }); assert.strictEqual(log.length, 1, 'NO_PROXY được tôn trọng');
    });

    console.log('Công cụ chẩn đoán ai:check');
    const runCheck = async ({ env, fetchScript, lookup }) => {
        setEnv(env); queue = fetchScript; const out = [];
        const ok = await AiCheck.run({ log: (l) => out.push(l), ai: AI, tools: Tools, env: process.env, lookup: lookup || (async () => [{ address: '142.250.1.95', family: 4 }, { address: '2404:6800::5f', family: 6 }]) });
        return { ok, text: out.join('\n') };
    };
    await test('mọi thứ ổn: 4 dấu ✅, không lộ key, có gọi kèm bộ công cụ thật', async () => {
        const r = await runCheck({ env: { AI_PROVIDER: 'gemini-openai', GEMINI_API_KEY: 'AQ.super-secret-key' }, fetchScript: [oaText('OK'), oaText('Chào bạn')] });
        assert.strictEqual(r.ok, true); assert(!/super-secret-key/.test(r.text)); assert(/142\.250\.1\.95 \(IPv4\), 2404:6800::5f \(IPv6\)/.test(r.text)); assert(/Mô hình trả lời: "OK"/.test(r.text)); assert(/Gọi kèm \d+ công cụ/.test(r.text) && /Chatbot AI dùng được/.test(r.text));
        assert(log[1].body.tools.length >= 18, 'lần 2 gửi bộ công cụ thật');
    });
    await test('chưa có key / lỗi DNS / lỗi chứng chỉ / key sai: dừng ở bước hỏng và nói cách sửa', async () => {
        let r = await runCheck({ env: { AI_PROVIDER: 'gemini-openai' }, fetchScript: [] }); assert.strictEqual(r.ok, false); assert(/❌ Cấu hình/.test(r.text) && /GEMINI_API_KEY/.test(r.text));
        r = await runCheck({ env: { AI_PROVIDER: 'gemini-openai', GEMINI_API_KEY: 'k' }, fetchScript: [], lookup: async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); } }); assert(/❌ DNS: generativelanguage/.test(r.text) && /8\.8\.8\.8/.test(r.text)); assert(!/Gọi mô hình/.test(r.text), 'dừng sớm');
        r = await runCheck({ env: { AI_PROVIDER: 'gemini-openai', GEMINI_API_KEY: 'k' }, fetchScript: [{ throw: fetchFailed('SELF_SIGNED_CERT_IN_CHAIN') }] }); assert(/❌ Gọi mô hình/.test(r.text) && /NODE_EXTRA_CA_CERTS/.test(r.text) && /SELF_SIGNED_CERT_IN_CHAIN/.test(r.text));
        r = await runCheck({ env: { AI_PROVIDER: 'gemini-openai', GEMINI_API_KEY: 'k' }, fetchScript: [{ status: 400, body: 'API key not valid' }] }); assert(/GEMINI_API_KEY/.test(r.text) && /aistudio/.test(r.text));
    });
    await test('gọi thường được nhưng gọi kèm công cụ bị từ chối → chẩn đoán đúng là lỗi khai báo công cụ; phản hồi rỗng → gợi ý reasoning', async () => {
        let r = await runCheck({ env: { AI_PROVIDER: 'gemini-openai', GEMINI_API_KEY: 'k' }, fetchScript: [oaText('OK'), { status: 400, body: 'function_declarations[0].parameters: invalid' }] });
        assert.strictEqual(r.ok, false); assert(/✅ Gọi mô hình/.test(r.text) && /❌ Gọi kèm bộ công cụ/.test(r.text) && /khai báo công cụ/.test(r.text));
        r = await runCheck({ env: { AI_PROVIDER: 'gemini-openai', GEMINI_API_KEY: 'k' }, fetchScript: [oaText(''), oaText('Chào')] }); assert(/AI_REASONING_EFFORT/.test(r.text));
        r = await runCheck({ env: { AI_PROVIDER: 'ollama' }, fetchScript: [oaText('OK'), oaText('Chào')] }); assert.strictEqual(r.ok, true); assert(/Ollama không cần key/.test(r.text));
    });
    done(); setImmediate(() => process.exit(process.exitCode || 0));
})();
