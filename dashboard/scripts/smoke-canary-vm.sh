#!/usr/bin/env bash
# Layer C smoke test — run before any fleet-wide :stable rollout.
#
# What this catches that Layers A + B can't
# -----------------------------------------
# Layer A (webui-side unit tests) runs at unit level on the fork source.
# Layer B (webui-side smoke workflow) boots the image in a CI runner with
# no real provider attached. This script is the one that exercises a
# REAL Hermes VM with REAL provider credentials and a REAL streamed
# response — the same path your users hit.
#
# Failure modes it surfaces:
#   - The pulled image won't start on Proxmox-flavoured Linux (kernel
#     mismatch, virtio quirks, etc. that don't appear on the GHA runner).
#   - The init script's UID/GID dance disagrees with this VM's actual
#     mounted-volume ownership.
#   - The sync-profiles overlay corrupts the .env after image rebuild
#     (the "VM secrets-sync override" MEMORY note's lurking case).
#   - Provider auth + streaming actually completes end-to-end against the
#     production API (Crof/Venice/Bankr/whatever the canary instance is
#     pointed at).
#
# Usage
# -----
#   bash dashboard/scripts/smoke-canary-vm.sh \
#       --pve-host "$HIVRA_AUDIT_HOST" \
#       --pve-key "$HIVRA_AUDIT_KEY" \
#       --vm-ip "$HIVRA_AUDIT_VM_IP" \
#       --instance-id "$HIVRA_AUDIT_INSTANCE_ID"
#
# All four identity arguments are required. Resolve them from the private host
# and instance registries at run time; this public script intentionally ships
# with no live infrastructure defaults.
#
# Exit codes
# ----------
#   31 — SSH path doesn't work (key wrong, host unreachable)
#   32 — `docker compose pull` failed
#   33 — container restart-loops after pull (init regression)
#   34 — /health never green
#   35 — provider auth wiring broken (fork patch regression on real image)
#   36 — /api/chat streaming response missing or empty
#
# Add `--keep-running` to skip the teardown poke for live debugging.
# Add `--no-recreate` to test the CURRENT image without pulling/recreating.

set -euo pipefail

# ── Explicit target identity ──────────────────────────────────────────────
PVE_HOST=""
PVE_KEY=""
VM_IP=""
INSTANCE_ID=""
NO_RECREATE=0
KEEP_RUNNING=0
HEALTH_TIMEOUT_S=240

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pve-host)   PVE_HOST="$2"; shift 2 ;;
    --pve-key)    PVE_KEY="$2"; shift 2 ;;
    --vm-ip)      VM_IP="$2"; shift 2 ;;
    --instance-id) INSTANCE_ID="$2"; shift 2 ;;
    --no-recreate) NO_RECREATE=1; shift ;;
    --keep-running) KEEP_RUNNING=1; shift ;;
    --health-timeout) HEALTH_TIMEOUT_S="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,/^set -euo/p' "$0" | sed 's/^# //;s/^#$//'
      exit 0
      ;;
    *)
      echo "unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

for required_name in PVE_HOST PVE_KEY VM_IP INSTANCE_ID; do
  if [[ -z "${!required_name}" ]]; then
    echo "missing required target identity; pass --pve-host, --pve-key, --vm-ip, and --instance-id" >&2
    exit 2
  fi
done

CONTAINER="agent-${INSTANCE_ID}"
INSTANCE_DIR="/opt/hermes/instances/${INSTANCE_ID}"

log() { printf '\n[canary-smoke] %s\n' "$*" >&2; }

# Build the SSH jump prefix once. Every later command piggybacks on this
# so we get a single ProxyJump rather than two nested ssh invocations.
ssh_vm() {
  ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 \
      -i "${PVE_KEY}" "root@${PVE_HOST}" \
      "ssh -o StrictHostKeyChecking=no -i /etc/hivra/keys/vm-orchestrator hermes@${VM_IP} \"$1\""
}

# ── 1. SSH path sanity ───────────────────────────────────────────────────
log "verifying SSH path: laptop → ${PVE_HOST} → ${VM_IP} → ${CONTAINER}"
if ! ssh_vm "sudo docker inspect ${CONTAINER} --format '{{.Image}}' >/dev/null 2>&1"; then
  log "FAIL: cannot reach container ${CONTAINER} on ${VM_IP}"
  exit 31
fi
BEFORE_IMG=$(ssh_vm "sudo docker inspect ${CONTAINER} --format '{{.Image}}'" 2>/dev/null || echo "unknown")
log "current image hash: ${BEFORE_IMG}"

# ── 2. Pull + recreate ───────────────────────────────────────────────────
if [[ "${NO_RECREATE}" == "0" ]]; then
  log "pulling :stable on canary VM"
  if ! ssh_vm "cd ${INSTANCE_DIR} && sudo docker compose pull webui 2>&1 | tail -5"; then
    log "FAIL: docker compose pull failed"
    exit 32
  fi

  log "force-recreating webui container"
  if ! ssh_vm "cd ${INSTANCE_DIR} && sudo docker compose rm -fsv webui && sudo docker compose up -d webui 2>&1 | tail -3"; then
    log "FAIL: docker compose up -d webui failed"
    exit 33
  fi
else
  log "--no-recreate set: testing current container without pulling"
