# ============================================
# Stage 1: Dependencies
# ============================================
FROM node:lts-alpine AS deps
WORKDIR /app

# Current Node LTS images no longer bundle corepack, so install pnpm directly.
RUN npm install -g pnpm@10.5.2
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

# Copy only dependency files (maximize cache hits)
COPY package.json pnpm-lock.yaml ./

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile

# ============================================
# Stage 2: Build
# ============================================
FROM node:lts-alpine AS build
WORKDIR /app

RUN npm install -g pnpm@10.5.2
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm run build

# Remove dev dependencies with a clean production install
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile --prod --ignore-scripts

# ============================================
# Stage 3: Runner
# ============================================
FROM node:lts-alpine AS runner
WORKDIR /app

COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json

# The device registry (one Waze account per device) is kept here; mount a volume.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

STOPSIGNAL SIGTERM

CMD ["node", "dist/index.js"]
