import "server-only";

import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import { parseProviderDesktopWorkerIdentity, parseProviderDesktopWorkerReceipt,
  type ProviderDesktopWorkerIdentity, type ProviderDesktopWorkerReceipt } from "@/lib/infrastructure/provider-desktop-worker";
import { parseProviderDesktopAccess, type ProviderDesktopAccess } from "@/lib/infrastructure/provider-desktop-launch-contract";
import type { ProviderGuestClock } from "@/lib/infrastructure/provider-guest-bundle";
import { loadProviderDesktopInstallBinding, ProviderAgentInstallStoreError,
  type ProviderAgentInstallOperation } from "./provider-agent-install-store";

const Uuid = z.string().uuid();
const Operation = z.object({ userId: z.string().min(1).max(256), agentId: Uuid, operationId: Uuid }).strict();
const Grant = z.object({ observationId: Uuid, budgetMs: z.literal(30000) }).strict();
export type ProviderDesktopCleanupGrant = z.infer<typeof Grant>;
function database() {
  if (!supabaseAdmin) throw new ProviderAgentInstallStoreError();
  return supabaseAdmin;
}
function checkedIdentity(input: ProviderAgentInstallOperation, identity: ProviderDesktopWorkerIdentity) {
  const current = Operation.parse(input), checked = parseProviderDesktopWorkerIdentity(identity);
  if (checked.agentId !== current.agentId || checked.operationId !== current.operationId) throw new Error();
  return { current, checked };
}
function checkedReceipt(input: ProviderAgentInstallOperation, receipt: ProviderDesktopWorkerReceipt, clock: ProviderGuestClock) {
  const { current, checked: identity } = checkedIdentity(input, receipt.identity);
  const checked = parseProviderDesktopWorkerReceipt(`HIVRA_PROVIDER_WORKER_V1 ${JSON.stringify(receipt)}\n`, identity, clock);
  if (!checked.stopped) throw new Error();
  return { current, checked };
}

/** Private v3 recovery only. The durable cancellation flag is intent, not a
 * reusable cleanup receipt. Expired/lost grants must still suppress readiness. */
export async function loadProviderDesktopInstallOperation(input: ProviderAgentInstallOperation) {
  try {
    const current = Operation.parse(input), context = await loadProviderDesktopInstallBinding(current);
    const { data, error } = await database().from("hivra_provider_desktop_cleanup")
      .select("agent_id,user_id,operation_id,identity")
      .eq("agent_id", current.agentId).eq("user_id", current.userId).eq("operation_id", current.operationId).maybeSingle();
    if (error) throw new Error();
    if (data !== null) {
      const journal = z.object({ agent_id: Uuid, user_id: z.string(), operation_id: Uuid, identity: z.unknown() }).strict().parse(data);
      const identity = checkedIdentity(current, journal.identity as ProviderDesktopWorkerIdentity).checked;
      if (journal.agent_id !== current.agentId || journal.user_id !== current.userId || journal.operation_id !== current.operationId
        || JSON.stringify(identity) !== JSON.stringify(parseProviderDesktopWorkerIdentity(context.identity))) throw new Error();
    }
    return { ...context, cancellationRequested: data !== null };
  } catch { throw new ProviderAgentInstallStoreError(); }
}
export type ProviderDesktopInstallContext = Awaited<ReturnType<typeof loadProviderDesktopInstallOperation>>;

export async function beginProviderDesktopInstall(input: ProviderAgentInstallOperation, identity: ProviderDesktopWorkerIdentity, access: ProviderDesktopAccess) {
  try {
    const { current, checked } = checkedIdentity(input, identity), bound = parseProviderDesktopAccess(access);
    const { data, error } = await database().rpc("begin_hivra_provider_desktop_install", {
      p_user_id: current.userId, p_agent_id: current.agentId, p_operation_id: current.operationId, p_identity: checked, p_access: bound,
    });
    if (error) throw new Error();
    return z.union([
      z.object({ outcome: z.literal("dispatch"), dispatchBudgetMs: z.literal(30000) }).strict(),
      z.object({ outcome: z.enum(["observe", "rejected"]) }).strict(),
    ]).parse(data);
  } catch { throw new ProviderAgentInstallStoreError(); }
}

export async function recordProviderDesktopInstallStopped(input: ProviderAgentInstallOperation,
  receipt: ProviderDesktopWorkerReceipt, clock: ProviderGuestClock) {
  try {
    const { current, checked } = checkedReceipt(input, receipt, clock);
    const { data, error } = await database().rpc("record_hivra_provider_install_stopped", {
      p_user_id: current.userId, p_agent_id: current.agentId, p_operation_id: current.operationId, p_receipt: checked,
    });
    if (error || typeof data !== "boolean") throw new Error();
    return data;
  } catch { throw new ProviderAgentInstallStoreError(); }
}

/** Start the caller's monotonic budget BEFORE this RPC. A response loss never
 * authorizes SSH or cached proof, and the cancellation latch remains durable. */
export async function beginProviderDesktopCleanup(input: ProviderAgentInstallOperation, identity: ProviderDesktopWorkerIdentity) {
  try {
    const { current, checked } = checkedIdentity(input, identity);
    const { data, error } = await database().rpc("begin_hivra_provider_desktop_cleanup", {
      p_user_id: current.userId, p_agent_id: current.agentId, p_operation_id: current.operationId, p_identity: checked,
    });
    if (error) throw new Error();
    return data === null ? null : Grant.parse(data);
  } catch { throw new ProviderAgentInstallStoreError(); }
}

/** Never load a newer grant here. The receipt belongs to the exact grant
 * captured before its fresh signed SSH clock/observation, not to database time
 * or a boot ID copied out of a cached receipt. SQL rechecks expiry and outcome. */
export async function recordProviderDesktopCleanup(input: ProviderAgentInstallOperation, grant: ProviderDesktopCleanupGrant,
  receipt: ProviderDesktopWorkerReceipt, clock: ProviderGuestClock) {
  try {
    const token = Grant.parse(grant), { current, checked } = checkedReceipt(input, receipt, clock);
    if (checked.desktopCleanup.state === "pending") throw new Error();
    const { data, error } = await database().rpc("record_hivra_provider_desktop_cleanup", {
      p_user_id: current.userId, p_agent_id: current.agentId, p_operation_id: current.operationId,
      p_observation_id: token.observationId, p_receipt: checked,
    });
    if (error || typeof data !== "boolean") throw new Error();
    return data;
  } catch { throw new ProviderAgentInstallStoreError(); }
}

/** Desktop readiness has no database bearer. Keep the shared v1
 * complete_hivra_agent_running NULL=preserve semantics unchanged and use the
 * desktop terminal CAS that explicitly clears any staged legacy token. */
export async function completeProviderDesktopRunning(input: ProviderAgentInstallOperation & {
  chatUrl: string; ip: string; provisionedAt: string;
}) {
  try {
    const current = Operation.parse({ userId: input.userId, agentId: input.agentId, operationId: input.operationId });
    const { data, error } = await database().rpc("complete_hivra_provider_desktop_running", {
      p_user_id: current.userId, p_agent_id: current.agentId, p_operation_id: current.operationId,
      p_chat_url: z.string().url().max(2048).parse(input.chatUrl),
      p_ip: z.string().min(1).max(64).parse(input.ip),
      p_provisioned_at: z.string().datetime({ offset: true }).parse(input.provisionedAt),
    });
    if (error || typeof data !== "boolean") throw new Error();
    return data;
  } catch { throw new ProviderAgentInstallStoreError(); }
}
