import crypto from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase";
import { decryptApiKey, encryptApiKey } from "@/lib/crypto";
import { getHetznerInstanceStatus } from "@/lib/services/hetzner-instance-service";
import { sshExec, type ProxmoxSshHostConfig } from "@/lib/hetzner/ssh";
import {
  SIDECAR_SERVER_CODE,
  WEBUI_HANDOFF_APPENDAGE,
} from "@/lib/services/sidecar-script";
import {
  getProxmoxInfrastructure,
  getHermesGuestSshTarget,
} from "@/lib/services/proxmox-infrastructure";
import { log } from "@/lib/logger";

export interface SecureInstanceOptions {
  id: string;
  userId: string;
  requireRunning?: boolean;
}

interface SecureUserInstanceQueryRecord {
  id: string;
  gateway_url: string | null;
  api_server_key_encrypted: string | null;
  api_key_encrypted?: string | null;
  provider?: string | null;
  backend?: "gateway" | "webui" | null;
  config?: unknown;
  user_id: string;
  status: string;
  host_id?: string | null;
  hetzner_server_id?: number | null;
  ipv4_address?: string | null;
  proxmox_vmid?: number | null;
  proxmox_node?: string | null;
  cpu_limit?: number | null;
  ram_limit?: number | null;
}

interface SecureUserInstanceRecord extends Omit<SecureUserInstanceQueryRecord, "gateway_url"> {
  [key: string]: unknown;
  gateway_url: string;
}

export type SecureUserInstanceResult =
  | {
      instance: SecureUserInstanceRecord;
      error: null;
      apiServerKey: string;
      instanceIpv4: string;
      /** Pass to sshExec for any guest command (`getHermesGuestSshTarget`). */
      guestTarget?: ProxmoxSshHostConfig | null;
    }
  | {
      instance: null;
      error: string;
      apiServerKey: string;
      instanceIpv4: string;
    };

const MANAGED_SIDECAR_REFRESH_TTL_MS = 5 * 60 * 1000;
const MANAGED_SIDECAR_READY_TIMEOUT_MS = 15 * 1000;
const MANAGED_SIDECAR_READY_INTERVAL_MS = 250;
const SIDECAR_SERVER_SCRIPT_VERSION = crypto
  .createHash("sha256")
  .update(SIDECAR_SERVER_CODE)
  .digest("hex");
const DASHBOARD_SIDECAR_SERVER_CODE = SIDECAR_SERVER_CODE + WEBUI_HANDOFF_APPENDAGE;
const DASHBOARD_SIDECAR_SERVER_SCRIPT_VERSION = crypto
  .createHash("sha256")
  .update(DASHBOARD_SIDECAR_SERVER_CODE)
  .digest("hex");
// v2: the chat-stream worker module is no longer shipped or mounted.
const SIDECAR_ASSET_LAYOUT_VERSION = "managed-sidecar-v2";
const SIDECAR_SCRIPT_VERSION = crypto
  .createHash("sha256")
  .update(SIDECAR_ASSET_LAYOUT_VERSION)
  .update(SIDECAR_SERVER_SCRIPT_VERSION)
  .digest("hex");
const DASHBOARD_SIDECAR_SCRIPT_VERSION = crypto
  .createHash("sha256")
  .update("managed-dashboard-sidecar-v2")
  .update(DASHBOARD_SIDECAR_SERVER_SCRIPT_VERSION)
  .digest("hex");
const SAFE_INSTANCE_ID = /^[a-zA-Z0-9_-]+$/;
const managedSidecarRefreshCache = new Map<string, { refreshedAt: number; version: string }>();
type ManagedSidecarComposeService = "sidecar" | "dashboard-sidecar";
interface ManagedSidecarRefreshParams {
  id: string;
  instanceIpv4: string;
  composeService?: ManagedSidecarComposeService;
  config?: unknown;
  hostId?: string | null;
}

function parseGatewayIpv4(gatewayUrl: string | null | undefined): string {
  if (!gatewayUrl) return "";

  try {
    const url = new URL(gatewayUrl);
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname)) {
      return url.hostname;
    }

    const sslipMatch = url.hostname.match(/^(\d{1,3}(?:-\d{1,3}){3})\.sslip\.io$/i);
    if (sslipMatch?.[1]) {
      return sslipMatch[1].replace(/-/g, ".");
    }
  } catch {}

  return "";
}

