import "server-only";

/**
 * Host-side resolution of the live agent container / runtime compose service on
 * a managed Proxmox guest.
 *
 * The webfree migration replaced the single bare `agent-<id>` container with two
 * agent-image containers — `agent-<id>-gateway` (the runtime) and
 * `agent-<id>-official-dashboard` (the surface) — that both mount the shared
 * `webui-state` volume at /home/hermes/.hermes, so either can service host-side
 * file/exec operations against the agent's home dir. There is NO bare
 * `agent-<id>` container on the active fleet anymore.
 *
 * Critically, the `hermes_instances.webfree` flag has DRIFTED from the live
 * topology (a `webfree=false` row was observed running the webfree compose), so
 * host-side code MUST resolve the container/service from the live guest rather
 * than hard-coding `agent-<id>` or branching on the flag. This mirrors the
 * candidate-list resolution `harvest-agent-usage` and the OAuth helpers already
 * use, factored into one place so the ordering lives in a single spot.
 */

// Ordered container suffixes appended to the `agent-<id>` base name. Order:
// legacy bare name first (still correct for old single-container `backend`
// instances), then the two webfree containers. First running wins.
export const AGENT_CONTAINER_SUFFIXES = ["", "-gateway", "-official-dashboard"] as const;

/** Candidate container names for an `agent-<id>` base, in resolution order. */
export function getAgentContainerCandidates(baseContainerName: string): string[] {
  return AGENT_CONTAINER_SUFFIXES.map((suffix) => `${baseContainerName}${suffix}`);
}

/**
 * Emit shell lines that set `${varName}` (default `AGENT_CONTAINER`) to the first
 * candidate container that is currently running on the guest, via `docker
 * inspect`. Prepend this to a larger SSH command so resolution and the `docker
 * exec` happen in the SAME round-trip (no extra hop), then guard on the variable
 * being non-empty. The variable is left EMPTY when no candidate is running, so
 * the caller decides whether to abort, no-op, or emit a marker.
 *
 * `set -e` safe: the `docker inspect | grep -q` lives inside an `if` condition,
 * which never triggers an errexit when it returns non-zero.
 */
export function buildResolveAgentContainerScript(
  baseContainerName: string,
  options: { varName?: string } = {},
): string {
  const varName = options.varName ?? "AGENT_CONTAINER";
  const candidates = getAgentContainerCandidates(baseContainerName)
    .map((name) => JSON.stringify(name))
    .join(" ");
  return [
    `${varName}=""`,
    `for __agent_cand in ${candidates}; do`,
    `  if docker inspect -f '{{.State.Running}}' "$__agent_cand" 2>/dev/null | grep -q true; then ${varName}="$__agent_cand"; break; fi`,
    `done`,
  ].join("\n");
}

/**
 * Emit shell lines that set `${varName}` (default `GW_CONTAINER`) to the running
 * GATEWAY container specifically — the process that lists MCP tools — as opposed
 * to buildResolveAgentContainerScript which also matches the -official-dashboard
 * surface. Only the bare `agent-<id>` (legacy) and `agent-<id>-gateway` (webfree)
 * candidates re-run `tools/list` on restart; restarting -official-dashboard would
 * bounce the user's chat UI for nothing. Leaves the var EMPTY when no gateway is
 * running, so the caller skips the restart (a down gateway re-lists on next start).
 */
export function buildResolveGatewayContainerScript(
  baseContainerName: string,
  varName = "GW_CONTAINER",
): string {
  const candidates = [baseContainerName, `${baseContainerName}-gateway`]
    .map((name) => JSON.stringify(name))
    .join(" ");
  return [
    `${varName}=""`,
    `for __gw_cand in ${candidates}; do`,
    `  if docker inspect -f '{{.State.Running}}' "$__gw_cand" 2>/dev/null | grep -q true; then ${varName}="$__gw_cand"; break; fi`,
    `done`,
  ].join("\n");
}

/**
 * A shell command-substitution that resolves to the docker-compose service
 * running the agent runtime in the CURRENT compose dir: the webfree `gateway`
 * service when present, else the legacy `webui` service. Drop it directly into a
 * `docker compose <cmd> <SERVICE>` invocation — including on the right-hand side
 * of a pipe or before a heredoc — so call sites need no separate resolver line.
 * The caller must already have `cd`-ed into the instance's compose directory.
 *
 * The webfree compose has no `webui` service (only gateway/official-dashboard/
 * dashboard-sidecar), so hard-coded `docker compose exec webui` aborts under
 * `set -e`; this keeps it correct across compose vintages. Pass `sudo: true` when
 * the surrounding command runs `sudo docker compose` (non-root SSH user).
 *
 * pipefail-safe: `docker compose config` is wrapped in `{ …; || true; }` so a
 * non-zero config exit (deprecation/validation hiccups exit non-zero while STILL
 * emitting the service list) can't propagate through the pipe. Without the guard,
 * a caller running under `set -euo pipefail` makes the `… config | grep -qx
 * gateway` pipeline inherit pipefail: a non-zero `config` exit fails the whole
 * pipeline even when `gateway` matched, skipping `&& echo gateway` and falling
 * through to `|| echo webui` — resolving to the ABSENT `webui` service on a
 * gateway-backend box, so the downstream `docker compose exec … webui` dies with
 * `service "webui" is not running`. Same mechanism as the restart_gateway
 * incident fixed in hermesdeploy#470 / hermesdeploy-canary#402.
 */
export function runtimeComposeServiceExpr(options: { sudo?: boolean } = {}): string {
  const dc = options.sudo ? "sudo docker compose" : "docker compose";
  return `"$({ ${dc} config --services 2>/dev/null || true; } | grep -qx gateway && echo gateway || echo webui)"`;
}
