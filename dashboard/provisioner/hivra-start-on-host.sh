#!/usr/bin/env bash
# hivra-start-on-host.sh — run ON a pve host as root. Starts (or restarts) a
# Hivra agent VM, waits for its chat server, re-establishes the cloudflared
# tunnel (quick tunnels get a fresh URL each time), and atomically writes a
# result to the exact lifecycle log selected by the caller so the dashboard
# poll can prove the operation receipt before returning the agent to running.
#
# Usage: hivra-start-on-host.sh VMID [OCTET]
set -euo pipefail
umask 077

VMID="${1:?usage: hivra-start-on-host.sh VMID [OCTET]}"
OCTET="${2:-$((VMID - 1000))}"
SUBNET_PREFIX="${HIVRA_SUBNET_PREFIX:-10.251.20}"
CHAT_PORT="${HIVRA_CHAT_PORT:-8080}"
VM_KEY="${HIVRA_VM_SSH_KEY_PATH:-/etc/hivra/keys/vm-orchestrator}"
PROVISIONER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSH_IDENTITY_HELPER="${HIVRA_GUEST_SSH_IDENTITY_HELPER:-${PROVISIONER_DIR}/hivra-guest-ssh-known-hosts}"
IP="${SUBNET_PREFIX}.${OCTET}"
LOG_DIR="${HIVRA_LOG_DIR:-/var/log/hivra}"
RESULT_LOG_PATH="${HIVRA_RESULT_LOG_PATH:-${LOG_DIR}/provision-${VMID}.log}"
CLOUDFLARED_VERSION="${CLOUDFLARED_VERSION:-2026.8.2}"
CLOUDFLARED_LINUX_AMD64_SHA256="${CLOUDFLARED_LINUX_AMD64_SHA256:-fcfb02b575a52ca1af2e3267af4e1517bcdeb30ac48c834c69abaed3c0576ad2}"
BINDING_TAG="${HIVRA_BINDING_TAG:-}"
BINDING_TAG_ENFORCED="${HIVRA_BINDING_TAG_ENFORCED:-1}"
LIFECYCLE_LOCK_FD="${HIVRA_LIFECYCLE_LOCK_FD:-}"
HOST_RESERVE_MB="${HIVRA_HOST_MEMORY_RESERVE_MB:-2048}"
ENFORCE_CEILINGS="${HIVRA_ENFORCE_CEILING_DENSITY:-0}"
CPU_DENSITY_MILLI="${HIVRA_CPU_CEILING_DENSITY_MILLI:-1000}"
MEMORY_DENSITY_MILLI="${HIVRA_MEMORY_CEILING_DENSITY_MILLI:-1000}"
install -d -m 0750 "$LOG_DIR"
case "$RESULT_LOG_PATH" in
  "${LOG_DIR}/provision-${VMID}.log"|"${LOG_DIR}/start-${VMID}.log"|"${LOG_DIR}/hivra-start-${VMID}.log") ;;
  *) echo "invalid lifecycle result log path" >&2; exit 1 ;;
esac
LOG="$RESULT_LOG_PATH"
OPERATION_ID="${HIVRA_OPERATION_ID:-}"

[[ "$VMID" =~ ^[0-9]+$ ]] && [ "$VMID" -ge 100 ] || { echo "invalid VMID" >&2; exit 1; }
[[ "$OCTET" =~ ^[0-9]+$ ]] && [ "$OCTET" -ge 2 ] && [ "$OCTET" -le 254 ] || { echo "invalid IP octet" >&2; exit 1; }