async function resolveInstanceIpv4(instance: {
  id: string;
  gateway_url: string | null;
  host_id?: string | null;
  hetzner_server_id?: number | null;
  ipv4_address?: string | null;
}): Promise<string> {
  if (instance.ipv4_address?.trim()) {
    return instance.ipv4_address.trim();
  }

  if (instance.host_id && supabaseAdmin) {
    const { data: host } = await supabaseAdmin
      .from("hermes_hosts")
      .select("hetzner_server_id")
      .eq("id", instance.host_id)
      .single<{ hetzner_server_id: number | null }>();

    if (host?.hetzner_server_id) {
      const status = await getHetznerInstanceStatus(host.hetzner_server_id);
      if (status.ipv4) return status.ipv4;
    }
  }

  if (instance.hetzner_server_id) {
    const status = await getHetznerInstanceStatus(instance.hetzner_server_id);
    if (status.ipv4) return status.ipv4;
  }

  return parseGatewayIpv4(instance.gateway_url);
}

interface ApiServerKeyRecoveryOptions {
  ignoreApiServerKey?: string | null;
}

function shouldUseRecoveredApiServerKey(
  candidate: string,
  options: ApiServerKeyRecoveryOptions = {},
): boolean {
  if (!/^[a-f0-9]{64}$/i.test(candidate)) {
    return false;
  }

  const ignored = options.ignoreApiServerKey?.trim();
  return !ignored || candidate !== ignored;
}

/**
 * True when `ip` is NOT globally unique — RFC1918 private space (10/8,
 * 172.16/12, 192.168/16), CGNAT/tailscale (100.64/10), or link-local
 * (169.254/16). The Hermes Proxmox fleet puts every guest on a private vmbr1
 * /24 (default 10.250.20.0/24) that is REUSED on every pve host, so the same
 * private IP resolves to a DIFFERENT tenant's VM depending on which host you
 * SSH from. Recovery must refuse to read API_SERVER_KEY over such an address
 * unless it also has a `proxmoxHostConfig` pinning the exact managing host —
 * otherwise a bare sshExec (or sshExec's IP-only host inference) lands on a
 * stranger's box and harvests THEIR key, which then gets persisted over the
 * real one and signs webui-login handoffs with the wrong bearer → the VM
 * sidecar 403s → permanent blank white workspace. Globally-routable addresses
 * (Hetzner Cloud public IPs) are unique, so they pass through unrouted.
 */
function isUnroutablePrivateGuestIpv4(ip: string): boolean {
  const octets = ip.trim().split(".");
  if (octets.length !== 4) return false;
  const a = Number(octets[0]);
  const b = Number(octets[1]);
  if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT / tailscale)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local)
  return false;
}

interface ManagedHostRecoveryInstance {
  id: string;
  gateway_url: string | null;
  host_id?: string | null;
  hetzner_server_id?: number | null;
  ipv4_address?: string | null;
  /** Full instance config blob. When it carries a Proxmox `infrastructure`
   *  handle, recovery routes the SSH read through the managing pve host
   *  instead of trying to reach the (unroutable) private guest IP directly. */
  config?: unknown;
}

type ManagedHostSshOptions = { timeoutMs: number; proxmoxHostConfig?: ProxmoxSshHostConfig };

