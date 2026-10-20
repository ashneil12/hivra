#!/usr/bin/env bash
# Refresh the Hivra-owned guest gateway assets for one already-running Proxmox
# VM in place (the guest half is hivra-guest-runtime-update.sh; a DeepSeek
# computer gets its own owned update, deepseek-harness/update-guest.py): the chat gateway, its detached-run supervisor and unit drop-in,
# the agent terminal entrypoint and units, the agent CLI pins, and the
# root-owned Telegram connect helper the gateway runs through its scoped
# sudoers rule (never the bot token or sudoers). Only bux-hivra-chat restarts, so the
# computer, its desktop apps, agent services, tmux-backed agent terminals and
# detached chat runs keep running; proxied browser views reconnect. For a
# Claude Code / Codex computer it then re-credentials and reinstalls the
# agent-run reporter, the step the start helper performs on every boot. The
# caller owns the provider-operation lease and takes the FD8 host lock; this
# helper releases that lock once its host-side checks are done (see
# release_lifecycle_lock). It never powers the VM on/off and never touches agent
# files, native CLI credentials, model credentials, or the box API token.
#
# Stdout carries only host-authored lines: at most one HIVRA_AGENT_CLI line (the
# guest's report, re-validated here), at most one HIVRA_ACTIVITY_COLLECTOR line,
# then the final `HIVRA_GUEST_RUNTIME_UPDATED vmid=<VMID>` receipt, which is
# printed only after the guest committed the update.
set -euo pipefail
umask 077

VMID="${1:?usage: hivra-update-guest-runtime.sh VMID IP}"
IP="${2:?usage: hivra-update-guest-runtime.sh VMID IP}"
VM_KEY="${HIVRA_VM_SSH_KEY_PATH:-/etc/hivra/keys/vm-orchestrator}"
CHAT_PORT="${HIVRA_CHAT_PORT:-8080}"
PROVISIONER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARCHIVE="$(mktemp "/tmp/hivra-runtime-${VMID}.XXXXXX.tar.gz")"
GUEST_RESULT="$(mktemp "/tmp/hivra-runtime-result-${VMID}.XXXXXX")"
REMOTE_ARCHIVE="/tmp/hivra-runtime-update-${VMID}.tar.gz"
SSH_IDENTITY_HELPER="${HIVRA_GUEST_SSH_IDENTITY_HELPER:-${PROVISIONER_DIR}/hivra-guest-ssh-known-hosts}"
GUEST_SSH_IDENTITY_DIR=""
cleanup() {
  rm -f -- "$ARCHIVE" "$GUEST_RESULT"
  [ -z "$GUEST_SSH_IDENTITY_DIR" ] || rm -rf -- "$GUEST_SSH_IDENTITY_DIR"
}
trap cleanup EXIT

[[ "$VMID" =~ ^[0-9]+$ ]] && [ "$VMID" -ge 100 ] || { echo "invalid VMID" >&2; exit 1; }
[[ "$IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { echo "invalid guest IP" >&2; exit 1; }

# Agent-run reporter credential (docs/superpowers/specs/2026-09-22-agent-run-tracing-contract.md).
# A runtime update re-issues it exactly like a start, through the same root-only
# file slot bound to this VMID. This block and the reporter step below are the
# start helper's own code, kept identical by a drift test: consume and delete
# the file before any later exit path, keep the credential in memory only, and
# never let the reporter step fail the update.
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
# The caller's request deadline (epoch seconds on this host) and the FD8
# lifecycle lock it holds. Both are optional so the helper can also run by hand.
UPDATE_DEADLINE="${HIVRA_RUNTIME_UPDATE_DEADLINE:-}"
LIFECYCLE_LOCK_FD="${HIVRA_LIFECYCLE_LOCK_FD:-}"
[ -z "$UPDATE_DEADLINE" ] || [[ "$UPDATE_DEADLINE" =~ ^[0-9]{1,12}$ ]] \
  || { echo "invalid runtime update deadline" >&2; exit 1; }
case "$LIFECYCLE_LOCK_FD" in ''|8) ;; *) echo "invalid lifecycle lock descriptor" >&2; exit 1 ;; esac
# FD8 serializes host-level lifecycle work (allocation, start, stop, bundle
# sync). Everything after the host-side checks and the archive build happens in
# the guest and can wait minutes on it, so release the lock there, as the start
# helper does before it waits for a guest. The operation lease still fences
# this computer against any other lifecycle change until the update completes.
release_lifecycle_lock() {
  if [ "$LIFECYCLE_LOCK_FD" = 8 ]; then
    flock -u 8 2>/dev/null || true
    exec 8>&-
    LIFECYCLE_LOCK_FD=""
  fi
}
[[ "$CHAT_PORT" =~ ^[0-9]+$ ]] && [ "$CHAT_PORT" -ge 1 ] && [ "$CHAT_PORT" -le 65535 ] \
  || { echo "invalid chat port" >&2; exit 1; }
