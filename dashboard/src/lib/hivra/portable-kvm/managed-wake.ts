import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import { getTunnelConfig, listTunnelConnections } from "@/lib/services/cloudflare-tunnel";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { supabaseAdmin } from "@/lib/supabase";
import { resolveHivraLifecycleTarget } from "../agent-lifecycle-host";
import { isCanonicalGitCanaryDeployment } from "../canonical-git-canary";
import { isStartBlockedForLapse } from "../lapse-gate";
import { shellQuote } from "../proxmox-target";
import { advancePortableKvmSourceCheckpoint, portableKvmCheckpointPassword } from "./checkpoint";
import {
  bootPortableKvmDestination, enablePortableKvmDestinationNetwork, releasePortableKvmDestinationLock, serializePortableKvmDestinationBootProfile,
  verifyPortableKvmQuarantinedDestination, type PortableKvmDestinationBootAdapter,
} from "./destination-boot";
import { serializePortableKvmDestinationReservation } from "./destination-disk";
import { dispatchPortableKvmDestinationJob, pollPortableKvmDestinationJob } from "./destination-job";
import {
  buildPortableKvmDestinationPrepareScript, buildPortableKvmHostCpuCompatibilityProbeScript, parsePortableKvmDestinationPrepareReceipt,
  portableKvmManagedDestinationProfileSchema, portableKvmUnicastMacAddress, type PortableKvmDestinationPrepareInput,
} from "./destination-prepare";
import { advancePortableKvmIdleHandoff, requestPortableKvmOwnerWake, type PortableKvmCheckpointReceipt, type PortableKvmHandoff } from "./handoff";
import { isPortableKvmReadyToCheckpoint, isPortableKvmWakeClaimed, type PortableKvmPlacement } from "./pilot";
import { buildPortableKvmSlotClaimScript } from "./slot-claim";
import { buildPortableKvmSourceFenceScript, parsePortableKvmSourceFence } from "./source-fence";
import { buildPortableKvmSourceProfileCheck, isPortableKvmSourceProfileEligible } from "./source-profile";

const hostProfile = z.object({
  storageId: z.string().min(1), volumeGroup: z.string().min(1), thinPool: z.string().min(1),
  bridge: z.string().regex(/^(?:hivra0|vmbr[0-9]{1,4})$/),
}).strict();
const profileSchema = z.object({
  machine: z.string().regex(/^pc-i440fx-[0-9]+\.[0-9]+(?:\.[0-9]+)?(?:\+pve[0-9]+)?$/),
  machineId: z.string().regex(/^[a-f0-9]{32}$/).refine(id => !/^0+$/.test(id)),
  macAddress: portableKvmUnicastMacAddress,
  attachment: z.object({ discard: z.boolean(), ssd: z.boolean(), ioThread: z.boolean() }).strict(),
  managed: portableKvmManagedDestinationProfileSchema,
  hosts: z.record(z.string(), hostProfile),
}).strict();

function pilotProfile(agent: Record<string, unknown>, placement: PortableKvmPlacement) {
  const config = profileSchema.parse(JSON.parse(process.env.HIVRA_KVM_PORTABLE_QA_PROFILE ?? ""));
  const host = config.hosts[placement.hostId];
  const cores = z.number().int().min(1).max(8).parse(agent.cpu);
  const memoryMb = z.number().int().min(1024).max(16384).parse(Number(agent.ram) * 1024);
  if (!Object.hasOwn(config.hosts, placement.hostId) || !host) throw new Error("Portable KVM host profile is missing");
  const { bridge, ...storage } = host;
  return { storage, machineId: config.machineId, profile: {
    machine: config.machine, cores, memoryMb,
    attachment: config.attachment, network: { bridge, macAddress: config.macAddress }, managed: config.managed,
  } };
}

