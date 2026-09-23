# syntax=docker/dockerfile:1

# ---- build -----------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Install with the lockfile so the build is reproducible.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies from the tree we are about to copy forward.
RUN npm prune --omit=dev

# ---- runtime ---------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000

# `node` (uid 1000) ships with the image; run as it rather than root.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

USER node
EXPOSE 3000

# Uses the service's own health endpoint; no extra tooling in the image.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# No npm in the entrypoint: node is PID 1 so it receives SIGTERM directly and
# the graceful shutdown in index.ts actually runs.
CMD ["node", "dist/index.js"]
