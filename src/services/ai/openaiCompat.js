'use strict';

/**
 * Bộ chuyển đổi giữa định dạng nội bộ (kiểu Anthropic Messages: content blocks text / tool_use / tool_result)
 * và API "Chat Completions" kiểu OpenAI — chuẩn mà Ollama (http://localhost:11434/v1), Groq, OpenRouter,
 * Gemini (endpoint tương thích OpenAI)… đều hỗ trợ. Nhờ vậy chatbot, trợ lý khách và các nút AI không phải sửa gì.
 */

const crypto = require('crypto');

const textOfBlocks = (blocks) =>
    blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');

/** messages nội bộ -> messages OpenAI. opts.toolName: ghi thêm "name" vào kết quả công cụ (Gemini cần). */
function toOpenAIMessages(system, messages, opts = {}) {
    const out = [];
    const toolNames = new Map(); // tool_use id -> tên công cụ
    if (system) out.push({ role: 'system', content: system });
    for (const m of messages) {
        if (typeof m.content === 'string') {
            out.push({ role: m.role, content: m.content });
            continue;
        }
        const blocks = Array.isArray(m.content) ? m.content : [];
        if (m.role === 'assistant') {
            const toolUses = blocks.filter((b) => b.type === 'tool_use');
            toolUses.forEach((b) => toolNames.set(b.id, b.name));
            const msg = { role: 'assistant', content: textOfBlocks(blocks) || (toolUses.length ? null : '') };
            if (toolUses.length) {
                msg.tool_calls = toolUses.map((b) => ({
                    id: b.id,
                    type: 'function',
                    function: { name: b.name, arguments: JSON.stringify(b.input || {}) }
                }));
            }
            out.push(msg);
        } else {
            // user: kết quả công cụ -> các message role "tool"; phần chữ (nếu có) -> message user
            for (const b of blocks.filter((x) => x.type === 'tool_result')) {
                const content = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
                out.push({
                    role: 'tool',
                    tool_call_id: b.tool_use_id,
                    ...(opts.toolName && toolNames.has(b.tool_use_id) ? { name: toolNames.get(b.tool_use_id) } : {}),
                    content: b.is_error ? `LỖI: ${content}` : content
                });
            }
            const text = textOfBlocks(blocks);
            if (text) out.push({ role: 'user', content: text });
        }
    }
    return out;
}

// Từ khóa JSON-Schema mà một số nhà cung cấp (Gemini) từ chối hoặc không hiểu
const DROP_KEYS = new Set(['$schema', 'additionalProperties', 'default', 'examples', 'title']);

/** Làm sạch schema tham số công cụ. Trả về undefined nếu không có tham số nào: Gemini báo lỗi với object rỗng. */
function cleanSchema(schema) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
    const out = {};
    for (const [k, v] of Object.entries(schema)) {
        if (DROP_KEYS.has(k)) continue;
        if (k === 'properties' && v && typeof v === 'object') {
            out.properties = Object.fromEntries(Object.entries(v).map(([name, sub]) => [name, cleanSchema(sub)]));
        } else if (k === 'items') {
            out.items = cleanSchema(v);
        } else {
            out[k] = v;
        }
    }
    return out;
}

const isEmptyObjectSchema = (s) => !s || (s.type === 'object' && (!s.properties || Object.keys(s.properties).length === 0));

/** tools nội bộ -> tools OpenAI (công cụ không có tham số thì bỏ hẳn trường parameters) */
const toOpenAITools = (tools = []) =>
    tools.map((t) => {
        const parameters = cleanSchema(t.input_schema);
        return {
            type: 'function',
            function: { name: t.name, description: t.description, ...(isEmptyObjectSchema(parameters) ? {} : { parameters }) }
        };
    });

/** Phản hồi OpenAI -> định dạng nội bộ { content: [...blocks], stop_reason } */
function fromOpenAIResponse(json) {
    const choice = (json && Array.isArray(json.choices) && json.choices[0]) || {};
    const msg = choice.message || {};
    const content = [];
    if (typeof msg.content === 'string' && msg.content.trim()) content.push({ type: 'text', text: msg.content.trim() });
    for (const call of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
        const fn = call.function || {};
        let input = {};
        if (fn.arguments && typeof fn.arguments === 'object') input = fn.arguments; // một số model trả object sẵn
        else if (typeof fn.arguments === 'string' && fn.arguments.trim()) {
            try {
                input = JSON.parse(fn.arguments);
            } catch {
                input = {}; // JSON hỏng: để bước kiểm tra đầu vào của tool báo lỗi cho model sửa
            }
        }
        if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};
        content.push({ type: 'tool_use', id: call.id || `call_${crypto.randomUUID().slice(0, 12)}`, name: fn.name, input });
    }
    const hasTools = content.some((b) => b.type === 'tool_use');
    const stop_reason = hasTools ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn';
    return { content, stop_reason };
}

module.exports = { toOpenAIMessages, toOpenAITools, fromOpenAIResponse, cleanSchema };
