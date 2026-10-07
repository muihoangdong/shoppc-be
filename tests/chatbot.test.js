// Kiểm thử logic chatbot với model + DB giả (không cần MySQL / mạng / API key thật).
// Chạy:  node tests/chatbot.test.js
process.env.ANTHROPIC_API_KEY = 'k';
const Module = require('module');
const path = require('path');
const assert = require('assert');
const BE = path.join(__dirname, '..', 'src');

// ---------- DB giả ----------
const data = {
  categories: [
    { id: 1, name: 'Laptop', type: 'pc', parent_id: null, parent_name: null },
    { id: 2, name: 'RAM', type: 'component', parent_id: null, parent_name: null },
    { id: 3, name: 'Gaming Laptop', type: 'pc', parent_id: 1, parent_name: 'Laptop' },
    { id: 4, name: 'Trống', type: 'peripheral', parent_id: null, parent_name: null },
  ],
  products: [
    { id: 10, name: 'Laptop Dell XPS 13', price: '25000000.00', stock: 5, category_id: 1, category_name: 'Laptop', description: 'Mỏng nhẹ', specs: { RAM: '16GB', CPU: 'i7' }, image_url: null },
    { id: 11, name: 'RAM Kingston 16GB', price: '1200000.00', stock: 0, category_id: 2, category_name: 'RAM', description: '', specs: {}, image_url: null },
    { id: 12, name: 'RAM Corsair 32GB', price: '2500000.00', stock: 40, category_id: 2, category_name: 'RAM', description: '', specs: {}, image_url: null },
  ],
  orders: [
    { id: 100, order_code: 'ORD-1', customer_name: 'Nguyễn Văn A', customer_phone: '0901', customer_email: 'a@x.vn', total_amount: '26200000.00', status: 'pending', payment_method: 'cod', payment_status: 'pending', created_at: new Date() },
    { id: 101, order_code: 'ORD-2', customer_name: 'Trần B', customer_phone: '0902', customer_email: 'b@x.vn', total_amount: '1200000.00', status: 'cancelled', payment_method: 'banking', payment_status: 'pending', created_at: new Date('2020-01-05T03:00:00Z') },
  ],
  users: [{ id: 1, username: 'admin', email: 'admin@x.vn', full_name: 'Admin', role: 'admin' }, { id: 2, username: 'nv', email: 'nv@x.vn', full_name: 'Nhân viên', role: 'staff' }],
};
const log = [];
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const Product = {
  getAllProducts: async (f = {}) => clone(data.products).filter((p) => (!f.search || p.name.toLowerCase().includes(f.search.toLowerCase())) && (!f.category_id || p.category_id === f.category_id)),
  getProductById: async (id) => clone(data.products.find((p) => p.id === Number(id))),
  createProduct: async (p) => { const id = 99; data.products.push({ id, ...p, category_name: 'x' }); log.push(['createProduct', p]); return id; },
  updateProduct: async (id, d) => { log.push(['updateProduct', id, d]); const p = data.products.find((x) => x.id === id); Object.assign(p, d); return 1; },
  setStock: async (id, q) => { log.push(['setStock', id, q]); data.products.find((x) => x.id === id).stock = q; return 1; },
  deleteProduct: async (id) => { log.push(['deleteProduct', id]); return 1; },
};
const Category = {
  getAllCategories: async () => clone(data.categories),
  getCategoryById: async (id) => clone(data.categories.find((c) => c.id === Number(id))),
  createCategory: async (c) => { log.push(['createCategory', c]); return 55; },
  updateCategory: async (id, d) => { log.push(['updateCategory', id, d]); return 1; },
  deleteCategory: async (id) => { log.push(['deleteCategory', id]); return 1; },
};
const Order = {
  getOrders: async (f = {}) => clone(data.orders).map((o) => ({ ...o, created_at: new Date(o.created_at) })).filter((o) => (!f.status || o.status === f.status)),
  getOrderById: async (id) => clone(data.orders.find((o) => o.id === Number(id))),
  getOrderByCode: async (c) => clone(data.orders.find((o) => o.order_code === c)),
  getOrderItems: async () => [{ product_id: 10, product_name: 'Laptop Dell XPS 13', quantity: 1, price: '25000000', total: '25000000' }],
  updateOrderStatus: async (id, st, by, note) => { log.push(['updateOrderStatus', id, st, by, note]); data.orders.find((o) => o.id === id).status = st; return {}; },
  getDashboardStats: async () => ({ totalProducts: 3, totalOrders: 2, totalRevenue: 0, lowStockProducts: 2, pendingOrders: 1, monthlyRevenue: [] }),
};
const User = {
  getUserById: async (id) => clone(data.users.find((u) => u.id === id)),
  getUserByEmail: async (e) => clone(data.users.find((u) => u.email === e)),
  updateProfile: async (id, d) => { log.push(['updateProfile', id, d]); return 1; },
};
const sqlLog = [];
const db = {
  query: async (sql, params) => {
    sqlLog.push([sql.replace(/\s+/g, ' ').trim(), params]);
    if (/GROUP BY category_id/.test(sql)) return [{ category_id: 1, n: 1 }, { category_id: 2, n: 2 }];
    if (/FROM categories WHERE parent_id/.test(sql)) return [{ n: params[0] === 1 ? 1 : 0 }];
    if (/FROM products WHERE category_id/.test(sql)) return [{ n: params[0] === 2 ? 2 : 0 }];
    if (/GROUP BY status/.test(sql)) return [{ status: 'completed', orders: 2, amount: '30000000' }, { status: 'cancelled', orders: 1, amount: '1200000' }];
    if (/GROUP BY payment_method/.test(sql)) return [{ payment_method: 'cod', orders: 2, amount: '30000000' }];
    if (/FROM order_items/.test(sql)) return [{ product_id: 10, product_name: 'Laptop Dell XPS 13', quantity_sold: 2, revenue: '50000000' }];
    return [];
  },
  pool: { query: async (sql, params) => { sqlLog.push([sql.replace(/\s+/g, ' ').trim(), params]); return [{ affectedRows: 1 }]; } },
};

