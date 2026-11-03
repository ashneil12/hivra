#!/usr/bin/env bash
# Regression check for the built sidecar image (CI: .github/workflows/browser-sidecar.yml).
#
# Proves, against a real kernel, that:
#   1. the image's Chromium is at or above the CVE floor;
#   2. Chromium runs with its sandbox ON (chrome://sandbox says "adequately
#      sandboxed") in both launch paths: a Playwright-launched browser and the
#      agent's CDP Chrome started by the entrypoint;
#   3. with the dashboard's container settings (seccomp-chromium.json +
#      no-new-privileges + init) every process runs as the `browser` user,
#      nothing carries --no-sandbox, and a root-owned volume from an older
#      image is handed over;
#   4. without those settings (Docker's default seccomp) the browser fails
#      CLOSED: it does not start, /health turns 503, and nothing falls back to
#      --no-sandbox.
#
# usage: tests/sandbox/run-image-checks.sh <image>
set -euo pipefail

IMAGE="${1:?usage: run-image-checks.sh <image>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
package_root="$(cd "$here/../.." && pwd)"
SECCOMP="$package_root/docker/seccomp-chromium.json"
MIN_VERSION="$(sed -n 's/^export const MIN_CHROMIUM_VERSION = "\(.*\)";$/\1/p' "$package_root/src/browser/chromium.ts")"
[[ -n "$MIN_VERSION" ]] || { echo "FAIL: could not read MIN_CHROMIUM_VERSION" >&2; exit 1; }

run_id="sbx-$$"
containers=()
volumes=()
cleanup() {
  for c in "${containers[@]}"; do docker rm -f "$c" >/dev/null 2>&1 || true; done
  for v in "${volumes[@]}"; do docker volume rm -f "$v" >/dev/null 2>&1 || true; done
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  for c in "${containers[@]}"; do
    echo "---- logs: $c" >&2
    docker logs --tail 80 "$c" >&2 2>&1 || true
  done
  exit 1
}

sandbox_settings=(--init --security-opt "seccomp=$SECCOMP" --security-opt no-new-privileges:true)
sidecar_env=(
  -e SIGNING_SECRET=ci-signing-secret-0123456789
  -e SIDECAR_AUTH_TOKEN=ci-auth-token-0123456789
  -e PLAYWRIGHT_HEADLESS=false
  -e DISPLAY=:99
  -e AGENT_CDP_ENABLED=true
  -e AGENT_CDP_PORT=9223
  -e AGENT_CDP_PROXY_PORT=9224
  -e VNC_PASSWORD=ci-vnc-pass
)

# Prints the /health body whatever the status code (wget hides a 503's body).
health() {
  docker exec "$1" node -e 'fetch("http://127.0.0.1:8789/health").then(async (r) => console.log(r.status, await r.text())).catch((e) => { console.log("unreachable", String(e)); process.exit(1); })'
}

echo "== 1. Chromium version floor ($MIN_VERSION)"
version_line="$(docker run --rm --entrypoint /usr/lib/chromium/chromium "$IMAGE" --version)"
echo "$version_line"
version="$(grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' <<<"$version_line" | head -1)"
lowest="$(printf '%s\n%s\n' "$version" "$MIN_VERSION" | sort -V | head -1)"
[[ "$lowest" == "$MIN_VERSION" ]] || fail "Chromium $version is below the floor $MIN_VERSION"

echo "== 2. Playwright launch path: sandbox ON as the browser user"
status="$(docker run --rm "${sandbox_settings[@]}" --user browser --entrypoint node -w /app "$IMAGE" dist/cli/sandbox-status.js)" \
  || fail "launch-mode sandbox status failed: $status"
echo "$status"
grep -q '"verdict":"adequate"' <<<"$status" || fail "launch mode not adequately sandboxed"

echo "== 3. Full container (entrypoint, CDP mode) with the dashboard's settings"
volume="$run_id-state"
volumes+=("$volume")
docker volume create "$volume" >/dev/null
# An older image ran as root and left root-owned profile files behind.
docker run --rm -v "$volume:/var/lib/hermes-browser" --entrypoint sh "$IMAGE" -c \
  'mkdir -p /var/lib/hermes-browser/profiles/cdp/Default && echo legacy > /var/lib/hermes-browser/profiles/cdp/Default/legacy-root-file && chown -R 0:0 /var/lib/hermes-browser'