# Agent-run reporter credential (docs/superpowers/specs/2026-09-22-agent-run-tracing-contract.md).
# The control plane stages it only for Claude Code / Codex computers, in a
# root-only file bound to this VMID. Consume and delete it before any later exit
# path and keep it in memory only (never argv, env or logs). The reporter step
# can never fail or hold up the start: every outcome is exactly one
# HIVRA_ACTIVITY_COLLECTOR line in the published result.
ACTIVITY_TELEMETRY_FILE="${HIVRA_ACTIVITY_TELEMETRY_FILE:-}"
ACTIVITY_CREDENTIAL_JSON=""
ACTIVITY_COLLECTOR_STATUS=""
read_activity_credential() {
  local file="$1" size line encoded
  [ -f "$file" ] && [ ! -L "$file" ] || return 1
  [ "$(stat -c '%a:%U:%G' "$file" 2>/dev/null)" = "600:root:root" ] || return 1
  size="$(stat -c '%s' "$file" 2>/dev/null)"
  [[ "$size" =~ ^[0-9]+$ ]] && [ "$size" -le 16384 ] || return 1
  line="$(grep -m1 -E '^HIVRA_ACTIVITY_TELEMETRY_B64=' "$file" 2>/dev/null)" || return 1
  encoded="${line#*=}"
  [[ "$encoded" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] || return 1
  printf '%s' "$encoded" | base64 -d 2>/dev/null | python3 -I -B -c '
import json, re, sys
raw = sys.stdin.buffer.read(8193)
if len(raw) > 8192:
    sys.exit(1)
try:
    doc = json.loads(raw.decode("utf-8"))
except ValueError:
    sys.exit(1)
keys = {"endpoint", "resourceId", "token", "expiresAt"}
if not isinstance(doc, dict) or set(doc) != keys or not all(isinstance(doc[k], str) for k in keys):
    sys.exit(1)
if (not re.fullmatch(r"https://[a-z0-9.-]+(:[0-9]{1,5})?/api/activity/ingest", doc["endpoint"])
        or not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", doc["resourceId"])
        or len(doc["token"]) > 4096
        or not re.fullmatch(r"hvra_otlp_v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", doc["token"])
        or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z", doc["expiresAt"])):
    sys.exit(1)
sys.stdout.write(json.dumps(doc, separators=(",", ":")))
' 2>/dev/null
}
if [ -n "$ACTIVITY_TELEMETRY_FILE" ]; then
  ACTIVITY_COLLECTOR_STATUS="status=failed reason=invalid_input"
  # Never follow or delete a caller-chosen path outside the exact VMID slot.
  if [[ "$ACTIVITY_TELEMETRY_FILE" =~ ^/run/hivra-lifecycle/${VMID}\.activity\.env$ ]]; then
    if ACTIVITY_CREDENTIAL_JSON="$(read_activity_credential "$ACTIVITY_TELEMETRY_FILE")" \
      && [ -n "$ACTIVITY_CREDENTIAL_JSON" ]; then
      ACTIVITY_COLLECTOR_STATUS="status=failed reason=not_attempted"
    else
      ACTIVITY_CREDENTIAL_JSON=""
    fi
    rm -f -- "$ACTIVITY_TELEMETRY_FILE" 2>/dev/null || true
  fi
fi
[[ "$CHAT_PORT" =~ ^[0-9]+$ ]] && [ "$CHAT_PORT" -ge 1 ] && [ "$CHAT_PORT" -le 65535 ] || { echo "invalid chat port" >&2; exit 1; }
case "$CLOUDFLARED_VERSION" in *[!0-9.]*|'') echo "invalid cloudflared version" >&2; exit 1 ;; esac
[[ "$CLOUDFLARED_LINUX_AMD64_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid cloudflared checksum" >&2; exit 1; }
case "$BINDING_TAG_ENFORCED" in 0|1) ;; *) echo "invalid binding-tag policy" >&2; exit 1 ;; esac
if [ "$BINDING_TAG_ENFORCED" = "1" ]; then
  [[ "$BINDING_TAG" =~ ^hivra-bind-[0-9a-f]{32}$ ]] || { echo "invalid Hivra binding tag" >&2; exit 1; }
else
  [ -z "$BINDING_TAG" ] || { echo "legacy binding-tag exception must not carry a tag" >&2; exit 1; }
