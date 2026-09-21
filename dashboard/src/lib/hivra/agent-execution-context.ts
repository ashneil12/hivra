import "server-only";

import {
  ProxmoxExecutionContextError,
  resolveSelfManagedProxmoxExecutionContext,
  type SelfManagedProxmoxExecutionContext,
} from "@/lib/infrastructure/proxmox-execution-context";
import {
  resolveProxmoxTargetConfiguration,
  runProxmoxHostScript,
  type HostScriptResult,
  type ProxmoxTargetConfiguration,
} from "@/lib/services/proxmox-instance-service";
import {
  SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL,
  hivraInfrastructureBindingTag,
  isHivraInfrastructureBindingTokenHash,
  type HivraAgentDeploymentMode,
} from "./agent-authority";
import {
  managedHivraProvisionerChannelConfiguration,
  persistedManagedHivraProvisionerChannel,
  type ManagedHivraProvisionerChannel,
} from "./managed-provisioner-channel";
import { resolveHivraProxmoxHost } from "./proxmox-target";
import { DEFAULT_PROXMOX_HOST_CAPACITY_POLICY } from "@/lib/infrastructure/host-capacity-policy";

type EnvLike = Record<string, string | undefined>;

export type HivraAgentInfrastructureBinding = {
  computer_substrate?: unknown;
  provider_capacity_order_id?: unknown;
  provider_enrollment_attempt_id?: unknown;
  provider_server_id?: unknown;
  deployment_mode?: unknown;
  proxmox_host?: unknown;
  infrastructure_connection_id?: unknown;
  deployment_target_id?: unknown;
  infrastructure_connection_revision?: unknown;
  infrastructure_binding_token_hash?: unknown;
  infrastructure_binding_token_enforced?: unknown;
  managed_provisioner_channel?: unknown;
};

type HivraAgentRuntimePaths = {
  provisionerDirectory: string;
  logDirectory: string;
  provisionLogPrefix: "hivra-prov-" | "provision-";
  startLogPrefix: "hivra-start-" | "start-";
  storage: string;
  vmSshKeyPath: string | null;
};

type ManagedHivraAgentExecutionContext = {
  kind: "managed";
  host: string;
  env: EnvLike;
  paths: HivraAgentRuntimePaths;
  provisionerChannel: ManagedHivraProvisionerChannel;
  infrastructureBindingTag: string;
  infrastructureBindingTagEnforced: boolean;
  capacityPolicy?: typeof DEFAULT_PROXMOX_HOST_CAPACITY_POLICY;
};

type SelfManagedHivraAgentExecutionContext = SelfManagedProxmoxExecutionContext & {
  host: string;
  paths: HivraAgentRuntimePaths;
  infrastructureBindingTag: string;
  infrastructureBindingTagEnforced: true;
};

export type HivraAgentExecutionContext =
  | ManagedHivraAgentExecutionContext
  | SelfManagedHivraAgentExecutionContext;

const RECOVERY_AUTHORITY_TIMEOUT_MS = 20_000;

/**
 * Prove that the exact owner-bound host credentials are currently usable
 * before a crash reconciler renews an abandoned provider-operation lease.
 * This command intentionally performs no provider read or mutation.
 */
export async function checkHivraAgentRecoveryAuthority(
  context: HivraAgentExecutionContext,
  runner: typeof runProxmoxHostScript = runProxmoxHostScript,
): Promise<HostScriptResult> {
  return runner(
    "set -eu\nprintf 'HIVRA_RECOVERY_AUTHORITY_READY\\n'",
    context.env,
    { timeoutMs: RECOVERY_AUTHORITY_TIMEOUT_MS },
  );
}

type Dependencies = {
  resolveManaged: (
    env: EnvLike,
    requestedTargetId?: string | null,
  ) => ProxmoxTargetConfiguration;
  resolveSelfManaged: typeof resolveSelfManagedProxmoxExecutionContext;
};

