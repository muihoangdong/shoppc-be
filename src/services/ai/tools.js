'use strict';

/**
 * Danh sách "tool" mà chatbot AI được phép dùng. Mỗi tool tương ứng một chức năng
 * trong dashboard admin (Tổng quan / Sản phẩm / Danh mục / Đơn hàng / Thống kê / Cài đặt).
 *
 * Quy ước:
 *  - Tool đọc dữ liệu (write: false)  -> chạy ngay, trả dữ liệu cho AI.
 *  - Tool ghi dữ liệu (write: true)   -> KHÔNG chạy ngay. Server chỉ kiểm tra đầu vào, sinh
 *    mô tả xác nhận (describe) rồi chờ người dùng bấm "Xác nhận" trên giao diện.
 *  - access: 'staff' (nhân viên + admin) hoặc 'admin' (chỉ admin).
 */

const Product = require('../../models/Product');
const Category = require('../../models/Category');
const Order = require('../../models/Order');
const User = require('../../models/User');
const db = require('../../config/database');
const Support = require('../../models/Support');
const supportService = require('../support/supportService');

// ───────────────────────── Hằng số & tiện ích ─────────────────────────

const { ORDER_STATUSES, STATUS_LABELS: STATUS_VI, canTransition, TRANSITIONS } = require('../../config/orderStatus');
const { RangeInputError, resolveRange: resolveRangeBase, getAnalytics, todayYmd, addDays } = require('../analytics');
const PAYMENT_STATUS_VI = { pending: 'Chưa thanh toán', paid: 'Đã thanh toán' };
const CATEGORY_TYPES = ['pc', 'component', 'peripheral'];
const TYPE_VI = { pc: 'Máy tính', component: 'Linh kiện', peripheral: 'Phụ kiện' };

const ADMIN_PAGES = {
    dashboard: { path: '/admin', label: 'Tổng quan' },
    products: { path: '/admin/products', label: 'Sản phẩm' },
    categories: { path: '/admin/categories', label: 'Danh mục' },
    orders: { path: '/admin/orders', label: 'Đơn hàng' },
    analytics: { path: '/admin/analytics', label: 'Thống kê' },
    support: { path: '/admin/support', label: 'Hỗ trợ khách hàng' },
    settings: { path: '/admin/settings', label: 'Cài đặt' },
};

const timezone = () => process.env.APP_TIMEZONE || 'Asia/Ho_Chi_Minh';

/** Lỗi do đầu vào sai / vi phạm nghiệp vụ -> thông báo được phép hiển thị cho người dùng và AI. */
class ToolInputError extends Error {}

const fail = (message) => {
    throw new ToolInputError(message);
};

const vnd = (n) =>
    new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 }).format(Number(n) || 0);

const fmtDate = (value) => {
    if (!value) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString('sv-SE', { timeZone: timezone() }); // dạng YYYY-MM-DD HH:mm:ss
};

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function pInt(v, label, { min = 0, max = 1e9, optional = false } = {}) {
    if (v === undefined || v === null || v === '') {
        if (optional) return undefined;
        fail(`Thiếu ${label}`);
    }
    const n = typeof v === 'string' ? Number(v) : v;
    if (!Number.isInteger(n) || n < min || n > max) {
        fail(`${label} phải là số nguyên từ ${min} đến ${max}`);
    }
    return n;
}

function pStr(v, label, { max = 255, optional = false, allowEmpty = false } = {}) {
    if (v === undefined || v === null) {
        if (optional) return undefined;
        fail(`Thiếu ${label}`);
    }
    if (typeof v !== 'string') fail(`${label} phải là chuỗi ký tự`);
    const s = v.trim();
    if (!s && !allowEmpty) {
        if (optional) return undefined;
        fail(`${label} không được để trống`);
    }
    if (s.length > max) fail(`${label} quá dài (tối đa ${max} ký tự)`);
    return s;
}

function pEnum(v, label, values, { optional = false } = {}) {
    if (v === undefined || v === null || v === '') {
        if (optional) return undefined;
        fail(`Thiếu ${label}`);
    }
    if (!values.includes(v)) fail(`${label} không hợp lệ. Giá trị cho phép: ${values.join(', ')}`);
    return v;
}

function pDate(v, label) {
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
        fail(`${label} phải có dạng YYYY-MM-DD`);
    }
    return v;
}

function pPrice(v, label = 'Giá', opts = {}) {
    // Giá VND luôn là số nguyên -> chặn trường hợp AI hiểu nhầm "1.5tr" thành 1.5
    return pInt(v, label, { min: 0, max: 1e12, ...opts });
}

function pSpecs(v) {
    if (v === undefined) return undefined;
    if (!isPlainObject(v)) fail('Thông số kỹ thuật (specs) phải là một object dạng {"tên": "giá trị"}');
    if (JSON.stringify(v).length > 10000) fail('Thông số kỹ thuật quá lớn');
    return v;
}

function pImageUrl(v) {
    const s = pStr(v, 'Link ảnh', { max: 500, optional: true, allowEmpty: true });
    if (s && !/^(https?:\/\/|\/)/i.test(s)) fail('Link ảnh phải bắt đầu bằng http://, https:// hoặc /');
    return s;
}