fi
if [ -n "$OPERATION_ID" ]; then
  [[ "$OPERATION_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] \
    || { echo "invalid lifecycle operation id" >&2; exit 1; }
fi
[ -f "$VM_KEY" ] || { echo "VM ssh key is missing" >&2; exit 1; }
[ -f "$SSH_IDENTITY_HELPER" ] && [ ! -L "$SSH_IDENTITY_HELPER" ] && [ -x "$SSH_IDENTITY_HELPER" ] \
  || { echo "guest SSH identity helper is missing or unsafe" >&2; exit 1; }

publish_result() {
  local result="$1" tmp="${LOG}.tmp.$$"
  install -m 0600 /dev/null "$tmp"
  if [ -n "$OPERATION_ID" ]; then
    printf 'HIVRA_OPERATION_ID %s\n' "$OPERATION_ID" >> "$tmp"
  fi
  if [ -n "$ACTIVITY_COLLECTOR_STATUS" ]; then
    printf 'HIVRA_ACTIVITY_COLLECTOR %s\n' "$ACTIVITY_COLLECTOR_STATUS" >> "$tmp"
  fi
  printf '%s\n' "$result" >> "$tmp"
  mv -f -- "$tmp" "$LOG"
}

release_lifecycle_lock() {
  if [ "$LIFECYCLE_LOCK_FD" = "8" ]; then
    flock -u 8 2>/dev/null || true
    exec 8>&-
    LIFECYCLE_LOCK_FD=""
  fi
}
trap release_lifecycle_lock EXIT
if [ "$LIFECYCLE_LOCK_FD" != "8" ]; then
  install -d -m 0755 /run/lock
  exec 8>/run/lock/hivra-allocation.lock
  flock -w 60 8 || { echo "timed out waiting for the Hivra lifecycle lock" >&2; exit 1; }
  LIFECYCLE_LOCK_FD=8
fi

qm status "$VMID" >/dev/null 2>&1 || { echo "VMID $VMID does not exist" >&2; exit 1; }
if [ "$BINDING_TAG_ENFORCED" = "1" ]; then
  TAGS="$(qm config "$VMID" 2>/dev/null | sed -n 's/^tags:[[:space:]]*//p')"
  printf '%s\n' "$TAGS" | tr ';' '\n' | grep -Fxq "$BINDING_TAG" \
    || { echo "refusing to start VMID $VMID without its exact Hivra binding tag" >&2; exit 1; }
fi
CURRENT_STATUS="$(qm status "$VMID" 2>/dev/null | awk '{print $2}')"
if [ "$CURRENT_STATUS" != "running" ]; then
  TARGET_CONFIG="$(qm config "$VMID" 2>/dev/null)" || { echo "could not inspect target capacity" >&2; exit 1; }
  TARGET_FLOOR_MB="$(printf '%s\n' "$TARGET_CONFIG" | awk '$1=="balloon:" {print $2; exit}')"
  [[ "$TARGET_FLOOR_MB" =~ ^[0-9]+$ ]] && [ "$TARGET_FLOOR_MB" -gt 0 ] \
    || TARGET_FLOOR_MB="$(printf '%s\n' "$TARGET_CONFIG" | awk '$1=="memory:" {print $2; exit}')"
  TARGET_MAX_MB="$(printf '%s\n' "$TARGET_CONFIG" | awk '$1=="memory:" {print $2; exit}')"
  TARGET_MAX_CPU="$(printf '%s\n' "$TARGET_CONFIG" | awk '$1=="cpulimit:" {print $2; exit}')"
  if ! [[ "$TARGET_MAX_CPU" =~ ^[0-9]+([.][0-9]+)?$ ]] || [ "$TARGET_MAX_CPU" = "0" ]; then
    TARGET_CORES="$(printf '%s\n' "$TARGET_CONFIG" | awk '$1=="cores:" {print $2; exit}')"
    TARGET_SOCKETS="$(printf '%s\n' "$TARGET_CONFIG" | awk '$1=="sockets:" {print $2; exit}')"
    [ -n "$TARGET_SOCKETS" ] || TARGET_SOCKETS=1
    [[ "$TARGET_CORES" =~ ^[0-9]+$ ]] && [ "$TARGET_CORES" -gt 0 ] \
      && [[ "$TARGET_SOCKETS" =~ ^[0-9]+$ ]] && [ "$TARGET_SOCKETS" -gt 0 ] \
      || { echo "could not inspect target CPU maximum" >&2; exit 1; }
    TARGET_MAX_CPU="$((TARGET_CORES * TARGET_SOCKETS))"
  fi
  bash "${PROVISIONER_DIR}/hivra-host-capacity-admission" "$VMID" "$TARGET_FLOOR_MB" "$TARGET_MAX_MB" "$TARGET_MAX_CPU" \
    "$HOST_RESERVE_MB" "$ENFORCE_CEILINGS" "$CPU_DENSITY_MILLI" "$MEMORY_DENSITY_MILLI" 0
fi
if [ "$CURRENT_STATUS" != "running" ]; then qm start "$VMID" >/dev/null; fi
release_lifecycle_lock
trap - EXIT

GUEST_SSH_IDENTITY_DIR="$(mktemp -d "/run/hivra-guest-ssh-identity.${VMID}.XXXXXXXX")"
chmod 0700 "$GUEST_SSH_IDENTITY_DIR"
cleanup_guest_ssh_identity() { rm -rf -- "$GUEST_SSH_IDENTITY_DIR"; }
trap cleanup_guest_ssh_identity EXIT
"$SSH_IDENTITY_HELPER" "$VMID" "$IP" "$GUEST_SSH_IDENTITY_DIR"
GSSH=(ssh -i "$VM_KEY" -o BatchMode=yes -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes -o HostKeyAlgorithms=ssh-ed25519 -o UpdateHostKeys=no \
  -o GlobalKnownHostsFile=/dev/null -o UserKnownHostsFile="$GUEST_SSH_IDENTITY_DIR/known_hosts" \
  -o HostKeyAlias="hivra-vmid-$VMID" -o ConnectTimeout=10)

# wait for the box to boot + its chat server to answer
GUEST_READY=0
for _ in $(seq 1 48); do
  if "${GSSH[@]}" "ubuntu@${IP}" 'curl -sf -o /dev/null http://127.0.0.1:'"${CHAT_PORT}"'/healthz && echo ok' 2>/dev/null | grep -q ok; then GUEST_READY=1; break; fi
  sleep 5
done
if [ "$GUEST_READY" != "1" ]; then
  publish_result "$(printf '{"vmid":%s,"ip":"%s","chat_url":"","ready":false,"error":"guest health check timed out"}' "$VMID" "$IP")"
  echo "[hivra-start] guest health check timed out for VMID $VMID" >&2
  exit 1
fi

# (Re)install the agent-run reporter with the fresh credential. This also
# backfills reporting into computers launched before it existed. Every guest
# call is time-bounded (at most ~160 s in total: the reporter's own worst case
# is ~92 s of bounded systemctl calls) and every failure only changes
# ACTIVITY_COLLECTOR_STATUS; the start itself continues regardless.
install_activity_collector() {
  local source guest_dir rc
  # Runs as root in the guest. The control plane stages a credential only for
  # Claude Code / Codex Proxmox computers, so the guest reads nothing the
  # monitored agent can write (no /home/bux selector). It unpacks the reviewed
  # reporter into a fresh root-only directory so no guest user can swap it
  # between staging and install.
  local stage='set -eu
umask 077
dir="$(mktemp -d /run/hivra-agent-trace-install.XXXXXXXX)"
if ! tar --no-same-owner --no-same-permissions -xf - -C "$dir" hivra-agent-trace.py hivra-agent-trace.service \
  || [ ! -f "$dir/hivra-agent-trace.py" ] || [ -L "$dir/hivra-agent-trace.py" ] \
  || [ ! -f "$dir/hivra-agent-trace.service" ] || [ -L "$dir/hivra-agent-trace.service" ]; then
  rm -rf -- "$dir"
  exit 4
fi
cat >/dev/null
printf "%s\n" "$dir"'
  for source in hivra-agent-trace.py hivra-agent-trace.service; do
    if [ ! -f "${PROVISIONER_DIR}/${source}" ] || [ -L "${PROVISIONER_DIR}/${source}" ]; then
      ACTIVITY_COLLECTOR_STATUS="status=failed reason=source_missing"
      return 0
    fi
  done
  guest_dir="$(tar -C "$PROVISIONER_DIR" -cf - hivra-agent-trace.py hivra-agent-trace.service \
    | timeout -k 5 20 "${GSSH[@]}" "ubuntu@${IP}" "sudo -n /bin/sh -c '${stage}'" 2>/dev/null)"
  rc=$?
  case "$rc" in
    0) ;;
    124|137) ACTIVITY_COLLECTOR_STATUS="status=failed reason=timeout"; return 0 ;;
    *) ACTIVITY_COLLECTOR_STATUS="status=failed reason=transfer_failed"; return 0 ;;
  esac
  if ! [[ "$guest_dir" =~ ^/run/hivra-agent-trace-install\.[A-Za-z0-9]{8}$ ]]; then
    ACTIVITY_COLLECTOR_STATUS="status=failed reason=transfer_failed"
    return 0
  fi
  # The credential travels only on stdin (printf is a builtin, so it never
  # appears in any argv); the guest installer validates it strictly.
  printf '%s' "$ACTIVITY_CREDENTIAL_JSON" | timeout -k 5 120 "${GSSH[@]}" "ubuntu@${IP}" \
    "sudo -n /usr/bin/python3 -I -B ${guest_dir}/hivra-agent-trace.py install --source-dir ${guest_dir}; rc=\$?; sudo -n /bin/rm -rf -- ${guest_dir}; exit \$rc" \
    >/dev/null 2>&1
  rc=$?
  if [ "$rc" = 0 ]; then
    ACTIVITY_COLLECTOR_STATUS="status=installed"
    return 0
  fi
  timeout -k 2 8 "${GSSH[@]}" "ubuntu@${IP}" "sudo -n /bin/rm -rf -- ${guest_dir}" </dev/null >/dev/null 2>&1 || true
  case "$rc" in
    124|137) ACTIVITY_COLLECTOR_STATUS="status=failed reason=timeout" ;;
    *) ACTIVITY_COLLECTOR_STATUS="status=failed reason=install_failed" ;;
  esac
  return 0
}
if [ -n "$ACTIVITY_CREDENTIAL_JSON" ]; then
  install_activity_collector || true
  ACTIVITY_CREDENTIAL_JSON=""
