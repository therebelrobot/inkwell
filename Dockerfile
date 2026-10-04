# syntax=docker/dockerfile:1

# Build once, on the build machine's own architecture: the output is plain
# JavaScript plus static assets, identical for amd64 and arm64. So the arm64
# image needs no QEMU-emulated npm install or Vite build, which is what makes
# multi-arch builds slow.
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
RUN npm run build && mkdir -p /app/data

# Runtime: the esbuild bundle has hono and inkjs inlined, so no node_modules.
# This stage deliberately has no RUN steps: nothing executes as the target
# architecture during the build, so CI needs no QEMU at all.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    INKWELL_DATA_DIR=/app/data \
    INKWELL_STATIC_DIR=/app/dist/public
COPY --from=build /app/dist ./dist
COPY --from=build --chown=node:node /app/data ./data
USER node
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "dist/server.mjs"]
