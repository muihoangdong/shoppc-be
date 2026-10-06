const ReviewModel = require('../models/ProductReview');
const UserModel = require('../models/User');
const Reviews = require('../services/reviews');
const Events = require('../realtime/events');
const v = require('../utils/validate');
const { sendError } = require('../utils/http');

const PAGE_SIZE = 5;
const ADMIN_PAGE_SIZE = 20;
const STATUSES = ['visible', 'hidden'];

const pageOf = (q, size) => {
    const page = Math.max(parseInt(q?.page, 10) || 1, 1);
    return { page, limit: size, offset: (page - 1) * size };
};
const ratingFilter = (x) => (x === undefined || x === '' ? undefined : v.int(x, 'Số sao', { min: 1, max: 5 }));

/** Khách đang đăng nhập có được đánh giá sản phẩm này không (kèm đánh giá cũ nếu có). */
async function viewerState(productId, reqUser) {
    if (!reqUser) return { logged_in: false, can_review: false, reason: Reviews.REASONS.login, code: 'login', order_id: null, my_review: null };
    const user = await UserModel.getUserById(reqUser.id);
    const [purchases, mine] = await Promise.all([
        ReviewModel.purchasesOf(productId, reqUser.id, user?.email),
        ReviewModel.mine(productId, reqUser.id)
    ]);
    return { logged_in: true, ...Reviews.eligibility(purchases), my_review: mine };
}

const publicViewer = ({ order_id, ...rest }) => rest; // không cần gửi mã đơn cho trình duyệt

class ReviewController {
    // ───── Khách ─────
    /** GET /api/reviews/product/:productId?page=&rating= — công khai; đăng nhập thì kèm quyền đánh giá. */
    static async listForProduct(req, res) {
        try {
            const productId = v.idParam(req.params.productId, 'Mã sản phẩm');
            const { page, limit, offset } = pageOf(req.query, PAGE_SIZE);
            const rating = ratingFilter(req.query?.rating);
            const [summary, items, viewer] = await Promise.all([
                ReviewModel.summary(productId),
                ReviewModel.listVisible(productId, { limit, offset, rating }),
                viewerState(productId, req.user)
            ]);
            const total = rating ? summary.distribution[rating] : summary.count;
            res.json({
                success: true,
                data: { summary, items, page, pages: Math.max(Math.ceil(total / limit), 1), viewer: publicViewer(viewer) }
            });
        } catch (error) {
            sendError(res, error);
        }
    }

    /** POST /api/reviews/product/:productId — gửi hoặc sửa đánh giá của mình. */
    static async submit(req, res) {
        try {
            const productId = v.idParam(req.params.productId, 'Mã sản phẩm');
            const data = Reviews.parseReview(req.body);
            const viewer = await viewerState(productId, req.user);
            if (!viewer.can_review) return res.status(403).json({ success: false, message: viewer.reason, code: viewer.code });

            const review = await ReviewModel.upsert({ productId, userId: req.user.id, orderId: viewer.order_id, ...data });
            Events.reviewChanged(review);
            const isNew = !viewer.my_review;
            res.status(isNew ? 201 : 200).json({
                success: true,
                message: isNew ? 'Cảm ơn bạn đã đánh giá sản phẩm!' : 'Đã cập nhật đánh giá của bạn',
                data: { review, summary: await ReviewModel.summary(productId) }
            });
        } catch (error) {
            sendError(res, error);
        }
    }

    /** DELETE /api/reviews/product/:productId/mine */
    static async removeMine(req, res) {
        try {
            const productId = v.idParam(req.params.productId, 'Mã sản phẩm');
            if (!(await ReviewModel.removeMine(productId, req.user.id))) {
                return res.status(404).json({ success: false, message: 'Bạn chưa đánh giá sản phẩm này' });
            }
            Events.reviewChanged(null);
            res.json({ success: true, message: 'Đã xóa đánh giá của bạn', data: { summary: await ReviewModel.summary(productId) } });
        } catch (error) {
            sendError(res, error);
        }
    }

    // ───── Nhân viên / admin ─────
    static async adminList(req, res) {
        try {
            const q = req.query || {};
            const { page, limit, offset } = pageOf(q, ADMIN_PAGE_SIZE);
            const status = q.status ? v.oneOf(q.status, 'Trạng thái', STATUSES) : undefined;
            const search = typeof q.search === 'string' ? q.search.trim().slice(0, 100) : '';
            const result = await ReviewModel.adminList({ status, rating: ratingFilter(q.rating), search, limit, offset });
            res.json({
                success: true,
                data: result.items,
                meta: { page, limit, total: result.total, pages: Math.max(Math.ceil(result.total / limit), 1), counts: result.counts }
            });
        } catch (error) {
            sendError(res, error);
        }
    }

    /** PATCH /api/reviews/:id — ẩn/hiện và/hoặc trả lời đánh giá. */
    static async update(req, res) {
        try {
            const id = v.idParam(req.params.id);
            const b = req.body && typeof req.body === 'object' ? req.body : {};
            if (b.status === undefined && b.admin_reply === undefined) v.fail('Không có gì để cập nhật');
            const status = b.status === undefined ? undefined : v.oneOf(b.status, 'Trạng thái', STATUSES);
            const reply = b.admin_reply === undefined ? undefined : Reviews.parseReply(b.admin_reply);

            const review = await ReviewModel.getById(id);
            if (!review) return res.status(404).json({ success: false, message: 'Không tìm thấy đánh giá' });
            if (status !== undefined) await ReviewModel.setStatus(id, status);
            if (reply !== undefined) await ReviewModel.setReply(id, reply);
            Events.reviewChanged(review);
            res.json({ success: true, message: 'Đã cập nhật đánh giá', data: await ReviewModel.getById(id) });
        } catch (error) {
            sendError(res, error);
        }
    }

    static async remove(req, res) {
        try {
            const id = v.idParam(req.params.id);
            if (!(await ReviewModel.remove(id))) return res.status(404).json({ success: false, message: 'Không tìm thấy đánh giá' });
            Events.reviewChanged(null);
            res.json({ success: true, message: 'Đã xóa đánh giá' });
        } catch (error) {
            sendError(res, error);
        }
    }
}

module.exports = ReviewController;
