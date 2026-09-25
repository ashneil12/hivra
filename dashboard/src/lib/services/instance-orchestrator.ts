import { SupabaseClient } from "@supabase/supabase-js";
import {
  getHetznerInstanceStatus,
  resolveGatewayConfiguration,
  buildAgentDeployScript,
  type HonchoSettings,
} from "@/lib/services/hetzner-instance-service";
import {
  buildProxmoxTenantIsolationGuard,
  getProxmoxInfrastructure,
  resolveProxmoxHostEnv,
  runProxmoxHostScript,
  resolveProxmoxGatewayUrlFromSubdomain,
  getProxmoxHostRoutingConfigFromInfrastructure,
  type ProxmoxHostRoutingConfig,
} from "@/lib/services/proxmox-instance-service";
import {
  buildWebUIBootstrapScript,
  buildWebUIProvisioningArtifacts,
  type WebUIDeployParams,
} from "@/lib/services/webui-instance-builder";
import { resolveRamBurst } from "@/lib/services/ram-burst";
import { deriveDnsDomainFromGatewayUrl } from "@/lib/services/cloudflare-dns";
import { PROVIDER_ID_MAP, resolveProviderBaseUrl } from "@/lib/services/provider-config";
import type { CodexVaultBundle } from "@/lib/codex-oauth";
import type { NousVaultBundle } from "@/lib/nous-oauth";
import { sshExec } from "@/lib/hetzner/ssh";
import { redactSensitiveCommandOutput } from "@/lib/command-output-redaction";
import { decryptApiKey } from "@/lib/crypto";
import {
  isCodexAuthProvider,
  isNousAuthProvider,
  resolveDeploymentApiKey,
  resolveProviderDeploymentSecret,
} from "@/lib/provider-deployment-auth";
import {
  bankrRuntimeWalletAddressHistory,
  buildInstanceBankrAgentConfig,
  getBankrWalletForInstance,
  isRevokedUserConnectedWallet,
  isUserConnectedWalletRecord,
  type InstanceBankrAgentConfig,
  type InstanceBankrWalletRecord,
} from "@/lib/billing/bankr-instance-wallets";
import {
  getRuntimeAgentSettings,
  getAutoUpdateConfig,
  decryptMemorySystemSecrets,
  type MemorySystemConfig,
} from "@/lib/instance-settings";
import { isProTierUser } from "@/lib/billing/pro-tier";
import {
  isOperatorosFlavorConfig,
  resolveAgentImageForStoredConfig,
} from "@/lib/operatoros-flavor";
import { resolvePersonaSoulFromSystemPrompt } from "@/lib/persona-souls-accessor";
import type { InstanceBackend } from "@/lib/types/instance";
import { isWebfreeBackend } from "@/lib/types/instance";
import { validateProviderApiKey } from "@/lib/services/provider-validation";
import { getProfileDeploymentState } from "@/lib/profile-deployment";
import { isIpv4Literal } from "@/lib/network-address";
import { buildInstanceUpdateReporterShell } from "@/lib/services/update-status-reporting";
import {
  BROWSER_SIDECAR_DEPLOY_ENABLED_ENV,
  isBrowserSidecarDeploymentGateEnabled,
  instanceCanFitBrowserSidecar,
} from "@/lib/browser-sidecar/deployment-gate";
import { buildInstanceLifecyclePatch } from "@/lib/instance-lifecycle";
import { log } from "@/lib/logger";
import { buildIdleGatedUpdateProvisioningScript } from "@/lib/services/idle-gated-update-builder";
import {
  INFLIGHT_UPDATE_GATE_BUDGET_SECONDS,
  buildClearUpdateDeferralsCommand,
  buildInFlightUpdateGateScript,
  describeInFlightDeferral,
  gatedLaunchTimeoutMs,
  inFlightGateLogFields,
  missingInFlightUpdateGateReport,
  parseInFlightUpdateGateReport,
  type InFlightDeferralReason,
  type InFlightUpdateGateReport,
} from "@/lib/services/inflight-update-gate";
import {
  isSystemLiveUpdate,
  type LiveUpdateInitiator,
} from "@/lib/services/live-update-initiator";

const LOG_SOURCE = "instance-orchestrator";

function shQuote(value: string | number): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// We mirror the row type here so this module doesn't depend on route.ts
export interface InstanceRowForOrchestration {
  id: string;
  user_id: string;
  provider: string;
  /** User-facing agent name (column `name` on the instances table).
   *  Forwarded as HERMES_WEBUI_BOT_NAME so WebUI's Assistant Name preference
   *  seeds with the name the user gave the agent at deploy time. */
  name?: string | null;
  subdomain?: string | null;
  hetzner_server_id?: number | null;
  gateway_url?: string | null;
  api_key_encrypted: string;
  api_server_key_encrypted?: string | null;
  honcho_api_key_encrypted?: string | null;
  config?: Record<string, unknown>;
  host_id?: string | null;
  proxmox_node?: string | null;
  ipv4_address?: string | null;
  cpu_limit?: number;
  ram_limit?: number;
  /** "gateway" (legacy hermes-agent) or "webui" (hermes-webui). When unset
   *  or null (rows pre-dating the WebUI backend column), callers fall
   *  back to "gateway" for backwards-compat. */
  backend?: InstanceBackend | null;
}

export function getHonchoSettingsFromInstance(instance: InstanceRowForOrchestration): HonchoSettings {
  const honchoApiKey = instance.honcho_api_key_encrypted
    ? decryptApiKey(instance.honcho_api_key_encrypted)
    : undefined;
  const cfg = instance.config?.honcho as Record<string, unknown> | undefined;

  return {
    enabled: Boolean(cfg?.enabled ?? true),
    apiKey: honchoApiKey || undefined,
    baseUrl: typeof cfg?.baseUrl === "string" ? cfg.baseUrl : undefined,
    peerName: typeof cfg?.peerName === "string" ? cfg.peerName : undefined,
    aiPeer: typeof cfg?.aiPeer === "string" ? cfg.aiPeer : undefined,
    memoryMode: cfg?.memoryMode === "honcho" ? "honcho" : "hybrid",
    recallMode:
      cfg?.recallMode === "context" || cfg?.recallMode === "tools"
        ? (cfg.recallMode as "context" | "tools")
        : "hybrid",
    configMode: (cfg?.configMode as "simple" | "advanced") ?? "simple",
  };
}

