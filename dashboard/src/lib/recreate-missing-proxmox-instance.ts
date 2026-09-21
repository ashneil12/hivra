/**
 * Recreate a Proxmox-backed instance whose VM is confirmed missing.
 *
 * Extracted from the `/api/cron/recreate-missing-proxmox-instance` route so it
 * can be driven both manually (the route, single `?id=`) and automatically by
 * the recover-missing-vm-instances sweep. The route stays a thin auth + map
 * wrapper; all the provisioning, stale-conflict recovery, and freshly-cloned-VM
 * rollback live here.
 *
 * "Confirmed missing" means a fleet-wide identity scan found no VM, or an
 * authoritative teardown marker records a completed rollback/reclaim.
 * We refuse otherwise, to avoid cloning a duplicate VM next to a live one.
 */

import { clerkClient } from "@clerk/nextjs/server";

import { encryptApiKey, decryptApiKey } from "@/lib/crypto";
import { buildInstanceLifecyclePatch } from "@/lib/instance-lifecycle";
import { isClearableStaleProxmoxMetadataRow } from "@/lib/proxmox-metadata-row";
import {
  extractGlobalHermesSettings,
  getRuntimeAgentSettings,
} from "@/lib/instance-settings";
import { log } from "@/lib/logger";
import { recoverProxmoxInstanceAcrossFleet } from "@/lib/recovery/recover-orphan-provisioning";
import {
  resolveDeploymentApiKey,
  resolveProviderDeploymentSecret,
  isCodexAuthProvider,
  isNousAuthProvider,
} from "@/lib/provider-deployment-auth";
import {
  getProxmoxHostRoutingConfigFromInfrastructure,
  resolveProxmoxLifecycleTarget,
  stripProxmoxInfrastructure,
  type ProxmoxHostRoutingConfig,
  type ProxmoxLifecycleRow,
} from "@/lib/services/proxmox-infrastructure";
import {
  deleteProxmoxInstance,
  getProxmoxInstanceStatus,
  provisionProxmoxInstance,
} from "@/lib/services/proxmox-instance-service";
import { getHonchoSettingsFromInstance } from "@/lib/services/instance-orchestrator";
import { supabaseAdmin } from "@/lib/supabase";
import type { CodexVaultBundle } from "@/lib/codex-oauth";
import type { NousVaultBundle } from "@/lib/nous-oauth";

const SOURCE = "recreate-missing-proxmox-instance";
const ROUTE = "/api/cron/recreate-missing-proxmox-instance";

export type InstanceRow = ProxmoxLifecycleRow & {
  id: string;
  user_id: string;
  name: string | null;
  provider: string;
  backend?: "gateway" | "webui" | null;
  subdomain?: string | null;
  api_key_encrypted: string | null;
  api_server_key_encrypted?: string | null;
  honcho_api_key_encrypted?: string | null;
  config?: Record<string, unknown> | null;
  status?: string | null;
  lifecycle_state?: string | null;
  cpu_limit?: number | null;
  ram_limit?: number | null;
  resource_tier?: string | null;
  proxmox_template_vmid?: number | null;
  updated_at: string;
};

type RecreateMetadataPayload = {
  infrastructure_provider: "proxmox";
  proxmox_node: string | null;
  proxmox_vmid: number | null;
  config: Record<string, unknown>;
  [key: string]: unknown;
};

type ProxmoxMetadataConflictRow = {
  id?: string | null;
  status?: string | null;
  lifecycle_state?: string | null;
  config?: Record<string, unknown> | null;
  proxmox_node?: string | null;
  proxmox_vmid?: number | null;
};

/**
 * Structured result the route maps to apiSuccess/apiError and the sweep maps to
 * recovered/failed counts. `httpStatus` mirrors what the route returned before
 * this was extracted, so the manual endpoint's contract is unchanged.
 */
export type RecreateMissingProxmoxResult =
  | {
      ok: true;
      instanceId: string;
      status: "provisioning";
      proxmoxVmid: number | null;
      proxmoxNode: string | null;
      gatewayUrl: string;
    }
  | {
      ok: false;
      httpStatus: number;
      message: string;
      failureType?: string;
      meta?: Record<string, unknown>;
    };

