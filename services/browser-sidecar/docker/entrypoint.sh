#!/usr/bin/env bash
# Service entrypoint.
#
# The display stack (Xvfb + x11vnc + websockify) runs ALWAYS, not gated on
# SEED_MODE. Why: the resource cost is ~25 MB total RAM at idle, which is
# negligible against Chromium's ~750 MB; and gating it on a startup env flag
# means seeding only works if the operator first stops and re-ups the
# container with SEED_MODE=true — a configuration footgun that hides the
# feature when nobody remembers it exists.
#
# Inner Caddy (for standalone deploys without an outer auth proxy) is still
# gated on SEED_MODE_INNER_CADDY=true. In Hermes deployments the outer Caddy
# on the user VM forward_auths to /internal/verify-novnc-url so the inner
# Caddy is redundant and stays off.
set -euo pipefail

# Drop root before anything starts. Chromium opens untrusted sites with its
# sandbox ON, and that sandbox cannot run as root (src/browser/chromium.ts), so
# every process below runs as the unprivileged `browser` user. Root is used only
# for this one-time ownership repair: images before 2026-11 ran as root, so the
# persistent browser-state volume (profiles, cookies, logins) holds root-owned
# files the browser user must be able to open.
BROWSER_USER="${BROWSER_USER:-browser}"
if [[ "$(id -u)" == "0" ]]; then
  state_dir=/var/lib/hermes-browser
  mkdir -p "$state_dir/profiles" "$state_dir/flows" "$state_dir/screenshots"
  if [[ -n "$(find "$state_dir" ! -user "$BROWSER_USER" -print -quit)" ]]; then
    echo "[entrypoint] handing $state_dir to $BROWSER_USER"
    find "$state_dir" ! -user "$BROWSER_USER" -exec chown -h "$BROWSER_USER:$BROWSER_USER" {} +
  fi
  install -d -m 1777 /tmp/.X11-unix
  browser_home="$(getent passwd "$BROWSER_USER" | cut -d: -f6)"
  exec setpriv --reuid="$BROWSER_USER" --regid="$BROWSER_USER" --init-groups --inh-caps=-all \
    env HOME="$browser_home" USER="$BROWSER_USER" "$0" "$@"
fi

DISPLAY_NUM="${DISPLAY:-:99}"
NOVNC_PORT="${NOVNC_INTERNAL_PORT:-6080}"

echo "[entrypoint] starting supervised display stack on ${DISPLAY_NUM} -> websockify :${NOVNC_PORT}"

# Supervise the display stack: respawn each process if it exits. The container
# healthcheck only covers the Node server (:8789), so an unsupervised x11vnc or
# websockify crash silently kills the /vnc/ live view — the route 502s until the
# next redeploy (exactly the websockify-died-and-zombied bug this replaces).
# Each supervisor runs in its own subshell that waits on (and thus reaps) its
# child, so a crashed process restarts and never lingers as a zombie.
SUPERVISED_PIDS=()
supervise() {
  local name="$1"; shift
  ( while true; do
      "$@" || true
      echo "[entrypoint] ${name} exited; restarting in 1s" >&2
      sleep 1
    done ) &
  SUPERVISED_PIDS+=("$!")
}

supervise Xvfb Xvfb "${DISPLAY_NUM}" -screen 0 1280x800x24 -ac +extension RANDR

# Startup ordering (kills the boot-race flap): wait for Xvfb's X socket before
# x11vnc starts (else x11vnc fails XOpenDisplay + thrashes), then wait for
# x11vnc's :5900 before websockify (else websockify proxies to a dead VNC and
# the live view 502s while everything settles). Bounded (~10s) so a genuinely
# stuck dependency still falls through to the supervisors.
X_SOCK="/tmp/.X11-unix/X${DISPLAY_NUM#:}"
for _ in $(seq 1 50); do [[ -S "$X_SOCK" ]] && break; sleep 0.2; done

