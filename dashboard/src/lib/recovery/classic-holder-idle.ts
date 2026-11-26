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

const SOURCE = "classic-holder-idle";

type Claim = {
  id: string; owner: string; node: string; vmid: number; host_id: string | null;
  ipv4_address: string | null; gateway_url: string | null;
  infrastructure: unknown; generation: number; action: "nap" | "hibernate" | "wake";
};

export type ClassicHolderTransitionOutcome =
  | "unclaimed"
  | "deferred"
  | "awake"
  | "superseded"
  | "napping"
  | "hibernated"
  | "reservation_released"
  | "reservation_ineligible";

export type ClassicHolderSweepOutcomes = Partial<Record<ClassicHolderTransitionOutcome, number>>;

type ClaimResult =
  | { kind: "claim"; claim: Claim }
  | { kind: "outcome"; outcome: ClassicHolderTransitionOutcome };

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
  // Do not shorten this deadline for a deep save. A timeout only loses the
  // acknowledgement; it is never permission to disturb the per-VM flock or
  // systemd save unit, and the fenced finish still records uncertainty.
  const result = await runProxmoxHostScript(script, env, 315_000);
  if (!result.ok) return null;
  return claim.action === "wake" ? parseWakeReceipt(result.stdout, claim.vmid)
    : parseClassicHolderSleep(result.stdout, claim.vmid, claim.action);
}

async function claimClassicHolder(
  owner: { id: string; userId: string } | undefined,
  excludeHosts: readonly string[] = [],
): Promise<ClaimResult> {
  if (!supabaseAdmin) throw new Error("Database not configured");
  const { data, error } = await supabaseAdmin.rpc("claim_classic_holder_idle", {
    p_id: owner?.id ?? null, p_owner: owner?.userId ?? null,
    p_allow_sleep: process.env.HERMES_CLASSIC_HOLDER_SLEEP_ENABLED === "true",
    p_exclude_hosts: excludeHosts.length ? [...excludeHosts] : null,
  });
  if (error) throw new Error(error.message);
  if (!data) return { kind: "outcome", outcome: "unclaimed" };
  if (data.action === "skipped") return { kind: "outcome", outcome: "deferred" };
  if (data.action === "already_awake") return { kind: "outcome", outcome: "awake" };
  if (data.action === "reservation_released") return { kind: "outcome", outcome: "reservation_released" };
  if (data.action === "reservation_ineligible") return { kind: "outcome", outcome: "reservation_ineligible" };
  if (!["wake", "nap", "hibernate"].includes(data.action)
    || (owner && (data.owner !== owner.userId || data.id !== owner.id || data.action !== "wake"))) {
    throw new Error("Classic holder lifecycle claim did not match its owner or action");
  }
  return { kind: "claim", claim: data as Claim };
}

async function finishClaim(claim: Claim): Promise<ClassicHolderTransitionOutcome> {
  let receipt;
  let prepared;
  try {
    prepared = prepareClaim(claim);
    receipt = await runClaim(claim, prepared);
  } catch (err) {
    log.warn("Classic holder VM operation could not be confirmed", { source: SOURCE, instanceId: claim.id, action: claim.action }, err);
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
    source: SOURCE, instanceId: claim.id, action: claim.action, reason: receipt?.reason ?? "unconfirmed", state,
  });
  const finish = await supabaseAdmin!.rpc("finish_classic_holder_idle", {
    p_id: claim.id, p_generation: claim.generation, p_node: claim.node, p_vmid: claim.vmid, p_state: state,
  });
  if (finish.error) throw new Error(finish.error.message);
  if (!finish.data) return "superseded";
  return receipt?.ok && finish.data !== "retry" ? String(finish.data) as ClassicHolderTransitionOutcome : "deferred";
}

export async function transitionClassicHolder(owner?: { id: string; userId: string }) {
  const claimed = await claimClassicHolder(owner);
  if (claimed.kind === "outcome") return claimed.outcome;
  return finishClaim(claimed.claim);
}

/**
 * Run one fair Classic sweep. Claims are still taken in SQL order and remain
 * generation-fenced, but hosts already executing an operation are excluded
 * from subsequent claims. A slow save can therefore occupy its own host
 * without serially starving every other host; it is never cancelled merely to
 * make the loop look fair. At most one claimed operation per host is in flight
 * at a time, matching the host-safety rule used by the Hivra-agent sweep.
 */
export async function runClassicHolderSweep({
  claimBudgetMs = 45_000,
  maxClaims = 25,
}: { claimBudgetMs?: number; maxClaims?: number } = {}): Promise<ClassicHolderSweepOutcomes> {
  const deadline = Date.now() + claimBudgetMs;
  const outcomes: ClassicHolderSweepOutcomes = {};
  const busyHosts = new Set<string>();
  const running = new Set<Promise<void>>();
  let claims = 0;

  const record = (outcome: ClassicHolderTransitionOutcome) => {
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
  };

  try {
    while (claims < maxClaims && Date.now() < deadline) {
      const claimed = await claimClassicHolder(undefined, [...busyHosts]);
      if (claimed.kind === "outcome") {
        if (claimed.outcome === "unclaimed") break;
        record(claimed.outcome);
        continue;
      }
      claims += 1;
      const claim = claimed.claim;
      busyHosts.add(claim.node);
      const task = (async () => {
        try {
          record(await finishClaim(claim));
        } catch (err) {
          record("deferred");
          log.warn("Classic holder sweep operation failed before reconciliation", {
            source: SOURCE, instanceId: claim.id, action: claim.action,
          }, err);
        } finally {
          busyHosts.delete(claim.node);
        }
      })();
      running.add(task);
    }
  } finally {
    // Even when a later claim read fails, responses must not return before
    // these promises settle: a serverless freeze must not orphan the finish
    // RPC. The host transport itself is bounded above; we simply do not start
    // additional serial work behind it.
    if (running.size) await Promise.all([...running]);
  }
  return outcomes;
}