[ -f "$VM_KEY" ] || { echo "VM ssh key is missing" >&2; exit 1; }
[ -f "$SSH_IDENTITY_HELPER" ] && [ ! -L "$SSH_IDENTITY_HELPER" ] && [ -x "$SSH_IDENTITY_HELPER" ] \
  || { echo "guest SSH identity helper is missing or unsafe" >&2; exit 1; }
[ "$(qm status "$VMID" 2>/dev/null | awk '{print $2}')" = "running" ] \
  || { echo "VMID $VMID must be running before its runtime can be updated" >&2; exit 1; }

ASSETS=(server.js llm-application.js guarded-files.cjs agent-zero-editor.cjs chat-runs.cjs index.html app.js)
for asset in "${ASSETS[@]}"; do
  source="$PROVISIONER_DIR/hivra-chat/$asset"
  [ -f "$source" ] && [ ! -L "$source" ] \
    || { echo "runtime source asset is missing or unsafe: $asset" >&2; exit 1; }
done
# Terminal entrypoint and units, plus the agent CLI pins and their helpers.
TERMINAL_ASSETS=(hivra-agent-shell bux-ttyd-base-path.conf bux-box-ttyd.service
  agent-cli-versions.json hivra-agent-cli-update.sh hivra-codex-config-pin.py hivra-tg-apply
  hivra-claude-app.py hivra-claude-app.service claude-desktop-pin.json)
for asset in "${TERMINAL_ASSETS[@]}"; do
  [ -f "$PROVISIONER_DIR/$asset" ] && [ ! -L "$PROVISIONER_DIR/$asset" ] \
    || { echo "runtime source asset is missing or unsafe: $asset" >&2; exit 1; }
done
# The guest half runs from this reviewed file, sent on stdin.
GUEST_UPDATER="$PROVISIONER_DIR/hivra-guest-runtime-update.sh"
[ -f "$GUEST_UPDATER" ] && [ ! -L "$GUEST_UPDATER" ] && bash -n "$GUEST_UPDATER" \
  || { echo "guest runtime updater is missing or unsafe" >&2; exit 1; }
# A DeepSeek computer runs its own gateway generation and pinned package
# (deepseek-harness/update-guest.py replaces them), so the archive also carries
# that directory. Its gateway assets are the ones above; the guest half lays
# them out again, since one file archived twice would arrive as a hard link.
NATIVE_ASSETS=(deepseek-harness)
[ -d "$PROVISIONER_DIR/deepseek-harness" ] && [ ! -L "$PROVISIONER_DIR/deepseek-harness" ] \
  && [ -z "$(find "$PROVISIONER_DIR/deepseek-harness" \( -type l -o \( ! -type f ! -type d \) \) -print -quit)" ] \
  || { echo "runtime source asset is missing or unsafe: deepseek-harness" >&2; exit 1; }
tar -czf "$ARCHIVE" -C "$PROVISIONER_DIR/hivra-chat" "${ASSETS[@]}" -C "$PROVISIONER_DIR" "${TERMINAL_ASSETS[@]}" "${NATIVE_ASSETS[@]}"
ARCHIVE_SHA256="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
release_lifecycle_lock

