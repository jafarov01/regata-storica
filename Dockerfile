# Gondola Royale: one container, the relay serving the built game (see docs/DEPLOY.md).
# Build: docker build -t gondola-royale .   Run: docker run -p 3000:3000 gondola-royale
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# The browser bundle, then drop the build tools (tsx stays: it runs the server).
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    TSX_TSCONFIG_PATH=tsconfig.server.json
COPY --from=build /app/package.json /app/tsconfig.server.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node_modules/.bin/tsx", "server/index.ts"]
