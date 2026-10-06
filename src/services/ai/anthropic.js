'use strict';

/**
 * Lớp gọi mô hình AI dùng chung cho: trợ lý admin (chatService), trợ lý khách (support/customerAssistant)
 * và các nút AI (features). Chọn nhà cung cấp bằng AI_PROVIDER:
 *   - gemini: Google Gemini qua API GỐC (generateContent), cần GEMINI_API_KEY (lấy tại aistudio.google.com).
 *     Nếu không đặt AI_PROVIDER mà chỉ có GEMINI_API_KEY (không có ANTHROPIC_API_KEY) thì tự dùng Gemini.
 *   - anthropic: Claude, cần ANTHROPIC_API_KEY.
 *   - gemini-openai: Gemini qua endpoint tương thích OpenAI của Google (cách cũ, giữ lại để tương thích).
 *   - ollama: model chạy trên máy (miễn phí), mặc định http://localhost:11434/v1, không cần key.
 *   - openai-compatible: dịch vụ khác theo chuẩn OpenAI (Groq, OpenRouter...), cần AI_BASE_URL + AI_API_KEY.
 * Mọi nơi khác trong code dùng chung một định dạng nội bộ (kiểu Anthropic); việc chuyển đổi nằm trong
 * gemini.js (API gốc của Google) và openaiCompat.js (chuẩn OpenAI).
 * Dùng fetch có sẵn của Node >= 18, không cần thư viện ngoài. API key chỉ nằm ở server.
 */

const { toOpenAIMessages, toOpenAITools, fromOpenAIResponse } = require('./openaiCompat');
const { toGeminiContents, toGeminiTools, fromGeminiResponse } = require('./gemini');
const { explainFetchError, proxyTransport, rootCause } = require('./netDiagnostics');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta';
const PROVIDERS = ['anthropic', 'gemini', 'gemini-openai', 'ollama', 'openai-compatible'];
const DEFAULT_BASE = { ollama: 'http://localhost:11434/v1', 'gemini-openai': `${GEMINI_URL}/openai` };
// gemini-2.5-* bị Google tắt từ 16/10/2026 nên mặc định dùng đời 3.5; nếu model không tồn tại với key của bạn thì tự thử các model sau
const GEMINI_FALLBACK_MODELS = ['gemini-3.5-flash', 'gemini-flash-latest', 'gemini-3-flash-preview', 'gemini-2.5-flash'];
const DEFAULT_MODEL = { anthropic: 'claude-sonnet-5-5', ollama: 'qwen2.5:7b', gemini: GEMINI_FALLBACK_MODELS[0], 'gemini-openai': GEMINI_FALLBACK_MODELS[0] };

const isGemini = (p) => p === 'gemini' || p === 'gemini-openai';
const provider = () => {
    const p = String(process.env.AI_PROVIDER || '').trim().toLowerCase();
    if (PROVIDERS.includes(p)) return p;
    // Không chọn (hoặc chọn sai): có key Gemini mà không có key Claude thì dùng Gemini
    if (!process.env.ANTHROPIC_API_KEY && String(process.env.GEMINI_API_KEY || '').trim()) return 'gemini';
    return 'anthropic';
};
const geminiBase = () => String(process.env.GEMINI_BASE_URL || GEMINI_URL).replace(/\/+$/, '');
const baseUrl = () =>
    provider() === 'gemini' ? geminiBase() : String(process.env.AI_BASE_URL || DEFAULT_BASE[provider()] || '').replace(/\/+$/, '');
// Model chạy trên máy (CPU) chậm hơn nhiều so với API đám mây nên cho chờ lâu hơn
const timeoutMs = () => Number(process.env.AI_TIMEOUT_MS) || (provider() === 'ollama' ? 120000 : 45000);

/** Lỗi có thể hiển thị cho người dùng cùng mã HTTP tương ứng. */
class AiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
        this.expose = true;
    }
}

/** AI có dùng được không (để bật/tắt chatbot, trợ lý khách và các nút AI). */
const isConfigured = () => {
    const p = provider();
    if (p === 'anthropic') return !!process.env.ANTHROPIC_API_KEY;
    if (p === 'ollama') return true; // không cần key; nếu Ollama chưa chạy sẽ báo lỗi rõ khi gọi
    if (isGemini(p)) return !!apiKey();
    return !!baseUrl() && !!process.env.AI_MODEL;
};

