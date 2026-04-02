const express = require('express');
const ProductController = require('../controllers/productController');

const router = express.Router();

router.get('/', ProductController.getAllProducts);
router.get('/type/:type', ProductController.getProductsByType);
router.get('/category/:categoryId', ProductController.getProductsByCategory);
router.get('/:id', ProductController.getProductById);
router.post('/', ProductController.createProduct);
router.put('/:id', ProductController.updateProduct);
router.patch('/:id/stock', ProductController.updateStock);
router.delete('/:id', ProductController.deleteProduct);

module.exports = router;