fi

# Named-tunnel boxes keep a STABLE URL across restarts: the hivra-cf-tunnel unit
# auto-starts on boot. Just reconnect it + report the unchanged stable URL.
NAMED="$("${GSSH[@]}" "ubuntu@${IP}" 'test -f /etc/hivra-cf-token.env && echo yes || echo no' 2>/dev/null || echo no)"
if [ "$NAMED" = "yes" ] && [ -n "${HIVRA_TUNNEL_URL:-}" ]; then
  "${GSSH[@]}" "ubuntu@${IP}" 'sudo systemctl restart hivra-cf-tunnel 2>/dev/null || true' 2>/dev/null || true
  NAMED_READY=0
  for _ in $(seq 1 24); do
    if curl -fsS -m 8 "${HIVRA_TUNNEL_URL%/}/healthz" >/dev/null 2>&1; then NAMED_READY=1; break; fi
    sleep 5
  done
  if [ "$NAMED_READY" != "1" ]; then
    publish_result "$(printf '{"vmid":%s,"ip":"%s","chat_url":"%s","ready":false,"error":"named tunnel health check timed out"}' "$VMID" "$IP" "${HIVRA_TUNNEL_URL}")"
    echo "[hivra-start] named tunnel health check timed out for VMID $VMID" >&2
    exit 1
  fi
  publish_result "$(printf '{"vmid":%s,"ip":"%s","chat_url":"%s","ready":true}' "$VMID" "$IP" "${HIVRA_TUNNEL_URL}")"
  echo "[hivra-start] vmid=$VMID NAMED tunnel chat_url=${HIVRA_TUNNEL_URL}" >&2
  exit 0
