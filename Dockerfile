# ---- Base ----
FROM oven/bun:1.4-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

# ---- Build ----
FROM base AS build
ENV NODE_ENV=development
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN bun run build

# ---- Production deps ----
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ---- Runtime ----
FROM base
USER bun

COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --chown=bun:bun config ./config
COPY --chown=bun:bun package.json ./

EXPOSE 3000

CMD ["bun", "run", "dist/main.js"]
