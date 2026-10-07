// Kiểm thử Gemini qua API GỐC (generateContent): chuyển đổi định dạng, giữ thoughtSignature (bắt buộc với Gemini 3.x),
// cấu hình "suy nghĩ", tự chọn model dự phòng, thử lại khi quá tải, và chạy trọn vòng chatbot admin + trợ lý khách.
// Dịch vụ thật được thay bằng fetch giả. Chạy:  node tests/gemini.test.js
const assert = require('assert');
const H = require('./helpers/harness');
const { src } = H;
delete process.env.NODE_ENV;

const products = [{ id: 1, name: 'Laptop Dell XPS 13', price: '25000000', stock: 5, category_id: 1, category_name: 'Laptop', description: 'Mỏng nhẹ' }];
H.install(new Map([
    [src('config/database.js'), { query: async () => [], pool: {}, getClient: async () => ({}) }],
    [src('models/Product.js'), { getAllProducts: async () => products, getProductById: async (id) => products.find((p) => p.id === id) }],
    [src('models/Category.js'), { getAllCategories: async () => [{ id: 1, name: 'Laptop' }] }], [src('models/Order.js'), {}], [src('models/User.js'), {}], [src('models/Support.js'), {}],
]));

const AI = require(src('services/ai/anthropic.js'));
const G = require(src('services/ai/gemini.js'));
const Tools = require(src('services/ai/tools.js'));
const CS = require(src('services/support/customerAssistant.js'));
const chatService = require(src('services/ai/chatService.js'));
const { test, done } = H.runner();

let queue = [], log = [];
global.fetch = async (url, opts) => {
    log.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    const next = queue.shift(); if (!next) throw new Error('fetch hết kịch bản');
    if (next.throw) throw next.throw;
    if (next.status) return { ok: false, status: next.status, text: async () => next.body || '' };
    return { ok: true, status: 200, json: async () => next };
};
const gText = (t, finishReason = 'STOP', extra = {}) => ({ candidates: [{ content: { role: 'model', parts: [{ text: t, ...extra }] }, finishReason }] });
const gCall = (name, args, sig) => ({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name, args }, ...(sig ? { thoughtSignature: sig } : {}) }] }, finishReason: 'STOP' }] });
const ENV = ['AI_PROVIDER', 'AI_BASE_URL', 'AI_API_KEY', 'GEMINI_API_KEY', 'GEMINI_BASE_URL', 'AI_MODEL', 'ANTHROPIC_API_KEY', 'AI_TIMEOUT_MS', 'AI_THINKING_LEVEL', 'AI_THINKING_EXTRA_TOKENS', 'AI_MAX_TOKENS', 'AI_RETRY_DELAY_MS', 'AI_PROXY_URL', 'HTTPS_PROXY', 'https_proxy'];
const setEnv = (env = {}) => { ENV.forEach((k) => delete process.env[k]); Object.assign(process.env, { AI_RETRY_DELAY_MS: '1' }, env); queue = []; log = []; AI._resetGeminiModel(); };
const gem = (env = {}) => setEnv({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'AIza-secret-key', ...env });
const quiet = (fn) => H.capture(fn).then((r) => r.result);
const FORBIDDEN = ['additionalProperties', '$schema', 'default', 'examples', 'title'];

