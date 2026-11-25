# ---------- build stage ----------
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY server.ts ./
COPY src/server ./src/server
RUN npm run build

# ---------- runtime stage ----------
FROM node:20-alpine
ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY src/client ./src/client
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 8787
CMD ["node", "dist/server.js"]
