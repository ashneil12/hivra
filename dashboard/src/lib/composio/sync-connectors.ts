import "server-only";

// src/lib/composio/sync-connectors.ts
//
// Writes the SINGLE `mcp_servers.composio` entry into a box's config so the agent
// gets Composio's Tool Router (search / connect / execute across 500+ apps). The
// entry is DETERMINISTIC — it's just the hosted endpoint + the user's consumer key
// header (no session to mint), so re-deriving it is free and re-writing an
// identical entry is a no-op. We touch the box config (and restart the gateway)
// only when the entry actually changes: first registration, key rotation, or
// de-register (key removed).

import { agentWebApi } from "@/lib/agent-web-api";
import { resolveInstanceIpv4 } from "@/lib/instance-resolvers";
import type { HermesInstanceRow } from "@/app/api/instances/[id]/route";
import { resolveHermesHomeDirFromConfig } from "@/lib/hermes-home";
import { sanitizeDockerName } from "@/lib/services/profile-service";
import { putHermesConfigWithBindMountFallback } from "@/lib/hermes-config-write";
import {
  buildResolveAgentContainerScript,
  buildResolveGatewayContainerScript,
} from "@/lib/services/agent-container";
import { sshExec, type ProxmoxSshHostConfig } from "@/lib/hetzner/ssh";
import { isWebfreeBackend } from "@/lib/types/instance";
import { buildComposioMcpServerEntry, getUserComposioKey } from "@/lib/composio/connect";
import {
  readCurrentComposioEntry,
  type ComposioMcpServerEntry,
} from "@/lib/composio/mcp-server";
import { getHermesGuestSshTarget } from "@/lib/services/proxmox-infrastructure";

export type ComposioSyncResult =
  | { applied: false; reason: "composio_disabled" | "no_public_ipv4" }
  | { applied: true; backend: "webfree" | "agent"; changed: boolean; restarted: boolean };

// Reconcile the single `composio` mcp_servers key. argv[1]=base64(JSON) where the
// JSON is { entry: {url,headers}|null }. Prints changed/unchanged. (The "should we
// write at all" decision is made in JS before minting a session, so this just
// reconciles: set if entry, strip if null, unchanged if already identical.)
const PY_MERGE = `
import sys, base64, json, yaml
payload = json.loads(base64.b64decode(sys.argv[1]).decode())
entry = payload.get("entry")
path = sys.argv[2]
try:
    with open(path) as f:
        cfg = yaml.safe_load(f) or {}
except FileNotFoundError:
    cfg = {}
if not isinstance(cfg, dict):
    cfg = {}
servers = cfg.get("mcp_servers")
if not isinstance(servers, dict):
    servers = {}
current = servers.get("composio")
changed = False
if entry is None:
    if current is not None:
        del servers["composio"]; changed = True
else:
    if current == entry:
        pass
    else:
        servers["composio"] = entry; changed = True
# Strip the dead 'pipedream' entry (migrated off Composio; its proxy route is gone,
# so a lingering entry makes the box's MCP client fail to connect + misleads it).
if "pipedream" in servers:
    del servers["pipedream"]; changed = True
# Composio's REMOTE Tool Router takes ~2.7s to connect; Hermes' 1.5s default
# mcp_discovery_timeout drops it at gateway boot so its tools never load. Bump
# upward (must match COMPOSIO_MIN_MCP_DISCOVERY_TIMEOUT_S).
if entry is not None:
    t = cfg.get("mcp_discovery_timeout")
    if not isinstance(t, (int, float)) or t < 15:
        cfg["mcp_discovery_timeout"] = 15; changed = True
if changed:
    if servers:
        cfg["mcp_servers"] = servers
    elif "mcp_servers" in cfg:
        del cfg["mcp_servers"]
    with open(path, "w") as f:
        yaml.safe_dump(cfg, f, default_flow_style=False, sort_keys=False, allow_unicode=True)
    print("COMPOSIO_MCP=changed")
else:
    print("COMPOSIO_MCP=unchanged")
`.trim();

