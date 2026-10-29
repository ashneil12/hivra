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
# UPSTREAM_COMMIT plus web/patches (the Hivra browser bridge). WEB_MODE=prebuilt takes them from
# ./web-prebuilt/{webchat_dist,web_dist_dash} (used for experiments and offline rebuilds).
# UPSTREAM_COMMIT is the commit UPSTREAM_TAG points to (the default is v0.21.6's). A tag can be
# moved, so the source is fetched by commit. When you change UPSTREAM_TAG, change UPSTREAM_COMMIT too.
ARG UPSTREAM_IMAGE
ARG WEB_MODE=build
ARG NODE_IMAGE=node:26-bookworm@sha256:e6cfc3514df35d1cb534e83f9279a242ad6e578692ab7b56d73dadcc7c4354a0

# ---- web bundles built from stock upstream source + the Hivra patch series --------------------
FROM ${NODE_IMAGE} AS web_build
ARG UPSTREAM_COMMIT=818c13be1dc4fd28987e1e881a9408224afd4535
WORKDIR /build
RUN git init -q . && git remote add origin https://github.com/NousResearch/hermes-agent.git \
 && git fetch -q --depth 1 origin "${UPSTREAM_COMMIT}" \
 && git -c advice.detachedHead=false checkout -q FETCH_HEAD
COPY web/patches/ /patches/
RUN for p in /patches/*.patch; do git apply "$p"; done
RUN npm install --no-audit --no-fund
RUN cd apps/desktop && npx vite build --base=/webchat/ --outDir /out/webchat_dist --emptyOutDir
RUN cd web && npx vite build --base=/dash/ --outDir /out/web_dist_dash --emptyOutDir \
 && node inject-dash-bootstrap.cjs /out/web_dist_dash/index.html

FROM scratch AS web_prebuilt
COPY web-prebuilt/ /out/

FROM web_${WEB_MODE} AS web

# ---- the list of overlay files (the migration and the box's self-update re-apply exactly these) ----
FROM busybox:1.37@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec AS overlay_manifest
COPY files/ /files/
RUN cd /files && find . -type f | sed 's|^\./||' | sort > /FILES.txt

# ---- runtime: stock upstream + overlay --------------------------------------------------------
FROM ${UPSTREAM_IMAGE}
# Re-declared: a global ARG is not visible inside the stage unless it is declared again, and the
# label below would silently come out empty (found when the box migration read it).
ARG UPSTREAM_IMAGE
ARG UPSTREAM_TAG=unknown
ARG OVERLAY_VERSION=dev
ARG VCS_REF=unknown
ARG UPSTREAM_REVISION=unknown

USER root

# Things the Hivra box supervisor and agents rely on that the stock image does not ship (found in
# the no-fork experiment): `uv` (the generated gateway supervisor runs `uv run --no-sync`), the
# GitHub CLI (agents doing GitHub work) and `hermes` on the default PATH (agent terminal tool).
COPY --from=ghcr.io/astral-sh/uv:0.11.6@sha256:b1e699368d24c57cda93c338a57a8c5a119009ba809305cc8e86986d4a006754 /uv /uvx /usr/local/bin/
# The GitHub CLI signing keys are the two primary fingerprints published in cli/cli's install docs.
# The downloaded keyring must hold exactly those keys before apt trusts it.
ARG GH_CLI_SIGNING_FPRS="2C6106201985B60E6C7AC87323F3D4EA75716059 7F38BBB59D064DBCB3D84D725612B36462313325"
RUN install -d -m 0755 /etc/apt/keyrings \
 && apt-get update && apt-get install -y --no-install-recommends gnupg \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /tmp/githubcli-archive-keyring.gpg \
 && gh_fprs="$(gpg --batch --with-colons --show-keys /tmp/githubcli-archive-keyring.gpg | awk -F: '$1=="pub"{want=1} $1=="fpr" && want {print $10; want=0}' | sort | paste -sd' ' -)" \
 && [ "$gh_fprs" = "$GH_CLI_SIGNING_FPRS" ] \
 && install -m 0644 /tmp/githubcli-archive-keyring.gpg /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && rm -f /tmp/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/* \
 && ln -sf /opt/hermes/bin/hermes /usr/local/bin/hermes

# Add-only: plugins/, tools/, skills/, gateway/ (runtime_governor.py, fork_status_guard.py) and the
# hivra_overlay/ package. Every path is new relative to the upstream tree (scripts/check-overlay.sh
# fails if a file would overwrite an upstream file).
COPY files/ /opt/hermes/
# Exactly which paths are the overlay's. A box that follows upstream by itself copies these onto
# every new stock image; nothing else from this image is carried over.
COPY --from=overlay_manifest /FILES.txt /opt/hermes/hivra_overlay/FILES.txt
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
