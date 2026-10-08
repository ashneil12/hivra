// Hermes-lane plumbing shared by /api/instances/[id]/bankr-wallet and its
// ./connect route. A Hermes agent gets its wallet key in the config YAML via
// the running-agent config API; the config is always rebuilt from the wallet
// row, so a row that is no longer active removes the key.

import type { HermesInstanceRow } from "@/app/api/instances/[id]/route";
import { agentWebApi } from "@/lib/agent-web-api";
import { putHermesConfigWithBindMountFallback } from "@/lib/hermes-config-write";
import { resolveHermesHomeDirFromConfig } from "@/lib/hermes-home";
import { resolveInstanceIpv4 } from "@/lib/instance-resolvers";
import { sanitizeDockerName } from "@/lib/services/profile-service";
import { supabaseAdmin } from "@/lib/supabase";
import { isWebfreeBackend } from "@/lib/types/instance";
import { getHermesGuestSshTarget } from "@/lib/services/proxmox-infrastructure";

function asConfig(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function loadOwnedHermesInstance(instanceId: string, userId: string): Promise<HermesInstanceRow | null> {
  if (!supabaseAdmin) return null;

  const { data, error } = await supabaseAdmin
    .from("hermes_instances")
    .select(
      [
        "id",
        "user_id",
        "name",
        "status",
        "backend",
        "provider",
        "subdomain",
        "hetzner_server_id",
        "gateway_url",
        "api_key_encrypted",
        "api_key_preview",
        "api_server_key_encrypted",
        "honcho_api_key_encrypted",
        "config",
        "host_id",
        "ipv4_address",
        "cpu_limit",
        "ram_limit",
        "infrastructure_provider",
        "proxmox_vmid",
        "lifecycle_state",
        "created_at",
        "updated_at",
      ].join(",")
    )
    .eq("id", instanceId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error("Failed to verify instance ownership");
  }

  return data ? (data as unknown as HermesInstanceRow) : null;
}

/**
 * Rewrite a running Hermes agent's config from the current wallet row. An
 * active row adds the `bankr:` section; any other state leaves it out
 * (buildHermesConfigWithInstanceBankrWallet), which is how a disconnect
 * reaches the agent. Webfree boxes pick the change up on their next runtime
 * update instead.
 */
export async function syncBankrConfigToRunningHermesInstance(
  instance: HermesInstanceRow,
  userId: string
): Promise<"synced" | "skipped"> {
  if (instance.status !== "running" || isWebfreeBackend(instance.backend)) {
    return "skipped";
  }

  const config = asConfig(instance.config);
  const ip = await resolveInstanceIpv4(instance);
  if (!ip) {
    throw new Error("Server has no public IPv4");
  }

  await putHermesConfigWithBindMountFallback({
    api: await agentWebApi(instance.id, userId),
    config,
    containerName: `agent-${sanitizeDockerName(instance.id)}`,
    hermesHomeDir: resolveHermesHomeDirFromConfig(config),
    ip,
    guestTarget: getHermesGuestSshTarget(instance),
    instanceId: instance.id,
    userId,
  });

  return "synced";
}
