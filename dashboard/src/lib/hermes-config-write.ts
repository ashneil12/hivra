import type { AgentWebApiClient } from "@/lib/agent-web-api";
import {
  decryptInstanceBankrApiKey,
  getBankrWalletForInstance,
  type SupabaseLike,
} from "@/lib/billing/bankr-instance-wallets";
import { sshExec } from "@/lib/hetzner/ssh";
import {
  COMPOSIO_MCP_SERVER_NAME,
  isComposioManagedServerName,
  type ComposioMcpServerEntry,
} from "@/lib/composio/mcp-server";
import { COMPOSIO_MIN_MCP_DISCOVERY_TIMEOUT_S } from "@/lib/composio/config";
import { buildResolveAgentContainerScript } from "@/lib/services/agent-container";

const BIND_MOUNT_EBUSY_PATTERN = /\b(?:errno\s*16|ebusy|device or resource busy)\b/i;

function isScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatYamlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function formatYamlScalar(value: string | number | boolean | null): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

function isBindMountedConfigWriteError(message: string): boolean {
  return BIND_MOUNT_EBUSY_PATTERN.test(message);
}

function serializeHermesConfigYaml(value: unknown, indent = 0): string {
  const prefix = " ".repeat(indent);

  if (isScalar(value)) {
    return `${prefix}${formatYamlScalar(value)}`;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return `${prefix}[]`;
    }

    return value
      .map((item) => {
        if (isScalar(item)) {
          return `${prefix}- ${formatYamlScalar(item)}`;
        }
        return `${prefix}-\n${serializeHermesConfigYaml(item, indent + 2)}`;
      })
      .join("\n");
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return `${prefix}{}`;
    }

    return entries
      .map(([key, entryValue]) => {
        if (isScalar(entryValue)) {
          return `${prefix}${formatYamlKey(key)}: ${formatYamlScalar(entryValue)}`;
        }
        return `${prefix}${formatYamlKey(key)}:\n${serializeHermesConfigYaml(entryValue, indent + 2)}`;
      })
      .join("\n");
  }

  return `${prefix}${JSON.stringify(value)}`;
}

async function writeHermesConfigDirectly(params: {
  config: Record<string, unknown>;
  containerName: string;
  hermesHomeDir: string;
  ip: string;
}): Promise<void> {
  const configYaml = `${serializeHermesConfigYaml(params.config)}\n`;
  const b64Config = Buffer.from(configYaml, "utf8").toString("base64");
  const targetPath = `${params.hermesHomeDir}/config.yaml`;
  // `params.containerName` is the base `agent-<id>`. On webfree there is no bare
  // `agent-<id>` container, so resolve the live one (-gateway/-official-dashboard,
  // both mount the same config volume) inside the one SSH round-trip.
  const result = await sshExec(
    params.ip,
    [
      buildResolveAgentContainerScript(params.containerName, { varName: "AGENT_CONTAINER" }),
      `if [ -z "$AGENT_CONTAINER" ]; then echo "no running agent container for ${params.containerName}" >&2; exit 1; fi`,
      `echo "${b64Config}" | base64 -d | docker exec -i "$AGENT_CONTAINER" sh -c "cat > ${targetPath}"`,
    ].join("\n")
  );

  if (!result.ok) {
    throw new Error(result.error || result.stderr || "Direct config write failed");
  }
}

export async function buildHermesConfigWithInstanceBankrWallet(params: {
  instanceId?: string | null;
  config: Record<string, unknown>;
  db?: SupabaseLike | null;
}): Promise<Record<string, unknown>> {
  if (!params.instanceId) {
    return params.config;
  }

  const configWithoutBankr = { ...params.config };
  delete configWithoutBankr.bankr;
  let record;
  try {
    record = await getBankrWalletForInstance({
      instanceId: params.instanceId,
      db: params.db,
    });
  } catch {
    return configWithoutBankr;
  }
  const apiKey = record?.status === "active"
    ? await decryptInstanceBankrApiKey(record)
    : null;

  if (!record || record.status !== "active" || !apiKey) {
    return configWithoutBankr;
  }

  return {
    ...configWithoutBankr,
    bankr: {
      walletAddress: record.evmAddress,
      apiKey,
      walletId: record.bankrWalletId,
      withdrawalDestination: record.withdrawalDestinationEvm,
    },
  };
}

