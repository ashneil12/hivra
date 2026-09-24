#!/usr/bin/env bash
#
# provision-claude-code-box.sh
# -----------------------------
# Reproduces, from scratch on a FRESH Ubuntu 22.04 box, a "coding agent on the
# cloud" box that was first validated on a disposable lab computer.
#
# Supports the catalog agent kinds (HIVRA_AGENT_KIND, default claude):
#   claude — Claude Code CLI + a self-hosted Chrome browser overlay.
#   codex  — OpenAI Codex CLI, with the same optional browser overlay (the bux
#            installer pre-installs codex; the cdp skill is shared via ~/.agents/skills).
#   linux-desktop — the shared Ubuntu/bux base without an agent CLI or persona;
#                   authenticated Files and terminals share ~/Hivra.
#
# What it sets up, end to end:
#   1. Stock browser-use/bux (Claude Code + Codex CLIs, Node 24, ttyd, the
#      browser-harness-js skill, a `bux` agent user) via the upstream installer,
#      run with a DUMMY BROWSER_USE_API_KEY and WITH_ZTK=0.
#   2. (browser-enabled boxes) A self-hosted browser OVERLAY that replaces bux's
#      Browser-Use-Cloud keeper: real Google Chrome (.deb) +
#      local-browser-keeper.py + bux-local-browser.service launching headless
#      Chrome on 127.0.0.1:9222 with a NON-default --user-data-dir.
#   3. The Hivra streaming chat surface (Node frontend to the official `claude`
#      OR `codex` CLI, selected by ~/.hivra/agent-kind) at /opt/bux/hivra-chat +
#      bux-hivra-chat.service.
#   4. A Hivra-branded system prompt (~/CLAUDE.md for claude, ~/AGENTS.md for
#      codex — both symlinks the installer makes).
#
# After this script the ONLY remaining manual step is the per-user login:
#   claude:  sudo -iu bux claude auth login            (native OAuth)
#   codex:   sudo -iu bux codex login --device-auth    (ChatGPT device-auth)
# (creds land in /home/bux/.claude or /home/bux/.codex)
#
# The script is IDEMPOTENT and safe to re-run. It NEVER touches box 1099.
#
# Run as root (or via sudo) on the target box:
#       sudo HIVRA_AGENT_KIND=codex ./provision-claude-code-box.sh
#
# It expects the sibling artifacts to live next to it:
#   local-browser-keeper.py  bux-local-browser.service
#   bux-hivra-chat.service   hivra-chat/{server.js,index.html,app.js}
#   system-prompt.md
#
set -euo pipefail

# --- tunables (override via env) -------------------------------------------
AGENT_USER="${AGENT_USER:-bux}"                 # bux's installer hardcodes this user
BUX_DIR="${BUX_DIR:-/opt/bux}"                  # MUST be /opt/bux: unit ExecStart paths are hardcoded
BUX_REF="${BUX_REF:-f17c1b31d6688dd92e745ade650e00d46b4dc4da}" # reviewed upstream commit
CLAUDE_CODE_VERSION="${CLAUDE_CODE_VERSION:-2.1.246}"
CODEX_CLI_VERSION="${CODEX_CLI_VERSION:-0.149.1}"
CLOUDFLARED_VERSION="${CLOUDFLARED_VERSION:-2026.8.2}"
CLOUDFLARED_LINUX_AMD64_SHA256="${CLOUDFLARED_LINUX_AMD64_SHA256:-fcfb02b575a52ca1af2e3267af4e1517bcdeb30ac48c834c69abaed3c0576ad2}"
CADDY_VERSION="${CADDY_VERSION:-2.11.4}"
CADDY_LINUX_AMD64_SHA256="${CADDY_LINUX_AMD64_SHA256:-527fbf917c39189a1e3b31d34fa955601680b2d5c8055d2a87b8b9588dec7bb9}"
CHROME_VERSION="${CHROME_VERSION:-152.0.7977.64-1}"
CHROME_LINUX_AMD64_SHA256="${CHROME_LINUX_AMD64_SHA256:-4eae0736a812d9bc851cd2937f7af00e47dbaf8305845eed452703ff009873c7}"
GH_VERSION="${GH_VERSION:-2.98.0}"
GH_LINUX_AMD64_SHA256="${GH_LINUX_AMD64_SHA256:-f65a3fa2fa0eb2e97c445ee3f5e087a40aae03b64847f45a8f13805e504535d6}"
NODE_VERSION="${NODE_VERSION:-22.23.2}"
NODE_LINUX_X64_SHA256="${NODE_LINUX_X64_SHA256:-d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307}"
TTYD_VERSION="${TTYD_VERSION:-1.7.7}"
TTYD_LINUX_X64_SHA256="${TTYD_LINUX_X64_SHA256:-8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55}"
AGENT_ZERO_IMAGE_DIGEST="${AGENT_ZERO_IMAGE_DIGEST:-sha256:d8fd86114b02e9b4b6f14ef6f696b1ba7af46e52327734bb8a77f7aaf8556cf0}"
CDP_PORT="${CDP_PORT:-9222}"                    # local Chrome remote-debugging port
PROFILE_DIR="${PROFILE_DIR:-/home/${AGENT_USER}/.browser-profile}"  # NON-default Chrome profile (Chrome 136+ gotcha)
HIVRA_CHAT_PORT="${HIVRA_CHAT_PORT:-8080}"      # Hivra chat HTTP port
DUMMY_BU_KEY="${DUMMY_BU_KEY:-local}"           # installer hard-requires a key; we self-host so it's a dummy
AGENT_KIND="${HIVRA_AGENT_KIND:-claude}"        # catalog runtime or linux-desktop computer profile
case "$AGENT_KIND" in
  claude|codex|aeon|openclaw|agent-zero|linux-desktop) ;;
  deepseek-harness)
    [ "${HIVRA_NATIVE_PREPARE_ONLY:-}" = 1 ] || { printf '%s\n' 'DeepSeek requires the shared typed guest installer' >&2; exit 1; }
    ;;
  *) printf '%s\n' 'unsupported HIVRA_AGENT_KIND' >&2; exit 1 ;;
esac
# Explicit substrate, not a best-effort fallback when required hardware fails.
# The managed/Proxmox default retains its required QEMU guest agent. A provider
# VM is already the isolation boundary and need not expose that guest channel.
COMPUTER_SUBSTRATE="${HIVRA_COMPUTER_SUBSTRATE:-proxmox-kvm}"
ACCESS_HOSTNAME="${HIVRA_ACCESS_HOSTNAME:-}"
case "$COMPUTER_SUBSTRATE" in
  proxmox-kvm|provider-vm) ;;
  *) printf '%s\n' 'unsupported HIVRA_COMPUTER_SUBSTRATE' >&2; exit 1 ;;
esac
# A private provider desktop worker must publish its ownership plan before
# activating chat, Selkies or the broker. This mode only prepares the shared
# base; it never publishes a desktop/runtime receipt or completes a launch.
provider_desktop_prepare_mode() {
  local mode="$1" kind="$2" substrate="$3"
  case "$mode" in
    0) ;;
    1) [ "$kind" = linux-desktop ] && [ "$substrate" = provider-vm ] || return 1 ;;
    *) return 1 ;;
  esac
  printf '%s\n' "$mode"
}
PROVIDER_DESKTOP_PREPARE_ONLY="$(provider_desktop_prepare_mode "${HIVRA_PROVIDER_DESKTOP_PREPARE_ONLY:-0}" "$AGENT_KIND" "$COMPUTER_SUBSTRATE")" \
  || { printf '%s\n' 'invalid provider desktop preparation mode' >&2; exit 1; }
case "$(uname -m)" in
  x86_64) ;;
  *) printf '%s\n' 'this runtime bundle requires Linux amd64 artifacts' >&2; exit 1 ;;
esac
# Browser stack: honor the explicit launch toggle (HIVRA_WANT_BROWSER=0/1, the
# paid opt-in from the dashboard); when unset (legacy / direct runs) default to
# "on for claude boxes".
if [ "${HIVRA_WANT_BROWSER:-}" = "1" ]; then WANT_BROWSER=1
elif [ "${HIVRA_WANT_BROWSER:-}" = "0" ]; then WANT_BROWSER=0
else WANT_BROWSER=0; [ "$AGENT_KIND" = "claude" ] && WANT_BROWSER=1; fi
# Aeon hosts a web dashboard only — never a browser stack.
[ "$AGENT_KIND" = "aeon" ] && WANT_BROWSER=0
# Agent Zero ships its OWN browser inside its container — never the box CDP stack.
[ "$AGENT_KIND" = "agent-zero" ] && WANT_BROWSER=0
# Linux Desktop's remote-computer profile owns its desktop/browser stack.
[ "$AGENT_KIND" = "linux-desktop" ] && WANT_BROWSER=0
# OpenClaw CAN drive the box's CDP Chrome (browser.cdpUrl → :${CDP_PORT}); it just
# honors the launch toggle like the coding agents (default off, opt in for the
# live "log into your accounts" browser). The block below wires cdpUrl when on.

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_HOME="/home/${AGENT_USER}"
HIVRA_COMPUTER_ID="${HIVRA_COMPUTER_ID:-}"
HIVRA_CONTROL_ORIGIN="${HIVRA_CONTROL_ORIGIN:-}"
HIVRA_PUBLIC_ORIGIN="${HIVRA_PUBLIC_ORIGIN:-}"

