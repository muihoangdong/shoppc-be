'use strict';

/**
 * Bộ chuyển đổi cho API GỐC của Google Gemini (generateContent):
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent   (header x-goog-api-key)
 *
 * Vì sao không dùng endpoint "tương thích OpenAI" của Google:
 *  - Gemini 3.x khi gọi công cụ trả về "thoughtSignature" và BẮT BUỘC gửi lại nguyên vẹn ở lượt sau, nếu không
 *    Google báo lỗi 400. API gốc cho phép giữ nguyên chữ ký này (lưu trên block tool_use/text nội bộ).
 *  - Điều khiển được "suy nghĩ" (thinkingConfig) đúng theo từng đời model, đọc được lý do bị chặn (an toàn, hết token...).
 *
 * Định dạng nội bộ vẫn là kiểu Anthropic (content blocks text / tool_use / tool_result) để mọi nơi khác không phải sửa.
 */

const crypto = require('crypto');

// Từ khóa schema mà kiểu Schema (OpenAPI) của Gemini hiểu. Mọi từ khóa khác bị lược để Google không từ chối khai báo công cụ.
const SCHEMA_KEYS = new Set([
    'type', 'format', 'description', 'nullable', 'enum', 'properties', 'required', 'items',
    'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'anyOf'
]);

/** JSON Schema (input_schema của công cụ) -> Schema của Gemini. */
function toGeminiSchema(schema) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return undefined;
    const out = {};
    for (const [k, v] of Object.entries(schema)) {
        if (!SCHEMA_KEYS.has(k)) continue;
        if (k === 'type') {
            // ["integer", "null"] -> type: "integer", nullable: true
            const types = (Array.isArray(v) ? v : [v]).filter((t) => typeof t === 'string');
            const real = types.filter((t) => t !== 'null');
            if (real.length) out.type = real[0];
            if (types.includes('null')) out.nullable = true;
        } else if (k === 'properties' && v && typeof v === 'object') {
            out.properties = Object.fromEntries(Object.entries(v).map(([name, sub]) => [name, toGeminiSchema(sub) || {}]));
        } else if (k === 'items') {
            out.items = toGeminiSchema(v) || {};
        } else if (k === 'anyOf' && Array.isArray(v)) {
            out.anyOf = v.map((s) => toGeminiSchema(s) || {});
        } else if (k === 'enum' && Array.isArray(v)) {
            out.enum = v.map(String); // Gemini chỉ nhận enum dạng chuỗi
            if (!out.type) out.type = 'string';
        } else {
            out[k] = v;
        }
    }
    if (out.enum && out.type !== 'string') out.type = 'string';
    if (Array.isArray(out.required) && out.properties) {
        out.required = out.required.filter((r) => Object.prototype.hasOwnProperty.call(out.properties, r));
        if (!out.required.length) delete out.required;
    }
    return out;
}

const isEmptyObjectSchema = (s) => !s || (s.type === 'object' && (!s.properties || Object.keys(s.properties).length === 0));

/** tools nội bộ -> [{ functionDeclarations: [...] }]. Công cụ không tham số thì bỏ hẳn "parameters" (Gemini từ chối object rỗng). */
function toGeminiTools(tools = []) {
    if (!tools.length) return undefined;
    return [{
        functionDeclarations: tools.map((t) => {
            const parameters = toGeminiSchema(t.input_schema);
            return { name: t.name, description: t.description || '', ...(isEmptyObjectSchema(parameters) ? {} : { parameters }) };
        })
    }];
}

/** Kết quả công cụ (chuỗi, thường là JSON) -> object cho functionResponse.response (Google yêu cầu là object). */
function toResponseObject(content, isError) {
    const str = typeof content === 'string' ? content : JSON.stringify(content);
    if (isError) return { error: str };
    try {
        const parsed = JSON.parse(str);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        return { result: parsed };
    } catch {
        return { result: str };
    }
}