const INSTANCE_SELECT = [
  "id",
  "user_id",
  "name",
  "provider",
  "backend",
  "subdomain",
  "api_key_encrypted",
  "api_server_key_encrypted",
  "honcho_api_key_encrypted",
  "config",
  "status",
  "lifecycle_state",
  "cpu_limit",
  "ram_limit",
  "resource_tier",
  "infrastructure_provider",
  "host_id",
  "proxmox_node",
  "proxmox_vmid",
  "proxmox_template_vmid",
  "ipv4_address",
  "gateway_url",
  "updated_at",
].join(", ");

function hostRoutingFromRow(
  row: Pick<InstanceRow, "host_id" | "proxmox_node">,
  target: ReturnType<typeof resolveProxmoxLifecycleTarget>,
): ProxmoxHostRoutingConfig | null {
  const fromTarget = getProxmoxHostRoutingConfigFromInfrastructure(target, {
    host_id: row.host_id ?? null,
  });
  if (fromTarget) return fromTarget;

  const node = row.proxmox_node?.trim();
  if (!node) return null;
  const token = node.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return {
    hostSlug: node,
    envPrefix: `PROXMOX_${token}_`,
    failClosed: true,
  };
}

function configWithoutReleaseMarker(config: Record<string, unknown> | null | undefined) {
  const next =
    config && typeof config === "object" && !Array.isArray(config)
      ? { ...config }
      : {};
  delete next.infrastructureReleased;
  return next;
}

function isDuplicateProxmoxMetadataError(error: unknown): boolean {
  const raw = error as { code?: unknown; message?: unknown; details?: unknown } | null | undefined;
  if (raw?.code === "23505") return true;

  const text = [raw?.message, raw?.details]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();

  return Boolean(
    text &&
      (text.includes("proxmox_vmid") ||
        text.includes("proxmox_node") ||
        text.includes("ipv4_address") ||
        text.includes("gateway_url"))
  );
}

function describeDatabaseError(error: unknown): Record<string, unknown> {
  const raw = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown } | null | undefined;
  return {
    code: typeof raw?.code === "string" ? raw.code : null,
    message: typeof raw?.message === "string" ? raw.message : null,
    details: typeof raw?.details === "string" ? raw.details : null,
    hint: typeof raw?.hint === "string" ? raw.hint : null,
    type: error instanceof Error ? error.name : typeof error,
  };
}