async function pinnedTarget(ownerId: string, agent: Record<string, unknown>, placement: PortableKvmPlacement, preflight = false) {
  const result = await resolveHivraLifecycleTarget({ userId: ownerId,
    agent: { ...agent, proxmox_host: placement.hostId, vmid: placement.vmid, ip: placement.ip },
    action: preflight ? "portable_kvm_preflight" : "stop",
  });
  if (!result.ok || result.target.executionContext.kind !== "managed" || result.target.executionContext.host !== placement.hostId
    || result.target.vmid !== placement.vmid || result.target.bindingTag !== placement.bindingTag
    || `${result.target.subnetPrefix}.${result.target.octet}` !== placement.ip) throw new Error("Portable KVM host authority changed");
  return result.target;
}

function destinationPlan(agent: Record<string, unknown>, lease: PortableKvmHandoff, disk: PortableKvmCheckpointReceipt["disk"]):
  PortableKvmDestinationPrepareInput {
  const { storage, profile } = pilotProfile(agent, lease.destination);
  if (!lease.checkpoint_sha256) throw new Error("Portable KVM checkpoint authority is missing");
  return { ...lease.destination, ...storage, profile, disk, agentId: lease.agent_id, operationId: lease.operation_id,
    generation: lease.generation, checkpointSha256: lease.checkpoint_sha256, expiresAt: new Date(lease.expires_at).toISOString() };
}