export async function resolveInstanceIpv4(
  instance: InstanceRowForOrchestration,
  supabaseAdmin?: SupabaseClient
): Promise<string> {
  if (isIpv4Literal(instance.ipv4_address)) {
    return instance.ipv4_address;
  }

  // Proxmox-backed instances expose the guest's private IPv4. sshExec auto-
  // routes the private subnet through the Proxmox host as a bastion, so
  // returning privateIpv4 lets every SSH-based dashboard call (telemetry,
  // console, redeploy, etc.) reach the guest.
  const proxmoxInfrastructure = getProxmoxInfrastructure(instance.config);
  if (proxmoxInfrastructure) {
    return proxmoxInfrastructure.privateIpv4;
  }

  // 1. Try to resolve via host_id (multi-agent host)
  if (instance.host_id && supabaseAdmin) {
    const { data: host } = await supabaseAdmin
      .from("hermes_hosts")
      .select("hetzner_server_id, ipv4_address")
      .eq("id", instance.host_id)
      .single<{ hetzner_server_id: number | null; ipv4_address?: string | null }>();

    if (isIpv4Literal(host?.ipv4_address)) {
      return host.ipv4_address;
    }

    if (host?.hetzner_server_id) {
      const hs = await getHetznerInstanceStatus(host.hetzner_server_id);
      if (hs.ipv4) {
        await supabaseAdmin
          .from("hermes_hosts")
          .update({ ipv4_address: hs.ipv4 })
          .eq("id", instance.host_id);
        return hs.ipv4;
      }
    }
  }

  // 2. Try to resolve via direct hetzner_server_id (legacy single-node)
  if (instance.hetzner_server_id) {
    const hs = await getHetznerInstanceStatus(instance.hetzner_server_id);
    if (hs.ipv4 && supabaseAdmin) {
      await supabaseAdmin
        .from("hermes_instances")
        .update({ ipv4_address: hs.ipv4 })
        .eq("id", instance.id);
      return hs.ipv4;
    }
    if (hs.ipv4) {
      return hs.ipv4;
    }
  }

  // 3. Final fallback: Extract from gateway_url if available
  if (instance.gateway_url) {
    try {
      const url = new URL(instance.gateway_url);
      if (isIpv4Literal(url.hostname)) {
        return url.hostname;
      }
    } catch {
      // Ignore invalid URL
    }
  }

  return "";
}

/**
 * What a live update does with the box's BANKR_* runtime env.
 *
 * - `upsert`: write the wallet's values (the only case with a config).
 *   `userConnected` marks a key from the user's own Bankr account, whose
 *   update also strips config.yaml's stale `bankr:` block and drops BANKR_*
 *   from cloned profile .env files holding any of `walletAddresses`, so each
 *   profile picks up the key this run delivers.
 * - `preserve`: leave whatever the box has. Covers no wallet row, a row with
 *   nothing to deliver (pending, failed, a revoked Hivra-provisioned row) and
 *   any lookup or decrypt failure, so a transient error never wipes live
 *   wallet credentials.
 * - `clear`: remove the disconnected wallet's BANKR_* and the `bankr:` block.
 *   Only for a row the lookup definitively resolved to a user-connected wallet
 *   the user disconnected.
 *
 * `walletAddresses` is every address the row has delivered
 * (bankrRuntimeWalletAddressHistory: the current one, which a disconnect
 * keeps, each earlier wallet a reconnect replaced and a replaced Hivra-created
 * wallet), lower-cased. A connect or disconnect can skip the restart, so the
 * box may still hold any of them. The update script matches each file's
 * BANKR_AGENT_WALLET_ADDRESS against this set and never touches a file
 * holding any other address. A revoked row without one valid address is
 * preserved instead.
 */
export type BankrRuntimeEnvPlan =
  | { action: "upsert"; config: InstanceBankrAgentConfig; userConnected: false }
  | { action: "upsert"; config: InstanceBankrAgentConfig; userConnected: true; walletAddresses: string[] }
  | {
      action: "preserve";
      reason: "no_wallet" | "not_deliverable" | "lookup_failed" | "disconnected_address_unknown";
    }
  | { action: "clear"; reason: "user_disconnected"; walletAddresses: string[] };

const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

function warnBankrAgentConfigUnavailable(instanceId: string, err: unknown): void {
  log.warn("bankr agent config unavailable during live update", {
    source: LOG_SOURCE,
    failureType: "bankr_agent_config_update_unavailable",
    instanceId,
    error: err instanceof Error ? err.message : String(err),
  });
}

export async function resolveBankrRuntimeEnvPlanForUpdate(
  instanceId: string,
  supabaseAdmin: SupabaseClient
): Promise<BankrRuntimeEnvPlan> {
  let record: InstanceBankrWalletRecord | null;
  try {
    record = await getBankrWalletForInstance({ instanceId, db: supabaseAdmin });
  } catch (err) {
    warnBankrAgentConfigUnavailable(instanceId, err);
    return { action: "preserve", reason: "lookup_failed" };
  }
  if (!record) return { action: "preserve", reason: "no_wallet" };

  if (isRevokedUserConnectedWallet(record)) {
    const walletAddresses = bankrRuntimeWalletAddressHistory(record);
    if (walletAddresses.length === 0) {
      log.warn("bankr runtime env left in place: disconnected user wallet has no address", {
        source: LOG_SOURCE,
        failureType: "bankr_runtime_env_clear_without_address",
        instanceId,
        walletRowId: record.id,
      });
      return { action: "preserve", reason: "disconnected_address_unknown" };
    }
    log.info("bankr runtime env cleared for a disconnected user wallet", {
      source: LOG_SOURCE,
      instanceId,
      walletRowId: record.id,
      bankrRuntimeEnv: "clear",
      walletAddressCount: walletAddresses.length,
    });
    return { action: "clear", reason: "user_disconnected", walletAddresses };
  }

  let config: InstanceBankrAgentConfig | null;
  try {
    config = await buildInstanceBankrAgentConfig(record);
  } catch (err) {
    warnBankrAgentConfigUnavailable(instanceId, err);
    return { action: "preserve", reason: "lookup_failed" };
  }
  if (!config) return { action: "preserve", reason: "not_deliverable" };
  if (!isUserConnectedWalletRecord(record)) return { action: "upsert", config, userConnected: false };
  // The delivered address is in the set too: a new key for the same wallet
  // must replace every profile copy of the old one.
  const delivered = config.walletAddress.trim();
  const walletAddresses = [
    ...(EVM_ADDRESS_PATTERN.test(delivered) ? [delivered.toLowerCase()] : []),
    ...bankrRuntimeWalletAddressHistory(record),
  ].filter((address, index, all) => all.indexOf(address) === index);
  return { action: "upsert", config, userConnected: true, walletAddresses };
}

