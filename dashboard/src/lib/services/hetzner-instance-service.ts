import { randomBytes } from "crypto";
import { createServer, deleteServer, getServer, mapHetznerStatus, waitForAction } from "@/lib/hetzner/client";
import type { CodexVaultBundle } from "@/lib/codex-oauth";
import type { NousVaultBundle } from "@/lib/nous-oauth";
import { redactSensitiveCommandOutput } from "@/lib/command-output-redaction";
import { log } from "@/lib/logger";
import type { InstanceBankrAgentConfig } from "@/lib/billing/bankr-instance-wallets";
import { isCodexAuthProvider } from "@/lib/provider-auth";
import { isOperatorosAgentImage } from "@/lib/operatoros-flavor";
import { resolvePersonaSoulFromSystemPrompt } from "@/lib/persona-souls-accessor";
import { isWebfreeBackend } from "@/lib/types/instance";

const LOG_SOURCE = "hetzner-instance-service";
import {
  agentPortsForBackend,
  buildAgentCaddyfile,
  buildAgentDeployScript,
  buildAutoUpdateTimerProvisioningScript,
  buildHermesEnvLines,
  buildHostCaddyfile,
  buildHostCaddyReloadScript,
  buildHonchoConfig,
  buildManagedEnvResetMap,
  buildProviderEnv,
  buildProviderEnvResetMap,
  getServerSpecs,
  pickServerType,
  PROVIDER_ID_MAP,
  renderCompressedProvisioningUserData,
  renderHostUserData,
  resolveGatewayConfiguration,
  type AgentSettings,
  type HonchoSettings,
} from "@/lib/services/hetzner-instance-builders";
import type { AutoUpdateConfig } from "@/lib/instance-settings";
import { resolveProviderBaseUrl } from "@/lib/services/provider-config";
import {
  buildWebUIBootstrapScript,
  buildWebUIProvisioningArtifacts,
} from "@/lib/services/webui-instance-builder";
import {
  getCloudflareDnsConfig,
  mintInstanceDns,
  removeInstanceDnsBestEffort,
} from "@/lib/services/cloudflare-dns";

export type ProvisionResult =
  | {
      ok: true;
      serverId: number;
      hostId?: string;
      ipv4: string;
      sshHostFingerprint?: string | null;
      apiServerKey: string;
      gatewayUrl: string;
      serverType: string;
    }
  | { ok: false; error: string };

export interface HetznerInstanceStatus {
  status: "provisioning" | "running" | "stopped" | "error" | "redeploying";
  ipv4?: string;
  backupsEnabled?: boolean;
}

export type InstanceBackend = "gateway" | "webui";

export {
  agentPortsForBackend,
  buildAgentCaddyfile,
  buildAgentDeployScript,
  buildAutoUpdateTimerProvisioningScript,
  buildHermesEnvLines,
  buildHostCaddyfile,
  buildHostCaddyReloadScript,
  buildHonchoConfig,
  buildManagedEnvResetMap,
  buildProviderEnv,
  buildProviderEnvResetMap,
  getServerSpecs,
  pickServerType,
  PROVIDER_ID_MAP,
  renderHostUserData,
  resolveGatewayConfiguration,
};

export type { AgentSettings, HonchoSettings };

function env(key: string, fallback: string): string {
  const v = process.env[key];
  return v && v.trim() ? v.trim() : fallback;
}

function getSshKeyId(): number[] {
  const raw = process.env.HETZNER_SSH_KEY_ID;
  if (!raw) return [];
  return raw.split(",").map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite);
}

const INITIAL_SSH_FINGERPRINT_CAPTURE_TIMEOUT_MS = 60_000;
const AGENT_DEPLOY_TIMEOUT_MS = 15 * 60_000;

function getSafeProvisioningFailureMessage(
  rawMessage: string,
  context: "existing-host" | "provisioning"
): string {
  const normalized = rawMessage.toLowerCase();
  if (
    normalized.includes("user_data length") &&
    normalized.includes("exceeds 32768 bytes")
  ) {
    return "Hetzner user_data length exceeds 32768 bytes.";
  }

  return context === "existing-host"
    ? "Failed to deploy to the existing host."
    : "Failed to provision the Hetzner instance.";
}