async function readReservation(plan: PortableKvmDestinationPrepareInput, env: Record<string, string | undefined>) {
  const file = `/var/lib/hivra-sleep/portable-kvm-destinations/${plan.vmid}`;
  const result = await runProxmoxHostScript(`set -eu
[ "$(hostname -s)" = ${shellQuote(plan.hostId)} ]
ROOT=/var/lib/hivra-sleep
DIR="$ROOT/portable-kvm-destinations"
FILE=${shellQuote(file)}
[ -d "$ROOT" ] && [ ! -L "$ROOT" ]
case "$(stat -c '%u:%a' "$ROOT")" in 0:700|0:755) ;; *) exit 1 ;; esac
[ -d "$DIR" ] && [ ! -L "$DIR" ] && [ "$(stat -c '%u:%a' "$DIR")" = 0:700 ]
[ -f "$FILE" ] && [ ! -L "$FILE" ] && [ "$(stat -c '%u:%a:%h' "$FILE")" = 0:600:1 ]
[ "$(stat -c %s "$FILE")" -le 4096 ]
printf 'HIVRA_KVM_PORTABLE_PREPARE_V1 '
cat -- "$FILE"
`, env, 15_000);
  return result.ok ? parsePortableKvmDestinationPrepareReceipt(result.stdout, plan) : null;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

async function rpc(name: string, params: Record<string, unknown>) {
  if (!supabaseAdmin) throw new Error("Portable KVM journal unavailable");
  const { data, error } = await supabaseAdmin.rpc(name, params);
  if (error) throw new Error("Portable KVM journal operation failed");
  return data as unknown;
}

export function requestManagedPortableKvmOwnerWake(ownerId: string, agent: Record<string, unknown>) {
  return requestPortableKvmOwnerWake(ownerId, agent, rpc);
}

export async function resumeManagedPortableKvmOwnerWake(options: { ownerId?: string; deadline?: number } = {}) {
  if (!isCanonicalGitCanaryDeployment() || process.env.HIVRA_KVM_PORTABLE_QA_ENABLED !== "true") return;
  const owner = process.env.HIVRA_KVM_PORTABLE_QA_OWNER_ID;
  const id = z.string().uuid().safeParse(process.env.HIVRA_KVM_PORTABLE_QA_AGENT_ID);
  if (!supabaseAdmin || !owner || !id.success) throw new Error("Portable KVM pilot is not configured");
  if (options.ownerId && options.ownerId !== owner) return;
  const deadline = options.deadline ?? Date.now() + 275_000;
  for (let step = 0; step < 8 && Date.now() + 10_000 < deadline; step++) {
    const { data, error } = await supabaseAdmin.from("hivra_agents").select("*").eq("id", id.data).eq("user_id", owner).maybeSingle();
    if (error) throw new Error("Portable KVM owner wake lookup failed");
    if (!data || !(isPortableKvmWakeClaimed(data) || (!options.ownerId && isPortableKvmReadyToCheckpoint(data)))
      || await isStartBlockedForLapse(data, "start")) return;
    const result = await advanceManagedPortableKvmHandoff(owner, data, { restoreOnly: !!options.ownerId, deadline });
    if (result?.state === "failed") throw new Error("Portable KVM wake lease needs operator reconciliation");
    if (!result?.progressed) return;
  }
}

function advanceManagedPortableKvmHandoff(ownerId: string, agent: Record<string, unknown>, options: { restoreOnly: boolean; deadline: number }) {
  async function connectors() {
    const id = z.string().uuid().parse(agent.cf_tunnel_id);
    return (await listTunnelConnections(id)).filter(connector => connector.connections > 0);
  }

  async function destination(lease: PortableKvmHandoff, prepare: boolean) {
    if (!lease.storage_evidence) throw new Error("Portable KVM storage evidence is missing");
    const plan = destinationPlan(agent, lease, lease.storage_evidence.disk);
    const target = await pinnedTarget(ownerId, agent, lease.destination);
    let reservation = await readReservation(plan, target.env);
    let newlyPrepared = false;
    if (!reservation && prepare) {
      const result = await runProxmoxHostScript(buildPortableKvmDestinationPrepareScript(plan), target.env, 115_000);
      reservation = result.ok ? parsePortableKvmDestinationPrepareReceipt(result.stdout, plan) : null;
      newlyPrepared = reservation !== null;
    }
    if (!reservation) throw new Error("Portable KVM destination reservation not confirmed");
    const approved = pilotProfile(agent, lease.destination);
    const profile = { reservation, ip: lease.destination.ip, machineId: approved.machineId,
      managed: approved.profile.managed };
    const adapter: PortableKvmDestinationBootAdapter = {
      async readAuthority({ ownerId: owner, agentId }) {
        if (!supabaseAdmin || owner !== ownerId || agentId !== lease.agent_id) return null;
        const { data, error } = await supabaseAdmin.from("hivra_agents").select("*").eq("id", agentId).eq("user_id", ownerId).maybeSingle();
        if (error || !data) return null;
        return { agent: data, lease: await rpc("read_hivra_kvm_portable_handoff", { p_owner_id: ownerId, p_agent_id: agentId }) };
      },
      runHostScript({ hostId, script, timeoutMs }) {
        if (hostId !== lease.destination.hostId) throw new Error("Portable KVM destination host changed");
        return runProxmoxHostScript(script, target.env, timeoutMs);
      },
    };
    return { reservation, env: target.env, profile, adapter, newlyPrepared };
  }

  function bootReceipt(lease: PortableKvmHandoff, target: Awaited<ReturnType<typeof destination>>) {
    const evidence = lease.destination_evidence;
    if (!evidence || evidence.reservationSha256 !== sha(serializePortableKvmDestinationReservation(target.reservation))) {
      throw new Error("Portable KVM destination reservation does not match the journal");
    }
    return { state: "destination_quarantined" as const, bootId: evidence.bootId,
      profileSha256: sha(serializePortableKvmDestinationBootProfile(target.profile)) };
  }

  return advancePortableKvmIdleHandoff(ownerId, agent, {
    rpc,
    async preflight(row, placement) {
      if (placement.current.ip !== placement.alternate.ip || !getTunnelConfig()) return false;
      pilotProfile(row, placement.alternate);
      const [source, target] = await Promise.all([
        pinnedTarget(ownerId, row, placement.current, true), pinnedTarget(ownerId, row, placement.alternate, true),
      ]);
      const { profile } = pilotProfile(row, placement.current);
      const [sourceProfile, sourceCpu, targetCpu, targetSlot] = await Promise.all([
        runProxmoxHostScript(buildPortableKvmSourceProfileCheck(placement.current, profile), source.env, 40_000),
        runProxmoxHostScript(buildPortableKvmHostCpuCompatibilityProbeScript(placement.current.hostId), source.env, 20_000),
        runProxmoxHostScript(buildPortableKvmHostCpuCompatibilityProbeScript(placement.alternate.hostId), target.env, 20_000),
        runProxmoxHostScript(buildPortableKvmSlotClaimScript("verify", placement.alternate), target.env, 40_000),
      ]);
      if (!sourceProfile.ok || !isPortableKvmSourceProfileEligible(sourceProfile.stdout)) return false;
      if (!targetSlot.ok || targetSlot.stdout.trim() !== "HIVRA_PORTABLE_SLOT_V1 verify") return false;
      return [sourceCpu, targetCpu].every(result => {
        if (!result.ok) return false;
        const observed = portableKvmManagedDestinationProfileSchema.shape.cpu.safeParse(JSON.parse(result.stdout));
        return observed.success && observed.data.vendor === profile.managed.cpu.vendor
          && profile.managed.cpu.requiredFlags.every(flag => observed.data.requiredFlags.includes(flag));
      });
    },
    async checkpoint(row) {
      const result = await advancePortableKvmSourceCheckpoint(ownerId, row);
      return result?.state === "checkpoint_verified" && result.disk.key === "scsi0"
        ? { checkpointSha256: result.checkpointSha256, configuration: result.configuration,
          disk: { ...result.disk, key: "scsi0" } } : null;
    },
    async verifyFencedSource(row, lease) {
      const target = await pinnedTarget(ownerId, row, lease.source);
      const scope = { agentId: lease.agent_id, operationId: lease.operation_id, generation: lease.generation,
        hostId: lease.source.hostId, vmid: lease.source.vmid, bindingTag: lease.source.bindingTag };
      const result = await runProxmoxHostScript(buildPortableKvmSourceFenceScript(scope, "verify"), target.env, 45_000);
      const proof = result.ok && parsePortableKvmSourceFence(result.stdout, scope);
      if (!proof || (lease.storage_evidence && lease.storage_evidence.configuration.sha256 !== proof.configurationSha256)) return false;
      return lease.phase === "placement_committed" || lease.phase === "connector_verified" || (await connectors()).length === 0;
    },
    async restoreAndColdBoot(_row, lease) {
      const target = await destination(lease, true);
      if (target.newlyPrepared) return null;
      const job = await pollPortableKvmDestinationJob(target.reservation, target.env);
      if (job.state === "missing") {
        const password = portableKvmCheckpointPassword(lease.agent_id, lease.operation_id);
        if (!password) throw new Error("Portable KVM checkpoint key is unavailable");
        const dispatched = await dispatchPortableKvmDestinationJob(target.reservation, password, target.env);
        if (dispatched.state === "failed") throw new Error("Portable KVM disk restore failed");
        return null;
      }
      if (job.state === "failed") throw new Error("Portable KVM disk restore failed");
      if (job.state !== "succeeded") return null;
      const boot = await bootPortableKvmDestination({ ownerId, profile: target.profile, diskReceipt: job.receipt }, target.adapter);
      return { bootId: boot.bootId, reservationSha256: sha(serializePortableKvmDestinationReservation(target.reservation)) };
    },
    async verifyQuarantinedDestination(_row, lease) {
      const target = await destination(lease, false);
      await verifyPortableKvmQuarantinedDestination({ ownerId, profile: target.profile, bootReceipt: bootReceipt(lease, target) }, target.adapter);
      return true;
    },
    async enableDestinationConnector(_row, lease) {
      const target = await destination(lease, false);
      const result = await enablePortableKvmDestinationNetwork({ ownerId, profile: target.profile,
        bootReceipt: bootReceipt(lease, target) }, target.adapter);
      const active = await connectors();
      return active.length === 1 && active[0].clientId === result.connectorId
        ? { bootId: result.bootId, connectorId: result.connectorId } : null;
    },
    async releaseDestinationLock(_row, lease) {
      const target = await destination(lease, false);
      const proof = lease.connector_evidence;
      const boot = bootReceipt(lease, target);
      if (!proof || proof.bootId !== boot.bootId) return false;
      await releasePortableKvmDestinationLock({ ownerId, profile: target.profile, networkReceipt: {
        ...boot, state: "destination_network_enabled", connectorId: proof.connectorId,
      } }, {
        ...target.adapter,
        async verifyConnector({ agentId, tunnelId, connectorId }) {
          if (agentId !== lease.agent_id || tunnelId !== agent.cf_tunnel_id) return false;
          const current = await connectors();
          return current.length === 1 && current[0].clientId === connectorId;
        },
      });
      return true;
    },
  }, options);
}