/**
 * Reconcile the single `composio` MCP server entry in `mcp_servers`. Composio's
 * Tool Router is one multi-toolkit server per user (see lib/composio/mcp-server.ts).
 *
 * CONTRACT:
 *   - `entry === undefined` → PRESERVE: return config untouched. General config
 *     writers (agent-config / skills / toolsets / …) don't manage the composio
 *     entry, so a routine PUT must never drop it — it GETs the live config (which
 *     already carries it) and passes it straight through.
 *   - `entry === null` → strip the managed `composio` entry (de-register).
 *   - `entry` object → strip the managed entry, then set `composio` to it.
 *
 * Never throws; leaves all non-composio mcp servers + the rest of config intact.
 */
export function buildHermesConfigWithComposioMcp(params: {
  config: Record<string, unknown>;
  entry?: ComposioMcpServerEntry | null;
}): Record<string, unknown> {
  if (params.entry === undefined) return params.config;

  const existingServersRaw = params.config.mcp_servers;
  const existingServers =
    existingServersRaw &&
    typeof existingServersRaw === "object" &&
    !Array.isArray(existingServersRaw)
      ? { ...(existingServersRaw as Record<string, unknown>) }
      : {};

  // Strip the entry we manage, then (if setting) merge it back in.
  for (const key of Object.keys(existingServers)) {
    if (isComposioManagedServerName(key)) delete existingServers[key];
  }
  // Also strip the dead `pipedream` entry (we migrated off it; its dashboard MCP
  // proxy route is deleted, so a lingering entry makes the box's MCP client fail
  // to connect — returning HTML — and misleads the agent into using it).
  delete existingServers.pipedream;
  if (params.entry) {
    existingServers[COMPOSIO_MCP_SERVER_NAME] = {
      url: params.entry.url,
      headers: params.entry.headers,
    };
  }

  const next = { ...params.config };
  if (Object.keys(existingServers).length === 0) {
    delete next.mcp_servers;
  } else {
    next.mcp_servers = existingServers;
  }
  // Composio's Tool Router is remote (~2.7s to connect); Hermes' default 1.5s
  // discovery timeout drops it at boot. Bump (upward only) when composio is set.
  if (params.entry) {
    const cur = next.mcp_discovery_timeout;
    if (typeof cur !== "number" || cur < COMPOSIO_MIN_MCP_DISCOVERY_TIMEOUT_S) {
      next.mcp_discovery_timeout = COMPOSIO_MIN_MCP_DISCOVERY_TIMEOUT_S;
    }
  }
  return next;
}

export async function putHermesConfigWithBindMountFallback(params: {
  api: AgentWebApiClient;
  config: Record<string, unknown>;
  containerName: string;
  hermesHomeDir: string;
  ip: string;
  instanceId?: string | null;
  userId?: string | null;
  db?: SupabaseLike | null;
  timeoutMs?: number;
  // When provided, reconcile the single Composio MCP entry (the connectors-sync
  // path passes it: an entry to set, or null to strip). Omitted by general config
  // writers, which preserve whatever composio entry the live config already carries.
  composioEntry?: ComposioMcpServerEntry | null;
}): Promise<unknown> {
  const configWithBankr = await buildHermesConfigWithInstanceBankrWallet({
    instanceId: params.instanceId,
    config: params.config,
    db: params.db,
  });
  const config = buildHermesConfigWithComposioMcp({
    config: configWithBankr,
    entry: params.composioEntry,
  });
  const response = await params.api.put(
    "/api/config",
    { config },
    { timeout: params.timeoutMs ?? 20_000 }
  );

  if (response.ok) {
    return response.json();
  }

  const errText = await response.text().catch(() => response.statusText);
  if (!isBindMountedConfigWriteError(errText)) {
    throw new Error(`Agent config update returned ${response.status}: ${errText}`);
  }

  await writeHermesConfigDirectly({
    config,
    containerName: params.containerName,
    hermesHomeDir: params.hermesHomeDir,
    ip: params.ip,
  });

  return {
    ok: true,
    mode: "direct-write-fallback",
  };
}