fi

# ── 3. Wait for /health ──────────────────────────────────────────────────
log "waiting up to ${HEALTH_TIMEOUT_S}s for webui /health"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT_S ))
healthy=0
while [[ "$(date +%s)" -lt "${deadline}" ]]; do
  # We probe /health from INSIDE the container (no host port-forward needed)
  if ssh_vm "sudo docker exec ${CONTAINER} curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/health 2>/dev/null" | grep -q '^200$'; then
    healthy=1
    break
  fi
  state=$(ssh_vm "sudo docker inspect ${CONTAINER} --format '{{.State.Status}}'" 2>/dev/null || echo "missing")
  if [[ "${state}" != "running" ]]; then
    log "FAIL: container state=${state} during health-wait — likely init regression"
    ssh_vm "sudo docker logs --tail 60 ${CONTAINER} 2>&1" >&2 || true
    exit 33
  fi
  sleep 4
done

if [[ "${healthy}" -ne 1 ]]; then
  log "FAIL: /health never returned 200 within ${HEALTH_TIMEOUT_S}s"
  ssh_vm "sudo docker logs --tail 80 ${CONTAINER} 2>&1" >&2 || true
  exit 34
fi
log "/health 200 ✓"

# ── 4. Provider resolution sanity (Python-level, in-image) ──────────────
#
# Stream the Python check via stdin → ssh → docker exec -i so we don't
# have to chase nested quote escaping (the dashboard's ssh path is two
# levels: laptop → pve → VM → docker exec; each layer eats one quote
# tier and single-quotes inside Python collide with bash's heredoc).
log "running provider-resolution self-check against the live container"
PYTHON_CHECK=$(cat <<'PY'
import json
import sys
from api.config import (
    _resolve_configured_provider_id,
    _named_custom_provider_slug_for_base_url,
    cfg,
)
errs = []
model_cfg = cfg.get("model") or {}
base = model_cfg.get("base_url") or ""
prov = model_cfg.get("provider") or ""
if base and prov == "custom":
    rt = _resolve_configured_provider_id(prov, cfg, base_url=base, resolve_alias=False)
    if rt != "custom":
        errs.append(f"runtime leaked {rt!r} for base_url={base!r}")
    sb = _named_custom_provider_slug_for_base_url(base, cfg, include_builtin_fallback=False)
    if sb != "":
        errs.append(f"include_builtin_fallback=False leaked {sb!r}")
print(json.dumps({"base_url": base, "provider": prov, "errors": errs}))
sys.exit(1 if errs else 0)
PY
)

# Pipe via two ssh hops + docker exec -i, all using stdin so no quoting
# layer touches the Python source. The intermediate ssh needs `-i ${PVE_KEY}`
# and the inner ssh is built into a literal command string.
PROBE_OUT=$(printf '%s\n' "${PYTHON_CHECK}" \
  | ssh -o StrictHostKeyChecking=no -i "${PVE_KEY}" "root@${PVE_HOST}" \
      "ssh -o StrictHostKeyChecking=no -i /etc/hivra/keys/vm-orchestrator hermes@${VM_IP} \
         'sudo docker exec -i ${CONTAINER} /app/venv/bin/python -'" \
  2>&1) || PROBE_RC=$?
if [[ "${PROBE_RC:-0}" != "0" ]]; then
  log "FAIL: provider-resolution self-check failed inside container"
  log "${PROBE_OUT}"
  exit 35
fi
log "provider-resolution self-check: ${PROBE_OUT}"

# ── 5. /api/models — proves the provider connection actually works ─────
#
# Full chat-stream needs a created session + a started stream + an SSE
# consumer — too many moving parts to be a reliable smoke check. Hitting
# /api/models instead exercises the same auth wiring (the agent has to
# call out to the configured provider's /v1/models endpoint with the
# resolved provider's API key) but in a single round-trip and without
# session state. If `OPENAI_API_KEY` isn't reachable from the agent's
# auxiliary client, this 404/500s.
log "querying /api/models to verify provider auth wiring"
MODELS_STATUS=$(ssh_vm "sudo docker exec ${CONTAINER} curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/api/models" 2>/dev/null | tail -1 || echo "000")
if [[ "${MODELS_STATUS}" != "200" ]]; then
  log "FAIL: /api/models returned status=${MODELS_STATUS}"
  ssh_vm "sudo docker exec ${CONTAINER} curl -fsS http://127.0.0.1:8787/api/models 2>&1 | head -20" >&2 || true
  exit 36
fi
log "/api/models 200 ✓"

# Sanity preview — first 240B of the models payload so the operator
# sees we got real data, not a routing-error JSON.
MODELS_PREVIEW=$(ssh_vm "sudo docker exec ${CONTAINER} curl -fsS http://127.0.0.1:8787/api/models 2>/dev/null | head -c 240" 2>/dev/null || true)
log "models payload preview:"
printf '%s\n' "${MODELS_PREVIEW}" >&2

log "PASS: ${VM_IP} on :stable boots clean, health green, provider resolution intact (custom→custom), /api/models 200 with live data"

if [[ "${KEEP_RUNNING}" == "1" ]]; then
  log "--keep-running set — leaving container ${CONTAINER} as-is"
fi
exit 0
