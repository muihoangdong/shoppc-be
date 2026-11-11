'use strict';

// Giữ nguyên thứ tự các output item (kể cả reasoning mã hóa) trong vòng gọi công cụ.
// Hai vòng lặp chat giữ nguyên mảng content. WeakMap giữ dữ liệu này ở backend trong lượt chat.
const responseItems = new WeakMap();

const quotaMessages = new Map([
    ['credit_balance_exhausted', 'Tổ chức OpenAI đã hết credit API. Hãy nạp thêm credit trong phần Billing.'],
    ['organization_spend_limit_exceeded', 'Tổ chức OpenAI đã chạm giới hạn chi tiêu. Hãy kiểm tra Limits của tổ chức.'],
    ['project_spend_limit_exceeded', 'Project OpenAI đã chạm giới hạn chi tiêu. Hãy kiểm tra Limits của project.'],
    ['organization_usage_limit_exceeded', 'Tổ chức đã chạm hạn mức sử dụng do OpenAI cấp. Hãy kiểm tra Limits của tổ chức.'],
    ['insufficient_quota', 'Project OpenAI hết hạn mức. Hãy kiểm tra Billing và Limits.']
]);

function openAIRateLimit(error, retryAfter) {
    const quota = quotaMessages.get(error?.code) || quotaMessages.get(error?.type);
    if (quota) return { message: quota };

    const throttled = error?.type === 'rate_limit_error' || ['rate_limit_exceeded', 'slow_down'].includes(error?.code);
    if (!throttled) {
        return { message: 'OpenAI từ chối yêu cầu (429). Hãy kiểm tra Billing, Limits hoặc mã lỗi trong log backend.' };
    }

    let retryMs;
    if (retryAfter?.trim()) {
        const seconds = Number(retryAfter);
        const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
        if (Number.isFinite(delay)) retryMs = Math.max(0, delay);
    }
    const wait = retryMs > 0 ? `Thử lại sau ít nhất ${Math.ceil(retryMs / 1000)} giây.` : 'Vui lòng thử lại sau.';
    return { message: `OpenAI đang giới hạn lưu lượng. ${wait}`, retryMs };
}

function toResponsesInput(messages) {
    const input = [];
    for (const { role, content } of messages) {
        if (typeof content === 'string') {
            input.push({ role, content });
        } else if (role === 'assistant' && responseItems.has(content)) {
            input.push(...responseItems.get(content));
        } else {
            for (const block of content || []) {
                if (block.type === 'text') input.push({ role, content: block.text });
                if (block.type === 'tool_result') {
                    const output = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
                    input.push({
                        type: 'function_call_output',
                        call_id: block.tool_use_id,
                        output: block.is_error ? `LỖI: ${output}` : output
                    });
                }
            }
        }
    }
    return input;
}

const toResponsesTools = (tools) => tools.map(({ name, description, input_schema }) => ({
    type: 'function', name, description, parameters: input_schema, strict: false
}));

function fromResponsesOutput(response) {
    if (response?.status === 'incomplete') {
        return { content: [], stop_reason: response.incomplete_details?.reason === 'content_filter' ? 'refusal' : 'max_tokens' };
    }
    if (response?.status !== 'completed' || !Array.isArray(response.output)) throw new Error('OpenAI response did not complete');

    const content = [];
    let refused = false;
    for (const item of response.output) {
        if (item.type === 'message') {
            for (const part of item.content || []) {
                if (part.type === 'output_text' && part.text?.trim()) content.push({ type: 'text', text: part.text.trim() });
                if (part.type === 'refusal') refused = true;
            }
        } else if (item.type === 'function_call') {
            const args = JSON.parse(item.arguments);
            if (!item.call_id || !item.name || !args || typeof args !== 'object' || Array.isArray(args)) {
                throw new Error('Invalid OpenAI function call');
            }
            content.push({ type: 'tool_use', id: item.call_id, name: item.name, input: args });
        }
    }
    responseItems.set(content, response.output);
    const stop_reason = refused ? 'refusal' : content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
    return { content, stop_reason };
}

module.exports = { toResponsesInput, toResponsesTools, fromResponsesOutput, openAIRateLimit };
