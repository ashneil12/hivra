import "server-only";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { resolveHivraAgentExecutionContext } from "./agent-execution-context";
import {
  decryptFolderRecovery, encryptFolderRecovery, FOLDER_RECOVERY_FORMAT,
  FolderRecoveryError, sha256FolderBytes, validateFolderRecoveryPayload,
} from "./folder-recovery-artifact";
import { buildFolderRecoveryHostScript, parseFolderRecoveryHostResult } from "./folder-recovery-host";

type AgentRow = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function ownedUbuntu(userId: string, id: string): Promise<AgentRow> {
  if (!UUID.test(id) || !supabaseAdmin) throw new FolderRecoveryError("Computer not found.", 404);
  const { data, error } = await supabaseAdmin.from("hivra_agents").select("*")
    .eq("id", id).eq("user_id", userId).neq("status", "deleted").maybeSingle();
  if (error || !data) throw new FolderRecoveryError("Computer not found.", 404);
  if (data.type !== "linux-desktop" || data.computer_profile !== "ubuntu-desktop"
    || data.computer_substrate !== "proxmox-kvm" || data.infrastructure_binding_token_enforced !== true
    || !data.vmid || typeof data.ip !== "string") {
    throw new FolderRecoveryError("Folder recovery currently supports enrolled Ubuntu desktops on Proxmox only.", 409);
  }
  return data;
}

async function guestTarget(userId: string, agent: AgentRow) {
  const context = await resolveHivraAgentExecutionContext(userId, agent);
  if (!context.infrastructureBindingTagEnforced || !context.paths.vmSshKeyPath) {
    throw new FolderRecoveryError("The exact computer SSH identity is unavailable.", 409);
  }
  return { context, target: { vmid: Number(agent.vmid), ip: String(agent.ip),
    bindingTag: context.infrastructureBindingTag, vmSshKeyPath: context.paths.vmSshKeyPath } };
}

export async function exportComputerFolder(userId: string, sourceId: string, passphrase: string): Promise<Buffer> {
  const agent = await ownedUbuntu(userId, sourceId);
  if (agent.status !== "running" || agent.desired_state !== "running" || agent.operation_id) {
    throw new FolderRecoveryError("Start the source Ubuntu computer and wait for its current operation to finish.", 409);
  }
  const { context, target } = await guestTarget(userId, agent);
  const result = await runProxmoxHostScript(buildFolderRecoveryHostScript(target, { action: "export" }), context.env,
    { timeoutMs: 120_000, maxOutputBytes: 4 * 1024 * 1024 });
  if (!result.ok) throw new FolderRecoveryError(
    "Folder export could not be verified. Close apps writing to Hivra and check the 2 MiB / 512 files-and-folders limit. Links and special files are not supported.", 409);
  const evidence = parseFolderRecoveryHostResult(result.stdout);
  const payload = validateFolderRecoveryPayload({ format: FOLDER_RECOVERY_FORMAT, scope: "/home/bux/Hivra",
    source: { agentId: sourceId, bindingHash: agent.infrastructure_binding_token_hash },
    exportedAt: new Date().toISOString(), entries: evidence.entries });
  return encryptFolderRecovery(payload, passphrase);
}