# --- pretty output ---------------------------------------------------------
c_bold=$'\033[1m'; c_dim=$'\033[2m'; c_green=$'\033[32m'; c_red=$'\033[31m'; c_reset=$'\033[0m'
say()  { printf '%s==>%s %s\n' "$c_bold" "$c_reset" "$*"; }
ok()   { printf '%s  ok%s %s\n' "$c_green" "$c_reset" "$*"; }
warn() { printf '%s  ! %s %s\n' "$c_red" "$c_reset" "$*" >&2; }
die()  { warn "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die 'must run as root (use sudo)'
[ -f /etc/debian_version ] || die 'only debian/ubuntu is supported'

# Guard the two overrides that the upstream bux artifacts hardcode and CANNOT
# follow: the keeper hardcodes /home/bux/.claude + pwd.getpwnam("bux"), and the
# local-browser unit's ExecStart hardcodes /opt/bux/venv/bin/python.
[ "${AGENT_USER}" = "bux" ] || die "AGENT_USER must be 'bux' (bux installer + keeper hardcode it)"
[ "${BUX_DIR}" = "/opt/bux" ] || die "BUX_DIR must be '/opt/bux' (bux unit ExecStart paths hardcode it)"
[[ "$CHROME_LINUX_AMD64_SHA256" =~ ^[0-9a-f]{64}$ ]] || die "invalid Chrome checksum"
[[ "$CADDY_LINUX_AMD64_SHA256" =~ ^[0-9a-f]{64}$ ]] || die "invalid Caddy checksum"
[[ "$GH_LINUX_AMD64_SHA256" =~ ^[0-9a-f]{64}$ ]] || die "invalid GitHub CLI checksum"
[[ "$NODE_LINUX_X64_SHA256" =~ ^[0-9a-f]{64}$ ]] || die "invalid Node.js checksum"
[[ "$TTYD_LINUX_X64_SHA256" =~ ^[0-9a-f]{64}$ ]] || die "invalid ttyd checksum"
[[ "$AGENT_ZERO_IMAGE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || die "invalid Agent Zero image digest"
[[ "$CDP_PORT" =~ ^[0-9]+$ ]] && [ "$CDP_PORT" -ge 1 ] && [ "$CDP_PORT" -le 65535 ] \
  || die "CDP_PORT must be an integer from 1 to 65535"
if [ -n "$ACCESS_HOSTNAME" ]; then
  [[ "$ACCESS_HOSTNAME" =~ ^([0-9]{1,3}-){3}[0-9]{1,3}\.sslip\.io$ ]] \
    || die "HIVRA_ACCESS_HOSTNAME must be an IPv4 sslip.io hostname"
  IFS=- read -r access_a access_b access_c access_tail <<<"${ACCESS_HOSTNAME%.sslip.io}"
  for access_octet in "$access_a" "$access_b" "$access_c" "$access_tail"; do
    [[ "$access_octet" =~ ^(0|[1-9][0-9]{0,2})$ ]] && [ "$((10#$access_octet))" -le 255 ] \
      || die "HIVRA_ACCESS_HOSTNAME contains an invalid IPv4 octet"
  done
  [ "$COMPUTER_SUBSTRATE" = "provider-vm" ] || die "direct HTTPS access requires provider-vm substrate"
fi

say "agent kind: ${c_bold}${AGENT_KIND}${c_reset} (browser overlay: $([ "$WANT_BROWSER" = 1 ] && echo yes || echo no))"

# Chat + prompt artifacts are always required; browser artifacts only for claude.
for f in VERSION bux-hivra-chat.service system-prompt.md hivra-agent-shell \
         bux-ttyd-base-path.conf bux-box-ttyd.service \
         hivra-runtime-receipt.py \
         hivra-chat/server.js hivra-chat/llm-application.js hivra-chat/guarded-files.cjs hivra-chat/agent-zero-editor.cjs hivra-chat/chat-runs.cjs hivra-chat/index.html hivra-chat/app.js; do
  [ -f "$SRC_DIR/$f" ] || die "missing artifact next to script: $f"
done
if [ "$AGENT_KIND" = "linux-desktop" ]; then
  for f in remote-desktop/install-guest.py remote-desktop/broker.cjs remote-desktop/server.cjs; do
    [ -f "$SRC_DIR/$f" ] || die "missing Linux Desktop artifact next to script: $f"
  done
fi
if [ "$PROVIDER_DESKTOP_PREPARE_ONLY" = 1 ]; then
  for f in workspace-access-policy.cjs workspace-sessions.cjs workspace-control.cjs workspace-router.cjs workspace-handoff.cjs; do
    [ -f "$SRC_DIR/hivra-chat/$f" ] || die "missing provider workspace artifact: $f"
  done
fi
if [ "$WANT_BROWSER" = 1 ]; then
  for f in local-browser-keeper.py bux-local-browser.service; do
    [ -f "$SRC_DIR/$f" ] || die "missing browser artifact next to script: $f"
  done
fi

# ===========================================================================
say "1/7  base packages"
# ===========================================================================
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates git wget gnupg tmux sudo xz-utils
if [ "$COMPUTER_SUBSTRATE" = "proxmox-kvm" ]; then
  apt-get install -y qemu-guest-agent
  systemctl enable --now qemu-guest-agent \
    || die "qemu-guest-agent failed to start"
fi
ok "base packages present"

if [ -z "$ACCESS_HOSTNAME" ] && { ! command -v cloudflared >/dev/null 2>&1 || ! cloudflared --version 2>/dev/null | grep -Fq "$CLOUDFLARED_VERSION"; }; then
  say "installing verified cloudflared ${CLOUDFLARED_VERSION}"
  CLOUDFLARED_TMP="$(mktemp /tmp/cloudflared.XXXXXX)"
  trap 'rm -f -- "${CLOUDFLARED_TMP:-}"' EXIT
  curl --fail --location --proto '=https' --tlsv1.2 --retry 3 \
    "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64" \
    -o "$CLOUDFLARED_TMP"
  printf '%s  %s\n' "$CLOUDFLARED_LINUX_AMD64_SHA256" "$CLOUDFLARED_TMP" | sha256sum -c - >/dev/null \
    || die "cloudflared checksum verification failed"
  install -m 0755 "$CLOUDFLARED_TMP" /usr/local/bin/cloudflared
  rm -f -- "$CLOUDFLARED_TMP"
  trap - EXIT
  ok "installed $(cloudflared --version)"
fi
assert_caddy_destination() {
  local expected="$1" installed="$2"
  if [ -e "$installed" ] || [ -L "$installed" ]; then
    [ -f "$installed" ] && [ ! -L "$installed" ] && cmp -s "$expected" "$installed" \
      || die "existing Caddy binary differs; explicit repair required"
  fi
}

if [ -n "$ACCESS_HOSTNAME" ]; then
    # The printed version is not provenance. Always verify the pinned archive
    # and compare any existing binary before adopting it or publishing notices.
    say "installing verified Caddy ${CADDY_VERSION} for standalone HTTPS"
    CADDY_TMP_DIR="$(mktemp -d /tmp/hivra-caddy.XXXXXX)"
    trap 'rm -rf -- "${CADDY_TMP_DIR:-}"' EXIT
    curl --fail --location --proto '=https' --tlsv1.2 --retry 3 \
      "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_amd64.tar.gz" \
      -o "$CADDY_TMP_DIR/caddy.tar.gz"
    printf '%s  %s\n' "$CADDY_LINUX_AMD64_SHA256" "$CADDY_TMP_DIR/caddy.tar.gz" | sha256sum -c - >/dev/null \
      || die "Caddy checksum verification failed"
    mkdir "$CADDY_TMP_DIR/unpacked"
    tar -xzf "$CADDY_TMP_DIR/caddy.tar.gz" -C "$CADDY_TMP_DIR/unpacked"
    [ "$(find "$CADDY_TMP_DIR/unpacked" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort | tr '\n' ' ')" = "LICENSE README.md caddy " ] \
      || die "Caddy archive contents changed"
    [ -f "$CADDY_TMP_DIR/unpacked/LICENSE" ] && [ -f "$CADDY_TMP_DIR/unpacked/README.md" ] \
      && [ -f "$CADDY_TMP_DIR/unpacked/caddy" ] && [ ! -L "$CADDY_TMP_DIR/unpacked/caddy" ] \
      || die "Caddy archive layout is invalid"
    assert_caddy_destination "$CADDY_TMP_DIR/unpacked/caddy" /usr/local/bin/caddy
    install -m 0755 "$CADDY_TMP_DIR/unpacked/caddy" /usr/local/bin/caddy
    install -d -m 0755 /usr/share/doc/hivra-caddy
    install -m 0644 "$CADDY_TMP_DIR/unpacked/LICENSE" /usr/share/doc/hivra-caddy/LICENSE
    rm -rf -- "$CADDY_TMP_DIR"
    trap - EXIT
  install -d -o root -g root -m 0700 /var/lib/caddy
  ok "verified $(caddy version) for ${ACCESS_HOSTNAME}"
fi

# ===========================================================================
say "2/7  install stock bux into ${BUX_DIR} (dummy BU key, WITH_ZTK=0)"
# ===========================================================================
if [ "$AGENT_KIND" = "linux-desktop" ]; then
  # A plain computer must not depend on an agent distribution. Install only
  # the small host-side access base used by Files and the two terminals; the
  # contained desktop itself is installed later by remote-desktop/install-guest.py.
  say "installing standalone Linux Desktop access base"
  if ! id "${AGENT_USER}" >/dev/null 2>&1; then
    useradd --create-home --home-dir "${AGENT_HOME}" --shell /bin/bash "${AGENT_USER}"
  fi
  [ "$(getent passwd "${AGENT_USER}" | cut -d: -f6)" = "${AGENT_HOME}" ] \
    || die "existing desktop user has an unexpected home"

  NODE_ROOT="/opt/hivra/node-v${NODE_VERSION}-linux-x64"
  if [ ! -x "${NODE_ROOT}/bin/node" ] || [ "$("${NODE_ROOT}/bin/node" --version 2>/dev/null || true)" != "v${NODE_VERSION}" ]; then
    [ ! -e "${NODE_ROOT}" ] || die "existing Node.js runtime differs from the pinned desktop runtime"
    NODE_TMP_DIR="$(mktemp -d /tmp/hivra-node.XXXXXX)"
    trap 'rm -rf -- "${NODE_TMP_DIR:-}"' EXIT
    curl --fail --location --proto '=https' --tlsv1.2 --retry 3 \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
      -o "${NODE_TMP_DIR}/node.tar.xz"
    printf '%s  %s\n' "$NODE_LINUX_X64_SHA256" "${NODE_TMP_DIR}/node.tar.xz" | sha256sum -c - >/dev/null \
      || die "Node.js archive checksum verification failed"
    install -d -m 0755 /opt/hivra
    # Vendor archives carry build-machine numeric owners. Do not give a local
    # unprivileged UID ownership of the gateway's executable or its parents.
    # Keep the checksum-pinned archive modes: the private worker uses umask077,
    # but the bux service must still traverse and execute this root-owned tree.
    tar --no-same-owner -xJf "${NODE_TMP_DIR}/node.tar.xz" -C /opt/hivra
    rm -rf -- "$NODE_TMP_DIR"
    trap - EXIT
  fi
  for binary in node npm npx corepack; do
    [ -x "${NODE_ROOT}/bin/${binary}" ] || die "pinned Node.js archive is incomplete"
    ln -sfn "${NODE_ROOT}/bin/${binary}" "/usr/local/bin/${binary}"
  done
  [ "$(node --version)" = "v${NODE_VERSION}" ] || die "pinned Node.js runtime is unavailable"

  if [ ! -x /usr/local/bin/ttyd ] || ! /usr/local/bin/ttyd --version 2>&1 | grep -Fq "$TTYD_VERSION"; then
    TTYD_TMP="$(mktemp /tmp/hivra-ttyd.XXXXXX)"
    trap 'rm -f -- "${TTYD_TMP:-}"' EXIT
    curl --fail --location --proto '=https' --tlsv1.2 --retry 3 \
      "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.x86_64" \
      -o "$TTYD_TMP"
    printf '%s  %s\n' "$TTYD_LINUX_X64_SHA256" "$TTYD_TMP" | sha256sum -c - >/dev/null \
      || die "ttyd binary checksum verification failed"
    install -o root -g root -m 0755 "$TTYD_TMP" /usr/local/bin/ttyd
    rm -f -- "$TTYD_TMP"
    trap - EXIT
  fi
  install -d -o root -g root -m 0755 "${BUX_DIR}" /var/log/bux
  cat > /etc/systemd/system/bux-ttyd.service <<'UNIT'
[Unit]
Description=Hivra computer terminal
After=network-online.target

[Service]
User=bux
Group=bux
WorkingDirectory=/home/bux
Environment=HOME=/home/bux
Environment=PATH=/usr/local/bin:/usr/bin:/bin
RuntimeDirectory=hivra-terminal
RuntimeDirectoryMode=0700
ExecStart=/usr/local/bin/ttyd -i /run/hivra-terminal/ttyd.sock -W /usr/local/bin/hivra-agent-shell
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
  chmod 0644 /etc/systemd/system/bux-ttyd.service
  ok "standalone desktop base ready (Node.js v${NODE_VERSION}, ttyd ${TTYD_VERSION})"
else
# bux's systemd units hardcode /opt/bux/agent/* in their ExecStart lines, so the
# repo MUST live at /opt/bux. We clone there (not curl|bash) so the installer
# runs from a real checkout and our re-runs are deterministic.
read_bux_checkout_head() {
  local checkout_uid git_uid agent_uid
  [ ! -L "${BUX_DIR}" ] && [ ! -L "${BUX_DIR}/.git" ] \
    || die "bux checkout must not be a symlink"
  checkout_uid="$(stat -c '%u' "${BUX_DIR}")" || return 1
  git_uid="$(stat -c '%u' "${BUX_DIR}/.git")" || return 1
  [ "$checkout_uid" = "$git_uid" ] || die "bux checkout ownership differs from its git directory"
  if [ "$checkout_uid" = 0 ]; then
    git -C "${BUX_DIR}" rev-parse HEAD
  else
    agent_uid="$(id -u "${AGENT_USER}")" || return 1
    [ "$checkout_uid" = "$agent_uid" ] || die "bux checkout has an unexpected owner"
    # The stock installer hands this checkout to bux. Read it as that owner on
    # replay, without disabling Git's ownership checks or changing global trust.
    sudo -H -u "${AGENT_USER}" -- git -C "${BUX_DIR}" rev-parse HEAD
  fi
}
BUX_CHECKOUT_CREATED=0
if [ ! -e "${BUX_DIR}" ] && [ ! -L "${BUX_DIR}" ]; then
  # Only newly created public source gets public modes. Never relax a retained
  # checkout, private worker journal, launch payload or credential directory.
  ( umask 022
    mkdir "${BUX_DIR}"
    git -C "${BUX_DIR}" init -q
    git -C "${BUX_DIR}" remote add origin https://github.com/browser-use/bux
    git -C "${BUX_DIR}" fetch --depth 1 origin "${BUX_REF}"
    git -C "${BUX_DIR}" checkout -q --detach FETCH_HEAD
  )
  BUX_CHECKOUT_CREATED=1
  ok "checked out browser-use/bux@${BUX_REF} -> ${BUX_DIR}"
else
  [ -d "${BUX_DIR}/.git" ] && [ -f "${BUX_DIR}/install.sh" ] \
    || die "existing ${BUX_DIR} is not a complete verifiable bux checkout"
  BUX_HEAD="$(read_bux_checkout_head)" || die "could not verify the existing bux checkout as its owner"
  [ "$BUX_HEAD" = "$BUX_REF" ] || die "existing bux checkout is ${BUX_HEAD:-unknown}; expected ${BUX_REF}"
  ok "verified existing browser-use/bux@${BUX_REF}"
fi

run_public_bootstrap() (
  # Package keyrings and executables must be readable/executable by their
  # service users. Scope this to fixed public installs, with no inherited keys,
  # Telegram settings or shell hooks. The enclosing worker keeps umask 077.
  umask 022
  exec env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    HOME=/root LANG=C.UTF-8 "$@"
)

ensure_bux_installed() {
if id "${AGENT_USER}" >/dev/null 2>&1 && [ -x /usr/bin/claude ]; then
  ok "bux already installed (user ${AGENT_USER} + claude present); skipping installer"
else
  # HEAD identifies the checkout, not its mutable working-tree bytes. Never
  # re-execute an existing user-customizable installer as root. A damaged base
  # (or a dashboard runtime which stripped the coding CLIs) needs trusted repair.
  [ "$BUX_CHECKOUT_CREATED" = 1 ] \
    || die "existing bux base is incomplete; trusted base repair is required"
  # Only the checkout created by this invocation is eligible for root execution.
  # Pin its two CLI downloads before running the reviewed upstream installer.
  sed -i -E \
    "s#npm install -g @anthropic-ai/claude-code(@[^[:space:]\\]+)?#npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}#" \
    "${BUX_DIR}/install.sh"
  sed -i -E \
    "s#npm install -g @openai/codex(@[^[:space:]\\]+)?#npm install -g @openai/codex@${CODEX_CLI_VERSION}#" \
    "${BUX_DIR}/install.sh"
  grep -Fq "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "${BUX_DIR}/install.sh" \
    || die "could not pin Claude Code in the reviewed bux installer"
  grep -Fq "@openai/codex@${CODEX_CLI_VERSION}" "${BUX_DIR}/install.sh" \
    || die "could not pin Codex in the reviewed bux installer"
  # WITH_ZTK=0 skips the optional Zig token-killer build. BROWSER_USE_API_KEY is
  # hard-required by install.sh even though we self-host the browser, so we pass a
  # dummy — the cloud keeper it would feed gets disabled in step 4 anyway. The
  # installer also pre-installs the codex CLI for the bux user.
  say "running bux installer (this builds Node 24, ttyd, the bux user, claude+codex, skills)"
  ( cd "${BUX_DIR}" && run_public_bootstrap env \
      BROWSER_USE_API_KEY=local \
      WITH_ZTK=0 \
      BUX_REF="${BUX_REF}" \
      ./install.sh )
  ok "bux installed"
fi
}
ensure_bux_installed

if ! claude --version 2>/dev/null | grep -Fq "$CLAUDE_CODE_VERSION"; then
  run_public_bootstrap npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    || die "failed to install pinned Claude Code ${CLAUDE_CODE_VERSION}"
fi

# Sanity: the installer should have produced these. Fail loud if not.
id "${AGENT_USER}" >/dev/null 2>&1 || die "agent user ${AGENT_USER} not created by installer"
[ -x /usr/bin/claude ] || die "claude CLI not found at /usr/bin/claude after installer"
[ -x /usr/bin/node ]   || die "node not found at /usr/bin/node after installer"
fi

prepare_linux_desktop_workspace() {
  [ "${AGENT_KIND:-}" = "linux-desktop" ] || return 0
  local workspace="${AGENT_HOME}/Hivra" owner expected_owner mode
  expected_owner="$(id -u "${AGENT_USER}"):$(id -g "${AGENT_USER}")"
  if [ ! -e "$workspace" ] && [ ! -L "$workspace" ]; then
    install -d -o "${AGENT_USER}" -g "${AGENT_USER}" -m 0755 "$workspace"
  else
    [ ! -L "$workspace" ] && [ -d "$workspace" ] \
      || die "Linux Desktop workspace must be a real directory"
    owner="$(stat -c '%u:%g' "$workspace")" \
      || die "Linux Desktop workspace ownership is unavailable"
    mode="$(stat -c '%a' "$workspace")" \
      || die "Linux Desktop workspace mode is unavailable"
    [ "$owner" = "$expected_owner" ] \
      || die "Linux Desktop workspace has an unexpected owner"
    [[ "$mode" =~ ^[0-7]{3,4}$ ]] && (( (8#$mode & 0022) == 0 )) \
      || die "Linux Desktop workspace is group/other writable"
  fi
  ok "Linux Desktop workspace ready: ${workspace}"
}
prepare_linux_desktop_workspace
# For codex boxes, make sure the installer's codex pre-install actually landed.
if [ "$AGENT_KIND" = "codex" ]; then
  if sudo -iu "${AGENT_USER}" command -v codex >/dev/null 2>&1; then
    ok "codex CLI present ($(sudo -iu "${AGENT_USER}" bash -lc 'codex --version' 2>/dev/null || echo present))"
  else
    say "codex CLI absent — installing @openai/codex for ${AGENT_USER}"
    sudo -iu "${AGENT_USER}" bash -lc "npm i -g @openai/codex@${CODEX_CLI_VERSION}" \
      || die "failed to install @openai/codex for ${AGENT_USER}"
    ok "codex CLI installed"
  fi
  sudo -iu "${AGENT_USER}" bash -lc 'codex --version' 2>/dev/null | grep -Fq "$CODEX_CLI_VERSION" \
    || die "Codex CLI version does not match ${CODEX_CLI_VERSION}"
fi
install -d -o root -g root -m 0755 /var/log/bux

# ===========================================================================
say "3/7  Google Chrome stable (.deb, NOT snap) — browser-enabled boxes"
# ===========================================================================
if [ "$WANT_BROWSER" = 1 ]; then
  if dpkg-query -W -f='${Version}' google-chrome-stable 2>/dev/null | grep -Fxq "$CHROME_VERSION"; then
    ok "verified google-chrome-stable ${CHROME_VERSION}"
  else
    CHROME_TMP="$(mktemp /tmp/google-chrome.XXXXXX.deb)"
    trap 'rm -f -- "${CHROME_TMP:-}"' EXIT
    curl --fail --location --proto '=https' --tlsv1.2 --retry 3 \
      "https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${CHROME_VERSION}_amd64.deb" \
      -o "$CHROME_TMP"
    printf '%s  %s\n' "$CHROME_LINUX_AMD64_SHA256" "$CHROME_TMP" | sha256sum -c - >/dev/null \
      || die "Chrome checksum verification failed"
    apt-get install -y "$CHROME_TMP"
    rm -f -- "$CHROME_TMP"
    trap - EXIT
    dpkg-query -W -f='${Version}' google-chrome-stable 2>/dev/null | grep -Fxq "$CHROME_VERSION" \
      || die "Chrome version does not match ${CHROME_VERSION}"
    ok "installed verified google-chrome-stable ${CHROME_VERSION}"
  fi
  # Live-view stack: Xvfb (virtual display) + x11vnc + noVNC/websockify so the
  # agent's headful Chrome can be streamed into the dashboard Browser tab.
  apt-get install -y xvfb x11vnc novnc websockify
  ok "installed browser-view stack (xvfb x11vnc novnc websockify)"
else
  ok "browser off — skipping Chrome"
fi

# ===========================================================================
say "4/7  self-hosted browser overlay (replaces the BU Cloud keeper) — browser-enabled boxes"
# ===========================================================================
if [ "$WANT_BROWSER" = 1 ]; then
  # Disable + remove the cloud keeper unit the installer enabled. On a fresh box
  # it is a SYMLINK at /etc/systemd/system/bux-browser-keeper.service ->
  # /opt/bux/agent/bux-browser-keeper.service; disabling drops the symlink.
  if systemctl list-unit-files 2>/dev/null | grep -q '^bux-browser-keeper\.service' \
     || [ -e /etc/systemd/system/bux-browser-keeper.service ]; then
    systemctl disable --now bux-browser-keeper.service >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/bux-browser-keeper.service
    ok "cloud keeper (bux-browser-keeper.service) disabled + unit link removed"
  else
    ok "cloud keeper already absent"
  fi

  # Drop in the local keeper script (current working copy from box 1099).
  install -o "${AGENT_USER}" -g "${AGENT_USER}" -m 0755 \
    "$SRC_DIR/local-browser-keeper.py" "${BUX_DIR}/local-browser-keeper.py"
  ok "installed ${BUX_DIR}/local-browser-keeper.py"

  # Pre-create the NON-default profile dir. Chrome 136+ refuses remote-debugging
  # on the default ~/.config/google-chrome profile, so we always use a custom one.
  install -d -o "${AGENT_USER}" -g "${AGENT_USER}" -m 0700 "${PROFILE_DIR}"
  install -d -o "${AGENT_USER}" -g "${AGENT_USER}" -m 0755 "${AGENT_HOME}/.claude"
  ok "profile dir ${PROFILE_DIR} ready"

  # Install the local-browser unit, templated with the chosen profile dir + port.
  sed \
    -e "s#^User=.*#User=${AGENT_USER}#" \
    -e "s#^Group=.*#Group=${AGENT_USER}#" \
    -e "s#^Environment=BUX_LOCAL_PROFILE_DIR=.*#Environment=BUX_LOCAL_PROFILE_DIR=${PROFILE_DIR}#" \
    "$SRC_DIR/bux-local-browser.service" > /etc/systemd/system/bux-local-browser.service
  if [ "${CDP_PORT}" != "9222" ]; then
    sed -i "/^Environment=BUX_LOCAL_PROFILE_DIR=/a Environment=BUX_LOCAL_CDP_PORT=${CDP_PORT}" \
      /etc/systemd/system/bux-local-browser.service
  fi
  chmod 0644 /etc/systemd/system/bux-local-browser.service

  # --- live browser view: Xvfb + x11vnc + noVNC, and run Chrome HEADFUL on it ---
  # The chat server proxies /vnc -> noVNC (:6080). x11vnc + websockify bind to
  # localhost only; the box tunnel is the access boundary (same as the terminals).
  cat > /etc/systemd/system/hivra-xvfb.service <<'UNIT'
[Unit]
Description=Hivra Xvfb virtual display :99 (browser view)
After=network.target
[Service]
ExecStart=/usr/bin/Xvfb :99 -screen 0 1280x720x24 -ac -nolisten tcp
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
UNIT
  cat > /etc/systemd/system/hivra-x11vnc.service <<'UNIT'
[Unit]
Description=Hivra x11vnc on :99
After=hivra-xvfb.service
Requires=hivra-xvfb.service
[Service]
ExecStartPre=/bin/sleep 1
ExecStart=/usr/bin/x11vnc -display :99 -forever -shared -nopw -rfbport 5900 -localhost -noxdamage -quiet
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
UNIT
  cat > /etc/systemd/system/hivra-novnc.service <<'UNIT'
[Unit]
Description=Hivra noVNC (websockify) on :6080
After=hivra-x11vnc.service
Requires=hivra-x11vnc.service
[Service]
ExecStart=/usr/bin/websockify --web /usr/share/novnc 6080 127.0.0.1:5900
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
UNIT
  # Drop-in makes the keeper launch Chrome headful on :99 (it reads HIVRA_BROWSER_VIEW).
  install -d -m 0755 /etc/systemd/system/bux-local-browser.service.d
  cat > /etc/systemd/system/bux-local-browser.service.d/hivra-view.conf <<'UNIT'
[Unit]
Requires=hivra-xvfb.service
After=hivra-xvfb.service
[Service]
Environment=HIVRA_BROWSER_VIEW=1
Environment=DISPLAY=:99
UNIT
  ok "installed browser-view units (hivra-xvfb/x11vnc/novnc + keeper headful drop-in)"
else
  ok "browser off — skipping browser overlay"
fi

# ===========================================================================
say "5/7  Hivra authenticated access gateway (${AGENT_KIND})"
# ===========================================================================
if [ "$AGENT_KIND" != "deepseek-harness" ]; then
install -d -o "${AGENT_USER}" -g "${AGENT_USER}" -m 0755 "${BUX_DIR}/hivra-chat"
for f in server.js llm-application.js guarded-files.cjs agent-zero-editor.cjs chat-runs.cjs index.html app.js; do
  install -o "${AGENT_USER}" -g "${AGENT_USER}" -m 0644 \
    "$SRC_DIR/hivra-chat/$f" "${BUX_DIR}/hivra-chat/$f"
done
if [ "$PROVIDER_DESKTOP_PREPARE_ONLY" = 1 ]; then
  # Provider workspace access has a separate owner/session protocol. Install its
  # complete fixed closure only on this once-only desktop preparation path.
  for f in workspace-access-policy.cjs workspace-sessions.cjs workspace-control.cjs workspace-router.cjs workspace-handoff.cjs; do
    install -o root -g root -m 0644 "$SRC_DIR/hivra-chat/$f" "${BUX_DIR}/hivra-chat/$f"
  done
  chown root:root "${BUX_DIR}" "${BUX_DIR}/hivra-chat"
  chmod 0755 "${BUX_DIR}" "${BUX_DIR}/hivra-chat"
  for f in server.js llm-application.js guarded-files.cjs agent-zero-editor.cjs chat-runs.cjs index.html app.js; do
    chown root:root "${BUX_DIR}/hivra-chat/$f"
  done
fi
ok "deployed ${BUX_DIR}/hivra-chat/{server.js,llm-application.js,chat-runs.cjs,index.html,app.js}"
fi

# Record which CLI the chat server should drive. The server reads
# ~/.hivra/agent-kind (and we ALSO set HIVRA_AGENT_KIND on the unit as a belt).
install -d -o "${AGENT_USER}" -g "${AGENT_USER}" -m 0755 "${AGENT_HOME}/.hivra"
printf '%s\n' "${AGENT_KIND}" > "${AGENT_HOME}/.hivra/agent-kind"
chown "${AGENT_USER}:${AGENT_USER}" "${AGENT_HOME}/.hivra/agent-kind"
ok "agent kind recorded: ${AGENT_HOME}/.hivra/agent-kind = ${AGENT_KIND}"

# Codex discovers skills from ~/.agents/skills (per OpenAI's skills spec); bux
# only installs the cdp (browser-harness-js) skill into ~/.claude/skills. Same
# SKILL.md format — symlink it across so codex can drive the box browser too.
if [ "$AGENT_KIND" = "codex" ] && [ -d "${AGENT_HOME}/.claude/skills/cdp" ]; then
  install -d -o "${AGENT_USER}" -g "${AGENT_USER}" -m 0755 "${AGENT_HOME}/.agents" "${AGENT_HOME}/.agents/skills"
  ln -sfn "${AGENT_HOME}/.claude/skills/cdp" "${AGENT_HOME}/.agents/skills/cdp"
  chown -h "${AGENT_USER}:${AGENT_USER}" "${AGENT_HOME}/.agents/skills/cdp"
  ok "cdp skill shared into ${AGENT_HOME}/.agents/skills (codex skill discovery)"
fi

# Box API token gating the introspection endpoints (sessions/files/skills). The
# orchestrator reads it back + the dashboard stores + passes it as a Bearer.
if [ ! -s "${AGENT_HOME}/.hivra/api-token" ]; then
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "${AGENT_HOME}/.hivra/api-token"
  chown "${AGENT_USER}:${AGENT_USER}" "${AGENT_HOME}/.hivra/api-token"
  chmod 600 "${AGENT_HOME}/.hivra/api-token"
fi
ok "box API token ready: ${AGENT_HOME}/.hivra/api-token"

# Install the chat unit, templated with the chosen port + agent user/home/kind.
if [ "$AGENT_KIND" != "deepseek-harness" ] && [ "$PROVIDER_DESKTOP_PREPARE_ONLY" != 1 ]; then
NODE_BIN="$(command -v node)"
[ -x "$NODE_BIN" ] || die "node runtime is unavailable for the Hivra gateway"
sed \
  -e "s#^User=.*#User=${AGENT_USER}#" \
  -e "s#^Group=.*#Group=${AGENT_USER}#" \
  -e "s#^WorkingDirectory=.*#WorkingDirectory=${BUX_DIR}/hivra-chat#" \
  -e "s#^Environment=HOME=.*#Environment=HOME=${AGENT_HOME}#" \
  -e "s#^Environment=HIVRA_CHAT_PORT=.*#Environment=HIVRA_CHAT_PORT=${HIVRA_CHAT_PORT}#" \
  -e "s#^Environment=BUX_LOCAL_CDP_PORT=.*#Environment=BUX_LOCAL_CDP_PORT=${CDP_PORT}#" \
  -e "s#^ExecStart=.*#ExecStart=${NODE_BIN} ${BUX_DIR}/hivra-chat/server.js#" \
  "$SRC_DIR/bux-hivra-chat.service" > /etc/systemd/system/bux-hivra-chat.service
# Ensure HIVRA_AGENT_KIND is present on the unit (add or rewrite).
if grep -q '^Environment=HIVRA_AGENT_KIND=' /etc/systemd/system/bux-hivra-chat.service; then
  sed -i "s#^Environment=HIVRA_AGENT_KIND=.*#Environment=HIVRA_AGENT_KIND=${AGENT_KIND}#" \
    /etc/systemd/system/bux-hivra-chat.service
else
  sed -i "/^Environment=HIVRA_CHAT_PORT=/a Environment=HIVRA_AGENT_KIND=${AGENT_KIND}" \
    /etc/systemd/system/bux-hivra-chat.service
fi
if [ "$AGENT_KIND" = "linux-desktop" ]; then
  sed -i "/^Environment=HIVRA_AGENT_KIND=/a Environment=HIVRA_WORKSPACE_ROOT=${AGENT_HOME}/Hivra" \
    /etc/systemd/system/bux-hivra-chat.service
fi
chmod 0644 /etc/systemd/system/bux-hivra-chat.service
ok "installed /etc/systemd/system/bux-hivra-chat.service (port ${HIVRA_CHAT_PORT}, kind ${AGENT_KIND})"
fi
# Chat turns run in detached runner processes (hivra-chat/chat-runs.cjs). A
# gateway restart (runtime update, crash) must stop only the gateway itself and
# leave in-flight agent runs working; the restarted gateway adopts them.
case "$AGENT_KIND" in
  claude|codex|generic)
    if [ "$PROVIDER_DESKTOP_PREPARE_ONLY" != 1 ]; then
      install -d -o root -g root -m 0755 /etc/systemd/system/bux-hivra-chat.service.d
      printf '%s\n' '[Service]' 'KillMode=process' > /etc/systemd/system/bux-hivra-chat.service.d/10-hivra-detached-runs.conf
      chmod 0644 /etc/systemd/system/bux-hivra-chat.service.d/10-hivra-detached-runs.conf
      ok "chat runs survive gateway restarts (KillMode=process drop-in)"
    fi
    ;;
esac

# Narrow root helper so the chat server (runs as ${AGENT_USER}, no general sudo)
# can (de)activate the bux Telegram bot via a SCOPED NOPASSWD sudoers rule.
if [ -f "$SRC_DIR/hivra-tg-apply" ]; then
  install -o root -g root -m 0755 "$SRC_DIR/hivra-tg-apply" /usr/local/bin/hivra-tg-apply
  printf '%s ALL=(root) NOPASSWD: /usr/local/bin/hivra-tg-apply\n' "${AGENT_USER}" > /etc/sudoers.d/hivra-tg
  chmod 0440 /etc/sudoers.d/hivra-tg
  if ! visudo -cf /etc/sudoers.d/hivra-tg >/dev/null 2>&1; then warn "hivra-tg sudoers invalid; removing"; rm -f /etc/sudoers.d/hivra-tg; fi
  ok "Telegram connect helper + scoped sudoers installed"
fi

# Narrow root helper so the chat server can turn browser automation (Chrome +
# the live-view stack) on/off — disabling runs the box ~1 CPU / 2 GB leaner.
# Browser-enabled boxes only (claude or codex with the overlay on).
if [ "$WANT_BROWSER" = 1 ] && [ -f "$SRC_DIR/hivra-browser-apply" ]; then
  install -o root -g root -m 0755 "$SRC_DIR/hivra-browser-apply" /usr/local/bin/hivra-browser-apply
  printf '%s ALL=(root) NOPASSWD: /usr/local/bin/hivra-browser-apply\n' "${AGENT_USER}" > /etc/sudoers.d/hivra-browser
  chmod 0440 /etc/sudoers.d/hivra-browser
  if ! visudo -cf /etc/sudoers.d/hivra-browser >/dev/null 2>&1; then warn "hivra-browser sudoers invalid; removing"; rm -f /etc/sudoers.d/hivra-browser; fi
  ok "browser-automation toggle helper + scoped sudoers installed"
fi

# ===========================================================================
if [ "$AGENT_KIND" = "aeon" ]; then
say "5b/7  Aeon dashboard (hosted Next.js; tasks run on the user's own GitHub Actions)"
# ===========================================================================
# GitHub CLI — Aeon shells out to `gh` for auth + every GitHub API call.
if ! dpkg-query -W -f='${Version}' gh 2>/dev/null | grep -Fxq "$GH_VERSION"; then
  GH_TMP="$(mktemp /tmp/github-cli.XXXXXX.deb)"
  trap 'rm -f -- "${GH_TMP:-}"' EXIT
  curl --fail --location --proto '=https' --tlsv1.2 --retry 3 \
    "https://cli.github.com/packages/pool/main/g/gh/gh_${GH_VERSION}_amd64.deb" \
    -o "$GH_TMP"
  printf '%s  %s\n' "$GH_LINUX_AMD64_SHA256" "$GH_TMP" | sha256sum -c - >/dev/null \
    || die "GitHub CLI checksum verification failed"
  apt-get install -y "$GH_TMP"
  rm -f -- "$GH_TMP"
  trap - EXIT
fi
dpkg-query -W -f='${Version}' gh 2>/dev/null | grep -Fxq "$GH_VERSION" \
  || die "GitHub CLI version does not match ${GH_VERSION}"
ok "verified gh ${GH_VERSION}"

# The dashboard's RUNTIME footprint is tiny (~200 MB), but a one-time `next build`
# peaks much higher. Ensure a swapfile exists so the build can spill instead of
# OOMing on a small (0.5 CPU / 1 GB) box. Persisted via fstab.
if ! swapon --show=NAME --noheadings 2>/dev/null | grep -q .; then
  fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null 2>&1 || true
  swapon /swapfile 2>/dev/null || true
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ok "2G swapfile enabled (build headroom for small boxes)"
else
  ok "swap already present"
fi

AEON_DIR="${AGENT_HOME}/aeon"
AEON_DASH="${AEON_DIR}/apps/dashboard"     # the Next.js dashboard lives here
AEON_PORT="${AEON_DASHBOARD_PORT:-5555}"
AEON_REPO_URL="${AEON_REPO_URL:-https://github.com/aaronjmars/aeon.git}"
AEON_REF="${AEON_REF:-8b8d719715ec9bb68fb858a1e334d23209047d82}"
[[ "$AEON_REF" =~ ^[0-9a-f]{40}$ ]] || die "AEON_REF must be a full 40-character commit SHA"
# Clone the Aeon template. The user repoints it at their own fork (and sets the
# default repo) from inside Aeon's dashboard after connecting GitHub. Idempotent.
if [ ! -d "${AEON_DIR}/.git" ]; then
  install -d -o "${AGENT_USER}" -g "${AGENT_USER}" -m 0755 "${AEON_DIR}"
  sudo -u "${AGENT_USER}" git -C "${AEON_DIR}" init -q
  sudo -u "${AGENT_USER}" git -C "${AEON_DIR}" remote add origin "${AEON_REPO_URL}"
  sudo -u "${AGENT_USER}" git -C "${AEON_DIR}" fetch --depth 1 origin "${AEON_REF}" \
    || die "failed to fetch pinned aeon commit"
  sudo -u "${AGENT_USER}" git -C "${AEON_DIR}" checkout -q --detach FETCH_HEAD
else
  AEON_HEAD="$(sudo -u "${AGENT_USER}" git -C "${AEON_DIR}" rev-parse HEAD 2>/dev/null || true)"
  [ "$AEON_HEAD" = "$AEON_REF" ] \
    || die "existing aeon checkout is ${AEON_HEAD:-unknown}; expected ${AEON_REF}"
fi
ok "verified aeon checkout at ${AEON_REF} -> ${AEON_DIR}"

# Serve under basePath=/aeon so the box's token-proxy can mount the dashboard —
# its absolute asset + /api paths then resolve under /aeon and route back through
# the gate. Upstream ships an empty next.config.ts, so replace it with an
# env-driven one (basePath read from AEON_BASE_PATH at build + runtime).
cat > "${AEON_DASH}/next.config.ts" <<'NEXTCFG'
import type { NextConfig } from 'next'
// Hivra hosts this dashboard behind a token-proxy mounted at /aeon.
const basePath = process.env.AEON_BASE_PATH || undefined
const nextConfig: NextConfig = basePath ? { basePath, assetPrefix: basePath } : {}
export default nextConfig
NEXTCFG
chown "${AGENT_USER}:${AGENT_USER}" "${AEON_DASH}/next.config.ts"
ok "aeon dashboard pinned to basePath=/aeon"

# Install deps + a PRODUCTION build (lighter + more stable than `next dev` for a
# hosted dashboard; basePath is baked at build time so AEON_BASE_PATH is set here
# too). LIVE-VALIDATION: confirm the build + runtime fit the box RAM (Next 16).
sudo -iu "${AGENT_USER}" bash -lc "cd '${AEON_DASH}' && npm ci" \
  || die "aeon npm install failed"
sudo -iu "${AGENT_USER}" bash -lc "cd '${AEON_DASH}' && AEON_BASE_PATH=/aeon npm run build" \
  || die "aeon production build failed"
ok "aeon dashboard prepared (${AEON_DASH})"

# Dashboard service: production Next.js server on :${AEON_PORT}, mounted at /aeon.
# It serves the UI immediately; its /api calls (which shell out to `gh`) start
# working once GitHub is connected via the chat server's connect endpoint. The
# Aeon dashboard has no auth of its own, so ALLOW_ANY_HOST=1 is safe ONLY because
# the box token-proxy authenticates every request.
cat > /etc/systemd/system/bux-aeon.service <<UNIT
[Unit]
Description=Hivra Aeon dashboard (Next.js on :${AEON_PORT}, basePath /aeon)
After=network.target
[Service]
User=${AGENT_USER}
Group=${AGENT_USER}
WorkingDirectory=${AEON_DASH}
Environment=HOME=${AGENT_HOME}
Environment=PATH=/usr/local/bin:/home/${AGENT_USER}/.npm-global/bin:/usr/bin:/bin
Environment=AEON_BASE_PATH=/aeon
Environment=AEON_DASHBOARD_ALLOW_ANY_HOST=1
Environment=PORT=${AEON_PORT}
ExecStart=/usr/bin/env npm run start -- -p ${AEON_PORT}
Restart=on-failure
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
chmod 0644 /etc/systemd/system/bux-aeon.service

# Narrow root helper so the chat server (runs as ${AGENT_USER}, no general sudo)
# can restart the dashboard after the GitHub connect step.
cat > /usr/local/bin/hivra-aeon-apply <<'HELPER'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  restart) systemctl restart bux-aeon.service ;;
  stop)    systemctl stop bux-aeon.service ;;
  *) echo "usage: hivra-aeon-apply restart|stop" >&2; exit 2 ;;
esac
HELPER
chmod 0755 /usr/local/bin/hivra-aeon-apply
printf '%s ALL=(root) NOPASSWD: /usr/local/bin/hivra-aeon-apply\n' "${AGENT_USER}" > /etc/sudoers.d/hivra-aeon
chmod 0440 /etc/sudoers.d/hivra-aeon
if ! visudo -cf /etc/sudoers.d/hivra-aeon >/dev/null 2>&1; then warn "hivra-aeon sudoers invalid; removing"; rm -f /etc/sudoers.d/hivra-aeon; fi
ok "Aeon dashboard service + restart helper installed (port ${AEON_PORT})"
fi

# ===========================================================================
if [ "$AGENT_KIND" = "openclaw" ]; then
say "5c/7  OpenClaw gateway (local-first agent daemon + Control UI)"
# ===========================================================================
# OpenClaw (MIT, ex-Moltbot) is a persistent agent daemon wired to messaging apps
# with a heartbeat scheduler. `openclaw gateway` serves everything on ONE port:
# WS control/RPC + HTTP APIs + the Control UI (chat/config/exec-approvals). We bind
# it LOOPBACK-ONLY and front it with the box token-proxy under /openclaw — its own
# auth + any self-tunnel must never be the access boundary, the gate is.
OPENCLAW_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
OPENCLAW_CFG_DIR="${AGENT_HOME}/.openclaw"
OPENCLAW_BIN="${AGENT_HOME}/.npm-global/bin/openclaw"

# One-time `npm i -g` of a large package can spike RAM; ensure swap on small boxes.
if ! swapon --show=NAME --noheadings 2>/dev/null | grep -q .; then
  fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile; mkswap /swapfile >/dev/null 2>&1 || true; swapon /swapfile 2>/dev/null || true
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ok "2G swapfile enabled (install headroom for small boxes)"
fi

# OpenClaw needs Node 24 (or >=22.19) — the bux installer already builds Node 24 at
# /usr/bin/node, so the npm global install + gateway shebang resolve the right node.
# PINNED version (not @latest) for fleet reproducibility — OpenClaw ships often and
# config-schema/auth-mode semantics drift between releases (e.g. auth.mode=none is
# accepted on 2026.6.10, the version validated live on a spike box 2026-06-24). Bump
# deliberately + re-validate on a spike box before raising this.
OPENCLAW_VERSION="${OPENCLAW_VERSION:-2026.6.10}"
say "installing openclaw@${OPENCLAW_VERSION} for ${AGENT_USER} (Node $(/usr/bin/node -v 2>/dev/null || echo '?'))"
sudo -iu "${AGENT_USER}" bash -lc "npm i -g openclaw@${OPENCLAW_VERSION}" \
  || die "openclaw npm install failed"
if [ -x "${OPENCLAW_BIN}" ] || sudo -iu "${AGENT_USER}" command -v openclaw >/dev/null 2>&1; then
  ok "openclaw installed ($(sudo -iu "${AGENT_USER}" bash -lc 'openclaw --version' 2>/dev/null | head -1 || echo present))"
else
  die "openclaw binary not found after install"
fi

# Gateway auth shared-secret. The Control UI sits behind our token-proxy, but
# OpenClaw rejects non-loopback binds without auth and the Control UI may require
# it even on loopback — seed a known token so the proxy/validation can present it.
# Stored root-readable for the orchestrator to retrieve (like the box api-token).
install -d -o "${AGENT_USER}" -g "${AGENT_USER}" -m 0700 "${OPENCLAW_CFG_DIR}"
if [ ! -s "${AGENT_HOME}/.hivra/openclaw-gateway-token" ]; then
  install -d -o "${AGENT_USER}" -g "${AGENT_USER}" -m 0755 "${AGENT_HOME}/.hivra"
  head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > "${AGENT_HOME}/.hivra/openclaw-gateway-token"
  chown "${AGENT_USER}:${AGENT_USER}" "${AGENT_HOME}/.hivra/openclaw-gateway-token"
  chmod 600 "${AGENT_HOME}/.hivra/openclaw-gateway-token"
fi
OC_TOKEN="$(cat "${AGENT_HOME}/.hivra/openclaw-gateway-token")"

# Minimal config — bind loopback on the fixed port with the seeded auth token. Do
# NOT clobber an existing config (the user may have onboarded channels/models in
# the Control UI). Schema is best-effort; verified + refined during live spike.
if [ ! -s "${OPENCLAW_CFG_DIR}/openclaw.json" ]; then
  # Config tuned + validated on a live spike box (2026-06-19):
  #  - gateway.mode=local is REQUIRED or the gateway won't start (exit 78/CONFIG:
  #    "existing config is missing gateway.mode"); undocumented.
  #  - bind=loopback keeps it private; the box token-proxy is the only public path.
  #  - auth.mode=none: the token-proxy already authenticates every user and the
  #    gateway is loopback+firewalled (OpenClaw's documented fronting-proxy
  #    deployment) — so the Control UI must NOT demand a SECOND token from the user.
  #  - controlUi.dangerouslyAllowHostHeaderOriginFallback: the Control UI WS arrives
  #    with the public tunnel Origin (not loopback); this accepts it. Safe only
  #    because the gate is the real boundary (same model as Aeon's ALLOW_ANY_HOST).
  #  (OC_TOKEN seeded below is unused while auth.mode=none, but kept so switching to
  #   token auth is a one-line change.)
  # When the browser stack is on, point OpenClaw at the box's CDP Chrome (:${CDP_PORT})
  # so it drives the SAME headful Chrome the user logs into in the live VNC tab — the
  # "act in my accounts" surface. profiles.chrome override takes precedence over
  # OpenClaw's built-in relay profile (docs.openclaw.ai/tools/browser).
  if [ "$WANT_BROWSER" = 1 ]; then
    # profiles.chrome.color is REQUIRED by OpenClaw's schema (gateway refuses to
    # start without it: "browser.profiles.chrome.color: expected string").
    OC_BROWSER_JSON=", \"browser\": { \"cdpUrl\": \"http://127.0.0.1:${CDP_PORT}\", \"profiles\": { \"chrome\": { \"cdpUrl\": \"http://127.0.0.1:${CDP_PORT}\", \"color\": \"#ff7a45\" } } }"
  else
    OC_BROWSER_JSON=""
  fi
  # Managed-Venice billing: when the dashboard minted a proxy key for this box, route
  # all inference through a custom OpenAI-compatible provider (models.providers.venice)
  # pointed at our managed-Venice gateway → usage bills the user's wallet. Schema
  # (models.providers.<id>.{baseUrl,api,apiKey,models[]} + agents.defaults.model.primary)
  # ground-truthed via `openclaw onboard` + validated live. Key is inline (0600 file,
  # single-tenant box) — same as OpenClaw's own onboard output.
  # Generic managed-Venice env (same the dashboard sends every managed agent):
  # HIVRA_MODEL_KEY (hven_ proxy key) / HIVRA_MODEL_BASE_URL (gateway /v1) /
  # HIVRA_HERMES_MODEL (model id).
  OC_MODEL="${HIVRA_HERMES_MODEL:-deepseek-v4-pro}"
  # Defensive: only embed the key + model if they're safe to interpolate into JSON
  # (no quotes/backslashes/spaces that would corrupt the config). hven_* keys are
  # base64url + the model is dashboard-validated; this guards a future format change
  # rather than silently writing a broken config that crash-loops the gateway.
  if [ -n "${HIVRA_MODEL_KEY:-}" ] \
     && printf '%s' "${HIVRA_MODEL_KEY}" | grep -qE '^[A-Za-z0-9_-]+$' \
     && printf '%s' "${OC_MODEL}" | grep -qE '^[A-Za-z0-9_.-]+$'; then
    OC_BASEURL="${HIVRA_MODEL_BASE_URL:-https://hivra.cloud/api/managed-venice/v1}"
    OC_VENICE_JSON=", \"agents\": { \"defaults\": { \"model\": { \"primary\": \"venice/${OC_MODEL}\" }, \"models\": { \"venice/${OC_MODEL}\": {} } } }, \"models\": { \"mode\": \"merge\", \"providers\": { \"venice\": { \"baseUrl\": \"${OC_BASEURL}\", \"api\": \"openai-completions\", \"apiKey\": \"${HIVRA_MODEL_KEY}\", \"models\": [ { \"id\": \"${OC_MODEL}\", \"name\": \"${OC_MODEL} (Venice)\", \"contextWindow\": 128000, \"maxTokens\": 4096, \"input\": [\"text\"], \"cost\": { \"input\": 0, \"output\": 0, \"cacheRead\": 0, \"cacheWrite\": 0 }, \"reasoning\": false } ] } } }"
    ok "managed-Venice billing wired into openclaw.json (model venice/${OC_MODEL})"
  elif [ -n "${HIVRA_MODEL_KEY:-}" ]; then
    warn "managed-Venice key/model has unexpected characters — skipping billing wiring (won't write corrupt config)"
    OC_VENICE_JSON=""
  else
    OC_VENICE_JSON=""
  fi
  cat > "${OPENCLAW_CFG_DIR}/openclaw.json" <<JSON
{
  "gateway": {
    "mode": "local",
    "bind": "loopback",
    "port": ${OPENCLAW_PORT},
    "auth": { "mode": "none" },
    "controlUi": { "dangerouslyAllowHostHeaderOriginFallback": true }
  }${OC_BROWSER_JSON}${OC_VENICE_JSON}
}
JSON
  chown "${AGENT_USER}:${AGENT_USER}" "${OPENCLAW_CFG_DIR}/openclaw.json"
  chmod 600 "${OPENCLAW_CFG_DIR}/openclaw.json"
  # Harden the state dir to 0700 (config holds the venice apiKey). `openclaw security
  # audit` flags 0755 as world-listable; the gateway recreates the dir 0755 on first
  # run, so enforce here AFTER the config write.
  chmod 700 "${OPENCLAW_CFG_DIR}" || true
  ok "seeded ${OPENCLAW_CFG_DIR}/openclaw.json (loopback :${OPENCLAW_PORT}, auth=none behind the gate)"
else
  ok "existing ${OPENCLAW_CFG_DIR}/openclaw.json kept (not clobbering onboarded config)"
fi

# Gateway service: the daemon serving the Control UI on loopback :${OPENCLAW_PORT}.
# OPENCLAW_GATEWAY_TOKEN mirrors the config token (env beats some config paths).
cat > /etc/systemd/system/bux-openclaw.service <<UNIT
[Unit]
Description=Hivra OpenClaw gateway (Control UI on loopback :${OPENCLAW_PORT})
After=network-online.target
Wants=network-online.target
[Service]
User=${AGENT_USER}
Group=${AGENT_USER}
WorkingDirectory=${AGENT_HOME}
Environment=HOME=${AGENT_HOME}
Environment=PATH=/usr/local/bin:${AGENT_HOME}/.npm-global/bin:/usr/bin:/bin
Environment=OPENCLAW_GATEWAY_TOKEN=${OC_TOKEN}
ExecStart=${OPENCLAW_BIN} gateway --port ${OPENCLAW_PORT}
Restart=on-failure
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
chmod 0644 /etc/systemd/system/bux-openclaw.service

# Narrow root helper so the chat server (runs as ${AGENT_USER}, no general sudo)
# can restart/stop the gateway after a config change in the Control UI.
cat > /usr/local/bin/hivra-openclaw-apply <<'HELPER'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  restart) systemctl restart bux-openclaw.service ;;
  stop)    systemctl stop bux-openclaw.service ;;
  *) echo "usage: hivra-openclaw-apply restart|stop" >&2; exit 2 ;;
