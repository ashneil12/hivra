import "server-only";

// Apply Hivra TOOLS to a HERMES-lane instance (Tools v2).
//
// Mirrors lib/composio/sync-connectors.ts exactly, because that path is already
// proven in production for the same file (the agent's config.yaml -> mcp_servers):
//
//   * webfree backend (webui|gateway) -> merge in-place over SSH with a small
//     python script run INSIDE the agent container (the config is a bind-mounted
//     volume the web API can't rewrite), then bounce the gateway on change.
//   * everything else                 -> GET /api/config via the agent web API,
//     reconcile, PUT back with putHermesConfigWithBindMountFallback.
//
// Only entries prefixed `hivra_` are ever touched (see hermes-tool-config.ts), so
// the composio entry and any user-authored MCP server survive untouched.

import { agentWebApi } from "@/lib/agent-web-api";
import { resolveInstanceIpv4 } from "@/lib/instance-resolvers";
import { sshExec, type ProxmoxSshHostConfig } from "@/lib/hetzner/ssh";
import { isWebfreeBackend } from "@/lib/types/instance";
import { buildResolveAgentContainerScript, buildResolveGatewayContainerScript } from "@/lib/services/agent-container";
import { putHermesConfigWithBindMountFallback } from "@/lib/hermes-config-write";
import { resolveHermesHomeDirFromConfig } from "@/lib/hermes-home";
import {
  buildHermesConfigWithTools,
  readInstalledHermesToolNames,
  type HermesToolServerEntry,
} from "@/lib/hivra/hermes-tool-config";
import { getHermesGuestSshTarget, type ProxmoxLifecycleRow } from "@/lib/services/proxmox-infrastructure";

export interface HermesToolApplyResult {
  applied: boolean;
  backend?: "webfree" | "agent";
  changed?: boolean;
  restarted?: boolean;
  reason?: "no_public_ipv4" | "not_running";
}

/** Minimal shape we need off a hermes_instances row. */
export interface HermesInstanceLike {
  id: string;
  status?: string | null;
  backend?: string | null;
  config?: unknown;
  [k: string]: unknown;
}

function sanitizeDockerName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, "");
}

// In-container merge. Reconciles ONLY `hivra_`-prefixed entries: strips the ones
// we manage, sets the desired set, and bumps mcp_discovery_timeout when any
// desired entry is remote. Mirrors the composio merge script's contract.
const PY_MERGE = `
import sys, json, yaml, os
payload = json.loads(__import__("base64").b64decode(sys.argv[1]).decode())
path = sys.argv[2]
entries = payload.get("entries") or {}
try:
    with open(path) as f:
        cfg = yaml.safe_load(f) or {}
except Exception:
    cfg = {}
if not isinstance(cfg, dict):
    cfg = {}
servers = cfg.get("mcp_servers")
if not isinstance(servers, dict):
    servers = {}
changed = False
# Strip every entry WE manage (never composio / user-authored).
for k in [k for k in servers if str(k).startswith("hivra_")]:
    del servers[k]; changed = True
has_remote = False
for name, entry in entries.items():
    servers[name] = entry
    if isinstance(entry, dict) and entry.get("url"):
        has_remote = True
    changed = True
if has_remote:
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
    print("HIVRA_TOOLS_MCP=changed")
else:
    print("HIVRA_TOOLS_MCP=unchanged")
`.trim();

/** Build the `{hivra_<name>: payload}` map the merge script consumes. */
function entriesPayload(entries: HermesToolServerEntry[]): Record<string, unknown> {
  const merged = buildHermesConfigWithTools({ config: {}, entries });
  const servers = merged.mcp_servers;
  return servers && typeof servers === "object" ? (servers as Record<string, unknown>) : {};
}

