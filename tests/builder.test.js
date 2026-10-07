// Kiểm thử trang Build PC: thông số linh kiện, luật tương thích, API, AI chọn cấu hình (Gemini giả).
// Chạy:  node tests/builder.test.js
const assert = require('assert');
const H = require('./helpers/harness');
const { src } = H;
delete process.env.NODE_ENV;

const P = (id, part_type, name, price, build_specs, stock = 10) => ({ id, part_type, name, price: String(price), stock, image_url: null, build_specs, specs: {} });
const parts = [
    P(1, 'cpu', 'Intel Core i5-12400F', 2900000, { socket: 'LGA1700', tdp_w: 65, igpu: false, cores: 6 }),
    P(2, 'cpu', 'Intel Core i5-12400', 3300000, { socket: 'LGA1700', tdp_w: 65, igpu: true, cores: 6 }),
    P(3, 'cpu', 'AMD Ryzen 5 7600', 4900000, { socket: 'AM5', tdp_w: 65, igpu: true, cores: 6 }),
    P(10, 'mainboard', 'MSI PRO B760M-A DDR4', 2700000, { socket: 'LGA 1700', ram_type: 'DDR4', form_factor: 'mATX', ram_slots: 4, m2_slots: 2 }),
    P(11, 'mainboard', 'ASUS B650 ATX DDR5', 4500000, { socket: 'AM5', ram_type: 'DDR5', form_factor: 'ATX', ram_slots: 4, m2_slots: 3 }),
    P(20, 'ram', 'Kingston 16GB DDR4', 900000, { ram_type: 'DDR4', capacity_gb: 16, modules: 2 }),
    P(21, 'ram', 'Kingston 32GB DDR5', 2600000, { ram_type: 'DDR5', capacity_gb: 32, modules: 2 }),
    P(30, 'vga', 'RTX 4060 8GB', 8000000, { tdp_w: 115, length_mm: 250, vram_gb: 8 }),
    P(31, 'vga', 'RTX 4090 24GB', 50000000, { tdp_w: 450, length_mm: 340, vram_gb: 24 }),
    P(40, 'storage', 'SSD NVMe 512GB', 1000000, { interface: 'NVMe', capacity_gb: 512 }),
    P(50, 'psu', 'Nguồn 450W', 800000, { wattage_w: 450 }),
    P(51, 'psu', 'Nguồn 650W', 1400000, { wattage_w: 650 }),
    P(60, 'case', 'Vỏ mATX nhỏ', 700000, { form_factors: ['mATX', 'ITX'], max_gpu_length_mm: 300 }),
    P(61, 'case', 'Vỏ ATX', 1200000, { form_factors: ['ATX', 'mATX', 'ITX'], max_gpu_length_mm: 380 }),
    P(70, 'cooler', 'Tản AM4 cũ', 300000, { sockets: ['AM4'], tdp_rating_w: 95 }),
    P(80, 'storage', 'SSD hết hàng', 500000, { interface: 'SATA', capacity_gb: 256 }, 0),
];
const ProductStub = {
    getBuilderParts: async (t) => parts.filter((p) => p.part_type === t).sort((a, b) => a.price - b.price),
    getBuilderPartsByIds: async (ids) => parts.filter((p) => ids.includes(p.id)),
};
H.install(new Map([
    [src('config/database.js'), { query: async () => [], pool: {} }],
    [src('models/Product.js'), ProductStub],
    [src('models/Category.js'), {}], [src('models/Order.js'), {}], [src('models/User.js'), {}], [src('models/Support.js'), {}],
]));

const Parts = require(src('config/pcParts.js'));
const B = require(src('services/pcBuilder.js'));
const Ctl = require(src('controllers/builderController.js'));
const routes = require(src('routes/builderRoutes.js'));
const Limiters = require(src('middlewares/limiters.js'));
const { test, done } = H.runner();
const byId = (id) => parts.find((p) => p.id === id);
const build = (ids) => Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, byId(id)]));
const codes = (r, level = 'error') => r.issues.filter((i) => i.level === level).map((i) => i.code).sort();
const fail = (m) => { const e = new Error(m); e.status = 400; e.expose = true; throw e; };