good="$run_id-good"
containers+=("$good")
docker run -d --name "$good" "${sandbox_settings[@]}" -v "$volume:/var/lib/hermes-browser" "${sidecar_env[@]}" "$IMAGE" >/dev/null
up=""
for _ in $(seq 1 45); do
  body="$(health "$good" || true)"
  if grep -q '"browser":"up"' <<<"$body"; then up=1; break; fi
  sleep 2
done
[[ -n "$up" ]] || fail "CDP browser never came up under the sandbox settings (last health: ${body:-none})"
echo "health: $body"

status="$(docker exec "$good" node /app/dist/cli/sandbox-status.js)" || fail "CDP-mode sandbox status failed: $status"
echo "$status"
grep -q '"verdict":"adequate"' <<<"$status" || fail "CDP Chrome not adequately sandboxed"

if docker exec "$good" pgrep -fa -- '--no-sandbox'; then
  fail "a process is running with --no-sandbox"
fi
# Every process except docker-init (pid 1) runs as browser. Our own `ps` comes
# from docker exec, which runs as root, so drop it from the list.
others="$(docker exec "$good" ps -eo pid=,user=,comm= | awk '$1 != 1 && $3 != "ps" && $2 != "browser"')"
[[ -z "$others" ]] || fail "processes not running as browser: $others"
owner="$(docker exec "$good" stat -c %U /var/lib/hermes-browser/profiles/cdp/Default/legacy-root-file)"
[[ "$owner" == "browser" ]] || fail "legacy root-owned profile file still owned by $owner"
docker exec "$good" wget -q --spider http://127.0.0.1:6080/vnc.html || fail "noVNC is not being served"
echo "ok: all processes run as browser, none with --no-sandbox, volume handed over, noVNC up"

echo "== 4. Fails closed under Docker's default seccomp (no sandbox settings)"
bad="$run_id-bad"
containers+=("$bad")
docker run -d --name "$bad" --init "${sidecar_env[@]}" "$IMAGE" >/dev/null
# Past the health grace (60s) the dead browser must make the container unhealthy.
sleep 75
body="$(health "$bad" || true)"
echo "health: $body"
grep -q '"browser":"down"' <<<"$body" || fail "health did not report the browser down: $body"
grep -q '"ok":false' <<<"$body" || fail "health still ok with no browser: $body"
if docker exec "$bad" pgrep -fa -- '--no-sandbox'; then
  fail "fell back to --no-sandbox under the default seccomp profile"
fi
if status="$(docker exec "$bad" node /app/dist/cli/sandbox-status.js)"; then
  fail "sandbox status passed without the sandbox settings: $status"
fi
echo "ok: browser refused to run unsandboxed and health is red"

echo "== 5. docker compose applies the same settings from the dashboard's compose lines"
# The dashboard writes the profile beside docker-compose.yml and references it
# by absolute path (dashboard/src/lib/browser-sidecar/container-security.ts).
project="$(mktemp -d)"
cp "$SECCOMP" "$project/browser-sidecar-seccomp.json"
cat > "$project/docker-compose.yml" <<COMPOSE
services:
  browser-sidecar:
    image: $IMAGE
    user: browser
    working_dir: /app
    entrypoint: ["node", "dist/cli/sandbox-status.js"]
    init: true
    security_opt:
      - seccomp=$project/browser-sidecar-seccomp.json
      - no-new-privileges:true
COMPOSE
docker compose version
status="$(docker compose -p "$run_id" -f "$project/docker-compose.yml" run --rm browser-sidecar)" \
  || fail "compose-run sandbox status failed: $status"
docker compose -p "$run_id" -f "$project/docker-compose.yml" down --remove-orphans >/dev/null 2>&1 || true
rm -rf "$project"
echo "$status"
grep -q '"verdict":"adequate"' <<<"$status" || fail "compose run not adequately sandboxed"

echo "PASS: sidecar image runs Chromium $version with its sandbox on"