async function recoverApiServerKeyFromManagedHost(
  instance: ManagedHostRecoveryInstance,
  options: ApiServerKeyRecoveryOptions = {},
): Promise<{ apiServerKey: string; instanceIpv4: string } | null> {
  // Proxmox guests sit on a private vmbr1 IP (e.g. 10.250.20.50) that Vercel
  // serverless cannot route to, and docker runs INSIDE the VM. The provisioner/
  // orchestrator reaches these via the managing pve host, and sshExec already
  // implements that nested hop (Vercel → pve host → guest private IP) when given
  // a `proxmoxHostConfig` — the same routing harvest-agent-usage and the WebUI
  // Caddy public-shell repair use to docker-inspect guest containers. Without it
  // every Proxmox-fleet drift recovery silently failed against the private IP and
  // fell back to the stale key (blank white workspace until a manual DB fix).
  // The routing keys (node/hostSlug/hostEnvPrefix) live in config.infrastructure,
  // so this works even when host_id/hetzner_server_id are NULL (which they often
  // are on the Proxmox fleet). Hetzner-Cloud instances have no infrastructure
  // handle → proxmoxHostConfig stays null → the original public-IP path is used.
  const proxmoxInfra = getProxmoxInfrastructure(instance.config);
  const proxmoxHostConfig = proxmoxInfra
    ? getHermesGuestSshTarget({ id: instance.id, config: instance.config, host_id: instance.host_id ?? null })
    : null;

  const instanceIpv4 = proxmoxInfra?.privateIpv4?.trim() || (await resolveInstanceIpv4(instance));
  if (!instanceIpv4) {
    return null;
  }

  // Fail closed before we ever SSH: a non-globally-unique private guest IP
  // (the vmbr1 /24 is reused on every pve host) without a `proxmoxHostConfig`
  // pinning the managing host cannot be reached unambiguously. A bare sshExec —
  // or sshExec's IP-only host inference — would land on whichever host answers
  // that private IP first (a DIFFERENT tenant's box) and harvest a stranger's
  // API_SERVER_KEY, which then gets persisted over the real one (blank white
  // workspace until a manual DB fix). The authenticated page-load /
  // webui-login-url paths pass config.infrastructure, so they keep healing via
  // the pinned host route; the egress-probe cron and the gateway/webui
  // 401-retry paths, which don't, stop here instead of corrupting the key.
  if (!proxmoxHostConfig && isUnroutablePrivateGuestIpv4(instanceIpv4)) {
    log.warn("apiServerKey recovery refused: private guest IP without a pinned host route", {
      source: "instance-security",
      instanceId: instance.id,
      failureType: "api_server_key_recovery_unroutable_private_ip",
    });
    return null;
  }

  const sshOptions: ManagedHostSshOptions = proxmoxHostConfig
    ? { timeoutMs: 20_000, proxmoxHostConfig }
    : { timeoutMs: 20_000 };

  // dashboard-sidecar is the auth-bridge container that bakes API_SERVER_KEY, so
  // it is probed first; -official-dashboard/-gateway cover the webfree topology
  // (the bare agent-<id> usually does not exist there); agent-<id>/-web cover the
  // classic single-container WebUI / legacy Hetzner layout.
  const containerNames = [
    `agent-${instance.id}-dashboard-sidecar`,
    `agent-${instance.id}-official-dashboard`,
    `agent-${instance.id}-gateway`,
    `agent-${instance.id}`,
    `agent-${instance.id}-web`,
  ];

  for (const containerName of containerNames) {
    const result = await sshExec(
      instanceIpv4,
      `docker inspect ${containerName} --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^API_SERVER_KEY=//p' | head -n1`,
      sshOptions
    );

    if (!result.ok) {
      continue;
    }

    const apiServerKey = result.stdout.trim();
    if (shouldUseRecoveredApiServerKey(apiServerKey, options)) {
      return {
        apiServerKey,
        instanceIpv4,
      };
    }
    if (/^[a-f0-9]{64}$/i.test(apiServerKey)) {
      log.warn("recovered API server key candidate matched rejected bearer; continuing recovery", {
        source: "instance-security",
        instanceId: instance.id,
        recoverySource: "container_env",
        containerName,
        failureType: "recovered_bearer_matched_rejected_token",
      });
    }
  }

  const discoveredSidecarResult = await sshExec(
    instanceIpv4,
    `docker ps --filter 'label=com.docker.compose.service=dashboard-sidecar' --format '{{.Names}}' 2>/dev/null | while IFS= read -r container; do
  [ -n "$container" ] || continue
  api_key=$(docker inspect "$container" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^API_SERVER_KEY=//p' | head -n1)
  if printf '%s' "$api_key" | grep -Eq '^[a-f0-9]{64}$'; then
    printf '%s\t%s\n' "$container" "$api_key"
  fi
done`,
    sshOptions
  );

  if (discoveredSidecarResult.ok) {
    for (const line of discoveredSidecarResult.stdout.split(/\r?\n/)) {
      const [containerName, apiServerKey] = line.split("\t");
      if (!containerName || !apiServerKey) {
        continue;
      }
      if (shouldUseRecoveredApiServerKey(apiServerKey, options)) {
        return {
          apiServerKey,
          instanceIpv4,
        };
      }
      if (/^[a-f0-9]{64}$/i.test(apiServerKey)) {
        log.warn("recovered API server key candidate matched rejected bearer; continuing recovery", {
          source: "instance-security",
          instanceId: instance.id,
          recoverySource: "discovered_dashboard_sidecar",
          containerName,
          failureType: "recovered_bearer_matched_rejected_token",
        });
      }
    }
  }

  if (!SAFE_INSTANCE_ID.test(instance.id)) {
    return null;
  }

  const webuiCaddyResult = await sshExec(
    instanceIpv4,
    `caddyfile=/opt/hermes/instances/${instance.id}/Caddyfile
[ -f "$caddyfile" ] && awk '/header Authorization "Bearer / {
    token = $0
    sub(/.*Bearer /, "", token)
    sub(/".*/, "", token)
    if (token ~ /^[a-f0-9]{64}$/) {
      print token
      exit
    }
  }' "$caddyfile" | head -n1`,
    sshOptions
  );

  if (webuiCaddyResult.ok) {
    const apiServerKey = webuiCaddyResult.stdout.trim();
    if (shouldUseRecoveredApiServerKey(apiServerKey, options)) {
      return {
        apiServerKey,
        instanceIpv4,
      };
    }
    if (/^[a-f0-9]{64}$/i.test(apiServerKey)) {
      log.warn("recovered API server key candidate matched rejected bearer; no alternate bearer found", {
        source: "instance-security",
        instanceId: instance.id,
        recoverySource: "caddyfile",
        failureType: "recovered_bearer_matched_rejected_token",
      });
    }
  }

  return null;
}

