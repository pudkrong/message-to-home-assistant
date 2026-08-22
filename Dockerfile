# ---- Base ----
FROM oven/bun:1.4-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

# ---- Production deps ----
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ---- Runtime ----
FROM base
USER bun

COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun dist ./dist
COPY --chown=bun:bun config ./config
COPY --chown=bun:bun package.json ./

EXPOSE 3000

CMD ["bun", "run", "dist/main.js"]
