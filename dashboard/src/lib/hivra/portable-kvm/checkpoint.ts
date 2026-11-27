import "server-only";

import { createHash, createHmac } from "node:crypto";
import { isIPv4 } from "node:net";
import { z } from "zod";
import { buildColdStorageInstallScriptOrExit } from "@/lib/cold-storage-ssh";
import { runProxmoxHostScript, runProxmoxHostScriptWithStdin } from "@/lib/services/proxmox-instance-service";
import { supabaseAdmin } from "@/lib/supabase";
import { resolveHivraLifecycleTarget, type HivraLifecycleAgentRow } from "../agent-lifecycle-host";
import { isCanonicalGitCanaryDeployment } from "../canonical-git-canary";
import { buildBackupPollScript, buildBackupStartScript, parseBackupPoll, parseBackupStartReceipt } from "../computer-backups/scripts";
import { computerBackupPassword } from "../computer-backups/sweep";
import { buildPortableKvmSourceFenceScript, parsePortableKvmSourceFence } from "./source-fence";

const uuid = z.string().uuid();
const targetSchema = z.object({
  hostId: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  vmid: z.number().int().min(9300).max(9399).refine(value => value !== 9302),
  ip: z.string().refine(isIPv4),
  bindingTag: z.string().regex(/^hivra-bind-[a-f0-9]{32}$/),
}).strict();
const leaseSchema = z.object({
  agent_id: uuid, owner_id: z.string().min(1), operation_id: uuid, generation: z.number().int().positive().safe(),
  phase: z.literal("checkpointing"), expires_at: z.string(),
  source: targetSchema, destination: targetSchema,
});

export async function advancePortableKvmSourceCheckpoint(ownerId: string, agent: HivraLifecycleAgentRow) {
  if (!isCanonicalGitCanaryDeployment() || process.env.HIVRA_KVM_PORTABLE_QA_ENABLED !== "true"
    || process.env.HIVRA_KVM_PORTABLE_QA_OWNER_ID !== ownerId
    || process.env.HIVRA_KVM_PORTABLE_QA_AGENT_ID !== agent.id || agent.user_id !== ownerId) return null;
  if (!supabaseAdmin) throw new Error("Portable KVM checkpoint store unavailable");
  const { data, error } = await supabaseAdmin.rpc("read_hivra_kvm_portable_handoff", {
    p_owner_id: ownerId, p_agent_id: agent.id,
  });
  const row = leaseSchema.safeParse(data);
  if (error || !row.success || row.data.agent_id !== agent.id || row.data.owner_id !== ownerId
    || !(Date.parse(row.data.expires_at) > Date.now())) {
    throw new Error("The exact portable KVM checkpoint lease is not active");
  }
  const lease = row.data;
  const source = lease.source;
  if (source.vmid !== agent.vmid || source.hostId !== agent.proxmox_host || source.ip !== agent.ip
    || source.hostId === lease.destination.hostId
    || source.hostId !== process.env.HIVRA_KVM_PORTABLE_QA_SOURCE_HOST
    || lease.destination.hostId !== process.env.HIVRA_KVM_PORTABLE_QA_DESTINATION_HOST) {
    throw new Error("Portable KVM checkpoint targets do not match the pilot");
  }
  const resolved = await resolveHivraLifecycleTarget({ userId: ownerId, agent, action: "portable_checkpoint" });
  if (!resolved.ok || resolved.target.executionContext.kind !== "managed"
    || resolved.target.executionContext.host !== source.hostId || resolved.target.vmid !== source.vmid
    || resolved.target.bindingTag !== source.bindingTag) {
    throw new Error("Portable KVM checkpoint host authority could not be verified");
  }
  const backupKey = computerBackupPassword(lease.agent_id);
  if (!backupKey) throw new Error("Portable KVM checkpoint key is unavailable");
  const coldStorageInstall = buildColdStorageInstallScriptOrExit(process.env);
  const { env } = resolved.target;
  const fenceScope = { agentId: lease.agent_id, generation: lease.generation, operationId: lease.operation_id,
    hostId: source.hostId, vmid: source.vmid, bindingTag: source.bindingTag };
  const fenced = await runProxmoxHostScript(buildPortableKvmSourceFenceScript(fenceScope), env, 75_000);
  const fence = fenced.ok && parsePortableKvmSourceFence(fenced.stdout, fenceScope);
  if (!fence) throw new Error("The portable KVM source could not be fenced");

  const jobId = lease.operation_id;
  const status = await runProxmoxHostScript(buildBackupPollScript([jobId]), env, 25_000);
  const job = status.ok && parseBackupPoll(status.stdout).find(result => result.jobId === jobId);
  if (!job) throw new Error("Portable KVM checkpoint job status could not be confirmed");
  if (job.state === "finished") {
    if (job.status !== "succeeded" || job.reason !== "portable_checkpointed"
      || job.configuration?.sha256 !== fence.configurationSha256 || job.disks.length !== 1 || job.disks[0].key !== "scsi0") {
      throw new Error("Portable KVM checkpoint evidence did not match the fenced source");
    }
    const proof = { fence, configuration: job.configuration, disk: job.disks[0] };
    const checkpointSha256 = createHash("sha256").update(JSON.stringify(proof)).digest("hex");
    return { state: "checkpoint_verified" as const, checkpointSha256, ...proof };
  }
  if (job.state === "running") return { state: "checkpointing" as const };
  const scopedKey = createHmac("sha256", backupKey).update(`hivra-kvm-portable-v1:${jobId}`).digest("hex");
  const start = await runProxmoxHostScriptWithStdin(buildBackupStartScript({
    kind: "portable_checkpoint", jobId, agentId: lease.agent_id, vmid: source.vmid, bindingTag: source.bindingTag,
    keepDaily: 1, keepWeekly: 0, uploadLimitKiB: 8192, maxHours: 1,
    coldStorageInstall, portableFence: fence,
  }), `${scopedKey}\n`, env, 25_000);
  const receipt = start.ok && parseBackupStartReceipt(start.stdout, jobId);
  if (!receipt || (!receipt.ok && !["already_running", "job_exists"].includes(receipt.reason))) {
    throw new Error("Portable KVM checkpoint dispatch could not be confirmed");
  }
  return { state: "checkpointing" as const };
}
