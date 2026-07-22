# syntax=docker/dockerfile:1

# Multi-stage build for the Workday Simulator.
# - build:     full install (with a C++ toolchain for native modules) + tsc + vite
# - prod-deps: production-only dependency tree, better-sqlite3 compiled once
# - runtime:   slim, non-root node:22 serving the built server and dashboard

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# --- build stage: compile server (tsc) and dashboard (vite) ------------------
FROM base AS build
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build

# --- production dependencies (better-sqlite3 built with the toolchain) -------
FROM base AS prod-deps
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

# --- runtime: minimal, non-root ---------------------------------------------
FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8477
ENV HOST=0.0.0.0
ENV DB_PATH=/app/data/workday.db
ENV WEB_DIST_PATH=/app/dist/web

COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Writable data directory owned by the unprivileged node user.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 8477

# Liveness via the shallow health endpoint (Node 22 has global fetch).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8477)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/main.js"]
