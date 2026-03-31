const express = require('express');
const CartController = require('../controllers/cartController');

const router = express.Router();

router.get('/', CartController.getCart);
router.post('/add', CartController.addToCart);
router.put('/update', CartController.updateCartItem);
router.delete('/remove/:product_id', CartController.removeFromCart);
router.delete('/clear', CartController.clearCart);
router.get('/check-stock', CartController.checkStock);

module.exports = router;