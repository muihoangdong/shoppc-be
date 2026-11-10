'use strict';
const db = require('../config/database');
const mailer = require('./mailer');
let timer = null, running = null;

async function processBatch() {
    if (!mailer.isConfigured()) return { sent: 0 };
    const client = await db.getClient();
    let locked = false, sent = 0;
    try {
        // Same database shares one sender, including when deployed with multiple Node processes.
        const [locks] = await client.query("SELECT GET_LOCK(CONCAT('stock_alert:', LEFT(SHA2(DATABASE(),256),40)), 0) AS acquired");
        locked = Number(locks[0].acquired) === 1;
        if (!locked) return { sent: 0 };
        const [alerts] = await client.query(`SELECT a.user_id, a.product_id, p.name AS product_name, u.email, u.full_name AS name
            FROM stock_alerts a JOIN products p ON p.id = a.product_id JOIN users u ON u.id = a.user_id
            WHERE a.status = 'pending' AND p.stock > 0 AND u.status = 'active'
            AND (a.next_attempt_at IS NULL OR a.next_attempt_at <= NOW()) ORDER BY a.created_at LIMIT 50`);
        for (const alert of alerts) {
            // Recheck before delivery: subscription may have been cancelled while waiting in this batch.
            const [current] = await client.query(`SELECT a.status FROM stock_alerts a JOIN products p ON p.id = a.product_id
                WHERE a.user_id = ? AND a.product_id = ? AND a.status = 'pending' AND p.stock > 0`, [alert.user_id, alert.product_id]);
            if (!current.length) continue;
            let result;
            try { result = await mailer.sendRestockNotice(alert); }
            catch { result = { delivered: false }; }
            if (result.delivered) {
                await client.query("UPDATE stock_alerts SET status = 'notified', notified_at = NOW(), attempts = attempts + 1 WHERE user_id = ? AND product_id = ? AND status = 'pending'", [alert.user_id, alert.product_id]);
                sent++;
            } else {
                await client.query("UPDATE stock_alerts SET attempts = attempts + 1, next_attempt_at = DATE_ADD(NOW(), INTERVAL 15 MINUTE) WHERE user_id = ? AND product_id = ? AND status = 'pending'", [alert.user_id, alert.product_id]);
            }
        }
        return { sent };
    } finally {
        if (locked) await client.query("SELECT RELEASE_LOCK(CONCAT('stock_alert:', LEFT(SHA2(DATABASE(),256),40)))").catch(() => {});
        client.release();
    }
}

function tick() {
    if (!running) running = processBatch().catch((err) => console.error('[stock-alert] Không xử lý được hàng đợi:', err.message)).finally(() => { running = null; });
    return running;
}
function start() { if (!timer) { void tick(); timer = setInterval(tick, 60000); timer.unref(); } }
async function stop() { if (timer) clearInterval(timer); timer = null; if (running) await running; }
module.exports = { processBatch, start, stop };
