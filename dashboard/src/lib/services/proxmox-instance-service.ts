import { randomBytes } from "crypto";
import { spawn } from "child_process";

// SCRIPTURE_ANCHOR: proxmox-foundation | Luke 14:28 | Verse: Which of you, desiring to build a tower, doesn't first sit down and count the cost?
import { Client as Ssh2Client, type ConnectConfig } from "ssh2";
import type { CodexVaultBundle } from "@/lib/codex-oauth";
import type { NousVaultBundle } from "@/lib/nous-oauth";
import type { InstanceBankrAgentConfig } from "@/lib/billing/bankr-instance-wallets";
import { redactSensitiveCommandOutput } from "@/lib/command-output-redaction";
import {
  buildAgentDeployScript,
  PROVIDER_ID_MAP,
  type AgentSettings,
  type HonchoSettings,
} from "@/lib/services/hetzner-instance-builders";
import { resolveProviderBaseUrl } from "@/lib/services/provider-config";
import {
  assertSupportedProxmoxGatewayHost,
  isCoveredByProxmoxStaticOriginCert,
} from "@/lib/services/proxmox-gateway-caddy-site";
import { buildIdleGatedUpdateProvisioningScript } from "@/lib/services/idle-gated-update-builder";
import { resolveRamBurst } from "@/lib/services/ram-burst";
import {
  buildWebUIBootstrapScript,
  buildWebUIProvisioningArtifacts,
} from "@/lib/services/webui-instance-builder";
import {
  getCloudflareDnsConfig,
  mintInstanceDns,
  removeInstanceDnsBestEffort,
} from "@/lib/services/cloudflare-dns";
import {
  BROWSER_SIDECAR_DEPLOY_ENABLED_ENV,
  isBrowserSidecarDeploymentGateEnabled,
  instanceCanFitBrowserSidecar,
} from "@/lib/browser-sidecar/deployment-gate";
import type { InstanceBackend } from "@/lib/services/hetzner-instance-service";
import { isWebfreeBackend } from "@/lib/types/instance";
import type {
  A2ASettings,
  AutoUpdateConfig,
  MemorySystemConfig,
} from "@/lib/instance-settings";
import { log } from "@/lib/logger";
import { isCodexAuthProvider } from "@/lib/provider-auth";
import { isOperatorosAgentImage } from "@/lib/operatoros-flavor";
import { resolvePersonaSoulFromSystemPrompt } from "@/lib/persona-souls-accessor";
import { supabaseAdmin } from "@/lib/supabase";
// Proxmox script generation and output parsing live in dedicated modules
// (./proxmox/script-builders, ./proxmox/output-parsers). Everything this
// module used to export is re-exported below, so existing importers keep
// resolving the same names from "@/lib/services/proxmox-instance-service".
import {
  DEFAULT_PROXMOX_VM_DISK_GB,
  PROXMOX_VM_MISSING_MARKER,
  PROXMOX_VM_STILL_RUNNING_MARKER,
  buildProxmoxDeleteScript,
  buildProxmoxDormantArchiveScript,
  buildProxmoxInfrastructureDiscoveryScript,
  buildProxmoxMetricsScript,
  buildProxmoxOrphanCleanupScript,
  buildProxmoxPowerScript,
  buildProxmoxProvisionScript,
  buildProxmoxResizeScript,
  buildProxmoxStatusBatchScript,
  buildProxmoxStatusScript,
  buildProxmoxTemplateAvailabilityScript,
  buildProxmoxVmidAvailabilityScript,
  resolveProxmoxBalloonFloorMb,
  shQuote,
} from "./proxmox/script-builders";
import type { ProxmoxInstanceMetrics } from "./proxmox/output-parsers";
import {
  buildSudoTransportCommand,
  frameSudoTransportInput,
  HIVRA_SUDO_LOADER,
  parseMissingTool,
  stripSudoSentinel,
  SUDO_MISSING_TOOLS_PROBE,
  SUDO_TRUE_PROBE,
  sudoTransportFailureMessage,
  type SudoTransportFailure,
} from "./proxmox-sudo-transport";
import {
  parseProxmoxInfrastructureDiscoveryOutput,
  parseProxmoxMetricsOutput,
  parseProxmoxProvisionOutput,
  parseProxmoxTemplateAvailabilityOutput,
  parseProxmoxVmidAvailabilityOutput,
} from "./proxmox/output-parsers";

export {
  DEFAULT_PROXMOX_VM_DISK_GB,
  PROXMOX_VM_MISSING_MARKER,
  PROXMOX_VM_STILL_RUNNING_MARKER,
  buildProxmoxCaddySiteCleanupScript,
  buildProxmoxDeleteScript,
  buildProxmoxDormantArchiveScript,
  buildProxmoxGuestBootstrapScript,
  buildProxmoxInfrastructureDiscoveryScript,
  buildProxmoxMetricsScript,
  buildProxmoxPowerScript,
  buildProxmoxProvisionScript,
  buildProxmoxResizeScript,
  buildProxmoxStatusBatchScript,
  buildProxmoxStatusScript,
  buildProxmoxTemplateAuditScript,
  buildProxmoxTemplatePruneScript,
  buildProxmoxTenantIsolationGuard,
  resolveProxmoxBalloonFloorMb,
} from "./proxmox/script-builders";
export {
  parseProxmoxMetricsOutput,
  parseProxmoxProvisionOutput,
  parseProxmoxTemplateAuditOutput,
} from "./proxmox/output-parsers";
export type {
  ProxmoxInstanceMetrics,
  ProxmoxTemplateAuditDecision,
  ProxmoxTemplateAuditReport,
  ProxmoxTemplateAuditTemplate,
  ProxmoxTemplateAuditVm,
} from "./proxmox/output-parsers";


const LOG_SOURCE = "proxmox-instance-service";
const BROWSER_SIDECAR_PRO_TIERS = new Set(["operator", "fleet", "command"]);

function canProvisionBrowserSidecarForTier(tier: string | undefined): boolean {
  return BROWSER_SIDECAR_PRO_TIERS.has((tier ?? "").trim().toLowerCase());
}


export interface ProxmoxInfrastructure {
  provider: "proxmox";
  node?: string;
  vmid: number;
  privateIpv4: string;
  gatewayHost: string;
  templateVmid?: number;
  /** Non-secret owner metadata used to route future lifecycle calls to the same Proxmox host. */
  hostId?: string;
  hostSlug?: string;
  hostEnvPrefix?: string;
}

export interface ProxmoxHostRoutingConfig {
  /** Database host row id, useful for logs/persistence. Not used as a secret lookup. */
  hostId?: string | null;
  /** Non-secret slug such as fixturenodea/fixturenodea. Used to select prefixed PROXMOX_HOST_<SLUG>_* env values. */
  hostSlug?: string | null;
  /** Optional explicit env prefix, e.g. PROXMOX_HOST_FIXTURENODE2_. */
  envPrefix?: string | null;
  /** Test/programmatic override. Values are overlaid on top of the base env. */
  env?: EnvLike;
  /** Explicit host rows/config must not silently fall back to another Proxmox host. */
  failClosed?: boolean;
}

type ProxmoxHostAwareDeps = {
  env?: EnvLike;
  hostConfig?: ProxmoxHostRoutingConfig | null;
  runHostScript?: (script: string) => Promise<HostScriptResult>;
};

export type ProxmoxProvisionResult =
  | {
      ok: true;
      provider: "proxmox";
      serverId: 0;
      vmid: number;
      templateId: number;
      ipv4: string;
      sshHostFingerprint: null;
      apiServerKey: string;
      gatewayUrl: string;
      serverType: "proxmox-kvm";
      infrastructure: ProxmoxInfrastructure;
    }
  | {
      ok: false;
      error: string;
      failureType?: "proxmox_vmid_range_exhausted";
      targetId?: string | null;
      vmidStart?: number;
      vmidEnd?: number;
    };

export interface HostScriptResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
  /** A user connection's server presented a different host key than the
   * pinned one. Nothing was authenticated or sent. Lowercase SHA-256 hex. */
  presentedHostFingerprintSha256?: string;
  /** Sudo transport only: the command never reached the script, and the
   * fixed diagnosis says why. */
  sudoFailure?: SudoTransportFailure;
}

/** Default and absolute host-output limits protect the control plane from a
 * noisy or hostile SSH peer. The budget is shared by stdout and stderr. */
export const DEFAULT_PROXMOX_HOST_SCRIPT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const HARD_PROXMOX_HOST_SCRIPT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export type ProxmoxVmidAvailability =
  | {
      ok: true;
      targetId: string | null;
      vmidStart: number;
      vmidEnd: number;
      occupiedVmids: number[];
      freeVmids: number[];
    }
  | {
      ok: false;
      targetId: string | null;
      vmidStart: number;
      vmidEnd: number;
      error: string;
    };

export type ProxmoxTemplateAvailability =
  | {
      ok: true;
      targetId: string | null;
      templateId: number;
    }
  | {
      ok: false;
      targetId: string | null;
      templateId: number;
      error: string;
      reason: "missing" | "not_template" | "check_failed" | "not_configured";
    };

type EnvLike = Record<string, string | undefined>;
type HostScriptTimeoutOverride =
  | number
  | {
      timeoutMs?: number;
      earlyFinishMarker?: string;
      maxOutputBytes?: number;
      /** Sudo transport only. "bounded" (the default) stops the remote script
       * with TERM, then KILL, just before Hivra's own deadline. "none" is for
       * scripts that change packages (gVisor Prepare): a KILL inside apt or
       * dpkg would leave the package database interrupted, so, exactly as for
       * a root login, the script finishes on the server even if Hivra stopped
       * waiting. */
      remoteLimit?: "bounded" | "none";
    };

type ProvisionDeps = ProxmoxHostAwareDeps & {
  buildDeployScript?: typeof buildAgentDeployScript;
  /** Injectable so DNS failure fallback is regression-testable without a live
   * Cloudflare zone. Production uses the real implementation. */
  mintInstanceDns?: typeof mintInstanceDns;
  /** Reads VMIDs claimed by other non-deleted rows on the same Proxmox node so
   *  the in-VM picker can skip them. The script defaults to scanning `qm list`
   *  on the host, which doesn't see VMIDs claimed in DB columns by stranded
   *  rows whose Proxmox-side VM has been destroyed — that's the race the
   *  post-provision unique-key conflict was throwing into. Injectable for
   *  tests; the default queries supabaseAdmin via {@link getReservedProxmoxVmidsForNode}. */
  getReservedVmidsForNode?: (params: {
    proxmoxNode: string;
    excludeInstanceId: string;
  }) => Promise<number[]>;
};

const HERMES_PROXMOX_HOST_ENV_RESOLVED = "HERMES_PROXMOX_HOST_ENV_RESOLVED";
const HERMES_PROXMOX_TARGET_ENV_RESOLVED = "HERMES_PROXMOX_TARGET_ENV_RESOLVED";
const HERMES_PROXMOX_TARGET_ENV_ERROR = "HERMES_PROXMOX_TARGET_ENV_ERROR";

