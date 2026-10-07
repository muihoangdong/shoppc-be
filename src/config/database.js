const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '123456',
    database: process.env.DB_NAME || 'shopdb',

    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,

    // Nếu dùng Render MySQL thì bật SSL
    ssl: process.env.DB_SSL === 'true'
        ? { rejectUnauthorized: false }
        : undefined
});

// Error handler
pool.on('error', (err) => {
    console.error('Unexpected database error:', err);
});

// Test connection
const testConnection = async () => {
    let connection;

    try {
        console.log('🔌 Connecting to MySQL...');

        connection = await pool.getConnection();

        const [rows] = await connection.query(
    'SELECT NOW() AS currentTime, VERSION() AS mysqlVersion'
);

console.log('✅ MySQL connected successfully');
console.log(`   📍 Host: ${process.env.DB_HOST}`);
console.log(`   📅 Time: ${rows[0].currentTime}`);
console.log(`   🐬 Version: ${rows[0].mysqlVersion}`);

        connection.release();
        return true;

    } catch (error) {
        if (connection) connection.release();

        console.error('❌ MySQL connection failed:', error.message);

        console.log('\\n📋 Connection config:');
        console.log(`   Host: ${process.env.DB_HOST}`);
        console.log(`   Port: ${process.env.DB_PORT}`);
        console.log(`   User: ${process.env.DB_USER}`);
        console.log(`   Database: ${process.env.DB_NAME}`);

        return false;
    }
};

// Query helper
const query = async (sql, params = []) => {
    try {
        const [rows] = await pool.query(sql, params);
        return rows;
    } catch (error) {
        console.error('Query error:', error.message);
        throw error;
    }
};

// Transaction helper
const getClient = async () => {
    const connection = await pool.getConnection();
    return connection;
};

// Close pool
const closePool = async () => {
    await pool.end();
    console.log('Database pool closed');
};

module.exports = {
    pool,
    testConnection,
    query,
    getClient,
    closePool
};