async function recoverStaleRecreateMetadataConflict(params: {
  updatePayload: RecreateMetadataPayload;
  updateInstanceId: string;
  userId: string;
}): Promise<{ recovered: boolean; retryError?: unknown }> {
  const { updatePayload, updateInstanceId, userId } = params;
  if (!supabaseAdmin) return { recovered: false };
  if (
    updatePayload.infrastructure_provider !== "proxmox" ||
    !updatePayload.proxmox_node ||
    typeof updatePayload.proxmox_vmid !== "number"
  ) {
    return { recovered: false };
  }

  const { data: conflicts, error: conflictLookupError } = await supabaseAdmin
    .from("hermes_instances")
    .select("id,status,lifecycle_state,config,proxmox_node,proxmox_vmid")
    .eq("proxmox_node", updatePayload.proxmox_node)
    .eq("proxmox_vmid", updatePayload.proxmox_vmid)
    .neq("id", updateInstanceId)
    .limit(5);

  if (conflictLookupError) {
    log.error("failed to inspect stale Proxmox recreate metadata conflict", new Error("conflict_lookup_failed"), {
      source: SOURCE,
      route: ROUTE,
      method: "POST",
      failureType: "recreate_missing_proxmox_metadata_conflict_lookup_failed",
      instanceId: updateInstanceId,
      userId,
      proxmoxNode: updatePayload.proxmox_node,
      proxmoxVmid: updatePayload.proxmox_vmid,
      databaseError: describeDatabaseError(conflictLookupError),
    });
    return { recovered: false };
  }

  const staleConflict = ((conflicts ?? []) as ProxmoxMetadataConflictRow[])
    .find(isClearableStaleProxmoxMetadataRow);
  if (!staleConflict?.id) {
    log.error(
      "Proxmox recreate metadata conflict is not clearable",
      new Error("Active or unknown row already owns Proxmox VMID"),
      {
        source: SOURCE,
        route: ROUTE,
        method: "POST",
        failureType: "recreate_missing_proxmox_metadata_conflict_active",
        instanceId: updateInstanceId,
        userId,
        proxmoxNode: updatePayload.proxmox_node,
        proxmoxVmid: updatePayload.proxmox_vmid,
        conflictCount: conflicts?.length ?? 0,
        conflictStates: (conflicts ?? []).map((row) => ({
          id: row.id ?? null,
          status: row.status ?? null,
          lifecycleState: row.lifecycle_state ?? null,
        })),
      }
    );
    return { recovered: false };
  }

  const { error: clearError } = await supabaseAdmin
    .from("hermes_instances")
    .update({
      gateway_url: null,
      ipv4_address: null,
      proxmox_node: null,
      proxmox_vmid: null,
      proxmox_template_vmid: null,
      config: stripProxmoxInfrastructure(
        staleConflict.config,
        "post_provision_stale_conflict",
      ),
      updated_at: new Date().toISOString(),
    })
    .eq("id", staleConflict.id)
    .eq("proxmox_node", updatePayload.proxmox_node)
    .eq("proxmox_vmid", updatePayload.proxmox_vmid);

  if (clearError) {
    log.error("failed to clear stale Proxmox recreate metadata conflict", new Error("conflict_clear_failed"), {
      source: SOURCE,
      route: ROUTE,
      method: "POST",
      failureType: "recreate_missing_proxmox_metadata_conflict_clear_failed",
      instanceId: updateInstanceId,
      userId,
      staleInstanceId: staleConflict.id,
      proxmoxNode: updatePayload.proxmox_node,
      proxmoxVmid: updatePayload.proxmox_vmid,
      databaseError: describeDatabaseError(clearError),
    });
    return { recovered: false };
  }

  log.warn("cleared stale Proxmox recreate metadata conflict", {
    source: SOURCE,
    route: ROUTE,
    method: "POST",
    failureType: "recreate_missing_proxmox_metadata_conflict_cleared",
    instanceId: updateInstanceId,
    userId,
    staleInstanceId: staleConflict.id,
    proxmoxNode: updatePayload.proxmox_node,
    proxmoxVmid: updatePayload.proxmox_vmid,
  });

  const { error: retryError } = await supabaseAdmin
    .from("hermes_instances")
    .update({ ...updatePayload, updated_at: new Date().toISOString() })
    .eq("id", updateInstanceId);

  return { recovered: true, retryError };
}

async function markFailed(instanceId: string, config: Record<string, unknown>) {
  const now = new Date().toISOString();
  await supabaseAdmin!
    .from("hermes_instances")
    .update({
      ...buildInstanceLifecyclePatch("error", { now }),
      proxmox_vmid: null,
      config,
      updated_at: now,
    })
    .eq("id", instanceId);
}

/**
 * Recreate the instance's VM. Idempotent-ish: refuses (409) if the VM still
 * exists, so a double-fire can't clone a duplicate.
 */
