# syntax=docker/dockerfile:1.7
FROM node:22.23-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

FROM base AS dependencies
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS builder
# NEXT_PUBLIC_* values are inlined into the browser bundle at build time, so
# the custom-domain CNAME target has to be known here (compose.yaml passes it
# as a build arg). Empty means custom domains are not offered.
ARG NEXT_PUBLIC_STUDIO_PLATFORM_HOST=
ENV NEXT_PUBLIC_STUDIO_PLATFORM_HOST=$NEXT_PUBLIC_STUDIO_PLATFORM_HOST
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22.23-bookworm-slim AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/.data \
    && chown -R node:node /app
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
USER node
EXPOSE 3000
# Liveness only: the container is healthy when the process answers. Readiness
# (database, email and payment configuration) is GET /api/health without the
# probe parameter — point the load balancer / uptime monitor at that one, so a
# missing optional integration degrades the service instead of restart-looping
# the container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health?probe=live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