GUEST_SSH_IDENTITY_DIR="$(mktemp -d "/run/hivra-guest-ssh-identity.${VMID}.XXXXXXXX")"
chmod 0700 "$GUEST_SSH_IDENTITY_DIR"
"$SSH_IDENTITY_HELPER" "$VMID" "$IP" "$GUEST_SSH_IDENTITY_DIR"
SSH_OPTIONS=(-i "$VM_KEY" -o BatchMode=yes -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes -o HostKeyAlgorithms=ssh-ed25519 -o UpdateHostKeys=no \
  -o GlobalKnownHostsFile=/dev/null -o UserKnownHostsFile="$GUEST_SSH_IDENTITY_DIR/known_hosts" \
  -o HostKeyAlias="hivra-vmid-$VMID" -o ConnectTimeout=10)
scp "${SSH_OPTIONS[@]}" "$ARCHIVE" "ubuntu@${IP}:${REMOTE_ARCHIVE}" >/dev/null

# Guest stdout goes to a private file, never to the caller: only the guest's
# own commit line below can lead to the host receipt.
# What is left of the caller's deadline, less the trip back, bounds the guest.
GUEST_SECONDS=""
if [ -n "$UPDATE_DEADLINE" ]; then
  GUEST_SECONDS="$(( UPDATE_DEADLINE - $(date +%s) - 15 ))"
  [ "$GUEST_SECONDS" -gt 0 ] || { echo "runtime update deadline passed before the guest step" >&2; exit 1; }
fi
ssh "${SSH_OPTIONS[@]}" "ubuntu@${IP}" \
  "sudo HIVRA_RUNTIME_ARCHIVE='$REMOTE_ARCHIVE' HIVRA_RUNTIME_ARCHIVE_SHA256='$ARCHIVE_SHA256' HIVRA_CHAT_PORT='$CHAT_PORT' HIVRA_RUNTIME_UPDATE_SECONDS='$GUEST_SECONDS' bash -s" \
  <"$GUEST_UPDATER" >"$GUEST_RESULT"
grep -Fxq HIVRA_GUEST_RUNTIME_UPDATED "$GUEST_RESULT" \
  || { echo "guest runtime update ended without its commit receipt" >&2; exit 1; }
# The guest's agent CLI report reaches stdout only in this exact shape.
AGENT_CLI_LINE="$(grep -m1 -xE 'HIVRA_AGENT_CLI name=(claude-code|codex) version=([0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}|unknown) target=[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6} state=(current|scheduled|running|failed)' "$GUEST_RESULT" || true)"

# (Re)install the agent-run reporter with the fresh credential, as the start
# helper does after a boot. The gateway update above is already committed; every
# outcome here only changes ACTIVITY_COLLECTOR_STATUS.
GSSH=(ssh "${SSH_OPTIONS[@]}")
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
# The update runs inside one bounded dashboard request. The reporter step starts
# only when its whole bounded worst case (the 20 s, 120 s and 8 s guest calls
# above plus their kill grace) still fits before the caller's deadline, so it can
# never turn the committed update into an unverified one. Otherwise it stays
# "not attempted" and the next start installs the reporter.
REPORTER_WORST_CASE_SECONDS=165
if [ -n "$ACTIVITY_CREDENTIAL_JSON" ] && [ -n "$UPDATE_DEADLINE" ] \
  && [ "$(( UPDATE_DEADLINE - $(date +%s) ))" -lt "$REPORTER_WORST_CASE_SECONDS" ]; then
  ACTIVITY_CREDENTIAL_JSON=""
fi
if [ -n "$ACTIVITY_CREDENTIAL_JSON" ]; then
  install_activity_collector || true
  ACTIVITY_CREDENTIAL_JSON=""
fi
if [ -n "$AGENT_CLI_LINE" ]; then
  printf '%s\n' "$AGENT_CLI_LINE"
fi
if [ -n "$ACTIVITY_COLLECTOR_STATUS" ]; then
  printf 'HIVRA_ACTIVITY_COLLECTOR %s\n' "$ACTIVITY_COLLECTOR_STATUS"
fi

printf 'HIVRA_GUEST_RUNTIME_UPDATED vmid=%s\n' "$VMID"
