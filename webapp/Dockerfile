# Build context is the repository root (docker-compose.yml: context ..), because the client bundles
# src/shared/ from the desktop app. What gets in: webapp/Dockerfile.dockerignore.

# ---------- build stage ----------
FROM node:20-alpine AS build
WORKDIR /repo/webapp
COPY webapp/package.json webapp/package-lock.json ./
RUN npm ci
COPY src/shared /repo/src/shared
COPY webapp/ ./
RUN npm run build

# ---------- runtime stage ----------
FROM node:20-alpine
# ssh: reach the Pi hosts; git: not needed locally, but handy for diagnosis; su-exec: drop root after setup
RUN apk add --no-cache openssh-client git su-exec
ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/data \
    SSH_MOUNT=/ssh
WORKDIR /app
COPY webapp/package.json webapp/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /repo/webapp/dist ./dist
COPY webapp/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown -R node:node /data /app
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
