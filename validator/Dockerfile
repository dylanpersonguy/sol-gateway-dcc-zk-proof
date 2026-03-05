FROM node:22-alpine AS builder

WORKDIR /app
COPY vendor/ ./vendor/
RUN ln -s /app/vendor /vendor
COPY validator/package.json ./
RUN npm install
# Fix ESM/CJS interop bug in @decentralchain protobuf import
RUN sed -i "s|import \* as dccProto from '@decentralchain/protobuf-serialization';|import dccProto_raw from '@decentralchain/protobuf-serialization'; const dccProto = dccProto_raw.default \|\| dccProto_raw;|" node_modules/@decentralchain/decentralchain-transactions/dist/index.js 2>/dev/null || true
RUN npm install esbuild
COPY tsconfig.base.json /tsconfig.base.json
COPY validator/tsconfig.json ./
COPY validator/src/ ./src/
# Bundle with esbuild to eliminate CJS/ESM interop issues with @decentralchain
RUN npx esbuild src/main.ts --bundle --platform=node --target=node22 \
    --outfile=dist/main.js --format=cjs \
    --external:snarkjs --external:js-sha3 --external:@solana/* --external:@coral-xyz/* \
    --external:ws --external:prom-client 2>&1 || npx tsc || true

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY validator/package.json ./
COPY validator/proof-worker.js ./proof-worker.js

# ZK build artifacts are mounted via docker-compose volume (zkey is 1.76 GB)
RUN mkdir -p /app/zk/circuits/build/bridge_deposit_js

RUN addgroup -g 1001 bridge && adduser -u 1001 -G bridge -s /bin/sh -D bridge
RUN mkdir -p /app/logs /app/data && chown -R bridge:bridge /app/logs /app/data
USER bridge

EXPOSE 9000 8080 9090
CMD ["node", "dist/main.js"]
