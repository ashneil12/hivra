################################################################################
# Browser sidecar — multi-stage build.
#
# Stage 1: deps      → install npm dependencies (cacheable)
# Stage 2: build     → compile TypeScript
# Stage 3: runtime   → Playwright base + runtime deps + compiled code
#
# Total image ~1.3GB (Chromium is ~700MB of that).
################################################################################

# Keep the readable tag for provenance, but bind the build to the exact
# multi-platform registry index reviewed on 2026-08-30.
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

# Base MUST match the playwright version pinned in package-lock.json (1.59.1):
# the image bakes the browser revision for that version, and Playwright's
# chromium.executablePath() resolves to it. A mismatch (e.g. base 1.49 baking
# chromium-1148 while npm installs 1.59 expecting chromium-1217) makes Chrome
# launch fail with ENOENT — both CDP mode and the Vex Playwright path.
FROM mcr.microsoft.com/playwright:v1.59.1-noble@sha256:b0ab6f3cb99aa7803adbc14d9027ec1785fc6e433b97e134e0f8fe61683b6b53 AS runtime
WORKDIR /app

# Optional seed-mode dependencies. Installed unconditionally because we want the
# same image to support both modes; the entrypoint decides whether to start them.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      xvfb x11vnc websockify novnc caddy ca-certificates \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY flows ./flows
COPY caddy/Caddyfile /etc/caddy/Caddyfile
# Agent CDP bridge: standalone Chrome supervisor + host-header-fixing DevTools
# proxy. Lives at /app so its `import { chromium } from "playwright"` resolves
# against /app/node_modules. Inert unless the entrypoint runs with
# AGENT_CDP_ENABLED=true (set by the dashboard on canary).
COPY docker/cdp-proxy.mjs ./cdp-proxy.mjs
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Profile/screenshot dirs. Mount volumes here in compose.
RUN mkdir -p /var/lib/hermes-browser/profiles /var/lib/hermes-browser/flows /var/lib/hermes-browser/screenshots \
 && cp -r flows/. /var/lib/hermes-browser/flows/ || true

EXPOSE 8789 6080 8080 9224

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://localhost:8789/health || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
