import { buildHostTimeSyncRepairScript } from "@/lib/services/hetzner-instance-builders";
import {
  buildLegacyManagedGatewayRunPython,
  buildManagedGatewayStatusCommand,
} from "@/lib/services/managed-gateway-command";
import { resolveHermesHomeDirFromConfig } from "@/lib/hermes-home";
import { resolveWebfreeGatewayService } from "@/lib/types/instance";

/**
 * Shell-command builders for restarting the supervised Hermes gateway on a
 * guest, split out of route.ts. Pure string generation — same inputs,
 * byte-identical output. The readiness poll constants live here because only
 * these builders interpolate them.
 */
export const WEBUI_HERMES_HOME = "/home/hermes/.hermes";
export const GATEWAY_RESTART_READINESS_ATTEMPTS = 120;
export const GATEWAY_RESTART_READINESS_POLL_SECONDS = 2;
export const GATEWAY_RESTART_SSH_TIMEOUT_MS = 300_000;
export function buildGatewayRestartCommand(
  containerName: string,
  instanceConfig: Record<string, unknown> | undefined
): string {
  const hermesHomeDir = resolveHermesHomeDirFromConfig(instanceConfig);

  return [
    "set -e",
    buildHostTimeSyncRepairScript(),
    `CONTAINER_NAME=${JSON.stringify(containerName)}`,
    `EXPECTED_HERMES_HOME=${JSON.stringify(hermesHomeDir)}`,
    'docker exec -e EXPECTED_HERMES_HOME="$EXPECTED_HERMES_HOME" "$CONTAINER_NAME" sh -lc \'. /etc/profile 2>/dev/null || true; export HERMES_HOME="${HERMES_HOME:-$EXPECTED_HERMES_HOME}"; HERMES_BIN="/opt/venv/bin/hermes"; if [ ! -x "$HERMES_BIN" ]; then HERMES_BIN="/opt/hermes/.venv/bin/hermes"; fi; if [ ! -x "$HERMES_BIN" ]; then HERMES_BIN="$(command -v hermes)"; fi; [ -n "$HERMES_BIN" ]; "$HERMES_BIN" gateway restart\'',
  ].join("\n");
}
export function buildWebUIGatewayLaunchScript(): string {
  return `docker compose exec -T --user 1024 webui sh -s <<'SH'
set -eu
BASE_HOME="${WEBUI_HERMES_HOME}"
PROFILE_HOME="$BASE_HOME"
export HERMES_HOME="$PROFILE_HOME"
export PATH="$BASE_HOME/bin:$PATH"
mkdir -p "$PROFILE_HOME/logs" "$BASE_HOME/gateway-profiles.d"
printf "%s\\n" "$BASE_HOME" > "$BASE_HOME/gateway-profiles.d/default.active"
unset HERMES_INFERENCE_PROVIDER HERMES_MODEL HERMES_SUBAGENT_MODEL MODEL PROVIDER LLM_PROVIDER HERMES_WEBUI_DEFAULT_MODEL
cd "$BASE_HOME/hermes-agent"
nohup python - > "$PROFILE_HOME/logs/gateway.log" 2>&1 <<'PY' &
import os
import re
from pathlib import Path

def decode_quoted_env_value(value: str) -> str:
    if len(value) < 2 or value[0] != value[-1] or value[0] not in ("'", '"'):
        return value

    inner = value[1:-1]
    if value[0] == "'":
        return inner.replace("\\\\'", "'")

    replacements = {
        "\\\\n": "\\n",
        "\\\\r": "\\r",
        "\\\\t": "\\t",
        '\\\\"': '"',
        "\\\\\\\\": "\\\\",
        "\\\\$": "$",
    }
    for old, new in replacements.items():
        inner = inner.replace(old, new)
    return inner

def load_env_file(path: Path) -> None:
    if not path.exists():
        return

    key_pattern = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
    for raw_line in path.read_text(errors="replace").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        key, value = line.split("=", 1)
        key = key.strip()
        if not key_pattern.match(key):
            continue
        os.environ[key] = decode_quoted_env_value(value.strip())

base_home = Path(os.environ["HERMES_HOME"])
load_env_file(base_home / ".env")
os.environ.pop("HERMES_WEBUI_DEFAULT_MODEL", None)
${buildLegacyManagedGatewayRunPython()}
PY
STATUS_FILE="$PROFILE_HOME/logs/gateway-status.log"
attempt=0
while [ "$attempt" -lt ${GATEWAY_RESTART_READINESS_ATTEMPTS} ]; do
  attempt=$((attempt + 1))
  sleep ${GATEWAY_RESTART_READINESS_POLL_SECONDS}
  ${buildManagedGatewayStatusCommand()} > "$STATUS_FILE" 2>&1 || true
  if grep -q "Gateway is running" "$STATUS_FILE"; then
    cat "$STATUS_FILE"
    exit 0
  fi
done
echo "[webui-gateway-restart] gateway did not report running before the readiness deadline" >&2
echo "[webui-gateway-restart] last status output:" >&2
cat "$STATUS_FILE" >&2 || true
echo "[webui-gateway-restart] recent gateway log:" >&2
tail -80 "$PROFILE_HOME/logs/gateway.log" >&2 || true
exit 1
SH`;
}
// The de-indented compose steps that restart the supervised `gateway` service.
// Shared by the gateway-backend path (run unconditionally) and the legacy
// webui-backend probe branch (indented two spaces inside `if … fi`).
export function buildGatewayServiceRestartSteps(): string[] {
  return [
    // `exec` requires a running container. Ensure the service is up first so
    // this action can recover a stopped/offline gateway instead of aborting
    // under `set -euo pipefail` before it ever reaches the start command.
    "docker compose up -d gateway",
    `docker compose exec -T --user 1024 gateway sh -lc 'BASE_HOME="${WEBUI_HERMES_HOME}"; mkdir -p "$BASE_HOME/gateway-profiles.d"; printf "%s\\n" "$BASE_HOME" > "$BASE_HOME/gateway-profiles.d/default.active"'`,
    "docker compose restart gateway",
    'STATUS_FILE="/tmp/hermes-gateway-service-status.log"',
    "attempt=0",
    `while [ "$attempt" -lt ${GATEWAY_RESTART_READINESS_ATTEMPTS} ]; do`,
    "  attempt=$((attempt + 1))",
    `  sleep ${GATEWAY_RESTART_READINESS_POLL_SECONDS}`,
    `  docker compose exec -T gateway ${buildManagedGatewayStatusCommand()} > "$STATUS_FILE" 2>&1 || true`,
    '  if grep -q "Gateway is running" "$STATUS_FILE"; then',
    '    cat "$STATUS_FILE"',
    "    exit 0",
    "  fi",
    "done",
    'echo "[webui-gateway-restart] supervised gateway service did not report running before the readiness deadline" >&2',
    'echo "[webui-gateway-restart] last status output:" >&2',
    'cat "$STATUS_FILE" >&2 || true',
    'echo "[webui-gateway-restart] recent gateway service logs:" >&2',
    "docker compose logs --tail=80 gateway >&2 || true",
    "exit 1",
  ];
}
export function buildWebUIRuntimeRestartCommand(
  instanceId: string,
  backend: string | null | undefined
): string {
  const preamble = [
    "set -euo pipefail",
    buildHostTimeSyncRepairScript(),
    `INSTANCE_DIR=/opt/hermes/instances/${instanceId}`,
    'cd "$INSTANCE_DIR"',
  ];

  // A backend='gateway' box is the Phase-2 webfree default: its compose stack is
  // `gateway` + `official-dashboard` + `dashboard-sidecar` with NO `webui`
  // service. Restart the `gateway` service directly — do NOT gate on a
  // `docker compose config --services` probe (which can exit non-zero under
  // `pipefail` and then wrongly fall through to the legacy `webui` bootstrap,
  // failing with `service "webui" is not running`). See the 2026-06-24 prod
  // incident on instance fixturecase08… (host fixturenodea).
  if (resolveWebfreeGatewayService(backend) === "gateway") {
    return [...preamble, ...buildGatewayServiceRestartSteps()].join("\n");
  }

  // Legacy backend='webui' boxes may run either the `webui` service or (when
  // Phase-2-collapsed onto the webfree stack) the `gateway` service, so probe
  // the live topology: restart `gateway` when present, otherwise re-launch the
  // gateway process inside the `webui` container via the bootstrap script.
  // Neutralize the `config` exit code with `{ …; || true; }` before the pipe so
  // a non-zero `docker compose config` (deprecation/validation hiccup) under
  // `set -euo pipefail` can't fail the pipeline, flip the `if` false, and wrongly
  // fall through to the in-`webui`-container bootstrap on a row that has drifted
  // to the gateway topology (`service "webui" is not running`). Same bug class as
  // hermesdeploy#470/#403's runtimeComposeServiceExpr fix.
  return [
    ...preamble,
    "if { docker compose config --services 2>/dev/null || true; } | grep -qx gateway; then",
    ...buildGatewayServiceRestartSteps().map((line) => `  ${line}`),
    "fi",
    buildWebUIGatewayLaunchScript(),
  ].join("\n");
}