esac
HELPER
chmod 0755 /usr/local/bin/hivra-openclaw-apply
printf '%s ALL=(root) NOPASSWD: /usr/local/bin/hivra-openclaw-apply\n' "${AGENT_USER}" > /etc/sudoers.d/hivra-openclaw
chmod 0440 /etc/sudoers.d/hivra-openclaw
if ! visudo -cf /etc/sudoers.d/hivra-openclaw >/dev/null 2>&1; then warn "hivra-openclaw sudoers invalid; removing"; rm -f /etc/sudoers.d/hivra-openclaw; fi
ok "OpenClaw gateway service + restart helper installed (port ${OPENCLAW_PORT})"
fi

if [ "$AGENT_KIND" = "agent-zero" ]; then
say "5d/7  Agent Zero (autonomous agent + web dashboard, Dockerized)"
# ===========================================================================
# Agent Zero (agent0ai/agent-zero) is a general autonomous agent whose OWN web UI
# (chat + a browser + a computer canvas) IS the product. It ships as a Docker image
# serving on container :80. We run it bound LOOPBACK-ONLY and front it with the box
# token-proxy under /agent-zero — its own basic-auth login + any self-tunnel are
# never the access boundary, the gate is. It computes locally (agent loop + its own
# in-container browser), so this box carries a real footprint (2 vCPU / 4 GB).
A0_PORT="${AGENT_ZERO_PORT:-50080}"         # container :80 -> loopback host :A0_PORT (8080 is the hivra-chat gate)
A0_ROOT="/opt/a0"                           # persisted state + env live here
# Immutable multi-architecture OCI digest (v2.2 at review time). Tags are
# intentionally not accepted: a mutable tag cannot be a release contract.
A0_IMAGE="agent0ai/agent-zero@${AGENT_ZERO_IMAGE_DIGEST}"