const stubs = new Map([
  [path.join(BE, 'models/Product.js'), Product],
  [path.join(BE, 'models/Category.js'), Category],
  [path.join(BE, 'models/Order.js'), Order],
  [path.join(BE, 'models/User.js'), User],
  [path.join(BE, 'config/database.js'), db],
]);
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && request.startsWith('.')) {
    const resolved = require.resolve(path.resolve(path.dirname(parent.filename), request));
    if (stubs.has(resolved)) return stubs.get(resolved);
  }
  return origLoad.apply(this, arguments);
};

// ---------- Anthropic giả ----------
let script = [];
let apiCalls = [];
global.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  apiCalls.push({ url, headers: opts.headers, body });
  const next = script.shift();
  if (!next) throw new Error('script hết');
  if (next.status) return { ok: false, status: next.status, text: async () => 'err' };
  return { ok: true, status: 200, json: async () => next };
};
const tu = (name, input, id = 'tu_' + Math.random().toString(36).slice(2, 7)) => ({ type: 'tool_use', id, name, input });
const toolTurn = (...blocks) => ({ stop_reason: 'tool_use', content: blocks });
const textTurn = (t) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }] });

const Chat = require(path.join(BE, 'services/ai/chatService.js'));
const Tools = require(path.join(BE, 'services/ai/tools.js'));
const Pending = require(path.join(BE, 'services/ai/pendingStore.js'));
const Ctl = require(path.join(BE, 'controllers/chatController.js'));

const admin = { id: 1, username: 'admin', role: 'admin' };
const staff = { id: 2, username: 'nv', role: 'staff' };
const U = (c) => [{ role: 'user', content: c }];

let passed = 0;
const test = async (name, fn) => {
  log.length = 0; sqlLog.length = 0; apiCalls = []; script = [];
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.log('  ✗', name, '\n   ', e.stack.split('\n').slice(0, 4).join('\n    ')); process.exitCode = 1; }
};