/** messages nội bộ -> { contents } của Gemini. Vai trò assistant = "model". Các lượt cùng vai trò liền nhau được gộp. */
function toGeminiContents(messages) {
    const contents = [];
    const toolNames = new Map(); // tool_use id -> tên công cụ (functionResponse cần tên)
    const push = (role, parts) => {
        if (!parts.length) return;
        const last = contents[contents.length - 1];
        if (last && last.role === role) last.parts.push(...parts);
        else contents.push({ role, parts });
    };

    for (const m of messages) {
        const role = m.role === 'assistant' ? 'model' : 'user';
        if (typeof m.content === 'string') {
            if (m.content) push(role, [{ text: m.content }]);
            continue;
        }
        const parts = [];
        for (const b of Array.isArray(m.content) ? m.content : []) {
            if (b.type === 'text' && (b.text || b.thought_signature)) {
                parts.push({ text: b.text, ...(b.thought_signature ? { thoughtSignature: b.thought_signature } : {}) });
            } else if (b.type === 'tool_use') {
                toolNames.set(b.id, b.name);
                parts.push({
                    functionCall: { name: b.name, args: b.input || {}, ...(b.gemini_id ? { id: b.gemini_id } : {}) },
                    ...(b.thought_signature ? { thoughtSignature: b.thought_signature } : {})
                });
            } else if (b.type === 'tool_result') {
                const name = toolNames.get(b.tool_use_id) || 'unknown_tool';
                const fromGemini = String(b.tool_use_id || '').startsWith('gm_') ? null : b.tool_use_id;
                parts.push({
                    functionResponse: {
                        name,
                        response: toResponseObject(b.content, b.is_error),
                        ...(fromGemini ? { id: fromGemini } : {})
                    }
                });
            }
        }
        push(role, parts);
    }
    return contents;
}

const REFUSAL_REASONS = new Set(['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY', 'LANGUAGE']);

/** Phản hồi Gemini -> định dạng nội bộ { content, stop_reason, finish_reason }. Giữ thoughtSignature để gửi lại lượt sau. */
function fromGeminiResponse(json) {
    const cand = (json && Array.isArray(json.candidates) && json.candidates[0]) || null;
    if (!cand) {
        const blocked = json && json.promptFeedback && json.promptFeedback.blockReason;
        return { content: [], stop_reason: blocked ? 'refusal' : 'end_turn', finish_reason: blocked || 'EMPTY' };
    }
    const parts = (cand.content && Array.isArray(cand.content.parts)) ? cand.content.parts : [];
    const content = [];
    for (const p of parts) {
        if (p.thought) continue; // phần "suy nghĩ" nội bộ của model, không hiển thị
        if (p.functionCall && p.functionCall.name) {
            const args = p.functionCall.args;
            content.push({
                type: 'tool_use',
                // id của Google (nếu có) được giữ riêng để gửi lại đúng; id nội bộ luôn duy nhất
                id: p.functionCall.id || `gm_${crypto.randomUUID().slice(0, 12)}`,
                name: p.functionCall.name,
                input: args && typeof args === 'object' && !Array.isArray(args) ? args : {},
                ...(p.functionCall.id ? { gemini_id: p.functionCall.id } : {}),
                ...(p.thoughtSignature ? { thought_signature: p.thoughtSignature } : {})
            });
        } else if (typeof p.text === 'string' && (p.text.trim() || p.thoughtSignature)) {
            content.push({ type: 'text', text: p.text.trim(), ...(p.thoughtSignature ? { thought_signature: p.thoughtSignature } : {}) });
        }
    }
    const reason = cand.finishReason || 'STOP';
    let stop_reason = 'end_turn';
    if (content.some((b) => b.type === 'tool_use')) stop_reason = 'tool_use';
    else if (reason === 'MAX_TOKENS') stop_reason = 'max_tokens';
    else if (REFUSAL_REASONS.has(reason)) stop_reason = 'refusal';
    return { content, stop_reason, finish_reason: reason };
}

module.exports = { toGeminiSchema, toGeminiTools, toGeminiContents, fromGeminiResponse, toResponseObject };