async function mergeComposioOverSsh(params: {
  ip: string;
  guestTarget: ProxmoxSshHostConfig | null;
  containerName: string;
  hermesHomeDir: string;
  entry: ComposioMcpServerEntry | null;
  /** When false, write config but do NOT bounce the gateway (config-only sweep). */
  restartOnChange: boolean;
}): Promise<{ changed: boolean; restarted: boolean }> {
  const b64Script = Buffer.from(PY_MERGE, "utf8").toString("base64");
  const b64Payload = Buffer.from(
    JSON.stringify({
      entry: params.entry ? { url: params.entry.url, headers: params.entry.headers } : null,
    }),
    "utf8",
  ).toString("base64");

  const command = [
    buildResolveAgentContainerScript(params.containerName, { varName: "AGENT_CONTAINER" }),
    `if [ -z "$AGENT_CONTAINER" ]; then echo "no running agent container for ${params.containerName}" >&2; exit 1; fi`,
    // Resolve the config path from the CONTAINER'S OWN $HERMES_HOME (falling back
    // to the JS-computed dir). resolveHermesHomeDirFromConfig keys off the DB's
    // enableRootAccess flag, which can DRIFT from the box's real runtime — e.g. a
    // box with enableRootAccess:true but actually running non-root at
    // /home/hermes/.hermes as uid 1024. Trusting the flag made the merge target a
    // root-owned path it then couldn't write as uid 1024 (PermissionError). The
    // container's own HERMES_HOME always matches its runtime user.
    `MERGE_OUT="$(docker exec "$AGENT_CONTAINER" sh -c 'set -e; echo "${b64Script}" | base64 -d > /tmp/composio_mcp_merge.py; PYBIN=$(head -1 "$(command -v hermes)" 2>/dev/null | sed "s|^#!||"); [ -x "$PYBIN" ] || PYBIN=/opt/hermes/.venv/bin/python3; CFG="\${HERMES_HOME:-${params.hermesHomeDir}}/config.yaml"; "$PYBIN" /tmp/composio_mcp_merge.py "${b64Payload}" "$CFG"; rm -f /tmp/composio_mcp_merge.py')" || { echo "composio config merge failed" >&2; exit 1; }`,
    `CHANGED=0`,
    `case "$MERGE_OUT" in *COMPOSIO_MCP=changed*) CHANGED=1;; esac`,
    `RESTARTED=0`,
    `RESTART_ALLOWED=${params.restartOnChange ? "1" : "0"}`,
    buildResolveGatewayContainerScript(params.containerName, "GW_CONTAINER"),
    // Only the gateway needs bouncing to pick up the new/removed MCP server, and
    // only when the caller allows a restart (fleet sweeps write config-only).
    `if [ "$CHANGED" = "1" ] && [ "$RESTART_ALLOWED" = "1" ] && [ -n "$GW_CONTAINER" ]; then`,
    `  nohup sh -c "sleep 1 && docker restart $GW_CONTAINER" >/dev/null 2>&1 &`,
    `  RESTARTED=1`,
    `fi`,
    `printf 'COMPOSIO_SYNC changed=%s restarted=%s\\n' "$CHANGED" "$RESTARTED"`,
  ].join("\n");

  const result = await sshExec(params.ip, command, params.guestTarget ? { proxmoxHostConfig: params.guestTarget } : {});
  if (!result.ok) {
    const detail = [result.error, result.stderr].filter(Boolean).join(" :: ");
    throw new Error(detail || "SSH composio merge failed");
  }
  const stdout = result.stdout || "";
  return { changed: /changed=1/.test(stdout), restarted: /restarted=1/.test(stdout) };
}

async function restartGatewayOverSsh(
  ip: string,
  guestTarget: ProxmoxSshHostConfig | null,
  baseContainerName: string,
): Promise<boolean> {
  const script = [
    buildResolveGatewayContainerScript(baseContainerName, "GW_CONTAINER"),
    `if [ -n "$GW_CONTAINER" ]; then nohup sh -c "sleep 1 && docker restart $GW_CONTAINER" >/dev/null 2>&1 & echo "COMPOSIO_RESTART=1"; else echo "COMPOSIO_RESTART=0"; fi`,
  ].join("\n");
  const result = await sshExec(ip, script, guestTarget ? { proxmoxHostConfig: guestTarget } : {});
  return result.ok && /COMPOSIO_RESTART=1/.test(result.stdout || "");
}

