const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

// Cấu hình SSL/TLS bắt buộc - Đã được cài đặt sẵn
const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'password',
    database: process.env.DB_NAME || 'shoppc',
    
    // ========== CẤU HÌNH SSL/TLS ==========
    // BẮT BUỘC SSL/TLS cho tất cả kết nối
    ssl: {
        rejectUnauthorized: false, // Chấp nhận self-signed certificate (ssl-cert-snakeoil)
        // Hoặc có thể dùng rejectUnauthorized: true cho production với certificate hợp lệ
    },
    // ======================================
    
    // Connection pool settings
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
});

// Kiểm tra và log SSL status khi kết nối
pool.on('connect', (client) => {
    console.log('✓ Connected to PostgreSQL database');
    
    // Kiểm tra SSL đã active
    if (client.connectionParameters.ssl) {
        console.log('✓ SSL/TLS encryption is ACTIVE');
        console.log('✓ SSL Mode: Required');
    } else {
        console.warn('⚠ WARNING: SSL/TLS is NOT active!');
    }
});

pool.on('error', (err) => {
    console.error('Database error:', err.message);
    
    // Xử lý lỗi SSL cụ thể
    if (err.message.includes('SSL')) {
        console.error('\n❌ SSL/TLS Connection Error:');
        console.error('Please ensure PostgreSQL is configured with:');
        console.error('  - ssl = on in postgresql.conf');
        console.error('  - SSL certificates exist at:');
        console.error('    * /etc/ssl/certs/ssl-cert-snakeoil.pem');
        console.error('    * /etc/ssl/private/ssl-cert-snakeoil.key');
        console.error('  - pg_hba.conf has: hostssl all all 0.0.0.0/0 md5');
    }
});

// Query wrapper
const query = async (text, params) => {
    const start = Date.now();
    try {
        const res = await pool.query(text, params);
        const duration = Date.now() - start;
        if (process.env.NODE_ENV === 'development' && duration > 100) {
            console.log(`Query executed in ${duration}ms`);
        }
        return res;
    } catch (error) {
        console.error('Query error:', { text, error: error.message });
        throw error;
    }
};

// Transaction helper
const getClient = async () => {
    const client = await pool.connect();
    const query = client.query.bind(client);
    const release = client.release.bind(client);
    
    client.query = query;
    client.release = release;
    return client;
};

// Kiểm tra kết nối với SSL
const testConnection = async () => {
    try {
        const client = await pool.connect();
        
        // Kiểm tra SSL connection status
        const sslStatus = await client.query(`
            SELECT 
                ssl_is_used() as ssl_used,
                ssl_version() as ssl_version,
                ssl_cipher() as ssl_cipher,
                inet_server_addr() as server_address,
                inet_server_port() as server_port,
                version() as postgres_version,
                NOW() as server_time
        `);
        
        const sslUsed = sslStatus.rows[0].ssl_used === 't';
        
        console.log('\n╔════════════════════════════════════════╗');
        console.log('║     PostgreSQL Connection Status      ║');
        console.log('╚════════════════════════════════════════╝');
        console.log(`✓ Connection: SUCCESS`);
        console.log(`✓ SSL/TLS: ${sslUsed ? 'ENABLED ✅' : 'DISABLED ❌'}`);
        
        if (sslUsed) {
            console.log(`✓ SSL Version: ${sslStatus.rows[0].ssl_version}`);
            console.log(`✓ SSL Cipher: ${sslStatus.rows[0].ssl_cipher}`);
        }
        
        console.log(`✓ Server: ${sslStatus.rows[0].server_address}:${sslStatus.rows[0].server_port}`);
        console.log(`✓ PostgreSQL Version: ${sslStatus.rows[0].postgres_version}`);
        console.log(`✓ Server Time: ${sslStatus.rows[0].server_time}`);
        console.log('=========================================\n');
        
        client.release();
        return true;
    } catch (error) {
        console.error('\n❌ PostgreSQL connection failed:', error.message);
        
        if (error.message.includes('no pg_hba.conf entry')) {
            console.error('\n🔧 SOLUTION: Add to pg_hba.conf:');
            console.error('   hostssl all all 0.0.0.0/0 md5');
            console.error('   hostssl all all ::/0 md5');
        } else if (error.message.includes('SSL')) {
            console.error('\n🔧 SSL/TLS Configuration Required:');
            console.error('1. Edit postgresql.conf:');
            console.error('   ssl = on');
            console.error('   ssl_cert_file = \'/etc/ssl/certs/ssl-cert-snakeoil.pem\'');
            console.error('   ssl_key_file = \'/etc/ssl/private/ssl-cert-snakeoil.key\'');
            console.error('\n2. Edit pg_hba.conf:');
            console.error('   hostssl all all 0.0.0.0/0 md5');
            console.error('   hostssl all all ::/0 md5');
            console.error('\n3. Restart PostgreSQL:');
            console.error('   sudo systemctl restart postgresql');
        } else if (error.code === 'ECONNREFUSED') {
            console.error('\n🔧 Cannot connect to PostgreSQL:');
            console.error('   - Check if PostgreSQL is running: sudo systemctl status postgresql');
            console.error('   - Check host and port configuration');
        }
        
        return false;
    }
};

// Đóng pool
const closePool = async () => {
    await pool.end();
    console.log('Database pool closed');
};

// Export các hàm
module.exports = {
    query,
    getClient,
    testConnection,
    closePool,
    pool
};