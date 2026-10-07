const express = require('express');
const ProductController = require('../controllers/productController');
const { authenticate, authorizeStaff, authorizeAdmin } = require('../middlewares/auth');

const router = express.Router();

router.get('/', ProductController.getAllProducts);
router.get('/type/:type', ProductController.getProductsByType);
router.get('/category/:categoryId', ProductController.getProductsByCategory);
router.get('/:id', ProductController.getProductById);
// Ghi dữ liệu: bắt buộc đăng nhập. Xóa chỉ dành cho admin.
router.post('/', authenticate, authorizeStaff, ProductController.createProduct);
router.put('/:id', authenticate, authorizeStaff, ProductController.updateProduct);
router.patch('/:id/stock', authenticate, authorizeStaff, ProductController.updateStock);
router.delete('/:id', authenticate, authorizeAdmin, ProductController.deleteProduct);

module.exports = router;
