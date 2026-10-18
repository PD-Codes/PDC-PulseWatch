# syntax=docker/dockerfile:1

# ---- production dependencies only
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ---- build the server bundle and the web UI
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY brand.json tsconfig.json tsconfig.web.json ./
COPY scripts scripts
COPY src src
COPY web web
RUN node scripts/build.mjs

# ---- runtime image: small, non-root
FROM node:22-alpine AS runtime
# iputils provides ICMP ping, tini reaps child processes and forwards signals
RUN apk add --no-cache iputils tini \
 && addgroup -S -g 10001 pulsewatch && adduser -S -u 10001 -G pulsewatch -h /app pulsewatch \
 && mkdir /data && chown 10001:10001 /data
WORKDIR /app
ENV NODE_ENV=production PW_DATA_DIR=/data PW_WEB_DIR=/app/dist/web PW_MIGRATIONS_DIR=/app/migrations PW_HOST=0.0.0.0 PW_PORT=3000
COPY --from=prod-deps /app/node_modules node_modules
COPY --from=build /app/dist/server dist/server
COPY --from=build /app/dist/web dist/web
COPY migrations migrations
COPY package.json ./
VOLUME /data
USER 10001:10001
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PW_PORT+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/server/main.js"]
