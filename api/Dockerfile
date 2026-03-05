FROM node:22-alpine AS builder

WORKDIR /app
COPY vendor/ ./vendor/
RUN ln -s /app/vendor /vendor
COPY api/package.json ./
RUN npm install
RUN npm install esbuild
COPY tsconfig.base.json /tsconfig.base.json
COPY api/tsconfig.json ./
COPY api/src/ ./src/
# Bundle with esbuild to eliminate CJS/ESM interop issues with @decentralchain
RUN npx esbuild src/main.ts --bundle --platform=node --target=node22 \
    --outfile=dist/main.js --format=cjs \
    --external:snarkjs --external:@solana/* --external:@coral-xyz/* \
    --external:ws --external:prom-client --external:better-sqlite3 \
    2>&1 || npx tsc || true

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY api/package.json ./

RUN addgroup -g 1001 bridge && adduser -u 1001 -G bridge -s /bin/sh -D bridge
RUN mkdir -p /app/logs /app/data && chown -R bridge:bridge /app/logs /app/data
USER bridge

EXPOSE 3000
CMD ["node", "dist/main.js"]