(async () => {
  console.log('Tools & phân quyền');
  await test('staff không thấy tool xóa; admin thấy', async () => {
    const s = Tools.getToolsForRole('staff').map((t) => t.name);
    const a = Tools.getToolsForRole('admin').map((t) => t.name);
    assert(!s.includes('delete_product') && !s.includes('delete_category'));
    assert(a.includes('delete_product') && a.includes('delete_category'));
    assert.strictEqual(a.length, 20); assert.strictEqual(s.length, 18);
    for (const name of ['list_conversations', 'get_conversation', 'reply_to_conversation']) assert(s.includes(name), name);
    assert.strictEqual(Tools.getTool('reply_to_conversation').write, true, 'gửi tin cho khách phải cần xác nhận');
    for (const t of Tools.getToolsForRole('admin')) assert(t.input_schema && t.input_schema.type === 'object', t.name);
  });
  await test('resolveRange: this_month / last_month / 7d', async () => {
    const r = Tools._internal.resolveRange({ period: 'last_month' });
    assert(/^\d{4}-\d{2}-01$/.test(r.from)); assert(r.to > r.from);
    const d = Tools._internal.resolveRange({ period: '7d' });
    assert.strictEqual(Tools._internal.addDays(d.from, 6), d.to);
    assert.throws(() => Tools._internal.resolveRange({ from: '2026-02-30x' }), /YYYY-MM-DD/);
    assert.throws(() => Tools._internal.resolveRange({ from: '2026-05-02', to: '2026-05-01' }), /trước/);
  });

  console.log('Vòng lặp chat – đọc dữ liệu');
  await test('đọc: gọi list_products rồi trả lời; kết quả tool gửi lại cho model', async () => {
    script = [toolTurn(tu('list_products', { max_stock: 5 }, 'T1')), textTurn('Có 2 sản phẩm sắp hết.')];
    const r = await Chat.runChat({ messages: U('hàng sắp hết?'), user: staff });
    assert.strictEqual(r.reply, 'Có 2 sản phẩm sắp hết.');
    assert.strictEqual(r.pending_actions.length, 0);
    const second = apiCalls[1].body.messages;
    const tr = second[second.length - 1].content[0];
    assert.strictEqual(tr.type, 'tool_result'); assert.strictEqual(tr.tool_use_id, 'T1');
    const parsed = JSON.parse(tr.content);
    assert.strictEqual(parsed.total_matched, 2);
    assert.deepStrictEqual(parsed.products.map((p) => p.id), [10, 11]);
    assert.strictEqual(parsed.products[0].price, 25000000);
    assert.strictEqual(apiCalls[0].headers['x-api-key'], 'k');
    assert(apiCalls[0].body.system.includes('staff') || apiCalls[0].body.system.includes('nhân viên'));
    assert(!apiCalls[0].body.tools.some((t) => t.name === 'delete_product'));
  });
  await test('get_analytics trả số liệu đúng', async () => {
    const out = await Tools.getTool('get_analytics').run({ period: 'this_month' });
    assert.strictEqual(out.total_orders, 3); assert.strictEqual(out.realized_revenue, 30000000);
    assert.strictEqual(out.avg_realized_order_value, 15000000);
    assert.strictEqual(out.top_products_excluding_cancelled[0].quantity_sold, 2);
    const q = sqlLog.find(([s]) => /GROUP BY status/.test(s));
    assert(/^\d{4}-\d{2}-\d{2} 00:00:00$/.test(q[1][0]) && /^\d{4}-\d{2}-\d{2} 00:00:00$/.test(q[1][1]));
  });
  await test('list_orders: lọc từ khóa, ngày; list_categories đếm sản phẩm', async () => {
    let o = await Tools.getTool('list_orders').run({ search: '#ord-2' });
    assert.strictEqual(o.total_matched, 1); assert.strictEqual(o.orders[0].id, 101);
    o = await Tools.getTool('list_orders').run({ from: '2020-01-01', to: '2020-12-31' });
    assert.strictEqual(o.total_matched, 1);
    const c = await Tools.getTool('list_categories').run({});
    assert.strictEqual(c.categories.find((x) => x.id === 2).product_count, 2);
    assert.strictEqual(c.categories.find((x) => x.id === 4).product_count, 0);
    const g = await Tools.getTool('get_order').run({ order_code: '#ORD-1' });
    assert.strictEqual(g.items.length, 1); assert.strictEqual(g.items[0].price, 25000000);
  });
  await test('navigate trả client_action, không lộ _client_action cho model', async () => {
    script = [toolTurn(tu('navigate', { page: 'orders' }, 'N1')), textTurn('Đã mở.')];
    const r = await Chat.runChat({ messages: U('mở đơn hàng'), user: staff });
    assert.deepStrictEqual(r.client_actions, [{ type: 'navigate', path: '/admin/orders' }]);
    const tr = apiCalls[1].body.messages.at(-1).content[0];
    assert(!tr.content.includes('_client_action'));
  });

  console.log('Ghi dữ liệu – bắt buộc xác nhận');
  await test('tool ghi KHÔNG chạy ngay; tạo thẻ xác nhận với mô tả do server sinh', async () => {
    script = [toolTurn(tu('update_product', { id: 10, price: 23000000, specs: { RAM: '32GB' } })), textTurn('Đã chuẩn bị.')];
    const r = await Chat.runChat({ messages: U('giảm giá dell'), user: staff });
    assert.strictEqual(log.length, 0, 'không được ghi DB trước khi xác nhận');
    assert.strictEqual(r.pending_actions.length, 1);
    const s = r.pending_actions[0].summary;
    assert(s.includes('Laptop Dell XPS 13') && s.includes('25.000.000') && s.includes('23.000.000'), s);
    assert(s.includes('"RAM"') && s.includes('16GB') && s.includes('32GB'), s);
    const tr = apiCalls[1].body.messages.at(-1).content[0];
    assert(/CHƯA thực hiện/.test(tr.content));
  });
  await test('xác nhận → thực thi đúng 1 lần; xác nhận lại bị từ chối; specs được gộp', async () => {
    script = [toolTurn(tu('update_product', { id: 10, price: 23000000, specs: { RAM: '32GB', CPU: null } })), textTurn('ok')];
    const r = await Chat.runChat({ messages: U('x'), user: staff });
    const id = r.pending_actions[0].id;
    let res = await Chat.confirmActions({ ids: [id], user: staff });
    assert(res[0].ok, JSON.stringify(res));
    assert.deepStrictEqual(log[0], ['updateProduct', 10, { price: 23000000, specs: { RAM: '32GB' } }]);
    res = await Chat.confirmActions({ ids: [id], user: staff });
    assert(!res[0].ok); assert.strictEqual(log.length, 1);
  });
  await test('user khác không xác nhận hộ được; hủy hoạt động', async () => {
    script = [toolTurn(tu('update_stock', { id: 11, mode: 'add', quantity: 20 })), textTurn('ok')];
    const r = await Chat.runChat({ messages: U('x'), user: staff });
    const id = r.pending_actions[0].id;
    assert(r.pending_actions[0].summary.includes('0 → 20'));
    let res = await Chat.confirmActions({ ids: [id], user: admin });
    assert(!res[0].ok); assert.strictEqual(sqlLog.filter(([s]) => /UPDATE products/.test(s)).length, 0);
    assert.strictEqual(Chat.cancelActions({ ids: [id], user: staff }), 1);
    res = await Chat.confirmActions({ ids: [id], user: staff });
    assert(!res[0].ok);
  });
  await test('update_stock add/âm: SQL đúng và chặn âm', async () => {
    const t = Tools.getTool('update_stock');
    const p = t.parse({ id: 12, mode: 'add', quantity: -15 });
    assert((await t.describe(p)).includes('40 → 25'));
    await t.run(p, { user: staff });
    const q = sqlLog.find(([s]) => /UPDATE products SET stock = stock - \?/.test(s));
    assert.deepStrictEqual(q[1], [15, 12, 15]);
    await assert.rejects(t.describe(t.parse({ id: 11, mode: 'add', quantity: -1 })), /không thể trừ/);
    await assert.rejects(async () => t.parse({ id: 11, mode: 'set', quantity: -1 }), /từ 0/);
  });
  await test('hết hạn xác nhận (TTL)', async () => {
    const realNow = Date.now; 
    const id = Pending.add(2, { tool: 'update_stock', input: { id: 12, mode: 'set', quantity: 1 }, summary: 's' });
    Date.now = () => realNow() + Pending.TTL_MS + 1000;
    try { const res = await Chat.confirmActions({ ids: [id], user: staff }); assert(!res[0].ok); } finally { Date.now = realNow; }
  });
  await test('staff gọi delete_product → bị từ chối ở server dù model cố gọi', async () => {
    script = [toolTurn(tu('delete_product', { id: 10 }, 'D1')), textTurn('Chỉ admin xóa được.')];
    const r = await Chat.runChat({ messages: U('xóa dell'), user: staff });
    assert.strictEqual(r.pending_actions.length, 0);
    const tr = apiCalls[1].body.messages.at(-1).content[0];
    assert(tr.is_error && /Không có tool|quản trị viên/.test(tr.content));
  });
  await test('admin xóa sản phẩm: thẻ danger; chỉ chạy sau xác nhận', async () => {
    script = [toolTurn(tu('delete_product', { id: 11 })), textTurn('ok')];
    const r = await Chat.runChat({ messages: U('xóa ram kingston'), user: admin });
    assert.strictEqual(r.pending_actions[0].danger, true); assert.strictEqual(log.length, 0);
    assert(r.pending_actions[0].summary.includes('XÓA VĨNH VIỄN'));
    const res = await Chat.confirmActions({ ids: [r.pending_actions[0].id], user: admin });
    assert(res[0].ok); assert.deepStrictEqual(log[0], ['deleteProduct', 11]);
  });
  await test('xóa danh mục còn con/sản phẩm bị chặn từ bước đề xuất; danh mục trống thì được', async () => {
    const t = Tools.getTool('delete_category');
    await assert.rejects(t.describe({ id: 1 }), /danh mục con/);
    await assert.rejects(t.describe({ id: 2 }), /2 sản phẩm/);
    assert((await t.describe({ id: 4 })).includes('XÓA danh mục'));
  });
  await test('đổi trạng thái đơn: đúng luồng, ghi người đổi, báo hoàn kho khi hủy, chặn bước sai', async () => {
    const t = Tools.getTool('update_order_status');
    const d = await t.describe(t.parse({ id: 100, status: 'cancelled' }));
    assert(d.includes('Chờ xử lý → Đã hủy') && d.includes('hoàn lại tồn kho') && !d.includes('không tự hoàn'));
    await assert.rejects(t.describe(t.parse({ id: 101, status: 'cancelled' })), /đã ở trạng thái/);
    // nhảy cóc: pending -> completed không hợp lệ, thông báo chỉ ra các bước được phép
    await assert.rejects(t.describe(t.parse({ id: 100, status: 'completed' })), /Không thể chuyển.*Chỉ có thể chuyển sang: "Đang xử lý", "Đã hủy"/);
    // đơn đã hủy là trạng thái cuối
    await assert.rejects(t.describe(t.parse({ id: 101, status: 'processing' })), /trạng thái cuối/);
    assert.throws(() => t.parse({ id: 100, status: 'weird' }), /không hợp lệ/);
    await t.run(t.parse({ id: 100, status: 'processing' }), { user: staff });
    assert.deepStrictEqual(log[0], ['updateOrderStatus', 100, 'processing', 2, 'Cập nhật qua chatbot']);
});
  await test('validate đầu vào: giá thập phân, id sai, SQL-ish string', async () => {
    const t = Tools.getTool('create_product');
    assert.throws(() => t.parse({ name: 'A', price: 1.5, category_id: 1 }), /số nguyên/);
    assert.throws(() => t.parse({ name: 'A', price: -1, category_id: 1 }), /từ 0/);
    assert.throws(() => t.parse({ name: '  ', price: 1, category_id: 1 }), /không được để trống/);
    assert.throws(() => t.parse({ name: 'A', price: 1, category_id: 'abc' }), /số nguyên/);
    assert.throws(() => t.parse({ name: 'A', price: 1, category_id: 1, specs: [1] }), /object/);
    assert.throws(() => t.parse({ name: 'A', price: 1, category_id: 1, image_url: 'javascript:alert(1)' }), /http/);
    const ok = t.parse({ name: "x'; DROP TABLE products;--", price: '15000000', category_id: 2 });
    assert.strictEqual(ok.price, 15000000);
    await assert.rejects(t.describe({ ...ok, category_id: 999 }), /Không tìm thấy danh mục #999/);
  });
  await test('update_category: chặn tự làm cha; parent_id=null hợp lệ', async () => {
    const t = Tools.getTool('update_category');
    assert.throws(() => t.parse({ id: 3, parent_id: 3 }), /chính nó/);
    const p = t.parse({ id: 3, parent_id: null });
    assert((await t.describe(p)).includes('Laptop → Không có'));
    await t.run(p, { user: staff });
    assert.deepStrictEqual(log[0], ['updateCategory', 3, { parent_id: null }]);
  });
  await test('update_my_profile: chặn email trùng người khác, chỉ sửa chính mình', async () => {
    const t = Tools.getTool('update_my_profile');
    await assert.rejects(t.describe(t.parse({ email: 'nv@x.vn' }), { user: admin }), /đã được tài khoản khác/);
    await t.run(t.parse({ full_name: 'Tên Mới' }), { user: staff });
    assert.deepStrictEqual(log[0], ['updateProfile', 2, { full_name: 'Tên Mới' }]);
  });
  await test('giới hạn 20 thao tác/lượt + chống trùng', async () => {
    const blocks = Array.from({ length: 22 }, (_, i) => tu('update_stock', { id: 12, mode: 'set', quantity: i }));
    blocks.push(tu('update_stock', { id: 12, mode: 'set', quantity: 0 })); // trùng
    script = [toolTurn(...blocks), textTurn('xong')];
    const r = await Chat.runChat({ messages: U('x'), user: staff });
    assert.strictEqual(r.pending_actions.length, 20);
    const results = apiCalls[1].body.messages.at(-1).content;
    assert(results.filter((x) => x.is_error).length >= 2);
  });
  await test('model ghi + đọc cùng lượt: hoạt động; tool lỗi trả is_error để model xử lý', async () => {
    script = [toolTurn(tu('get_product', { id: 999 }, 'E1'), tu('get_product', { id: 10 }, 'E2')), textTurn('ok')];
    await Chat.runChat({ messages: U('x'), user: staff });
    const res = apiCalls[1].body.messages.at(-1).content;
    assert(res[0].is_error && res[0].content.includes('#999')); assert(!res[1].is_error);
  });

  console.log('Lỗi dịch vụ AI');
  await test('thiếu API key / 401 / 429 / 500 / quá nhiều vòng', async () => {
    const saved = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
    await assert.rejects(Chat.runChat({ messages: U('x'), user: staff }), (e) => e.status === 503 && /ANTHROPIC_API_KEY/.test(e.message));
    process.env.ANTHROPIC_API_KEY = saved;
    for (const [st, code] of [[401, 502], [429, 429], [500, 503], [404, 502]]) {
      script = [{ status: st }];
      await assert.rejects(Chat.runChat({ messages: U('x'), user: staff }), (e) => e.status === code, 'status ' + st);
    }
    apiCalls = [];
    script = Array.from({ length: 10 }, () => toolTurn(tu('list_categories', {})));
    const r = await Chat.runChat({ messages: U('x'), user: staff });
    assert(r.reply.length > 0); assert.strictEqual(apiCalls.length, 6);
  });

  console.log('Controller');
  const mkRes = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
  await test('sanitize: bỏ role lạ, cắt lịch sử, bắt đầu bằng user, kết thúc bằng user', async () => {
    const S = Ctl._test.sanitizeMessages;
    assert.strictEqual(S('x'), null);
    assert.strictEqual(S([{ role: 'assistant', content: 'a' }]), null);
    const m = S([{ role: 'system', content: 'hack' }, { role: 'assistant', content: 'hi' }, { role: 'user', content: ' q ' }]);
    assert.deepStrictEqual(m, [{ role: 'user', content: 'q' }]);
    const many = Array.from({ length: 50 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i }));
    many.push({ role: 'user', content: 'last' });
    const out = S(many); assert(out.length <= 20 && out[0].role === 'user' && out.at(-1).content === 'last');
    assert.strictEqual(S([{ role: 'user', content: 'a'.repeat(9000) }])[0].content.length, 4000);
  });
  await test('chat/confirm/cancel qua controller + rate limit', async () => {
    script = [textTurn('xin chào')];
    let res = mkRes(); await Ctl.chat({ user: { id: 77, username: 'u', role: 'staff' }, body: { messages: U('hi') } }, res);
    assert.strictEqual(res.code, 200); assert.strictEqual(res.body.data.reply, 'xin chào');
    res = mkRes(); await Ctl.chat({ user: staff, body: { messages: 'bad' } }, res); assert.strictEqual(res.code, 400);
    res = mkRes(); await Ctl.confirm({ user: staff, body: { action_ids: [] } }, res); assert.strictEqual(res.code, 400);
    res = mkRes(); await Ctl.confirm({ user: staff, body: { action_ids: ['nope'] } }, res);
    assert.strictEqual(res.code, 200); assert.strictEqual(res.body.data.results[0].ok, false);
    res = mkRes(); await Ctl.cancel({ user: staff, body: { action_ids: ['nope'] } }, res); assert.strictEqual(res.body.data.cancelled, 0);
    script = [{ status: 500 }];
    res = mkRes(); await Ctl.chat({ user: { id: 88, username: 'z', role: 'staff' }, body: { messages: U('hi') } }, res);
    assert.strictEqual(res.code, 503); assert(!JSON.stringify(res.body).includes('err'));
    let last; for (let i = 0; i < 25; i++) { script = [textTurn('.')]; last = mkRes(); await Ctl.chat({ user: { id: 99, username: 'r', role: 'staff' }, body: { messages: U('hi') } }, last); }
    assert.strictEqual(last.code, 429);
  });

  console.log(`\n${passed} test đạt`);
})();
