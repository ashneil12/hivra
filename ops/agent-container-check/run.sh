#!/usr/bin/env bash
# Install one agent kind with the real guest installer in a throwaway container
# on the shared runner box, ask it a sum through the box's own chat, then
# delete the container. Usage, from the repository root:
#   CHECK_MODEL_KEY=... CHECK_MODEL_ORIGIN=https://canary.hermesos.cloud CHECK_MODEL=... \
#     ops/agent-container-check/run.sh <agent-kind>
# The key is a Hivra managed-model key: Claude Code uses the Anthropic
# endpoint, and Codex uses the OpenAI-compatible Responses endpoint.
# Needs Docker, and privileged containers (the installer manages systemd units).
set -euo pipefail
kind="${1:?usage: run.sh <agent-kind>}"
: "${CHECK_MODEL_KEY:?CHECK_MODEL_KEY is required}"
: "${CHECK_MODEL_ORIGIN:?CHECK_MODEL_ORIGIN is required}"
: "${CHECK_MODEL:?CHECK_MODEL is required}"
root="$(git rev-parse --show-toplevel)"
name="hivra-agent-check-${kind}-$$"
log_dir="${CHECK_LOG_DIR:-${root}/out/agent-checks}"
mkdir -p "$log_dir"
case "$kind" in
  claude) base_url="${CHECK_MODEL_ORIGIN%/}/api/managed-venice/anthropic" ;;
  codex|aeon|openclaw|agent-zero|openbot|nuphos|hermes)
    base_url="${CHECK_MODEL_ORIGIN%/}/api/managed-venice/v1" ;;
  *) echo "[agent-check] unsupported agent kind: $kind" >&2; exit 2 ;;
esac

cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker build -q -t hivra-agent-check-base "${root}/ops/agent-container-check" >/dev/null
docker run -d --name "$name" --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  -v "${root}/dashboard/provisioner:/src:ro" \
  -v "${root}/scripts/release/agent-container-check.mjs:/check/agent-container-check.mjs:ro" \
  hivra-agent-check-base >/dev/null
for _ in $(seq 30); do
  state="$(docker exec "$name" systemctl is-system-running 2>/dev/null || true)"
  case "$state" in running|degraded) break ;; esac
  sleep 2
done

echo "[agent-check] ${kind}: installing"
HIVRA_MODEL_KEY="$CHECK_MODEL_KEY" docker exec -e HIVRA_AGENT_KIND="$kind" -e HIVRA_COMPUTER_SUBSTRATE=proxmox-kvm -e HIVRA_WANT_BROWSER=0 \
  -e HIVRA_MODEL_KEY -e HIVRA_MODEL_BASE_URL="$base_url" -e HIVRA_HERMES_MODEL="$CHECK_MODEL" \
  "$name" bash -c 'cp -r /src /opt/hivra-src && bash /opt/hivra-src/provision-claude-code-box.sh' \
  > "${log_dir}/${kind}-install.log" 2>&1 \
  || { echo "[agent-check] ${kind}: install failed (see install log)"; exit 1; }

if [ "$kind" = "codex" ]; then
  # Reproduce the deploy-time agent-bootstrap provider file; the installer
  # alone intentionally doesn't set Codex's model provider.
  CHECK_MODEL_BASE_URL="$base_url" docker exec -u bux -e CHECK_MODEL_KEY \
    -e CHECK_MODEL_BASE_URL -e CHECK_MODEL "$name" \
    node /check/agent-container-check.mjs seed-codex --home /home/bux
fi

case "$kind" in
  claude|codex) ;;
  *) echo "[agent-check] ${kind}: installer readiness passed; native chat not checked"; exit 0 ;;
esac

# The box's chat listens on 127.0.0.1 only, as on a real computer, so it is
# asked from inside the container with the box's own Node.
echo "[agent-check] ${kind}: waiting for the box's chat"
for _ in $(seq 60); do
  docker exec "$name" curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1 && break
  sleep 5
done
status=0
docker exec "$name" node /check/agent-container-check.mjs ask --url http://127.0.0.1:8080 \
  --token-file /home/bux/.hivra/api-token || status=$?
docker exec "$name" journalctl --no-pager -n 200 > "${log_dir}/${kind}-journal.log" 2>&1 || true
exit "$status"
