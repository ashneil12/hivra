import "server-only";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase";


export async function stopDeletedUserComputer(userId: string, agentId: string): Promise<void> {
  if (!supabaseAdmin) throw new Error("Database not configured");
  const db = supabaseAdmin;
  const { data: agent, error } = await db.from("hivra_agents").select("*").eq("id", agentId).eq("user_id", userId).single();
  if (error || !agent || agent.id !== agentId || agent.user_id !== userId || agent.status === "deleted") throw new Error("Computer authority changed");
  // Never interpret a different substrate's identifiers as a managed VM.
  if (agent.computer_substrate !== "proxmox-kvm" && agent.computer_substrate != null) throw new Error("Computer substrate requires operator containment");
  if (!Number.isSafeInteger(agent.vmid) || agent.vmid <= 0) throw new Error("Computer VM identity is unavailable");
  const [execution, operations, scripts, host, desktop] = await Promise.all([
    import("@/lib/hivra/agent-execution-context"), import("@/lib/hivra/agent-operation-store"),
    import("@/lib/hivra/agent-power-scripts"), import("@/lib/services/proxmox-instance-service"),
    import("@/lib/remote-computers/session-broker"),
  ]);
  const { resolveHivraAgentExecutionContext } = execution;
  const { claimHivraAgentOperation, completeHivraAgentOperation, recordHivraAgentOperationFailure } = operations;
  const { verifiedStopVmScript } = scripts;
  const { runProxmoxHostScript } = host;
  const { revokeRemoteDesktopCapability } = desktop;
  const context = await resolveHivraAgentExecutionContext(userId, agent);
  const resuming = agent.operation_kind === "stop" && agent.desired_state === "stopped" && typeof agent.operation_id === "string";
  const operationId = resuming ? agent.operation_id : randomUUID();
  const operation = { userId, agentId, operationId };
  // A retained stop already owns this exact operation token. Re-run its
  // idempotent, host-locked action, then use the same terminal CAS. Do not use
  // continue_hivra_agent_operation: that RPC only supports start-like actions.
  const claimed = resuming || await claimHivraAgentOperation({ ...operation, operationKind: "stop", desiredState: "stopped" });
  if (!claimed) throw new Error("Computer operation is busy");
  try {
    const { data: current, error: reloadError } = await db.from("hivra_agents").select("*").eq("id", agentId).eq("user_id", userId).single();
    const identityFields = ["vmid", "proxmox_host", "deployment_mode", "computer_substrate", "infrastructure_connection_id", "deployment_target_id", "infrastructure_connection_revision", "infrastructure_binding_token_hash", "infrastructure_binding_token_enforced", "managed_provisioner_channel"];
    if (reloadError || !current || current.operation_id !== operationId || current.operation_kind !== "stop" || current.desired_state !== "stopped" || identityFields.some((key) => current[key] !== agent[key])) throw new Error("Computer authority changed after claiming containment");
    let desktopRevoked = false;
    try { desktopRevoked = (await revokeRemoteDesktopCapability({ userId, computerKind: "hivra-agent", computerId: agentId })).ok; } catch { /* Still contain the running VM. */ }
    const stopped = await runProxmoxHostScript(verifiedStopVmScript(agent.vmid, 30, context.infrastructureBindingTagEnforced ? context.infrastructureBindingTag : null, true), context.env, { timeoutMs: 120_000 });
    if (!stopped.ok) throw new Error("Computer shutdown or autostart disable is unconfirmed");
    if (!desktopRevoked) throw new Error("Desktop access revocation is incomplete");
    if (!await completeHivraAgentOperation({ ...operation, expectedDesiredState: "stopped", status: "stopped" })) throw new Error("Computer shutdown persistence was superseded");
  } catch (failure) {
    // Retain the operation for the existing reconciler rather than allowing a
    // competing Start while an unconfirmed provider action may still run.
    await recordHivraAgentOperationFailure({ ...operation, error: "Deleted owner containment is incomplete" }).catch(() => false);
    throw failure;
  }
}

export async function runDeletedOwnerComputerSweep() {
  if (!supabaseAdmin) throw new Error("Database not configured");
  const { clerkClient } = await import("@clerk/nextjs/server");
  const { classifyByClerkOwnership, listLiveComputers, rotatingContainmentBatch } = await import("./orphaned-instances");
  const rows = await listLiveComputers(supabaseAdmin);
  const clerk = await clerkClient();
  const checks = await classifyByClerkOwnership(rows, clerk.users);
  const orphans = checks.filter((check) => check.status === "orphan");
  let stopped = 0, failures = 0;
  for (const { row } of rotatingContainmentBatch(orphans, 2)) {
    try { await stopDeletedUserComputer(row.user_id, row.id); stopped += 1; }
    catch { failures += 1; }
  }
  return { checked: rows.length, orphaned: orphans.length, stopped, failures, lookupFailures: checks.filter((check) => check.status === "lookup-failed").length };
}
