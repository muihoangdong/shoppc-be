'use strict';

/**
 * Định nghĩa linh kiện cho trang Build PC: loại linh kiện (products.part_type) và thông số dùng để kiểm tra
 * tương thích (products.build_specs). Dùng chung cho: kiểm tra dữ liệu khi admin lưu sản phẩm, form admin
 * (GET /api/builder/config trả về bảng này), bộ kiểm tra tương thích và trợ lý AI.
 *
 * Kiểu trường: text | int | bool | enum (một giá trị) | multi (nhiều giá trị, mảng)
 */

const FORM_FACTORS = ['ATX', 'mATX', 'ITX'];
const RAM_TYPES = ['DDR4', 'DDR5'];

const PART_TYPES = [
    {
        key: 'cpu', label: 'CPU (Bộ vi xử lý)', required: true,
        fields: [
            { key: 'socket', label: 'Socket', type: 'text', required: true, example: 'LGA1700, LGA1851, AM5, AM4' },
            { key: 'tdp_w', label: 'Công suất TDP (W)', type: 'int', required: true, min: 1, max: 500 },
            { key: 'igpu', label: 'Có nhân đồ họa tích hợp', type: 'bool', required: true },
            { key: 'cores', label: 'Số nhân', type: 'int', min: 1, max: 256 }
        ]
    },
    {
        key: 'mainboard', label: 'Mainboard (Bo mạch chủ)', required: true,
        fields: [
            { key: 'socket', label: 'Socket', type: 'text', required: true, example: 'LGA1700, AM5' },
            { key: 'ram_type', label: 'Loại RAM', type: 'enum', options: RAM_TYPES, required: true },
            { key: 'form_factor', label: 'Kích thước', type: 'enum', options: FORM_FACTORS, required: true },
            { key: 'ram_slots', label: 'Số khe RAM', type: 'int', min: 1, max: 16 },
            { key: 'm2_slots', label: 'Số khe M.2', type: 'int', min: 0, max: 10 }
        ]
    },
    {
        key: 'ram', label: 'RAM', required: true,
        fields: [
            { key: 'ram_type', label: 'Loại RAM', type: 'enum', options: RAM_TYPES, required: true },
            { key: 'capacity_gb', label: 'Tổng dung lượng (GB)', type: 'int', required: true, min: 1, max: 1024 },
            { key: 'modules', label: 'Số thanh trong bộ', type: 'int', min: 1, max: 8 }
        ]
    },
    {
        key: 'vga', label: 'Card đồ họa (VGA)', required: false,
        fields: [
            { key: 'tdp_w', label: 'Công suất (W)', type: 'int', required: true, min: 1, max: 1000 },
            { key: 'length_mm', label: 'Chiều dài (mm)', type: 'int', min: 50, max: 500 },
            { key: 'vram_gb', label: 'VRAM (GB)', type: 'int', min: 1, max: 128 }
        ]
    },
    {
        key: 'storage', label: 'Ổ cứng (SSD/HDD)', required: true,
        fields: [
            { key: 'interface', label: 'Chuẩn kết nối', type: 'enum', options: ['NVMe', 'SATA'], required: true },
            { key: 'capacity_gb', label: 'Dung lượng (GB)', type: 'int', required: true, min: 1, max: 100000 }
        ]
    },
    {
        key: 'psu', label: 'Nguồn (PSU)', required: true,
        fields: [
            { key: 'wattage_w', label: 'Công suất (W)', type: 'int', required: true, min: 100, max: 3000 }
        ]
    },
    {
        key: 'case', label: 'Vỏ máy (Case)', required: true,
        fields: [
            { key: 'form_factors', label: 'Hỗ trợ mainboard', type: 'multi', options: FORM_FACTORS, required: true },
            { key: 'max_gpu_length_mm', label: 'VGA dài tối đa (mm)', type: 'int', min: 100, max: 600 }
        ]
    },
    {
        key: 'cooler', label: 'Tản nhiệt CPU', required: false,
        fields: [
            { key: 'sockets', label: 'Socket hỗ trợ (cách nhau bởi dấu phẩy)', type: 'multi', required: true, example: 'LGA1700, LGA1851, AM5' },
            { key: 'tdp_rating_w', label: 'Tản được tối đa (W)', type: 'int', min: 1, max: 500 }
        ]
    }
];

const PART_KEYS = PART_TYPES.map((p) => p.key);
const partDef = (key) => PART_TYPES.find((p) => p.key === key);

/** Chuẩn hóa socket để so sánh: "lga 1700" == "LGA1700" */
const normSocket = (s) => String(s || '').replace(/[\s_-]+/g, '').toUpperCase();

/**
 * Kiểm tra + chuẩn hóa build_specs theo loại linh kiện. Ném lỗi (qua `fail`) nếu sai.
 * Trả về object chỉ gồm các trường đã định nghĩa.
 */
function parseBuildSpecs(partType, raw, fail) {
    const def = partDef(partType);
    if (!def) fail('Loại linh kiện không hợp lệ');
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const out = {};
    for (const f of def.fields) {
        let val = src[f.key];
        const empty = val === undefined || val === null || val === '' || (Array.isArray(val) && val.length === 0);
        if (empty) {
            if (f.required) fail(`Thiếu thông số "${f.label}" của ${def.label}`);
            continue;
        }
        if (f.type === 'int') {
            const n = Number(val);
            if (!Number.isInteger(n) || n < (f.min ?? 0) || n > (f.max ?? 1e9)) fail(`"${f.label}" phải là số nguyên từ ${f.min ?? 0} đến ${f.max ?? 1e9}`);
            val = n;
        } else if (f.type === 'bool') {
            if (val === 'true' || val === 1) val = true;
            if (val === 'false' || val === 0) val = false;
            if (typeof val !== 'boolean') fail(`"${f.label}" phải là có/không`);
        } else if (f.type === 'enum') {
            const hit = f.options.find((o) => o.toLowerCase() === String(val).trim().toLowerCase());
            if (!hit) fail(`"${f.label}" phải là một trong: ${f.options.join(', ')}`);
            val = hit;
        } else if (f.type === 'multi') {
            const list = (Array.isArray(val) ? val : String(val).split(',')).map((x) => String(x).trim()).filter(Boolean);
            if (!list.length || list.length > 20) fail(`"${f.label}" không hợp lệ`);
            if (f.options) {
                const mapped = list.map((x) => f.options.find((o) => o.toLowerCase() === x.toLowerCase()));
                if (mapped.some((x) => !x)) fail(`"${f.label}" chỉ nhận: ${f.options.join(', ')}`);
                val = [...new Set(mapped)];
            } else {
                val = [...new Set(list.map((x) => x.slice(0, 30)))];
            }
        } else {
            val = String(val).trim().slice(0, 50);
            if (!val) fail(`Thiếu thông số "${f.label}" của ${def.label}`);
        }
        out[f.key] = val;
    }
    return out;
}

module.exports = { PART_TYPES, PART_KEYS, FORM_FACTORS, RAM_TYPES, partDef, normSocket, parseBuildSpecs };
