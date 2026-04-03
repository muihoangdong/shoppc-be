const dotenv = require('dotenv');
const app = require('./src/app');
const { testConnection } = require('./src/config/database');

dotenv.config();

const PORT = process.env.PORT || 3000;

// Kiểm tra kết nối database trước khi khởi động server
const startServer = async () => {
    console.log('🔌 Checking database connection...');
    
    const dbConnected = await testConnection();
    if (!dbConnected) {
        console.error('❌ Cannot start server: Database connection failed');
        process.exit(1);
    }
    
    app.listen(PORT, () => {
        console.log(`\n🚀 Server is running on port ${PORT}`);
        console.log(`📝 Health check: http://localhost:${PORT}/health`);
        console.log(`🔐 Auth API: http://localhost:${PORT}/api/auth`);
        console.log(`👥 Users API: http://localhost:${PORT}/api/users`);
        console.log(`📦 Products API: http://localhost:${PORT}/api/products`);
        console.log(`📂 Categories API: http://localhost:${PORT}/api/categories`);
        console.log(`🛒 Cart API: http://localhost:${PORT}/api/cart`);
        console.log(`📋 Orders API: http://localhost:${PORT}/api/orders`);
        console.log(`\n✨ Ready to accept requests!\n`);
    });
};

startServer();