function envValue(env: EnvLike, key: string, fallback = ""): string {
  const value = env[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function shouldForceWebUIProvisionImagePull(
  targetId: string | null | undefined,
  env: EnvLike = process.env
): boolean {
  const rawTargets = envValue(env, "HERMES_WEBUI_PROVISION_FORCE_PULL_TARGETS", "all");
  const normalizedTarget = normalizeProxmoxTargetId(targetId);
  const normalizedRaw = rawTargets.trim().toLowerCase();

  if (!normalizedRaw || ["0", "false", "no", "off", "none", "disabled"].includes(normalizedRaw)) {
    return false;
  }
  if (["*", "all"].includes(normalizedRaw)) {
    return Boolean(normalizedTarget);
  }

  const forcePullTargets = normalizedRaw
    .split(/[,\s]+/)
    .map((value) => normalizeProxmoxTargetId(value))
    .filter((value): value is string => Boolean(value));

  return Boolean(normalizedTarget && forcePullTargets.includes(normalizedTarget));
}


function normalizeProxmoxHostSlug(value: string | null | undefined): string | null {
  const slug = value?.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return slug || null;
}

function envPrefixesForProxmoxHost(config: ProxmoxHostRoutingConfig | null | undefined, env: EnvLike): string[] {
  const prefixes: string[] = [];
  const explicitPrefix = config?.envPrefix?.trim();
  if (explicitPrefix) prefixes.push(explicitPrefix);

  const slug = normalizeProxmoxHostSlug(config?.hostSlug);
  const hostIdToken = config?.hostId?.trim()
    ? config.hostId.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_")
    : null;
  if (slug || hostIdToken) {
    if (slug) {
      const upper = slug.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
      prefixes.push(`PROXMOX_HOST_${upper}_`);
      prefixes.push(`PROXMOX_${upper}_`);
      prefixes.push(`${upper}_PROXMOX_`);
    }
    if (hostIdToken) {
      prefixes.push(`PROXMOX_HOST_ID_${hostIdToken}_`);
    }
  } else {
    // Legacy rows have no host identity. Prefer an explicit fixturenodea/pinned legacy
    // prefix when present so a future global PROXMOX_* flip cannot accidentally
    // retarget old VMs to fixturenodea. If no prefixed env exists, preserve current
    // production behavior by falling back to the ambient PROXMOX_* values.
    const legacySlug = normalizeProxmoxHostSlug(envValue(env, "HERMES_PROXMOX_LEGACY_HOST_SLUG", "fixturenode1"));
    if (legacySlug) {
      const upper = legacySlug.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
      prefixes.push(`PROXMOX_HOST_${upper}_`);
      prefixes.push(`PROXMOX_${upper}_`);
      prefixes.push(`${upper}_PROXMOX_`);
    }
  }

  return Array.from(new Set(prefixes));
}

function targetProxmoxEnvKeyFromSuffix(suffix: string): string | null {
  const clean = suffix.trim().replace(/^_+/, "");
  if (!clean) return null;
  if (clean.startsWith("PROXMOX_") || clean.startsWith("HERMES_PROXMOX_") || clean.startsWith("NEXT_PUBLIC_") || clean.startsWith("VERCEL_")) {
    return clean;
  }
  return `PROXMOX_${clean}`;
}

const PROXMOX_CANONICAL_ENV_PREFIX = "PROXMOX_";
const PROXMOX_AMBIENT_INHERIT_BLOCKLIST = new Set([
  "PROXMOX_NODE",
  "PROXMOX_PUBLIC_IP",
  "PROXMOX_SSH_HOST",
  "PROXMOX_SSH_KEY_PATH",
  "PROXMOX_SSH_PRIVATE_KEY",
  "PROXMOX_SSH_PRIVATE_KEY_B64",
  "PROXMOX_SSH_HOST_FINGERPRINT",
  "PROXMOX_ALLOW_SSH_AGENT",
  "PROXMOX_API_URL",
  "PROXMOX_API_TOKEN",
  "PROXMOX_API_TOKEN_ID",
  "PROXMOX_API_TOKEN_SECRET",
]);

function hasOwnEnvValue(env: EnvLike, key: string): boolean {
  return typeof env[key] === "string" && Boolean(env[key]?.trim());
}

export function resolveProxmoxHostEnv(
  hostConfig: ProxmoxHostRoutingConfig | null | undefined,
  baseEnv: EnvLike = process.env
): EnvLike {
  const explicitHost = Boolean(hostConfig?.hostId?.trim() || hostConfig?.hostSlug?.trim() || hostConfig?.envPrefix?.trim());

  // If the env was already resolved against a per-target host identity via
  // resolveProxmoxTargetConfiguration (which sets HERMES_PROXMOX_TARGET_ENV_RESOLVED),
  // skip the legacy-slug overlay. The candidate env already has canonical
  // PROXMOX_<KEY> populated from PROXMOX_<SLUG>_* for the chosen target;
  // re-overlaying with the default "fixturenodea" legacy prefix here would clobber
  // PROXMOX_PUBLIC_IP / PROXMOX_SSH_HOST / PROXMOX_API_URL etc. back to fixturenodea's,
  // and the downstream SSH call would route to the wrong host. Diagnosed
  // 2026-05-16 from production 503s where template availability checks for
  // fixturenodea/fixturenodea/fixturenodea candidates all returned "nodes/fixturenodea/qemu-server/9006.conf
  // does not exist" — fixturenodea was the actual SSH target for every candidate.
  if (!explicitHost && envValue(baseEnv, HERMES_PROXMOX_TARGET_ENV_RESOLVED) === "true") {
    return { ...baseEnv };
  }

  const hostEnv = hostConfig?.env ?? {};
  const sourceEnv: EnvLike = { ...baseEnv, ...hostEnv };
  const merged: EnvLike = { ...sourceEnv };
  const prefixes = envPrefixesForProxmoxHost(hostConfig, sourceEnv);
  const selectedHostKeys = new Set<string>();
  let applied = 0;

  for (const prefix of prefixes) {
    for (const [key, value] of Object.entries(sourceEnv)) {
      if (value === undefined || !key.startsWith(prefix)) continue;
      const targetKey = targetProxmoxEnvKeyFromSuffix(key.slice(prefix.length));
      if (!targetKey) continue;
      merged[targetKey] = value;
      selectedHostKeys.add(targetKey);
      applied += 1;
    }
  }

  for (const key of Object.keys(hostEnv)) {
    if (key.startsWith(PROXMOX_CANONICAL_ENV_PREFIX) && hasOwnEnvValue(hostEnv, key)) {
      selectedHostKeys.add(key);
    }
  }

  if (explicitHost && hostConfig?.failClosed !== false) {
    if (applied === 0 && Object.keys(hostEnv).length === 0) {
      throw new Error(
        `Proxmox host routing config for ${hostConfig?.hostSlug || hostConfig?.envPrefix || "unknown"} has no matching environment overrides`
      );
    }

    const inheritedBlockedKeys = Array.from(PROXMOX_AMBIENT_INHERIT_BLOCKLIST).filter(
      (key) => hasOwnEnvValue(baseEnv, key) && !selectedHostKeys.has(key)
    );
    if (inheritedBlockedKeys.length > 0) {
      throw new Error(
        `Proxmox host routing config for ${hostConfig?.hostSlug || hostConfig?.envPrefix || hostConfig?.hostId || "unknown"} is missing host-specific values for ${inheritedBlockedKeys.join(", ")}; refusing to inherit ambient Proxmox env`
      );
    }

    for (const key of Object.keys(merged)) {
      if (
        key.startsWith(PROXMOX_CANONICAL_ENV_PREFIX) &&
        !selectedHostKeys.has(key) &&
        hasOwnEnvValue(baseEnv, key) &&
        !hasOwnEnvValue(hostEnv, key)
      ) {
        delete merged[key];
      }
    }
  }

  const slug = normalizeProxmoxHostSlug(hostConfig?.hostSlug) ?? normalizeProxmoxHostSlug(envValue(merged, "HERMES_PROXMOX_LEGACY_HOST_SLUG", "fixturenode1"));
  if (slug) merged.PROXMOX_HOST_SLUG = slug;
  if (explicitHost) merged[HERMES_PROXMOX_HOST_ENV_RESOLVED] = "true";
  return merged;
}

export function getProxmoxHostRoutingConfigFromInfrastructure(
  infrastructure: Pick<ProxmoxInfrastructure, "hostId" | "hostSlug" | "hostEnvPrefix" | "node"> | null | undefined,
  row?: { host_id?: string | null } | null
): ProxmoxHostRoutingConfig | null {
  const hostId = infrastructure?.hostId ?? row?.host_id ?? null;
  const hostSlug = infrastructure?.hostSlug ?? infrastructure?.node ?? null;
  const envPrefix = infrastructure?.hostEnvPrefix ?? null;
  if (!hostId && !hostSlug && !envPrefix) return null;
  return {
    hostId,
    hostSlug,
    envPrefix,
    failClosed: true,
  };
}

function envInt(env: EnvLike, key: string, fallback: number): number {
  const raw = envValue(env, key);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envOptionalPositiveInt(env: EnvLike, key: string): number | null {
  const raw = envValue(env, key);
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseProxmoxVmidExhaustionError(
  detail: string
): { vmidStart: number; vmidEnd: number } | null {
  const match = detail.match(/No free Proxmox VMID in range\s+(\d+)-(\d+)/i);
  if (!match?.[1] || !match[2]) return null;
  const vmidStart = Number.parseInt(match[1], 10);
  const vmidEnd = Number.parseInt(match[2], 10);
  if (!Number.isFinite(vmidStart) || !Number.isFinite(vmidEnd)) return null;
  return { vmidStart, vmidEnd };
}

const PROXMOX_TARGET_ENV_KEYS = [
  "PROXMOX_ALLOW_SSH_AGENT",
  "PROXMOX_API_TOKEN",
  "PROXMOX_API_TOKEN_ID",
  "PROXMOX_API_TOKEN_SECRET",
  "PROXMOX_API_URL",
  "PROXMOX_CADDY_SITES_DIR",
  "PROXMOX_EXEC_MODE",
  "PROXMOX_GATEWAY_DOMAIN",
  "PROXMOX_IP_LAST_OCTET_START",
  "PROXMOX_PRIVATE_CIDR",
  "PROXMOX_PRIVATE_GATEWAY",
  "PROXMOX_PRIVATE_SUBNET_PREFIX",
  "PROXMOX_PROVISION_TIMEOUT_MS",
  "PROXMOX_PUBLIC_IP",
  "PROXMOX_SSH_HOST",
  "PROXMOX_SSH_HOST_FINGERPRINT",
  "PROXMOX_SSH_KEY_PATH",
  "PROXMOX_SSH_PORT",
  "PROXMOX_SSH_PRIVATE_KEY",
  "PROXMOX_SSH_PRIVATE_KEY_B64",
  "PROXMOX_SSH_USER",
  "PROXMOX_TEMPLATE_ID",
  "PROXMOX_VM_DISK_GB",
  "PROXMOX_VM_NAMESERVER",
  "PROXMOX_VM_SSH_KEY_PATH",
  "PROXMOX_VM_SSH_USER",
  "PROXMOX_VMID_END",
  "PROXMOX_VMID_START",
] as const;

const PROXMOX_TARGET_HOST_IDENTITY_KEYS = [
  "PROXMOX_PUBLIC_IP",
  "PROXMOX_SSH_HOST",
  "PROXMOX_SSH_HOST_FINGERPRINT",
  "PROXMOX_SSH_KEY_PATH",
  "PROXMOX_SSH_PRIVATE_KEY",
  "PROXMOX_SSH_PRIVATE_KEY_B64",
  "PROXMOX_API_URL",
] as const;

export type ProxmoxTargetConfiguration = {
  id: string | null;
  env: EnvLike;
};

function normalizeProxmoxTargetId(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || null;
}

function resolveRequestedProxmoxTargetId(env: EnvLike, requestedTargetId?: string | null): string | null {
  const explicit = normalizeProxmoxTargetId(requestedTargetId);
  if (explicit) return explicit;

  const configured = normalizeProxmoxTargetId(
    envValue(env, "HERMES_PROXMOX_TARGET") ||
      envValue(env, "PROXMOX_TARGET") ||
      envValue(env, "PROXMOX_NODE")
  );
  if (configured) return configured;

  const firstTarget = envValue(env, "HERMES_PROXMOX_TARGETS") || envValue(env, "PROXMOX_TARGETS");
  return normalizeProxmoxTargetId(firstTarget.split(/[,\s]+/).find(Boolean));
}

function resolveProxmoxTargetEnvPrefix(env: EnvLike, targetId: string | null | undefined): string | null {
  const normalized = normalizeProxmoxTargetId(targetId);
  if (!normalized) return null;

  const upper = normalized.toUpperCase();
  const prefixes = [
    `PROXMOX_HOST_${upper}_`,
    `PROXMOX_${upper}_`,
    `${upper}_PROXMOX_`,
  ];

  return prefixes.find((prefix) =>
    Object.entries(env).some(([key, value]) => key.startsWith(prefix) && typeof value === "string" && value.trim())
  ) ?? null;
}

export function resolveProxmoxTargetCandidateIds(env: EnvLike = process.env): string[] {
  const ids: string[] = [];
  const push = (value: string | null | undefined) => {
    const id = normalizeProxmoxTargetId(value);
    if (id && !ids.includes(id)) ids.push(id);
  };

  // Prefer the multi-target list (HERMES_PROXMOX_TARGETS) so the env-order
  // fallback path honours the declared rotation. HERMES_PROXMOX_TARGET
  // (singular) is only consulted when the multi-target list is empty.
  //
  // History: until 2026-05-12 the singular was pushed FIRST, which meant
  // any silent fall-through from the registry path to the env-order path
  // pinned every placement to whichever single host the singular pointed
  // at — masked the registry working correctly while one host got
  // saturated. The placement diagnosed at 2026-05-12 (every new VM on
  // fixturenodea while fixturenodea/fixturenodea sat empty with 128 GB free) traced to exactly
  // this priority. Multi-target list is now the source of truth for the
  // fallback's rotation.
  const configuredTargets = envValue(env, "HERMES_PROXMOX_TARGETS") || envValue(env, "PROXMOX_TARGETS");
  for (const target of configuredTargets.split(/[,\s]+/)) {
    push(target);
  }

  if (ids.length === 0) {
    push(envValue(env, "HERMES_PROXMOX_TARGET") || envValue(env, "PROXMOX_TARGET") || envValue(env, "PROXMOX_NODE"));
  }

  return ids;
}

export function resolveProxmoxTargetConfiguration(
  env: EnvLike = process.env,
  requestedTargetId?: string | null
): ProxmoxTargetConfiguration {
  const id = resolveRequestedProxmoxTargetId(env, requestedTargetId);
  if (!id) return { id: null, env: { ...env } };

  const targetPrefix = id.toUpperCase();
  const resolved: EnvLike = { ...env, PROXMOX_NODE: id };
  const selectedTargetKeys = new Set<string>();
  const targetPrefixes = [
    `PROXMOX_HOST_${targetPrefix}_`,
    `PROXMOX_${targetPrefix}_`,
    `${targetPrefix}_PROXMOX_`,
  ];

  for (const key of PROXMOX_TARGET_ENV_KEYS) {
    const suffix = key.replace(/^PROXMOX_/, "");
    const targetScopedValue = targetPrefixes
      .map((prefix) => envValue(env, `${prefix}${suffix}`))
      .find(Boolean);
    if (targetScopedValue) {
      resolved[key] = targetScopedValue;
      selectedTargetKeys.add(key);
    }
  }

  const ambientTargetId = normalizeProxmoxTargetId(envValue(env, "PROXMOX_NODE"));
  const allowAmbientTargetInherit = envValue(env, "HERMES_PROXMOX_ALLOW_AMBIENT_TARGET_INHERIT") === "true";
  const requiresTargetSpecificHostIdentity = !allowAmbientTargetInherit && ambientTargetId !== id;
  if (requiresTargetSpecificHostIdentity) {
    const inheritedHostIdentityKeys = PROXMOX_TARGET_HOST_IDENTITY_KEYS.filter(
      (key) => hasOwnEnvValue(env, key) && !selectedTargetKeys.has(key)
    );

    if (inheritedHostIdentityKeys.length > 0) {
      for (const key of inheritedHostIdentityKeys) {
        delete resolved[key];
      }
      resolved[HERMES_PROXMOX_TARGET_ENV_ERROR] =
        `Proxmox target ${id} is missing target-specific values for ${inheritedHostIdentityKeys.join(", ")}; refusing to inherit ambient host routing`;
    }
  }

  resolved[HERMES_PROXMOX_TARGET_ENV_RESOLVED] = "true";
  return { id, env: resolved };
}

export function resolveProxmoxTargetConfigurationUnlessHostResolved(env: EnvLike): ProxmoxTargetConfiguration {
  if (
    envValue(env, HERMES_PROXMOX_HOST_ENV_RESOLVED) === "true" ||
    envValue(env, HERMES_PROXMOX_TARGET_ENV_RESOLVED) === "true"
  ) {
    return {
      id: normalizeProxmoxTargetId(envValue(env, "PROXMOX_NODE")),
      env: { ...env },
    };
  }

  return resolveProxmoxTargetConfiguration(env);
}

export function resolveProxmoxOperationEnv(
  env: EnvLike,
  infrastructure?: Pick<ProxmoxInfrastructure, "node"> | null
): EnvLike {
  return resolveProxmoxTargetConfiguration(env, infrastructure?.node ?? null).env;
}

export const DEFAULT_PROXMOX_MAX_TENANT_INSTANCES = 40;

export function resolveProxmoxVmDiskGb(env: EnvLike = process.env): number {
  return envOptionalPositiveInt(env, "PROXMOX_VM_DISK_GB") ?? DEFAULT_PROXMOX_VM_DISK_GB;
}

export function resolveProxmoxMaxTenantInstances(env: EnvLike = process.env): number | null {
  const raw = envValue(env, "HERMES_PROXMOX_MAX_TENANT_INSTANCES");
  if (!raw) return DEFAULT_PROXMOX_MAX_TENANT_INSTANCES;
  const normalized = raw.toLowerCase();
  if (normalized === "0" || normalized === "none" || normalized === "unlimited") {
    return null;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_PROXMOX_MAX_TENANT_INSTANCES;
}

export function resolveProxmoxVmidEnd(env: EnvLike = process.env, vmidStart: number): number {
  const configuredEnd = envOptionalPositiveInt(env, "PROXMOX_VMID_END");
  if (configuredEnd) return configuredEnd;

  const maxTenantInstances = resolveProxmoxMaxTenantInstances(env);
  if (maxTenantInstances) {
    return vmidStart + maxTenantInstances - 1;
  }

  return 399;
}

function envPrivateKey(env: EnvLike): string {
  const b64 = envValue(env, "PROXMOX_SSH_PRIVATE_KEY_B64");
  if (b64) {
    return Buffer.from(b64, "base64").toString("utf8");
  }

  return envValue(env, "PROXMOX_SSH_PRIVATE_KEY").replace(/\\n/g, "\n");
}

/**
 * Normalize an OpenSSH SHA-256 host fingerprint to the lowercase hex digest
 * emitted by ssh2 when `hostHash: "sha256"` is configured. Accepts the usual
 * `SHA256:BASE64` display form as well as a 64-character hex digest.
 */
export function normalizeProxmoxSshHostFingerprint(fingerprint: string): string {
  const trimmed = fingerprint.trim();
  if (!trimmed) throw new Error("Proxmox SSH host fingerprint is empty.");

  const withoutPrefix = trimmed.replace(/^sha256:/i, "").trim();
  const compactHex = withoutPrefix.replace(/[\s:]+/g, "");
  const looksExplicitlyHex = withoutPrefix.includes(":") || compactHex.length === 64;
  if (looksExplicitlyHex && /^[a-f0-9:\s]+$/i.test(withoutPrefix)) {
    if (compactHex.length !== 64) {
      throw new Error("Proxmox SSH host fingerprint must contain 64 hexadecimal characters.");
    }
    return compactHex.toLowerCase();
  }

  const compactBase64 = withoutPrefix.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compactBase64)) {
    throw new Error("Proxmox SSH host fingerprint must use SHA256:BASE64 or hexadecimal form.");
  }
  const padding = compactBase64.length % 4;
  const padded = compactBase64 + (padding === 0 ? "" : "=".repeat(4 - padding));
  const digest = Buffer.from(padded, "base64");
  if (digest.length !== 32) {
    throw new Error("Proxmox SSH host fingerprint must contain a 32-byte SHA-256 digest.");
  }
  const canonical = digest.toString("base64").replace(/=+$/g, "");
  if (canonical !== compactBase64.replace(/=+$/g, "")) {
    throw new Error("Proxmox SSH host fingerprint is not canonical base64.");
  }
  return digest.toString("hex");
}


function sanitizeDnsLabel(value: string | null | undefined, fallback: string): string {
  const label = (value?.trim() || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  return label || fallback;
}

function sanitizeVmName(value: string): string {
  const safe = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return safe || `hermes-${randomBytes(4).toString("hex")}`;
}

function dashedIpv4(ipv4: string): string {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ipv4)) {
    throw new Error(`Invalid Proxmox public IPv4 address: ${ipv4}`);
  }
  return ipv4.replace(/\./g, "-");
}

export function resolveProxmoxGatewayConfiguration(params: {
  subdomain: string | null;
  publicIp: string;
  dnsDomain?: string | null;
}): { deployFqdn: "localhost"; fqdn: string; gatewayUrl: string } {
  const label = sanitizeDnsLabel(params.subdomain, `agent-${randomBytes(4).toString("hex")}`);
  const domain = params.dnsDomain?.trim().replace(/^\.+|\.+$/g, "");
  const fqdn = domain ? `${label}.${domain}` : `${label}.${dashedIpv4(params.publicIp)}.sslip.io`;

  return {
    deployFqdn: "localhost",
    fqdn,
    gatewayUrl: `https://${fqdn}`,
  };
}

/**
 * Canonical gateway URL for a Proxmox instance, derived from the instance
 * subdomain + the gateway domain the box actually serves on, using the EXACT
 * env-resolution + Cloudflare-vs-sslip precedence provisionProxmoxInstance
 * uses: prefer the Cloudflare `<subdomain>.<CLOUDFLARE_DNS_DOMAIN>` when the
 * zone is configured/proxied, else the host's PROXMOX_GATEWAY_DOMAIN, else the
 * host's `<dashedPublicIp>.sslip.io` fallback.
 *
 * This exists so instance sync/recovery NEVER writes gateway_url from a
 * possibly-stale `infrastructure.gatewayHost`, which on a restored/recovered
 * row can be a NAT bridge IP. A previous recovery wrote the private bridge as
 * gateway_url, causing repeated health failures against a healthy VM.
 * resolveProxmoxGatewayConfiguration structurally cannot
 * emit a bare-IP host (it always appends a domain or `.sslip.io`), so deriving
 * here repairs the incident class rather than trusting the stored host.
 *
 * Returns null when a canonical FQDN cannot be derived (no subdomain, the host
 * env fails to resolve, or the host has neither a gateway domain nor a public
 * IP configured). Callers MUST treat null as "leave the stored gateway_url
 * alone" — never persist null over a good URL, and never fall back to the
 * untrusted gatewayHost for a row whose gateway_url is empty.
 */
export function resolveProxmoxGatewayUrlFromSubdomain(params: {
  subdomain: string | null | undefined;
  hostConfig: ProxmoxHostRoutingConfig | null;
  env?: EnvLike;
}): string | null {
  const subdomain = params.subdomain?.trim();
  if (!subdomain) return null;

  let env: EnvLike;
  try {
    const hostEnv = resolveProxmoxHostEnv(params.hostConfig, params.env ?? process.env);
    env = resolveProxmoxTargetConfigurationUnlessHostResolved(hostEnv).env;
  } catch {
    // failClosed host routing with no matching per-host env overrides: we
    // can't safely derive a host domain, so leave the caller's value as-is.
    return null;
  }

  const publicIp = envValue(env, "PROXMOX_PUBLIC_IP");

  // Mirror provisionProxmoxInstance's gateway-domain precedence (the
  // Cloudflare-vs-sslip decision, MINUS the DNS mint — recovery only formats
  // the FQDN; the record already exists from provisioning). A prod Proxmox box
  // provisioned behind Cloudflare serves on `<subdomain>.<CLOUDFLARE_DNS_DOMAIN>`
  // (e.g. hermesos.cloud), NOT the per-host PROXMOX_GATEWAY_DOMAIN — prod sets
  // that to the `<dashedIP>.sslip.io` ACME/no-CF fallback. Deriving from
  // PROXMOX_GATEWAY_DOMAIN alone would hand back an sslip URL the box's Caddy
  // vhost doesn't serve → the same false-unhealthy probe storm, just not a
  // bridge IP. Keep this in lockstep with the provisioning block's
  // "Gateway DNS resolution" precedence.
  const cfConfig = getCloudflareDnsConfig(env);
  const configuredGatewayDomain = envValue(env, "PROXMOX_GATEWAY_DOMAIN");
  const cloudflareDomain = cfConfig?.domain?.trim().replace(/^\.+|\.+$/g, "") ?? "";
  const cloudflareDnsProxied = cfConfig?.proxied === true;
  const configuredGatewayIsCloudflareDomain = Boolean(
    configuredGatewayDomain &&
      cloudflareDomain &&
      (configuredGatewayDomain === cloudflareDomain ||
        configuredGatewayDomain.endsWith(`.${cloudflareDomain}`)),
  );
  const preferConfiguredGatewayDomain = Boolean(
    configuredGatewayDomain && !cloudflareDnsProxied && (!cfConfig || !configuredGatewayIsCloudflareDomain),
  );
  const useCloudflareDns = Boolean(!preferConfiguredGatewayDomain && cfConfig && publicIp);
  const dnsDomain = useCloudflareDns ? cloudflareDomain : configuredGatewayDomain;

  // With neither a resolvable gateway domain nor a public IP,
  // resolveProxmoxGatewayConfiguration would build "<label>..sslip.io"
  // (dashedIpv4("") throws). Bail so the caller keeps the stored value rather
  // than write garbage.
  if (!dnsDomain && !publicIp) return null;

  try {
    return resolveProxmoxGatewayConfiguration({
      subdomain,
      publicIp,
      dnsDomain,
    }).gatewayUrl;
  } catch {
    // publicIp present but not a valid IPv4 (e.g. a hostname) with no domain
    // → dashedIpv4 throws. Treat as underivable.
    return null;
  }
}

export function isProxmoxProvisioningConfigured(env: EnvLike = process.env): boolean {
  const target = resolveProxmoxTargetConfigurationUnlessHostResolved(env);
  const targetEnv = target.env;
  if (envValue(targetEnv, HERMES_PROXMOX_TARGET_ENV_ERROR)) return false;
  const mode = envValue(targetEnv, "PROXMOX_EXEC_MODE", "ssh");
  const hasPublicIp = Boolean(envValue(targetEnv, "PROXMOX_PUBLIC_IP"));
  if (mode === "local") {
    return hasPublicIp;
  }

  return Boolean(
    hasPublicIp &&
      envValue(targetEnv, "PROXMOX_SSH_HOST") &&
      (
        envValue(targetEnv, "PROXMOX_SSH_KEY_PATH") ||
        envPrivateKey(targetEnv) ||
        envValue(targetEnv, "PROXMOX_ALLOW_SSH_AGENT") === "true"
      )
  );
}

export function getProxmoxInfrastructure(config: unknown): ProxmoxInfrastructure | null {
  const rawConfig = typeof config === "object" && config ? config as Record<string, unknown> : {};
  const infrastructure = rawConfig.infrastructure;
  if (typeof infrastructure !== "object" || !infrastructure) return null;

  const raw = infrastructure as Record<string, unknown>;
  if (raw.provider !== "proxmox") return null;
  if (typeof raw.vmid !== "number" || !Number.isFinite(raw.vmid)) return null;
  if (typeof raw.privateIpv4 !== "string" || !raw.privateIpv4.trim()) return null;
  if (typeof raw.gatewayHost !== "string" || !raw.gatewayHost.trim()) return null;

  const templateVmid =
    typeof raw.templateVmid === "number" && Number.isFinite(raw.templateVmid)
      ? raw.templateVmid
      : undefined;
  const node =
    typeof raw.node === "string" && raw.node.trim()
      ? normalizeProxmoxTargetId(raw.node)
      : typeof raw.proxmoxNode === "string" && raw.proxmoxNode.trim()
        ? normalizeProxmoxTargetId(raw.proxmoxNode)
        : undefined;
  const hostId = typeof raw.hostId === "string" && raw.hostId.trim() ? raw.hostId.trim() : undefined;
  const hostSlug = typeof raw.hostSlug === "string" && raw.hostSlug.trim() ? raw.hostSlug.trim() : undefined;
  const hostEnvPrefix =
    typeof raw.hostEnvPrefix === "string" && raw.hostEnvPrefix.trim() ? raw.hostEnvPrefix.trim() : undefined;

  return {
    provider: "proxmox",
    ...(node ? { node } : {}),
    vmid: raw.vmid,
    privateIpv4: raw.privateIpv4,
    gatewayHost: raw.gatewayHost,
    ...(templateVmid ? { templateVmid } : {}),
    ...(hostId ? { hostId } : {}),
    ...(hostSlug ? { hostSlug } : {}),
    ...(hostEnvPrefix ? { hostEnvPrefix } : {}),
  };
}

// `resolveProxmoxLifecycleTarget` and `isProxmoxBackedInstanceRow` live in the
// lightweight `proxmox-infrastructure` module so they can be imported from
// edge contexts. Re-exported here for callers that already import from
// `proxmox-instance-service`.
export {
  getReleasedProxmoxInfrastructure,
  isProxmoxBackedInstanceRow,
  isProxmoxReleaseSafeForDbOnlyDelete,
  resolveProxmoxLifecycleTarget,
  stripProxmoxInfrastructure,
} from "@/lib/services/proxmox-infrastructure";
export type {
  ProxmoxInfrastructureReleaseMarker,
  ProxmoxInfrastructureReleaseReason,
  ProxmoxLifecycleRow,
} from "@/lib/services/proxmox-infrastructure";


export async function discoverProxmoxInfrastructureForInstance(
  params: {
    instanceId: string;
    instanceName: string;
    subdomain?: string | null;
  },
  deps: ProxmoxHostAwareDeps = {}
): Promise<ProxmoxInfrastructure | null> {
  // Use the same target resolution as provisionProxmoxInstance: when no
  // hostConfig is provided, fall back through HERMES_PROXMOX_TARGET /
  // PROXMOX_TARGET / PROXMOX_NODE / first(HERMES_PROXMOX_TARGETS) so
  // target.id is the canonical slug for the host the VM actually lives on.
  //
  // Reading PROXMOX_NODE directly here (the previous behaviour) silently
  // returned target.id = null when only HERMES_PROXMOX_TARGET was set in
  // prod env. Recovery would then write proxmox_node = null to the DB row
  // for a VM that actually lived on fixturenodea, and the next dashboard probe via
  // the (now-stale) legacy NULL slug would route to fixturenodea, hit qm status
  // missing, and auto-delete the row. This caused the Fixture Customer A / Fixture Customer B incident
  // (2026-05-07): 4 stuck-in-provisioning rows where post-provision UPDATE
  // never ran were "recovered" by this path with node=null, then nuked.
  const hostEnv = resolveProxmoxHostEnv(deps.hostConfig, deps.env ?? process.env);
  const target = resolveProxmoxTargetConfigurationUnlessHostResolved(hostEnv);
  const env = target.env;
  const targetId = target.id ?? normalizeProxmoxTargetId(envValue(env, "PROXMOX_NODE"));
  const inferredHostSlug = deps.hostConfig?.hostSlug || (!deps.hostConfig ? targetId : null);
  const inferredHostEnvPrefix =
    deps.hostConfig?.envPrefix || (!deps.hostConfig ? resolveProxmoxTargetEnvPrefix(hostEnv, targetId) : null);
  if (!isProxmoxProvisioningConfigured(env)) {
    return null;
  }

  const publicIp = envValue(env, "PROXMOX_PUBLIC_IP");
  const gatewayConfig = resolveProxmoxGatewayConfiguration({
    subdomain: params.subdomain ?? null,
    publicIp,
    dnsDomain: envValue(env, "PROXMOX_GATEWAY_DOMAIN"),
  });
  const vmName = sanitizeVmName(
    `hermes-${params.instanceName}-${params.instanceId.slice(0, 8)}`
  );
  const runner = deps.runHostScript ?? ((hostScript: string) => runProxmoxHostScript(hostScript, env));

  try {
    const result = await runner(buildProxmoxInfrastructureDiscoveryScript({ vmName }));
    if (!result.ok) return null;

    const discovered = parseProxmoxInfrastructureDiscoveryOutput(result.stdout);
    if (!discovered) return null;

    return {
      provider: "proxmox",
      ...(targetId ? { node: targetId } : {}),
      vmid: discovered.vmid,
      privateIpv4: discovered.privateIpv4,
      gatewayHost: gatewayConfig.fqdn,
      ...(deps.hostConfig?.hostId ? { hostId: deps.hostConfig.hostId } : {}),
      ...(inferredHostSlug ? { hostSlug: inferredHostSlug } : {}),
      ...(inferredHostEnvPrefix ? { hostEnvPrefix: inferredHostEnvPrefix } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Returns the VMIDs claimed by other non-deleted rows on the given Proxmox
 * node. The provision picker uses this to avoid the unique-key race that
 * surfaces as `post_provision_proxmox_metadata_conflict_active`: a previous
 * tenant's VM may have been destroyed on Proxmox while its
 * (proxmox_node, proxmox_vmid) DB columns still hold a unique-key lock —
 * `qm list` shows the slot free, the in-VM picker picks it, `qm clone`
 * succeeds, then the post-provision UPDATE 23505s.
 *
 * On a DB outage we return [] rather than throwing: failing open here
 * preserves the legacy `qm list`-only behaviour, which is strictly no
 * worse than what we had before this guard.
 */
export async function getReservedProxmoxVmidsForNode(params: {
  proxmoxNode: string;
  excludeInstanceId: string;
}): Promise<number[]> {
  if (!supabaseAdmin) return [];
  const node = params.proxmoxNode.trim();
  if (!node) return [];
  // `hermes_instances.id` is a uuid. The vmid-availability preflight calls this
  // with a sentinel string (`__vmid_availability_preflight__`) — there's no row
  // to exclude — and comparing that to a uuid column throws "invalid input
  // syntax for type uuid", which used to error the whole lookup and silently
  // drop EVERY reserved vmid (DB + hivra), degrading the picker to qm-list-only.
  // Only apply the exclusion when we were actually handed a uuid.
  const isUuidExclude =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      (params.excludeInstanceId ?? "").trim()
    );
  let legacyQuery = supabaseAdmin
    .from("hermes_instances")
    .select("proxmox_vmid")
    .eq("proxmox_node", node)
    .not("proxmox_vmid", "is", null)
    .neq("status", "deleted")
    .neq("lifecycle_state", "deleted");
  if (isUuidExclude) {
    legacyQuery = legacyQuery.neq("id", params.excludeInstanceId);
  }
  const [
    { data: legacyRows, error: legacyError },
    { data: hivraRows, error: hivraError },
  ] = await Promise.all([
    legacyQuery,
    supabaseAdmin
      .from("hivra_agents")
      .select("vmid")
      .eq("proxmox_host", node)
      .not("vmid", "is", null)
      .neq("status", "deleted"),
  ]);
  if (legacyError || hivraError) {
    log.warn("failed to read reserved proxmox vmids; falling back to qm-list-only picker", {
      source: LOG_SOURCE,
      failureType: "reserved_vmid_lookup_failed",
      proxmoxNode: node,
      excludeInstanceId: params.excludeInstanceId,
      legacyError: legacyError ? redactSensitiveCommandOutput(legacyError.message ?? "", 400) : null,
      hivraError: hivraError ? redactSensitiveCommandOutput(hivraError.message ?? "", 400) : null,
    });
    return [];
  }
  const seen = new Set<number>();
  for (const row of legacyRows ?? []) {
    const raw = (row as { proxmox_vmid?: unknown }).proxmox_vmid;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      seen.add(Math.trunc(raw));
    }
  }
  for (const row of hivraRows ?? []) {
    const raw = (row as { vmid?: unknown }).vmid;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      seen.add(Math.trunc(raw));
    }
  }
  return Array.from(seen).sort((a, b) => a - b);
}


export async function getProxmoxTemplateAvailability(
  deps: ProxmoxHostAwareDeps = {}
): Promise<ProxmoxTemplateAvailability> {
  const hostEnv = resolveProxmoxHostEnv(deps.hostConfig, deps.env ?? process.env);
  const target = resolveProxmoxTargetConfigurationUnlessHostResolved(hostEnv);
  const env = target.env;
  const targetId = target.id ?? normalizeProxmoxTargetId(envValue(env, "PROXMOX_NODE"));
  const templateId = envInt(env, "PROXMOX_TEMPLATE_ID", 9000);

  if (!isProxmoxProvisioningConfigured(env)) {
    return {
      ok: false,
      targetId,
      templateId,
      reason: "not_configured",
      error: targetId
        ? `Proxmox deployment target "${targetId}" is not configured.`
        : "Proxmox deployment not configured.",
    };
  }

  const runner = deps.runHostScript ?? ((script: string) => runProxmoxHostScript(script, env));
  const result = await runner(buildProxmoxTemplateAvailabilityScript({ templateId }));
  if (!result.ok) {
    return {
      ok: false,
      targetId,
      templateId,
      reason: "check_failed",
      error: redactSensitiveCommandOutput(
        result.stderr || result.error || result.stdout || "Unknown Proxmox template availability failure.",
        800
      ),
    };
  }

  const parsed = parseProxmoxTemplateAvailabilityOutput(result.stdout);
  if (parsed.ready) {
    return { ok: true, targetId, templateId };
  }

  if (parsed.missing) {
    return {
      ok: false,
      targetId,
      templateId,
      reason: "missing",
      error: redactSensitiveCommandOutput(
        parsed.details || `Proxmox template VM ${templateId} does not exist on the selected node.`,
        800
      ),
    };
  }

  if (parsed.notTemplate) {
    return {
      ok: false,
      targetId,
      templateId,
      reason: "not_template",
      error: `Proxmox VM ${templateId} exists but is not marked as a template.`,
    };
  }

  return {
    ok: false,
    targetId,
    templateId,
    reason: "check_failed",
    error: "Proxmox template availability check returned no template status.",
  };
}

export async function getProxmoxVmidAvailability(
  deps: ProxmoxHostAwareDeps = {}
): Promise<ProxmoxVmidAvailability> {
  const hostEnv = resolveProxmoxHostEnv(deps.hostConfig, deps.env ?? process.env);
  const target = resolveProxmoxTargetConfigurationUnlessHostResolved(hostEnv);
  const env = target.env;
  const targetId = target.id ?? normalizeProxmoxTargetId(envValue(env, "PROXMOX_NODE"));
  const vmidStart = envInt(env, "PROXMOX_VMID_START", 200);
  const vmidEnd = resolveProxmoxVmidEnd(env, vmidStart);

  if (!isProxmoxProvisioningConfigured(env)) {
    return {
      ok: false,
      targetId,
      vmidStart,
      vmidEnd,
      error: targetId
        ? `Proxmox deployment target "${targetId}" is not configured.`
        : "Proxmox deployment not configured.",
    };
  }

  const runner = deps.runHostScript ?? ((script: string) => runProxmoxHostScript(script, env));
  const result = await runner(buildProxmoxVmidAvailabilityScript({ vmidStart, vmidEnd }));
  if (!result.ok) {
    return {
      ok: false,
      targetId,
      vmidStart,
      vmidEnd,
      error: redactSensitiveCommandOutput(
        result.stderr || result.error || result.stdout || "Unknown Proxmox VMID availability failure.",
        800
      ),
    };
  }

  const parsed = parseProxmoxVmidAvailabilityOutput(result.stdout);
  const reservedVmids = targetId
    ? await getReservedProxmoxVmidsForNode({
        proxmoxNode: targetId,
        excludeInstanceId: "__vmid_availability_preflight__",
      })
    : [];
  const occupiedSet = new Set(parsed.occupiedVmids);
  for (const vmid of reservedVmids) {
    if (vmid >= vmidStart && vmid <= vmidEnd) occupiedSet.add(vmid);
  }
  const occupiedVmids = Array.from(occupiedSet).sort((a, b) => a - b);
  const freeVmids = parsed.freeVmids
    .filter((vmid) => !occupiedSet.has(vmid))
    .sort((a, b) => a - b);
  if (freeVmids.length + occupiedVmids.length === 0) {
    return {
      ok: false,
      targetId,
      vmidStart,
      vmidEnd,
      error: "Proxmox VMID availability check returned no allocator rows.",
    };
  }

  return {
    ok: true,
    targetId,
    vmidStart,
    vmidEnd,
    occupiedVmids,
    freeVmids,
  };
}

// Mirrors Hetzner's mapHetznerStatus + getHetznerInstanceStatus contract so
// callers can swap between providers without switching shapes.
export interface ProxmoxInstanceStatus {
  status: "provisioning" | "running" | "stopped" | "error" | "redeploying";
  ipv4?: string;
  // True when `qm status` reports the VMID is missing — the VM was either
  // destroyed by Phase 2's cleanup trap or manually purged. Distinct from
  // a deliberate "stopped" (paused VM still exists), so callers can release
  // the row's `proxmox_vmid` claim and let the partial unique index recycle
  // the slot for a future provision.
  vmMissing?: boolean;
}

function mapProxmoxStatus(raw: string): ProxmoxInstanceStatus["status"] {
  const normalized = raw.toLowerCase().trim();
  if (normalized === "running") return "running";
  if (normalized === "stopped" || normalized === "paused") return "stopped";
  if (normalized === "prelaunch" || normalized === "starting") return "provisioning";
  return "error";
}


export async function getProxmoxInstanceStatus(
  target: number | Pick<ProxmoxInfrastructure, "vmid" | "node">,
  deps: ProxmoxHostAwareDeps = {}
): Promise<ProxmoxInstanceStatus> {
  const vmid = typeof target === "number" ? target : target.vmid;
  const env = deps.hostConfig
    ? resolveProxmoxHostEnv(deps.hostConfig, deps.env ?? process.env)
    : resolveProxmoxOperationEnv(
        deps.env ?? process.env,
        typeof target === "number" ? null : target
      );
  if (!isProxmoxProvisioningConfigured(env)) {
    return { status: "error" };
  }

  const runner = deps.runHostScript ?? ((hostScript: string) => runProxmoxHostScript(hostScript, env));
  try {
    const result = await runner(buildProxmoxStatusScript(vmid));
    if (!result.ok) {
      return { status: "error" };
    }
    const match = result.stdout.match(/^STATUS\s+(\S+)/m);
    if (!match) {
      return { status: "error" };
    }
    const value = match[1];
    if (value === "missing") {
      return { status: "stopped", vmMissing: true };
    }
    return { status: mapProxmoxStatus(value) };
  } catch {
    return { status: "error" };
  }
}


export async function getProxmoxInstanceStatusBatch(
  vmids: number[],
  deps: ProxmoxHostAwareDeps & {
    hostConfig: ProxmoxHostRoutingConfig;
  }
): Promise<Map<number, ProxmoxInstanceStatus>> {
  const result = new Map<number, ProxmoxInstanceStatus>();
  if (vmids.length === 0) return result;

  const env = resolveProxmoxHostEnv(deps.hostConfig, deps.env ?? process.env);
  if (!isProxmoxProvisioningConfigured(env)) {
    for (const vmid of vmids) result.set(vmid, { status: "error" });
    return result;
  }

  const runner = deps.runHostScript ?? ((hostScript: string) => runProxmoxHostScript(hostScript, env));
  let listing: { ok: boolean; stdout: string };
  try {
    listing = await runner(buildProxmoxStatusBatchScript());
  } catch {
    for (const vmid of vmids) result.set(vmid, { status: "error" });
    return result;
  }

  if (!listing.ok) {
    for (const vmid of vmids) result.set(vmid, { status: "error" });
    return result;
  }

  const observed = new Map<number, string>();
  for (const line of listing.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [vmidRaw, statusRaw] = trimmed.split(/\s+/, 2);
    const vmid = Number(vmidRaw);
    if (!Number.isInteger(vmid) || !statusRaw) continue;
    observed.set(vmid, statusRaw);
  }

  for (const vmid of vmids) {
    const value = observed.get(vmid);
    if (value === undefined) {
      result.set(vmid, { status: "stopped", vmMissing: true });
      continue;
    }
    result.set(vmid, { status: mapProxmoxStatus(value) });
  }
  return result;
}


/**
 * Pull the current resource snapshot for a single Proxmox VM. Read-only —
 * does not mutate the VM. Returns null if the VM is missing/destroyed
 * (caller treats as "skip this sample, instance gone").
 */
export async function getProxmoxInstanceMetrics(
  target: number | Pick<ProxmoxInfrastructure, "vmid" | "node">,
  deps: ProxmoxHostAwareDeps = {}
): Promise<ProxmoxInstanceMetrics | null> {
  const vmid = typeof target === "number" ? target : target.vmid;
  const env = deps.hostConfig
    ? resolveProxmoxHostEnv(deps.hostConfig, deps.env ?? process.env)
    : resolveProxmoxOperationEnv(
        deps.env ?? process.env,
        typeof target === "number" ? null : target
      );
  if (!isProxmoxProvisioningConfigured(env)) {
    return null;
  }

  const runner =
    deps.runHostScript ?? ((hostScript: string) => runProxmoxHostScript(hostScript, env, { timeoutMs: 30_000 }));
  try {
    const result = await runner(buildProxmoxMetricsScript(vmid, {
      vmSshUser: envValue(env, "PROXMOX_VM_SSH_USER", "hermes"),
      vmSshKeyPath: envValue(env, "PROXMOX_VM_SSH_KEY_PATH", "/etc/hivra/keys/vm-orchestrator"),
    }));
    if (!result.ok) {
      return null;
    }
    return parseProxmoxMetricsOutput(result.stdout);
  } catch {
    return null;
  }
}


export function isProxmoxVmMissingResult(result: HostScriptResult): boolean {
  return !result.ok && result.stdout.includes(PROXMOX_VM_MISSING_MARKER);
}

export function isProxmoxVmStillRunningResult(result: HostScriptResult): boolean {
  return !result.ok && result.stdout.includes(PROXMOX_VM_STILL_RUNNING_MARKER);
}


function resolveHostScriptMaxOutputBytes(override: HostScriptTimeoutOverride | undefined): number {
  const requested = typeof override === "object" ? override.maxOutputBytes : undefined;
  if (!Number.isSafeInteger(requested) || (requested ?? 0) <= 0) {
    return DEFAULT_PROXMOX_HOST_SCRIPT_MAX_OUTPUT_BYTES;
  }
  return Math.min(requested!, HARD_PROXMOX_HOST_SCRIPT_MAX_OUTPUT_BYTES);
}

function spawnWithInput(
  command: string,
  args: string[],
  input: string,
  timeoutMs: number,
  maxOutputBytes: number,
  childEnv?: NodeJS.ProcessEnv,
): Promise<HostScriptResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], ...(childEnv ? { env: childEnv } : {}) });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let settled = false;

    const capturedResult = (error: string): HostScriptResult => ({
      ok: false,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      error,
    });

    const capture = (target: Buffer[], chunk: Buffer): boolean => {
      const remaining = maxOutputBytes - capturedBytes;
      if (remaining > 0) {
        const capturedChunk = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
        target.push(capturedChunk);
        capturedBytes += capturedChunk.length;
      }
      return chunk.length <= remaining;
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve(capturedResult(`Proxmox host script timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const captureOrTerminate = (target: Buffer[], chunk: Buffer) => {
      if (settled) return;
      if (capture(target, chunk)) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      resolve(capturedResult(`Proxmox host script output exceeded ${maxOutputBytes} bytes`));
    };

    child.stdout.on("data", (chunk: Buffer) => captureOrTerminate(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => captureOrTerminate(stderr, chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        error: error.message,
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      resolve({
        ok: code === 0,
        stdout: stdoutText,
        stderr: stderrText,
        error: code === 0 ? undefined : `Proxmox host script exited with code ${code}`,
      });
    });
    child.stdin.end(input);
  });
}

/** One host script run. `loginCommand`/`loginInput` are today's exact SSH
 * command and stdin; `script`/`stdin` are what the sudo transport frames
 * instead, for connections whose privilege is "sudo". */
type HostInvocation = {
  loginCommand: string;
  loginInput: string;
  script: string;
  stdin: string;
};

function withoutSudoSentinel(result: HostScriptResult): HostScriptResult {
  return { ...result, stderr: stripSudoSentinel(result.stderr).stderr };
}

async function runProxmoxHostInvocation(
  invocation: HostInvocation,
  env: EnvLike = process.env,
  timeoutMsOverride?: HostScriptTimeoutOverride
): Promise<HostScriptResult> {
  env = resolveProxmoxTargetConfigurationUnlessHostResolved(env).env;
  const targetEnvError = envValue(env, HERMES_PROXMOX_TARGET_ENV_ERROR);
  if (targetEnvError) {
    return { ok: false, stdout: "", stderr: "", error: targetEnvError };
  }
  const timeoutMs =
    typeof timeoutMsOverride === "number"
      ? timeoutMsOverride
      : timeoutMsOverride?.timeoutMs ?? envInt(env, "PROXMOX_PROVISION_TIMEOUT_MS", 20 * 60 * 1000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    return { ok: false, stdout: "", stderr: "", error: "Invalid Proxmox host script timeout" };
  }
  // Include asynchronous key loading in the SSH dispatch budget. A delayed
  // timer is not authority to start bash or write script input after expiry.
  const dispatchDeadline = performance.now() + timeoutMs;
  const earlyFinishMarker =
    typeof timeoutMsOverride === "object" ? timeoutMsOverride?.earlyFinishMarker : undefined;
  const maxOutputBytes = resolveHostScriptMaxOutputBytes(timeoutMsOverride);
  const mode = envValue(env, "PROXMOX_EXEC_MODE", "ssh");
  const userInfrastructureConnection =
    envValue(env, "HIVRA_USER_INFRA_CONNECTION").toLowerCase() === "true";
  // The managed fleet never sets this; login connections keep today's exact
  // commands. Only a user connection that recorded sudo uses the transport.
  const sudoTransport = userInfrastructureConnection
    && envValue(env, "PROXMOX_SSH_PRIVILEGE") === "sudo";
  const sudoInput = sudoTransport ? frameSudoTransportInput(invocation.script, invocation.stdin) : null;
  if (sudoTransport && sudoInput === null) {
    return { ok: false, stdout: "", stderr: "", error: "Invalid host script for the sudo transport" };
  }
  const remoteLimit = typeof timeoutMsOverride === "object" && timeoutMsOverride.remoteLimit === "none" ? "none" : "bounded";
  const command = sudoTransport ? buildSudoTransportCommand(timeoutMs, remoteLimit) : invocation.loginCommand;
  const input = sudoTransport ? sudoInput! : invocation.loginInput;

  if (mode === "local") {
    // Local mode runs the same framing without sudo, so the loader's
    // behaviour can be checked on a development machine. LC_ALL=C as on the
    // server: the loader counts the script's length in bytes.
    if (sudoTransport) {
      return withoutSudoSentinel(
        await spawnWithInput("bash", ["--noprofile", "--norc", "-c", HIVRA_SUDO_LOADER], input, timeoutMs, maxOutputBytes,
          { ...process.env, LC_ALL: "C" }),
      );
    }
    return command === "bash -s"
      ? spawnWithInput("bash", ["-s"], input, timeoutMs, maxOutputBytes)
      : spawnWithInput("bash", ["-c", command], input, timeoutMs, maxOutputBytes);
  }

  const host = envValue(env, "PROXMOX_SSH_HOST");
  const user = envValue(env, "PROXMOX_SSH_USER", "root");
  const port = envValue(env, "PROXMOX_SSH_PORT", "22");
  const hostKeyType = userInfrastructureConnection ? envValue(env, "PROXMOX_SSH_HOST_KEY_TYPE") : "";
  if (hostKeyType && hostKeyType !== "ssh-ed25519") {
    return { ok: false, stdout: "", stderr: "", error: "Unsupported pinned SSH host key type." };
  }
  const configuredHostFingerprint = envValue(env, "PROXMOX_SSH_HOST_FINGERPRINT");
  let expectedHostFingerprint: string | null = null;
  if (configuredHostFingerprint) {
    try {
      expectedHostFingerprint = normalizeProxmoxSshHostFingerprint(configuredHostFingerprint);
    } catch (err) {
      return {
        ok: false,
        stdout: "",
        stderr: "",
        error: err instanceof Error ? err.message : "Invalid Proxmox SSH host fingerprint.",
      };
    }
  }
  if (userInfrastructureConnection && !expectedHostFingerprint) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      error: "User-owned Proxmox connections require a pinned SSH host fingerprint.",
    };
  }
  const keyPath = envValue(env, "PROXMOX_SSH_KEY_PATH");
  if (!host) {
    return { ok: false, stdout: "", stderr: "", error: "PROXMOX_SSH_HOST is not configured." };
  }
  const privateKeyEnv = envPrivateKey(env);
  if (!keyPath && !privateKeyEnv && envValue(env, "PROXMOX_ALLOW_SSH_AGENT") !== "true") {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      error: "PROXMOX_SSH_KEY_PATH or an in-memory Proxmox SSH private key is not configured.",
    };
  }

  // Pure-JS SSH via ssh2 — works in Vercel serverless (which has no `ssh`
  // binary on PATH). Mirrors the Hetzner path in src/lib/hetzner/ssh.ts.
  // We read the private key once into memory; the legacy `keyPath` env var
  // path falls back to reading from disk for self-hosted dev where the key
  // already lives at PROXMOX_SSH_KEY_PATH.
  let privateKeyBuf: Buffer | null = null;
  if (privateKeyEnv) {
    privateKeyBuf = Buffer.from(privateKeyEnv, "utf8");
  } else if (keyPath) {
    try {
      const { readFile } = await import("fs/promises");
      privateKeyBuf = await readFile(/*turbopackIgnore: true*/ keyPath);
    } catch (err) {
      return {
        ok: false,
        stdout: "",
        stderr: "",
        error: `Failed to read PROXMOX_SSH_KEY_PATH=${keyPath}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return await new Promise<HostScriptResult>((resolve) => {
      const conn = new Ssh2Client();
      let settled = false;
      // What the server presented, recorded before the verifier refuses it.
      let presentedFingerprint: string | null = null;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;

      const capturedOutput = () => ({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
      const timeoutResult = (): HostScriptResult => ({
        ok: false,
        ...capturedOutput(),
        error: `Proxmox SSH operation timed out after ${timeoutMs}ms`,
      });

      const finish = (result: HostScriptResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          conn.end();
        } catch {
          // ignore
        }
        const bounded = result.ok && performance.now() >= dispatchDeadline ? timeoutResult() : result;
        resolve(sudoTransport ? withoutSudoSentinel(bounded) : bounded);
      };

      const timer = setTimeout(() => {
        finish(timeoutResult());
      }, Math.max(1, dispatchDeadline - performance.now()));
      const active = () => {
        if (settled) return false;
        if (performance.now() >= dispatchDeadline) {
          finish(timeoutResult());
          return false;
        }
        return true;
      };

      const captureChunk = (target: Buffer[], chunk: Buffer, stream: "stdout" | "stderr") => {
        if (!active()) return false;
        const capturedBytes = stdoutBytes + stderrBytes;
        const remaining = maxOutputBytes - capturedBytes;
        if (remaining > 0) {
          const capturedChunk = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
          target.push(capturedChunk);
          if (stream === "stdout") stdoutBytes += capturedChunk.length;
          else stderrBytes += capturedChunk.length;
        }
        if (chunk.length <= remaining) return true;
        finish({
          ok: false,
          ...capturedOutput(),
          error: `Proxmox host script output exceeded ${maxOutputBytes} bytes`,
        });
        return false;
      };

      const connectConfig: ConnectConfig = {
        host,
        port: Number(port) || 22,
        username: user,
        // ssh2 accepts undefined privateKey — falls through to ssh-agent
        // if PROXMOX_ALLOW_SSH_AGENT=true is configured at runtime.
        ...(privateKeyBuf ? { privateKey: privateKeyBuf } : {}),
        readyTimeout: Math.min(timeoutMs, 60_000),
        // An enrolled connection recorded its Ed25519 key: offer only that
        // algorithm, so another key type is refused before authentication.
        ...(hostKeyType === "ssh-ed25519" ? { algorithms: { serverHostKey: ["ssh-ed25519" as const] } } : {}),
        ...(expectedHostFingerprint
          ? {
              hostHash: "sha256",
              hostVerifier: (fingerprint: string) => {
                presentedFingerprint = String(fingerprint).trim().toLowerCase();
                return active() && presentedFingerprint === expectedHostFingerprint;
              },
            }
          : {}),
      };

      const t0 = Date.now();
      const debugLog = (event: string, extra?: Record<string, unknown>) => {
        if (!earlyFinishMarker) return; // only log for provisioning calls
        log.debug("proxmox runner event", {
          source: LOG_SOURCE,
          event,
          elapsedMs: Date.now() - t0,
          ...(extra ?? {}),
        });
      };

      conn.on("ready", () => {
        if (!active()) return;
        debugLog("ssh.ready");
        if (!active()) return;
        conn.exec(command, (err, stream) => {
          if (!active()) {
            // A late channel acknowledgement is not permission to send even
            // one byte of a setup/provisioning script after cancellation.
            try { stream?.destroy(); } catch { /* Best-effort late-channel teardown. */ }
            return;
          }
          if (err) {
            debugLog("ssh.exec.error", { message: err.message });
            finish({
              ok: false,
              stdout: "",
              stderr: "",
              error: `SSH exec failed: ${err.message}`,
            });
            return;
          }
          debugLog("ssh.exec.ready");
          stream.on("close", (code: number) => {
            if (!active()) return;
            debugLog("stream.close", {
              code,
              stdoutBytes,
              stderrBytes,
            });
            const { stdout, stderr } = capturedOutput();
            if (code === 0) {
              finish({ ok: true, stdout, stderr });
            } else if (sudoTransport && !stripSudoSentinel(stderr).sentinel) {
              // No sentinel: the command never reached the script. sudo's own
              // messages follow the server's locale, so run fixed probes
              // instead of parsing them. Only on this failure path.
              void diagnoseSudoTransport().then((failure) => finish({
                ok: false,
                stdout,
                stderr,
                error: sudoTransportFailureMessage(failure),
                sudoFailure: failure,
              }));
            } else {
              finish({
                ok: false,
                stdout,
                stderr,
                error: `Remote bash exited with code ${code}`,
              });
            }
          });
          stream.on("data", (chunk: Buffer) => {
            if (!captureChunk(stdoutChunks, chunk, "stdout")) return;
            debugLog("stream.data", {
              chunkBytes: chunk.length,
              totalBytes: stdoutBytes,
            });
            // Early-finish on a sentinel line. Proxmox provisioning emits
            // HERMES_PROXMOX_RESULT after Phase 1 completes; the rest of
            // the script forks Phase 2 detached and exits. In some Vercel
            // serverless environments the SSH channel-close event doesn't
            // fire promptly even after the remote bash exits — sshd waits
            // on inherited FDs that the disowned grandchild "should" have
            // released — leaving the orchestrator's lambda blocked until
            // it hits the 300s function timeout. By the time Vercel kills
            // the lambda, the kickoff metadata never reached the DB and
            // the row is orphaned with status='provisioning' / null vmid.
            // Resolve the moment we see the marker; Phase 2 continues
            // independently on the host.
            if (earlyFinishMarker && !settled) {
              const stdout = Buffer.concat(stdoutChunks).toString("utf8");
              if (stdout.includes(earlyFinishMarker)) {
                debugLog("marker.found");
                const stderr = Buffer.concat(stderrChunks).toString("utf8");
                finish({ ok: true, stdout, stderr });
              }
            }
          });
          stream.stderr.on("data", (chunk: Buffer) => {
            if (!captureChunk(stderrChunks, chunk, "stderr")) return;
            debugLog("stream.stderr.data", { chunkBytes: chunk.length });
          });
          // Pipe the script into bash -s's stdin and close it
          if (!active()) {
            try { stream.destroy(); } catch { /* No late script dispatch. */ }
            return;
          }
          stream.write(input);
          stream.end();
          debugLog("script.written", { bytes: input.length });
        });
      });

      // Up to two fixed commands on the same connection, each bounded by the
      // same dispatch deadline and a small output cap.
      const runProbe = (probe: string): Promise<{ code: number | null; stdout: string }> =>
        new Promise((settle) => {
          if (!active()) {
            settle({ code: null, stdout: "" });
            return;
          }
          conn.exec(probe, (err, stream) => {
            if (err || !active()) {
              try { stream?.destroy(); } catch { /* Best-effort probe teardown. */ }
              settle({ code: null, stdout: "" });
              return;
            }
            const chunks: Buffer[] = [];
            let bytes = 0;
            stream.on("data", (chunk: Buffer) => {
              if (bytes < 4_096) chunks.push(chunk.subarray(0, 4_096 - bytes));
              bytes += chunk.length;
            });
            stream.stderr.on("data", () => undefined);
            stream.on("close", (code: number) => {
              settle({ code: typeof code === "number" ? code : null, stdout: Buffer.concat(chunks).toString("utf8") });
            });
            stream.end();
          });
        });
      const diagnoseSudoTransport = async (): Promise<SudoTransportFailure> => {
        const missing = parseMissingTool((await runProbe(SUDO_MISSING_TOOLS_PROBE)).stdout);
        if (missing) return { kind: "missing_tool", path: missing };
        const sudoTrue = await runProbe(SUDO_TRUE_PROBE);
        return sudoTrue.code === 0 ? { kind: "command_not_allowed" } : { kind: "password_required" };
      };

      conn.on("error", (err: Error) => {
        finish({
          ok: false,
          ...capturedOutput(),
          error: `SSH connection failed: ${err.message}`,
          ...(expectedHostFingerprint && presentedFingerprint !== null && presentedFingerprint !== expectedHostFingerprint
            ? { presentedHostFingerprintSha256: presentedFingerprint }
            : {}),
        });
      });

      try {
        if (!active()) return;
        conn.connect(connectConfig);
      } catch (err) {
        finish({
          ok: false,
          stdout: "",
          stderr: "",
          error: `SSH connect threw: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
  });
}

export async function runProxmoxHostScript(
  script: string,
  env: EnvLike = process.env,
  timeoutMsOverride?: HostScriptTimeoutOverride,
): Promise<HostScriptResult> {
  return runProxmoxHostInvocation(
    { loginCommand: "bash -s", loginInput: script, script, stdin: "" },
    env,
    timeoutMsOverride,
  );
}

/**
 * Run fixed host-side source while carrying a separate sensitive stdin stream.
 * The stdin value is never interpolated into the SSH command or script body.
 */
export async function runProxmoxHostScriptWithStdin(
  script: string,
  stdin: string,
  env: EnvLike = process.env,
  timeoutMsOverride?: HostScriptTimeoutOverride,
): Promise<HostScriptResult> {
  if (typeof script !== "string" || script.length < 1 || Buffer.byteLength(script) > 96 * 1024
    || script.includes("\0") || typeof stdin !== "string" || Buffer.byteLength(stdin) > 1024 * 1024) {
    return { ok: false, stdout: "", stderr: "", error: "Invalid Proxmox host script or stdin" };
  }
  const encoded = Buffer.from(script, "utf8").toString("base64");
  const command = `/bin/bash -c "$(printf '%s' '${encoded}' | /usr/bin/base64 --decode)"`;
  return runProxmoxHostInvocation(
    { loginCommand: command, loginInput: stdin, script, stdin },
    env,
    timeoutMsOverride,
  );
}

export async function provisionProxmoxInstance(params: {
  userId: string;
  instanceId: string;
  tier?: string;
  cpuLimit: number;
  ramLimit: number;
  name: string;
  provider: string;
  apiKey: string;
  model: string;
  bankr?: InstanceBankrAgentConfig | null;
  subdomain: string | null;
  migrationUrl?: string;
  codexAuthBundle?: CodexVaultBundle;
  nousAuthBundle?: NousVaultBundle;
  honchoSettings?: HonchoSettings;
  agentSettings?: AgentSettings;
  a2aSettings?: A2ASettings;
  autoUpdate?: AutoUpdateConfig;
  memorySystem?: MemorySystemConfig;
  globalSettings?: {
    memoryContextLimit?: number;
    userContextLimit?: number;
    sessionExpiryHours?: number;
    dashboardUrl?: string;
  };
  backend?: InstanceBackend;
  /** Clean-slate BYOK (deploy-card Managed=OFF): ship no provider/model/key. */
  unconfigured?: boolean;
  /** Agent image override (e.g. operatoros-agent:stable for Operator OS). */
  webuiAgentImage?: string;
}, deps: ProvisionDeps = {}): Promise<ProxmoxProvisionResult> {
  const hostEnv = resolveProxmoxHostEnv(deps.hostConfig, deps.env ?? process.env);
  const target = resolveProxmoxTargetConfigurationUnlessHostResolved(hostEnv);
  const env = target.env;
  const targetId = target.id ?? normalizeProxmoxTargetId(envValue(env, "PROXMOX_NODE"));
  const inferredHostSlug = deps.hostConfig?.hostSlug || (!deps.hostConfig ? targetId : null);
  const inferredHostEnvPrefix =
    deps.hostConfig?.envPrefix || (!deps.hostConfig ? resolveProxmoxTargetEnvPrefix(hostEnv, targetId) : null);
  if (!isProxmoxProvisioningConfigured(env)) {
    return {
      ok: false,
      error: targetId
        ? `Proxmox deployment target "${targetId}" is not configured.`
        : "Proxmox deployment not configured.",
    };
  }

  const publicIp = envValue(env, "PROXMOX_PUBLIC_IP");

  // ── RAM burst plan ────────────────────────────────────────────────────
  // baseline = the tier's guaranteed RAM (= ram_limit, what placement reserves
  // and the balloon floor). ceiling = the burst cap the VM boots at and the
  // agent container is cgroup-limited to. When HERMES_RAM_BURST_ENABLED is off
  // (or this is a free/starter tier), ceiling == baseline and everything below
  // is byte-for-byte the legacy pinned allocation. Resolved once so the VM
  // (--memory/--balloon) and the container (mem_limit) agree on one ceiling.
  const baselineRamMb = Math.max(1024, Math.floor(params.ramLimit));
  const ramBurst = resolveRamBurst(baselineRamMb, env);

  // ── Gateway DNS resolution ────────────────────────────────────────────
  // Try minting `<subdomain>.<HERMES_INSTANCE_DNS_DOMAIN>` against
  // Cloudflare first. The Proxmox host's public IP is known up front
  // (it's the gateway IP, not a per-VM IP — Caddy on the host routes to
  // the VM via its private IP), so the mint can complete before we kick
  // off the host script.
  //
  // If Cloudflare DNS is configured for proxied records, prefer the
  // Cloudflare hostname even when the target has an sslip fallback domain:
  // the browser-facing TLS certificate is handled by Cloudflare's edge
  // wildcard instead of Caddy minting one certificate per instance on the
  // Proxmox host. A hostname served with the fleet's Cloudflare Origin CA
  // certificate MUST also be proxied: Origin CA is trusted by Cloudflare, not
  // by browsers connecting directly to the host. If neither safe path is
  // available, the resolver returns sslip.
  const cfConfig = getCloudflareDnsConfig(env);
  const configuredGatewayDomain = envValue(env, "PROXMOX_GATEWAY_DOMAIN");
  const cloudflareDomain = cfConfig?.domain?.trim().replace(/^\.+|\.+$/g, "") ?? "";
  const cloudflareDnsProxied = cfConfig?.proxied === true;
  const configuredGatewayIsCloudflareDomain = Boolean(
    configuredGatewayDomain &&
      cloudflareDomain &&
      (configuredGatewayDomain === cloudflareDomain ||
        configuredGatewayDomain.endsWith(`.${cloudflareDomain}`))
  );
  // Canary intentionally keeps its general-purpose DNS namespace under
  // agents.canary.hermesos.cloud, while the Proxmox origin certificate only
  // covers one-label *.hermesos.cloud hosts. Active PVE targets therefore set
  // PROXMOX_GATEWAY_DOMAIN=hermesos.cloud. Treat that static-origin domain as
  // an exact Cloudflare mint target even when it differs from the configured
  // canary namespace; otherwise the old "prefer configured domain" branch
  // creates a Caddy vhost but no A record and every healthy fresh VM remains
  // stuck in provisioning behind NXDOMAIN.
  const configuredGatewayUsesStaticOriginDomain = Boolean(
    configuredGatewayDomain &&
      params.subdomain &&
      isCoveredByProxmoxStaticOriginCert(`${params.subdomain}.${configuredGatewayDomain}`)
  );
  const mintDnsProxied = cloudflareDnsProxied || configuredGatewayUsesStaticOriginDomain;
  const mintDnsDomain =
    cfConfig && configuredGatewayUsesStaticOriginDomain
      ? configuredGatewayDomain
      : cloudflareDomain;
  const mustMintConfiguredStaticOriginDomain = Boolean(
    cfConfig &&
      configuredGatewayUsesStaticOriginDomain &&
      configuredGatewayDomain !== cloudflareDomain
  );
  const preferConfiguredGatewayDomain = Boolean(
    configuredGatewayDomain &&
      !mustMintConfiguredStaticOriginDomain &&
      !cloudflareDnsProxied &&
      (!cfConfig || !configuredGatewayIsCloudflareDomain)
  );
  const useCloudflareDns = Boolean(
    !preferConfiguredGatewayDomain && cfConfig && params.subdomain && publicIp
  );
  if (useCloudflareDns) {
    const plannedCloudflareGateway = resolveProxmoxGatewayConfiguration({
      subdomain: params.subdomain,
      publicIp,
      dnsDomain: mintDnsDomain,
    });
    try {
      assertSupportedProxmoxGatewayHost(plannedCloudflareGateway.fqdn);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unsupported Proxmox gateway host";
      log.error("refusing to mint unsupported nested Hermes gateway hostname", error, {
        source: LOG_SOURCE,
        failureType: "proxmox_gateway_tls_policy_rejected",
        instanceId: params.instanceId,
        userId: params.userId,
        gatewayHost: plannedCloudflareGateway.fqdn,
      });
      return { ok: false, error: detail };
    }
  }
  let mintedDns = false;
  if (useCloudflareDns) {
    const mintDns = deps.mintInstanceDns ?? mintInstanceDns;
    const mint = await mintDns({
      subdomain: params.subdomain!,
      ip: publicIp!,
      comment: `hermes instance ${params.instanceId}`,
      proxied: mintDnsProxied,
    }, { ...cfConfig!, domain: mintDnsDomain });
    if (mint.ok) {
      mintedDns = true;
    } else {
      log.warn("cloudflare DNS mint failed for proxmox provision; falling back to sslip", {
        source: LOG_SOURCE,
        instanceId: params.instanceId,
        userId: params.userId,
        failureType: "cloudflare_dns_mint_failed",
        redactedError: redactSensitiveCommandOutput(mint.error ?? "", 600),
      });
    }
  }

  const gatewayConfig = resolveProxmoxGatewayConfiguration({
    subdomain: params.subdomain,
    publicIp,
    dnsDomain: mintedDns
      ? mintDnsDomain
      : preferConfiguredGatewayDomain
        ? configuredGatewayDomain
        : null,
  });
  try {
    assertSupportedProxmoxGatewayHost(gatewayConfig.fqdn);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unsupported Proxmox gateway host";
    log.error("refusing unsupported Proxmox gateway hostname", error, {
      source: LOG_SOURCE,
      failureType: "proxmox_gateway_tls_policy_rejected",
      instanceId: params.instanceId,
      userId: params.userId,
      gatewayHost: gatewayConfig.fqdn,
    });
    return { ok: false, error: detail };
  }
  const apiServerKey = randomBytes(32).toString("hex");
  const containerName = `agent-${params.instanceId}`;
  const backend: InstanceBackend = params.backend === "webui" ? "webui" : "gateway";
  const templateId = envInt(env, "PROXMOX_TEMPLATE_ID", 9000);

  let deployScript: string;
  if (isWebfreeBackend(backend)) {
    // Webfree mode (webui|gateway — Phase-2 collapse): build the same artifacts
    // Hetzner builds. The Proxmox guest VM
    // already runs the same outer Caddy container as a Hetzner host (set up by
    // buildProxmoxGuestBootstrapScript), so the WebUI bootstrap and per-instance
    // Caddyfile from buildWebUIBootstrapScript drop straight in. We pass
    // `fqdn: "localhost"` so the inner Caddyfile uses a `:80` site label —
    // TLS is terminated upstream on the Proxmox host, not inside the guest.
    const inferenceProvider =
      params.provider === "custom_llm"
        ? "custom"
        : PROVIDER_ID_MAP[params.provider] ?? params.provider;
    // Browser sidecar defaults ON for Pro+ tiers; only an explicit opt-out
    // (browserSidecarEnabled === false) suppresses it. Diagnostic logs fire only
    // for an EXPLICIT opt-in so the common default-on paths don't spam.
    const browserSidecarExplicitOptIn = params.agentSettings?.browserSidecarEnabled === true;
    const wantBrowserSidecar = params.agentSettings?.browserSidecarEnabled !== false;
    const browserSidecarDeploymentGateEnabled = isBrowserSidecarDeploymentGateEnabled(env);
    const browserSidecarTierEligible = canProvisionBrowserSidecarForTier(params.tier);
    // RAM floor: never schedule the ~1.3 GB sidecar onto a box whose budget
    // can't host it (defense-in-depth against a stale/mis-set ram_limit).
    const browserSidecarRamSufficient = instanceCanFitBrowserSidecar(params.ramLimit);
    const browserSidecarEnabled =
      wantBrowserSidecar &&
      browserSidecarDeploymentGateEnabled &&
      browserSidecarTierEligible &&
      browserSidecarRamSufficient;
    if (browserSidecarExplicitOptIn && !browserSidecarDeploymentGateEnabled) {
      log.info("browser-sidecar disabled during fresh Proxmox provision: deployment gate is off", {
        source: LOG_SOURCE,
        failureType: "browser_sidecar_deploy_gate_disabled",
        instanceId: params.instanceId,
        userId: params.userId,
        envVar: BROWSER_SIDECAR_DEPLOY_ENABLED_ENV,
      });
    } else if (browserSidecarExplicitOptIn && !browserSidecarTierEligible) {
      log.info("browser-sidecar disabled during fresh Proxmox provision: tier does not qualify", {
        source: LOG_SOURCE,
        failureType: "browser_sidecar_tier_dropped",
        instanceId: params.instanceId,
        userId: params.userId,
        tier: params.tier ?? null,
      });
    } else if (
      wantBrowserSidecar &&
      browserSidecarDeploymentGateEnabled &&
      browserSidecarTierEligible &&
      !browserSidecarRamSufficient
    ) {
      log.warn("browser-sidecar disabled during fresh Proxmox provision: insufficient RAM budget", {
        source: LOG_SOURCE,
        failureType: "browser_sidecar_ram_insufficient",
        instanceId: params.instanceId,
        userId: params.userId,
        ramLimitMb: params.ramLimit,
      });
    }
    const webUIParams = {
      instanceId: params.instanceId,
      containerName,
      fqdn: gatewayConfig.deployFqdn,
      cpuLimit: params.cpuLimit,
      ramLimit: params.ramLimit,
      // Burst ceiling for the agent-bearing containers' cgroup limit. Equals
      // ramLimit when burst is off/free-tier (no behaviour change).
      ramBurstMb: ramBurst.ceilingMb,
      llmApiKey: params.apiKey,
      inferenceProvider,
      defaultModel: params.model,
      dashboardProvider: params.provider,
      baseUrl:
        resolveProviderBaseUrl(params.provider, params.agentSettings?.customLlmBaseUrl) ??
        undefined,
      // Auxiliary compression model + context engine — dashboard-configurable
      // (empty = inherit main / agent default). Emitted into config.yaml by the
      // builder as auxiliary.compression.{provider,model} and context.engine.
      compressionProvider: params.agentSettings?.compressionProvider,
      compressionModel: params.agentSettings?.compressionModel,
      contextEngine: params.agentSettings?.contextEngine,
      webuiPassword: apiServerKey,
      tavilyApiKey: params.agentSettings?.tavilyApiKey,
      daytonaApiKey: params.agentSettings?.daytonaApiKey,
      firecrawlApiKey: params.agentSettings?.firecrawlApiKey,
      codexAuthBundle:
        isCodexAuthProvider(params.provider)
          ? params.codexAuthBundle
          : undefined,
      bankr: params.bankr,
      browserSidecarEnabled,
      // Every Proxmox provision gets a dedicated QEMU guest. Root-equivalent
      // Docker control therefore reaches only this tenant's guest daemon, not
      // the Proxmox host or another customer's VM.
      gatewayDockerAccess: params.agentSettings?.enableRootAccess === true,
      terminalBackend: params.agentSettings?.terminalBackend,
      agentName: params.name,
      // Welcome-persona deploys carry the authored soul as the BASE of the
      // stored systemPrompt; recognize it so the box's SOUL.md boots AS the
      // hired persona instead of the who-am-i ritual. Null for custom/no-persona.
      // Operator OS always uses its own autonomy SOUL — never a welcome persona.
      personaSoulPrompt:
        isOperatorosAgentImage(params.webuiAgentImage)
          ? null
          : (resolvePersonaSoulFromSystemPrompt(params.agentSettings?.systemPrompt)?.soulPrompt ?? null),
      // Clean-slate BYOK: builders skip all provider/model/key seeding.
      unconfigured: params.unconfigured === true,
      // Agent image override (e.g. operatoros-agent:stable when the user
      // selected Operator OS). Passed as 'agentImage' which resolveWebUIAgentImage
      // checks FIRST — overriding all env-var fallbacks.
      agentImage: params.webuiAgentImage,
    };
    log.info("seeding WebUI default model from dashboard deployment selection", {
      source: LOG_SOURCE,
      failureType: "webui_default_model_seed",
      instanceId: params.instanceId,
      userId: params.userId,
      dashboardProvider: params.provider,
      inferenceProvider,
      defaultModel: params.model,
    });
    const artifacts = buildWebUIProvisioningArtifacts(webUIParams);
    const forceWebUIImagePull = shouldForceWebUIProvisionImagePull(targetId, env);
    if (forceWebUIImagePull) {
      log.info("fresh WebUI provision will force-pull current images for Proxmox target", {
        source: LOG_SOURCE,
        instanceId: params.instanceId,
        userId: params.userId,
        targetId,
        envVar: "HERMES_WEBUI_PROVISION_FORCE_PULL_TARGETS",
      });
    }
    deployScript = buildWebUIBootstrapScript(artifacts, webUIParams, {
      forceWebUIImagePull,
      forceAgentImagePull: forceWebUIImagePull,
      // The Proxmox path provisions webui-free instances (the running surface is
      // the official Hermes dashboard + the gateway agent image), so emit the
      // idle-gated update stack (sampler+roll+refresh) instead of the legacy
      // daily auto-update. `backend: "gateway"` here is intentional and is the
      // idle-gated builder's OWN build-mode selector (emit-the-stack), NOT the DB
      // instance backend: this call site lives inside the webfree branch
      // (isWebfreeBackend(backend) — both "webui" and "gateway" DB values) because
      // the WebUI bootstrap artifacts ARE the webui-free compose, but the actual
      // running backend is always the gateway agent — so the gateway stack is
      // correct for every webfree box regardless of its DB backend value.
      additionalProvisioningScript: buildIdleGatedUpdateProvisioningScript({
        instanceId: params.instanceId,
        backend: "gateway",
      }),
    });
  } else {
    const deployBuilder = deps.buildDeployScript ?? buildAgentDeployScript;
    deployScript = deployBuilder({
      instanceId: params.instanceId,
      containerName,
      apiServerKey,
      provider: params.provider,
      apiKey: params.apiKey,
      model: params.model,
      // Clean-slate BYOK (deploy-card Managed=OFF): boot unconfigured so the agent's
      // onboarding overlay collects a provider. Mirrors the webui branch above;
      // omitting it bakes a keyless default model → "No LLM provider configured".
      unconfigured: params.unconfigured === true,
      bankr: params.bankr,
      fqdn: gatewayConfig.deployFqdn,
      cpuLimit: params.cpuLimit,
      ramLimit: params.ramLimit,
      ramBurstMb: ramBurst.ceilingMb,
      migrationUrl: params.migrationUrl,
      codexAuthBundle: params.codexAuthBundle,
      nousAuthBundle: params.nousAuthBundle,
      honchoSettings: params.honchoSettings,
      agentSettings: params.agentSettings,
      a2aSettings: params.a2aSettings,
      autoUpdate: params.autoUpdate,
      memorySystem: params.memorySystem,
      globalSettings: params.globalSettings,
    });
  }

  const vmidStart = envInt(env, "PROXMOX_VMID_START", 200);
  const vmidEnd = resolveProxmoxVmidEnd(env, vmidStart);
  // Read DB-claimed VMIDs on this node before scripting so the in-VM
  // picker can skip both `qm list` occupants AND stranded DB claims.
  // Using `inferredHostSlug` here (not env.PROXMOX_NODE) matches the
  // value stored in `proxmox_node` by buildPostProvisionMetadataPayload
  // — see instance-service.ts:~2417. Empty slug short-circuits to [] so
  // single-host deployments without a slug keep working.
  const reservedVmidLookup =
    deps.getReservedVmidsForNode ?? getReservedProxmoxVmidsForNode;
  const reservedVmids = inferredHostSlug
    ? await reservedVmidLookup({
        proxmoxNode: inferredHostSlug,
        excludeInstanceId: params.instanceId,
      })
    : [];
  const script = buildProxmoxProvisionScript({
    instanceId: params.instanceId,
    vmName: sanitizeVmName(`hermes-${params.name}-${params.instanceId.slice(0, 8)}`),
    templateId,
    vmidStart,
    vmidEnd,
    reservedVmids,
    ipLastOctetStart: envInt(env, "PROXMOX_IP_LAST_OCTET_START", 50),
    privateSubnetPrefix: envValue(env, "PROXMOX_PRIVATE_SUBNET_PREFIX", "10.250.20"),
    privateCidr: envInt(env, "PROXMOX_PRIVATE_CIDR", 24),
    privateGateway: envValue(env, "PROXMOX_PRIVATE_GATEWAY", "10.250.20.1"),
    // Hetzner's own DNS first (always reachable from a Hetzner host
    // even when public resolvers are throttled/dropped), then public
    // fallbacks. A single-resolver config (just `1.1.1.1`) took the
    // whole fleet DNS-dark on 2026-05-02 when the path to Cloudflare
    // degraded: ICMP ping kept working so /health stayed green, but
    // every LLM call failed with `gaierror`, surfacing to the user as
    // `streamNotFound` from the SW. Order matters — query the working
    // resolver first instead of timing out on the broken one then
    // falling through.
    nameserver: envValue(env, "PROXMOX_VM_NAMESERVER", "185.12.64.1 185.12.64.2 1.1.1.1 8.8.8.8"),
    // The user's plan tier sets these via the dashboard "Hardware Slicing"
    // sliders → instance-service.ts caps them to plan.maxCpuPerAgent /
    // maxRamPerAgent → they arrive here as params.cpuLimit / params.ramLimit.
    // We intentionally do NOT honor PROXMOX_VM_CORES / PROXMOX_VM_MEMORY_MB
    // env-var overrides anymore — those used to be a hard cap that pinned
    // every VM to 1 vCPU / 2GB regardless of the user's plan, which made
    // upgraded users (operator+) silently provision at free-tier specs.
    // If the env var is genuinely needed for a debug deploy, set it AND
    // pass cpuLimit/ramLimit matching it; or unset both and let the plan
    // drive the spec.
    cores: Math.max(1, Math.floor(params.cpuLimit)),
    cpuLimit: params.cpuLimit,
    // RAM burst (HERMES_RAM_BURST_ENABLED): boot the VM at the burst ceiling and
    // set the balloon floor to the paid baseline, so the guest can use burst
    // headroom while the host can auto-balloon it back down to baseline (never
    // below) under memory pressure. The `--memory` value is the guest's boot-time
    // size, so a fresh provision sees the full ceiling immediately. When burst is
    // off/free-tier, memoryMb == baseline and the legacy
    // PROXMOX_VM_BALLOON_FLOOR_MB host override applies — byte-for-byte unchanged.
    memoryMb: ramBurst.burstActive ? ramBurst.ceilingMb : baselineRamMb,
    balloonFloorMb: ramBurst.burstActive
      ? ramBurst.baselineMb
      : envInt(env, "PROXMOX_VM_BALLOON_FLOOR_MB", 0) || undefined,
    diskSizeGb: resolveProxmoxVmDiskGb(env),
    deployScript,
    vmSshUser: envValue(env, "PROXMOX_VM_SSH_USER", "hermes"),
    vmSshKeyPath: envValue(env, "PROXMOX_VM_SSH_KEY_PATH", "/etc/hivra/keys/vm-orchestrator"),
    gatewayHost: gatewayConfig.fqdn,
    gatewayHttpOnly: mintedDns && mintDnsProxied,
    caddySitesDir: envValue(env, "PROXMOX_CADDY_SITES_DIR", "/etc/caddy/hermes.d"),
    apiServerKey,
    // The dashboard origin enables the CORS headers in the per-instance
    // Caddy site. Empty string falls back to the plain bearer-only config.
    // Reads NEXT_PUBLIC_DASHBOARD_ORIGIN explicitly so it can be set to a
    // canonical URL even on preview deployments where VERCEL_URL is the
    // ephemeral preview hostname.
    dashboardOrigin:
      envValue(env, "NEXT_PUBLIC_DASHBOARD_ORIGIN", "") ||
      (envValue(env, "VERCEL_PROJECT_PRODUCTION_URL", "")
        ? `https://${envValue(env, "VERCEL_PROJECT_PRODUCTION_URL", "")}`
        : ""),
    backend,
    requireTenantIsolation: params.agentSettings?.enableRootAccess === true,
  });

  // earlyFinishMarker resolves the SSH call the moment the kickoff line
  // lands in stdout, so the orchestrator can persist the VMID/IP/gateway-host
  // metadata to the DB even if the SSH channel-close event is delayed by
  // sshd waiting on inherited FDs (a known pitfall when nohup'ing a child
  // over SSH from a serverless runtime). Phase 2 continues detached.
  const runner =
    deps.runHostScript ??
    ((hostScript: string) =>
      runProxmoxHostScript(hostScript, env, { earlyFinishMarker: "HERMES_PROXMOX_RESULT" }));
  const result = await runner(script);
  if (!result.ok) {
    if (mintedDns) {
      // The host script never produced a working VM — drop the A record so
      // the next provision attempt starts from a clean slate.
      await removeInstanceDnsBestEffort(params.subdomain, {
        source: LOG_SOURCE,
        instanceId: params.instanceId,
        userId: params.userId,
      }, { dnsDomain: mintDnsDomain });
    }
    const detail = redactSensitiveCommandOutput(
      result.stderr || result.error || result.stdout || "Unknown Proxmox provisioning failure.",
      800
    );
    const vmidExhaustion = parseProxmoxVmidExhaustionError(detail);
    if (vmidExhaustion) {
      return {
        ok: false,
        error: detail,
        failureType: "proxmox_vmid_range_exhausted",
        // Fall back to the routed host's slug when target resolution yielded
        // no id (pinned hostConfig path) so the caller's failover loop can
        // identify — and exclude — the exhausted host instead of surfacing
        // the raw allocator error.
        targetId: targetId ?? normalizeProxmoxTargetId(inferredHostSlug),
        vmidStart: vmidExhaustion.vmidStart,
        vmidEnd: vmidExhaustion.vmidEnd,
      };
    }
    return { ok: false, error: detail };
  }

  try {
    const metadata = parseProxmoxProvisionOutput(result.stdout);
    const infrastructure: ProxmoxInfrastructure = {
      provider: "proxmox",
      ...(targetId ? { node: targetId } : {}),
      vmid: metadata.vmid,
      privateIpv4: metadata.privateIpv4,
      gatewayHost: metadata.gatewayHost,
      templateVmid: templateId,
      ...(deps.hostConfig?.hostId ? { hostId: deps.hostConfig.hostId } : {}),
      ...(inferredHostSlug ? { hostSlug: inferredHostSlug } : {}),
      ...(inferredHostEnvPrefix ? { hostEnvPrefix: inferredHostEnvPrefix } : {}),
    };

    return {
      ok: true,
      provider: "proxmox",
      serverId: 0,
      vmid: metadata.vmid,
      templateId,
      ipv4: metadata.privateIpv4,
      sshHostFingerprint: null,
      apiServerKey,
      gatewayUrl: `https://${metadata.gatewayHost}`,
      serverType: "proxmox-kvm",
      infrastructure,
    };
  } catch (err) {
    // Best-effort rollback on parse failure: the kickoff script may have
    // already created a VM and consumed a VMID slot. If parsing the
    // structured result line fails (truncated stdout, unexpected
    // interleaved output, malformed JSON), the orchestrator has nothing
    // to clean up by — without this rollback, an orphan VM lives on
    // forever and the VMID slot is gone, eventually exhausting the
    // PROXMOX_VMID_START..END range.
    //
    // Try to recover the VMID from stdout via a loose regex; if that
    // works, fire a destroy script. We don't propagate destroy
    // failures — the original parse error is what the operator needs
    // to see.
    const recoveredVmid = recoverProxmoxVmidFromMalformedOutput(result.stdout);
    if (recoveredVmid != null) {
      try {
        const cleanupScript = buildProxmoxOrphanCleanupScript({
          vmid: recoveredVmid,
          instanceId: params.instanceId,
          gatewayHost: gatewayConfig.fqdn,
          caddySitesDir: envValue(env, "PROXMOX_CADDY_SITES_DIR", "/etc/caddy/hermes.d"),
        });
        const cleanupRunner =
          deps.runHostScript ?? ((s: string) => runProxmoxHostScript(s, env));
        await cleanupRunner(cleanupScript);
      } catch {
        // Swallow cleanup errors — surface the original parse failure.
      }
    }

    if (mintedDns) {
      await removeInstanceDnsBestEffort(params.subdomain, {
        source: LOG_SOURCE,
        instanceId: params.instanceId,
        userId: params.userId,
      }, { dnsDomain: mintDnsDomain });
    }

    const baseError = err instanceof Error ? err.message : String(err);
    const errorMsg =
      recoveredVmid != null
        ? `${baseError} (orphan-cleanup attempted for vmid=${recoveredVmid})`
        : baseError;
    return { ok: false, error: errorMsg };
  }
}

/**
 * Best-effort VMID recovery when parseProxmoxProvisionOutput throws.
 * Looks for `"vmid":<digits>` or `vmid=<digits>` anywhere in stdout.
 * Returns null if nothing plausible can be extracted.
 */
function recoverProxmoxVmidFromMalformedOutput(stdout: string): number | null {
  const m =
    stdout.match(/"vmid"\s*:\s*(\d{3,6})/) ||
    stdout.match(/\bvmid\s*=\s*(\d{3,6})/i) ||
    stdout.match(/HERMES_PROXMOX_RESULT[^\d]*(\d{3,6})/);
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}


export async function archiveProxmoxDormantInstance(
  infrastructure: Pick<ProxmoxInfrastructure, "vmid" | "node">,
  params: {
    archiveDir: string;
    instanceId: string;
    hostConfig?: ProxmoxHostRoutingConfig | null;
  },
  deps: ProxmoxHostAwareDeps = {}
): Promise<HostScriptResult> {
  const env = params.hostConfig
    ? resolveProxmoxHostEnv(params.hostConfig, deps.env ?? process.env)
    : deps.hostConfig
      ? resolveProxmoxHostEnv(deps.hostConfig, deps.env ?? process.env)
      : resolveProxmoxOperationEnv(deps.env ?? process.env, infrastructure);
  const script = buildProxmoxDormantArchiveScript({
    vmid: infrastructure.vmid,
    archiveDir: params.archiveDir,
    instanceId: params.instanceId,
  });
  const runner = deps.runHostScript ?? ((hostScript: string) => runProxmoxHostScript(hostScript, env));
  return runner(script);
}

export async function deleteProxmoxInstance(
  infrastructure: ProxmoxInfrastructure,
  deps: ProxmoxHostAwareDeps & { expectedInstanceId: string }
): Promise<HostScriptResult> {
  const env = deps.hostConfig
    ? resolveProxmoxHostEnv(deps.hostConfig, deps.env ?? process.env)
    : resolveProxmoxOperationEnv(deps.env ?? process.env, infrastructure);
  const script = buildProxmoxDeleteScript({
    vmid: infrastructure.vmid,
    expectedInstanceId: deps.expectedInstanceId,
    gatewayHost: infrastructure.gatewayHost,
    caddySitesDir: envValue(env, "PROXMOX_CADDY_SITES_DIR", "/etc/caddy/hermes.d"),
    gracefulShutdownTimeoutSeconds: envInt(env, "PROXMOX_DELETE_GRACEFUL_TIMEOUT_SEC", 30),
  });
  const runner = deps.runHostScript ?? ((hostScript: string) => runProxmoxHostScript(hostScript, env));
  return runner(script);
}

export async function shutdownProxmoxInstance(
  infrastructure: Pick<ProxmoxInfrastructure, "vmid" | "node">,
  deps: ProxmoxHostAwareDeps & {
    shutdownTimeoutSeconds?: number;
    /** Pass 0 when pausing for inactivity/capacity so a host reboot doesn't
     * auto-start the paused VM. Undefined leaves onboot untouched. */
    setOnboot?: 0 | 1;
  } = {}
): Promise<HostScriptResult> {
  const env = deps.hostConfig
    ? resolveProxmoxHostEnv(deps.hostConfig, deps.env ?? process.env)
    : resolveProxmoxOperationEnv(deps.env ?? process.env, infrastructure);
  const script = buildProxmoxPowerScript({
    vmid: infrastructure.vmid,
    action: "shutdown",
    shutdownTimeoutSeconds: deps.shutdownTimeoutSeconds,
    setOnboot: deps.setOnboot,
  });
  const runner = deps.runHostScript ?? ((hostScript: string) => runProxmoxHostScript(hostScript, env));
  return runner(script);
}

export async function startProxmoxInstance(
  infrastructure: Pick<ProxmoxInfrastructure, "vmid" | "node">,
  deps: ProxmoxHostAwareDeps & {
    /** Pass 1 when resuming an agent so it survives host reboots while active
     * (the inverse of the inactivity-pause onboot:0). Undefined leaves onboot
     * untouched. */
    setOnboot?: 0 | 1;
  } = {}
): Promise<HostScriptResult> {
  const env = deps.hostConfig
    ? resolveProxmoxHostEnv(deps.hostConfig, deps.env ?? process.env)
    : resolveProxmoxOperationEnv(deps.env ?? process.env, infrastructure);
  const script = buildProxmoxPowerScript({
    vmid: infrastructure.vmid,
    action: "start",
    setOnboot: deps.setOnboot,
  });
  const runner = deps.runHostScript ?? ((hostScript: string) => runProxmoxHostScript(hostScript, env));
  return runner(script);
}

export async function rebootProxmoxInstance(
  infrastructure: Pick<ProxmoxInfrastructure, "vmid" | "node">,
  deps: ProxmoxHostAwareDeps & { shutdownTimeoutSeconds?: number } = {}
): Promise<HostScriptResult> {
  const env = deps.hostConfig
    ? resolveProxmoxHostEnv(deps.hostConfig, deps.env ?? process.env)
    : resolveProxmoxOperationEnv(deps.env ?? process.env, infrastructure);
  const script = buildProxmoxPowerScript({
    vmid: infrastructure.vmid,
    action: "reboot",
    shutdownTimeoutSeconds: deps.shutdownTimeoutSeconds,
  });
  const runner = deps.runHostScript ?? ((hostScript: string) => runProxmoxHostScript(hostScript, env));
  return runner(script);
}


export async function resizeProxmoxInstance(
  infrastructure: Pick<ProxmoxInfrastructure, "vmid" | "node">,
  resources: { cpuLimit: number; ramLimit: number },
  deps: ProxmoxHostAwareDeps = {}
): Promise<HostScriptResult> {
  const env = deps.hostConfig
    ? resolveProxmoxHostEnv(deps.hostConfig, deps.env ?? process.env)
    : resolveProxmoxOperationEnv(deps.env ?? process.env, infrastructure);
  const script = buildProxmoxResizeScript({
    vmid: infrastructure.vmid,
    cores: resources.cpuLimit,
    memoryMb: resources.ramLimit,
    balloonFloorMb: envInt(env, "PROXMOX_VM_BALLOON_FLOOR_MB", 0) || undefined,
  });
  const runner = deps.runHostScript ?? ((hostScript: string) => runProxmoxHostScript(hostScript, env));
  return runner(script);
}

/**
 * Container-name suffixes whose compose `deploy.resources.limits` carry the
 * TIER ceiling (see buildWebUICompose: both get `cpus: cpuLimit` /
 * `memory: ramCeilingMb`). The system sidecars — `-browser-sidecar` (1320M),
 * `-autoheal` (64M), `-dashboard-sidecar` — are deliberately fixed-size and
 * must NOT be resized with the tier.
 */
const TIER_CEILING_CONTAINER_SUFFIXES = ["gateway", "official-dashboard"] as const;

/**
 * Guest-side script (runs as root INSIDE the VM) that reapplies the tier
 * ceiling to the agent containers' cgroups.
 *
 * Why this exists: `qm set --memory/--balloon` raises the VM's ceiling only.
 * The agent containers carry their own cgroup limits, baked into compose at
 * PROVISION time from the tier's `ram_limit` — so a tier upgrade used to leave
 * an instance running under the OLD tier's cap until something recreated its
 * containers. Node reads the cgroup, not /proc/meminfo, so a VM grown to 4 GB
 * whose container was still capped at 1 GB gave V8 a ~524 MB heap and killed
 * `next build` with "Ineffective mark-compacts near heap limit" (SIGABRT)
 * rather than a kernel OOM (SIGKILL). Confirmed on a disposable verification computer,
 * 2026-08-03.
 *
 * `docker update` writes through to the container's hostconfig.json, so the new
 * ceiling survives a container RESTART and a VM reboot. It does NOT survive a
 * `docker compose up --force-recreate`, which regenerates limits from the
 * compose file — that's what `tier_change_pending` + the apply-pending-resizes
 * sweep are for. This is the immediate relief (the tenant gets the RAM they
 * just paid for in seconds, with no chat interruption); the recreate is the
 * durable one. Both are wanted, which is why this does not clear that flag.
 *
 * Best-effort by construction: no `set -e`, every failure logs and continues.
 * A resize must never fail because one container refused an update.
 */
export function buildAgentContainerCgroupScript(opts: { memoryMb: number; cpus: number; strict?: boolean }): string {
  const memMb = Math.max(64, Math.floor(opts.memoryMb));
  const cpus = Math.max(0.01, opts.cpus);
  const nameFilter = `^agent-.+-(${TIER_CEILING_CONTAINER_SUFFIXES.join("|")})$`;
  return `set -uo pipefail
MEM_MB=${shQuote(memMb)}
CPUS=${shQuote(cpus)}
# Mirror docker's own default for a compose \`limits.memory\` with no swap entry
# (memory-swap = 2 × memory), so this lands on the exact same numbers a
# container recreate would produce. Passing memory-swap is REQUIRED on the way
# up: docker rejects a new --memory that exceeds the existing swap limit.
SWAP_MB=$(( MEM_MB * 2 ))

if ! command -v docker >/dev/null 2>&1; then
  echo "[resize] guest has no docker; nothing to reapply"
  exit ${opts.strict ? "1" : "0"}
fi

# docker rejects --cpus greater than the guest's available CPUs. On the
# pre-reboot pass the guest may still report the OLD (lower) nproc, so CLAMP
# instead of failing the whole update: memory is the cap that actually breaks
# builds, and the post-reboot pass raises cpus once the new vCPUs are visible.
NPROC="$(nproc 2>/dev/null || echo 1)"
case "$NPROC" in ''|*[!0-9]*) NPROC=1 ;; esac
CPUS_EFF="$(awk -v c="$CPUS" -v n="$NPROC" 'BEGIN { printf "%.2f", (c < n ? c : n) }')"

updated=0
failed=0
for name in $(docker ps --format '{{.Names}}' 2>/dev/null | grep -E ${shQuote(nameFilter)} || true); do
  before="$(docker inspect -f '{{.HostConfig.Memory}}' "$name" 2>/dev/null || echo 0)"
  # Fall back to a memory-only update when the cpus value is what docker
  # rejected — never let a CPU quibble block the RAM ceiling.
  if docker update --memory "\${MEM_MB}m" --memory-swap "\${SWAP_MB}m" --cpus "$CPUS_EFF" "$name" >/dev/null 2>&1 \\
    || docker update --memory "\${MEM_MB}m" --memory-swap "\${SWAP_MB}m" "$name" >/dev/null 2>&1; then
    after="$(docker inspect -f '{{.HostConfig.Memory}}' "$name" 2>/dev/null || echo 0)"
    echo "[resize] container $name HostConfig.Memory $before -> $after (cpus $CPUS_EFF, nproc $NPROC)"
    updated=$(( updated + 1 ))
  else
    echo "[resize] WARN: docker update failed for $name" >&2
    failed=$(( failed + 1 ))
  fi
done
${opts.strict ? '[ "$updated" -gt 0 ] && [ "$failed" -eq 0 ] || { echo "[resize] container cgroup enforcement was incomplete" >&2; exit 1; }' : ""}
echo "[resize] container cgroup reapply: $updated container(s) set to \${MEM_MB}M / $CPUS_EFF cpus"
`;
}


/**
 * Resize a running Proxmox VM's CPU + RAM caps to match its tier.
 *
 * cpulimit + memory apply LIVE (hot). The guest-visible core COUNT (`--cores`)
 * is also set so nproc matches the tier — REQUIRED so docker's
 * deploy.resources.limits.cpus (= cpuLimit) never exceeds the VM's available
 * CPUs. Since `--cores` only takes effect after a guest restart, this reboots
 * the VM ONLY when the core count changes (cpulimit/memory-only resizes stay
 * hot). Previously `--cores` was omitted, which left tier-upgraded VMs at
 * nproc=1 and broke `docker compose up` ("range of CPUs is from 0.01 to 1.00").
 *
 * Difference vs `resizeProxmoxInstance`:
 *   - `--cpulimit X` (decimal allowed, e.g. 0.5 = half-core) is a kernel
 *     scheduler enforcement that applies live.
 *   - `--memory M --balloon M` reuses the QEMU memory balloon to grow/shrink
 *     RAM live; the guest's kernel sees the change immediately without
 *     reboot, as long as ballooning is enabled (which it is by default on
 *     hermes-cloned templates).
 *
 * The VM ceiling is only half the job: the agent containers keep their OWN
 * cgroup limits (compose `deploy.resources.limits`, written at provision time),
 * so this also SSHes into the guest and `docker update`s them onto the same
 * ceiling — see buildAgentContainerCgroupScript. Without it an upgraded VM has
 * the RAM but the agent can't reach it.
 *
 * Used by the tier-change service to apply a Stripe upgrade or downgrade
 * to a running VM with no chat interruption.
 */
export async function resizeProxmoxVm(
  params: { vmid: number; node?: string; cpuLimit: number; memoryMb: number; cpuUnits?: number },
  deps: ProxmoxHostAwareDeps = {}
): Promise<HostScriptResult> {
  const env = deps.hostConfig
    ? resolveProxmoxHostEnv(deps.hostConfig, deps.env ?? process.env)
    : resolveProxmoxOperationEnv(deps.env ?? process.env, params);
  const cpu = Math.max(0.1, params.cpuLimit);
  // Visible vCPU topology must match the tier so the guest's nproc >= the
  // docker compose cpus limit (= cpuLimit). Floor at 1.
  const cores = Math.max(1, Math.floor(params.cpuLimit));
  const baselineMemMb = Math.max(512, Math.floor(params.memoryMb));
  // RAM burst (HERMES_RAM_BURST_ENABLED): a paid VM is resized to boot at the
  // burst ceiling with the balloon floor pinned to the paid baseline. The
  // ceiling is the guest's boot-time `--memory`, so the FULL ceiling only
  // becomes visible after a restart — which an upgrade already triggers when the
  // core count increases (free->operator->fleet->command all bump cores). The
  // balloon CAN deflate live up to the boot-time memory, so once a VM has booted
  // at the ceiling, Proxmox grows/shrinks it between baseline and ceiling hot.
  const ramBurst = resolveRamBurst(baselineMemMb, env);
  const memMb = ramBurst.burstActive ? ramBurst.ceilingMb : baselineMemMb;
  // When burst is active the balloon floor is the paid baseline (never reclaim
  // below what the tenant pays for). Otherwise PROXMOX_VM_BALLOON_FLOOR_MB lets a
  // host be configured with elastic memory; default (unset / 0) keeps the legacy
  // fully-pinned allocation by setting balloon = memory.
  const floorEnv = envInt(env, "PROXMOX_VM_BALLOON_FLOOR_MB", 0);
  const requestedFloor = ramBurst.burstActive
    ? ramBurst.baselineMb
    : floorEnv > 0
      ? floorEnv
      : undefined;
  const balloonMb = resolveProxmoxBalloonFloorMb(memMb, requestedFloor);
  // Phase 5: optional cgroup CPU weight (scheduling priority). Empty string unless a
  // caller passes cpuUnits, so existing callers keep the exact prior qm-set behaviour.
  const cpuUnitsArg =
    typeof params.cpuUnits === "number" && params.cpuUnits > 0
      ? ` --cpuunits ${Math.max(1, Math.floor(params.cpuUnits))}`
      : "";
  // The container cgroup gets the SAME ceiling the VM boots at (memMb — the
  // burst ceiling when burst is active, the baseline otherwise), so the VM's
  // `--memory` and the agent's `mem_limit` never disagree. This mirrors the
  // provisioning path, where buildWebUICompose is handed ramBurstMb =
  // ramBurst.ceilingMb and the VM is created with the same number.
  const guestCgroupScriptB64 = Buffer.from(
    buildAgentContainerCgroupScript({ memoryMb: memMb, cpus: cpu }),
    "utf8"
  ).toString("base64");
  const vmSshUser = envValue(env, "PROXMOX_VM_SSH_USER", "hermes");
  const vmSshKeyPath = envValue(env, "PROXMOX_VM_SSH_KEY_PATH", "/etc/hivra/keys/vm-orchestrator");
  // qm set --cpulimit accepts a decimal; --balloon and --memory together
  // give the live RAM cap (ballooning shrinks/grows guest's available RAM).
  const script = `#!/usr/bin/env bash
set -euo pipefail
VMID=${shQuote(params.vmid)}
CPU_LIMIT=${shQuote(cpu)}
CORES=${shQuote(cores)}
MEMORY_MB=${shQuote(memMb)}
BALLOON_FLOOR_MB=${shQuote(balloonMb)}
VM_SSH_USER=${shQuote(vmSshUser)}
VM_SSH_KEY_PATH=${shQuote(vmSshKeyPath)}
GUEST_CGROUP_B64=${shQuote(guestCgroupScriptB64)}
GUEST_KNOWN_HOSTS=""

if ! qm status "$VMID" >/dev/null 2>&1; then
  echo "VM $VMID not found" >&2
  exit 1
fi

# Same ipconfig0 parse the metrics script uses — the guest's private IP is the
# only route from the Proxmox host into the VM.
PRIVATE_IP="$(qm config "$VMID" 2>/dev/null | sed -n 's/^ipconfig0: .*ip=\\([^,\\/]*\\).*/\\1/p' | head -n1)"

cleanup_resize() {
  if [ -n "\${GUEST_KNOWN_HOSTS:-}" ]; then rm -f "$GUEST_KNOWN_HOSTS"; fi
}
trap cleanup_resize EXIT

# Push the tier ceiling down into the agent containers' cgroups. ALWAYS
# best-effort (returns 0 even when it can't run): the VM-level resize is the
# load-bearing half, and tier_change_pending still drives the durable compose
# regen if this can't land. $1 = label, $2 = SSH attempts (5s apart).
reapply_container_caps() {
  label="$1"
  attempts="$2"
  if [ -z "$PRIVATE_IP" ] || [ -z "$VM_SSH_USER" ] || [ -z "$VM_SSH_KEY_PATH" ] || [ ! -r "$VM_SSH_KEY_PATH" ]; then
    echo "[resize] container caps ($label): no guest SSH route available; skipped" >&2
    return 0
  fi
  if [ -z "$GUEST_KNOWN_HOSTS" ]; then
    GUEST_KNOWN_HOSTS="$(mktemp /tmp/hermes-resize-known-hosts.XXXXXX)"
  fi
  attempt=1
  while [ "$attempt" -le "$attempts" ]; do
    if printf '%s' "$GUEST_CGROUP_B64" | base64 -d | ssh \\
      -i "$VM_SSH_KEY_PATH" \\
      -o BatchMode=yes \\
      -o StrictHostKeyChecking=accept-new \\
      -o UserKnownHostsFile="$GUEST_KNOWN_HOSTS" \\
      -o ConnectTimeout=5 \\
      "$VM_SSH_USER@$PRIVATE_IP" "sudo bash -s"; then
      return 0
    fi
    attempt=$(( attempt + 1 ))
    if [ "$attempt" -le "$attempts" ]; then sleep 5; fi
  done
  echo "[resize] WARN: container caps ($label) not reapplied after $attempts attempt(s); the tier_change_pending recreate remains the backstop" >&2
  return 0
}

# Record current core count BEFORE the change so we only reboot when the
# visible vCPU topology actually changes (cpulimit/memory are hot; cores are not).
CUR_CORES=$(qm config "$VMID" 2>/dev/null | sed -n 's/^cores: *//p' | head -1)
[ -n "$CUR_CORES" ] || CUR_CORES=1

# Apply CPU + memory caps. --cpulimit (scheduler cap) + --memory/--balloon
# (balloon) take effect live. --cores sets the guest-visible vCPU count so
# nproc matches the tier — REQUIRED so docker's deploy.resources.limits.cpus
# (= cpuLimit) never exceeds available CPUs on the VM.
qm set "$VMID" --cpulimit "$CPU_LIMIT" --cores "$CORES" --memory "$MEMORY_MB" --balloon "$BALLOON_FLOOR_MB"${cpuUnitsArg}

# Reapply the container ceiling BEFORE any reboot, while the guest is known-up.
# docker update persists into hostconfig.json, so the new memory limit survives
# the reboot below (containers RESTART, they aren't recreated) — which means the
# RAM half of the upgrade lands even if the post-reboot pass never gets to run.
reapply_container_caps pre-reboot 3

# --cores only becomes visible to the guest (nproc) after a restart. Reboot ONLY
# when cores INCREASE: an upgrade must restart so the guest gains the vCPUs (and
# so docker's cpus limit doesn't exceed nproc). Downgrades need no reboot — the
# new (lower) cores apply on the next natural restart, and a VM with MORE cores
# than the tier still runs the lower docker cpus limit fine; cpulimit/memory-only
# resizes stay hot.
if [ "$CORES" -gt "$CUR_CORES" ] 2>/dev/null; then
  echo "[resize] cores $CUR_CORES -> $CORES (increase); rebooting VM $VMID so the guest sees the new vCPUs"
  qm reboot "$VMID" --timeout 120 || { echo "[resize] graceful reboot failed; forcing stop/start"; qm stop "$VMID" || true; qm start "$VMID"; }
  # Second pass: the pre-reboot run had to clamp --cpus to the OLD nproc, so
  # only now can the container get the tier's full CPU share. Bounded wait —
  # this is the tail of the resize, not something the caller should block on
  # forever, and the memory ceiling already landed above.
  reapply_container_caps post-reboot 12
fi

# Verify
qm config "$VMID" | grep -E '^(cores|cpulimit|memory|balloon):' || true
`;
  const runner = deps.runHostScript ?? ((hostScript: string) => runProxmoxHostScript(hostScript, env));
  return runner(script);
}
