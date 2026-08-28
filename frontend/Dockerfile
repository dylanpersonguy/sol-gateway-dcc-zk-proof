FROM node:22-alpine AS builder

WORKDIR /app
COPY frontend/package.json ./
RUN npm install --ignore-scripts
COPY tsconfig.base.json /tsconfig.base.json
COPY frontend/tsconfig.json ./
COPY frontend/vite.config.ts ./
COPY frontend/tailwind.config.js ./
COPY frontend/postcss.config.js ./
COPY frontend/index.html ./
COPY frontend/src/ ./src/

# Vite inlines import.meta.env at BUILD time, so these must be present here --
# setting them on the running container does nothing. Both have fallbacks in
# the source, and shipping either fallback to a browser is a broken deploy:
#   VITE_API_URL          -> "/api/v1"            (fine: nginx proxies it)
#   VITE_SOLANA_RPC_URL   -> "http://127.0.0.1:8899"  (fatal: user's own laptop)
ARG VITE_API_URL=""
ARG VITE_SOLANA_RPC_URL=""
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_SOLANA_RPC_URL=$VITE_SOLANA_RPC_URL

# Fail loudly instead of baking localhost into a public bundle. This exact
# silent fallback shipped to production and made every deposit fail at
# readNonce() with "Failed to create deposit instruction".
RUN if [ -z "$VITE_SOLANA_RPC_URL" ]; then \
      echo "ERROR: VITE_SOLANA_RPC_URL build arg is required." >&2; \
      echo "  Vite bakes it in at build time; unset means the bundle talks to" >&2; \
      echo "  http://127.0.0.1:8899 -- the visitor's own machine -- and every" >&2; \
      echo "  deposit fails. Pass a public Solana RPC URL as a build arg." >&2; \
      exit 1; \
    fi

RUN npm run build

# nginx rather than `serve -s`: the app needs /api proxied to the API service,
# and `serve -s` rewrites every unmatched path to index.html — including /api.
FROM nginx:1.27-alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/templates/default.conf.template
ENV PORT=3000
# Overridable so the image also runs outside a compose network.
ENV API_UPSTREAM=http://api:3000
ENV DNS_RESOLVER=127.0.0.11
# Docker compose default. Railway's private network is IPv6-only — set
# RESOLVER_IPV6=on and point DNS_RESOLVER at its resolver there.
ENV RESOLVER_IPV6=off
EXPOSE 3000