export interface LiveUpdateOptions {
  /**
   * Who asked for this update. Required so every caller decides: a system
   * initiator (scheduled automation) passes the in-flight turn gate and may be
   * deferred; user and operator initiators recreate immediately. See
   * live-update-initiator.ts.
   */
  initiator: LiveUpdateInitiator;
  applyTerminalBackend?: boolean;
}

/**
 * - applied: the update was launched on the box. `inFlightGate` is the gate's
 *   report for a system update (null for user/operator updates, which skip it).
 * - deferred: a system update did NOT launch because an agent turn is in flight
 *   (`deferred_busy`) or the box could not confirm that none is running
 *   (`deferred_unverified`); nothing on the box or in the row changed. The
 *   caller retries on its next tick. `error` carries a readable reason for
 *   callers that only log it.
 * - otherwise: the launch failed (`error`).
 */
export type LiveUpdateResult =
  | {
      applied: true;
      deferred?: undefined;
      initiator: LiveUpdateInitiator;
      inFlightGate: InFlightUpdateGateReport | null;
    }
  | {
      applied: false;
      deferred: true;
      reason: InFlightDeferralReason;
      error: string;
      initiator: LiveUpdateInitiator;
      inFlightGate: InFlightUpdateGateReport;
    }
  | {
      applied: false;
      deferred?: undefined;
      error: string;
      initiator: LiveUpdateInitiator;
    };

/** Last line of the launch output that isn't the gate's report: the background pid. */
function launchedPid(stdout: string): string {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("HERMES_INFLIGHT_GATE "));
  return lines[lines.length - 1] ?? "";
}

