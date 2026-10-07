const dns = require('dns');
const net = require('net');
const dotenv = require('dotenv');
const app = require('./src/app');
const { testConnection, closePool } = require('./src/config/database');
const { runStartupChecks } = require('./src/config/startupChecks');
const { hub } = require('./src/realtime/hub');
const supportService = require('./src/services/support/supportService');
const { describe: aiDescribe } = require('./src/services/ai/anthropic');
const mailer = require('./src/services/mailer');
const { getBankAccount } = require('./src/services/bankSettings');

dotenv.config();

// Mạng có IPv6 hỏng (hay gặp trên Windows + Node 20+) làm fetch tới Google/Anthropic bị quá thời gian hoặc "fetch failed".
// Ưu tiên IPv4 và cho thêm thời gian thử từng địa chỉ. Đặt DNS_RESULT_ORDER=verbatim để giữ hành vi mặc định của Node.
if (process.env.DNS_RESULT_ORDER !== 'verbatim' && typeof dns.setDefaultResultOrder === 'function') dns.setDefaultResultOrder('ipv4first');
if (typeof net.setDefaultAutoSelectFamilyAttemptTimeout === 'function') {
    net.setDefaultAutoSelectFamilyAttemptTimeout(Number(process.env.NET_FAMILY_TIMEOUT_MS) || 1000);
}

const PORT = process.env.PORT || 3000;
let server = null;
let shuttingDown = false;

/**
 * Tắt server êm khi nơi deploy gửi SIGTERM (Render/Docker khi deploy bản mới):
 * ngừng nhận request mới, báo client realtime kết nối lại sau, hủy lượt AI đang chờ, đóng pool database.
 */
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal}: đang tắt server…`);
    const force = setTimeout(() => {
        console.error('Quá 10 giây chưa tắt xong, buộc dừng.');
        process.exit(1);
    }, 10000);
    force.unref();
    try {
        hub.closeAll(); // SSE là kết nối mở lâu: phải đóng thì server.close() mới xong
        supportService.shutdown();
        if (server) await new Promise((resolve) => server.close(resolve));
        await closePool();
        console.log('Đã tắt server.');
        process.exit(0);
    } catch (error) {
        console.error('Lỗi khi tắt server:', error.message);
        process.exit(1);
    }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
    console.error('Promise bị từ chối mà không được xử lý:', reason);
});

// Kiểm tra kết nối database trước khi khởi động server
const startServer = async () => {
    console.log('🔌 Checking database connection...');

    const dbConnected = await testConnection();
    if (!dbConnected) {
        console.error('❌ Cannot start server: Database connection failed');
        process.exit(1);
    }

    try {
        await runStartupChecks();
    } catch (error) {
        console.error(`❌ Cannot start server: ${error.message}`);
        process.exit(1);
    }

    server = app.listen(PORT, () => {
        console.log(`\n🚀 Server is running on port ${PORT}`);
        console.log(`📝 Health check: http://localhost:${PORT}/health (sẵn sàng: /health/ready)`);
        console.log(`📦 API: http://localhost:${PORT}/api`);
        console.log(`📡 Realtime (SSE): http://localhost:${PORT}/api/realtime/stream`);
        console.log(`💬 Chat hỗ trợ khách hàng: http://localhost:${PORT}/api/support`);
        console.log(`🤖 AI: ${aiDescribe()}`);
        console.log(mailer.isConfigured()
            ? `📧 Email: gửi qua ${process.env.SMTP_HOST} (${process.env.SMTP_USER})`
            : '📧 Email: CHƯA cấu hình SMTP → mã OTP hiện ngay trên trang đăng ký. Gửi email thật: điền SMTP trong .env, kiểm tra bằng "npm run mail-check"');
        getBankAccount()
            .then((bank) => console.log(bank
                ? `💳 Chuyển khoản VietQR: ${bank.bank_name} ${bank.account_no} — ${bank.account_name} (${bank.source === 'settings' ? 'nhập trong admin' : 'từ .env'})`
                : '💳 Chuyển khoản VietQR: CHƯA có tài khoản nhận tiền → vào admin → Cài đặt → "Thanh toán chuyển khoản" để nhập'))
            .catch(() => {})
            .finally(() => console.log(`\n✨ Ready to accept requests!\n`));
    });
    // Kết nối SSE mở lâu: không để Node tự cắt sau 5 phút mặc định
    server.requestTimeout = 0;
    server.headersTimeout = 65 * 1000;
    server.keepAliveTimeout = 61 * 1000;
};

startServer();
