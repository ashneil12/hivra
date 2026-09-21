function buildHermesBinaryResolver(): string {
  return [
    'HERMES_BIN=/opt/hermes/.venv/bin/hermes',
    'if [ ! -x "$HERMES_BIN" ]; then',
    '  HERMES_BIN=/opt/venv/bin/hermes',
    'fi',
    'if [ ! -x "$HERMES_BIN" ]; then',
    '  HERMES_BIN=$(command -v hermes || true)',
    'fi',
    'if [ -z "$HERMES_BIN" ]; then',
    '  echo "ERROR: Hermes CLI binary not found."',
    '  exit 1',
    'fi',
  ].join('\n');
}

// Webfree VMs run agent-<id>-gateway instead of the bare agent-<id>
// container (still used by the Hetzner docker lane). Resolve whichever is
// running into $AGENT_CONTAINER before the docker exec so both topologies
// work in a single SSH round trip. When neither is running, emit the exact
// docker "No such container" stderr and exit 1 so the gws routes' existing
// `No such container` classification keeps returning a 503.
function buildAgentContainerResolver(instanceId: string): string {
  return [
    'AGENT_CONTAINER=""',
    `for candidate_container in agent-${instanceId} agent-${instanceId}-gateway; do`,
    `  if docker inspect --format='{{.State.Running}}' "$candidate_container" 2>/dev/null | grep -q true; then`,
    '    AGENT_CONTAINER="$candidate_container"',
    '    break',
    '  fi',
    'done',
    'if [ -z "$AGENT_CONTAINER" ]; then',
    `  echo "Error response from daemon: No such container: agent-${instanceId}" >&2`,
    '  exit 1',
    'fi',
  ].join('\n');
}

export function buildGoogleWorkspaceSetupCommand(
  instanceId: string,
  credentialsJson: string
): string {
  const b64Json = Buffer.from(credentialsJson).toString('base64');

  // The pipe feeds stdin into docker exec, so the container must already be
  // resolved when the pipeline runs — resolve it in a preceding statement.
  return [
    buildAgentContainerResolver(instanceId),
    `echo "${b64Json}" | base64 -d | docker exec -i "$AGENT_CONTAINER" sh -lc '`,
    'set -e',
    buildHermesBinaryResolver(),
    'cat > /tmp/gws_creds.json',
    '"$HERMES_BIN" workspace setup --client-secret /tmp/gws_creds.json',
    '"$HERMES_BIN" workspace setup --auth-url 2>&1',
    "'",
  ].join('\n');
}

export function buildGoogleWorkspaceExchangeCommand(
  instanceId: string,
  code: string
): string {
  const b64Code = Buffer.from(code).toString('base64');

  return [
    buildAgentContainerResolver(instanceId),
    `docker exec "$AGENT_CONTAINER" sh -lc '`,
    'set -e',
    buildHermesBinaryResolver(),
    `GWS_AUTH_CODE=$(printf %s "${b64Code}" | base64 -d)`,
    `"$HERMES_BIN" workspace setup --auth-code "$GWS_AUTH_CODE" 2>&1`,
    "'",
  ].join('\n');
}