# --- Docker engine (boxes are full VMs — no LXC-nesting problem here) ---
if ! command -v docker >/dev/null 2>&1; then
  say "installing Docker from Ubuntu's signed package repository"
  apt-get install -y docker.io || die "docker.io package installation failed"
fi
systemctl enable --now docker >/dev/null 2>&1 || die "Docker service did not start"
systemctl is-active --quiet docker || die "Docker service is not active"
ok "docker present ($(docker --version 2>/dev/null | head -1 || echo '?'))"

# --- Persisted state + basic-auth + (optional) managed model -> /opt/a0/.env ---
install -d -m 0755 "${A0_ROOT}"
install -d -m 0777 "${A0_ROOT}/usr"         # the container writes as its own uid; keep it writable
# Basic-auth login gates Agent Zero's OWN web UI (a second layer behind our token
# gate). Seed a known login so an unconfigured prompt never blocks the user; stored
# root-readable for the orchestrator, like the box api-token.
if [ ! -s "${AGENT_HOME}/.hivra/agent-zero-login" ]; then
  install -d -o "${AGENT_USER}" -g "${AGENT_USER}" -m 0755 "${AGENT_HOME}/.hivra"
  A0_LOGIN="hivra"
  A0_PASS="$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  printf 'AUTH_LOGIN=%s\nAUTH_PASSWORD=%s\n' "$A0_LOGIN" "$A0_PASS" > "${AGENT_HOME}/.hivra/agent-zero-login"
  chown "${AGENT_USER}:${AGENT_USER}" "${AGENT_HOME}/.hivra/agent-zero-login"
  chmod 600 "${AGENT_HOME}/.hivra/agent-zero-login"
