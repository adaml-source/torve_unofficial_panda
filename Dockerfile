FROM node:22-slim

WORKDIR /app

COPY package.json ./
COPY src/ ./src/

RUN mkdir -p /app/.data

EXPOSE 7000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "const http = require('http'); http.get('http://localhost:7000/healthz', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

VOLUME ["/app/.data"]

CMD ["node", "src/server.js"]