async function mergeToolsOverSsh(params: {
  ip: string;
  guestTarget: ProxmoxSshHostConfig | null;
  containerName: string;
  hermesHomeDir: string;
  entries: HermesToolServerEntry[];
  restartOnChange: boolean;
}): Promise<{ changed: boolean; restarted: boolean }> {
  const b64Script = Buffer.from(PY_MERGE, "utf8").toString("base64");
  const b64Payload = Buffer.from(
    JSON.stringify({ entries: entriesPayload(params.entries) }),
    "utf8",
  ).toString("base64");

  const res = await sshExec(
    params.ip,
    [
      buildResolveAgentContainerScript(params.containerName, { varName: "AGENT_CONTAINER" }),
      `if [ -z "$AGENT_CONTAINER" ]; then echo "no running agent container for ${params.containerName}" >&2; exit 1; fi`,
      `MERGE_OUT="$(docker exec "$AGENT_CONTAINER" sh -c 'set -e; echo "${b64Script}" | base64 -d > /tmp/hivra_tools_merge.py; PYBIN=$(head -1 "$(command -v hermes)" 2>/dev/null | sed "s|^#!||"); [ -x "$PYBIN" ] || PYBIN=/opt/hermes/.venv/bin/python3; CFG="\${HERMES_HOME:-${params.hermesHomeDir}}/config.yaml"; "$PYBIN" /tmp/hivra_tools_merge.py "${b64Payload}" "$CFG"; rm -f /tmp/hivra_tools_merge.py')" || { echo "hivra tools config merge failed" >&2; exit 1; }`,
      `echo "$MERGE_OUT"`,
    ].join("\n"),
    params.guestTarget ? { proxmoxHostConfig: params.guestTarget } : {},
  );
  if (!res.ok) throw new Error(res.error || res.stderr || "tools config merge failed");
  const changed = /HIVRA_TOOLS_MCP=changed/.test(res.stdout || "");

  let restarted = false;
  if (changed && params.restartOnChange) {
    const r = await sshExec(
      params.ip,
      [
        buildResolveGatewayContainerScript(params.containerName, "GW_CONTAINER"),
        `if [ -n "$GW_CONTAINER" ]; then docker restart "$GW_CONTAINER" >/dev/null 2>&1 && echo RESTARTED; fi`,
      ].join("\n"),
      params.guestTarget ? { proxmoxHostConfig: params.guestTarget } : {},
    );
    restarted = r.ok && /RESTARTED/.test(r.stdout || "");
  }
  return { changed, restarted };
}

/**
 * Reconcile the FULL desired set of Hivra tools on a Hermes instance. `entries`
 * is the complete desired state (pass [] to remove all Hivra-managed tools).
 * Never touches composio / user-authored MCP servers.
 */
export async function applyToolsToHermesInstance(params: {
  instanceId: string;
  userId: string;
  instance: HermesInstanceLike;
  entries: HermesToolServerEntry[];
  restart?: "on-change" | "never";
}): Promise<HermesToolApplyResult> {
  const { instanceId, userId, instance, entries } = params;
  const restartOnChange = (params.restart ?? "on-change") !== "never";

  if (instance.status && instance.status !== "running") {
    return { applied: false, reason: "not_running" };
  }

  const ip = await resolveInstanceIpv4(instance as never);
  if (!ip) return { applied: false, reason: "no_public_ipv4" };
  const guestTarget = getHermesGuestSshTarget(instance as ProxmoxLifecycleRow & { id: string });

  const containerName = `agent-${sanitizeDockerName(instanceId)}`;
  const hermesHomeDir = resolveHermesHomeDirFromConfig(
    (instance.config as Record<string, unknown> | undefined) ?? undefined,
  );

  if (isWebfreeBackend(instance.backend)) {
    const { changed, restarted } = await mergeToolsOverSsh({
      ip,
      guestTarget,
      containerName,
      hermesHomeDir,
      entries,
      restartOnChange,
    });
    return { applied: true, backend: "webfree", changed, restarted };
  }

  const api = await agentWebApi(instanceId, userId);
  const configRes = await api.get("/api/config");
  if (!configRes.ok) {
    throw new Error(
      `Agent config read returned ${configRes.status} for instance ${instanceId}; skipping tool sync to avoid clobbering config`,
    );
  }
  const current = (await configRes.json()) as Record<string, unknown>;

  await putHermesConfigWithBindMountFallback({
    api,
    // Reconcile OUR entries; composioEntry is deliberately omitted so the live
    // composio entry is preserved verbatim (that writer's documented contract).
    config: buildHermesConfigWithTools({ config: current, entries }),
    containerName,
    hermesHomeDir,
    ip,
    guestTarget,
    instanceId,
    userId,
  });

  return { applied: true, backend: "agent", changed: true, restarted: false };
}