const defaultDependencies: Dependencies = {
  resolveManaged: resolveProxmoxTargetConfiguration,
  resolveSelfManaged: resolveSelfManagedProxmoxExecutionContext,
};

function boundString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Resolve the exact infrastructure identity persisted on an agent row.
 *
 * `deployment_mode` is the authority discriminator. Nullable binding presence
 * and host labels are never allowed to choose managed versus self-managed
 * credentials. Migration backfills every legacy row before this reader ships.
 */
async function resolveHivraAgentExecutionContextForPurpose(
  userId: string,
  agent: HivraAgentInfrastructureBinding,
  purpose: "lifecycle" | "teardown",
  dependencies: Partial<Dependencies> = {},
): Promise<HivraAgentExecutionContext> {
  // Schema-first provider reservations must never enter the Proxmox adapter,
  // including teardown/recovery where a null VMID means something different.
  // N-1 rows omit the discriminator; their existing mode checks remain below.
  if ((agent.computer_substrate != null && agent.computer_substrate !== "proxmox-kvm")
    || agent.provider_capacity_order_id != null || agent.provider_enrollment_attempt_id != null
    || agent.provider_server_id != null) {
    throw new ProxmoxExecutionContextError("binding_invalid");
  }
  const deps = { ...defaultDependencies, ...dependencies };
  const connectionId = boundString(agent.infrastructure_connection_id);
  const targetId = boundString(agent.deployment_target_id);
  const revision = agent.infrastructure_connection_revision;
  const mode = boundString(agent.deployment_mode) as HivraAgentDeploymentMode | null;
  const storedHost = boundString(agent.proxmox_host);
  const bindingTokenHash = agent.infrastructure_binding_token_hash;
  const bindingTagEnforced = agent.infrastructure_binding_token_enforced === true;
  const bindingPartsPresent = [connectionId, targetId, revision != null].filter(Boolean).length;
  const provisionerChannel = persistedManagedHivraProvisionerChannel(
    agent.managed_provisioner_channel,
  );
  if (!provisionerChannel) {
    throw new ProxmoxExecutionContextError("binding_invalid");
  }

  if (mode === "hivra-managed") {
    if (
      bindingPartsPresent !== 0 ||
      storedHost === SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL ||
      (provisionerChannel === "canary" && agent.computer_substrate !== "proxmox-kvm")
    ) {
      throw new ProxmoxExecutionContextError("binding_invalid");
    }
    if (!isHivraInfrastructureBindingTokenHash(bindingTokenHash)) {
      throw new ProxmoxExecutionContextError("binding_invalid");
    }
    const host = resolveHivraProxmoxHost(storedHost);
    const resolved = deps.resolveManaged(process.env, host);
    const runtimePaths = managedHivraProvisionerChannelConfiguration(provisionerChannel).runtime;
    return {
      kind: "managed",
      host,
      env: resolved.env,
      paths: {
        provisionerDirectory: runtimePaths.provisionerDirectory,
        logDirectory: runtimePaths.logDirectory,
        provisionLogPrefix: "hivra-prov-",
        startLogPrefix: "hivra-start-",
        storage: runtimePaths.storage,
        vmSshKeyPath: runtimePaths.vmSshKeyPath,
      },
      provisionerChannel,
      infrastructureBindingTag: hivraInfrastructureBindingTag(bindingTokenHash),
      infrastructureBindingTagEnforced: bindingTagEnforced,
      capacityPolicy: DEFAULT_PROXMOX_HOST_CAPACITY_POLICY,
    };
  }

  if (
    mode !== "self-managed" ||
    storedHost !== SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL ||
    bindingPartsPresent !== 3 ||
    !connectionId ||
    !targetId ||
    !Number.isSafeInteger(revision) ||
    Number(revision) < 1 ||
    !isHivraInfrastructureBindingTokenHash(bindingTokenHash) ||
    !bindingTagEnforced ||
    provisionerChannel !== "default"
  ) {
    throw new ProxmoxExecutionContextError("binding_invalid");
  }

  const resolved = await deps.resolveSelfManaged(userId, {
    connectionId,
    targetId,
    expectedConnectionRevision: Number(revision),
    purpose,
  });
  return {
    ...resolved,
    host: resolved.runtime.node,
    paths: {
      provisionerDirectory: resolved.runtime.provisionerDirectory,
      logDirectory: resolved.runtime.logDirectory,
      provisionLogPrefix: "provision-",
      startLogPrefix: "start-",
      storage: resolved.runtime.storage,
      vmSshKeyPath: resolved.runtime.vmSshKeyPath,
    },
    infrastructureBindingTag: hivraInfrastructureBindingTag(bindingTokenHash),
    infrastructureBindingTagEnforced: true,
  };
}