fi
# Build /opt/a0/.env from the seeded login + (optional) managed-Venice model. Venice
# is OpenAI-compatible → point Agent Zero's OpenAI provider at the managed gateway.
# The user can still switch providers inside Agent Zero's own Settings.
# NOTE: this block's stdout IS the .env file — emit ONLY env lines here (no ok/warn,
# whose output would land in the file and make docker --env-file/dotenv choke).
{
  cat "${AGENT_HOME}/.hivra/agent-zero-login"
  if [ -n "${HIVRA_MODEL_KEY:-}" ] && printf '%s' "${HIVRA_MODEL_KEY}" | grep -qE '^[A-Za-z0-9_-]+$'; then
    A0_MODEL="${HIVRA_HERMES_MODEL:-deepseek-v4-pro}"
    A0_BASEURL="${HIVRA_MODEL_BASE_URL:-https://hivra.cloud/api/managed-venice/v1}"
    # Managed Venice is OpenAI-compatible: Agent Zero models it as provider "openai"
    # with a custom api_base. A0_SET_<setting> seeds Agent Zero's settings.json
    # defaults (exact lowercase field names from its model-config schema —
    # chat_model_provider/name/api_base + util_model_*); API_KEY_OPENAI supplies the
    # key. `chat_model_api_base` is the critical one — without it the openai provider
    # would hit real OpenAI, not Venice. The user can still change any of this in
    # Agent Zero's own Settings (settings.json then wins over these defaults).
    printf 'API_KEY_OPENAI=%s\n' "${HIVRA_MODEL_KEY}"
    printf 'A0_SET_chat_model_provider=openai\n'
    printf 'A0_SET_chat_model_name=%s\n' "${A0_MODEL}"
    printf 'A0_SET_chat_model_api_base=%s\n' "${A0_BASEURL}"
    printf 'A0_SET_util_model_provider=openai\n'
    printf 'A0_SET_util_model_name=%s\n' "${A0_MODEL}"
    printf 'A0_SET_util_model_api_base=%s\n' "${A0_BASEURL}"
  fi
} > "${A0_ROOT}/.env"
chmod 600 "${A0_ROOT}/.env"
if [ -n "${HIVRA_MODEL_KEY:-}" ] && printf '%s' "${HIVRA_MODEL_KEY}" | grep -qE '^[A-Za-z0-9_-]+$'; then
  ok "managed-Venice seeded into Agent Zero /opt/a0/.env (model ${HIVRA_HERMES_MODEL:-deepseek-v4-pro})"