export async function provisionHetznerInstance(params: {
  userId: string;
  instanceId: string;
  hostId?: string;
  hostHetznerServerId?: number;
  hostIp?: string;
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
  autoUpdate?: AutoUpdateConfig;
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
}): Promise<ProvisionResult> {
  if (params.hostId && !params.hostIp) {
    const msg =
      `[hetzner] hostId "${params.hostId}" was provided but hostIp is missing. ` +
      `Refusing to create a new server — this would result in an unintended duplicate VM. ` +
      `Ensure the host's Hetzner server IP is resolvable before retrying.`;
    log.error("hostId provided without hostIp", new Error("missing hostIp for existing host"), {
      source: LOG_SOURCE,
      failureType: "missing_host_ip",
      instanceId: params.instanceId,
      userId: params.userId,
      hostId: params.hostId,
    });
    return { ok: false, error: msg };
  }

  const apiServerKey = randomBytes(32).toString("hex");
  const backend: InstanceBackend = params.backend === "webui" ? "webui" : "gateway";

  // ── Gateway DNS resolution ────────────────────────────────────────────
  // Two paths, decided by whether Cloudflare DNS is configured AND the
  // instance has a subdomain to mint:
  //
  //  - hermesos.cloud path: bake `<subdomain>.<dnsDomain>` into the agent
  //    script. For existing-host deploys, mint the A record up front so
  //    Caddy can ACME on first run; if mint fails we degrade to sslip
  //    rather than ship a broken instance. For new-host deploys, the IP
  //    isn't known until createServer returns, so we commit to the FQDN
  //    optimistically and mint after the server is created — a mint
  //    failure there throws into the existing rollback path so we don't
  //    leak a billable VM with no working URL.
  //
  //  - sslip path: same as before — `<dashed-ipv4>.sslip.io` with the
  //    `0-0-0-0.sslip.io` placeholder substituted at first boot. No DNS
  //    provisioning required.
  const cfConfig = getCloudflareDnsConfig();
  const useCloudflareDns = Boolean(cfConfig && params.subdomain);
  const cfDomain = useCloudflareDns ? cfConfig!.domain : null;

  // For existing-host deploys we know the IP and can mint up front so the
  // script is built with whichever FQDN actually points at this box.
  let mintedDnsForExistingHost = false;
  if (useCloudflareDns && params.hostId && params.hostIp) {
    const mint = await mintInstanceDns({
      subdomain: params.subdomain!,
      ip: params.hostIp,
      comment: `hermes instance ${params.instanceId}`,
    });
    if (mint.ok) {
      mintedDnsForExistingHost = true;
    } else {
      log.warn("cloudflare DNS mint failed for existing-host deploy; falling back to sslip", {
        source: LOG_SOURCE,
        instanceId: params.instanceId,
        userId: params.userId,
        hostId: params.hostId,
        failureType: "cloudflare_dns_mint_failed",
        redactedError: redactSensitiveCommandOutput(mint.error ?? "", 600),
      });
    }
  }

  const gatewayConfig = resolveGatewayConfiguration({
    subdomain: params.subdomain,
    ipv4: params.hostIp || "0.0.0.0",
    dnsDomain:
      // Existing-host: only use Cloudflare FQDN if mint actually succeeded.
      // New-host: commit to Cloudflare FQDN optimistically — we'll mint
      // post-createServer and roll back on failure.
      params.hostId && params.hostIp
        ? mintedDnsForExistingHost
          ? cfDomain
          : null
        : cfDomain,
  });

  const containerName = `agent-${params.instanceId}`;
  let agentScript: string;
  if (isWebfreeBackend(backend)) {
    const inferenceProvider =
      params.provider === "custom_llm"
        ? "custom"
        : PROVIDER_ID_MAP[params.provider] ?? params.provider;
    const webUIParams = {
      instanceId: params.instanceId,
      containerName,
      fqdn: gatewayConfig.fqdn,
      cpuLimit: params.cpuLimit,
      ramLimit: params.ramLimit,
      llmApiKey: params.apiKey,
      inferenceProvider,
      defaultModel: params.model,
      dashboardProvider: params.provider,
      baseUrl:
        resolveProviderBaseUrl(params.provider, params.agentSettings?.customLlmBaseUrl, params.apiKey) ??
        undefined,
      // Auxiliary compression model + context engine (empty = inherit main /
      // agent default). Builder emits auxiliary.compression.{provider,model} and
      // context.engine into config.yaml when set.
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
      // A new direct Hetzner server is a customer-dedicated VM. Existing-host
      // deployments can contain sibling tenants, so they must never inherit
      // the host Docker socket even if stale settings request root access.
      gatewayDockerAccess:
        !params.hostId && params.agentSettings?.enableRootAccess === true,
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
      // Agent image override (e.g. operatoros-agent:stable for Operator OS).
      // Passed as 'agentImage' which resolveWebUIAgentImage checks FIRST.
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
    agentScript = buildWebUIBootstrapScript(artifacts, webUIParams, {
      includeHostTimeSyncRepair: Boolean(params.hostId && params.hostIp),
      additionalProvisioningScript: buildAutoUpdateTimerProvisioningScript({
        instanceId: params.instanceId,
        containerName,
        autoUpdate: params.autoUpdate,
        apiServerKey,
        dashboardUrl: params.globalSettings?.dashboardUrl,
        backend: "webui",
        includeHostTimeSyncInstallFallback: false,
      }),
    });
  } else {
    agentScript = buildAgentDeployScript({
      instanceId: params.instanceId,
      containerName,
      apiServerKey,
      provider: params.provider,
      apiKey: params.apiKey,
      model: params.model,
      bankr: params.bankr,
      fqdn: gatewayConfig.fqdn,
      cpuLimit: params.cpuLimit,
      ramLimit: params.ramLimit,
      migrationUrl: params.migrationUrl,
      codexAuthBundle: params.codexAuthBundle,
      nousAuthBundle: params.nousAuthBundle,
      honchoSettings: params.honchoSettings,
      agentSettings: params.agentSettings,
      autoUpdate: params.autoUpdate,
      globalSettings: params.globalSettings,
      includeHostTimeSyncRepair: Boolean(params.hostId && params.hostIp),
      // An existing host receives the script uncompressed over SSH; a new
      // server receives it inside renderCompressedProvisioningUserData.
      embeddedFileEncoding: params.hostId && params.hostIp ? "gzip-base64" : "heredoc",
    });
  }

  if (params.hostId && params.hostIp) {
    try {
      log.info("deploying agent to existing host", {
        source: LOG_SOURCE,
        instanceId: params.instanceId,
        userId: params.userId,
        hostId: params.hostId,
      });

      const { sshExec } = await import("@/lib/hetzner/ssh");
      const deploymentTimeoutMs = isWebfreeBackend(backend) ? 8 * 60_000 : AGENT_DEPLOY_TIMEOUT_MS;
      const res = await sshExec(params.hostIp, agentScript, { timeoutMs: deploymentTimeoutMs });
      if (!res.ok) {
        throw new Error(`SSH deployment failed: ${res.error || res.stderr}`);
      }

      return {
        ok: true,
        serverId: params.hostHetznerServerId || 0,
        hostId: params.hostId,
        ipv4: params.hostIp,
        sshHostFingerprint: null,
        apiServerKey,
        gatewayUrl: gatewayConfig.gatewayUrl,
        serverType: pickServerType(params.tier, params.userId),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("existing host deployment failed", err, {
        source: LOG_SOURCE,
        failureType: "existing_host_deployment_failed",
        instanceId: params.instanceId,
        userId: params.userId,
        hostId: params.hostId,
        redactedMessage: redactSensitiveCommandOutput(msg, 600),
      });
      if (mintedDnsForExistingHost) {
        // Helper is contracted not to throw — don't re-throw and mask the
        // deployment error that brought us here.
        await removeInstanceDnsBestEffort(params.subdomain, {
          source: LOG_SOURCE,
          instanceId: params.instanceId,
          userId: params.userId,
          hostId: params.hostId,
        });
      }
      return {
        ok: false,
        error: getSafeProvisioningFailureMessage(msg, "existing-host"),
      };
    }
  }

  const location = env("HETZNER_LOCATION", "nbg1");
  const serverType = pickServerType(params.tier, params.userId);
  const sshKeys = getSshKeyId();
  const hostUserData = renderCompressedProvisioningUserData(renderHostUserData(), agentScript);

  let serverId: number | null = null;

  try {
    log.info("creating hetzner server", {
      source: LOG_SOURCE,
      instanceId: params.instanceId,
      userId: params.userId,
      serverType,
      location,
      name: params.name,
    });

    const res = await createServer({
      name: `host-${randomBytes(4).toString("hex")}`,
      server_type: serverType,
      image: "ubuntu-22.04",
      location,
      user_data: hostUserData,
      ssh_keys: sshKeys,
      labels: { app: "hermes-deploy" },
      backups: true,
    });

    serverId = res.server.id;
    const ipv4 = res.server.public_net.ipv4?.ip || "";

    log.info("hetzner server created", {
      source: LOG_SOURCE,
      instanceId: params.instanceId,
      userId: params.userId,
      hetznerServerId: serverId,
      ipv4,
    });

    await waitForAction(res.action.id);
    let sshHostFingerprint: string | null = null;
    if (ipv4) {
      try {
        const { captureHostFingerprint } = await import("@/lib/hetzner/ssh");
        sshHostFingerprint = await captureHostFingerprint(ipv4, INITIAL_SSH_FINGERPRINT_CAPTURE_TIMEOUT_MS);
      } catch (fingerprintErr) {
        const msg =
          fingerprintErr instanceof Error ? fingerprintErr.message : String(fingerprintErr);
        log.warn("could not capture SSH host fingerprint", {
          source: LOG_SOURCE,
          failureType: "ssh_fingerprint_capture_failed",
          instanceId: params.instanceId,
          userId: params.userId,
          hetznerServerId: serverId,
          ipv4,
          redactedMessage: redactSensitiveCommandOutput(msg, 600),
        }, fingerprintErr);
      }
    }

    // We optimistically baked the hermesos.cloud FQDN into the cloud-init
    // user_data above. Now that the IP is known, mint the matching A
    // record so Caddy can ACME on first run. A mint failure here is the
    // 2026-04-30 bug class — throw so the existing rollback below deletes
    // the server rather than orphaning a billable VM with a URL that
    // resolves to NXDOMAIN.
    if (useCloudflareDns && ipv4 && params.subdomain) {
      const mint = await mintInstanceDns({
        subdomain: params.subdomain,
        ip: ipv4,
        comment: `hermes instance ${params.instanceId}`,
      });
      if (!mint.ok) {
        throw new Error(`Cloudflare DNS minting failed: ${mint.error ?? "unknown"}`);
      }
    }

    const { gatewayUrl } = resolveGatewayConfiguration({
      subdomain: params.subdomain,
      ipv4,
      dnsDomain: cfDomain,
    });

    return {
      ok: true,
      serverId,
      ipv4,
      sshHostFingerprint,
      apiServerKey,
      gatewayUrl,
      serverType,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("provisioning failed", err, {
      source: LOG_SOURCE,
      failureType: "provisioning_failed",
      instanceId: params.instanceId,
      userId: params.userId,
      hetznerServerId: serverId,
      redactedMessage: redactSensitiveCommandOutput(msg, 600),
    });

    if (serverId !== null) {
      try {
        await deleteServer(serverId);
        log.info("rolled back hetzner server", {
          source: LOG_SOURCE,
          instanceId: params.instanceId,
          userId: params.userId,
          hetznerServerId: serverId,
        });
      } catch (rollbackErr) {
        const rollbackMessage =
          rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        log.error("rollback failed for hetzner server", rollbackErr, {
          source: LOG_SOURCE,
          failureType: "rollback_failed",
          instanceId: params.instanceId,
          userId: params.userId,
          hetznerServerId: serverId,
          redactedMessage: redactSensitiveCommandOutput(rollbackMessage, 600),
        });
      }
    }

    if (useCloudflareDns) {
      // Best-effort: drop the A record so the next provision attempt
      // starts from a clean slate. If the record was never created (e.g.
      // failure before mint), the helper is a no-op.
      await removeInstanceDnsBestEffort(params.subdomain, {
        source: LOG_SOURCE,
        instanceId: params.instanceId,
        userId: params.userId,
      });
    }

    return {
      ok: false,
      error: getSafeProvisioningFailureMessage(msg, "provisioning"),
    };
  }
}

export async function getHetznerInstanceStatus(
  serverId: number
): Promise<HetznerInstanceStatus> {
  try {
    const { server } = await getServer(serverId);
    return {
      status: mapHetznerStatus(server.status),
      ipv4: server.public_net.ipv4?.ip || undefined,
      backupsEnabled: !!server.backup_window,
    };
  } catch {
    return { status: "error" };
  }
}

export { deleteServer as deleteHetznerServer };
