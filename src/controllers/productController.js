const ProductModel = require('../models/Product');
const CategoryModel = require('../models/Category');
const v = require('../utils/validate');
const { sendError } = require('../utils/http');
const Events = require('../realtime/events');

const { PART_KEYS, parseBuildSpecs } = require('../config/pcParts');

const CATEGORY_TYPES = ['pc', 'component', 'peripheral'];

/** Chuẩn hóa dữ liệu sản phẩm gửi lên. partial=true: chỉ kiểm tra các trường có mặt (khi cập nhật). */
function parseProduct(body, { partial }) {
    const b = body && typeof body === 'object' ? body : {};
    const out = {
        name: v.str(b.name, 'Tên sản phẩm', { max: 255, optional: partial }),
        price: b.price === undefined && partial ? undefined : v.int(b.price, 'Giá', { min: 0, max: 1e12 }),
        stock: v.int(b.stock === undefined && !partial ? 0 : b.stock, 'Tồn kho', { min: 0, max: 1e7, optional: partial }),
        category_id: v.int(b.category_id, 'Danh mục', { min: 1, optional: partial }),
        description: v.str(b.description, 'Mô tả', { max: 5000, optional: true, allowEmpty: true }),
        image_url: v.imageUrl(b.image_url),
        specs: v.specs(b.specs),
        // Build PC: loại linh kiện ('' / null = không phải linh kiện) + thông số kiểm tra tương thích
        part_type: b.part_type === undefined ? undefined : (b.part_type === '' || b.part_type === null ? null : v.oneOf(b.part_type, 'Loại linh kiện', PART_KEYS)),
        build_specs: b.build_specs
    };
    if (out.part_type === null) out.build_specs = null;
    else if (out.part_type) out.build_specs = parseBuildSpecs(out.part_type, b.build_specs, v.fail);
    else if (b.build_specs !== undefined) out.build_specs = undefined; // thông số không đi kèm loại: xử lý ở updateProduct
    Object.keys(out).forEach((k) => out[k] === undefined && delete out[k]);
    if (partial && Object.keys(out).length === 0 && b.build_specs === undefined) v.fail('Không có trường nào cần cập nhật');
    return out;
}

async function ensureCategory(id) {
    if (id !== undefined && !(await CategoryModel.getCategoryById(id))) v.fail('Danh mục không tồn tại');
}

class ProductController {
    static async getAllProducts(req, res) {
        try {
            // Chỉ nhận giá trị chuỗi/số hợp lệ: chặn dạng ?category_id[a]=1 (object injection vào truy vấn SQL)
            const q = req.query || {};
            const filters = {};
            if (q.category_id !== undefined) filters.category_id = v.int(q.category_id, 'category_id', { min: 1 });
            if (q.type !== undefined) filters.type = v.oneOf(q.type, 'type', CATEGORY_TYPES);
            if (q.search !== undefined) filters.search = v.str(q.search, 'search', { max: 100, allowEmpty: true });
            const products = await ProductModel.getAllProducts(filters);
            res.json({ success: true, data: products });
        } catch (error) {
            sendError(res, error);
        }
    }

    static async getProductById(req, res) {
        try {
            const product = await ProductModel.getProductById(req.params.id);
            if (!product) return res.status(404).json({ success: false, message: 'Không tìm thấy sản phẩm' });
            res.json({ success: true, data: product });
        } catch (error) {
            sendError(res, error);
        }
    }

    static async getProductsByCategory(req, res) {
        try {
            const products = await ProductModel.getProductsByCategory(req.params.categoryId);
            res.json({ success: true, data: products });
        } catch (error) {
            sendError(res, error);
        }
    }

    static async getProductsByType(req, res) {
        try {
            const products = await ProductModel.getProductsByType(req.params.type);
            res.json({ success: true, data: products });
        } catch (error) {
            sendError(res, error);
        }
    }

    static async createProduct(req, res) {
        try {
            const data = parseProduct(req.body, { partial: false });
            await ensureCategory(data.category_id);
            const id = await ProductModel.createProduct(data);
            Events.productChanged([id]);
            const product = await ProductModel.getProductById(id);
            res.status(201).json({ success: true, message: 'Tạo sản phẩm thành công', data: product });
        } catch (error) {
            sendError(res, error);
        }
    }

    static async updateProduct(req, res) {
        try {
            const id = v.idParam(req.params.id);
            const data = parseProduct(req.body, { partial: true });
            // Chỉ gửi thông số mà không gửi loại: kiểm tra theo loại hiện có của sản phẩm
            const body = req.body || {};
            if (body.part_type === undefined && body.build_specs !== undefined) {
                const current = await ProductModel.getProductById(id);
                if (!current) return res.status(404).json({ success: false, message: 'Không tìm thấy sản phẩm' });
                if (!current.part_type) v.fail('Hãy chọn loại linh kiện trước khi nhập thông số Build PC');
                data.build_specs = parseBuildSpecs(current.part_type, body.build_specs, v.fail);
            }
            await ensureCategory(data.category_id);
            const affectedRows = await ProductModel.updateProduct(id, data);
            if (affectedRows === 0) return res.status(404).json({ success: false, message: 'Không tìm thấy sản phẩm' });
            Events.productChanged([id]);
            const product = await ProductModel.getProductById(id);
            res.json({ success: true, message: 'Cập nhật sản phẩm thành công', data: product });
        } catch (error) {
            sendError(res, error);
        }
    }

    static async updateStock(req, res) {
        try {
            const id = v.idParam(req.params.id);
            const quantity = v.int((req.body || {}).quantity, 'Số lượng tồn kho', { min: 0, max: 1e7 });
            const affectedRows = await ProductModel.setStock(id, quantity);
            if (affectedRows === 0) return res.status(404).json({ success: false, message: 'Không tìm thấy sản phẩm' });
            Events.productChanged([id]);
            const product = await ProductModel.getProductById(id);
            res.json({ success: true, message: 'Cập nhật tồn kho thành công', data: product });
        } catch (error) {
            sendError(res, error);
        }
    }

    static async deleteProduct(req, res) {
        try {
            const productId = v.idParam(req.params.id);
            const affectedRows = await ProductModel.deleteProduct(productId);
            if (affectedRows === 0) return res.status(404).json({ success: false, message: 'Không tìm thấy sản phẩm' });
            Events.productChanged([productId]);
            res.json({ success: true, message: 'Xóa sản phẩm thành công' });
        } catch (error) {
            sendError(res, error);
        }
    }
}

module.exports = ProductController;
