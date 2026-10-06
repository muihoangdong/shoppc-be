'use strict';

/**
 * Kiểm tra tương thích cấu hình PC (hàm thuần, không đụng database).
 *
 * Đầu vào: { cpu: product, mainboard: product, ... } với product = { id, name, price, stock, part_type, build_specs }.
 * Mỗi vấn đề: { level: 'error' | 'warning' | 'info', code, message, parts: ['cpu', 'mainboard'] }
 *   - error   : lắp không được / thiếu linh kiện bắt buộc / hết hàng
 *   - warning : lắp được nhưng không nên (nguồn sát công suất, tản nhiệt yếu...)
 *   - info    : gợi ý thêm
 */

const { PART_TYPES, normSocket } = require('../config/pcParts');

const BASE_POWER_W = 75; // mainboard, RAM, ổ cứng, quạt...
const HEADROOM = 1.3; // nguồn nên dư ~30%
const roundUp50 = (n) => Math.ceil(n / 50) * 50;
const vnd = (n) => `${new Intl.NumberFormat('vi-VN').format(Math.round(Number(n) || 0))}₫`;
const LABEL = Object.fromEntries(PART_TYPES.map((p) => [p.key, p.label.replace(/\s*\(.*\)$/, '')]));

const specsOf = (p) => (p && p.build_specs && typeof p.build_specs === 'object' ? p.build_specs : {});

/** Công suất ước tính và công suất nguồn khuyên dùng. */
function powerEstimate(parts) {
    const cpu = Number(specsOf(parts.cpu).tdp_w) || 0;
    const vga = Number(specsOf(parts.vga).tdp_w) || 0;
    const estimated = cpu + vga + BASE_POWER_W;
    return { estimated_w: estimated, recommended_psu_w: roundUp50(estimated * HEADROOM) };
}

