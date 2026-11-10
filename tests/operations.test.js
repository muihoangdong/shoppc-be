'use strict';

const assert = require('node:assert/strict');
const { templateFields, validateSpecs, supplierPayload } = require('../src/services/operationsCatalog');
const { serialNumbers, receiptPayload } = require('../src/services/operationsInventory');
const { refundableMaximum, RETURN_NEXT, SHIP_NEXT } = require('../src/services/operationsAftersales');
const { normalizeRow, csvCell } = require('../src/services/operationsBulk');

const fields = templateFields([{ key: 'Dung lượng', type: 'number', required: true, unit: 'GB' }, { key: 'Chuẩn', type: 'select', options: ['DDR4', 'DDR5'] }]);
validateSpecs(fields, { 'Dung lượng': 16, 'Chuẩn': 'DDR5' });
assert.throws(() => validateSpecs(fields, { 'Dung lượng': -1 }), /không âm/);
assert.throws(() => validateSpecs(fields, {}), /bắt buộc/);
assert.throws(() => validateSpecs(fields, { 'Dung lượng': 16, 'Chuẩn': 'DDR3' }), /cho phép/);
assert.throws(() => templateFields([{ key: 'RAM' }, { key: 'ram' }]), /trùng/);
assert.throws(() => templateFields([{ key: '__proto__' }]), /không được/);
assert.throws(() => supplierPayload({ code: 'NCC 1', name: 'Test' }), /chỉ gồm/);
assert.deepEqual(serialNumbers([' a-1 ', 'B-2']), ['A-1', 'B-2']);
assert.throws(() => serialNumbers(['a', 'A']), /trùng/);
assert.throws(() => receiptPayload({ supplier_id: 1, items: [{ product_id: 1, quantity: 2, unit_cost: 1, serial_numbers: ['A'] }] }), /khớp/);
assert.throws(() => receiptPayload({ supplier_id: 1, items: [{ product_id: 1, quantity: 1, unit_cost: 1 }, { product_id: 1, quantity: 1, unit_cost: 1 }] }), /một dòng/);
assert.equal(refundableMaximum({ subtotal: 1000, discount: 100 }, { price: 333 }, 2), 599);
assert.equal(refundableMaximum({ subtotal: 100, discount: 200 }, { price: 100 }, 1), 0);
assert.deepEqual(RETURN_NEXT.refunded, []);
assert(!SHIP_NEXT.created.includes('delivered'));
assert.equal(csvCell('=HYPERLINK("bad")'), '"\'=HYPERLINK(""bad"")"');
assert.throws(() => normalizeRow({ sku: 'BAD SKU' }), /SKU/);
assert.throws(() => normalizeRow({ sku: 'OK', name: 'Test', category_id: 1, price: 1, stock: 0, specs: '{' }), /JSON/);
console.log('✓ Operations: mẫu thông số, serial, phiếu nhập, giới hạn hoàn tiền, trạng thái và CSV');