(async () => {
    console.log('Chuyển đổi sang định dạng Gemini');
    await test('schema công cụ: lược từ khóa lạ, ["integer","null"] → nullable, enum thành chuỗi, công cụ không tham số bỏ "parameters"', () => {
        const s = G.toGeminiSchema({ type: 'object', additionalProperties: false, properties: { parent_id: { type: ['integer', 'null'], default: null }, n: { enum: [1, 2] }, tags: { type: 'array', items: { type: 'string', title: 'x' } } }, required: ['parent_id', 'khong_co'] });
        assert.deepStrictEqual(s, { type: 'object', properties: { parent_id: { type: 'integer', nullable: true }, n: { enum: ['1', '2'], type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['parent_id'] });
        assert.deepStrictEqual(G.toGeminiTools([{ name: 'a', description: 'd', input_schema: { type: 'object', properties: {} } }]), [{ functionDeclarations: [{ name: 'a', description: 'd' }] }]);
        assert.strictEqual(G.toGeminiTools([]), undefined);
    });
    await test('bộ công cụ THẬT của chatbot admin và trợ lý khách đều hợp lệ với Gemini', () => {
        const all = [...Tools.getToolsForRole('admin'), ...CS.TOOLS].map(({ name, description, input_schema }) => ({ name, description, input_schema }));
        const decls = G.toGeminiTools(all)[0].functionDeclarations;
        assert.strictEqual(decls.length, all.length);
        const walk = (s, where) => {
            if (!s || typeof s !== 'object') return;
            for (const k of FORBIDDEN) assert(!(k in s), `${where}: còn từ khóa ${k}`);
            assert(!Array.isArray(s.type), `${where}: type dạng mảng`);
            if (s.type === 'object' && s.properties) assert(Object.keys(s.properties).length > 0, `${where}: properties rỗng`);
            if (s.enum) { assert.strictEqual(s.type, 'string', where); s.enum.forEach((v) => assert.strictEqual(typeof v, 'string', where)); }
            Object.values(s.properties || {}).forEach((x) => walk(x, where)); if (s.items) walk(s.items, where);
        };
        decls.forEach((d) => { assert(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(d.name), d.name); walk(d.parameters, d.name); });
    });
    await test('tin nhắn: assistant → "model"; tool_use → functionCall kèm thoughtSignature; tool_result → functionResponse (tên + object); gộp lượt cùng vai trò', () => {
        const contents = G.toGeminiContents([
            { role: 'user', content: 'Hàng nào sắp hết?' },
            { role: 'assistant', content: [{ type: 'text', text: 'Để mình xem' }, { type: 'tool_use', id: 'gm_1', name: 'list_products', input: { max_stock: 10 }, thought_signature: 'SIG' }, { type: 'tool_use', id: 'g-2', gemini_id: 'g-2', name: 'get_product', input: { id: 1 } }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'gm_1', content: '{"total":1}' }, { type: 'tool_result', tool_use_id: 'g-2', content: 'Không có', is_error: true }] },
            { role: 'user', content: 'cảm ơn' },
        ]);
        assert.deepStrictEqual(contents, [
            { role: 'user', parts: [{ text: 'Hàng nào sắp hết?' }] },
            { role: 'model', parts: [{ text: 'Để mình xem' }, { functionCall: { name: 'list_products', args: { max_stock: 10 } }, thoughtSignature: 'SIG' }, { functionCall: { name: 'get_product', args: { id: 1 }, id: 'g-2' } }] },
            { role: 'user', parts: [{ functionResponse: { name: 'list_products', response: { total: 1 } } }, { functionResponse: { name: 'get_product', response: { error: 'Không có' }, id: 'g-2' } }, { text: 'cảm ơn' }] },
        ]);
        assert.deepStrictEqual(G.toResponseObject('[1,2]'), { result: [1, 2] }); assert.deepStrictEqual(G.toResponseObject('chữ thường'), { result: 'chữ thường' });
    });
    await test('phản hồi: chữ, gọi công cụ (giữ chữ ký), bỏ phần "suy nghĩ", hết token, bị chặn vì an toàn', () => {
        const r = G.fromGeminiResponse({ candidates: [{ content: { parts: [{ text: 'nghĩ...', thought: true }, { text: ' Xin chào ' }, { functionCall: { name: 'get_product', args: { id: 1 } }, thoughtSignature: 'S1' }] }, finishReason: 'STOP' }] });
        assert.strictEqual(r.stop_reason, 'tool_use'); assert.strictEqual(r.content.length, 2); assert.deepStrictEqual(r.content[0], { type: 'text', text: 'Xin chào' });
        assert.strictEqual(r.content[1].thought_signature, 'S1'); assert(/^gm_/.test(r.content[1].id)); assert.deepStrictEqual(r.content[1].input, { id: 1 });
        assert.strictEqual(G.fromGeminiResponse(gText('dở', 'MAX_TOKENS')).stop_reason, 'max_tokens');
        assert.strictEqual(G.fromGeminiResponse({ candidates: [{ finishReason: 'SAFETY' }] }).stop_reason, 'refusal');
        assert.strictEqual(G.fromGeminiResponse({ promptFeedback: { blockReason: 'SAFETY' } }).stop_reason, 'refusal');
        assert.deepStrictEqual(G.fromGeminiResponse({}).content, []);
    });

    console.log('Gọi API gốc của Gemini');
    await test('đúng địa chỉ generateContent, key chỉ ở header (không nằm trong URL), systemInstruction, model mặc định 3.5 + suy nghĩ mức thấp', async () => {
        gem(); queue = [gText('Chào bạn')];
        const r = await AI.callModel({ system: 'sys', tools: [{ name: 'list_products', description: 'd', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }], messages: [{ role: 'user', content: 'hi' }], maxTokens: 300 });
        assert.strictEqual(log[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent');
        assert.strictEqual(log[0].headers['x-goog-api-key'], 'AIza-secret-key'); assert(!/AIza/.test(log[0].url)); assert(!('authorization' in log[0].headers));
        assert.deepStrictEqual(log[0].body.systemInstruction, { parts: [{ text: 'sys' }] });
        assert.strictEqual(log[0].body.tools[0].functionDeclarations[0].name, 'list_products');
        assert.deepStrictEqual(log[0].body.generationConfig.thinkingConfig, { thinkingLevel: 'LOW' });
        assert.strictEqual(log[0].body.generationConfig.maxOutputTokens, 300 + 2048, 'chừa chỗ cho phần suy nghĩ');
        assert(!('temperature' in log[0].body.generationConfig), 'đời 3.x giữ nhiệt độ mặc định');
        assert.deepStrictEqual(r, { content: [{ type: 'text', text: 'Chào bạn' }], stop_reason: 'end_turn', finish_reason: 'STOP' });
        assert(/Gemini · gemini-3\.5-flash/.test(AI.describe()));
    });
    await test('gemini-2.5-flash: tắt hẳn suy nghĩ; AI_THINKING_LEVEL đổi được (rỗng = không gửi, số = thinkingBudget)', async () => {
        gem({ AI_MODEL: 'gemini-2.5-flash' }); queue = [gText('ok')]; await AI.callModel({ system: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 100 });
        assert.deepStrictEqual(log[0].body.generationConfig, { maxOutputTokens: 100, temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } });
        gem({ AI_THINKING_LEVEL: 'minimal' }); queue = [gText('ok')]; await AI.callModel({ system: 's', messages: [] });
        assert.deepStrictEqual(log[0].body.generationConfig.thinkingConfig, { thinkingLevel: 'MINIMAL' });
        assert.deepStrictEqual(log[0].body.contents, [{ role: 'user', parts: [{ text: '.' }] }], 'không gửi contents rỗng');
        gem({ AI_THINKING_LEVEL: '' }); queue = [gText('ok')]; await AI.callModel({ system: 's', messages: [] }); assert(!('thinkingConfig' in log[0].body.generationConfig));
        gem({ AI_THINKING_LEVEL: '512' }); queue = [gText('ok')]; await AI.callModel({ system: 's', messages: [] }); assert.deepStrictEqual(log[0].body.generationConfig.thinkingConfig, { thinkingBudget: 512 });
    });
    await test('tự chọn Gemini khi chỉ có GEMINI_API_KEY; có ANTHROPIC_API_KEY thì vẫn mặc định Claude; key có dấu nháy/khoảng trắng được làm sạch', async () => {
        setEnv({ GEMINI_API_KEY: ' "AIza-k" ' }); assert.strictEqual(AI.provider(), 'gemini'); assert.strictEqual(AI.isConfigured(), true);
        queue = [gText('ok')]; await AI.callModel({ system: 's', messages: [] }); assert.strictEqual(log[0].headers['x-goog-api-key'], 'AIza-k');
        setEnv({ GEMINI_API_KEY: 'k', ANTHROPIC_API_KEY: 'sk' }); assert.strictEqual(AI.provider(), 'anthropic');
        setEnv({ AI_PROVIDER: 'gemini' }); assert.strictEqual(AI.isConfigured(), false);
        await assert.rejects(AI.callModel({ system: 's', messages: [] }), (e) => e.status === 503 && /GEMINI_API_KEY/.test(e.message));
        assert(/thiếu GEMINI_API_KEY/.test(AI.describe()));
    });
    await test('model mặc định không có (404) → tự thử model dự phòng và nhớ lại; AI_MODEL tự đặt mà sai thì báo rõ, không đổi model', async () => {
        gem(); queue = [{ status: 404, body: 'models/gemini-3.5-flash is not found' }, gText('ok')];
        const { result, logs } = await H.capture(() => AI.callModel({ system: 's', messages: [] }));
        assert.strictEqual(result.content[0].text, 'ok'); assert(log[1].url.endsWith(`${AI.GEMINI_FALLBACK_MODELS[1]}:generateContent`), log[1].url);
        assert(logs.some((l) => l.includes(`chuyển sang "${AI.GEMINI_FALLBACK_MODELS[1]}"`)));
        assert.strictEqual(AI.modelName(), AI.GEMINI_FALLBACK_MODELS[1]); log = []; queue = [gText('ok')]; await AI.callModel({ system: 's', messages: [] });
        assert(log[0].url.endsWith(`${AI.GEMINI_FALLBACK_MODELS[1]}:generateContent`), 'lần sau đi thẳng model đã dò được');
        gem(); queue = AI.GEMINI_FALLBACK_MODELS.map(() => ({ status: 404, body: 'not found' }));
        let e = await quiet(() => AI.callModel({ system: 's', messages: [] }).catch((x) => x)); assert.strictEqual(log.length, AI.GEMINI_FALLBACK_MODELS.length); assert(/Không tìm được model Gemini/.test(e.message), e.message);
        gem({ AI_MODEL: 'gemini-9' }); queue = [{ status: 404, body: 'not found' }];
        e = await quiet(() => AI.callModel({ system: 's', messages: [] }).catch((x) => x)); assert.strictEqual(log.length, 1); assert(/"gemini-9".*AI_MODEL/.test(e.message), e.message);
    });
    await test('model không nhận thinkingConfig → gửi lại không kèm; Google quá tải (503) → chờ rồi thử lại một lần; lời gọi công cụ hỏng → thử lại', async () => {
        gem(); queue = [{ status: 400, body: 'Thinking level is not supported for this model.' }, gText('ok')];
        let r = await quiet(() => AI.callModel({ system: 's', messages: [] })); assert.strictEqual(r.content[0].text, 'ok'); assert(log[0].body.generationConfig.thinkingConfig); assert(!log[1].body.generationConfig.thinkingConfig);
        gem(); queue = [{ status: 503, body: 'The model is overloaded' }, gText('ok')]; r = await AI.callModel({ system: 's', messages: [] }); assert.strictEqual(r.content[0].text, 'ok'); assert.strictEqual(log.length, 2);
        // model chính vẫn quá tải sau khi thử lại → tạm dùng model dự phòng (không nhớ: lần sau vẫn thử model chính trước)
        gem(); queue = [{ status: 503, body: 'overloaded' }, { status: 503, body: 'overloaded' }, gText('ok2')];
        r = await quiet(() => AI.callModel({ system: 's', messages: [] })); assert.strictEqual(r.content[0].text, 'ok2'); assert.strictEqual(log.length, 3, 'mỗi model chỉ thử lại một lần');
        assert(log[2].url.endsWith(`${AI.GEMINI_FALLBACK_MODELS[1]}:generateContent`), log[2].url);
        log = []; queue = [gText('ok3')]; await AI.callModel({ system: 's', messages: [] }); assert(/gemini-3\.5-flash:generateContent$/.test(log[0].url), 'lần sau vẫn thử model chính trước');
        // hết lượt (429) của model chính → chuyển ngay sang model khác, không chờ
        gem(); queue = [{ status: 429, body: 'RESOURCE_EXHAUSTED' }, gText('ok4')];
        r = await quiet(() => AI.callModel({ system: 's', messages: [] })); assert.strictEqual(r.content[0].text, 'ok4'); assert.strictEqual(log.length, 2);
        // mọi model đều quá tải → báo lỗi 503
        gem(); queue = Array(AI.GEMINI_FALLBACK_MODELS.length * 2).fill({ status: 503, body: 'overloaded' });
        const e = await quiet(() => AI.callModel({ system: 's', messages: [] }).catch((x) => x)); assert.strictEqual(e.status, 503); assert.strictEqual(log.length, AI.GEMINI_FALLBACK_MODELS.length * 2);
        // model chính quá tải, các model còn lại không tồn tại → báo "quá tải" (không phải "không có model")
        gem(); queue = [{ status: 503, body: 'overloaded' }, { status: 503, body: 'overloaded' }, ...AI.GEMINI_FALLBACK_MODELS.slice(1).map(() => ({ status: 404, body: 'not found' }))];
        const e3 = await quiet(() => AI.callModel({ system: 's', messages: [] }).catch((x) => x)); assert.strictEqual(e3.status, 503, e3.message); assert(/quá tải/.test(e3.message), e3.message);
        assert(!AI.GEMINI_FALLBACK_MODELS.some((m) => m.startsWith('gemini-2.5')), 'không dùng model Google đã ngừng');
        // AI_MODEL tự đặt: không đổi model
        gem({ AI_MODEL: 'gemini-3.5-flash' }); queue = [{ status: 503, body: 'overloaded' }, { status: 503, body: 'overloaded' }];
        const e2 = await quiet(() => AI.callModel({ system: 's', messages: [] }).catch((x) => x)); assert.strictEqual(e2.status, 503); assert.strictEqual(log.length, 2);
        gem(); queue = [{ candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL' }] }, gText('ok')]; r = await quiet(() => AI.callModel({ system: 's', messages: [] })); assert.strictEqual(r.content[0].text, 'ok');
    });
    await test('lỗi Google được dịch sang tiếng Việt, không lộ key', async () => {
        const cases = [
            [{ status: 400, body: '{"error":{"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}' }, 502, /GEMINI_API_KEY.*aistudio/],
            [{ status: 403, body: 'Method doesn\'t allow unregistered callers' }, 502, /GEMINI_API_KEY/],
            [{ status: 429, body: 'RESOURCE_EXHAUSTED' }, 429, /hết lượt miễn phí/],
            [{ status: 400, body: 'User location is not supported for the API use.' }, 502, /khu vực/],
            [{ status: 400, body: '{"error":{"message":"Invalid JSON payload: function_declarations[3].parameters"}}' }, 502, /khai báo công cụ.*function_declarations/],
            [{ status: 418, body: 'teapot' }, 502, /mã 418/],
        ];
        for (const [resp, code, re] of cases) {
            gem(); queue = Array(AI.GEMINI_FALLBACK_MODELS.length).fill(resp); // 429: thử hết các model dự phòng rồi mới báo lỗi
            const e = await quiet(() => AI.callModel({ system: 's', messages: [] }).catch((x) => x));
            assert.strictEqual(e.status, code, resp.body); assert(re.test(e.message), `${resp.status}: ${e.message}`); assert(!/AIza-secret-key/.test(e.message));
        }
        gem(); queue = [{ throw: Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) }) }];
        const e = await quiet(() => AI.callModel({ system: 's', messages: [] }).catch((x) => x)); assert.strictEqual(e.status, 502); assert(/ENOTFOUND/.test(e.message), e.message);
        gem(); queue = [{ throw: Object.assign(new Error('aborted'), { name: 'AbortError' }) }];
        assert.strictEqual((await AI.callModel({ system: 's', messages: [] }).catch((x) => x)).status, 504);
    });

    console.log('Chạy trọn vòng qua Gemini');
    await test('runAgent: gọi công cụ → gửi lại functionCall KÈM thoughtSignature + functionResponse đúng tên → nhận câu trả lời', async () => {
        gem(); queue = [gCall('get_product', { id: 1 }, 'SIG-123'), gText('Dell XPS 13 giá 25.000.000₫.')];
        let got; const r = await AI.runAgent({ system: 's', tools: [{ name: 'get_product', description: 'd', input_schema: { type: 'object', properties: { id: { type: 'integer' } } } }], messages: [{ role: 'user', content: 'giá Dell?' }], executeTool: async (b) => { got = b; return { price: 25000000 }; } });
        assert.strictEqual(r.text, 'Dell XPS 13 giá 25.000.000₫.'); assert.deepStrictEqual(got.input, { id: 1 }); assert.deepStrictEqual(r.toolCalls, ['get_product']);
        const second = log[1].body.contents;
        assert.deepStrictEqual(second[1], { role: 'model', parts: [{ functionCall: { name: 'get_product', args: { id: 1 } }, thoughtSignature: 'SIG-123' }] });
        assert.deepStrictEqual(second[2], { role: 'user', parts: [{ functionResponse: { name: 'get_product', response: { price: 25000000 } } }] });
    });
    await test('chatbot admin qua Gemini: tra cứu chạy ngay; thao tác ghi chỉ tạo thẻ xác nhận (không thực hiện)', async () => {
        gem(); queue = [gCall('list_products', { max_stock: 10 }, 'S'), gText('Có 1 sản phẩm sắp hết: Laptop Dell XPS 13.')];
        let res = await chatService.runChat({ messages: [{ role: 'user', content: 'hàng sắp hết?' }], user: { id: 1, username: 'admin', role: 'admin' } });
        assert.strictEqual(res.reply, 'Có 1 sản phẩm sắp hết: Laptop Dell XPS 13.');
        assert.strictEqual(log[1].body.contents[2].parts[0].functionResponse.response.total_matched, 1);
        gem(); queue = [gCall('delete_product', { id: 1 }), gText('Mình đã chuẩn bị, bạn xác nhận nhé.')];
        res = await chatService.runChat({ messages: [{ role: 'user', content: 'xóa Dell' }], user: { id: 1, username: 'admin', role: 'admin' } });
        assert.strictEqual(res.pending_actions.length, 1); assert(/XÓA VĨNH VIỄN/.test(res.pending_actions[0].summary));
        gem(); queue = [{ candidates: [{ finishReason: 'SAFETY' }] }];
        res = await chatService.runChat({ messages: [{ role: 'user', content: '...' }], user: { id: 1, username: 'admin', role: 'admin' } });
        assert(/không thể hỗ trợ/.test(res.reply), res.reply);
    });
    await test('trợ lý khách qua Gemini: tìm sản phẩm rồi trả lời; gọi request_human thì chuyển cho nhân viên', async () => {
        gem(); queue = [gCall('search_products', { query: 'laptop' }), gText('Bên mình có Laptop Dell XPS 13 giá 25.000.000₫, còn hàng.')];
        let handed = null;
        const text = await CS.reply({ history: [{ sender_type: 'customer', content: 'Tư vấn chọn laptop' }], requestHuman: async (r) => { handed = r; } });
        assert(/Dell XPS 13/.test(text)); assert.strictEqual(log[1].body.contents[2].parts[0].functionResponse.response.products[0].name, 'Laptop Dell XPS 13');
        gem(); queue = [gCall('request_human', { reason: 'Khách muốn đổi trả' }), gText('Mình đã chuyển cho nhân viên.')];
        await CS.reply({ history: [{ sender_type: 'customer', content: 'Tôi muốn đổi trả' }], requestHuman: async (r) => { handed = r; } });
        assert.strictEqual(handed, 'Khách muốn đổi trả');
    });
    done(); setImmediate(() => process.exit(process.exitCode || 0));
})();