function checkBuild(parts) {
    const issues = [];
    const add = (level, code, message, ps) => issues.push({ level, code, message, parts: ps });
    const has = (k) => !!parts[k];
    const s = Object.fromEntries(Object.keys(parts).map((k) => [k, specsOf(parts[k])]));

    // Linh kiện sai loại / hết hàng
    for (const [type, p] of Object.entries(parts)) {
        if (!p) continue;
        if (p.part_type && p.part_type !== type) add('error', 'wrong_type', `"${p.name}" không phải ${LABEL[type]}.`, [type]);
        if (Number(p.stock) <= 0) add('error', 'out_of_stock', `${LABEL[type]} "${p.name}" đã hết hàng.`, [type]);
    }

    // Thiếu linh kiện bắt buộc
    for (const def of PART_TYPES) {
        if (def.required && !has(def.key)) add('error', 'missing', `Chưa chọn ${LABEL[def.key]}.`, [def.key]);
    }
    if (has('cpu') && s.cpu.igpu === false && !has('vga')) {
        add('error', 'need_vga', `CPU "${parts.cpu.name}" không có nhân đồ họa tích hợp: cần thêm card đồ họa (VGA) để có hình.`, ['cpu', 'vga']);
    }

    // CPU ↔ Mainboard
    if (has('cpu') && has('mainboard') && s.cpu.socket && s.mainboard.socket && normSocket(s.cpu.socket) !== normSocket(s.mainboard.socket)) {
        add('error', 'socket', `CPU dùng socket ${s.cpu.socket} nhưng mainboard là socket ${s.mainboard.socket}.`, ['cpu', 'mainboard']);
    }

    // RAM ↔ Mainboard
    if (has('ram') && has('mainboard')) {
        if (s.ram.ram_type && s.mainboard.ram_type && s.ram.ram_type !== s.mainboard.ram_type) {
            add('error', 'ram_type', `RAM ${s.ram.ram_type} không cắm được vào mainboard hỗ trợ ${s.mainboard.ram_type}.`, ['ram', 'mainboard']);
        }
        const modules = Number(s.ram.modules) || 1;
        if (s.mainboard.ram_slots && modules > Number(s.mainboard.ram_slots)) {
            add('error', 'ram_slots', `Bộ RAM có ${modules} thanh nhưng mainboard chỉ có ${s.mainboard.ram_slots} khe.`, ['ram', 'mainboard']);
        }
    }

    // Mainboard ↔ Vỏ
    if (has('mainboard') && has('case') && s.mainboard.form_factor && Array.isArray(s.case.form_factors)
        && !s.case.form_factors.includes(s.mainboard.form_factor)) {
        add('error', 'form_factor', `Vỏ máy chỉ lắp được mainboard ${s.case.form_factors.join('/')}, mainboard đã chọn là ${s.mainboard.form_factor}.`, ['mainboard', 'case']);
    }

    // VGA ↔ Vỏ
    if (has('vga') && has('case') && s.vga.length_mm && s.case.max_gpu_length_mm && Number(s.vga.length_mm) > Number(s.case.max_gpu_length_mm)) {
        add('error', 'gpu_length', `Card đồ họa dài ${s.vga.length_mm}mm, vỏ máy chỉ chứa được tối đa ${s.case.max_gpu_length_mm}mm.`, ['vga', 'case']);
    }

    // Ổ NVMe ↔ Mainboard
    if (has('storage') && has('mainboard') && s.storage.interface === 'NVMe' && s.mainboard.m2_slots === 0) {
        add('error', 'm2', 'Ổ NVMe cần khe M.2 nhưng mainboard đã chọn không có khe M.2.', ['storage', 'mainboard']);
    }

    // Tản nhiệt ↔ CPU
    if (has('cooler') && has('cpu') && Array.isArray(s.cooler.sockets) && s.cpu.socket
        && !s.cooler.sockets.some((x) => normSocket(x) === normSocket(s.cpu.socket))) {
        add('error', 'cooler_socket', `Tản nhiệt không hỗ trợ socket ${s.cpu.socket} (chỉ hỗ trợ ${s.cooler.sockets.join(', ')}).`, ['cooler', 'cpu']);
    }
    if (has('cooler') && has('cpu') && s.cooler.tdp_rating_w && s.cpu.tdp_w && Number(s.cooler.tdp_rating_w) < Number(s.cpu.tdp_w)) {
        add('warning', 'cooler_weak', `Tản nhiệt chịu tối đa ${s.cooler.tdp_rating_w}W, thấp hơn TDP ${s.cpu.tdp_w}W của CPU: máy dễ nóng khi chạy nặng.`, ['cooler', 'cpu']);
    }
    if (has('cpu') && !has('cooler') && Number(s.cpu.tdp_w) > 65) {
        add('info', 'cooler_hint', `CPU có TDP ${s.cpu.tdp_w}W: nên chọn thêm tản nhiệt rời nếu CPU không kèm sẵn quạt.`, ['cooler']);
    }

    // Nguồn
    const power = powerEstimate(parts);
    if (has('psu') && (has('cpu') || has('vga'))) {
        const w = Number(s.psu.wattage_w) || 0;
        if (w < power.estimated_w) {
            add('error', 'psu_low', `Nguồn ${w}W không đủ: cấu hình cần khoảng ${power.estimated_w}W (nên dùng từ ${power.recommended_psu_w}W).`, ['psu']);
        } else if (w < power.recommended_psu_w) {
            add('warning', 'psu_tight', `Nguồn ${w}W hơi sát: nên dùng từ ${power.recommended_psu_w}W để máy chạy ổn định và bền hơn.`, ['psu']);
        }
    }

    const chosen = Object.entries(parts).filter(([, p]) => p);
    const total = chosen.reduce((sum, [, p]) => sum + Number(p.price || 0), 0);
    const errors = issues.filter((i) => i.level === 'error');
    return {
        items: chosen.map(([type, p]) => ({ type, id: p.id, name: p.name, price: Number(p.price), stock: Number(p.stock), image_url: p.image_url || null })),
        total,
        total_text: vnd(total),
        ...power,
        issues,
        // "chưa chọn" / "cần thêm VGA" là thiếu món, không phải xung đột giữa các món đã chọn
        compatible: !errors.some((i) => i.code !== 'missing' && i.code !== 'need_vga'),
        complete: errors.length === 0
    };
}

/**
 * Đánh dấu từng ứng viên của một loại linh kiện: lắp được với các món đang chọn hay không.
 * Chỉ tính các lỗi liên quan tới chính loại đó (bỏ qua "chưa chọn" món khác).
 */
function markCandidates(type, candidates, selected) {
    return candidates.map((p) => {
        const report = checkBuild({ ...selected, [type]: p });
        const reasons = report.issues
            .filter((i) => i.level === 'error' && i.code !== 'missing' && i.code !== 'need_vga' && i.parts.includes(type))
            .map((i) => i.message);
        return { ...p, compatible: reasons.length === 0, reasons };
    });
}

module.exports = { checkBuild, markCandidates, powerEstimate, BASE_POWER_W, HEADROOM };