const clampLimit = (v, def, max) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 1) return def;
    return Math.min(Math.floor(n), max);
};

/** Quy đổi period/from/to (dùng chung với dashboard) và đổi lỗi sang ToolInputError cho chatbot. */
function resolveRange(input) {
    try {
        return resolveRangeBase(input || {});
    } catch (e) {
        if (e instanceof RangeInputError) fail(e.message);
        throw e;
    }
}

const compactProduct = (p) => ({
    id: p.id,
    name: p.name,
    price: Number(p.price),
    stock: Number(p.stock),
    category_id: p.category_id,
    category_name: p.category_name || null,
});

const compactOrder = (o) => ({
    id: o.id,
    order_code: o.order_code,
    customer_name: o.customer_name,
    customer_phone: o.customer_phone,
    total_amount: Number(o.total_amount),
    status: o.status,
    status_label: STATUS_VI[o.status] || o.status,
    payment_method: o.payment_method,
    payment_status: o.payment_status,
    created_at: fmtDate(o.created_at),
});

async function mustGetProduct(id) {
    const p = await Product.getProductById(id);
    if (!p) fail(`Không tìm thấy sản phẩm #${id}`);
    return p;
}

async function mustGetCategory(id) {
    const c = await Category.getCategoryById(id);
    if (!c) fail(`Không tìm thấy danh mục #${id}`);
    return c;
}

async function mustGetOrder(id) {
    const o = await Order.getOrderById(id);
    if (!o) fail(`Không tìm thấy đơn hàng #${id}`);
    return o;
}

const changeLine = (label, from, to, fmt = (x) => x) => `- ${label}: ${fmt(from)} → ${fmt(to)}`;

// ───────────────────────── Tool đọc dữ liệu ─────────────────────────