async function persistRecoveredApiServerKey(instanceId: string, apiServerKey: string): Promise<void> {
  await supabaseAdmin
    ?.from("hermes_instances")
    .update({
      api_server_key_encrypted: encryptApiKey(apiServerKey),
    })
    .eq("id", instanceId);
}

export async function recoverAndPersistApiServerKeyFromManagedHost(
  instance: ManagedHostRecoveryInstance,
  options: ApiServerKeyRecoveryOptions = {},
): Promise<{ apiServerKey: string; instanceIpv4: string } | null> {
  const recovered = await recoverApiServerKeyFromManagedHost(instance, options);
  if (!recovered) {
    return null;
  }

  await persistRecoveredApiServerKey(instance.id, recovered.apiServerKey);
  return recovered;
}

function buildManagedSidecarRefreshCommand(params: {
  instanceId: string;
  encodedSidecarScript: string;
  expectedServerVersion: string;
  composeService: ManagedSidecarComposeService;
}): string {
  const composeService = params.composeService;
  const requiresWebUITerminalUpstream = composeService === "dashboard-sidecar";
  const readinessProbeScript = [
    "const http = require('http');",
    "const req = http.get({ host: '127.0.0.1', port: 9090, path: '/dashboard-logout', timeout: 2000 }, (res) => {",
    "  res.resume();",
    "  process.exit(res.statusCode && res.statusCode < 500 ? 0 : 1);",
    "});",
    "req.on('timeout', () => { req.destroy(new Error('timeout')); process.exit(1); });",
    "req.on('error', () => process.exit(1));",
  ].join(" ");
  const readinessAttempts = Math.ceil(MANAGED_SIDECAR_READY_TIMEOUT_MS / MANAGED_SIDECAR_READY_INTERVAL_MS);

  return [
    "set -e",
    `INSTANCE_DIR=/opt/hermes/instances/${params.instanceId}`,
    `SIDECAR_CONTAINER=agent-${params.instanceId}-${composeService}`,
    `EXPECTED_SERVER_VERSION=${params.expectedServerVersion}`,
    'COMPOSE_FILE="$INSTANCE_DIR/docker-compose.yml"',
    'mkdir -p "$INSTANCE_DIR"',
    'cd "$INSTANCE_DIR"',
    'CURRENT_VERSION=""',
    'if [ -f sidecar_server.js ]; then',
    '  if command -v sha256sum >/dev/null 2>&1; then',
    `    CURRENT_VERSION="$(sha256sum sidecar_server.js | awk '{print $1}')"`,
    '  elif command -v shasum >/dev/null 2>&1; then',
    `    CURRENT_VERSION="$(shasum -a 256 sidecar_server.js | awk '{print $1}')"`,
    "  fi",
    "fi",
    "SIDECAR_EXISTS=0",
    "SIDECAR_RUNNING=0",
    'if docker inspect "$SIDECAR_CONTAINER" >/dev/null 2>&1; then',
    "  SIDECAR_EXISTS=1",
    `  if [ "$(docker inspect -f '{{.State.Running}}' "$SIDECAR_CONTAINER" 2>/dev/null)" = "true" ]; then`,
    "    SIDECAR_RUNNING=1",
    "  fi",
    "fi",
    "SHOULD_WRITE=1",
    'if [ -n "$CURRENT_VERSION" ] && [ "$CURRENT_VERSION" = "$EXPECTED_SERVER_VERSION" ]; then',
    "  SHOULD_WRITE=0",
    "fi",
    "SIDECAR_READY=0",
    "SHOULD_WAIT=0",
    "SHOULD_COMPOSE_UP=0",
    ...(requiresWebUITerminalUpstream
      ? [
          `DASHBOARD_TERMINAL_UPSTREAM_URL=http://agent-${params.instanceId}-official-dashboard:9119`,
          'if [ -f "$COMPOSE_FILE" ] && ! grep -Fq -- "WEBUI_TERMINAL_UPSTREAM_URL=" "$COMPOSE_FILE"; then',
          '  if grep -Eq "^[[:space:]]*-[[:space:]]*DASHBOARD_UPSTREAM_URL=" "$COMPOSE_FILE"; then',
          '    sed "/^[[:space:]]*-[[:space:]]*DASHBOARD_UPSTREAM_URL=/a\\      - WEBUI_TERMINAL_UPSTREAM_URL=$DASHBOARD_TERMINAL_UPSTREAM_URL" "$COMPOSE_FILE" > "$COMPOSE_FILE.next" && mv "$COMPOSE_FILE.next" "$COMPOSE_FILE"',
          "  fi",
          '  if ! grep -Fq -- "WEBUI_TERMINAL_UPSTREAM_URL=$DASHBOARD_TERMINAL_UPSTREAM_URL" "$COMPOSE_FILE"; then',
          '    echo "Dashboard sidecar missing WEBUI_TERMINAL_UPSTREAM_URL env" >&2',
          "    exit 1",
          "  fi",
          "  SHOULD_COMPOSE_UP=1",
          "  SHOULD_WAIT=1",
          "fi",
        ]
      : []),
    'if [ "$SHOULD_WRITE" = "1" ]; then',
    `  printf '%s' '${params.encodedSidecarScript}' | base64 -d > sidecar_server.js`,
    "  SHOULD_WAIT=1",
    "fi",
    'if [ "$SIDECAR_EXISTS" = "1" ]; then',
    '  if [ "$SHOULD_COMPOSE_UP" = "1" ]; then',
    `    docker compose up -d ${composeService} >/dev/null 2>&1 || true`,
    "    SHOULD_WAIT=1",
    '  elif [ "$SHOULD_WRITE" = "1" ]; then',
    '    docker restart "$SIDECAR_CONTAINER" >/dev/null 2>&1 || true',
    "    SHOULD_WAIT=1",
    '  elif [ "$SIDECAR_RUNNING" != "1" ]; then',
    '    docker start "$SIDECAR_CONTAINER" >/dev/null 2>&1 || true',
    "    SHOULD_WAIT=1",
    "  fi",
    'elif [ -f docker-compose.yml ]; then',
    `  docker compose up -d ${composeService} >/dev/null 2>&1 || true`,
    "  SHOULD_WAIT=1",
    "fi",
    'if [ "$SHOULD_WAIT" = "1" ]; then',
    "  ATTEMPT=0",
    `  while [ "$ATTEMPT" -lt ${readinessAttempts} ]; do`,
    `    if docker exec "$SIDECAR_CONTAINER" node -e ${JSON.stringify(readinessProbeScript)} >/dev/null 2>&1; then`,
    "      SIDECAR_READY=1",
    "      break",
    "    fi",
    "    ATTEMPT=$((ATTEMPT + 1))",
    `    sleep ${MANAGED_SIDECAR_READY_INTERVAL_MS / 1000}`,
    "  done",
    '  if [ "$SIDECAR_READY" != "1" ]; then',
    '    echo "Managed sidecar did not become ready in time" >&2',
    "    exit 1",
    "  fi",
    "fi",
  ].join("\n");
}