fi

# (re)establish the http2 tunnel inside the box
"${GSSH[@]}" "ubuntu@${IP}" "CLOUDFLARED_VERSION=${CLOUDFLARED_VERSION} CLOUDFLARED_LINUX_AMD64_SHA256=${CLOUDFLARED_LINUX_AMD64_SHA256} HIVRA_CHAT_PORT=${CHAT_PORT} bash -s" <<'TUN'
set -e
if ! command -v cloudflared >/dev/null 2>&1; then
  tmp="$(mktemp /tmp/cloudflared.XXXXXX)"
  trap 'rm -f -- "$tmp"' EXIT
  curl --fail --location --proto '=https' --tlsv1.2 --retry 3 \
    "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64" \
    -o "$tmp"
  printf '%s  %s\n' "$CLOUDFLARED_LINUX_AMD64_SHA256" "$tmp" | sha256sum -c - >/dev/null
  sudo install -m 0755 "$tmp" /usr/local/bin/cloudflared
  rm -f -- "$tmp"
  trap - EXIT
fi
pkill -f "cloudflared tunnel" 2>/dev/null || true
tmux kill-session -t cf 2>/dev/null || true
tmux new-session -d -s cf "cloudflared tunnel --url http://localhost:${HIVRA_CHAT_PORT} --no-autoupdate --protocol http2 2>&1 | tee /tmp/cf.log"
TUN

TUNNEL=""
for _ in $(seq 1 30); do
  TUNNEL="$("${GSSH[@]}" "ubuntu@${IP}" 'grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" /tmp/cf.log 2>/dev/null | head -1' 2>/dev/null || true)"
  if [ -n "$TUNNEL" ] && curl -fsS -m 8 "${TUNNEL%/}/healthz" >/dev/null 2>&1; then break; fi
  TUNNEL=""
  sleep 4
done

[ -n "$TUNNEL" ] && READY=true || READY=false
publish_result "$(printf '{"vmid":%s,"ip":"%s","chat_url":"%s","ready":%s}' "$VMID" "$IP" "$TUNNEL" "$READY")"
echo "[hivra-start] vmid=$VMID chat_url=${TUNNEL:-<none>} ready=$READY" >&2
[ "$READY" = true ]
