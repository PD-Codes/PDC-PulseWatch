# syntax=docker/dockerfile:1

# The build and dependency stages produce platform-independent JavaScript (no production dependency
# ships a native binary: none has an os/cpu restriction, and --ignore-scripts skips the optional
# native add-ons), so they always run on the machine that builds the image. Only the small runtime
# stage is built for the target platform, which keeps multi-arch builds fast (no QEMU for npm).

# ---- production dependencies only
FROM --platform=$BUILDPLATFORM node:26-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ---- build the server bundle and the web UI
FROM --platform=$BUILDPLATFORM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY brand.json tsconfig.json tsconfig.web.json ./
COPY scripts scripts
COPY src src
COPY web web
RUN node scripts/build.mjs

# ---- runtime image: small, non-root (built for the target platform)
FROM node:26-alpine AS runtime
# iputils provides ICMP ping, tini reaps child processes and forwards signals
RUN apk add --no-cache iputils tini \
 && addgroup -S -g 10001 pulsewatch && adduser -S -u 10001 -G pulsewatch -h /app pulsewatch \
 && mkdir /data && chown 10001:10001 /data
WORKDIR /app
# UV_THREADPOOL_SIZE: DNS lookups run on the libuv thread pool; the default of 4 is too small for 200 parallel checks
ENV NODE_ENV=production PW_DATA_DIR=/data PW_WEB_DIR=/app/dist/web PW_MIGRATIONS_DIR=/app/migrations PW_HOST=0.0.0.0 PW_PORT=3000 UV_THREADPOOL_SIZE=64
COPY --from=prod-deps /app/node_modules node_modules
COPY --from=build /app/dist/server dist/server
COPY --from=build /app/dist/web dist/web
COPY migrations migrations
COPY package.json ./
VOLUME /data
USER 10001:10001
EXPOSE 3000
# start-period: migrations run before the server listens; an upgrade that builds an index on a large heartbeats table can take minutes
HEALTHCHECK --interval=15s --timeout=5s --start-period=10m --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PW_PORT+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
# --enable-experimental-regexp-engine-on-excessive-backtracks falls back to a linear-time regex engine instead of
# freezing on catastrophic backtracking. Node rejects this flag in NODE_OPTIONS, so it has to be on the command line.
CMD ["node", "--enable-source-maps", "--enable-experimental-regexp-engine-on-excessive-backtracks", "dist/server/main.js"]
