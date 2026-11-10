'use strict';

// Uses a newly-created disposable database. Never writes fixtures into DB_NAME.
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { randomBytes } = require('crypto');
require('dotenv').config();

async function main() {
    const database = `shoppc_ops_test_${Date.now()}_${randomBytes(3).toString('hex')}`;
    const adminConnection = await mysql.createConnection({ host: process.env.DB_HOST || 'localhost', port: process.env.DB_PORT || 3306, user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '123456', ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined });
    let db, server, created = false;
    try {
        await adminConnection.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`); created = true;
        process.env.DB_NAME = database;
        process.env.CORS_ORIGINS = 'http://127.0.0.1:3004,http://localhost:3004';
        db = require('../src/config/database');
        const Schema = require('../src/config/schema');
        const target = Schema.loadTarget();
        for (const name of target.order) await db.query(target.tables[name].ddl);
        const ledger = require('../src/services/operationsLedger');
        assert(await ledger.initialize());
        const bcrypt = require('bcryptjs');
        const password = await bcrypt.hash('OpsDemo2026!', 10);
        for (const [username, role] of [['ops_admin', 'admin'], ['ops_staff', 'staff'], ['ops_customer', 'customer']]) await db.query('INSERT INTO users (username,password,email,full_name,role) VALUES (?,?,?,?,?)', [username, password, `${username}@example.invalid`, username, role]);
        const admin = { id: 1, username: 'ops_admin', role: 'admin' }, staff = { id: 2, username: 'ops_staff', role: 'staff' };
        const Catalog = require('../src/services/operationsCatalog');
        const Inventory = require('../src/services/operationsInventory');
        const Warranty = require('../src/services/operationsWarranty');
        const After = require('../src/services/operationsAftersales');
        const Bulk = require('../src/services/operationsBulk');
        const Product = require('../src/models/Product');
        const Order = require('../src/models/Order');
        const scalar = async (sql, values = []) => Object.values((await db.query(sql, values))[0])[0];
        const rejects = async (fn, pattern) => assert.rejects(fn, pattern);
        await db.query("INSERT INTO categories (name,type) VALUES ('CPU','component')");
        const brand = await Catalog.saveCatalog('brands', null, { name: 'Test Brand' }, admin);
        const template = await Catalog.saveCatalog('templates', null, { name: 'CPU chuẩn', category_id: 1, fields: [{ key: 'Socket', type: 'select', required: true, options: ['AM5', 'LGA1700'] }, { key: 'Cores', type: 'number', required: true }] }, admin);
        await rejects(() => Product.createProduct({ name: 'Sai thông số', price: 1000, category_id: 1, spec_template_id: template.id, specs: {} }), /Thiếu thông số/);
        const serialized = await Product.createProduct({ name: 'CPU test serial', sku: 'CPU-TEST', price: 1000, stock: 0, category_id: 1, brand_id: brand.id, spec_template_id: template.id, specs: { Socket: 'AM5', Cores: 8 }, serial_required: true, warranty_months: 36 }, admin);
        const ordinary = await Product.createProduct({ name: 'Phụ kiện test', sku: 'NORMAL-TEST', price: 2000, stock: 0, category_id: 1 }, admin);
        const supplier = await Catalog.saveCatalog('suppliers', null, { code: 'SUP-TEST', name: 'Nhà cung cấp test' }, admin);
        const receipt = await Inventory.saveReceipt(null, { supplier_id: supplier.id, items: [{ product_id: serialized, quantity: 2, unit_cost: 700, serial_numbers: ['SERIAL-A', 'SERIAL-B'] }, { product_id: ordinary, quantity: 5, unit_cost: 1000 }] }, staff);
        const double = await Promise.allSettled([Inventory.receiveReceipt(receipt.id, admin), Inventory.receiveReceipt(receipt.id, admin)]);
        assert.equal(double.filter((r) => r.status === 'fulfilled').length, 1);
        assert.equal(await scalar('SELECT stock FROM products WHERE id = ?', [serialized]), 2);
        assert.equal(await scalar('SELECT COUNT(*) FROM product_serials'), 2);
        assert.equal(await scalar('SELECT COUNT(*) FROM inventory_movements'), 2);
        console.log('✓ Nhà cung cấp, hãng/mẫu thông số, nhập kho và serial; xác nhận đồng thời không cộng tồn hai lần');

        const duplicate = await Inventory.saveReceipt(null, { supplier_id: supplier.id, items: [{ product_id: serialized, quantity: 1, unit_cost: 700, serial_numbers: ['SERIAL-A'] }] }, admin);
        await rejects(() => Inventory.receiveReceipt(duplicate.id, admin), /đã tồn tại/);
        assert.equal(await scalar('SELECT stock FROM products WHERE id = ?', [serialized]), 2);
        assert.equal(await scalar('SELECT COUNT(*) FROM inventory_movements'), 2);
        await Inventory.cancelReceipt(duplicate.id, admin);
        await rejects(() => Inventory.saveReceipt(receipt.id, { supplier_id: supplier.id, items: [{ product_id: ordinary, quantity: 1, unit_cost: 10 }] }, admin), /Chỉ sửa được/);
        await rejects(() => Product.setStock(serialized, 10, admin), /serial/);
        await Inventory.adjustStock(ordinary, 4, admin, 'Kiểm kê thử nghiệm');
        assert.equal(await scalar('SELECT stock FROM products WHERE id = ?', [ordinary]), 4);
        console.log('✓ Rollback toàn bộ khi serial trùng; chặn sửa phiếu đã nhập; điều chỉnh tồn có lịch sử');

        let session = 0;
        const buy = async (productId) => {
            const session_id = `ops-test-${++session}`;
            await db.query('INSERT INTO cart_items (session_id,product_id,quantity) VALUES (?,?,1)', [session_id, productId]);
            return Order.createOrderFromCart({ session_id, user_id: 3, customer_name: 'Khách test', customer_email: 'customer@example.invalid', customer_phone: '0900000000', customer_address: 'Địa chỉ test', customer_city: 'TP.HCM', payment_method: 'cod' });
        };
        const order = await buy(serialized);
        assert.equal(await scalar('SELECT stock FROM products WHERE id = ?', [serialized]), 1);
        await Order.updateOrderStatus(order.id, 'processing', admin.id);
        await rejects(() => Order.updateOrderStatus(order.id, 'shipped', admin.id), /gán đủ serial/);
        const item = (await Catalog.orderItems(order.id))[0];
        const serialId = await scalar("SELECT id FROM product_serials WHERE serial_number='SERIAL-A'");
        await Warranty.assignSerial(serialId, { order_item_id: item.id }, staff);
        await rejects(() => Warranty.assignSerial(serialId, { order_item_id: item.id }, staff), /không còn trong kho/);
        const shipment = await After.createShipment({ order_id: order.id, carrier: 'Hãng test', tracking_number: 'TRACK-TEST', estimated_delivery: '2026-12-01' }, staff);
        await After.updateShipment(shipment.id, { status: 'picked_up' }, staff);
        await After.updateShipment(shipment.id, { status: 'delivered', note: 'Đã giao test' }, staff);
        assert.equal(await scalar('SELECT status FROM orders WHERE id=?', [order.id]), 'delivered');
        assert.equal(await scalar('SELECT payment_status FROM orders WHERE id=?', [order.id]), 'paid');
        console.log('✓ Đặt hàng ghi xuất kho; chặn giao thiếu serial; vận chuyển đồng bộ đơn và thanh toán COD');

        const ticket = await Warranty.createWarranty({ serial_id: serialId, issue: 'Lỗi thử nghiệm' }, staff);
        await rejects(() => Warranty.createWarranty({ serial_id: serialId, issue: 'Phiếu trùng' }, staff), /đã bán/);
        await Warranty.updateWarranty(ticket.id, { status: 'diagnosing', resolution: 'Đang kiểm tra' }, staff);
        await Warranty.updateWarranty(ticket.id, { status: 'repairing', resolution: 'Đang sửa' }, staff);
        await Warranty.updateWarranty(ticket.id, { status: 'resolved', resolution: 'Đã xử lý' }, staff);
        await rejects(() => Warranty.updateWarranty(ticket.id, { status: 'repairing' }, staff), /Không thể chuyển/);
        assert.equal(await scalar('SELECT status FROM product_serials WHERE id=?', [serialId]), 'sold');
        console.log('✓ Bảo hành tiếp nhận một lần, kiểm tra/sửa/xử lý và trả serial về trạng thái đã bán');

        await rejects(() => After.createReturn({ order_item_id: item.id, quantity: 2, reason: 'Trả quá số lượng' }, staff), /vượt số lượng/);
        const ret = await After.createReturn({ order_item_id: item.id, quantity: 1, reason: 'Trả thử nghiệm' }, staff);
        await rejects(() => After.updateReturn(ret.id, { status: 'approved' }, staff), /quản trị viên/);
        await rejects(() => After.updateReturn(ret.id, { status: 'approved', refund_amount: 1001 }, admin), /vượt giá trị/);
        await After.updateReturn(ret.id, { status: 'approved', refund_amount: 1000 }, admin);
        await After.updateReturn(ret.id, { status: 'received', restock: true, serial_ids: [serialId] }, staff);
        await rejects(() => After.updateReturn(ret.id, { status: 'received', restock: true, serial_ids: [serialId] }, staff), /đã được thực hiện/);
        assert.equal(await scalar('SELECT stock FROM products WHERE id=?', [serialized]), 2);
        await After.updateReturn(ret.id, { status: 'refunded', refund_reference: 'REFUND-TEST' }, admin);
        await rejects(() => After.updateReturn(ret.id, { status: 'refunded', refund_reference: 'REFUND-TEST-2' }, admin), /đã được thực hiện/);
        assert.equal(await scalar("SELECT COUNT(*) FROM inventory_movements WHERE kind='return'"), 1);
        console.log('✓ Đổi trả chặn quá số lượng/tiền, staff không duyệt; nhận kho/hoàn tiền không lặp lại');

        const cancelOrder = await buy(serialized);
        await Order.updateOrderStatus(cancelOrder.id, 'processing', admin.id);
        const cancelItem = (await Catalog.orderItems(cancelOrder.id))[0];
        await Warranty.assignSerial(serialId, { order_item_id: cancelItem.id }, staff);
        await Order.updateOrderStatus(cancelOrder.id, 'cancelled', admin.id);
        assert.equal(await scalar('SELECT stock FROM products WHERE id=?', [serialized]), 2);
        assert.equal(await scalar('SELECT status FROM product_serials WHERE id=?', [serialId]), 'in_stock');
        console.log('✓ Hủy đơn hoàn tồn, ghi lịch sử và thu hồi gán serial');

        const input = [{ id: ordinary, sku: 'NORMAL-TEST', name: 'Phụ kiện đã nhập CSV', category_id: 1, price: 2100, stock: 6 }, { sku: 'CSV-NEW', name: 'Sản phẩm CSV mới', category_id: 1, price: 3000, stock: 3 }];
        const preview = await Bulk.previewRows(input);
        assert.equal(preview.valid, true);
        assert.equal(preview.creates, 1); assert.equal(preview.updates, 1);
        await Bulk.applyRows({ rows: input, fingerprint: preview.fingerprint, reason: 'Nhập CSV thử nghiệm' }, admin);
        assert.equal(await scalar('SELECT stock FROM products WHERE id=?', [ordinary]), 6);
        assert.equal(await scalar("SELECT COUNT(*) FROM products WHERE sku='CSV-NEW'"), 1);
        const stale = await Bulk.previewRows(input);
        await Product.updateProduct(ordinary, { price: 2200 }, admin);
        await rejects(() => Bulk.applyRows({ rows: input, fingerprint: stale.fingerprint, reason: 'Kiểm tra dữ liệu cũ' }, admin), /đã thay đổi/);
        const invalid = await Bulk.previewRows([{ sku: 'BAD', name: 'Sai', category_id: 999999, price: -1, stock: 0 }]);
        assert.equal(invalid.valid, false);
        assert((await Bulk.exportProducts()).includes('CSV-NEW'));
        assert.equal(Bulk.csvCell('=1+1'), '"\'=1+1"');
        await Warranty.registerSerials({ product_id: ordinary, serial_numbers: ['OPTIONAL-SERIAL'] }, admin);
        const protectedStock = await Bulk.previewRows([{ id: ordinary, sku: 'NORMAL-TEST', name: 'Phụ kiện', category_id: 1, price: 2200, stock: 7 }]);
        assert.equal(protectedStock.valid, false);
        assert.match(protectedStock.items[0].error, /đã có serial/);
        console.log('✓ CSV xem trước, áp dụng nguyên giao dịch, chặn bản xem trước cũ và xuất an toàn cho Excel');

        const app = require('../src/app');
        server = app.listen(process.argv.includes('--serve') ? 3100 : 0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        const base = `http://127.0.0.1:${server.address().port}/api`;
        const { signAccessToken } = require('../src/config/jwt');
        const call = (path, actor, method = 'GET', body) => fetch(`${base}${path}`, { method, headers: { ...(actor ? { Authorization: `Bearer ${signAccessToken(actor)}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        assert.equal((await call('/operations/lookups')).status, 401);
        assert.equal((await call('/operations/lookups', { id: 3, username: 'ops_customer', role: 'customer' })).status, 403);
        assert.equal((await call('/operations/audit', staff)).status, 403);
        assert.equal((await call('/operations/brands', staff, 'POST', { name: 'Không được phép' })).status, 403);
        assert.equal((await call('/operations/suppliers', staff)).status, 200);
        assert.equal((await call('/operations/bulk/preview', staff, 'POST', { rows: input })).status, 403);
        const auditList = await (await call('/operations/audit', admin)).json();
        assert(auditList.data.total >= 10);
        assert(!JSON.stringify(auditList).includes(password));
        for (const route of ['receipts', 'movements', 'serials', 'warranties', 'returns', 'shipments', 'brands', 'templates']) assert.equal((await call(`/operations/${route}`, admin)).status, 200, route);
        console.log('✓ HTTP thật: 401/403 đúng quyền, mọi danh sách truy vấn được; audit có dữ liệu và không lộ mật khẩu');

        if (process.argv.includes('--serve')) {
            console.log('QA server http://127.0.0.1:3100 — tài khoản test ops_admin / OpsDemo2026! (chỉ database dùng thử)');
            console.log('Nhập stop rồi Enter để kết thúc và dọn database QA (đặc biệt trên Windows).');
            await new Promise((resolve) => {
                const finish = () => { process.stdin.pause(); resolve(); };
                process.once('SIGINT', finish); process.once('SIGTERM', finish);
                process.stdin.setEncoding('utf8');
                process.stdin.on('data', (input) => { if (input.trim() === 'stop') finish(); });
                process.stdin.resume();
            });
        }
    } finally {
        if (server) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
        if (db) await db.closePool();
        if (created && /^shoppc_ops_test_\d+_[a-f0-9]{6}$/.test(database)) await adminConnection.query(`DROP DATABASE \`${database}\``);
        await adminConnection.end();
    }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
