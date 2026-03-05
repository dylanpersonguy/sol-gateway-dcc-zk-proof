FROM node:20-alpine AS builder

WORKDIR /app
COPY monitoring/package.json ./
RUN npm install
COPY tsconfig.base.json /tsconfig.base.json
COPY monitoring/tsconfig.json ./
COPY monitoring/src/ ./src/
RUN npx tsc || true

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY monitoring/package.json ./

RUN addgroup -g 1001 bridge && adduser -u 1001 -G bridge -s /bin/sh -D bridge
RUN mkdir -p /app/logs && chown -R bridge:bridge /app/logs
USER bridge

EXPOSE 9091
CMD ["node", "dist/main.js"]