function summarizeSidecarRefreshFailure(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed
    .replace(/\b[a-f0-9]{64}\b/gi, "[redacted-hex-token]")
    .slice(-800);
}

function resolveManagedSidecarHostConfig(
  params: Pick<ManagedSidecarRefreshParams, "id" | "config" | "hostId">,
): ProxmoxSshHostConfig | null {
  return getProxmoxInfrastructure(params.config)
    ? getHermesGuestSshTarget({ id: params.id.trim(), config: params.config, host_id: params.hostId ?? null })
    : null;
}

function managedSidecarHostCacheKey(
  proxmoxHostConfig: ProxmoxSshHostConfig | null,
): string {
  if (!proxmoxHostConfig) return "direct";
  return [
    proxmoxHostConfig.hostId ?? "",
    proxmoxHostConfig.hostSlug ?? "",
    proxmoxHostConfig.envPrefix ?? "",
    proxmoxHostConfig.vmid ?? "",
  ].join(":");
}

export async function refreshManagedSidecarScript(
  params: ManagedSidecarRefreshParams,
): Promise<boolean> {
  const instanceId = params.id.trim();
  const instanceIpv4 = params.instanceIpv4.trim();
  const composeService = params.composeService === "dashboard-sidecar" ? "dashboard-sidecar" : "sidecar";

  if (!instanceIpv4 || !/^[a-zA-Z0-9_-]+$/.test(instanceId)) {
    return false;
  }

  const proxmoxHostConfig = resolveManagedSidecarHostConfig(params);
  if (!proxmoxHostConfig && isUnroutablePrivateGuestIpv4(instanceIpv4)) {
    log.warn("refused managed sidecar refresh for unroutable private guest IP", {
      source: "instance-security",
      instanceId,
      composeService,
      failureType: "managed_sidecar_refresh_unroutable_private_ip",
    });
    return false;
  }

  const sidecarServerCode = composeService === "dashboard-sidecar"
    ? DASHBOARD_SIDECAR_SERVER_CODE
    : SIDECAR_SERVER_CODE;
  const expectedServerVersion = composeService === "dashboard-sidecar"
    ? DASHBOARD_SIDECAR_SERVER_SCRIPT_VERSION
    : SIDECAR_SERVER_SCRIPT_VERSION;
  const encodedSidecarScript = Buffer.from(sidecarServerCode, "utf8").toString("base64");
  const repairCommand = buildManagedSidecarRefreshCommand({
    instanceId,
    encodedSidecarScript,
    expectedServerVersion,
    composeService,
  });

  const sshOptions: ManagedHostSshOptions = proxmoxHostConfig
    ? { timeoutMs: 30_000, proxmoxHostConfig }
    : { timeoutMs: 30_000 };
  const result = await sshExec(instanceIpv4, repairCommand, sshOptions);
  if (!result.ok) {
    log.warn("managed sidecar refresh command failed", {
      source: "instance-security",
      instanceId,
      composeService,
      failureType: "managed_sidecar_refresh_command_failed",
      stderrTail: summarizeSidecarRefreshFailure(result.stderr),
      errorMessage: summarizeSidecarRefreshFailure(result.error),
    });
  }
  return result.ok;
}