else
  warn "no managed-Venice key at launch — Agent Zero starts unconfigured; set a model in its Settings UI"
fi

# Pre-pull the pinned image so the unit's first `docker run` starts fast.
docker pull "${A0_IMAGE}" >/tmp/az-pull.log 2>&1 \
  || die "Agent Zero image pull failed (see /tmp/az-pull.log)"
docker image inspect "${A0_IMAGE}" >/dev/null 2>&1 \
  || die "Agent Zero image digest is unavailable after pull"

# --- systemd unit: run the pinned image loopback-bound, env + state mounted ---
cat > /etc/systemd/system/hivra-agent-zero.service <<UNIT
[Unit]
Description=Hivra Agent Zero (agent0ai/agent-zero on 127.0.0.1:${A0_PORT}, mounted at /agent-zero)
After=network-online.target docker.service
Requires=docker.service
[Service]
TimeoutStartSec=0
Restart=always
RestartSec=5
ExecStartPre=-/usr/bin/docker rm -f hivra-agent-zero
ExecStart=/usr/bin/docker run --rm --name hivra-agent-zero -v ${A0_ROOT}/.env:/a0/.env -v ${A0_ROOT}/usr:/a0/usr -p 127.0.0.1:${A0_PORT}:80 ${A0_IMAGE}
ExecStop=/usr/bin/docker stop hivra-agent-zero
[Install]
WantedBy=multi-user.target
UNIT
chmod 0644 /etc/systemd/system/hivra-agent-zero.service

