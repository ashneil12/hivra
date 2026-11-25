import "server-only";

import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import {
  getProxmoxHostRoutingConfigFromInfrastructure, resolveProxmoxHostEnv,
  runProxmoxHostScript,
} from "@/lib/services/proxmox-instance-service";
import { buildClassicHolderPowerScript, parseClassicHolderSleep, parseWakeReceipt } from "@/lib/hivra/agent-sleep-scripts";
import { resolveProxmoxLifecycleTarget } from "@/lib/services/proxmox-infrastructure";
import { DEFAULT_PROXMOX_HOST_CAPACITY_POLICY } from "@/lib/infrastructure/host-capacity-policy";
import { managedHivraProvisionerChannelConfiguration, managedHivraProvisionerChannelForServerEnvironment } from "@/lib/hivra/managed-provisioner-channel";

type Claim = {
  id: string; owner: string; node: string; vmid: number; host_id: string | null;
  ipv4_address: string | null; gateway_url: string | null;
  infrastructure: unknown; generation: number; action: "nap" | "hibernate" | "wake";
};

function prepareClaim(claim: Claim) {
  const infra = resolveProxmoxLifecycleTarget({
    config: { infrastructure: claim.infrastructure }, proxmox_node: claim.node, proxmox_vmid: claim.vmid,
    ipv4_address: claim.ipv4_address, gateway_url: claim.gateway_url,
  });
  if (!infra || infra.vmid !== claim.vmid || (infra.hostSlug ?? infra.node) !== claim.node) {
    throw new Error("Classic host coordinates disagree");
  }
  const routing = getProxmoxHostRoutingConfigFromInfrastructure(infra, claim);
  if (!routing) throw new Error("Classic host routing is missing");
  const env = resolveProxmoxHostEnv(routing, process.env);
  const policy = DEFAULT_PROXMOX_HOST_CAPACITY_POLICY;
  const paths = managedHivraProvisionerChannelConfiguration(managedHivraProvisionerChannelForServerEnvironment(process.env)).runtime;
  const script = buildClassicHolderPowerScript({
    ...claim, privateIpv4: infra.privateIpv4, gatewayHost: infra.gatewayHost,
    sitesDirectory: env.PROXMOX_CADDY_SITES_DIR || "/etc/caddy/hermes.d",
    admission: {
      provisionerDirectory: paths.provisionerDirectory, hostReserveMb: policy.hostMemoryReserveMb,
      enforceCeilings: policy.mode === "enforce", cpuDensityMilli: policy.cpuCeilingDensity * 1000,
      memoryDensityMilli: policy.memoryCeilingDensity * 1000,
    },
  });
  return { script, env };
}

async function runClaim(claim: Claim, { script, env }: ReturnType<typeof prepareClaim>) {
  const result = await runProxmoxHostScript(script, env, 315_000);
  if (!result.ok) return null;
  return claim.action === "wake" ? parseWakeReceipt(result.stdout, claim.vmid)
    : parseClassicHolderSleep(result.stdout, claim.vmid, claim.action);
}

export async function transitionClassicHolder(owner?: { id: string; userId: string }) {
  if (!supabaseAdmin) throw new Error("Database not configured");
  const { data, error } = await supabaseAdmin.rpc("claim_classic_holder_idle", {
    p_id: owner?.id ?? null, p_owner: owner?.userId ?? null,
    p_allow_sleep: process.env.HERMES_CLASSIC_HOLDER_SLEEP_ENABLED === "true",
  });
  if (error) throw new Error(error.message);
  if (!data) return "unclaimed";
  if (data.action === "skipped") return "deferred";
  if (data.action === "already_awake") return "awake";
  const claim = data as Claim;
  let receipt;
  let prepared;
  try {
    prepared = prepareClaim(claim);
    receipt = await runClaim(claim, prepared);
  } catch (err) {
    log.warn("Classic holder VM operation could not be confirmed", { source: "classic-holder-idle", instanceId: claim.id, action: claim.action }, err);
  }
  // A lost reply may mean the host completed the operation. Keep the owner
  // wake route available and account for full compute until positively saved.
  let state = "retry";
  if (!prepared && claim.action !== "wake") state = claim.action === "nap" ? "awake" : "napping";
  else if (receipt?.ok) state = receipt.to;
  else if (claim.action !== "wake" && receipt?.to === "awake") state = "awake";
  else if (claim.action === "wake" && receipt?.reason === "capacity" && receipt.to === "hibernated") state = "hibernated";
  else if (claim.action === "hibernate" && receipt?.to === "napping") state = "napping";
  else if (claim.action === "nap" && receipt && ["binding_mismatch", "unreachable", "fence_failed"].includes(receipt.reason)) state = "awake";
  if (!receipt?.ok) log.warn("Classic holder power transition deferred", {
    source: "classic-holder-idle", instanceId: claim.id, action: claim.action, reason: receipt?.reason ?? "unconfirmed", state,
  });
  const finish = await supabaseAdmin.rpc("finish_classic_holder_idle", {
    p_id: claim.id, p_generation: claim.generation, p_node: claim.node, p_vmid: claim.vmid, p_state: state,
  });
  if (finish.error) throw new Error(finish.error.message);
  if (!finish.data) return "superseded";
  return receipt?.ok && finish.data !== "retry" ? String(finish.data) : "deferred";
}
