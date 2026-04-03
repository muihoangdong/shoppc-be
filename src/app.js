const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const errorHandler = require('./middlewares/errorHandler');

const productRoutes = require('./routes/productRoutes');
const categoryRoutes = require('./routes/categoryRoutes');
const cartRoutes = require('./routes/cartRoutes');
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const orderRoutes = require('./routes/orderRoutes');

const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Route gốc
app.get('/', (req, res) => {
    res.json({
        success: true,
        message: 'Welcome to ShoPPC API',
        version: '1.0.0',
        endpoints: {
            health: '/health',
            auth: '/api/auth',
            users: '/api/users',
            products: '/api/products',
            categories: '/api/categories',
            cart: '/api/cart',
            orders: '/api/orders'
        },
        documentation: 'https://github.com/shoppc/api-docs',
        timestamp: new Date().toISOString()
    });
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        message: 'Server is running', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        environment: process.env.NODE_ENV || 'development'
    });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/products', productRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/orders', orderRoutes);

// 404 handler cho routes không tồn tại
app.use((req, res) => {
    res.status(404).json({ 
        success: false, 
        message: `Không tìm thấy route: ${req.originalUrl}`,
        available_endpoints: [
            '/',
            '/health',
            '/api/auth',
            '/api/users',
            '/api/products',
            '/api/categories',
            '/api/cart',
            '/api/orders'
        ]
    });
});

// Error handler middleware
app.use(errorHandler);

module.exports = app;