export async function applyLiveUpdate(
  instance: InstanceRowForOrchestration,
  ipv4: string,
  globalSettings: Record<string, unknown>,
  supabaseAdmin: SupabaseClient,
  options: LiveUpdateOptions
): Promise<LiveUpdateResult> {
  const { initiator } = options;
  const proxmoxInfrastructure = getProxmoxInfrastructure(instance.config);
  if (!proxmoxInfrastructure && !instance.host_id && !instance.hetzner_server_id) {
    return { applied: false as const, error: "No host attached", initiator };
  }
  if (!proxmoxInfrastructure && !ipv4) {
    return { applied: false as const, error: "Host has no IPv4 address", initiator };
  }

  const decryptedSecret = decryptApiKey(instance.api_key_encrypted);
  const providerDeploymentSecret = resolveProviderDeploymentSecret(
    instance.provider,
    decryptedSecret
  );
  const apiKey = resolveDeploymentApiKey(
    decryptedSecret,
    providerDeploymentSecret
  );
  const apiServerKey = instance.api_server_key_encrypted
    ? decryptApiKey(instance.api_server_key_encrypted)
    : "";
  const model = typeof instance.config?.model === "string" ? instance.config.model : "";
  // Clean-slate BYOK (deploy-card Managed=OFF): persisted on create as
  // config.unconfigured. Threaded into webUIParams below so a REDEPLOY of a
  // clean-slate box stays clean-slate (no provider/model/key re-seeded) and the
  // agent's native onboarding overlay keeps owning provider setup. instance.provider
  // stays at its benign default and is still read safely for PROVIDER_ID_MAP below.
  const unconfigured = instance.config?.unconfigured === true;
  // Operator OS flavor: persisted on create as config.agentFlavor +
  // config.webuiAgentImage (see operatoros-flavor.ts for the shared detection
  // every path uses). Threaded into webUIParams below so an UPDATE/redeploy
  // (a) never re-seeds a welcome persona soul over the box's autonomy SOUL and
  // (b) regenerates compose on the operatoros image instead of reverting to
  // the env-default vanilla image. resolveAgentImageForStoredConfig also
  // covers the half-migrated row that says operatoros but stored no image:
  // returning undefined there would silently boot the vanilla runtime AND
  // seed the wrong identity (the builder's SOUL gate keys on the image).
  const resolvedAgentImage = resolveAgentImageForStoredConfig(instance.config);
  const isOperatorosFlavor = isOperatorosFlavorConfig(instance.config);
  const runtimeAgentSettings = getRuntimeAgentSettings(instance.config);
  const bankrRuntimeEnvPlan = await resolveBankrRuntimeEnvPlanForUpdate(instance.id, supabaseAdmin);
  const bankrAgentConfig = bankrRuntimeEnvPlan.action === "upsert" ? bankrRuntimeEnvPlan.config : null;
  // Only a user-connected wallet changes the webfree script: a disconnect
  // clears BANKR_* belonging to any wallet the row delivered, a connect
  // replaces them, drops config.yaml's `bankr:` block and refreshes profile
  // copies. Every other plan leaves the script exactly as it was.
  const bankrRuntimeReconcile: WebUIDeployParams["bankrRuntimeReconcile"] =
    bankrRuntimeEnvPlan.action === "clear"
      ? { action: "clear_user_disconnected", walletAddresses: bankrRuntimeEnvPlan.walletAddresses }
      : bankrRuntimeEnvPlan.action === "upsert" && bankrRuntimeEnvPlan.userConnected
        ? { action: "replace_user_connected", walletAddresses: bankrRuntimeEnvPlan.walletAddresses }
        : undefined;

  // Validate API key against provider before deploying
  if (apiKey) {
    const validation = await validateProviderApiKey(instance.provider, apiKey);
    if (!validation.valid) {
      const safeValidationError = validation.error
        ? redactSensitiveCommandOutput(validation.error, 300)
        : "Unknown validation error";
      log.warn("API key validation failed but proceeding with deploy", {
        source: LOG_SOURCE,
        failureType: "api_key_validation_failed",
        instanceId: instance.id,
        userId: instance.user_id,
        provider: instance.provider,
        validationError: safeValidationError,
      });
    }
  }

  // Site-3 guard (2026-07-02 poisoning class): proxmoxInfrastructure.gatewayHost
  // can be the vmbr1 NAT bridge IP (e.g. 10.250.20.1) on a restored/recovered
  // row. This gatewayUrl flows to the gateway_url DB write below, and
  // applyLiveUpdate is the exact path recover-unhealthy-active-instances calls
  // every cycle — so a raw `https://${gatewayHost}` here re-poisons the row and
  // paints a healthy VM as unhealthy. Derive the canonical FQDN via the shipped
  // recovery helper (PR #439/#441); on null, keep the row's existing gateway_url
  // rather than persisting a bridge IP. Never fall back to the raw gatewayHost.
  const proxmoxGatewayUrl = proxmoxInfrastructure
    ? resolveProxmoxGatewayUrlFromSubdomain({
        subdomain: instance.subdomain ?? null,
        hostConfig: getProxmoxHostRoutingConfigFromInfrastructure(proxmoxInfrastructure, {
          host_id: instance.host_id ?? null,
        }),
      }) ?? instance.gateway_url ?? null
    : null;
  const { fqdn, gatewayUrl } = proxmoxInfrastructure
    ? {
        // fqdn is dead for proxmox — overridden to "localhost" below (guest
        // Caddy binds :80). This branch only sources the DB gateway_url.
        // No raw gatewayHost fallback: that exact pattern is what poisoned
        // 5 prod rows with https://10.250.20.1 (2026-06-30/07-01 incident).
        fqdn: (proxmoxGatewayUrl ?? instance.gateway_url ?? "").replace(/^https?:\/\//, ""),
        gatewayUrl: proxmoxGatewayUrl,
      }
    : resolveGatewayConfiguration({
        subdomain: instance.subdomain ?? null,
        ipv4,
        // Preserve the existing domain (sslip vs hermesos.cloud, or
        // legacy per-host sub-subdomains) so the rebuilt agent script
        // keeps the same FQDN as what's already running on the box.
        // Returns null for sslip URLs, falling back to the sslip resolver.
        dnsDomain: deriveDnsDomainFromGatewayUrl(
          instance.gateway_url,
          instance.subdomain ?? null,
        ),
      });
  const { profileRoutes, profilesToRestore } = await getProfileDeploymentState(
    supabaseAdmin,
    instance.id,
    instance.user_id
  );

  // Backend-aware deploy script. WebUI instances run a different runtime
  // (hermes-webui container reading source from a named volume) so the
  // legacy gateway-style buildAgentDeployScript would deploy the wrong
  // containers and break the instance. Mirrors the same branch present
  // in proxmox-instance-service.ts and hetzner-instance-service.ts.
  // Default to "gateway" when backend is unset (legacy rows pre-dating
  // the WebUI backend column).
  const backend: InstanceBackend = instance.backend === "webui" ? "webui" : "gateway";
  const isolatedCustomerVm =
    Boolean(proxmoxInfrastructure) ||
    (!instance.host_id && typeof instance.hetzner_server_id === "number");
  const gatewayDockerAccess =
    isWebfreeBackend(backend) &&
    isolatedCustomerVm &&
    runtimeAgentSettings.enableRootAccess === true;
  let agentScript: string;
  if (isWebfreeBackend(backend)) {
    const inferenceProvider =
      instance.provider === "custom_llm"
        ? "custom"
        : PROVIDER_ID_MAP[instance.provider] ?? instance.provider;
    const customLlmBaseUrl = runtimeAgentSettings.customLlmBaseUrl;

    // Provisioning gates for browser-sidecar. It now defaults ON for Pro+
    // instances — only an explicit opt-out (browserSidecarEnabled === false)
    // suppresses it. The deployment gate keeps this special-purpose sidecar
    // absent from ordinary installs; the tier check is re-resolved on every
    // redeploy. Diagnostic logs fire only for an EXPLICIT opt-in, so the common
    // default-on paths (non-Pro+ tier, or gate-off deployments) don't spam.
    const browserSidecarExplicitOptIn = runtimeAgentSettings.browserSidecarEnabled === true;
    const wantBrowserSidecar = runtimeAgentSettings.browserSidecarEnabled !== false;
    const browserSidecarDeploymentGateEnabled = isBrowserSidecarDeploymentGateEnabled();
    let browserSidecarEnabled = false;
    // RAM floor: never schedule the ~1.3 GB sidecar onto a box whose budget is
    // KNOWN too small (defense-in-depth against a stale/mis-set ram_limit). A
    // missing ram_limit is treated as unknown → allowed; the sidecar entrypoint
    // re-checks the live VM's actual RAM. Pass the raw nullable value (not the
    // ?? 2048 sizing default) so "unset" isn't mistaken for "2 GB".
    const browserSidecarRamSufficient = instanceCanFitBrowserSidecar(
      instance.ram_limit
    );
    if (wantBrowserSidecar && browserSidecarDeploymentGateEnabled) {
      const tierCheck = await isProTierUser(instance.user_id);
      browserSidecarEnabled = tierCheck.ok && browserSidecarRamSufficient;
      if (!tierCheck.ok && browserSidecarExplicitOptIn) {
        log.info("browser-sidecar disabled at deploy time: tier no longer qualifies", {
          source: LOG_SOURCE,
          failureType: "browser_sidecar_tier_dropped",
          instanceId: instance.id,
          userId: instance.user_id,
          reason: tierCheck.reason,
          tier: tierCheck.tier,
        });
      } else if (tierCheck.ok && !browserSidecarRamSufficient) {
        log.warn("browser-sidecar disabled at deploy time: insufficient RAM budget", {
          source: LOG_SOURCE,
          failureType: "browser_sidecar_ram_insufficient",
          instanceId: instance.id,
          userId: instance.user_id,
          ramLimitMb: instance.ram_limit ?? 2048,
        });
      }
    } else if (browserSidecarExplicitOptIn && !browserSidecarDeploymentGateEnabled) {
      log.info("browser-sidecar disabled at deploy time: deployment gate is off", {
        source: LOG_SOURCE,
        failureType: "browser_sidecar_deploy_gate_disabled",
        instanceId: instance.id,
        userId: instance.user_id,
        envVar: BROWSER_SIDECAR_DEPLOY_ENABLED_ENV,
      });
    }

    const webUIParams = {
      instanceId: instance.id,
      containerName: `agent-${instance.id}`,
      // Proxmox has two Caddy layers: public TLS on the host, plain HTTP
      // inside the guest VM. The guest Caddyfile must bind :80; using the
      // public hostname here makes Caddy redirect /health to HTTPS forever.
      fqdn: proxmoxInfrastructure ? "localhost" : fqdn,
      cpuLimit: instance.cpu_limit ?? 1,
      ramLimit: instance.ram_limit ?? 2048,
      // The container cgroup must land on the SAME ceiling the VM boots at.
      // Provisioning hands buildWebUICompose ramBurst.ceilingMb and creates the
      // VM with the same number; resizeProxmoxVm docker-updates the containers
      // to it. Without this the recreate path would regenerate compose at the
      // BASELINE and silently walk a burst-sized box back down — the same
      // "VM ceiling and container ceiling disagree" bug from the other side.
      // Burst is off by default, in which case ceilingMb === baseline and this
      // is a byte-for-byte no-op. Proxmox only: Hetzner has no burst plan.
      ramBurstMb: proxmoxInfrastructure
        ? resolveRamBurst(Math.max(1024, Math.floor(instance.ram_limit ?? 2048))).ceilingMb
        : undefined,
      llmApiKey: apiKey,
      inferenceProvider,
      defaultModel: model,
      dashboardProvider: instance.provider,
      baseUrl:
        resolveProviderBaseUrl(instance.provider, customLlmBaseUrl, apiKey) ??
        undefined,
      // Auxiliary compression model + context engine, from the instance's stored
      // agentSettings. This is the redeploy path the Configuration tab's Save &
      // apply lands on, so a dashboard change to either reaches the box here as
      // config.yaml auxiliary.compression.{provider,model} + context.engine.
      compressionProvider: runtimeAgentSettings.compressionProvider,
      compressionModel: runtimeAgentSettings.compressionModel,
      contextEngine: runtimeAgentSettings.contextEngine,
      // Stable per-instance bearer that gates the WebUI HTTP API. Re-use
      // the api_server_key the row was provisioned with so the running
      // webui's already-issued tokens keep validating after the recreate.
      webuiPassword: apiServerKey,
      tavilyApiKey: runtimeAgentSettings.tavilyApiKey,
      daytonaApiKey: runtimeAgentSettings.daytonaApiKey,
      firecrawlApiKey: runtimeAgentSettings.firecrawlApiKey,
      codexAuthBundle:
        isCodexAuthProvider(instance.provider)
          ? (providerDeploymentSecret.authBundle as CodexVaultBundle | undefined)
          : undefined,
      bankr: bankrAgentConfig,
      ...(bankrRuntimeReconcile ? { bankrRuntimeReconcile } : {}),
      browserSidecarEnabled,
      // Docker-socket access is root-equivalent. A persisted Proxmox guest or
      // a direct, non-host-attached Hetzner server proves this runtime is in a
      // customer-dedicated VM. Shared-host/legacy rows fail closed even when
      // stale or user-controlled settings request it.
      gatewayDockerAccess,
      terminalBackend: runtimeAgentSettings.terminalBackend,
      agentName: instance.name,
      // Welcome-persona deploys carry the authored soul as the BASE of the
      // stored systemPrompt. Resolve it on the UPDATE path too (it was only
      // wired on fresh provision) so a config redeploy or a recovery redrive —
      // both of which run in update mode through this call site — re-seeds the
      // hired persona's SOUL.md when the box is still un-onboarded, instead of
      // leaving a slow-provisioned or redriven box on the factory default. The
      // seed's head-pattern guard keeps this idempotent and never overwrites a
      // real authored identity. Null for custom/no-persona deploys.
      // Operator OS always uses its own autonomy SOUL — never a welcome persona
      // (mirrors the fresh-provision gate in proxmox-instance-service.ts).
      personaSoulPrompt: isOperatorosFlavor
        ? null
        : resolvePersonaSoulFromSystemPrompt(runtimeAgentSettings.systemPrompt)?.soulPrompt ??
          null,
      // Clean-slate BYOK: when set, the builders skip all provider/model/key
      // seeding so a redeploy never re-bricks a box the user configured later.
      unconfigured,
      // Agent image override persisted at create (Operator OS boxes). Without
      // it, resolveWebUIAgentImage falls back to the env-default vanilla image
      // and every dashboard-driven update evicts the operatoros runtime.
      ...(resolvedAgentImage ? { agentImage: resolvedAgentImage } : {}),
    };
    log.info("seeding WebUI default model from dashboard deployment selection", {
      source: LOG_SOURCE,
      failureType: "webui_default_model_seed",
      instanceId: instance.id,
      userId: instance.user_id,
      dashboardProvider: instance.provider,
      inferenceProvider,
      defaultModel: model,
      mode: "update",
    });
    const artifacts = isOperatorosFlavor
      ? buildWebUIProvisioningArtifacts(webUIParams, "update")
      : buildWebUIProvisioningArtifacts(webUIParams);
    // Refresh the box-local idle-gated update stack (idle sampler + hourly roll +
    // static refresh) where the box already runs it, so fixes to it (such as the
    // sampler counting web-chat turns) reach existing boxes instead of only new
    // provisions. Boxes that never had the stack are not enrolled here. Same
    // builder call as the Proxmox provision path, plus the row's pinned image so
    // the roll follows the image this compose runs.
    const rollExecutable = `/usr/local/bin/hermes-roll-${instance.id}`;
    const idleGatedStackRefresh = `# Refresh the idle-gated update stack only where it is already installed.
if [ -x ${shQuote(rollExecutable)} ]; then
${buildIdleGatedUpdateProvisioningScript({
  instanceId: instance.id,
  backend: "gateway",
  ...(resolvedAgentImage ? { agentImage: resolvedAgentImage } : {}),
})}fi
`;
    agentScript = buildWebUIBootstrapScript(artifacts, webUIParams, {
      mode: "update",
      // Normal updates/recovery must retain backend changes made in the native
      // Hermes config; only the terminal/access Save & Apply flow overrides it.
      ...(options.applyTerminalBackend === true ? { applyTerminalBackend: true } : {}),
      additionalProvisioningScript: idleGatedStackRefresh,
    });
  } else {
    agentScript = buildAgentDeployScript({
      instanceId: instance.id,
      containerName: `agent-${instance.id}`,
      apiServerKey,
      provider: instance.provider,
      apiKey,
      model,
      // Preserve clean-slate BYOK across redeploys: without this the gateway
      // builder re-bakes the reconciled openrouter default model with no key →
      // "No LLM provider configured". (config.unconfigured computed above.)
      unconfigured,
      fqdn,
      cpuLimit: instance.cpu_limit ?? 1,
      ramLimit: instance.ram_limit ?? 2048,
      migrationUrl: instance.config?.migrationUrl as string | undefined,
      codexAuthBundle:
        isCodexAuthProvider(instance.provider)
          ? (providerDeploymentSecret.authBundle as CodexVaultBundle | undefined)
          : undefined,
      nousAuthBundle:
        isNousAuthProvider(instance.provider)
          ? (providerDeploymentSecret.authBundle as NousVaultBundle | undefined)
          : undefined,
      honchoSettings: getHonchoSettingsFromInstance(instance),
      bankr: bankrAgentConfig,
      agentSettings: runtimeAgentSettings,
      autoUpdate: getAutoUpdateConfig(instance.config),
      memorySystem: decryptMemorySystemSecrets(
        instance.config?.memorySystem as MemorySystemConfig | undefined
      ),
      globalSettings,
      profileRoutes,
      profilesToRestore,
    });
  }

  const scriptPath = `/tmp/hermes-update-${instance.id}.sh`;
  const wrapperPath = `/tmp/hermes-update-wrapper-${instance.id}.sh`;
  const logPath = `/tmp/hermes-update-${instance.id}.log`;
  // Single-tenant VM invariant: each Proxmox guest hosts exactly one instance, and the
  // outer caddy globs `/opt/hermes/instances/*/Caddyfile`. A misrouted deploy that lands
  // a second tenant dir here gets two `:80` blocks → caddy adapter errors → port 80
  // unbound → the legitimate tenant's gateway returns 502 until cleanup.
  const singleTenantGuard = proxmoxInfrastructure
    ? `
if [ -d /opt/hermes/instances ]; then
  stray_dirs=$(find /opt/hermes/instances -mindepth 1 -maxdepth 1 -type d ! -name "${instance.id}" 2>/dev/null)
  if [ -n "$stray_dirs" ]; then
    echo "ERROR: refusing to deploy ${instance.id} -- VM already hosts other instance(s):" >&2
    echo "$stray_dirs" >&2
    ru "failed" "stray_tenant_dir_collision" || true
    exit 64
  fi
fi
`
    : "";
const wrapperScript = `#!/usr/bin/env bash
set -euo pipefail
${buildInstanceUpdateReporterShell({
  instanceId: instance.id,
  dashboardUrl: process.env.NEXT_PUBLIC_APP_URL,
  apiServerKey,
  runType: "manual",
})}
${singleTenantGuard}
mkdir -p /opt/hermes/instances/${instance.id}
cd /opt/hermes/instances/${instance.id}

if bash ${scriptPath} > ${logPath} 2>&1; then
  ru "succeeded" "completed" || true
else
  status=$?
  ru "failed" "exit_status_\${status}" "${logPath}" || true
  exit "$status"
fi
`;

  // In-flight turn gate. A system-initiated update (nobody asked for this
  // restart) first asks the box whether an agent turn is running (a web-chat
  // turn in official-dashboard, or a messaging/cron/scheduled-task turn in the
  // gateway) and, while one is, prints a defer report and exits before anything
  // is written or launched; the gate caps how long that can go on per caller
  // (inflight-update-gate.ts). User and operator updates skip the check. Every
  // launched update ends every caller's deferral streak for the box.
  //
  // The gate's probe is bounded by gateBudgetSeconds, and the lane's launch
  // timeout grows by that budget (plus slack) below, so a slow Docker on the box
  // cannot push a system update past its SSH timeout into a failed launch.
  const gatePath = `/tmp/hermes-update-gate-${instance.id}.sh`;
  const gateBudgetSeconds = INFLIGHT_UPDATE_GATE_BUDGET_SECONDS;
  const gateLines = isSystemLiveUpdate(initiator)
    ? [
        `printf '%s' '${Buffer.from(
          buildInFlightUpdateGateScript({
            instanceId: instance.id,
            trigger: initiator.trigger,
            budgetSeconds: gateBudgetSeconds,
          })
        ).toString("base64")}' | base64 -d > ${gatePath}`,
        `hermes_update_gate_report="$(bash ${gatePath} </dev/null 2>/dev/null)" || true`,
        `rm -f ${gatePath}`,
        `printf '%s\\n' "$hermes_update_gate_report"`,
        `case "$hermes_update_gate_report" in *"action=defer"*) exit 0 ;; esac`,
      ]
    : [];
  const launchTimeoutMs = (baseTimeoutMs: number) =>
    isSystemLiveUpdate(initiator) ? gatedLaunchTimeoutMs(baseTimeoutMs, gateBudgetSeconds) : baseTimeoutMs;
  const innerScript = [
    ...gateLines,
    buildClearUpdateDeferralsCommand(instance.id),
    `printf '%s' '${Buffer.from(agentScript).toString("base64")}' | base64 -d > ${scriptPath}`,
    `chmod +x ${scriptPath}`,
    `printf '%s' '${Buffer.from(wrapperScript).toString("base64")}' | base64 -d > ${wrapperPath}`,
    `chmod +x ${wrapperPath}`,
    `nohup bash ${wrapperPath} </dev/null >/dev/null 2>&1 &`,
    `echo $!`,
  ].join("\n");

  // Bind the bastion env to THIS instance's host. Without this, runProxmoxHostScript
  // falls back to HERMES_PROXMOX_TARGET — a single global value — so an update for an
  // instance on fixturenodea can bastion through fixturenodea, then SSH to a private IP that resolves
  // to the wrong VM when subnets overlap (fixturenodea+fixturenodea both use 10.250.20.0/24). Prefer
  // the JSONB infrastructure block, then the row column. `failClosed:true` so a slug
  // that doesn't match any PROXMOX_<SLUG>_* env (e.g. legacy `fixturelegacy` blobs) throws
  // here with a clear message instead of silently inheriting the ambient PROXMOX_*
  // values — that fallback bit us 2026-05-17 when 11 fixturenodea VMs offered the stale
  // pre-rotation ambient key and got "All configured authentication methods failed".
  const proxmoxHostConfig: ProxmoxHostRoutingConfig | null = proxmoxInfrastructure
    ? (() => {
        const hostSlug =
          proxmoxInfrastructure.hostSlug?.trim() ||
          proxmoxInfrastructure.node?.trim() ||
          instance.proxmox_node?.trim() ||
          null;
        const hostId = proxmoxInfrastructure.hostId?.trim() || instance.host_id?.trim() || null;
        const envPrefix = proxmoxInfrastructure.hostEnvPrefix?.trim() || null;
        if (!hostSlug && !hostId && !envPrefix) return null;
        return { hostSlug, hostId, envPrefix, failClosed: true };
      })()
    : null;
  let proxmoxScriptEnv: NodeJS.ProcessEnv | Record<string, string | undefined>;
  try {
    proxmoxScriptEnv = proxmoxHostConfig
      ? resolveProxmoxHostEnv(proxmoxHostConfig, process.env)
      : process.env;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("proxmox host env resolution failed", new Error("proxmox_host_env_resolution_failed"), {
      source: LOG_SOURCE,
      failureType: "proxmox_host_env_resolution_failed",
      instanceId: instance.id,
      userId: instance.user_id,
      hostSlug: proxmoxHostConfig?.hostSlug ?? null,
      hostId: proxmoxHostConfig?.hostId ?? null,
      redactedMessage: redactSensitiveCommandOutput(message, 600),
    });
    return { applied: false as const, error: message, initiator };
  }

  const launchResult = proxmoxInfrastructure
    ? await runProxmoxHostScript(
        [
          `#!/usr/bin/env bash`,
          `set -euo pipefail`,
          ...(gatewayDockerAccess ? [buildProxmoxTenantIsolationGuard()] : []),
          `VMID=${shQuote(proxmoxInfrastructure.vmid)}`,
          `PRIVATE_IP=${shQuote(proxmoxInfrastructure.privateIpv4)}`,
          `VM_SSH_USER=${shQuote(proxmoxScriptEnv.PROXMOX_VM_SSH_USER || "hermes")}`,
          `VM_SSH_KEY_PATH=${shQuote(proxmoxScriptEnv.PROXMOX_VM_SSH_KEY_PATH || "/etc/hivra/keys/vm-orchestrator")}`,
          `SSH_KNOWN_HOSTS_FILE="/tmp/hermes-proxmox-known-hosts-update-$VMID"`,
          `rm -f "$SSH_KNOWN_HOSTS_FILE"`,
          `GUEST_SSH_OPTS=(-i "$VM_SSH_KEY_PATH" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$SSH_KNOWN_HOSTS_FILE")`,
          // The readiness wait MUST fit inside the runProxmoxHostScript cap below,
          // or the "not reachable over SSH" diagnostic underneath is dead code. A
          // powered-off VM drops packets rather than sending RST, so every attempt
          // burns the full ConnectTimeout: the old `seq 1 12` cost 12*(5s connect +
          // 5s sleep) = 120s and the 90s cap always fired first, reporting the
          // useless "Proxmox SSH operation timed out after 90000ms" instead of
          // naming the VM and IP. That mis-attribution cost hours on 2026-07-16,
          // when the inactivity sweep's 42703 (#593) left VMs powered off under
          // active rows and the fleet-sync redeploy walked into them.
          // 8 attempts with no trailing sleep = 8*5s connect + 7*5s sleep = 75s
          // worst case, leaving ~15s of headroom under the cap. A booting VM
          // answers well inside that; a healthy one answers on the first attempt.
          `SSH_READY_ATTEMPTS=8`,
          `ssh_ready=0`,
          `for _attempt in $(seq 1 "$SSH_READY_ATTEMPTS"); do`,
          `  if ssh -n "\${GUEST_SSH_OPTS[@]}" -o ConnectTimeout=5 "$VM_SSH_USER@$PRIVATE_IP" "sudo -n true" >/dev/null 2>&1; then`,
          `    ssh_ready=1`,
          `    break`,
          `  fi`,
          // Explicit `if` rather than `[ … ] && sleep 5`: under `set -e` a false
          // test as the loop body's last command makes the body exit non-zero.
          `  if [ "$_attempt" -lt "$SSH_READY_ATTEMPTS" ]; then sleep 5; fi`,
          `done`,
          `if [ "$ssh_ready" != "1" ]; then`,
          `  echo "VM $VMID is not reachable over SSH at $PRIVATE_IP" >&2`,
          `  exit 1`,
          `fi`,
          `printf '%s' '${Buffer.from(innerScript).toString("base64")}' | base64 -d | ssh "\${GUEST_SSH_OPTS[@]}" "$VM_SSH_USER@$PRIVATE_IP" "sudo bash -s"`,
        ].join("\n"),
        proxmoxScriptEnv,
        launchTimeoutMs(90_000)
      )
    : await sshExec(ipv4, "bash -s", {
      timeoutMs: launchTimeoutMs(30_000),
      stdin: innerScript,
    });

  if (!launchResult.ok) {
    log.error("update launch failed", new Error("update launch failed"), {
      source: LOG_SOURCE,
      failureType: "update_launch_failed",
      instanceId: instance.id,
      userId: instance.user_id,
      redactedMessage: redactSensitiveCommandOutput(launchResult.stderr || launchResult.error || "", 600),
    });
    // Stamp lifecycle_state='failed' so recover-stuck-instances (which selects
    // lifecycle_state IN ('failed','provisioning')) re-drives this row. Without
    // it, a launch failure here returns BEFORE the redeploying-patch below, so a
    // previously-active row is left orphaned with no recovery path — the cause
    // of the 7 stuck instances on 2026-06-09 (a whole fleet-sync wave failed on
    // a shared host and none of the rows ever became recovery candidates).
    await supabaseAdmin
      .from("hermes_instances")
      .update(buildInstanceLifecyclePatch("failed"))
      .eq("id", instance.id);
    return {
      applied: false as const,
      error: launchResult.stderr || launchResult.error || "Failed to start update process on server",
      initiator,
    };
  }

  let inFlightGate: InFlightUpdateGateReport | null = null;
  if (isSystemLiveUpdate(initiator)) {
    inFlightGate = parseInFlightUpdateGateReport(launchResult.stdout);
    if (inFlightGate?.action === "defer") {
      // Nothing was written or launched on the box, so the row keeps its
      // status and last_synced_at; the caller's next tick retries. A turn in
      // flight is routine; a box that cannot confirm it is idle (gateway state
      // stale or unreadable while it runs) may have a failing gateway, so that
      // one is loud.
      const deferral = describeInFlightDeferral(inFlightGate);
      const context = {
        source: LOG_SOURCE,
        failureType: `live_update_${deferral.reason}`,
        instanceId: instance.id,
        userId: instance.user_id,
        trigger: initiator.trigger,
        ...inFlightGateLogFields(inFlightGate),
      };
      if (deferral.kind === "busy") {
        log.info(`system live update deferred: ${deferral.summary}`, context);
      } else {
        log.warn(`system live update deferred: ${deferral.summary}`, context);
      }
      return {
        applied: false as const,
        deferred: true as const,
        reason: deferral.reason,
        error: `Deferred: ${deferral.clause} (deferral ${inFlightGate.deferrals}); the next run retries`,
        initiator,
        inFlightGate,
      };
    }
    if (!inFlightGate) {
      // The gate printed nothing usable (crashed, or the box shell ate its
      // output). The launch still went ahead, so say so rather than guess.
      inFlightGate = missingInFlightUpdateGateReport();
      log.warn("system live update launched without an in-flight gate report", {
        source: LOG_SOURCE,
        failureType: "live_update_gate_report_missing",
        instanceId: instance.id,
        userId: instance.user_id,
        trigger: initiator.trigger,
      });
    } else if (inFlightGate.verdict !== "idle") {
      // Proceeding while a turn may be running: the caller's deferral cap was
      // reached, the streak could not be recorded, or unhealthy-box recovery
      // went ahead on an unknown verdict. Loud, because it can interrupt a turn.
      log.warn("system live update proceeding past the in-flight gate", {
        source: LOG_SOURCE,
        failureType:
          inFlightGate.reason === "deferral_cap" ? "live_update_gate_cap_reached" : "live_update_gate_unverified",
        instanceId: instance.id,
        userId: instance.user_id,
        trigger: initiator.trigger,
        verdict: inFlightGate.verdict,
        gateReason: inFlightGate.reason,
        deferrals: inFlightGate.deferrals,
        streakSeconds: inFlightGate.streakSeconds,
      });
    }
  }

  // Mark as redeploying immediately so the UI shows progress. We MUST go
  // through buildInstanceLifecyclePatch so `lifecycle_state` flips to
  // "provisioning" alongside `status`; otherwise the recover-stuck-instances
  // cron (filtered by lifecycle_state) can't recover rows whose in-VM
  // success callback fails to land, and they sit at "redeploying" forever
  // (verified 2026-05-17 on 124 fleet-sync rows).
  //
  // Also stamp last_synced_at: the launch succeeded, so this VM is now on the
  // latest :stable image. The daily fleet-sync cron orders by this column
  // (NULLS FIRST) to advance to the next-oldest cohort each run; without the
  // bump every run would re-roll the same ~50 VMs and the fleet never
  // converges. Every applyLiveUpdate caller (fleet-sync, manual redeploy,
  // resize, recovery) recreates from :stable, so all of them advance the cursor.
  await supabaseAdmin
    .from("hermes_instances")
    .update({
      ...buildInstanceLifecyclePatch("redeploying"),
      // Never write null over a good gateway_url — a proxmox row whose safe
      // derivation failed (no subdomain, host env unresolved) must keep its
      // existing value, not get nulled out. This is the exact write that
      // poisoned 5 prod rows with https://10.250.20.1 on 2026-06-30/07-01.
      ...(gatewayUrl ? { gateway_url: gatewayUrl } : {}),
      last_synced_at: new Date().toISOString(),
    })
    .eq("id", instance.id);

  log.info("update launched in background", {
    source: LOG_SOURCE,
    instanceId: instance.id,
    userId: instance.user_id,
    pid: launchedPid(launchResult.stdout),
    initiator: initiator.kind,
    ...(isSystemLiveUpdate(initiator) ? { trigger: initiator.trigger } : {}),
    ...(inFlightGate ? { gateReason: inFlightGate.reason } : {}),
  });
  return { applied: true as const, initiator, inFlightGate };
}