export async function ensureManagedSidecarScript(
  params: ManagedSidecarRefreshParams,
): Promise<boolean> {
  const instanceId = params.id.trim();
  const instanceIpv4 = params.instanceIpv4.trim();
  const composeService = params.composeService === "dashboard-sidecar" ? "dashboard-sidecar" : "sidecar";

  if (!instanceIpv4 || !/^[a-zA-Z0-9_-]+$/.test(instanceId)) {
    return false;
  }

  const proxmoxHostConfig = resolveManagedSidecarHostConfig(params);
  if (!proxmoxHostConfig && isUnroutablePrivateGuestIpv4(instanceIpv4)) {
    log.warn("refused managed sidecar refresh for unroutable private guest IP", {
      source: "instance-security",
      instanceId,
      composeService,
      failureType: "managed_sidecar_refresh_unroutable_private_ip",
    });
    return false;
  }

  const cacheKey = `${composeService}:${instanceId}:${instanceIpv4}:${managedSidecarHostCacheKey(proxmoxHostConfig)}`;
  const expectedVersion = composeService === "dashboard-sidecar"
    ? DASHBOARD_SIDECAR_SCRIPT_VERSION
    : SIDECAR_SCRIPT_VERSION;
  const cached = managedSidecarRefreshCache.get(cacheKey);
  if (
    cached &&
    cached.version === expectedVersion &&
    Date.now() - cached.refreshedAt < MANAGED_SIDECAR_REFRESH_TTL_MS
  ) {
    return true;
  }

  const refreshed = await refreshManagedSidecarScript({
    id: instanceId,
    instanceIpv4,
    composeService,
    config: params.config,
    hostId: params.hostId,
  });
  if (refreshed) {
    managedSidecarRefreshCache.set(cacheKey, {
      refreshedAt: Date.now(),
      version: expectedVersion,
    });
  }

  return refreshed;
}

