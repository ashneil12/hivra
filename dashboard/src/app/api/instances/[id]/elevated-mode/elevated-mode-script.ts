// Pure shell-script builders for the agent elevated-mode (gated sudo) toggle.
// Kept import-free so the regression tests can exercise them without pulling in
// next/server or the ssh2 stack. The route.ts handlers wrap these with auth +
// sshExec. See the webui image side (docker_init.bash) which reads
// HERMES_AGENT_ELEVATED at container start and writes/removes the NOPASSWD
// sudoers drop-in accordingly.

export const ELEVATED_ENV_KEY = 'HERMES_AGENT_ELEVATED';

function instanceEnvPath(instanceId: string): string {
  return `/opt/hermes/instances/${instanceId}/.env`;
}

/** Reads the persisted flag from the compose env_file (root-owned → sudo -n). */
export function buildElevatedModeReadScript(instanceId: string): string {
  return `sudo -n sh -c 'grep -E "^${ELEVATED_ENV_KEY}=" ${instanceEnvPath(instanceId)} 2>/dev/null || true'`;
}

/**
 * Interpret the output of buildElevatedModeReadScript. Elevated mode defaults ON
 * in the image (docker_init `${HERMES_AGENT_ELEVATED:-1}`), so the agent is
 * elevated UNLESS the flag is explicitly falsy. An absent key (empty output) ⇒ on.
 */
export function isElevatedFromReadOutput(stdout: string): boolean {
  return !/^HERMES_AGENT_ELEVATED=\s*(0|false|FALSE|no|off)\s*$/m.test(stdout.trim());
}

/**
 * Sets HERMES_AGENT_ELEVATED to 1 (enabled) or 0 (disabled) in the instance
 * env_file, then recreates the webui container so docker_init.bash re-applies
 * or revokes the sudoers drop-in. The flag is always stripped first so repeated
 * toggles stay idempotent.
 *
 * Elevated mode now defaults ON in the image (docker_init's
 * `${HERMES_AGENT_ELEVATED:-1}`), so "disabled" must write an explicit `=0`
 * rather than removing the key — an absent key reads as ON.
 */
export function buildElevatedModeApplyScript(instanceId: string, enabled: boolean): string {
  const envPath = instanceEnvPath(instanceId);
  const py = `
import os
from pathlib import Path
p = Path(${JSON.stringify(envPath)})
key = ${JSON.stringify(ELEVATED_ENV_KEY)}
try:
    lines = p.read_text().splitlines()
except FileNotFoundError:
    lines = []
lines = [l for l in lines if l.split("=", 1)[0].strip() != key]
${enabled ? 'lines.append(key + "=1")' : 'lines.append(key + "=0")'}
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text("\\n".join(l for l in lines if l.strip()).strip() + "\\n")
try:
    os.chown(p, 1024, 1024)
    os.chmod(p, 0o600)
except OSError:
    pass
`;
  return `set -euo pipefail
cd /opt/hermes/instances/${instanceId}
# Patch the compose env_file (root-owned on the managed runtime → sudo -n).
sudo -n python3 - <<'PY'
${py}
PY
# Recreate the runtime service so the env_file change is injected and
# docker_init.bash (re)writes or removes the gated sudoers drop-in for the agent
# runtime user. Resolve the service name: webfree runs \`gateway\`, not \`webui\`
# (no \`webui\` service exists there, so hard-coding it aborts under set -e). This
# inlines runtimeComposeServiceExpr() from lib/services/agent-container.ts — this
# file is intentionally import-free so its regression tests stay dependency-free.
# pipefail-safe: \`config\` is wrapped in \`{ …; || true; }\` so a non-zero config
# exit can't fail the pipeline under this script's \`set -euo pipefail\` and fall
# through to the ABSENT \`webui\` service (cf. hermesdeploy#470).
# Command substitution OUT=$(…) ensures non-zero exit codes from docker compose
# fail the script under set -e rather than being masked by a tail pipe.
TARGET_SVC="$({ sudo docker compose config --services 2>/dev/null || true; } | grep -qx gateway && echo gateway || echo webui)"
OUT=$(sudo docker compose up -d --force-recreate "$TARGET_SVC" 2>&1)
echo "$OUT" | tail -6
echo "elevated-mode apply: ${enabled ? 'enabled' : 'disabled'}"
`;
}
