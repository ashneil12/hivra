#!/usr/bin/env bash
set -euo pipefail

image=${1:?Pass the sha256 ID of the locally built image}
[[ "$image" =~ ^sha256:[0-9a-f]{64}$ ]]
[[ "$(docker image inspect --format '{{.Id}} {{.Os}}/{{.Architecture}}' "$image")" == "$image linux/amd64" ]]
runtime=${HIVRA_GVISOR_SMOKE_RUNTIME:-runsc}
name="hivra-claude-terminal-smoke-$(cat /proc/sys/kernel/random/uuid)"
volume="$name-workspace"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true; docker volume rm "$volume" >/dev/null 2>&1 || true' EXIT

docker volume create "$volume" >/dev/null
docker run --rm --runtime="$runtime" --network=none --read-only --cap-drop=ALL --cap-add=CHOWN \
  --security-opt=no-new-privileges --user 0:0 --pids-limit=32 --cpus=0.5 \
  --memory=128m --memory-swap=128m --mount "type=volume,src=$volume,dst=/workspace,volume-nocopy" \
  --pull=never --entrypoint=/bin/chown "$image" 65534:65534 /workspace
docker run -d --name "$name" --runtime="$runtime" --init --network=none --read-only \
  --cap-drop=ALL --security-opt=no-new-privileges --pids-limit=256 --cpus=1 --memory=1g --memory-swap=1g \
  --tmpfs '/tmp:rw,noexec,nosuid,nodev,size=128m' --mount "type=volume,src=$volume,dst=/workspace,volume-nocopy" \
  --pull=never "$image" >/dev/null

require_ready() {
  local state
  for _ in {1..20}; do
    state=$(docker inspect --format '{{.State.Health.Status}}' "$name")
    case "$state" in
      healthy) return 0 ;;
      unhealthy) break ;;
    esac
    sleep 1
  done
  docker logs "$name" >&2
  return 1
}

require_ready
docker exec "$name" claude --version | grep -Fx '2.1.332 (Claude Code)'
docker exec "$name" ttyd --version | grep -F '1.7.7'
docker exec "$name" sh -ec '
  test "$(id -u)" = 65534
  test "$(stat -c %a "$HOME")" = 700
  test "$(stat -c %a /workspace/project)" = 700
  test -S /tmp/hivra-claude-terminal.sock
  test ! -w /usr/local/bin
  printf fixture > /workspace/project/persistence-marker
  printf fixture > "$HOME/persistence-marker"
'
docker stop --time 5 "$name" >/dev/null
docker start "$name" >/dev/null
require_ready
docker exec "$name" sh -ec '
  test "$(cat /workspace/project/persistence-marker)" = fixture
  test "$(cat "$HOME/persistence-marker")" = fixture
'
printf '%s\n' 'Claude terminal health and both persistent paths verified under gVisor.'