(async () => {
    console.log('Thông số linh kiện (admin nhập)');
    await test('chuẩn hóa đúng kiểu: số, có/không, enum không phân biệt hoa thường, danh sách; bỏ trường lạ', () => {
        assert.deepStrictEqual(Parts.parseBuildSpecs('cpu', { socket: ' LGA1700 ', tdp_w: '65', igpu: 'false', hack: 1 }, fail), { socket: 'LGA1700', tdp_w: 65, igpu: false });
        assert.deepStrictEqual(Parts.parseBuildSpecs('mainboard', { socket: 'AM5', ram_type: 'ddr5', form_factor: 'matx' }, fail), { socket: 'AM5', ram_type: 'DDR5', form_factor: 'mATX' });
        assert.deepStrictEqual(Parts.parseBuildSpecs('case', { form_factors: 'atx, mATX, ATX' }, fail), { form_factors: ['ATX', 'mATX'] });
        assert.deepStrictEqual(Parts.parseBuildSpecs('cooler', { sockets: 'LGA1700, AM5' }, fail), { sockets: ['LGA1700', 'AM5'] });
    });
    await test('thiếu thông số bắt buộc / sai kiểu / ngoài khoảng / loại lạ → báo lỗi tiếng Việt', () => {
        for (const [type, specs, re] of [
            ['cpu', { tdp_w: 65, igpu: true }, /Socket/], ['cpu', { socket: 'AM5', tdp_w: 'nhiều', igpu: true }, /số nguyên/],
            ['mainboard', { socket: 'AM5', ram_type: 'DDR3', form_factor: 'ATX' }, /DDR4, DDR5/], ['psu', { wattage_w: 50 }, /từ 100/],
            ['case', { form_factors: ['E-ATX'] }, /chỉ nhận/], ['ssd', {}, /Loại linh kiện/], ['cpu', { socket: 'AM5', tdp_w: 65, igpu: 'có lẽ' }, /có\/không/],
        ]) assert.throws(() => Parts.parseBuildSpecs(type, specs, fail), (e) => re.test(e.message), `${type} ${JSON.stringify(specs)}`);
    });

    console.log('Luật tương thích');
    const good = { cpu: 2, mainboard: 10, ram: 20, storage: 40, psu: 51, case: 60 };
    await test('cấu hình đúng: tương thích + đủ món; tổng tiền và công suất đúng', () => {
        const r = B.checkBuild(build(good));
        assert.strictEqual(r.complete, true); assert.strictEqual(r.compatible, true); assert.deepStrictEqual(codes(r), []);
        assert.strictEqual(r.total, 3300000 + 2700000 + 900000 + 1000000 + 1400000 + 700000); assert.strictEqual(r.total_text, '10.000.000₫');
        assert.strictEqual(r.estimated_w, 65 + 75); assert.strictEqual(r.recommended_psu_w, 200);
    });
    await test('sai socket (so sánh bỏ khoảng trắng), sai loại RAM, mainboard to hơn vỏ, VGA dài hơn vỏ, tản không hợp socket', () => {
        assert.deepStrictEqual(codes(B.checkBuild(build({ ...good, cpu: 3 }))), ['socket']);
        assert.deepStrictEqual(codes(B.checkBuild(build({ ...good, ram: 21 }))), ['ram_type']);
        assert.deepStrictEqual(codes(B.checkBuild(build({ ...good, cpu: 3, mainboard: 11, ram: 21 }))), ['form_factor']);
        const big = B.checkBuild(build({ ...good, vga: 31, psu: 51, case: 60 }));
        assert.deepStrictEqual(codes(big), ['gpu_length']); assert.deepStrictEqual(codes(big, 'warning'), ['psu_tight'], '650W cho ~590W: đủ nhưng sát');
        assert.deepStrictEqual(codes(B.checkBuild(build({ ...good, cooler: 70 }))), ['cooler_socket']);
    });
    await test('CPU không có nhân đồ họa mà không có VGA → bắt buộc thêm VGA; có VGA thì hết lỗi', () => {
        assert.deepStrictEqual(codes(B.checkBuild(build({ ...good, cpu: 1 }))), ['need_vga']);
        assert.deepStrictEqual(codes(B.checkBuild(build({ ...good, cpu: 1, vga: 30 }))), []);
    });
    await test('nguồn: thiếu công suất → lỗi; đủ nhưng sát → cảnh báo; hết hàng → lỗi; thiếu món bắt buộc → "chưa chọn"', () => {
        const r = B.checkBuild(build({ ...good, cpu: 1, vga: 30, psu: 50 }));
        assert.strictEqual(r.estimated_w, 65 + 115 + 75); assert.strictEqual(r.recommended_psu_w, 350); assert.deepStrictEqual(codes(r), []); assert.deepStrictEqual(codes(r, 'warning'), []);
        const tight = B.checkBuild({ ...build({ ...good, cpu: 1, vga: 30 }), psu: { ...byId(50), build_specs: { wattage_w: 300 } } });
        assert.deepStrictEqual(codes(tight, 'warning'), ['psu_tight']);
        const low = B.checkBuild({ ...build({ ...good, cpu: 1, vga: 30 }), psu: { ...byId(50), build_specs: { wattage_w: 200 } } });
        assert.deepStrictEqual(codes(low), ['psu_low']);
        assert.deepStrictEqual(codes(B.checkBuild(build({ ...good, storage: 80 }))), ['out_of_stock']);
        const partial = B.checkBuild(build({ cpu: 2 }));
        assert.strictEqual(partial.complete, false); assert.strictEqual(partial.compatible, true, 'chỉ thiếu món, chưa có xung đột');
        assert.deepStrictEqual(codes(partial).filter((c) => c === 'missing').length, 5);
    });
    await test('đánh dấu ứng viên: chỉ lý do liên quan tới loại đang chọn', () => {
        const marked = B.markCandidates('cpu', parts.filter((p) => p.part_type === 'cpu'), build({ mainboard: 10 }));
        assert.deepStrictEqual(marked.map((p) => [p.id, p.compatible]), [[1, true], [2, true], [3, false]]);
        assert(/AM5.*LGA 1700/.test(marked[2].reasons[0]), marked[2].reasons[0]);
        const psus = B.markCandidates('psu', parts.filter((p) => p.part_type === 'psu'), build({ cpu: 1, vga: 31 }));
        assert.deepStrictEqual(psus.map((p) => p.compatible), [false, true], 'RTX 4090: nguồn 450W không đủ, 650W đủ'); assert(/590W/.test(psus[0].reasons[0]));
    });

    console.log('API /api/builder');
    await test('danh sách linh kiện theo loại + đánh dấu; chọn sai loại / id lạ / loại lạ → 400', async () => {
        let res = await H.call(Ctl.parts, { params: { type: 'ram' }, query: { mainboard: '10' } });
        assert.strictEqual(res.code, 200); assert.deepStrictEqual(res.body.data.map((p) => [p.id, p.compatible]), [[20, true], [21, false]]);
        assert.strictEqual(res.body.data[0].price, 900000, 'giá trả về dạng số');
        res = await H.call(Ctl.parts, { params: { type: 'ram' }, query: { mainboard: '1' } }); assert.strictEqual(res.code, 400); assert(/không phải Mainboard/.test(res.body.message));
        res = await H.call(Ctl.parts, { params: { type: 'ram' }, query: { cpu: '999' } }); assert.strictEqual(res.code, 400);
        res = await H.call(Ctl.parts, { params: { type: 'gpu' }, query: {} }); assert.strictEqual(res.code, 400);
        res = await H.call(Ctl.parts, { params: { type: 'ram' }, query: { cpu: ['1', '2'] } }); assert.strictEqual(res.code, 400, 'tham số lặp bị từ chối');
    });
    await test('kiểm tra cấu hình qua API; cấu hình trả về kèm danh sách món và tổng tiền', async () => {
        const res = await H.call(Ctl.check, { body: { parts: { ...good, vga: '' } } });
        assert.strictEqual(res.code, 200); assert.strictEqual(res.body.data.complete, true); assert.strictEqual(res.body.data.items.length, 6);
    });
    await test('route công khai; gợi ý AI có giới hạn tần suất; AI chưa bật → 503', async () => {
        const find = (m, p) => routes.routes.find((r) => r.method === m && r.path === p);
        assert.strictEqual(find('post', '/suggest').handlers[0], Limiters.builderAiLimiter);
        assert.strictEqual(find('get', '/parts/:type').handlers.length, 1);
        for (const k of ['AI_PROVIDER', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'AI_API_KEY']) delete process.env[k];
        const res = await H.call(Ctl.suggest, { body: { budget: 20000000, purpose: 'gaming' } });
        assert.strictEqual(res.code, 503);
        const cfg = await H.call(Ctl.config); assert.strictEqual(cfg.body.data.ai_enabled, false); assert.strictEqual(cfg.body.data.part_types.length, 8);
    });

    console.log('AI chọn cấu hình (Gemini giả)');
    const gCall = (name, args) => ({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name, args } }] }, finishReason: 'STOP' }] });
    const gText = (t) => ({ candidates: [{ content: { role: 'model', parts: [{ text: t }] }, finishReason: 'STOP' }] });
    let queue = []; const log = [];
    global.fetch = async (url, opts) => { log.push(JSON.parse(opts.body)); const n = queue.shift(); return { ok: true, status: 200, json: async () => n }; };
    Object.assign(process.env, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'k' });
    await test('AI xem linh kiện → kiểm tra → sửa lỗi → chốt; server kiểm tra lại và trả về cấu hình + giải thích', async () => {
        queue = [
            gCall('list_parts', { type: 'cpu', max_price: 4000000 }),
            gCall('check_build', { cpu: 1, mainboard: 10, ram: 20, storage: 40, psu: 50, case: 60 }),
            gCall('check_build', { cpu: 1, mainboard: 10, ram: 20, storage: 40, psu: 51, case: 60, vga: 30 }),
            gCall('propose_build', { parts: { cpu: 1, mainboard: 10, ram: 20, storage: 40, psu: 51, case: 60, vga: 30 }, explanation: 'Bộ này chơi game Full HD tốt.' }),
            gText('Mình đã chọn xong cấu hình.'),
        ];
        const res = await H.call(Ctl.suggest, { body: { budget: 20000000, purpose: 'gaming', note: 'thích màu trắng' } });
        assert.strictEqual(res.code, 200, JSON.stringify(res.body));
        const d = res.body.data;
        assert.deepStrictEqual(d.parts, { cpu: 1, mainboard: 10, ram: 20, vga: 30, storage: 40, psu: 51, case: 60 });
        assert.strictEqual(d.report.complete, true); assert.strictEqual(d.over_budget, false); assert.strictEqual(d.explanation, 'Bộ này chơi game Full HD tốt.');
        const listResult = log[1].contents.at(-1).parts[0].functionResponse.response;
        assert.deepStrictEqual(listResult.parts.map((p) => p.id), [1, 2], 'chỉ hàng còn trong tầm giá, rẻ trước');
        const firstCheck = log[2].contents.at(-1).parts[0].functionResponse.response;
        assert(firstCheck.issues.some((i) => /card đồ họa/.test(i)), 'AI nhận được lỗi thiếu VGA để tự sửa');
        assert(/thích màu trắng/.test(log[0].systemInstruction.parts[0].text) && /DỮ LIỆU/.test(log[0].systemInstruction.parts[0].text));
    });
    await test('AI bịa id / chọn sai loại → bị loại khỏi kết quả; không chốt gì → báo lỗi; ngân sách / nhu cầu sai → 400', async () => {
        queue = [gCall('propose_build', { parts: { cpu: 999, mainboard: 20, ram: 20 }, explanation: 'x' }), gText('ok')];
        let res = await H.call(Ctl.suggest, { body: { budget: 20000000, purpose: 'office' } });
        assert.strictEqual(res.code, 200); assert.deepStrictEqual(res.body.data.parts, { ram: 20 }); assert.strictEqual(res.body.data.report.complete, false);
        queue = [gText('Mình không chọn được.')];
        res = await H.call(Ctl.suggest, { body: { budget: 20000000, purpose: 'office' } }); assert.strictEqual(res.code, 502);
        res = await H.call(Ctl.suggest, { body: { budget: 1000, purpose: 'office' } }); assert.strictEqual(res.code, 400);
        res = await H.call(Ctl.suggest, { body: { budget: 20000000, purpose: 'hack' } }); assert.strictEqual(res.code, 400);
    });
    await test('bộ công cụ AI hợp lệ với Gemini (không còn từ khóa schema bị từ chối)', () => {
        const G = require(src('services/ai/gemini.js'));
        const decls = G.toGeminiTools(require(src('services/ai/pcBuildAssistant.js')).TOOLS)[0].functionDeclarations;
        assert.strictEqual(decls.length, 3); assert.strictEqual(decls[2].parameters.properties.parts.properties.cpu.type, 'integer');
    });

    done(); setImmediate(() => process.exit(process.exitCode || 0));
})();