/**
 * Centrally validates row-level security equivalent constraints on the backend,
 * ensuring no API route can accidentally fetch an instance belonging to another user.
 */
export async function getSecureUserInstance({
  id,
  userId,
  requireRunning = false,
}: SecureInstanceOptions): Promise<SecureUserInstanceResult> {
  if (!supabaseAdmin) {
    throw new Error("Database not configured");
  }

  const { data: instance, error } = await supabaseAdmin
    .from("hermes_instances")
    .select("id, gateway_url, api_server_key_encrypted, api_key_encrypted, provider, backend, config, user_id, status, host_id, hetzner_server_id, ipv4_address, proxmox_vmid, proxmox_node, cpu_limit, ram_limit")
    .eq("id", id)
    .eq("user_id", userId)
    .neq("status", "deleted")
    .single<SecureUserInstanceQueryRecord>();

  if (error || !instance) {
    return { instance: null, error: "Instance not found or unauthorized", apiServerKey: "", instanceIpv4: "" };
  }

  if (requireRunning && instance.status !== "running") {
    return { instance: null, error: "Instance is not currently running", apiServerKey: "", instanceIpv4: "" };
  }

  if (!instance.gateway_url) {
    return { instance: null, error: "Gateway URL not configured", apiServerKey: "", instanceIpv4: "" };
  }

  const resolvedInstance: SecureUserInstanceRecord = {
    ...instance,
    gateway_url: instance.gateway_url,
  };

  let apiServerKey = "";
  let recoveredInstanceIpv4 = "";
  if (resolvedInstance.api_server_key_encrypted) {
    try {
      apiServerKey = decryptApiKey(resolvedInstance.api_server_key_encrypted);
    } catch {
      const recovered = await recoverAndPersistApiServerKeyFromManagedHost(resolvedInstance);
      if (!recovered) {
        return { instance: null, error: "Failed to decrypt API key", apiServerKey: "", instanceIpv4: "" };
      }

      apiServerKey = recovered.apiServerKey;
      recoveredInstanceIpv4 = recovered.instanceIpv4;
    }
  }

  if (!apiServerKey.trim()) {
    const recovered = await recoverAndPersistApiServerKeyFromManagedHost(resolvedInstance);
    if (!recovered) {
      return { instance: null, error: "Instance API server key not configured", apiServerKey: "", instanceIpv4: "" };
    }

    apiServerKey = recovered.apiServerKey;
    recoveredInstanceIpv4 = recovered.instanceIpv4;
  }

  const instanceIpv4 = recoveredInstanceIpv4 || await resolveInstanceIpv4(resolvedInstance);

  return {
    instance: resolvedInstance,
    apiServerKey,
    instanceIpv4,
    guestTarget: getHermesGuestSshTarget(resolvedInstance),
    error: null,
  };
}
