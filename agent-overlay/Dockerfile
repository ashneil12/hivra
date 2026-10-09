# syntax=docker/dockerfile:1
# Hivra overlay image: stock upstream Hermes (digest pinned) + add-only files + the Hivra web
# bundles. No upstream file is edited in the runtime image. See docs/release/NO-FORK-PLAN.md.
#
#   docker buildx build --platform linux/amd64 \
#     --build-arg UPSTREAM_IMAGE=nousresearch/hermes-agent@sha256:<digest> \
#     --build-arg UPSTREAM_TAG=v0.21.6 --build-arg OVERLAY_VERSION=1 \
#     --build-arg VCS_REF=<hivra git sha> -t <repo>:<tag> agent-overlay
#
# WEB_MODE=build (default) builds the two static web bundles from the upstream source at
# UPSTREAM_TAG plus web/patches (the Hivra browser bridge). WEB_MODE=prebuilt takes them from
# ./web-prebuilt/{webchat_dist,web_dist_dash} (used for experiments and offline rebuilds).
ARG UPSTREAM_IMAGE
ARG WEB_MODE=build
ARG NODE_IMAGE=node:26-bookworm@sha256:e6cfc3514df35d1cb534e83f9279a242ad6e578692ab7b56d73dadcc7c4354a0

# ---- web bundles built from stock upstream source + the Hivra patch series --------------------
FROM ${NODE_IMAGE} AS web_build
ARG UPSTREAM_TAG=unknown
WORKDIR /build
RUN git clone --depth 1 --branch "${UPSTREAM_TAG}" https://github.com/NousResearch/hermes-agent.git . 
COPY web/patches/ /patches/
RUN for p in /patches/*.patch; do git apply "$p"; done
RUN npm install --no-audit --no-fund
RUN cd apps/desktop && npx vite build --base=/webchat/ --outDir /out/webchat_dist --emptyOutDir
RUN cd web && npx vite build --base=/dash/ --outDir /out/web_dist_dash --emptyOutDir \
 && node inject-dash-bootstrap.cjs /out/web_dist_dash/index.html

FROM scratch AS web_prebuilt
COPY web-prebuilt/ /out/

FROM web_${WEB_MODE} AS web

# ---- runtime: stock upstream + overlay --------------------------------------------------------
FROM ${UPSTREAM_IMAGE}
ARG UPSTREAM_TAG=unknown
ARG OVERLAY_VERSION=dev
ARG VCS_REF=unknown
ARG UPSTREAM_REVISION=unknown

USER root

# Things the Hivra box supervisor and agents rely on that the stock image does not ship (found in
# the no-fork experiment): `uv` (the generated gateway supervisor runs `uv run --no-sync`), the
# GitHub CLI (agents doing GitHub work) and `hermes` on the default PATH (agent terminal tool).
COPY --from=ghcr.io/astral-sh/uv:0.11.6 /uv /uvx /usr/local/bin/
RUN install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/* \
 && ln -sf /opt/hermes/bin/hermes /usr/local/bin/hermes

# Add-only: plugins/, tools/, skills/, gateway/ (runtime_governor.py, fork_status_guard.py) and the
# hivra_overlay/ package. Every path is new relative to the upstream tree (scripts/check-overlay.sh
# fails if a file would overwrite an upstream file).
COPY files/ /opt/hermes/
# The static bundles the box's Caddy extracts (/webchat and /dash). Same location the retired fork used.
COPY --from=web /out/ /opt/hermes/hermes_cli/
RUN chmod -R a+rX /opt/hermes/hivra_overlay /opt/hermes/plugins /opt/hermes/tools /opt/hermes/skills /opt/hermes/gateway /opt/hermes/hermes_cli/webchat_dist /opt/hermes/hermes_cli/web_dist_dash

LABEL org.opencontainers.image.title="hivra-hermes" \
      org.opencontainers.image.source="https://github.com/ashneil12/hivra" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${UPSTREAM_TAG}+hivra.${OVERLAY_VERSION}" \
      io.hivra.upstream.tag="${UPSTREAM_TAG}" \
      io.hivra.upstream.revision="${UPSTREAM_REVISION}" \
      io.hivra.upstream.image="${UPSTREAM_IMAGE}" \
      io.hivra.overlay.version="${OVERLAY_VERSION}"
