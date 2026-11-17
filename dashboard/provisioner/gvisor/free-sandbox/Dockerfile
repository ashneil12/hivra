# syntax=docker/dockerfile:1.7
# The free sandbox image: one agent app runner, Bun to run it, OpenCode thinking only with OpenCode's own free models,
# and the enroll shim. Built by an operator and pinned by digest in the gVisor adapter (FREE_IMAGE); nothing here is
# pulled when a sandbox starts. Every version and checksum is an argument, so a rebuild names what it takes.
#
#   docker build -f Dockerfile \
#     --build-arg FREE_MODELS="provider/model-a,provider/model-b" \
#     --build-context runner=<dir holding agentes-runner.mjs> \
#     --build-arg RUNNER_SHA256=<sha256 of agentes-runner.mjs> .
#
# The runner bundle comes from the agent app release the sandboxes connect to (its /runner/agentes-runner.mjs), so the
# runner and the server always speak the same protocol. FREE_MODELS comes from the free plan's settings (freeModels):
# the first is the image's default model. The agent app's plan limits are what hold a workspace to them.

ARG BASE=ubuntu:24.04@sha256:73b999393d07f2bf65a40373778a44dc9a6d54ad7718d29247d8ff9413c4d6a8

FROM ${BASE} AS fetch
ARG TARGETARCH
ARG BUN_VERSION=1.4.4
ARG BUN_SHA256_AMD64=bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c
ARG BUN_SHA256_ARM64=baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e
ARG OPENCODE_VERSION=2.3.0
ARG OPENCODE_SHA256_AMD64=fc0f81522aceeabac47693d88389efa2bc517ce74c2c38fd6967819fcc6e4d3b
ARG OPENCODE_SHA256_ARM64=3207fb5cdec448d479242c0f1a14f4f7bdfcad3a79209b5eb8f9003725e93711
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) bun=linux-x64; bun_sha=$BUN_SHA256_AMD64; oc=linux-x64; oc_sha=$OPENCODE_SHA256_AMD64 ;; \
      arm64) bun=linux-aarch64; bun_sha=$BUN_SHA256_ARM64; oc=linux-arm64; oc_sha=$OPENCODE_SHA256_ARM64 ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL --proto '=https' --retry 3 -o /tmp/bun.zip \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-${bun}.zip"; \
    echo "${bun_sha}  /tmp/bun.zip" | sha256sum -c -; \
    unzip -q /tmp/bun.zip -d /tmp/bun; install -m 0755 "/tmp/bun/bun-${bun}/bun" /out-bun; \
    curl -fsSL --proto '=https' --retry 3 -o /tmp/opencode.tar.gz \
      "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-${oc}.tar.gz"; \
    echo "${oc_sha}  /tmp/opencode.tar.gz" | sha256sum -c -; \
    mkdir /tmp/oc && tar -xzf /tmp/opencode.tar.gz -C /tmp/oc; install -m 0755 /tmp/oc/opencode /out-opencode

FROM ${BASE} AS settings
ARG FREE_MODELS
COPY opencode-managed.sh /opencode-managed.sh
RUN sh /opencode-managed.sh "$FREE_MODELS" > /opencode.json

FROM ${BASE}
ARG RUNNER_SHA256
# git and ripgrep: what an agent and OpenCode reach for first (OpenCode would otherwise download its own rg).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git ripgrep less \
 && rm -rf /var/lib/apt/lists/*
COPY --from=fetch /out-bun /usr/local/bin/bun
COPY --from=fetch /out-opencode /usr/local/bin/opencode
COPY --from=runner agentes-runner.mjs /opt/hivra/agentes-runner.mjs
RUN set -eu; \
    test -n "${RUNNER_SHA256:-}" || { echo "RUNNER_SHA256 is required" >&2; exit 1; }; \
    echo "${RUNNER_SHA256}  /opt/hivra/agentes-runner.mjs" | sha256sum -c -; \
    chmod 0444 /opt/hivra/agentes-runner.mjs; \
    printf '#!/bin/sh\nexec /usr/local/bin/bun /opt/hivra/agentes-runner.mjs "$@"\n' > /usr/local/bin/agentes-runner; \
    chmod 0755 /usr/local/bin/agentes-runner
# OpenCode's managed config, root's alone: no other provider, no self-update, no sharing, and the first free model as the
# default. OpenCode 2 does not apply its model whitelist, so the agent app's plan limits (`models`) are what pin Free's
# models; this file is the default under them.
COPY --from=settings --chmod=0444 /opencode.json /etc/opencode/opencode.json
COPY --chmod=0555 enroll-shim /opt/hivra/enroll-shim
COPY --chmod=0555 free-entrypoint /opt/hivra/free-entrypoint
ENV HOME=/workspace \
    OPENCODE_DISABLE_AUTOUPDATE=1 \
    OPENCODE_DISABLE_LSP_DOWNLOAD=1 \
    PATH=/usr/local/bin:/usr/bin:/bin
USER 65534:65534
WORKDIR /workspace
CMD ["/opt/hivra/free-entrypoint"]