# VNC auth: when VNC_PASSWORD is set (the dashboard derives it per-instance and
# the same-origin /vnc/ viewer sends it), gate the RFB server with it so the
# open /vnc/ route isn't an unauthenticated window into the agent's browser.
# Falls back to -nopw when unset (local/dev).
if [[ -n "${VNC_PASSWORD:-}" ]]; then
  x11vnc -storepasswd "${VNC_PASSWORD}" /tmp/.vncpass >/dev/null 2>&1 || true
  X11VNC_AUTH=(-rfbauth /tmp/.vncpass)
else
  X11VNC_AUTH=(-nopw)
fi
supervise x11vnc x11vnc -display "${DISPLAY_NUM}" -forever -shared -rfbport 5900 "${X11VNC_AUTH[@]}" -quiet

# Wait for x11vnc's RFB port before starting websockify.
for _ in $(seq 1 50); do (exec 3<>/dev/tcp/127.0.0.1/5900) 2>/dev/null && break; sleep 0.2; done

# websockify serves the noVNC bundle (static) + proxies the RFB websocket to
# x11vnc on :5900. (No --idle-timeout: that was tied to the old signed-URL TTL,
# now removed; the supervisor handles any crash instead.)
supervise websockify websockify --web=/usr/share/novnc "${NOVNC_PORT}" localhost:5900

CADDY_PID=""
if [[ "${SEED_MODE_INNER_CADDY:-false}" == "true" ]]; then
  echo "[entrypoint] starting inner Caddy auth proxy (standalone deploy)"
  caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
  CADDY_PID=$!
fi

# Make DISPLAY available to the Node process so headed Playwright (during seed)
# renders into Xvfb. Headless mode ignores DISPLAY entirely, so this is a
# no-op for normal operation.
# SCRIPTURE_ANCHOR: entry-door | John 10:9 | Verse: I am the door. If anyone enters in by me, he will be saved.
export DISPLAY="${DISPLAY_NUM}"

# Agent CDP bridge: run a plain headful Chrome with the DevTools Protocol
# exposed so the hermes-agent drives it with its *native* browser tools over CDP
# (the dashboard sets AGENT_CDP_ENABLED=true + AGENT_CDP_PORT and points the
# agent's BROWSER_CDP_URL here). cdp-proxy.mjs spawns/supervises Chrome
# (remote-debugging on a private port) and publishes a docker-network-reachable,
# host-header-fixed CDP endpoint on AGENT_CDP_PORT for the agent. The Node server
# below still runs for /health (healthcheck) and /internal/verify-novnc-url (the
# dashboard noVNC viewer auth); its SessionManager stays dormant because the
# agent drives Chrome over CDP, not the /session/start tool surface.
CDP_PROXY_PID=""
# Same truthy set as src/server.ts and the sandbox-status CLI (1/true/yes/on).
cdp_flag="$(printf '%s' "${AGENT_CDP_ENABLED:-false}" | tr '[:upper:]' '[:lower:]')"
if [[ "$cdp_flag" =~ ^(1|true|yes|on)$ ]]; then
  echo "[entrypoint] agent CDP bridge enabled — Chrome on :${AGENT_CDP_PORT:-9223}, proxy on :${AGENT_CDP_PROXY_PORT:-9224}"
  node /app/cdp-proxy.mjs &
  CDP_PROXY_PID=$!
fi

# Clean up child processes on shutdown so the container exits cleanly.
cleanup() {
  if [[ ${#SUPERVISED_PIDS[@]} -gt 0 ]]; then
    kill "${SUPERVISED_PIDS[@]}" 2>/dev/null || true
  fi
  [[ -n "${CADDY_PID:-}" ]] && kill "$CADDY_PID" 2>/dev/null || true
  [[ -n "${CDP_PROXY_PID:-}" ]] && kill "$CDP_PROXY_PID" 2>/dev/null || true
}
trap cleanup EXIT

exec node dist/server.js
