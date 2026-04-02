const express = require('express');
const UserController = require('../controllers/userController');
const { authenticate, authorizeAdmin } = require('../middlewares/auth');

const router = express.Router();

router.post('/login', UserController.login);
router.post('/register', UserController.register);

router.get('/me', authenticate, UserController.getCurrentUser);
router.put('/me', authenticate, UserController.updateCurrentUser);
router.put('/me/password', authenticate, UserController.updatePassword);

router.get('/', authenticate, authorizeAdmin, UserController.getAllUsers);
router.get('/:id', authenticate, authorizeAdmin, UserController.getUserById);
router.put('/:id', authenticate, authorizeAdmin, UserController.updateUser);
router.delete('/:id', authenticate, authorizeAdmin, UserController.deleteUser);

module.exports = router;
