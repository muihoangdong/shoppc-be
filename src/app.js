const express = require('express');
const bodyParser = require('body-parser');
const errorHandler = require('./middlewares/errorHandler');
const { securityHeaders, corsMiddleware, hideServerErrors } = require('./middlewares/security');
const requestLog = require('./middlewares/requestLog');
const db = require('./config/database');

const productRoutes = require('./routes/productRoutes');
const categoryRoutes = require('./routes/categoryRoutes');
const cartRoutes = require('./routes/cartRoutes');
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const orderRoutes = require('./routes/orderRoutes');
const chatRoutes = require('./routes/chatRoutes');
const realtimeRoutes = require('./routes/realtimeRoutes');
const supportRoutes = require('./routes/supportRoutes');
const aiRoutes = require('./routes/aiRoutes');
const builderRoutes = require('./routes/builderRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const couponRoutes = require('./routes/couponRoutes');
const { hub } = require('./realtime/hub');

const app = express();

// Phía sau proxy (Render, Nginx...) cần trust proxy để req.ip là IP thật của người dùng (giới hạn tần suất).
// Đặt TRUST_PROXY=0 để tắt, hoặc số lượng proxy (mặc định 1 khi NODE_ENV=production).
const trustProxy = process.env.TRUST_PROXY !== undefined
    ? (Number.isNaN(Number(process.env.TRUST_PROXY)) ? process.env.TRUST_PROXY : Number(process.env.TRUST_PROXY))
    : (process.env.NODE_ENV === 'production' ? 1 : false);
app.set('trust proxy', trustProxy);
app.disable('x-powered-by');

// Middleware
app.use(requestLog);
app.use(securityHeaders);
app.use(corsMiddleware());
app.use(hideServerErrors);
app.use(bodyParser.json({ limit: '100kb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '100kb' }));

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
            orders: '/api/orders',
            chat: '/api/chat'
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
        environment: process.env.NODE_ENV || 'development',
        realtime: hub.stats()
    });
});

// Kiểm tra sẵn sàng: có kết nối được database không (dùng cho health check của nơi deploy)
app.get('/health/ready', async (req, res) => {
    try {
        await db.query('SELECT 1');
        res.json({ status: 'READY', database: 'up', timestamp: new Date().toISOString() });
    } catch (error) {
        console.error('Readiness check failed:', error.message);
        res.status(503).json({ status: 'NOT_READY', database: 'down', timestamp: new Date().toISOString() });
    }
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/products', productRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/realtime', realtimeRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/builder', builderRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/coupons', couponRoutes);

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
            '/api/orders',
            '/api/chat'
        ]
    });
});

// Error handler middleware
app.use(errorHandler);

module.exports = app;