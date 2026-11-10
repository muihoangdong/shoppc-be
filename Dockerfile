# Backend Shoppc — image production
FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# Cài thư viện trước để tận dụng cache khi chỉ đổi code
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# Thư mục upload cần ghi được khi chạy bằng user node.
RUN mkdir -p /app/uploads/products && chown -R node:node /app/uploads

# Không chạy bằng root
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-3000}/health >/dev/null || exit 1

CMD ["node", "server.js"]
