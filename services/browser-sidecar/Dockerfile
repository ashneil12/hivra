################################################################################
# Browser sidecar — multi-stage build.
#
# Stage 1: deps      → install npm dependencies (cacheable)
# Stage 2: build     → compile TypeScript
# Stage 3: runtime   → Debian + security-tracked Chromium + display stack
#
# The sidecar browses real, untrusted sites, so its Chromium must be a patched
# build with its sandbox ON. Playwright's bundled browsers are pinned per
# Playwright release and never receive security fixes, so the runtime uses
# Debian's Chromium from trixie-security instead (open source, so it can ship
# in a public image) and refuses to build below the CVE floor. Rebuilding the
# image picks up Debian's latest Chromium security release.
################################################################################

# Keep the readable tag for provenance, but bind the build to the exact
# multi-platform registry index reviewed on 2026-11-03.
FROM node:22-trixie-slim@sha256:2117f713a417f3aff682ac8f5bc2ebbdf1beed51f36e67ab1e0fd3866b6d2d8f AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-trixie-slim@sha256:2117f713a417f3aff682ac8f5bc2ebbdf1beed51f36e67ab1e0fd3866b6d2d8f AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:22-trixie-slim@sha256:2117f713a417f3aff682ac8f5bc2ebbdf1beed51f36e67ab1e0fd3866b6d2d8f AS runtime
WORKDIR /app

# Oldest Chromium this image may ship (CVE-2026-118306, fixed in 156.0.8078.73).
# Must equal MIN_CHROMIUM_VERSION in src/browser/chromium.ts; tests pin both.
ARG CHROMIUM_MIN_VERSION=156.0.8078.73

# Chromium plus the always-on display stack (Xvfb + x11vnc + websockify/noVNC)
# and the optional inner Caddy. Fonts cover Latin, CJK and emoji pages.
# wget serves the HEALTHCHECK; procps gives the fleet audit `ps`.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      chromium fonts-liberation fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
      xvfb x11vnc websockify novnc caddy ca-certificates wget procps \
 && apt-get clean && rm -rf /var/lib/apt/lists/*
RUN installed="$(dpkg-query -W -f='${Version}' chromium)" \
 && if ! dpkg --compare-versions "$installed" ge "$CHROMIUM_MIN_VERSION"; then \
      echo "chromium $installed is older than the security floor $CHROMIUM_MIN_VERSION" >&2; exit 1; \
    fi \
 && /usr/lib/chromium/chromium --version

# Chromium's sandbox cannot run as root. The entrypoint starts as root only to
# repair ownership of the persistent volume, then drops to this user.
RUN useradd --create-home --uid 10001 --user-group --shell /usr/sbin/nologin browser
ENV CHROMIUM_PATH=/usr/lib/chromium/chromium

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY flows ./flows
COPY caddy/Caddyfile /etc/caddy/Caddyfile
# Agent CDP bridge: standalone Chrome supervisor + host-header-fixing DevTools
# proxy. Lives at /app so its imports resolve against /app/dist (the shared
# Chromium launch settings) and /app/node_modules. Inert unless the entrypoint runs with
# AGENT_CDP_ENABLED=true (set by the dashboard on canary).
COPY docker/cdp-proxy.mjs ./cdp-proxy.mjs
COPY docker/cdp-request-guard.mjs ./cdp-request-guard.mjs
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Profile/screenshot dirs. Mount volumes here in compose.
RUN mkdir -p /var/lib/hermes-browser/profiles /var/lib/hermes-browser/flows /var/lib/hermes-browser/screenshots \
 && cp -r flows/. /var/lib/hermes-browser/flows/ || true \
 && chown -R browser:browser /var/lib/hermes-browser

EXPOSE 8789 6080 8080 9224

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://localhost:8789/health || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