# Scoped restart helper (the box user has no general sudo).
cat > /usr/local/bin/hivra-agent-zero-apply <<'HELPER'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  restart) systemctl restart hivra-agent-zero.service ;;
  stop)    systemctl stop hivra-agent-zero.service ;;
  *) echo "usage: hivra-agent-zero-apply restart|stop" >&2; exit 2 ;;
esac
HELPER
chmod 0755 /usr/local/bin/hivra-agent-zero-apply
printf '%s ALL=(root) NOPASSWD: /usr/local/bin/hivra-agent-zero-apply\n' "${AGENT_USER}" > /etc/sudoers.d/hivra-agent-zero
chmod 0440 /etc/sudoers.d/hivra-agent-zero
if ! visudo -cf /etc/sudoers.d/hivra-agent-zero >/dev/null 2>&1; then warn "hivra-agent-zero sudoers invalid; removing"; rm -f /etc/sudoers.d/hivra-agent-zero; fi
ok "Agent Zero service + restart helper installed (container :80 -> 127.0.0.1:${A0_PORT})"
fi

# ===========================================================================
if [ "$AGENT_KIND" = "deepseek-harness" ]; then
  # Fresh base only (the typed caller rejects pre-existing bases). Do not
  # replace the upstream DeepSeek persona or uninstall other agent packages.
  ok "native DeepSeek profile owns its instructions; leaving base packages intact"
elif [ "$AGENT_KIND" != "aeon" ] && [ "$AGENT_KIND" != "openclaw" ] && [ "$AGENT_KIND" != "agent-zero" ] && [ "$AGENT_KIND" != "linux-desktop" ]; then
say "6/7  Hivra system prompt (clean assistant persona)"
# ===========================================================================
# bux's installer wrote /home/bux/system-prompt.md (Telegram/agency persona) and
# symlinked ~/CLAUDE.md + ~/AGENTS.md to it. claude reads ~/CLAUDE.md, codex reads
# ~/AGENTS.md (the hivra-chat server runs the CLI with cwd=$HOME), so overwriting
# this one file rebrands BOTH agents. We replace the content but KEEP the symlinks.
# Codex boxes get a codex-flavored persona (no browser section); claude boxes
# get the browser-aware one. Falls back to the claude prompt if the codex
# variant is missing.
PROMPT_SRC="system-prompt.md"
if [ "$AGENT_KIND" = "codex" ] && [ -f "$SRC_DIR/system-prompt-codex.md" ]; then
  PROMPT_SRC="system-prompt-codex.md"
fi
install -o "${AGENT_USER}" -g "${AGENT_USER}" -m 0644 \
  "$SRC_DIR/$PROMPT_SRC" "${AGENT_HOME}/system-prompt.md"
ln -sfn "${AGENT_HOME}/system-prompt.md" "${AGENT_HOME}/CLAUDE.md"
ln -sfn "${AGENT_HOME}/system-prompt.md" "${AGENT_HOME}/AGENTS.md"
chown -h "${AGENT_USER}:${AGENT_USER}" "${AGENT_HOME}/CLAUDE.md" "${AGENT_HOME}/AGENTS.md"
ok "Hivra system prompt installed (${PROMPT_SRC}) + ~/CLAUDE.md, ~/AGENTS.md re-pointed"
else
say "6/7  strip the base installer's coding-agent cruft (${AGENT_KIND} profile)"
# ===========================================================================
# Dashboard agents and Linux Desktop never run the claude/codex CLIs, but the
# shared bux base installer built them and wrote a coding persona
# (system-prompt.md → CLAUDE.md/AGENTS.md symlinks, SOUL.md). Strip it so the
# box is a clean ${AGENT_KIND} profile. Dashboard agents keep ~/.claude/ because
# the browser stack's browser.env contract lives there; Linux Desktop removes
# that agent state below. Keep node, the access gateway and ~/.npm-global
# (OpenClaw lives there).
rm -f "${AGENT_HOME}/system-prompt.md" "${AGENT_HOME}/CLAUDE.md" "${AGENT_HOME}/AGENTS.md" \
      "${AGENT_HOME}/SOUL.md" "${AGENT_HOME}/.claude.json" 2>/dev/null || true
rm -rf "${AGENT_HOME}/.codex" 2>/dev/null || true
# Uninstall the coding CLIs: codex = the bux user's npm-global; claude = system npm
# (/usr/lib/node_modules + /usr/bin/claude). rm-fallback if npm can't resolve them.
sudo -iu "${AGENT_USER}" bash -lc 'npm uninstall -g @openai/codex >/dev/null 2>&1' || true
npm uninstall -g @anthropic-ai/claude-code >/dev/null 2>&1 || true
rm -rf /usr/lib/node_modules/@anthropic-ai/claude-code /usr/bin/claude 2>/dev/null || true
if [ "$AGENT_KIND" = "linux-desktop" ]; then
  # No browser automation or agent skill contract survives on a plain computer.
  rm -rf "${AGENT_HOME}/.claude" "${AGENT_HOME}/.agents" 2>/dev/null || true
  ok "${AGENT_KIND} box — stripped claude/codex CLIs, agent state and persona docs"
else
  ok "${AGENT_KIND} box — stripped claude/codex CLIs + persona docs (kept .claude/browser.env)"
fi
fi

# Native terminal setup belongs to the guest, not the Proxmox host. Provider
# VMs and direct guest installs need the same CLI, box shell and access paths.
install_native_terminals() {
  [ -x /usr/local/bin/ttyd ] || die "ttyd is missing after the base installation"
  install -o root -g root -m 0755 "$SRC_DIR/hivra-agent-shell" /usr/local/bin/hivra-agent-shell
  install -d -o root -g root -m 0755 /etc/systemd/system/bux-ttyd.service.d
  install -o root -g root -m 0644 "$SRC_DIR/bux-ttyd-base-path.conf" /etc/systemd/system/bux-ttyd.service.d/base-path.conf
  install -o root -g root -m 0644 "$SRC_DIR/bux-box-ttyd.service" /etc/systemd/system/bux-box-ttyd.service
  if [ "${AGENT_KIND:-}" = "linux-desktop" ]; then
    sed -i 's#^WorkingDirectory=.*#WorkingDirectory=/home/bux/Hivra#' \
      /etc/systemd/system/bux-ttyd.service.d/base-path.conf \
      /etc/systemd/system/bux-box-ttyd.service
  fi
}
start_native_terminals() {
  systemctl enable bux-ttyd.service bux-box-ttyd.service
  systemctl restart bux-ttyd.service bux-box-ttyd.service
}
install_native_terminals

# ===========================================================================
say "7/7  enable + start the services"
# ===========================================================================
systemctl daemon-reload
start_native_terminals
if [ "$WANT_BROWSER" = 1 ]; then
  systemctl enable --now hivra-xvfb.service hivra-x11vnc.service hivra-novnc.service
  systemctl enable --now bux-local-browser.service
  ok "browser-view stack + bux-local-browser enabled and started"
else
  # Make sure a stray browser keeper isn't running on a codex box.
  systemctl disable --now bux-local-browser.service >/dev/null 2>&1 || true
fi
if [ "$AGENT_KIND" != "deepseek-harness" ] && [ "$PROVIDER_DESKTOP_PREPARE_ONLY" != 1 ]; then
  systemctl enable --now bux-hivra-chat.service
  ok "bux-hivra-chat enabled and started"
fi
if [ "$AGENT_KIND" = "aeon" ]; then
  systemctl enable --now bux-aeon.service >/dev/null 2>&1 \
    || die "Aeon service did not start"
  ok "bux-aeon enabled + started (dashboard on :${AEON_DASHBOARD_PORT:-5555}, mounted at /aeon)"