// Model Gemini dùng được, tìm ra khi model mặc định không tồn tại (chỉ khi người dùng không tự đặt AI_MODEL)
let resolvedGeminiModel = null;
const userModel = () => String(process.env.AI_MODEL || '').trim();
const modelName = () =>
    userModel() || (provider() === 'gemini' && resolvedGeminiModel) || DEFAULT_MODEL[provider()] || DEFAULT_MODEL.anthropic;

/** Key cho Gemini / các nhà cung cấp kiểu OpenAI. Bỏ khoảng trắng/dấu nháy thừa hay gặp khi dán vào .env. */
const cleanKey = (v) => String(v || '').trim().replace(/^["']|["']$/g, '').trim();
const apiKey = () =>
    isGemini(provider()) ? cleanKey(process.env.GEMINI_API_KEY) || cleanKey(process.env.AI_API_KEY) : cleanKey(process.env.AI_API_KEY);

/** Địa chỉ gọi API (dùng cho chẩn đoán DNS ở scripts/ai-check.js). */
const endpointUrl = () => {
    if (provider() === 'anthropic') return ANTHROPIC_URL;
    if (provider() === 'gemini') return `${geminiBase()}/models/${encodeURIComponent(modelName())}:generateContent`;
    return `${baseUrl()}/chat/completions`;
};

/** Mô tả ngắn để in log khi khởi động server. */
const describe = () => {
    if (!isConfigured()) return `chưa cấu hình (${isGemini(provider()) ? 'thiếu GEMINI_API_KEY' : 'thiếu ANTHROPIC_API_KEY hoặc GEMINI_API_KEY'}) — chatbot, trợ lý khách và các nút AI sẽ tắt`;
    if (provider() === 'anthropic') return `Claude · ${modelName()}`;
    if (provider() === 'gemini') return `Google Gemini · ${modelName()} (API gốc)`;
    return `${provider()} · ${modelName()} @ ${baseUrl()}`;
};

async function callModel(args) {
    if (provider() === 'anthropic') return callAnthropic(args);
    if (provider() === 'gemini') return callGemini(args);
    return callOpenAICompatible(args);
}

async function callAnthropic({ system, tools, messages, maxTokens }) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        throw new AiError(503, 'Tính năng AI chưa được cấu hình: server thiếu biến môi trường ANTHROPIC_API_KEY.');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs());

    try {
        let res;
        try {
            const via = proxyTransport(ANTHROPIC_URL, (status, msg) => new AiError(status, msg));
            res = await (via ? via.fetch : fetch)(ANTHROPIC_URL, {
                ...(via ? { dispatcher: via.dispatcher } : {}),
                method: 'POST',
                signal: controller.signal,
                headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': API_VERSION },
                body: JSON.stringify({
                    model: modelName(),
                    max_tokens: maxTokens || Number(process.env.AI_MAX_TOKENS) || 1500,
                    system,
                    ...(tools && tools.length ? { tools } : {}),
                    messages
                })
            });
        } catch (err) {
            if (err instanceof AiError) throw err;
            if (err.name === 'AbortError') throw new AiError(504, 'AI phản hồi quá lâu, vui lòng thử lại.');
            const info = explainFetchError(err, { url: ANTHROPIC_URL, provider: 'Claude' });
            console.error(`[ai] Không gọi được ${ANTHROPIC_URL}: ${info.code} — ${rootCause(err).message || err.message}`);
            throw new AiError(502, info.message);
        }

        if (!res.ok) {
            const body = await res.text().catch(() => '');
            console.error('[ai] Anthropic API error', res.status, body.slice(0, 500));
            if (res.status === 401 || res.status === 403) throw new AiError(502, 'Dịch vụ AI từ chối yêu cầu. Quản trị viên hãy kiểm tra ANTHROPIC_API_KEY trên server.');
            if (res.status === 404) throw new AiError(502, 'Model AI không tồn tại. Hãy kiểm tra biến AI_MODEL trên server.');
            if (res.status === 429) throw new AiError(429, 'Dịch vụ AI đang bị giới hạn lưu lượng, vui lòng thử lại sau ít phút.');
            if (res.status >= 500) throw new AiError(503, 'Dịch vụ AI đang quá tải hoặc gặp sự cố, vui lòng thử lại sau.');
            throw new AiError(502, 'Yêu cầu tới dịch vụ AI không hợp lệ.');
        }

        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

/** Gemini 2.5 Flash mặc định "suy nghĩ" và tính phần đó vào max_tokens nên câu trả lời dễ bị cắt/rỗng: tắt suy nghĩ cho model flash. */
const reasoningEffort = () => {
    if (process.env.AI_REASONING_EFFORT !== undefined) return process.env.AI_REASONING_EFFORT.trim() || undefined; // đặt rỗng = không gửi
    return provider() === 'gemini-openai' && /gemini-2\.5-flash/i.test(modelName()) ? 'none' : undefined;
};

/** Ollama / Gemini / Groq / OpenRouter...: chuyển định dạng nội bộ sang Chat Completions rồi chuyển phản hồi về lại. */
async function callOpenAICompatible({ system, tools, messages, maxTokens }) {
    const url = `${baseUrl()}/chat/completions`;
    const local = provider() === 'ollama';
    const gemini = provider() === 'gemini-openai';
    if (!baseUrl()) throw new AiError(503, 'Tính năng AI chưa được cấu hình: thiếu AI_BASE_URL.');
    if (gemini && !apiKey()) throw new AiError(503, 'Tính năng AI chưa được cấu hình: server thiếu GEMINI_API_KEY.');

    const headers = { 'content-type': 'application/json' };
    if (apiKey()) headers.authorization = `Bearer ${apiKey()}`;
    if (gemini && apiKey()) headers['x-goog-api-key'] = apiKey(); // key kiểu mới của Google nhận qua header này; gửi cả hai cho chắc

    const buildBody = (withReasoning) => JSON.stringify({
        model: modelName(),
        max_tokens: maxTokens || Number(process.env.AI_MAX_TOKENS) || 1500,
        temperature: 0.2, // model nhỏ ổn định hơn khi dùng công cụ với nhiệt độ thấp
        messages: toOpenAIMessages(system, messages, { toolName: gemini }),
        ...(tools && tools.length ? { tools: toOpenAITools(tools) } : {}),
        ...(withReasoning && reasoningEffort() ? { reasoning_effort: reasoningEffort() } : {}),
        stream: false
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs());

    const send = async (withReasoning) => {
        try {
            const via = proxyTransport(url, (status, msg) => new AiError(status, msg));
            return await (via ? via.fetch : fetch)(url, {
                ...(via ? { dispatcher: via.dispatcher } : {}),
                method: 'POST',
                signal: controller.signal,
                headers,
                body: buildBody(withReasoning)
            });
        } catch (err) {
            if (err instanceof AiError) throw err;
            if (err.name === 'AbortError') {
                throw new AiError(504, local
                    ? 'Model trên máy phản hồi quá lâu. Hãy dùng model nhỏ hơn (AI_MODEL) hoặc tăng AI_TIMEOUT_MS.'
                    : 'AI phản hồi quá lâu, vui lòng thử lại.');
            }
            const info = explainFetchError(err, { url, provider: provider() });
            console.error(`[ai] Không gọi được ${url}: ${info.code} — ${rootCause(err).message || err.message}`);
            if (local && info.code === 'ECONNREFUSED') {
                throw new AiError(502, `Không kết nối được tới Ollama tại ${baseUrl()}. Hãy kiểm tra Ollama đang chạy (lệnh: ollama serve).`);
            }
            throw new AiError(502, info.message);
        }
    };

    try {
        let res = await send(true);
        let body = res.ok ? '' : await res.text().catch(() => '');
        // Model/nhà cung cấp không hiểu reasoning_effort: gửi lại không kèm tham số đó
        if (!res.ok && res.status === 400 && reasoningEffort() && /reasoning/i.test(body)) {
            console.warn('[ai] Nhà cung cấp không nhận reasoning_effort, thử lại không có tham số này.');
            res = await send(false);
            body = res.ok ? '' : await res.text().catch(() => '');
        }

        if (!res.ok) {
            console.error(`[ai] ${provider()} error`, res.status, body.slice(0, 500));
            if (res.status === 404) {
                throw new AiError(502, local
                    ? `Chưa có model "${modelName()}" trên máy. Hãy chạy: ollama pull ${modelName()}`
                    : `Model AI "${modelName()}" không tồn tại hoặc không dùng được với key này. Hãy kiểm tra biến AI_MODEL.`);
            }
            if (gemini && (res.status === 400 || res.status === 401 || res.status === 403) && /api[ _-]?key|credential|authenticat|permission/i.test(body)) {
                throw new AiError(502, 'Google từ chối GEMINI_API_KEY (key sai, đã bị xóa, hoặc chưa bật quyền dùng Gemini API). Hãy tạo key mới tại aistudio.google.com rồi cập nhật .env.');
            }
            if (gemini && res.status === 429) {
                throw new AiError(429, 'Đã dùng hết lượt miễn phí của Gemini trong lúc này. Vui lòng thử lại sau ít phút (hoặc ngày mai nếu hết lượt trong ngày).');
            }
            if (local && /support.{0,10}tools?/i.test(body)) {
                throw new AiError(502, `Model "${modelName()}" không hỗ trợ gọi công cụ. Hãy dùng model có hỗ trợ, ví dụ qwen2.5:7b hoặc llama3.1:8b.`);
            }
            if (res.status === 400 && /tool|function/i.test(body)) {
                const detail = body.replace(/\s+/g, ' ').slice(0, 200);
                throw new AiError(502, `Nhà cung cấp từ chối phần khai báo công cụ của chatbot (model "${modelName()}"). Chi tiết: ${detail}`);
            }
            if (res.status === 401 || res.status === 403) throw new AiError(502, `Dịch vụ AI từ chối yêu cầu. Hãy kiểm tra ${gemini ? 'GEMINI_API_KEY' : 'AI_API_KEY'} trên server.`);
            if (res.status === 429) throw new AiError(429, 'Dịch vụ AI đang bị giới hạn lưu lượng, vui lòng thử lại sau ít phút.');
            if (res.status >= 500) throw new AiError(503, 'Dịch vụ AI đang quá tải hoặc gặp sự cố, vui lòng thử lại sau.');
            throw new AiError(502, `Yêu cầu tới dịch vụ AI không hợp lệ (mã ${res.status}).`);
        }

        return fromOpenAIResponse(await res.json());
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Cấu hình "suy nghĩ" cho Gemini. Phần suy nghĩ tính vào số token trả lời nên nếu để mặc định câu trả lời dễ bị cắt/rỗng.
 *  - Đời 2.5 Flash: tắt hẳn (thinkingBudget 0).  - Đời 3.x trở lên: mức thấp (thinkingLevel LOW) — không tắt hẳn được.
 *  - AI_THINKING_LEVEL=minimal|low|medium|high (hoặc một con số = thinkingBudget) để tự chọn; đặt rỗng = không gửi.
 */
function geminiThinking(model) {
    const env = process.env.AI_THINKING_LEVEL;
    if (env !== undefined) {
        const v = env.trim();
        if (!v) return undefined;
        return /^-?\d+$/.test(v) ? { thinkingBudget: Number(v) } : { thinkingLevel: v.toUpperCase() };
    }
    if (/gemini-2\.5-flash/i.test(model)) return { thinkingBudget: 0 };
    if (/gemini-([3-9]|\d{2,})|latest/i.test(model)) return { thinkingLevel: 'LOW' };
    return undefined;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Google Gemini qua API gốc generateContent (giữ thoughtSignature của Gemini 3.x khi gọi công cụ). */
async function callGemini({ system, tools, messages, maxTokens }) {
    const key = apiKey();
    if (!key) throw new AiError(503, 'Tính năng AI chưa được cấu hình: server thiếu GEMINI_API_KEY (lấy tại aistudio.google.com).');

    const baseTokens = maxTokens || Number(process.env.AI_MAX_TOKENS) || 1500;
    const contents = toGeminiContents(messages);
    if (!contents.length) contents.push({ role: 'user', parts: [{ text: '.' }] }); // Google không nhận contents rỗng
    const geminiTools = tools && tools.length ? toGeminiTools(tools) : undefined;

    const buildBody = (model, withThinking) => {
        const thinking = withThinking ? geminiThinking(model) : undefined;
        const thinks = !thinking || thinking.thinkingBudget !== 0;
        const generationConfig = {
            // còn "suy nghĩ" thì chừa thêm chỗ để phần trả lời không bị cắt
            maxOutputTokens: baseTokens + (thinks ? Number(process.env.AI_THINKING_EXTRA_TOKENS) || 2048 : 0),
            // Google khuyên giữ nhiệt độ mặc định cho đời 3.x (đặt thấp dễ bị lặp); đời cũ để thấp cho ổn định khi gọi công cụ
            ...(/gemini-([3-9]|\d{2,})|latest/i.test(model) ? {} : { temperature: 0.2 }),
            ...(thinking ? { thinkingConfig: thinking } : {})
        };
        return JSON.stringify({
            ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
            contents,
            ...(geminiTools ? { tools: geminiTools } : {}),
            generationConfig
        });
    };

    const send = async (model, withThinking) => {
        const url = `${geminiBase()}/models/${encodeURIComponent(model)}:generateContent`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs());
        try {
            const via = proxyTransport(url, (status, msg) => new AiError(status, msg));
            const res = await (via ? via.fetch : fetch)(url, {
                ...(via ? { dispatcher: via.dispatcher } : {}),
                method: 'POST',
                signal: controller.signal,
                // key gửi qua header (không đặt trong URL để không lọt vào log)
                headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
                body: buildBody(model, withThinking)
            });
            const body = res.ok ? null : await res.text().catch(() => '');
            const json = res.ok ? await res.json() : null;
            return { res, body, json };
        } catch (err) {
            if (err instanceof AiError) throw err;
            if (err.name === 'AbortError') throw new AiError(504, 'Gemini phản hồi quá lâu, vui lòng thử lại.');
            const info = explainFetchError(err, { url, provider: 'Gemini' });
            console.error(`[ai] Không gọi được ${geminiBase()}: ${info.code} — ${rootCause(err).message || err.message}`);
            throw new AiError(502, info.message);
        } finally {
            clearTimeout(timer);
        }
    };

    // Thử lần lượt: model người dùng đặt (hoặc model đã dò được) → các model dự phòng nếu model mặc định không tồn tại
    const candidates = userModel()
        ? [userModel()]
        : [...new Set([resolvedGeminiModel || GEMINI_FALLBACK_MODELS[0], ...GEMINI_FALLBACK_MODELS])];

    let last;
    for (const model of candidates) {
        let withThinking = true;
        let retried5xx = false;
        let retriedMalformed = false;
        for (;;) {
            last = await send(model, withThinking);
            const { res, body } = last;
            if (res.ok) {
                const out = fromGeminiResponse(last.json);
                // Gemini thỉnh thoảng sinh lời gọi công cụ hỏng: thử lại một lần
                if (out.finish_reason === 'MALFORMED_FUNCTION_CALL' && !retriedMalformed) {
                    retriedMalformed = true;
                    console.warn('[ai] Gemini trả về lời gọi công cụ hỏng, thử lại.');
                    continue;
                }
                if (!userModel() && model !== candidates[0]) {
                    console.warn(`[ai] Model Gemini "${candidates[0]}" không dùng được với key này, chuyển sang "${model}".`);
                    resolvedGeminiModel = model;
                }
                return out;
            }
            // Model không nhận cấu hình "suy nghĩ" đang gửi: gửi lại không kèm
            if (res.status === 400 && withThinking && geminiThinking(model) && /think/i.test(body)) {
                console.warn(`[ai] Model "${model}" không nhận thinkingConfig, thử lại không có tham số này.`);
                withThinking = false;
                continue;
            }
            // Google quá tải tạm thời (rất hay gặp ở gói miễn phí): chờ chút rồi thử lại một lần
            if ((res.status === 500 || res.status === 503) && !retried5xx) {
                retried5xx = true;
                await sleep(Number(process.env.AI_RETRY_DELAY_MS) || 1000);
                continue;
            }
            break;
        }
        if (last.res.status !== 404) break; // chỉ lỗi "không có model" mới thử model dự phòng
    }

    const { res, body } = last;
    const detail = String(body || '').replace(/\s+/g, ' ').slice(0, 500);
    console.error('[ai] gemini error', res.status, detail);
    if (res.status === 404) {
        throw new AiError(502, userModel()
            ? `Model Gemini "${userModel()}" không tồn tại hoặc đã bị Google ngừng. Hãy sửa AI_MODEL (ví dụ ${GEMINI_FALLBACK_MODELS[0]}) hoặc xóa dòng đó để dùng mặc định.`
            : `Không tìm được model Gemini nào dùng được với key này (đã thử: ${candidates.join(', ')}). Hãy đặt AI_MODEL theo danh sách tại aistudio.google.com.`);
    }
    if ((res.status === 400 || res.status === 401 || res.status === 403) && /api[ _-]?key|credential|authenticat|permission|unregistered/i.test(detail)) {
        throw new AiError(502, 'Google từ chối GEMINI_API_KEY (key sai, đã bị xóa, hoặc chưa bật quyền dùng Gemini API). Hãy tạo key mới tại aistudio.google.com rồi cập nhật .env.');
    }
    if (/location is not supported|not available in your country|FAILED_PRECONDITION/i.test(detail)) {
        throw new AiError(502, 'Google chưa hỗ trợ Gemini API ở khu vực của máy chủ (hoặc gói miễn phí không dùng được ở đây). Hãy bật thanh toán cho project hoặc chạy backend ở khu vực được hỗ trợ.');
    }
    if (res.status === 429) {
        throw new AiError(429, 'Đã dùng hết lượt miễn phí của Gemini trong lúc này. Vui lòng thử lại sau ít phút (hoặc ngày mai nếu hết lượt trong ngày).');
    }
    if (res.status === 400 && /function|tool|schema|parameters/i.test(detail)) {
        throw new AiError(502, `Gemini từ chối phần khai báo công cụ của chatbot (model "${modelName()}"). Chi tiết: ${detail.slice(0, 200)}`);
    }
    if (res.status >= 500) throw new AiError(503, 'Gemini đang quá tải hoặc gặp sự cố, vui lòng thử lại sau.');
    throw new AiError(502, `Yêu cầu tới Gemini không hợp lệ (mã ${res.status}). Chi tiết: ${detail.slice(0, 200)}`);
}

const textOf = (content) =>
    (Array.isArray(content) ? content : [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();

/**
 * Vòng lặp "agent" tổng quát: gọi mô hình, chạy các tool_use qua `executeTool`, gửi kết quả lại, lặp lại.
 * @param {{system:string, tools?:object[], messages:object[], executeTool:(block:object)=>Promise<string|object>, maxSteps?:number, maxTokens?:number}} args
 * @returns {Promise<{text:string, steps:number, toolCalls:string[]}>}
 */
async function runAgent({ system, tools = [], messages, executeTool, maxSteps = 5, maxTokens }) {
    const convo = messages.map((m) => ({ role: m.role, content: m.content }));
    const toolCalls = [];
    let text = '';

    for (let step = 1; step <= maxSteps; step += 1) {
        const resp = await callModel({ system, tools, messages: convo, maxTokens });
        const content = Array.isArray(resp.content) ? resp.content : [];
        convo.push({ role: 'assistant', content });
        text = textOf(content);

        if (resp.stop_reason !== 'tool_use') return { text, steps: step, toolCalls };

        const results = [];
        for (const block of content.filter((b) => b.type === 'tool_use')) {
            toolCalls.push(block.name);
            let out;
            let isError = false;
            try {
                out = await executeTool(block);
            } catch (err) {
                isError = true;
                out = err && err.expose ? err.message : 'Không thực hiện được thao tác này.';
            }
            const str = typeof out === 'string' ? out : JSON.stringify(out);
            results.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: str.length > 8000 ? `${str.slice(0, 8000)}… [đã cắt bớt]` : str,
                ...(isError ? { is_error: true } : {})
            });
        }
        convo.push({ role: 'user', content: results });
    }
    return { text, steps: maxSteps, toolCalls };
}

module.exports = {
    AiError, callModel, runAgent, textOf, isConfigured, modelName, provider, describe, endpointUrl,
    GEMINI_FALLBACK_MODELS, _resetGeminiModel: () => { resolvedGeminiModel = null; }
};
