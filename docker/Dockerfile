# syntax=docker/dockerfile:1.7

# ── Stage 1: install deps ──
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN --mount=type=cache,target=/root/.npm \
    npm install --no-audit --no-fund

# ── Stage 2: build ──
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate \
 && npm run build

# ── Stage 3: production runtime ──
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# `dumb-init` reaps zombies; `openssl` is needed by Prisma at runtime on Alpine.
RUN apk add --no-cache dumb-init openssl

# Install only production deps so `node_modules` is lean.
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force

# Copy build artefacts.
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY prisma ./prisma
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Drop privileges. node:alpine ships a `node` user (uid 1000) — use it.
RUN chown -R node:node /app
USER node

EXPOSE 4000
ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/server.js"]
