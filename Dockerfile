# ---- Build ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# ---- Production deps ----
FROM node:24-alpine AS prod-deps
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- Runtime ----
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
USER node

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node config ./config
COPY --chown=node:node package.json ./

EXPOSE 3000

CMD ["node", "dist/main.js"]
