// Kiểm thử lớp chọn nhà cung cấp AI: Claude (mặc định), Ollama (chạy trên máy), Gemini, dịch vụ kiểu OpenAI.
// Dịch vụ thật được thay bằng fetch giả. Chạy:  node tests/provider.test.js
const assert = require('assert');
const H = require('./helpers/harness');
const { src } = H;
delete process.env.NODE_ENV;

const products = [{ id: 1, name: 'Laptop Dell XPS 13', price: '25000000', stock: 5, category_id: 1, category_name: 'Laptop' }];
H.install(new Map([
    [src('config/database.js'), { query: async () => [], pool: {}, getClient: async () => ({}) }],
    [src('models/Product.js'), { getAllProducts: async () => products, getProductById: async (id) => products.find((p) => p.id === id) }],
    [src('models/Category.js'), {}], [src('models/Order.js'), {}], [src('models/User.js'), {}], [src('models/Support.js'), {}],
]));

const AI = require(src('services/ai/anthropic.js'));
const C = require(src('services/ai/openaiCompat.js'));
const chatService = require(src('services/ai/chatService.js'));
const { test, done } = H.runner();

let queue = [], log = [];
global.fetch = async (url, opts) => {
    log.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    const next = queue.shift(); if (!next) throw new Error('fetch hết kịch bản');
    if (next.throw) throw next.throw;
    if (typeof next.status === 'number') return { ok: false, status: next.status, headers: new Headers(next.headers), text: async () => next.body || '', json: async () => JSON.parse(next.body) };
    return { ok: true, status: 200, json: async () => next };
};
const oaText = (t, finish = 'stop') => ({ choices: [{ message: { role: 'assistant', content: t }, finish_reason: finish }] });
const oaTool = (name, args, id = 'call_1') => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] });
const setEnv = (env) => { for (const k of ['AI_PROVIDER', 'AI_BASE_URL', 'AI_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'AI_MODEL', 'ANTHROPIC_API_KEY', 'AI_TIMEOUT_MS']) delete process.env[k]; Object.assign(process.env, env); queue = []; log = []; };

const response = (...output) => ({ status: 'completed', output });
const responseText = (text) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const responseCall = (name, args, call_id) => ({ type: 'function_call', id: `fc_${call_id}`, call_id, name, arguments: JSON.stringify(args), status: 'completed' });

(async () => {
    console.log('Chuyển đổi định dạng');
    await test('yêu cầu: system, tin nhắn chữ, gọi công cụ của AI, kết quả công cụ (kể cả lỗi) đúng chuẩn OpenAI', () => {
        const out = C.toOpenAIMessages('Bạn là trợ lý', [
            { role: 'user', content: 'Hàng nào sắp hết?' },
            { role: 'assistant', content: [{ type: 'text', text: 'Để mình xem' }, { type: 'tool_use', id: 't1', name: 'list_products', input: { max_stock: 10 } }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"total":1}' }, { type: 'tool_result', tool_use_id: 't2', content: 'Không có', is_error: true }] },
            { role: 'assistant', content: [{ type: 'tool_use', id: 't3', name: 'navigate', input: {} }] },
        ]);
        assert.deepStrictEqual(out, [
            { role: 'system', content: 'Bạn là trợ lý' },
            { role: 'user', content: 'Hàng nào sắp hết?' },
            { role: 'assistant', content: 'Để mình xem', tool_calls: [{ id: 't1', type: 'function', function: { name: 'list_products', arguments: '{"max_stock":10}' } }] },
            { role: 'tool', tool_call_id: 't1', content: '{"total":1}' },
            { role: 'tool', tool_call_id: 't2', content: 'LỖI: Không có' },
            { role: 'assistant', content: null, tool_calls: [{ id: 't3', type: 'function', function: { name: 'navigate', arguments: '{}' } }] },
        ]);
        assert.deepStrictEqual(C.toOpenAITools([{ name: 'a', description: 'd', input_schema: { type: 'object', properties: { id: { type: 'integer' } } } }]), [{ type: 'function', function: { name: 'a', description: 'd', parameters: { type: 'object', properties: { id: { type: 'integer' } } } } }]);
        // công cụ không tham số: bỏ hẳn trường parameters (Gemini từ chối object rỗng)
        assert.deepStrictEqual(C.toOpenAITools([{ name: 'b', description: 'd', input_schema: { type: 'object', properties: {} } }]), [{ type: 'function', function: { name: 'b', description: 'd' } }]);
    });
    await test('phản hồi: chữ, gọi công cụ (tham số dạng chuỗi/object), JSON hỏng, thiếu id, bị cắt do giới hạn token', () => {
        assert.deepStrictEqual(C.fromOpenAIResponse(oaText('  Xin chào  ')), { content: [{ type: 'text', text: 'Xin chào' }], stop_reason: 'end_turn' });
        assert.deepStrictEqual(C.fromOpenAIResponse(oaTool('get_product', { id: 1 })).content[0], { type: 'tool_use', id: 'call_1', name: 'get_product', input: { id: 1 } });
        assert.strictEqual(C.fromOpenAIResponse(oaTool('x', { a: 1 })).stop_reason, 'tool_use');
        const obj = { choices: [{ message: { tool_calls: [{ function: { name: 'x', arguments: { a: 2 } } }] } }] };
        const r = C.fromOpenAIResponse(obj); assert.deepStrictEqual(r.content[0].input, { a: 2 }); assert(/^call_/.test(r.content[0].id), 'tự tạo id khi model không trả');
        assert.deepStrictEqual(C.fromOpenAIResponse(oaTool('x', '{hỏng')).content[0].input, {}); assert.deepStrictEqual(C.fromOpenAIResponse(oaTool('x', '[1,2]')).content[0].input, {});
        assert.strictEqual(C.fromOpenAIResponse(oaText('dở', 'length')).stop_reason, 'max_tokens');
        assert.deepStrictEqual(C.fromOpenAIResponse({}), { content: [], stop_reason: 'end_turn' });
    });

    console.log('Chọn nhà cung cấp');
    await test('mặc định vẫn là Claude, gửi đúng như trước (x-api-key, định dạng Anthropic)', async () => {
        setEnv({ ANTHROPIC_API_KEY: 'sk-ant' }); queue = [{ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }];
        await AI.callModel({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
        assert.strictEqual(log[0].url, 'https://api.anthropic.com/v1/messages'); assert.strictEqual(log[0].headers['x-api-key'], 'sk-ant'); assert.strictEqual(log[0].body.system, 's');
        assert.strictEqual(AI.provider(), 'anthropic'); setEnv({ AI_PROVIDER: 'khong-co' }); assert.strictEqual(AI.provider(), 'anthropic', 'giá trị lạ quay về mặc định');
    });
    await test('Gemini: đúng địa chỉ, Bearer key, model mặc định, công cụ chuyển đổi; phản hồi chuyển về định dạng nội bộ', async () => {
        setEnv({ AI_PROVIDER: 'gemini-openai' }); assert.strictEqual(AI.isConfigured(), false, 'chưa có key thì tắt');
        await assert.rejects(AI.callModel({ system: 's', messages: [] }), (e) => e.status === 503 && /GEMINI_API_KEY/.test(e.message));
        setEnv({ AI_PROVIDER: 'gemini-openai', GEMINI_API_KEY: 'AIza-k' }); assert.strictEqual(AI.isConfigured(), true);
        queue = [oaTool('list_products', { max_stock: 10 })];
        const r = await AI.callModel({ system: 'sys', tools: [{ name: 'list_products', description: 'd', input_schema: { type: 'object' } }], messages: [{ role: 'user', content: 'hi' }], maxTokens: 300 });
        assert.strictEqual(log[0].url, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
        assert.strictEqual(log[0].headers.authorization, 'Bearer AIza-k'); assert.strictEqual(log[0].body.model, 'gemini-3.5-flash'); assert.strictEqual(log[0].body.max_tokens, 300);
        assert.deepStrictEqual(log[0].body.messages[0], { role: 'system', content: 'sys' }); assert.strictEqual(log[0].body.tools[0].function.name, 'list_products');
        assert.deepStrictEqual(r, { content: [{ type: 'tool_use', id: 'call_1', name: 'list_products', input: { max_stock: 10 } }], stop_reason: 'tool_use' });
        setEnv({ AI_PROVIDER: 'gemini-openai', AI_API_KEY: 'k2', AI_MODEL: 'gemini-2.0-flash' }); queue = [oaText('x')]; await AI.callModel({ system: 's', messages: [] });
        assert.strictEqual(log[0].headers.authorization, 'Bearer k2'); assert.strictEqual(log[0].body.model, 'gemini-2.0-flash');
    });
    await test('Gemini: lỗi key sai, hết lượt miễn phí, model không tồn tại có thông báo tiếng Việt rõ ràng', async () => {
        const cases = [[{ status: 400, body: '{"error":{"message":"API key not valid. Please pass a valid API key."}}' }, 502, /GEMINI_API_KEY/], [{ status: 429, body: 'quota' }, 429, /hết lượt miễn phí/], [{ status: 404, body: 'not found' }, 502, /AI_MODEL/], [{ status: 503 }, 503, /quá tải/]];
        for (const [resp, code, re] of cases) {
            setEnv({ AI_PROVIDER: 'gemini-openai', GEMINI_API_KEY: 'k' }); queue = [resp];
            const { result } = await H.capture(() => AI.callModel({ system: 's', messages: [] }).catch((e) => e));
            assert.strictEqual(result.status, code, JSON.stringify(resp)); assert(re.test(result.message), result.message);
        }
    });
    await test('Ollama: không cần key, mặc định localhost + qwen2.5:7b; chưa chạy / chưa tải model / quá lâu đều chỉ cách sửa', async () => {
        setEnv({ AI_PROVIDER: 'ollama' }); assert.strictEqual(AI.isConfigured(), true); queue = [oaText('chào')];
        const r = await AI.callModel({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
        assert.strictEqual(log[0].url, 'http://localhost:11434/v1/chat/completions'); assert.strictEqual(log[0].headers.authorization, undefined); assert.strictEqual(log[0].body.model, 'qwen2.5:7b');
        assert.deepStrictEqual(r.content, [{ type: 'text', text: 'chào' }]);
        const cases = [[{ throw: Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) }, 502, /ollama serve/], [{ status: 404, body: 'model "qwen2.5:7b" not found' }, 502, /ollama pull qwen2\.5:7b/], [{ throw: Object.assign(new Error('aborted'), { name: 'AbortError' }) }, 504, /model nhỏ hơn|AI_TIMEOUT_MS/], [{ status: 400, body: 'model does not support tools' }, 502, /không hỗ trợ gọi công cụ/]];
        for (const [resp, code, re] of cases) {
            setEnv({ AI_PROVIDER: 'ollama' }); queue = [resp];
            const { result } = await H.capture(() => AI.callModel({ system: 's', messages: [] }).catch((e) => e));
            assert.strictEqual(result.status, code); assert(re.test(result.message), result.message);
        }
        setEnv({ AI_PROVIDER: 'ollama', AI_BASE_URL: 'http://host.docker.internal:11434/v1/' }); queue = [oaText('x')]; await AI.callModel({ system: 's', messages: [] });
        assert.strictEqual(log[0].url, 'http://host.docker.internal:11434/v1/chat/completions', 'bỏ dấu / thừa');
    });

    console.log('Chạy trọn vòng qua nhà cung cấp mới');
    await test('GPT-6.1 Sol tra cứu và đề xuất thay đổi qua Responses API, giữ bước xác nhận', async () => {
        setEnv({ AI_PROVIDER: 'openai', AI_API_KEY: 'other-provider-key' });
        assert.strictEqual(AI.isConfigured(), false);
        await assert.rejects(AI.callModel({ messages: [] }), /OPENAI_API_KEY/);

        setEnv({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'project-key', AI_BASE_URL: 'https://other.example/v1' });
        const reasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'encrypted' };
        const lookup = responseCall('list_products', { max_stock: 10 }, 'call_lookup');
        const remove = responseCall('delete_product', { id: 1 }, 'call_remove');
        queue = [response(reasoning, lookup), response(remove), response(responseText('Bạn kiểm tra và xác nhận nhé.'))];
        const messages = [{ role: 'user', content: 'Tìm sản phẩm sắp hết và chuẩn bị xóa Dell.' }];
        const result = await chatService.runChat({ messages, user: { id: 1, username: 'admin', role: 'admin' } });

        assert.strictEqual(AI.endpointUrl(), 'https://api.openai.com/v1/responses');
        assert.strictEqual(log[0].url, AI.endpointUrl());
        assert.strictEqual(log[0].headers.authorization, 'Bearer project-key');
        const first = log[0].body;
        assert.strictEqual(first.model, 'gpt-6.1-sol');
        assert.strictEqual(first.store, false);
        assert.deepStrictEqual(first.input, messages);
        assert.deepStrictEqual(first.include, ['reasoning.encrypted_content']);
        const tool = first.tools.find((item) => item.name === 'list_products');
        assert.strictEqual(tool.type, 'function');
        assert.strictEqual(tool.strict, false);
        assert(tool.parameters.properties.max_stock);

        const second = log[1].body.input;
        assert.deepStrictEqual(second.slice(0, -1), [...messages, reasoning, lookup]);
        assert.strictEqual(second.at(-1).type, 'function_call_output');
        assert.strictEqual(second.at(-1).call_id, 'call_lookup');
        assert.strictEqual(JSON.parse(second.at(-1).output).total_matched, 1);
        const third = log[2].body.input;
        assert.deepStrictEqual(third.slice(0, -1), [...second, remove]);
        assert.strictEqual(third.at(-1).call_id, 'call_remove');
        assert.match(third.at(-1).output, /CHƯA thực hiện/);
        assert.strictEqual(result.pending_actions.length, 1);
        assert.strictEqual(result.pending_actions[0].tool, 'delete_product');
        assert.strictEqual(result.reply, 'Bạn kiểm tra và xác nhận nhé.');
    });
    await test('Responses API không chạy công cụ nếu phản hồi bị cắt hoặc tham số bị lỗi', async () => {
        setEnv({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'project-key' });
        const call = responseCall('delete_product', { id: 1 }, 'call_remove');
        queue = [{ ...response(call), status: 'incomplete' }, response({ ...call, arguments: '{' })];
        let calls = 0;
        const args = { messages: [{ role: 'user', content: 'xóa Dell' }], executeTool: async () => { calls++; } };
        assert.deepStrictEqual((await AI.runAgent(args)).toolCalls, []);
        await assert.rejects(AI.runAgent(args), /lệnh gọi công cụ không hợp lệ/);
        assert.strictEqual(calls, 0);
    });
    await test('OpenAI 429 phân biệt hết credit, giới hạn chi tiêu và giới hạn lưu lượng', async () => {
        const config = { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'project-key' };
        const args = { messages: [{ role: 'user', content: 'Ping' }] };
        const throttled = (error, delay) => ({ status: 429, body: JSON.stringify({ error }), headers: { 'Retry-After': delay } });
        const cases = [
            [{ code: 'credit_balance_exhausted', type: 'insufficient_quota' }, '0', /hết credit/],
            [{ code: 'project_spend_limit_exceeded', type: 'insufficient_quota' }, '0', /Project OpenAI đã chạm giới hạn chi tiêu/],
            [{ type: 'insufficient_quota' }, '0', /hết hạn mức/],
            [{ code: 'slow_down' }, '12', /12 giây/],
            [{}, '0', /Billing, Limits hoặc mã lỗi/]
        ];
        for (const [error, delay, pattern] of cases) {
            setEnv(config);
            queue = [throttled(error, delay)];
            await H.capture(() => assert.rejects(AI.callModel(args), (err) => err.status === 429 && pattern.test(err.message)));
            assert.strictEqual(log.length, 1);
        }

        setEnv(config);
        queue = [throttled({ code: 'rate_limit_exceeded' }, '0'), response(responseText('OK'))];
        assert.strictEqual(AI.textOf((await AI.callModel(args)).content), 'OK');
        assert.strictEqual(log.length, 2);
        assert.deepStrictEqual(log[0].body, log[1].body);
    });
    await test('runAgent qua Gemini: gọi công cụ → gửi kết quả về đúng tool_call_id → nhận câu trả lời', async () => {
        setEnv({ AI_PROVIDER: 'gemini-openai', GEMINI_API_KEY: 'k' }); queue = [oaTool('get_product', { id: 1 }, 'abc'), oaText('Dell XPS 13 giá 25 triệu.')];
        let got; const r = await AI.runAgent({ system: 's', tools: [{ name: 'get_product', description: 'd', input_schema: { type: 'object' } }], messages: [{ role: 'user', content: 'giá Dell?' }], executeTool: async (b) => { got = b; return { price: 25000000 }; } });
        assert.strictEqual(r.text, 'Dell XPS 13 giá 25 triệu.'); assert.deepStrictEqual(got.input, { id: 1 });
        const second = log[1].body.messages; assert.deepStrictEqual(second.at(-1), { role: 'tool', tool_call_id: 'abc', name: 'get_product', content: '{"price":25000000}' }); // Gemini cần tên công cụ
        assert.strictEqual(second.at(-2).tool_calls[0].id, 'abc');
    });
    await test('chatbot admin qua Ollama: tra cứu chạy ngay; thao tác ghi vẫn chỉ tạo thẻ xác nhận (không thực hiện)', async () => {
        setEnv({ AI_PROVIDER: 'ollama' });
        queue = [oaTool('list_products', { max_stock: 10 }), oaText('Có 1 sản phẩm sắp hết: Laptop Dell XPS 13.')];
        let res = await chatService.runChat({ messages: [{ role: 'user', content: 'hàng sắp hết?' }], user: { id: 1, username: 'admin', role: 'admin' } });
        assert.strictEqual(res.reply, 'Có 1 sản phẩm sắp hết: Laptop Dell XPS 13.'); assert(JSON.parse(log[1].body.messages.at(-1).content).total_matched === 1);
        queue = [oaTool('delete_product', { id: 1 }), oaText('Mình đã chuẩn bị, bạn xác nhận nhé.')];
        res = await chatService.runChat({ messages: [{ role: 'user', content: 'xóa Dell' }], user: { id: 1, username: 'admin', role: 'admin' } });
        assert.strictEqual(res.pending_actions.length, 1); assert(/XÓA VĨNH VIỄN/.test(res.pending_actions[0].summary));
    });
    done(); setImmediate(() => process.exit(process.exitCode || 0));
})();