export async function restoreComputerFolder(input: {
  userId: string; sourceId: string; destinationId: string; artifact: Buffer; passphrase: string; revokeSourceSessions: boolean;
}): Promise<{ destinationId: string; sourceId: string; files: number; bytes: number; resumed: boolean; alreadyCompleted: boolean }> {
  if (input.revokeSourceSessions !== true) throw new FolderRecoveryError("Confirm that existing source desktop sessions will end after the verified transfer.");
  const payload = await decryptFolderRecovery(input.artifact, input.passphrase);
  if (payload.source.agentId !== input.sourceId) throw new FolderRecoveryError("This archive belongs to a different original computer. Select its original before confirming the handoff.", 409);
  if (payload.source.agentId === input.destinationId) throw new FolderRecoveryError("Choose a different, freshly launched Ubuntu computer.", 409);
  const [source, destination] = await Promise.all([
    ownedUbuntu(input.userId, payload.source.agentId), ownedUbuntu(input.userId, input.destinationId),
  ]);
  if (source.infrastructure_binding_token_hash !== payload.source.bindingHash
    || source.infrastructure_binding_token_hash === destination.infrastructure_binding_token_hash
    || !destination.api_token || source.api_token === destination.api_token) {
    throw new FolderRecoveryError("The archive source or destination's fresh identity could not be verified.", 409);
  }
  const artifactSha256 = sha256FolderBytes(input.artifact);
  const { context, target } = await guestTarget(input.userId, destination);
  const prior = await supabaseAdmin!.from("hivra_folder_recoveries").select("*")
    .eq("destination_agent_id", input.destinationId).eq("user_id", input.userId).maybeSingle();
  if (prior.error) throw new FolderRecoveryError("Folder recovery journal is unavailable.", 503);
  if (!prior.data) {
    if (destination.status !== "running" || destination.desired_state !== "running" || destination.operation_id) {
      throw new FolderRecoveryError("Wait until the fresh destination Ubuntu computer is running and idle.", 409);
    }
    // Read-only empty-folder preflight before taking any lease. The guest also
    // enforces emptiness atomically at rename after the lease is claimed.
    const check = await runProxmoxHostScript(buildFolderRecoveryHostScript(target, { action: "export" }), context.env,
      { timeoutMs: 90_000, maxOutputBytes: 4 * 1024 * 1024 });
    if (!check.ok) throw new FolderRecoveryError("The destination folder could not be inspected. Nothing was restored.", 409);
    const entries = parseFolderRecoveryHostResult(check.stdout).entries;
    if (!Array.isArray(entries) || entries.length !== 0) throw new FolderRecoveryError("The destination Hivra folder must be empty. Existing files are never overwritten.", 409);
  }
  const { data: operationId, error: beginError } = await supabaseAdmin!.rpc("begin_hivra_folder_recovery", {
    p_user_id: input.userId, p_source_id: payload.source.agentId, p_destination_id: input.destinationId,
    p_source_binding_hash: payload.source.bindingHash, p_artifact_sha256: artifactSha256,
    p_operation_id: randomUUID(), p_revoke_source_sessions: true,
  });
  if (beginError || typeof operationId !== "string" || !UUID.test(operationId)) {
    throw new FolderRecoveryError("The destination is busy, has already received a different archive, or its identity changed. Nothing new was dispatched.", 409);
  }
  const expectedFiles = payload.entries.filter((entry) => entry.kind === "file");
  const files = expectedFiles.length;
  const bytes = expectedFiles.reduce((sum, entry) => sum + Buffer.from(entry.content, "base64").length, 0);
  if (prior.data?.status === "complete" && prior.data.id === operationId) {
    return { destinationId: input.destinationId, sourceId: payload.source.agentId, files, bytes, resumed: true, alreadyCompleted: true };
  }
  const result = await runProxmoxHostScript(buildFolderRecoveryHostScript(target, {
    action: "restore", operationId, artifactSha256, tokenSha256: sha256FolderBytes(Buffer.from(String(destination.api_token))), entries: payload.entries,
  }), context.env, { timeoutMs: 180_000, maxOutputBytes: 16_384 });
  const pending = "Restore has not been confirmed. The operation remains recorded; select the same archive and destination to verify or resume it. No source data was removed.";
  if (!result.ok) throw new FolderRecoveryError(pending, 503);
  const evidence = parseFolderRecoveryHostResult(result.stdout);
  if (evidence.operationId !== operationId || evidence.artifactSha256 !== artifactSha256
    || evidence.verified !== true || evidence.files !== files || evidence.bytes !== bytes) {
    throw new FolderRecoveryError(pending, 503);
  }
  const { data: completed, error: completeError } = await supabaseAdmin!.rpc("complete_hivra_folder_recovery", {
    p_user_id: input.userId, p_operation_id: operationId, p_artifact_sha256: artifactSha256,
    p_file_count: files, p_byte_count: bytes,
  });
  if (completeError || completed !== true) throw new FolderRecoveryError(pending, 503);
  return { destinationId: input.destinationId, sourceId: payload.source.agentId, files, bytes, resumed: Boolean(prior.data), alreadyCompleted: false };
}
