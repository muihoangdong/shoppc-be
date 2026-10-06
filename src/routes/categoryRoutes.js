const express = require('express');
const CategoryController = require('../controllers/categoryController');
const { authenticate, authorizeStaff, authorizeAdmin } = require('../middlewares/auth');

const router = express.Router();

router.get('/', CategoryController.getAllCategories);
router.get('/:id', CategoryController.getCategoryById);
// Ghi dữ liệu: bắt buộc đăng nhập. Xóa chỉ dành cho admin.
router.post('/', authenticate, authorizeStaff, CategoryController.createCategory);
router.put('/:id', authenticate, authorizeStaff, CategoryController.updateCategory);
router.delete('/:id', authenticate, authorizeAdmin, CategoryController.deleteCategory);

module.exports = router;