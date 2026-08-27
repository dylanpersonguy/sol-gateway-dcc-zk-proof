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
EXPOSE 3000
