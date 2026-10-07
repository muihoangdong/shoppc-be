'use strict';

/**
 * Hub realtime dùng Server-Sent Events (SSE), không cần thư viện ngoài.
 *
 * Kênh (channel):
 *   staff            tất cả nhân viên/admin đang mở dashboard
 *   user:<id>        một tài khoản đăng nhập
 *   visitor:<id>     một khách ẩn danh (chat hỗ trợ)
 *   public           mọi người đang kết nối (dùng cho trạng thái "nhân viên đang trực tuyến")
 *
 * Lưu trong bộ nhớ của tiến trình. Nếu chạy nhiều instance backend, hãy thay lớp này bằng Redis Pub/Sub
 * (giữ nguyên giao diện add/publish/countStaffOnline).
 */

const HEARTBEAT_MS = 25 * 1000; // giữ kết nối sống qua proxy (Render, Nginx đều cắt kết nối im lặng)
const MAX_BUFFERED_BYTES = 1024 * 1024; // client đọc quá chậm thì ngắt, tránh tốn bộ nhớ

class Hub {
    constructor({ heartbeatMs = HEARTBEAT_MS, maxClients = 5000, maxPerIdentity = 6 } = {}) {
        this.clients = new Set();
        this.seq = 0;
        this.maxClients = maxClients;
        this.maxPerIdentity = maxPerIdentity;
        this.timer = setInterval(() => this.heartbeat(), heartbeatMs);
        this.timer.unref();
    }

    /** Mở luồng SSE trên `res`. Trả về client, hoặc null nếu đã quá giới hạn kết nối. */
    add({ req, res, channels, identity }) {
        if (this.clients.size >= this.maxClients) return null;

        // Mỗi danh tính (một user/khách) chỉ giữ tối đa N kết nối: ngắt kết nối cũ nhất (người dùng mở nhiều tab)
        const key = `${identity.type}:${identity.id}`;
        const mine = [...this.clients].filter((c) => c.key === key);
        while (mine.length >= this.maxPerIdentity) this.remove(mine.shift(), true);

        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no' // tắt đệm của Nginx để sự kiện đến ngay
        });
        res.write('retry: 3000\n\n');

        const client = { id: ++this.seq, res, key, identity, channels: new Set(channels) };
        this.clients.add(client);

        const onClose = () => this.remove(client);
        if (req && typeof req.on === 'function') req.on('close', onClose);
        if (typeof res.on === 'function') res.on('close', onClose);

        this.send(client, 'ready', { client_id: client.id, channels: [...client.channels].filter((c) => c !== 'public') });
        this.broadcastPresence();
        return client;
    }

    remove(client, end = false) {
        if (!client || !this.clients.has(client)) return;
        this.clients.delete(client);
        if (end) {
            try { client.res.end(); } catch { /* đã đóng */ }
        }
        this.broadcastPresence();
    }

    /** Ghi một sự kiện cho một client. Trả về true nếu gửi thành công. */
    send(client, event, data) {
        try {
            client.res.write(`id: ${++this.seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            if (client.res.writableLength > MAX_BUFFERED_BYTES) {
                this.remove(client, true);
                return false;
            }
            return true;
        } catch {
            this.remove(client);
            return false;
        }
    }

    /** Gửi sự kiện tới mọi client đang ở kênh `channel`. Trả về số client nhận. */
    publish(channel, event, data = {}) {
        let n = 0;
        for (const client of [...this.clients]) {
            if (client.channels.has(channel) && this.send(client, event, data)) n += 1;
        }
        return n;
    }

    /** Số NHÂN VIÊN (không phải số tab) đang trực tuyến. */
    countStaffOnline() {
        return new Set([...this.clients].filter((c) => c.identity.type === 'staff').map((c) => c.identity.id)).size;
    }

    broadcastPresence() {
        const staff_online = this.countStaffOnline();
        if (staff_online === this.lastPresence) return;
        this.lastPresence = staff_online;
        this.publish('public', 'presence', { staff_online });
    }

    heartbeat() {
        for (const client of [...this.clients]) {
            try {
                client.res.write(': ping\n\n');
            } catch {
                this.remove(client);
            }
        }
    }

    stats() {
        return { connections: this.clients.size, staff_online: this.countStaffOnline() };
    }

    /** Dùng khi tắt server: báo client kết nối lại sau và đóng toàn bộ luồng. */
    closeAll() {
        for (const client of [...this.clients]) {
            try {
                client.res.write('event: shutdown\ndata: {}\n\n');
                client.res.end();
            } catch { /* bỏ qua */ }
            this.clients.delete(client);
        }
    }

    dispose() {
        clearInterval(this.timer);
        this.closeAll();
    }
}

module.exports = { Hub, hub: new Hub(), HEARTBEAT_MS };
