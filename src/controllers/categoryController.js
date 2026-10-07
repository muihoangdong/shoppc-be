const CategoryModel = require('../models/Category');
const v = require('../utils/validate');
const { sendError } = require('../utils/http');
const Events = require('../realtime/events');

const CATEGORY_TYPES = ['pc', 'component', 'peripheral'];

function parseCategory(body, { partial }) {
    const b = body && typeof body === 'object' ? body : {};
    const out = {
        name: v.str(b.name, 'Tên danh mục', { max: 100, optional: partial }),
        type: v.oneOf(b.type, 'Loại danh mục', CATEGORY_TYPES, { optional: partial })
    };
    if ('parent_id' in b) out.parent_id = b.parent_id === null || b.parent_id === '' ? null : v.int(b.parent_id, 'Danh mục cha', { min: 1 });
    Object.keys(out).forEach((k) => out[k] === undefined && delete out[k]);
    if (partial && Object.keys(out).length === 0) v.fail('Không có trường nào cần cập nhật');
    return out;
}

/** Danh mục cha phải tồn tại, không được là chính nó hoặc con cháu của nó (tránh vòng lặp). */
async function checkParent(selfId, parentId) {
    if (!parentId) return;
    let cur = await CategoryModel.getCategoryById(parentId);
    if (!cur) v.fail('Danh mục cha không tồn tại');
    for (let i = 0; cur && i < 50; i += 1) {
        if (selfId !== undefined && cur.id === selfId) v.fail('Danh mục không thể là con của chính nó hoặc của danh mục con của nó');
        cur = cur.parent_id ? await CategoryModel.getCategoryById(cur.parent_id) : null;
    }
}

class CategoryController {
    static async getAllCategories(req, res) {
        try {
            const categories = await CategoryModel.getAllCategories();
            res.json({ success: true, data: categories });
        } catch (error) {
            sendError(res, error);
        }
    }

    static async getCategoryById(req, res) {
        try {
            const category = await CategoryModel.getCategoryById(req.params.id);
            if (!category) return res.status(404).json({ success: false, message: 'Không tìm thấy danh mục' });
            const subCategories = await CategoryModel.getSubCategories(req.params.id);
            res.json({ success: true, data: { ...category, sub_categories: subCategories } });
        } catch (error) {
            sendError(res, error);
        }
    }

    static async createCategory(req, res) {
        try {
            const data = parseCategory(req.body, { partial: false });
            await checkParent(undefined, data.parent_id);
            const id = await CategoryModel.createCategory(data);
            Events.categoryChanged();
            const category = await CategoryModel.getCategoryById(id);
            res.status(201).json({ success: true, message: 'Tạo danh mục thành công', data: category });
        } catch (error) {
            sendError(res, error);
        }
    }

    static async updateCategory(req, res) {
        try {
            const id = v.idParam(req.params.id);
            const data = parseCategory(req.body, { partial: true });
            await checkParent(id, data.parent_id);
            const affectedRows = await CategoryModel.updateCategory(id, data);
            if (affectedRows === 0) return res.status(404).json({ success: false, message: 'Không tìm thấy danh mục' });
            Events.categoryChanged();
            const category = await CategoryModel.getCategoryById(id);
            res.json({ success: true, message: 'Cập nhật danh mục thành công', data: category });
        } catch (error) {
            sendError(res, error);
        }
    }

    static async deleteCategory(req, res) {
        try {
            const affectedRows = await CategoryModel.deleteCategory(v.idParam(req.params.id));
            if (affectedRows === 0) return res.status(404).json({ success: false, message: 'Không tìm thấy danh mục' });
            Events.categoryChanged();
            res.json({ success: true, message: 'Xóa danh mục thành công' });
        } catch (error) {
            // Model ném lỗi tiếng Anh khi danh mục còn con / còn sản phẩm -> dịch thành thông báo rõ ràng
            if (/subcategories/i.test(error.message)) return res.status(409).json({ success: false, message: 'Không thể xóa: danh mục còn danh mục con' });
            if (/products/i.test(error.message)) return res.status(409).json({ success: false, message: 'Không thể xóa: danh mục còn sản phẩm' });
            sendError(res, error);
        }
    }
}

module.exports = CategoryController;