export async function resolveHivraAgentExecutionContext(
  userId: string,
  agent: HivraAgentInfrastructureBinding,
  dependencies: Partial<Dependencies> = {},
): Promise<HivraAgentExecutionContext> {
  return resolveHivraAgentExecutionContextForPurpose(
    userId,
    agent,
    "lifecycle",
    dependencies,
  );
}

export async function resolveHivraAgentTeardownExecutionContext(
  userId: string,
  agent: HivraAgentInfrastructureBinding,
  dependencies: Partial<Dependencies> = {},
): Promise<HivraAgentExecutionContext> {
  return resolveHivraAgentExecutionContextForPurpose(
    userId,
    agent,
    "teardown",
    dependencies,
  );
}

function checkedVmid(vmid: number): number {
  if (!Number.isSafeInteger(vmid) || vmid < 1) {
    throw new ProxmoxExecutionContextError("binding_invalid");
  }
  return vmid;
}

export function hivraAgentProvisionLogPath(
  context: HivraAgentExecutionContext,
  vmid: number,
): string {
  return `${context.paths.logDirectory}/${context.paths.provisionLogPrefix}${checkedVmid(vmid)}.log`;
}

export function hivraAgentStartLogPath(
  context: HivraAgentExecutionContext,
  vmid: number,
): string {
  return `${context.paths.logDirectory}/${context.paths.startLogPrefix}${checkedVmid(vmid)}.log`;
}

/**
 * The reviewed provisioner returns the freshly generated box credential through
 * a root-only, one-shot file. The receipt lives on persistent host storage so a
 * reboot between guest readiness and dashboard convergence cannot lose the only
 * copy of the bearer. It is removed immediately after a successful DB persist.
 * Legacy managed bundles may still include the bearer in their JSON result; the
 * poller tolerates an absent file and keeps that compatibility path intact.
 */
export function hivraAgentProvisionSecretPath(
  _context: HivraAgentExecutionContext,
  vmid: number,
): string {
  return `/var/lib/hivra/provision-results/${checkedVmid(vmid)}.secret`;
}

export function describeHivraAgentExecutionContextError(error: unknown): {
  status: number;
  message: string;
} | null {
  if (!(error instanceof ProxmoxExecutionContextError)) return null;

  if (error.code === "connection_not_found" || error.code === "target_not_found") {
    return { status: 404, message: "This agent's infrastructure target no longer exists." };
  }
  if (error.code === "connection_stale") {
    return {
      status: 409,
      message: "This agent's infrastructure connection changed. Check it again before controlling the agent.",
    };
  }
  if (error.code === "network_unavailable") {
    return { status: 503, message: "Hivra cannot currently reach this agent's infrastructure target." };
  }
  if (error.code === "credential_unavailable") {
    return {
      status: 409,
      message: "This agent's infrastructure credential must be replaced before it can be controlled.",
    };
  }
  if (error.code === "binding_invalid" || error.code === "target_mismatch") {
    return {
      status: 409,
      message: "This agent has an invalid infrastructure binding and cannot be controlled safely.",
    };
  }
  return {
    status: 409,
    message: "This agent's infrastructure target is not ready for lifecycle operations.",
  };
}
