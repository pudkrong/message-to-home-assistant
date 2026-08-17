# ---- Base ----
# Alpine is safe here: all runtime deps are pure-JS (no node-gyp).
FROM node:22-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

# ---- Build ----
FROM base AS build
# Dev dependencies are required to compile TypeScript.
ENV NODE_ENV=development
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# ---- Production deps ----
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- Runtime ----
FROM base
# Run as an unprivileged user.
USER node

# Only what's needed to run: production node_modules, compiled output,
# and the runtime config files referenced via REPORTS_CONFIG_PATH /
# UNIT_FACTORIES_CONFIG_PATH (default ./config/*.json).
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node config ./config
COPY --chown=node:node package.json ./

EXPOSE 3000

CMD ["node", "dist/main.js"]