const readTools = [
    {
        name: 'get_dashboard_stats',
        description:
            'Lấy số liệu trang Tổng quan: tổng sản phẩm, tổng đơn hàng, tổng doanh thu, số sản phẩm tồn kho thấp (<= 10), ' +
            'số đơn chờ xử lý và doanh thu theo tháng (6 tháng gần nhất). Dùng khi hỏi tình hình chung của cửa hàng.',
        input_schema: { type: 'object', properties: {} },
        access: 'staff',
        write: false,
        async run() {
            const s = await Order.getDashboardStats();
            return {
                ...s,
                notes: [
                    'totalRevenue chỉ tính đơn có trạng thái delivered hoặc completed.',
                    'monthlyRevenue cũng chỉ tính đơn delivered/completed (không gồm đơn đã hủy).',
                ],
            };
        },
    },
    {
        name: 'get_analytics',
        description:
            'Thống kê (trang Thống kê) trong một khoảng thời gian: số đơn, doanh thu thực (đơn delivered/completed), ' +
            'giá trị đơn trung bình, phân bổ theo trạng thái đơn, theo phương thức thanh toán và top sản phẩm bán chạy. ' +
            'Dùng `period` cho các mốc phổ biến, hoặc from/to (YYYY-MM-DD) cho khoảng tùy chọn.',
        input_schema: {
            type: 'object',
            properties: {
                period: {
                    type: 'string',
                    enum: ['today', '7d', '30d', 'this_month', 'last_month', 'this_year'],
                    description: 'Mốc thời gian có sẵn. Mặc định 30d. Bị bỏ qua nếu có from/to.',
                },
                from: { type: 'string', description: 'Ngày bắt đầu YYYY-MM-DD' },
                to: { type: 'string', description: 'Ngày kết thúc YYYY-MM-DD (gồm cả ngày này)' },
            },
        },
        access: 'staff',
        write: false,
        async run(input) {
            resolveRange(input); // kiểm tra đầu vào sớm để trả lỗi tiếng Việt cho AI
            return getAnalytics(input);
        },
    },
    {
        name: 'list_products',
        description:
            'Tìm/lọc sản phẩm (trang Sản phẩm). Trả về tối đa `limit` sản phẩm mới nhất kèm tổng số khớp. ' +
            'Dùng max_stock=10 để tìm hàng sắp hết, max_stock=0 để tìm hàng đã hết. ' +
            'LUÔN dùng tool này để tra id sản phẩm theo tên trước khi sửa/xóa.',
        input_schema: {
            type: 'object',
            properties: {
                search: { type: 'string', description: 'Từ khóa trong tên hoặc mô tả' },
                category_id: { type: 'integer' },
                type: { type: 'string', enum: CATEGORY_TYPES, description: 'Loại danh mục: pc, component, peripheral' },
                min_price: { type: 'integer' },
                max_price: { type: 'integer' },
                max_stock: { type: 'integer', description: 'Chỉ lấy sản phẩm có tồn kho <= giá trị này' },
                limit: { type: 'integer', description: 'Mặc định 20, tối đa 50' },
            },
        },
        access: 'staff',
        write: false,
        async run(input) {
            const filters = {};
            if (input.search) filters.search = pStr(input.search, 'Từ khóa', { max: 100 });
            if (input.category_id !== undefined) filters.category_id = pInt(input.category_id, 'category_id', { min: 1 });
            if (input.type) filters.type = pEnum(input.type, 'type', CATEGORY_TYPES);
            if (input.min_price !== undefined) filters.min_price = pPrice(input.min_price, 'min_price');
            if (input.max_price !== undefined) filters.max_price = pPrice(input.max_price, 'max_price');

            let rows = await Product.getAllProducts(filters);
            if (input.max_stock !== undefined) {
                const ms = pInt(input.max_stock, 'max_stock', { min: 0 });
                rows = rows.filter((p) => Number(p.stock) <= ms);
            }
            const limit = clampLimit(input.limit, 20, 50);
            return {
                total_matched: rows.length,
                returned: Math.min(rows.length, limit),
                products: rows.slice(0, limit).map(compactProduct),
            };
        },
    },
    {
        name: 'get_product',
        description: 'Xem chi tiết một sản phẩm theo id: mô tả, giá, tồn kho, danh mục, link ảnh và thông số kỹ thuật (specs).',
        input_schema: {
            type: 'object',
            properties: { id: { type: 'integer' } },
            required: ['id'],
        },
        access: 'staff',
        write: false,
        async run(input) {
            const p = await mustGetProduct(pInt(input.id, 'id', { min: 1 }));
            return {
                ...compactProduct(p),
                description: p.description,
                image_url: p.image_url,
                specs: p.specs,
                category_type: p.category_type,
                created_at: fmtDate(p.created_at),
                updated_at: fmtDate(p.updated_at),
            };
        },
    },
    {
        name: 'list_categories',
        description:
            'Liệt kê toàn bộ danh mục (trang Danh mục) kèm danh mục cha và số sản phẩm trong mỗi danh mục. ' +
            'LUÔN dùng tool này để tra id danh mục theo tên trước khi tạo sản phẩm/sửa/xóa danh mục.',
        input_schema: { type: 'object', properties: {} },
        access: 'staff',
        write: false,
        async run() {
            const [categories, counts] = await Promise.all([
                Category.getAllCategories(),
                db.query('SELECT category_id, COUNT(*) AS n FROM products GROUP BY category_id'),
            ]);
            const countMap = new Map(counts.map((r) => [r.category_id, Number(r.n)]));
            return {
                total: categories.length,
                categories: categories.map((c) => ({
                    id: c.id,
                    name: c.name,
                    type: c.type,
                    type_label: TYPE_VI[c.type] || c.type,
                    parent_id: c.parent_id,
                    parent_name: c.parent_name || null,
                    product_count: countMap.get(c.id) || 0,
                })),
            };
        },
    },
    {
        name: 'list_orders',
        description:
            'Tìm/lọc đơn hàng (trang Đơn hàng), mới nhất trước. Lọc theo trạng thái, trạng thái thanh toán, khoảng ngày, ' +
            'hoặc từ khóa (mã đơn, tên/SĐT/email khách). Trả về tối đa `limit` đơn kèm tổng số và tổng tiền khớp.',
        input_schema: {
            type: 'object',
            properties: {
                status: { type: 'string', enum: ORDER_STATUSES },
                payment_status: { type: 'string', enum: ['pending', 'paid'] },
                search: { type: 'string', description: 'Mã đơn, tên khách, số điện thoại hoặc email' },
                from: { type: 'string', description: 'YYYY-MM-DD' },
                to: { type: 'string', description: 'YYYY-MM-DD' },
                limit: { type: 'integer', description: 'Mặc định 10, tối đa 30' },
            },
        },
        access: 'staff',
        write: false,
        async run(input) {
            const filters = {};
            if (input.status) filters.status = pEnum(input.status, 'status', ORDER_STATUSES);
            if (input.payment_status) filters.payment_status = pEnum(input.payment_status, 'payment_status', ['pending', 'paid']);
            let rows = await Order.getOrders(filters);

            const from = pDate(input.from, 'from');
            const to = pDate(input.to, 'to');
            if (from || to) {
                rows = rows.filter((o) => {
                    const day = (fmtDate(o.created_at) || '').slice(0, 10);
                    return (!from || day >= from) && (!to || day <= to);
                });
            }
            if (input.search) {
                const q = pStr(input.search, 'Từ khóa', { max: 100 }).toLowerCase().replace(/^#/, '');
                rows = rows.filter((o) =>
                    [o.order_code, o.customer_name, o.customer_phone, o.customer_email].some((f) =>
                        String(f || '').toLowerCase().includes(q)
                    )
                );
            }

            const limit = clampLimit(input.limit, 10, 30);
            return {
                total_matched: rows.length,
                total_amount_matched: rows.reduce((s, o) => s + Number(o.total_amount || 0), 0),
                returned: Math.min(rows.length, limit),
                orders: rows.slice(0, limit).map(compactOrder),
            };
        },
    },
    {
        name: 'get_order',
        description: 'Xem chi tiết một đơn hàng (thông tin khách, địa chỉ, ghi chú, danh sách sản phẩm) theo `id` hoặc `order_code`.',
        input_schema: {
            type: 'object',
            properties: {
                id: { type: 'integer' },
                order_code: { type: 'string', description: 'Vd: ORD-1730000000000' },
            },
        },
        access: 'staff',
        write: false,
        async run(input) {
            let order;
            if (input.id !== undefined) {
                order = await mustGetOrder(pInt(input.id, 'id', { min: 1 }));
            } else if (input.order_code) {
                const code = pStr(input.order_code, 'order_code', { max: 64 }).replace(/^#/, '');
                order = await Order.getOrderByCode(code);
                if (!order) fail(`Không tìm thấy đơn hàng ${code}`);
            } else {
                fail('Cần cung cấp id hoặc order_code');
            }
            const items = await Order.getOrderItems(order.id);
            return {
                ...compactOrder(order),
                customer_email: order.customer_email,
                address: [order.customer_address, order.customer_ward, order.customer_district, order.customer_city]
                    .filter(Boolean)
                    .join(', '),
                note: order.note,
                subtotal: Number(order.subtotal),
                discount: Number(order.discount),
                shipping_fee: Number(order.shipping_fee),
                items: items.map((i) => ({
                    product_id: i.product_id,
                    name: i.product_name,
                    quantity: Number(i.quantity),
                    price: Number(i.price),
                    total: Number(i.total),
                })),
            };
        },
    },
    {
        name: 'list_conversations',
        description:
            'Liệt kê các cuộc chat hỗ trợ với khách hàng (trang Hỗ trợ khách hàng), chưa đọc và mới nhất trước. ' +
            'Lọc theo status (open/closed), needs_human=true (khách đang chờ nhân viên) hoặc từ khóa (tên, SĐT, nội dung gần nhất).',
        input_schema: {
            type: 'object',
            properties: {
                status: { type: 'string', enum: ['open', 'closed'] },
                needs_human: { type: 'boolean' },
                search: { type: 'string' },
                limit: { type: 'integer', description: 'Mặc định 10, tối đa 20' },
            },
        },
        access: 'staff',
        write: false,
        async run(input) {
            const r = await Support.listConversations({
                status: input.status ? pEnum(input.status, 'status', ['open', 'closed']) : undefined,
                needs_human: input.needs_human === true,
                search: input.search ? pStr(input.search, 'Từ khóa', { max: 100 }) : undefined,
                limit: clampLimit(input.limit, 10, 20),
            });
            return {
                total_matched: r.total,
                unread_total: await Support.unreadStaffTotal(),
                conversations: r.rows.map((c) => ({
                    id: c.id,
                    customer_name: c.customer_name || 'Khách ẩn danh',
                    customer_phone: c.customer_phone,
                    status: c.status,
                    needs_human: !!c.needs_human,
                    ai_enabled: !!c.ai_enabled,
                    unread: Number(c.unread_staff),
                    last_message_at: fmtDate(c.last_message_at),
                    last_message_preview: c.last_message_preview,
                })),
            };
        },
    },
    {
        name: 'get_conversation',
        description: 'Đọc một cuộc chat hỗ trợ theo id: thông tin khách và 20 tin nhắn gần nhất.',
        input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
        access: 'staff',
        write: false,
        async run(input) {
            const id = pInt(input.id, 'id', { min: 1 });
            const c = await Support.getConversationById(id);
            if (!c) fail(`Không tìm thấy hội thoại #${id}`);
            const msgs = await Support.getMessages(id, { limit: 20 });
            return {
                id: c.id, customer_name: c.customer_name || 'Khách ẩn danh', customer_phone: c.customer_phone, status: c.status,
                needs_human: !!c.needs_human, ai_enabled: !!c.ai_enabled,
                messages: msgs.map((m) => ({ from: m.sender_type, name: m.sender_name, content: m.content, at: fmtDate(m.created_at) })),
            };
        },
    },
    {
        name: 'navigate',
        description:
            'Mở một trang trong dashboard cho người dùng (dashboard, products, categories, orders, analytics, settings). ' +
            'Dùng khi người dùng muốn "mở / chuyển tới / xem trang ...".',
        input_schema: {
            type: 'object',
            properties: { page: { type: 'string', enum: Object.keys(ADMIN_PAGES) } },
            required: ['page'],
        },
        access: 'staff',
        write: false,
        async run(input) {
            const page = ADMIN_PAGES[pEnum(input.page, 'page', Object.keys(ADMIN_PAGES))];
            return { message: `Đã mở trang ${page.label}`, _client_action: { type: 'navigate', path: page.path } };
        },
    },
];

// ───────────────────────── Tool ghi dữ liệu (cần xác nhận) ─────────────────────────

const writeTools = [
    {
        name: 'create_product',
        description:
            'Tạo sản phẩm mới. Bắt buộc: name, price (VND, số nguyên), category_id (tra bằng list_categories). ' +
            'Thao tác này cần người dùng xác nhận.',
        input_schema: {
            type: 'object',
            properties: {
                name: { type: 'string' },
                price: { type: 'integer', description: 'Giá VND, số nguyên. Vd 15 triệu = 15000000' },
                category_id: { type: 'integer' },
                stock: { type: 'integer', description: 'Mặc định 0' },
                description: { type: 'string' },
                image_url: { type: 'string' },
                specs: { type: 'object', description: 'Thông số kỹ thuật, vd {"RAM":"16GB","CPU":"i5"}' },
            },
            required: ['name', 'price', 'category_id'],
        },
        access: 'staff',
        write: true,
        parse(input) {
            return {
                name: pStr(input.name, 'Tên sản phẩm', { max: 255 }),
                price: pPrice(input.price),
                category_id: pInt(input.category_id, 'category_id', { min: 1 }),
                stock: pInt(input.stock ?? 0, 'Tồn kho', { max: 1e7 }),
                description: pStr(input.description, 'Mô tả', { max: 5000, optional: true, allowEmpty: true }),
                image_url: pImageUrl(input.image_url),
                specs: pSpecs(input.specs),
            };
        },
        async describe(p) {
            const cat = await mustGetCategory(p.category_id);
            return `Tạo sản phẩm mới "${p.name}"\n- Giá: ${vnd(p.price)}\n- Tồn kho: ${p.stock}\n- Danh mục: ${cat.name} (#${cat.id})`;
        },
        async run(p) {
            await mustGetCategory(p.category_id);
            const id = await Product.createProduct(p);
            return { message: `Đã tạo sản phẩm "${p.name}" (#${id})`, data: { id } };
        },
    },
    {
        name: 'update_product',
        description:
            'Sửa thông tin sản phẩm (tên, giá, mô tả, danh mục, ảnh, specs). Chỉ truyền các trường cần đổi. ' +
            '`specs` được GỘP vào specs hiện có (giá trị null = xóa khóa đó). Muốn đổi tồn kho hãy dùng update_stock. ' +
            'Cần người dùng xác nhận.',
        input_schema: {
            type: 'object',
            properties: {
                id: { type: 'integer' },
                name: { type: 'string' },
                price: { type: 'integer', description: 'Giá VND, số nguyên' },
                category_id: { type: 'integer' },
                description: { type: 'string' },
                image_url: { type: 'string' },
                specs: { type: 'object' },
            },
            required: ['id'],
        },
        access: 'staff',
        write: true,
        parse(input) {
            const p = {
                id: pInt(input.id, 'id', { min: 1 }),
                name: pStr(input.name, 'Tên sản phẩm', { max: 255, optional: true }),
                price: input.price === undefined ? undefined : pPrice(input.price),
                category_id: pInt(input.category_id, 'category_id', { min: 1, optional: true }),
                description: pStr(input.description, 'Mô tả', { max: 5000, optional: true, allowEmpty: true }),
                image_url: pImageUrl(input.image_url),
                specs: pSpecs(input.specs),
            };
            if (Object.entries(p).every(([k, v]) => k === 'id' || v === undefined)) fail('Không có trường nào cần cập nhật');
            return p;
        },
        async describe(p) {
            const cur = await mustGetProduct(p.id);
            const lines = [];
            if (p.name !== undefined && p.name !== cur.name) lines.push(changeLine('Tên', cur.name, p.name, (x) => `"${x}"`));
            if (p.price !== undefined && p.price !== Number(cur.price)) lines.push(changeLine('Giá', cur.price, p.price, vnd));
            if (p.category_id !== undefined && p.category_id !== cur.category_id) {
                const cat = await mustGetCategory(p.category_id);
                lines.push(changeLine('Danh mục', cur.category_name || cur.category_id, cat.name));
            }
            if (p.description !== undefined && p.description !== (cur.description || '')) lines.push('- Mô tả: thay đổi nội dung');
            if (p.image_url !== undefined && p.image_url !== (cur.image_url || '')) lines.push('- Ảnh: thay đổi link');
            if (p.specs) {
                for (const [k, v] of Object.entries(p.specs)) {
                    const old = cur.specs?.[k];
                    if (v === null) lines.push(`- Thông số "${k}": xóa (đang là ${old ?? 'trống'})`);
                    else if (String(old) !== String(v)) lines.push(changeLine(`Thông số "${k}"`, old ?? 'trống', v));
                }
            }
            if (!lines.length) fail('Các giá trị đưa ra trùng với dữ liệu hiện tại, không có gì để cập nhật');
            return `Cập nhật sản phẩm #${cur.id} "${cur.name}"\n${lines.join('\n')}`;
        },
        async run(p) {
            const cur = await mustGetProduct(p.id);
            const { id, specs, ...rest } = p;
            const data = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
            if (p.category_id !== undefined) await mustGetCategory(p.category_id);
            if (specs) {
                const merged = { ...(cur.specs || {}), ...specs };
                for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k];
                data.specs = merged;
            }
            await Product.updateProduct(id, data);
            return { message: `Đã cập nhật sản phẩm #${id} "${data.name || cur.name}"` };
        },
    },
    {
        name: 'update_stock',
        description:
            'Cập nhật tồn kho một sản phẩm. mode="set": đặt tồn kho bằng đúng `quantity`. ' +
            'mode="add": cộng thêm `quantity` (số âm = trừ bớt) — dùng khi người dùng nói "nhập thêm", "bán/trừ đi"... ' +
            'Cần người dùng xác nhận.',
        input_schema: {
            type: 'object',
            properties: {
                id: { type: 'integer' },
                mode: { type: 'string', enum: ['set', 'add'] },
                quantity: { type: 'integer' },
            },
            required: ['id', 'mode', 'quantity'],
        },
        access: 'staff',
        write: true,
        parse(input) {
            const mode = pEnum(input.mode, 'mode', ['set', 'add']);
            return {
                id: pInt(input.id, 'id', { min: 1 }),
                mode,
                quantity: pInt(input.quantity, 'quantity', { min: mode === 'add' ? -1e7 : 0, max: 1e7 }),
            };
        },
        async describe(p) {
            const cur = await mustGetProduct(p.id);
            const next = p.mode === 'set' ? p.quantity : Number(cur.stock) + p.quantity;
            if (next < 0) fail(`Tồn kho hiện tại của "${cur.name}" là ${cur.stock}, không thể trừ ${Math.abs(p.quantity)}`);
            const verb = p.mode === 'set' ? 'Đặt tồn kho' : p.quantity >= 0 ? `Nhập thêm ${p.quantity}` : `Trừ ${Math.abs(p.quantity)}`;
            return `${verb} cho #${cur.id} "${cur.name}"\n- Tồn kho: ${cur.stock} → ${next}`;
        },
        async run(p) {
            const cur = await mustGetProduct(p.id);
            if (p.mode === 'set') {
                await Product.setStock(p.id, p.quantity);
                return { message: `Đã đặt tồn kho "${cur.name}" = ${p.quantity}` };
            }
            const [r] =
                p.quantity >= 0
                    ? await db.pool.query(
                          'UPDATE products SET stock = stock + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                          [p.quantity, p.id]
                      )
                    : await db.pool.query(
                          'UPDATE products SET stock = stock - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND stock >= ?',
                          [-p.quantity, p.id, -p.quantity]
                      );
            if (!r.affectedRows) fail(`Tồn kho "${cur.name}" không đủ để trừ ${Math.abs(p.quantity)}`);
            const after = await mustGetProduct(p.id);
            return { message: `Đã cập nhật tồn kho "${cur.name}": ${cur.stock} → ${after.stock}` };
        },
    },
    {
        name: 'delete_product',
        description: 'XÓA vĩnh viễn một sản phẩm theo id. Chỉ admin. Cần người dùng xác nhận.',
        input_schema: {
            type: 'object',
            properties: { id: { type: 'integer' } },
            required: ['id'],
        },
        access: 'admin',
        write: true,
        danger: true,
        parse: (input) => ({ id: pInt(input.id, 'id', { min: 1 }) }),
        async describe(p) {
            const cur = await mustGetProduct(p.id);
            return `XÓA VĨNH VIỄN sản phẩm #${cur.id} "${cur.name}" (giá ${vnd(cur.price)}, tồn kho ${cur.stock})`;
        },
        async run(p) {
            const cur = await mustGetProduct(p.id);
            await Product.deleteProduct(p.id);
            return { message: `Đã xóa sản phẩm #${p.id} "${cur.name}"` };
        },
    },
    {
        name: 'create_category',
        description: 'Tạo danh mục mới. type: pc (máy tính), component (linh kiện), peripheral (phụ kiện). parent_id tùy chọn. Cần xác nhận.',
        input_schema: {
            type: 'object',
            properties: {
                name: { type: 'string' },
                type: { type: 'string', enum: CATEGORY_TYPES },
                parent_id: { type: ['integer', 'null'] },
            },
            required: ['name', 'type'],
        },
        access: 'staff',
        write: true,
        parse(input) {
            return {
                name: pStr(input.name, 'Tên danh mục', { max: 100 }),
                type: pEnum(input.type, 'type', CATEGORY_TYPES),
                parent_id: input.parent_id == null ? null : pInt(input.parent_id, 'parent_id', { min: 1 }),
            };
        },
        async describe(p) {
            let parent = '';
            if (p.parent_id) parent = `\n- Danh mục cha: ${(await mustGetCategory(p.parent_id)).name}`;
            return `Tạo danh mục "${p.name}"\n- Loại: ${TYPE_VI[p.type]}${parent}`;
        },
        async run(p) {
            if (p.parent_id) await mustGetCategory(p.parent_id);
            const id = await Category.createCategory(p);
            return { message: `Đã tạo danh mục "${p.name}" (#${id})`, data: { id } };
        },
    },
    {
        name: 'update_category',
        description:
            'Sửa danh mục: đổi tên, loại hoặc danh mục cha (parent_id = null để đưa về cấp gốc). Chỉ truyền trường cần đổi. Cần xác nhận.',
        input_schema: {
            type: 'object',
            properties: {
                id: { type: 'integer' },
                name: { type: 'string' },
                type: { type: 'string', enum: CATEGORY_TYPES },
                parent_id: { type: ['integer', 'null'] },
            },
            required: ['id'],
        },
        access: 'staff',
        write: true,
        parse(input) {
            const p = { id: pInt(input.id, 'id', { min: 1 }) };
            if (input.name !== undefined) p.name = pStr(input.name, 'Tên danh mục', { max: 100 });
            if (input.type !== undefined) p.type = pEnum(input.type, 'type', CATEGORY_TYPES);
            if ('parent_id' in input) p.parent_id = input.parent_id == null ? null : pInt(input.parent_id, 'parent_id', { min: 1 });
            if (p.parent_id === p.id) fail('Danh mục không thể là cha của chính nó');
            if (Object.keys(p).length === 1) fail('Không có trường nào cần cập nhật');
            return p;
        },
        async describe(p) {
            const cur = await mustGetCategory(p.id);
            const lines = [];
            if (p.name !== undefined && p.name !== cur.name) lines.push(changeLine('Tên', cur.name, p.name, (x) => `"${x}"`));
            if (p.type !== undefined && p.type !== cur.type) lines.push(changeLine('Loại', TYPE_VI[cur.type], TYPE_VI[p.type]));
            if ('parent_id' in p && p.parent_id !== cur.parent_id) {
                const to = p.parent_id ? (await mustGetCategory(p.parent_id)).name : 'Không có (cấp gốc)';
                lines.push(changeLine('Danh mục cha', cur.parent_name || 'Không có (cấp gốc)', to));
            }
            if (!lines.length) fail('Các giá trị đưa ra trùng với dữ liệu hiện tại, không có gì để cập nhật');
            return `Cập nhật danh mục #${cur.id} "${cur.name}"\n${lines.join('\n')}`;
        },
        async run(p) {
            const cur = await mustGetCategory(p.id);
            const { id, ...data } = p;
            if (data.parent_id) await mustGetCategory(data.parent_id);
            await Category.updateCategory(id, data);
            return { message: `Đã cập nhật danh mục #${id} "${data.name || cur.name}"` };
        },
    },
    {
        name: 'delete_category',
        description:
            'XÓA một danh mục theo id. Chỉ xóa được khi danh mục không còn danh mục con và không còn sản phẩm. Chỉ admin. Cần xác nhận.',
        input_schema: {
            type: 'object',
            properties: { id: { type: 'integer' } },
            required: ['id'],
        },
        access: 'admin',
        write: true,
        danger: true,
        parse: (input) => ({ id: pInt(input.id, 'id', { min: 1 }) }),
        async describe(p) {
            const cur = await mustGetCategory(p.id);
            const [{ n: subs }] = await db.query('SELECT COUNT(*) AS n FROM categories WHERE parent_id = ?', [p.id]);
            const [{ n: prods }] = await db.query('SELECT COUNT(*) AS n FROM products WHERE category_id = ?', [p.id]);
            if (Number(subs) > 0) fail(`Danh mục "${cur.name}" còn ${subs} danh mục con, cần xử lý trước khi xóa`);
            if (Number(prods) > 0) fail(`Danh mục "${cur.name}" còn ${prods} sản phẩm, cần chuyển hoặc xóa sản phẩm trước`);
            return `XÓA danh mục #${cur.id} "${cur.name}"`;
        },
        async run(p) {
            const cur = await mustGetCategory(p.id);
            try {
                await Category.deleteCategory(p.id);
            } catch (e) {
                if (/subcategories|with products/i.test(e.message)) fail(`Không thể xóa "${cur.name}": danh mục còn danh mục con hoặc sản phẩm`);
                throw e;
            }
            return { message: `Đã xóa danh mục #${p.id} "${cur.name}"` };
        },
    },
    {
        name: 'update_order_status',
        description:
            'Đổi trạng thái đơn hàng theo đúng vòng đời: pending → processing → shipped → delivered → completed; ' +
            'pending/processing/shipped có thể → cancelled (hủy đơn sẽ TỰ HOÀN LẠI tồn kho). ' +
            'completed và cancelled là trạng thái cuối, không đổi tiếp được; không được nhảy cóc bước. ' +
            'Khi chuyển sang delivered với đơn COD, hệ thống tự đánh dấu đã thanh toán. Cần xác nhận.',
        input_schema: {
            type: 'object',
            properties: {
                id: { type: 'integer' },
                status: { type: 'string', enum: ORDER_STATUSES },
                note: { type: 'string', description: 'Ghi chú lưu vào lịch sử trạng thái (tùy chọn)' },
            },
            required: ['id', 'status'],
        },
        access: 'staff',
        write: true,
        parse(input) {
            return {
                id: pInt(input.id, 'id', { min: 1 }),
                status: pEnum(input.status, 'status', ORDER_STATUSES),
                note: pStr(input.note, 'Ghi chú', { max: 500, optional: true }),
            };
        },
        async describe(p) {
            const cur = await mustGetOrder(p.id);
            if (cur.status === p.status) fail(`Đơn ${cur.order_code} đã ở trạng thái "${STATUS_VI[p.status]}"`);
            if (!canTransition(cur.status, p.status)) {
                const next = (TRANSITIONS[cur.status] || []).map((x) => `"${STATUS_VI[x]}"`).join(', ');
                fail(
                    `Không thể chuyển đơn ${cur.order_code} từ "${STATUS_VI[cur.status]}" sang "${STATUS_VI[p.status]}". ` +
                        (next ? `Chỉ có thể chuyển sang: ${next}.` : 'Đây là trạng thái cuối.')
                );
            }
            let text =
                `Đổi trạng thái đơn #${cur.id} (${cur.order_code}) của ${cur.customer_name}, ${vnd(cur.total_amount)}\n` +
                changeLine('Trạng thái', STATUS_VI[cur.status] || cur.status, STATUS_VI[p.status]);
            if (p.note) text += `\n- Ghi chú: ${p.note}`;
            if (p.status === 'cancelled') text += '\n- Hủy đơn sẽ hoàn lại tồn kho các sản phẩm trong đơn.';
            return text;
        },
        async run(p, ctx) {
            const cur = await mustGetOrder(p.id);
            try {
                await Order.updateOrderStatus(p.id, p.status, ctx.user.id, p.note || 'Cập nhật qua chatbot');
            } catch (e) {
                if (e && e.expose) fail(e.message); // lỗi nghiệp vụ của model (trạng thái không hợp lệ...)
                throw e;
            }
            return { message: `Đã chuyển đơn ${cur.order_code} sang "${STATUS_VI[p.status]}"` };
        },
    },
    {
        name: 'reply_to_conversation',
        description:
            'Gửi tin nhắn trả lời khách trong một cuộc chat hỗ trợ (hiện ngay trên màn hình của khách, với tên của người đang chat với bạn). ' +
            'Nên đọc hội thoại bằng get_conversation trước. Cần người dùng xác nhận nội dung chính xác trước khi gửi.',
        input_schema: {
            type: 'object',
            properties: { id: { type: 'integer' }, content: { type: 'string', description: 'Nội dung tin nhắn gửi khách (tối đa 2000 ký tự)' } },
            required: ['id', 'content'],
        },
        access: 'staff',
        write: true,
        parse: (input) => ({ id: pInt(input.id, 'id', { min: 1 }), content: pStr(input.content, 'Nội dung tin nhắn', { max: 2000 }) }),
        async describe(p) {
            const c = await Support.getConversationById(p.id);
            if (!c) fail(`Không tìm thấy hội thoại #${p.id}`);
            return `Gửi tin cho khách "${c.customer_name || 'Khách ẩn danh'}" (hội thoại #${c.id}):\n"${p.content}"\n- Khách sẽ thấy tin này ngay lập tức`;
        },
        async run(p, ctx) {
            try {
                await supportService.postStaffMessage({ conversationId: p.id, staff: ctx.user, content: p.content });
            } catch (e) {
                if (e && e.expose) fail(e.message);
                throw e;
            }
            return { message: `Đã gửi tin nhắn cho khách ở hội thoại #${p.id}` };
        },
    },
    {
        name: 'update_my_profile',
        description:
            'Cập nhật hồ sơ của CHÍNH người đang chat (họ tên, email) — tương ứng trang Cài đặt. ' +
            'Không đổi được mật khẩu qua chatbot. Cần xác nhận.',
        input_schema: {
            type: 'object',
            properties: { full_name: { type: 'string' }, email: { type: 'string' } },
        },
        access: 'staff',
        write: true,
        parse(input) {
            const p = {
                full_name: pStr(input.full_name, 'Họ tên', { max: 100, optional: true }),
                email: pStr(input.email, 'Email', { max: 150, optional: true }),
            };
            if (p.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) fail('Email không hợp lệ');
            if (p.full_name === undefined && p.email === undefined) fail('Không có trường nào cần cập nhật');
            return p;
        },
        async describe(p, ctx) {
            const cur = await User.getUserById(ctx.user.id);
            const lines = [];
            if (p.full_name !== undefined && p.full_name !== cur.full_name) lines.push(changeLine('Họ tên', cur.full_name, p.full_name));
            if (p.email !== undefined && p.email !== cur.email) {
                const existing = await User.getUserByEmail(p.email);
                if (existing && existing.id !== cur.id) fail('Email này đã được tài khoản khác sử dụng');
                lines.push(changeLine('Email', cur.email, p.email));
            }
            if (!lines.length) fail('Các giá trị đưa ra trùng với hồ sơ hiện tại');
            return `Cập nhật hồ sơ của bạn\n${lines.join('\n')}`;
        },
        async run(p, ctx) {
            if (p.email) {
                const existing = await User.getUserByEmail(p.email);
                if (existing && existing.id !== ctx.user.id) fail('Email này đã được tài khoản khác sử dụng');
            }
            const data = Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined));
            await User.updateProfile(ctx.user.id, data);
            return { message: 'Đã cập nhật hồ sơ của bạn' };
        },
    },
];

// ───────────────────────── Xuất ra ─────────────────────────

const allTools = [...readTools, ...writeTools];
const byName = new Map(allTools.map((t) => [t.name, t]));

const canUse = (tool, role) => role === 'admin' || (role === 'staff' && tool.access === 'staff');

module.exports = {
    ToolInputError,
    ORDER_STATUSES,
    getTool: (name) => byName.get(name),
    canUse,
    getToolsForRole: (role) => allTools.filter((t) => canUse(t, role)),
    // Chỉ để phục vụ kiểm thử
    _internal: { resolveRange, addDays, todayYmd, fmtDate, vnd },
};