/**
 * Reconcile a box's single `composio` MCP entry to the user's Composio consumer
 * key. The entry is DETERMINISTIC (Tool Router endpoint + key header), so this
 * just writes it when it differs from what's on the box, strips it when the key
 * is gone, and no-ops otherwise. Returns {applied:false} for benign skips; THROWS
 * on a real runtime/SSH failure so callers record it.
 */
export async function syncComposioToInstance(params: {
  instanceId: string;
  userId: string;
  instance: HermesInstanceRow;
  /** Force a rewrite + restart even when the entry is unchanged (rarely needed). */
  force?: boolean;
  /**
   * Gateway restart policy after a config change:
   *  - "on-change" (default): bounce the gateway when the entry changes so the
   *    user's Tool Router activates immediately (the live per-user path).
   *  - "never": write config only, never restart — for broad fleet sweeps (cron
   *    backfill) that must not ripple-restart boxes or drop live agent sessions;
   *    those boxes surface the tools on their next natural roll.
   */
  restart?: "on-change" | "never";
}): Promise<ComposioSyncResult> {
  const { instanceId, userId, instance } = params;
  const force = params.force === true;
  const restartOnChange = (params.restart ?? "on-change") !== "never";

  const key = await getUserComposioKey(userId);
  const ip = await resolveInstanceIpv4(instance);
  if (!ip) return { applied: false, reason: "no_public_ipv4" };
  const guestTarget = getHermesGuestSshTarget(instance);

  const containerName = `agent-${sanitizeDockerName(instanceId)}`;
  const hermesHomeDir = resolveHermesHomeDirFromConfig(
    instance.config as Record<string, unknown> | undefined,
  );

  // Deterministic desired entry: the Tool Router endpoint + this user's consumer
  // key (null when they have no key → strip any existing entry).
  const desiredEntry: ComposioMcpServerEntry | null = key ? buildComposioMcpServerEntry(key) : null;

  if (isWebfreeBackend(instance.backend)) {
    // The merge reconciles in-place (set / strip / no-op when identical), so we
    // can write unconditionally — no probe needed. `force` is moot here since the
    // entry is deterministic and the merge already no-ops on an unchanged entry.
    const { changed, restarted } = await mergeComposioOverSsh({
      ip,
      guestTarget,
      containerName,
      hermesHomeDir,
      entry: desiredEntry, // null → strip (no key); object → set
      restartOnChange,
    });
    return { applied: true, backend: "webfree", changed, restarted };
  }

  // Non-webfree: GET config first, PUT only when the entry must change.
  const api = await agentWebApi(instanceId, userId);
  const configRes = await api.get("/api/config");
  if (!configRes.ok) {
    throw new Error(
      `Agent config read returned ${configRes.status} for instance ${instanceId}; skipping composio sync to avoid clobbering config`,
    );
  }
  const current = (await configRes.json()) as Record<string, unknown>;
  const currentEntry = readCurrentComposioEntry(current);

  // No change needed → no-op (unless forced).
  if (!force && sameComposioEntry(currentEntry, desiredEntry)) {
    return { applied: true, backend: "agent", changed: false, restarted: false };
  }

  await putHermesConfigWithBindMountFallback({
    api,
    config: current,
    containerName,
    hermesHomeDir,
    ip,
    guestTarget,
    instanceId,
    userId,
    composioEntry: desiredEntry, // null strips, object sets
  });

  const restarted = restartOnChange ? await restartGatewayOverSsh(ip, guestTarget, containerName) : false;
  return { applied: true, backend: "agent", changed: true, restarted };
}

/** Structural equality for the managed composio entry (order-insensitive headers). */
function sameComposioEntry(
  a: ComposioMcpServerEntry | null,
  b: ComposioMcpServerEntry | null,
): boolean {
  if (a === null || b === null) return a === b;
  if (a.url !== b.url) return false;
  const ak = Object.keys(a.headers);
  const bk = Object.keys(b.headers);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => a.headers[k] === b.headers[k]);
}