fi
if [ "$AGENT_KIND" = "openclaw" ]; then
  systemctl enable --now bux-openclaw.service >/dev/null 2>&1 \
    || die "OpenClaw service did not start"
  ok "bux-openclaw enabled + started (Control UI on :${OPENCLAW_GATEWAY_PORT:-18789}, mounted at /openclaw)"
fi

if [ "$AGENT_KIND" = "agent-zero" ]; then
  systemctl enable --now hivra-agent-zero.service >/dev/null 2>&1 \
    || die "Agent Zero service did not start"
  ok "hivra-agent-zero enabled + started (dashboard on 127.0.0.1:${AGENT_ZERO_PORT:-8080}, mounted at /agent-zero)"
fi

# --- post-flight ------------------------------------------------------------
echo
say "post-flight checks"
wait_for_http() {
  local url="$1" code
  for _ in $(seq 1 60); do
    code="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || true)"
    case "$code" in 2??|3??|401|403) return 0 ;; esac
    sleep 2
  done
  return 1
}
wait_for_exact_http_200() {
  local url="$1" code
  for _ in $(seq 1 60); do
    code="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || true)"
    [ "$code" = 200 ] && return 0
    sleep 2
  done
  return 1
}
wait_for_unix_http_200() {
  local socket="$1" url="$2" code
  for _ in $(seq 1 60); do
    code="$(curl -sS --max-time 5 --unix-socket "$socket" -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || true)"
    [ "$code" = 200 ] && return 0
    sleep 2
  done
  return 1
}
verify_native_terminals() {
  local unit
  for unit in bux-ttyd.service bux-box-ttyd.service; do
    systemctl is-active --quiet "$unit" || die "native terminal service is not active: $unit"
  done
  # Both terminals listen only on bux-owned unix sockets (no loopback port).
  wait_for_unix_http_200 /run/hivra-terminal/ttyd.sock 'http://localhost/terminal/' \
    || die "agent terminal did not pass its socket readiness check"
  wait_for_unix_http_200 /run/hivra-box-terminal/ttyd.sock 'http://localhost/box-terminal/' \
    || die "box terminal did not pass its socket readiness check"
}
wait_for_browser_ready() {
  local env_file="$1" cdp_port="$2" cdp_code novnc_code unit units_ready
  for _ in $(seq 1 60); do
    units_ready=1
    for unit in hivra-xvfb.service hivra-x11vnc.service hivra-novnc.service bux-local-browser.service; do
      if ! systemctl is-active --quiet "$unit"; then
        units_ready=0
        break
      fi
    done
    if [ "$units_ready" = 1 ] \
      && [ -s "$env_file" ] \
      && grep -Eq "^BU_CDP_WS=ws://127\\.0\\.0\\.1:${cdp_port}/devtools/browser/[A-Za-z0-9._-]+$" "$env_file"; then
      cdp_code="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' \
        "http://127.0.0.1:${cdp_port}/json/version" 2>/dev/null || true)"
      novnc_code="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' \
        'http://127.0.0.1:6080/vnc.html' 2>/dev/null || true)"
      [ "$cdp_code" = 200 ] && [ "$novnc_code" = 200 ] && return 0
    fi
    sleep 2
  done
  return 1
}
verify_native_terminals
if [ "$WANT_BROWSER" = 1 ]; then
  if ! wait_for_browser_ready "${AGENT_HOME}/.claude/browser.env" "${CDP_PORT}"; then
    for unit in hivra-xvfb.service hivra-x11vnc.service hivra-novnc.service bux-local-browser.service; do
      journalctl -u "$unit" -n 50 --no-pager >&2 2>/dev/null || true
    done
    die "browser automation and live view did not become ready"
  fi
  ok "browser automation and live view passed local readiness"
fi
if [ "$AGENT_KIND" = "deepseek-harness" ] || [ "$PROVIDER_DESKTOP_PREPARE_ONLY" = 1 ]; then
  # Return to the same lock-owning Python entrypoint. It publishes the pinned
  # native runtime, immutable gateway, origin and service before readiness and
  # runtime receipt generation. This base pass is not a completed launch.
  ok "native guest base prepared; returning to the shared installer"
  exit 0
fi
systemctl is-active --quiet bux-hivra-chat.service || die "hivra-chat service is not active"
if ! wait_for_exact_http_200 "http://127.0.0.1:${HIVRA_CHAT_PORT}/healthz"; then
  journalctl -u bux-hivra-chat.service -n 50 --no-pager >&2 2>/dev/null || true
  die "hivra-chat health endpoint is not ready"
fi
ok "hivra-chat answering on 127.0.0.1:${HIVRA_CHAT_PORT}/healthz"

if [ "$AGENT_KIND" = "linux-desktop" ]; then
  say "Linux Desktop capability installation"
  REMOTE_DESKTOP_RESULT="$(python3 -I -B "$SRC_DIR/remote-desktop/install-guest.py" \
    --apply \
    --computer-kind hivra-agent \
    --computer-id "$HIVRA_COMPUTER_ID" \
    --control-origin "$HIVRA_CONTROL_ORIGIN" \
    --public-origin "$HIVRA_PUBLIC_ORIGIN" \
    --source-dir "$SRC_DIR/remote-desktop")" \
    || die "Linux Desktop capability installation failed"
  [[ "$REMOTE_DESKTOP_RESULT" != *$'\n'* ]] \
    || die "Linux Desktop capability receipt has unexpected output"
  printf '%s\n' "$REMOTE_DESKTOP_RESULT" \
    | grep -Eq '^HIVRA_REMOTE_DESKTOP_INSTALLED \{"capabilityGeneration":"[0-9a-f-]{36}","computerId":"[0-9a-f-]{36}","computerKind":"hivra-agent","observedRevision":"[0-9a-f]{64}","protocol":"hivra-remote-desktop-installed-v1","transport":"selkies-websocket"\}$' \
    || die "Linux Desktop capability receipt is invalid"
  ok "Linux Desktop capability installed before computer readiness"
fi

if [ "$AGENT_KIND" = "aeon" ]; then
  systemctl is-active --quiet bux-aeon.service || die "Aeon service is not active"
  wait_for_http "http://127.0.0.1:${AEON_PORT}/aeon/" || die "Aeon dashboard did not become ready"
  ok "Aeon dashboard passed runtime-specific readiness"
elif [ "$AGENT_KIND" = "openclaw" ]; then
  systemctl is-active --quiet bux-openclaw.service || die "OpenClaw service is not active"
  wait_for_http "http://127.0.0.1:${OPENCLAW_PORT}/" || die "OpenClaw Control UI did not become ready"
  ok "OpenClaw passed runtime-specific readiness"
elif [ "$AGENT_KIND" = "agent-zero" ]; then
  systemctl is-active --quiet hivra-agent-zero.service || die "Agent Zero service is not active"
  wait_for_http "http://127.0.0.1:${A0_PORT}/" || die "Agent Zero dashboard did not become ready"
  docker inspect -f '{{.State.Running}}' hivra-agent-zero 2>/dev/null | grep -Fxq true \
    || die "Agent Zero container is not running"
  ok "Agent Zero passed runtime-specific readiness"
fi

# Record the exact installed state after every runtime-specific readiness gate.
# This private receipt deliberately excludes credentials, user files, browser
# profiles, process environments and command lines. It is evidence for a later
# release review, not an automatic release or redistribution approval.
BUNDLE_VERSION="$(tr -d '[:space:]' < "$SRC_DIR/VERSION")"
RECEIPT_ARGS=(
  --provisioner-version "$BUNDLE_VERSION"
  --agent-kind "$AGENT_KIND"
  --substrate "$COMPUTER_SUBSTRATE"
  --browser-enabled "$WANT_BROWSER"
)
if [ "$AGENT_KIND" = "agent-zero" ]; then
  RECEIPT_ARGS+=(--agent-zero-image "$A0_IMAGE")
fi
RECEIPT_RESULT="$(python3 "$SRC_DIR/hivra-runtime-receipt.py" "${RECEIPT_ARGS[@]}")" \
  || die "installed runtime receipt generation failed"
printf '%s\n' "$RECEIPT_RESULT" | grep -Eq '^HIVRA_RUNTIME_RECEIPT_V1 sha256=[0-9a-f]{64} packages=[1-9][0-9]* sbomSha256=[0-9a-f]{64} sbomComponents=[1-9][0-9]* noticeSha256=[0-9a-f]{64}$' \
  || die "installed runtime receipt marker is invalid"
(cd /var/lib/hivra && sha256sum -c --status runtime-receipt.sha256 \
  && sha256sum -c --status runtime-sbom.sha256 \
  && sha256sum -c --status runtime-notice-manifest.sha256) \
  || die "installed runtime evidence checksum verification failed"
ok "$RECEIPT_RESULT"

if [ "$AGENT_KIND" = "aeon" ]; then
  LOGIN_HINT="sudo -iu ${AGENT_USER} gh auth login   (or paste a PAT in the dashboard Connect step)"
  STATUS_HINT="sudo -iu ${AGENT_USER} gh auth status"
elif [ "$AGENT_KIND" = "openclaw" ]; then
  LOGIN_HINT="open the Control UI (/openclaw) and configure model providers + channels there"
  STATUS_HINT="systemctl status bux-openclaw --no-pager; curl -fsS http://127.0.0.1:${OPENCLAW_GATEWAY_PORT:-18789}/ -o /dev/null -w '%{http_code}\n'"
elif [ "$AGENT_KIND" = "agent-zero" ]; then
  LOGIN_HINT="open the dashboard (/agent-zero) — a managed model is pre-seeded; change it in Agent Zero's Settings if you prefer your own"
  STATUS_HINT="systemctl status hivra-agent-zero --no-pager; docker logs --tail 40 hivra-agent-zero 2>&1 | tail -40; curl -fsS http://127.0.0.1:${AGENT_ZERO_PORT:-8080}/ -o /dev/null -w '%{http_code}\n'"
elif [ "$AGENT_KIND" = "linux-desktop" ]; then
  LOGIN_HINT="none — Linux Desktop has no agent account login"
  STATUS_HINT="systemctl status bux-hivra-chat bux-ttyd bux-box-ttyd --no-pager"
elif [ "$AGENT_KIND" = "codex" ]; then
  LOGIN_HINT="sudo -iu ${AGENT_USER} codex login --device-auth"
  STATUS_HINT="sudo -iu ${AGENT_USER} codex login status"
else
  LOGIN_HINT="sudo -iu ${AGENT_USER} claude auth login"
  STATUS_HINT="sudo -iu ${AGENT_USER} claude auth status"
fi

cat <<EOF

${c_green}${c_bold}Provisioning complete (${AGENT_KIND}).${c_reset}

  Account setup:

      ${c_bold}${LOGIN_HINT}${c_reset}

  Then verify with:

      ${STATUS_HINT}

  The Hivra gateway at :${HIVRA_CHAT_PORT} exposes only the authenticated
  surfaces supported by ${AGENT_KIND}.$([ "$AGENT_KIND" = "linux-desktop" ] && echo " Agent chat and agent login are disabled." || echo "")

  ${c_dim}Exposure (chat) is intentionally NOT configured here — see README
  for the cloudflared --protocol http2 / named-tunnel / Caddy options.${c_reset}
EOF
