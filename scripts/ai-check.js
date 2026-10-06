#!/usr/bin/env node
'use strict';

/**
 * Chẩn đoán kết nối AI:   npm run ai:check
 * Kiểm tra lần lượt: phiên bản Node, cấu hình (.env), phân giải DNS, một lời gọi mô hình thật rất ngắn, rồi một lời gọi
 * kèm ĐÚNG bộ công cụ mà chatbot admin gửi (phát hiện nhà cung cấp từ chối khai báo công cụ). In ra kết luận + cách sửa.
 * Không in API key.
 */

const dns = require('dns').promises;

const mask = (v) => (v ? `đã đặt (${String(v).length} ký tự, bắt đầu "${String(v).slice(0, 3)}…")` : 'CHƯA đặt');

async function run({ log = console.log, ai, tools, env = process.env, nodeVersion = process.version, lookup = dns.lookup } = {}) {
    const results = [];
    const step = (ok, title, detail) => {
        results.push(ok);
        log(`${ok ? '✅' : '❌'} ${title}${detail ? `\n     ${detail}` : ''}`);
        return ok;
    };

    log('\n── Chẩn đoán kết nối AI ──────────────────────────────');
    const major = Number(String(nodeVersion).replace(/^v/, '').split('.')[0]);
    step(major >= 18, `Node.js ${nodeVersion}`, major >= 18 ? '' : 'Cần Node.js 18 trở lên (để có sẵn fetch). Hãy cập nhật Node.');

    const provider = ai.provider();
    const key = provider === 'anthropic' ? env.ANTHROPIC_API_KEY : provider.startsWith('gemini') ? env.GEMINI_API_KEY || env.AI_API_KEY : env.AI_API_KEY;
    log(`   Nhà cung cấp : ${provider}`);
    log(`   Model        : ${ai.modelName()}`);
    log(`   Khóa API     : ${provider === 'ollama' ? '(Ollama không cần key)' : mask(key)}`);
    if (env.AI_PROXY_URL) log(`   Proxy        : ${env.AI_PROXY_URL}`);

    if (!step(ai.isConfigured(), 'Cấu hình', ai.isConfigured() ? ai.describe() : `Chưa đủ: ${ai.describe()}`)) return finish(results, log);

    const url = ai.endpointUrl();
    const host = new URL(url).hostname;
    try {
        const addrs = await lookup(host, { all: true });
        step(true, `DNS: ${host}`, addrs.map((a) => `${a.address} (IPv${a.family})`).join(', '));
    } catch (error) {
        step(false, `DNS: ${host}`, `${error.code || error.message}. Kiểm tra Internet/DNS (thử DNS 8.8.8.8), hoặc bật VPN nếu mạng chặn.`);
        return finish(results, log);
    }

    const started = Date.now();
    let first;
    try {
        first = await ai.callModel({ system: 'Chỉ trả lời đúng một từ: OK', messages: [{ role: 'user', content: 'Ping' }], maxTokens: 50 });
        const text = (first.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
        step(true, `Gọi mô hình (${Date.now() - started} ms)`, text ? `Mô hình trả lời: "${text.slice(0, 60)}"` : 'Nhà cung cấp trả về phản hồi hợp lệ nhưng không có chữ (xem mục lưu ý bên dưới).');
        if (!text) log('   ⚠️  Phản hồi rỗng thường do model dùng hết số token để "suy nghĩ". Gemini: thử AI_THINKING_LEVEL=minimal hoặc tăng AI_MAX_TOKENS (endpoint kiểu OpenAI: AI_REASONING_EFFORT=none).');
    } catch (error) {
        step(false, 'Gọi mô hình', error.message);
        return finish(results, log);
    }

    try {
        const defs = tools.getToolsForRole('admin').map(({ name, description, input_schema }) => ({ name, description, input_schema }));
        await ai.callModel({ system: 'Chào ngắn gọn.', tools: defs, messages: [{ role: 'user', content: 'Xin chào' }], maxTokens: 100 });
        step(true, `Gọi kèm ${defs.length} công cụ của chatbot admin`, 'Nhà cung cấp chấp nhận bộ công cụ.');
    } catch (error) {
        step(false, 'Gọi kèm bộ công cụ của chatbot admin', `${error.message}\n     (Gọi thường được nhưng gọi kèm công cụ bị từ chối: lỗi nằm ở phần khai báo công cụ hoặc model không hỗ trợ.)`);
    }
    return finish(results, log);
}

function finish(results, log) {
    const ok = results.length > 0 && results.every(Boolean);
    log(ok ? '\n🎉 Mọi thứ hoạt động. Chatbot AI dùng được.\n' : '\n⚠️  Có bước chưa đạt — làm theo gợi ý ở dòng ❌ đầu tiên rồi chạy lại: npm run ai:check\n');
    return ok;
}

module.exports = { run, mask };

if (require.main === module) {
    require('dotenv').config();
    const ai = require('../src/services/ai/anthropic');
    const tools = require('../src/services/ai/tools');
    run({ ai, tools })
        .then((ok) => process.exit(ok ? 0 : 1))
        .catch((error) => {
            console.error('Lỗi không mong đợi:', error);
            process.exit(1);
        });
}
