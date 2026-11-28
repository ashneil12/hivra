# Provisioner provenance

This directory is the versioned source for Hivra's portable Proxmox runtime.
It was recovered from the active canary provisioner on `fixturenodea` on 2026-08-26,
before portable-path changes were applied. The imported files were checked for
private-key blocks and common committed-token formats; none were found.

The managed host remains runtime evidence, not the source of truth. Changes to
this directory must bump `VERSION`, pass the provisioner contract tests, and be
installed through the explicit host-preparation operation.

Earlier release notes are in [historical provisioner provenance](../../docs/release/PORTABLE-PROVISIONER-PROVENANCE.md).

Release `2026.11.27.5` seals the host-side Hermes standby helper and its
launch integration. It adds no third-party assets and leaves the catalog image
pins and the desktop and native workload contracts unchanged.

Release `2026.11.27.6` adds optional, digest-bound managed Canary images for
Agent Zero and the shared Claude Code/Codex system dependencies. The producer
locks Ubuntu packages, reviewed tooling, the upstream installer and the Agent
Zero OCI index; the image files themselves are not distributed by this bundle.
The scoped selector is unset by default. It leaves tenant configuration, CLI
updates and non-selected launches on their existing paths.
The stock QEMU Guest Agent refresh skips optional translation, command and
desktop metadata; signed package indexes, SSH attestation and the clean
cloud-init gate are unchanged.

## Reviewed upstream pins

Every network-fetched artifact used by the portable installer is listed here.
The shell sources remain the executable source of truth; this inventory exists
so a reviewer can reproduce the exact download and integrity checks without
inferring them from a live host.

- Ubuntu 22.04 Jammy cloud image:
  `https://cloud-images.ubuntu.com/releases/jammy/release-20260807/ubuntu-22.04-server-cloudimg-amd64.img`
  - SHA-256: `ff271290a23279ce764561dbe2e9c3ec29da899535b571a987c37b47970c2ad9`
- Browser Use bux: `https://github.com/browser-use/bux`
  - commit: `f17c1b31d6688dd92e745ade650e00d46b4dc4da`
- Aeon dashboard: `https://github.com/aaronjmars/aeon.git`
  - commit: `8b8d719715ec9bb68fb858a1e334d23209047d82`
- Cloudflare Tunnel (`cloudflared`) Linux amd64:
  `https://github.com/cloudflare/cloudflared/releases/download/2026.8.2/cloudflared-linux-amd64`
  - version: `2026.8.2`
  - SHA-256: `fcfb02b575a52ca1af2e3267af4e1517bcdeb30ac48c834c69abaed3c0576ad2`
- Caddy Linux amd64:
  `https://github.com/caddyserver/caddy/releases/download/v2.11.4/caddy_2.11.4_linux_amd64.tar.gz`
  - version: `2.11.4`
  - SHA-256: `527fbf917c39189a1e3b31d34fa955601680b2d5c8055d2a87b8b9588dec7bb9`
  - upstream license: Apache-2.0 (`LICENSE` retained at `/usr/share/doc/hivra-caddy/LICENSE`)
- Google Chrome stable Linux amd64:
  `https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_157.0.8103.50-1_amd64.deb`
  - package version: `157.0.8103.50-1` (shipped as `chrome-pin.json`, which the installer and the runtime update both read; the build it replaced, `152.0.7977.64-1`, SHA-256 `4eae0736a812d9bc851cd2937f7af00e47dbaf8305845eed452703ff009873c7`, stays in its `previous` list so an existing computer can be put back)
  - SHA-256: `92148bd14dc05823a64061c2fafcf20d4d82b3fc56f5831206f16d2ac9ee3f79`
- GitHub CLI Linux amd64:
  `https://cli.github.com/packages/pool/main/g/gh/gh_2.98.0_amd64.deb`
  - package version: `2.98.0`
  - SHA-256: `f65a3fa2fa0eb2e97c445ee3f5e087a40aae03b64847f45a8f13805e504535d6`
- Anthropic Claude Code npm package: `@anthropic-ai/claude-code`, upstream's newest
  release at install time (npm `latest`); no Hivra pin
- Anthropic Claude desktop app for Linux (optional, owner-initiated):
  `https://downloads.claude.ai/claude-desktop/apt/stable/pool/main/c/claude-desktop/claude-desktop_2.26454.0_amd64.deb`
  - package version: `2.26454.0`
  - SHA-256: `6d3e4973dcb11511ddd962040b3073b435d1592b3174a82ef52e50377a75a63f`
  - size: 180809792 bytes
  - proprietary Anthropic software, downloaded from Anthropic's repository and never bundled or redistributed by Hivra
- OpenAI Codex CLI npm package: `@openai/codex`, npm `latest` at install time; no Hivra pin
- OpenClaw npm package: `openclaw`, npm `latest` at install time; no Hivra pin
- Agent Zero OCI image: `agent0ai/agent-zero:latest`, recorded by the digest it
  resolved to at install time; no Hivra pin
- Aeon: the upstream repository's `HEAD` commit at install time; no Hivra pin
- Selkies X11 desktop OCI image:
  `ghcr.io/selkies-project/selkies-egl-desktop@sha256:6ee5ddc3aa50ec9b3f22d2090ee1b0d2161e7be5acd9f385717e7c3603f6b3aa`
  - observed source commit: `dbc97872dbeae49e7f1e4491c3dee54f437f364d`
  - upstream license: MPL-2.0
  - observed amd64 runtime identity: `Config.User=1000`, named user/group
    `ubuntu=1000:1000`, entrypoint `/etc/container-entrypoint.sh`, no command,
    working directory `/home/ubuntu`

Release `2026.11.27.7` accepts the exact Proxmox-escaped Hermes standby
ownership description. It preserves the previous release and does not change
Hermes upstream code, the guest image pins or native update behavior.

Release `2026.11.28.1` adds elapsed-time markers to the baked Hermes guest
installer and its final standby attestation. It does not change upstream
Hermes, baked image pins, stock launch behavior or readiness checks.

Release `2026.11.28.2` adds bounded memory overcommit to host admission for
eligible Canary KVM launches and wakes. Ordinary admission remains unchanged;
the new behavior requires explicit policy and this sealed host release.
The same release seals the operator wrapper for exact allowlisted QA clones.