export async function recreateMissingProxmoxInstanceById(
  instanceId: string,
): Promise<RecreateMissingProxmoxResult> {
  if (!supabaseAdmin) {
    return { ok: false, httpStatus: 500, message: "Database not configured" };
  }

  const { data: instance, error: fetchError } = await supabaseAdmin
    .from("hermes_instances")
    .select(INSTANCE_SELECT)
    .eq("id", instanceId)
    .maybeSingle<InstanceRow>();

  if (fetchError) {
    log.error("failed to load instance for Proxmox recreate", fetchError, {
      source: SOURCE,
      route: ROUTE,
      method: "POST",
      failureType: "recreate_missing_proxmox_fetch_failed",
      instanceId,
    });
    return { ok: false, httpStatus: 500, message: "Failed to load instance" };
  }
  if (!instance) return { ok: false, httpStatus: 404, message: "Instance not found" };
  if (instance.status === "deleted" || instance.lifecycle_state === "deleted") {
    return {
      ok: false,
      httpStatus: 409,
      message: "Deleted instances cannot be recreated",
      failureType: "recreate_missing_proxmox_deleted",
    };
  }
  if (instance.infrastructure_provider !== "proxmox") {
    return {
      ok: false,
      httpStatus: 409,
      message: "Instance is not Proxmox-backed",
      failureType: "recreate_missing_proxmox_wrong_provider",
    };
  }
  if (!instance.api_key_encrypted) {
    return {
      ok: false,
      httpStatus: 409,
      message: "Instance has no encrypted provider credential",
      failureType: "recreate_missing_proxmox_missing_provider_secret",
    };
  }

  const lifecycleTarget = resolveProxmoxLifecycleTarget(instance);
  const hostConfig = hostRoutingFromRow(instance, lifecycleTarget);

  let confirmedMissing = false;
  if (lifecycleTarget) {
    const proxmoxStatus = await getProxmoxInstanceStatus(lifecycleTarget, {
      hostConfig,
    });
    if (proxmoxStatus.vmMissing) {
    } else {
      return {
        ok: false,
        httpStatus: 409,
        message: "Refusing to recreate because the Proxmox VM still exists",
        failureType: "recreate_missing_proxmox_vm_exists",
        meta: { instanceStatus: proxmoxStatus.status },
      };
    }
  }

  // Release receipts are historical evidence, not a current absence check.
  // Always scan the full configured fleet immediately before cloning so a VM
  // moved or restored after the marker was written cannot be duplicated.
  const recovery = await recoverProxmoxInstanceAcrossFleet(instance);
  if (recovery.status === "recovered") {
    return {
      ok: false,
      httpStatus: 409,
      message: "Refusing to recreate because the VM was found and its routing was repaired",
      failureType: "recreate_missing_proxmox_vm_exists",
      meta: { instanceStatus: "running" },
    };
  }
  confirmedMissing = recovery.status === "gone";

  if (!confirmedMissing) {
    return {
      ok: false,
      httpStatus: 409,
      message: "Refusing to recreate without a confirmed missing VM",
      failureType: "recreate_missing_proxmox_not_confirmed_missing",
    };
  }

  const releasedConfig = lifecycleTarget
    ? stripProxmoxInfrastructure(instance.config, "vm_missing_across_fleet")
    : configWithoutReleaseMarker(instance.config);

  const now = new Date().toISOString();
  const { data: claimedRow, error: claimError } = await supabaseAdmin
    .from("hermes_instances")
    .update({
      ...buildInstanceLifecyclePatch("provisioning", { now }),
      proxmox_vmid: null,
      config: releasedConfig,
      updated_at: now,
    })
    .eq("id", instance.id)
    .eq("updated_at", instance.updated_at)
    .select("id")
    .maybeSingle();

  if (claimError || !claimedRow) {
    log.error("failed to mark missing Proxmox instance provisioning", claimError, {
      source: SOURCE,
      route: ROUTE,
      method: "POST",
      failureType: "recreate_missing_proxmox_claim_failed",
      instanceId: instance.id,
      userId: instance.user_id,
    });
    return {
      ok: false,
      httpStatus: claimError ? 500 : 409,
      message: claimError
        ? "Failed to reserve instance for recreation"
        : "Another lifecycle action changed this instance; recreation was not started",
      failureType: claimError
        ? "recreate_missing_proxmox_claim_failed"
        : "recreate_missing_proxmox_claim_conflict",
    };
  }

  let providerSecret: string;
  try {
    providerSecret = decryptApiKey(instance.api_key_encrypted);
  } catch (err) {
    await markFailed(instance.id, releasedConfig);
    log.error("failed to decrypt provider credential for Proxmox recreate", err, {
      source: SOURCE,
      route: ROUTE,
      method: "POST",
      failureType: "recreate_missing_proxmox_provider_decrypt_failed",
      instanceId: instance.id,
      userId: instance.user_id,
    });
    return { ok: false, httpStatus: 500, message: "Failed to decrypt provider credential" };
  }

  const providerDeploymentSecret = resolveProviderDeploymentSecret(
    instance.provider,
    providerSecret,
  );
  const deployApiKey = resolveDeploymentApiKey(
    providerSecret,
    providerDeploymentSecret,
  );

  let globalSettings: ReturnType<typeof extractGlobalHermesSettings> = {};
  try {
    const clerk = await clerkClient();
    const user = await clerk.users.getUser(instance.user_id);
    globalSettings = extractGlobalHermesSettings(user.publicMetadata);
  } catch (err) {
    log.warn("failed to load Clerk metadata during Proxmox recreate; using defaults", {
      source: SOURCE,
      route: ROUTE,
      method: "POST",
      failureType: "recreate_missing_proxmox_clerk_metadata_failed",
      instanceId: instance.id,
      userId: instance.user_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const model =
    typeof instance.config?.model === "string" && instance.config.model.trim()
      ? instance.config.model.trim()
      : "";

  const result = await provisionProxmoxInstance(
    {
      userId: instance.user_id,
      instanceId: instance.id,
      tier: instance.resource_tier ?? undefined,
      cpuLimit: instance.cpu_limit ?? 1,
      ramLimit: instance.ram_limit ?? 1024,
      name: instance.name || "Hermes Agent",
      provider: instance.provider,
      apiKey: deployApiKey,
      model,
      subdomain: instance.subdomain ?? null,
      codexAuthBundle: isCodexAuthProvider(instance.provider)
        ? (providerDeploymentSecret.authBundle as CodexVaultBundle | undefined)
        : undefined,
      nousAuthBundle: isNousAuthProvider(instance.provider)
        ? (providerDeploymentSecret.authBundle as NousVaultBundle | undefined)
        : undefined,
      honchoSettings: getHonchoSettingsFromInstance({
        id: instance.id,
        user_id: instance.user_id,
        provider: instance.provider,
        api_key_encrypted: instance.api_key_encrypted,
        honcho_api_key_encrypted: instance.honcho_api_key_encrypted ?? null,
        config: instance.config ?? undefined,
      }),
      agentSettings: getRuntimeAgentSettings(instance.config ?? undefined),
      globalSettings,
      backend: instance.backend ?? "gateway",
      // Clean-slate BYOK (deploy-card Managed=OFF), same contract the redeploy
      // path honours in instance-orchestrator.ts. Without this, recreating a
      // missing clean-slate VM seeds provider/model into the box's compose env
      // and config.yaml, which makes the agent's _has_any_provider_configured()
      // return true and suppresses its native onboarding overlay — leaving a
      // keyless provider configured and the box bricked on first message.
      // `provider`/`apiKey`/`model` above stay at their benign DB defaults and
      // go unused on this path, exactly as on the create path.
      unconfigured: instance.config?.unconfigured === true,
    },
    { hostConfig },
  );

  if (!result.ok) {
    await markFailed(instance.id, releasedConfig);
    log.error("Proxmox recreate provisioning failed", new Error(result.error), {
      source: SOURCE,
      route: ROUTE,
      method: "POST",
      failureType: "recreate_missing_proxmox_provision_failed",
      instanceId: instance.id,
      userId: instance.user_id,
    });
    return {
      ok: false,
      httpStatus: 502,
      message: "Proxmox recreate provisioning failed",
      failureType: "recreate_missing_proxmox_provision_failed",
    };
  }

  const finalConfig = configWithoutReleaseMarker(releasedConfig);
  if ("infrastructure" in result && result.infrastructure) {
    finalConfig.infrastructure = result.infrastructure;
  }

  const updatePayload: RecreateMetadataPayload = {
    ...buildInstanceLifecyclePatch("provisioning"),
    gateway_url: result.gatewayUrl,
    api_server_key_encrypted: encryptApiKey(result.apiServerKey),
    ipv4_address: result.ipv4,
    infrastructure_provider: "proxmox",
    proxmox_node:
      "infrastructure" in result && result.infrastructure?.provider === "proxmox"
        ? result.infrastructure.node ?? instance.proxmox_node ?? null
        : instance.proxmox_node ?? null,
    proxmox_vmid:
      "infrastructure" in result && result.infrastructure?.provider === "proxmox"
        ? result.infrastructure.vmid
        : null,
    proxmox_template_vmid:
      "infrastructure" in result &&
      result.infrastructure?.provider === "proxmox" &&
      typeof result.infrastructure.templateVmid === "number"
        ? result.infrastructure.templateVmid
        : instance.proxmox_template_vmid ?? null,
    config: finalConfig,
    updated_at: new Date().toISOString(),
  };

  const { error: firstUpdateError } = await supabaseAdmin
    .from("hermes_instances")
    .update(updatePayload)
    .eq("id", instance.id);
  let updateError: unknown = firstUpdateError;

  if (updateError) {
    if (isDuplicateProxmoxMetadataError(updateError)) {
      const recovery = await recoverStaleRecreateMetadataConflict({
        updatePayload,
        updateInstanceId: instance.id,
        userId: instance.user_id,
      });
      if (recovery.recovered) {
        updateError = recovery.retryError ?? null;
      }
    }
  }

  if (updateError) {
    // The clone succeeded but we can't persist the new vmid to the row.
    // Without destroying the freshly-cloned VM here, it sits on the host
    // running with no DB row pointing at it — observed 2026-05-18 on fixturenodea
    // where three duplicate VMs (744/745/746) for the same paused tenant
    // Duplicate rows can accumulate across cron retries, with each iteration
    // claiming a new VMID slot. Mirrors the post-provision rollback path
    // already in instance-service.ts. We only roll back when THIS run
    // actually allocated a VM, i.e. the result has proxmox infrastructure
    // populated.
    const rollbackInfra =
      "infrastructure" in result &&
      result.infrastructure?.provider === "proxmox" &&
      typeof result.infrastructure.vmid === "number"
        ? result.infrastructure
        : null;
    let rollbackOutcome: "deleted" | "skipped" | "failed" = "skipped";
    if (rollbackInfra) {
      try {
        const deleteResult = await deleteProxmoxInstance(rollbackInfra, {
          hostConfig,
          expectedInstanceId: instance.id,
        });
        if (deleteResult.ok) {
          rollbackOutcome = "deleted";
        } else {
          rollbackOutcome = "failed";
          log.error(
            "recreate cron rollback returned non-ok — orphan VM may exist",
            new Error(deleteResult.error || deleteResult.stderr || "deleteProxmoxInstance not ok"),
            {
              source: SOURCE,
              route: ROUTE,
              method: "POST",
              failureType: "recreate_missing_proxmox_rollback_failed",
              instanceId: instance.id,
              userId: instance.user_id,
              proxmoxVmid: rollbackInfra.vmid,
              proxmoxNode: rollbackInfra.node ?? null,
            },
          );
        }
      } catch (rollbackError) {
        rollbackOutcome = "failed";
        log.error("recreate cron rollback threw — orphan VM may exist", rollbackError, {
          source: SOURCE,
          route: ROUTE,
          method: "POST",
          failureType: "recreate_missing_proxmox_rollback_failed",
          instanceId: instance.id,
          userId: instance.user_id,
          proxmoxVmid: rollbackInfra.vmid,
          proxmoxNode: rollbackInfra.node ?? null,
        });
      }
    }

    await markFailed(instance.id, releasedConfig);
    log.error("failed to persist Proxmox recreate metadata", new Error("metadata_update_failed"), {
      source: SOURCE,
      route: ROUTE,
      method: "POST",
      failureType: "recreate_missing_proxmox_metadata_failed",
      instanceId: instance.id,
      userId: instance.user_id,
      proxmoxNode: updatePayload.proxmox_node,
      proxmoxVmid: updatePayload.proxmox_vmid,
      databaseError: describeDatabaseError(updateError),
      rollbackOutcome,
    });
    return { ok: false, httpStatus: 500, message: "Failed to persist recreated VM metadata" };
  }

  log.info("missing Proxmox instance recreated", {
    source: SOURCE,
    route: ROUTE,
    method: "POST",
    failureType: "recreate_missing_proxmox_recreated",
    instanceId: instance.id,
    userId: instance.user_id,
    proxmoxVmid: updatePayload.proxmox_vmid,
    proxmoxNode: updatePayload.proxmox_node,
    gatewayUrl: result.gatewayUrl,
  });

  return {
    ok: true,
    instanceId: instance.id,
    status: "provisioning",
    proxmoxVmid: (updatePayload.proxmox_vmid as number | null) ?? null,
    proxmoxNode: (updatePayload.proxmox_node as string | null) ?? null,
    gatewayUrl: result.gatewayUrl,
  };
}
