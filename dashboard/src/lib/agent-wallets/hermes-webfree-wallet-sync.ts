// Delivers a connect or disconnect of the user's own Bankr key to a running
// Hermes "webfree" box (backend `gateway` or `webui`). Those boxes take BANKR_*
// only from their persisted runtime env, which the live-update script owns, so
// the change goes through that same path (applyLiveUpdate) for this one
// instance rather than a second writer. The update re-reads the wallet row,
// upserts or clears BANKR_*, strips config.yaml's `bankr:` block and recreates
// the containers: the agent restarts for 1–3 minutes, as with Update, and chats
// in progress stop. So the connect route calls this only when the user ticked
// "restart the agent now" (`restartAgent: true`); without it the change waits
// for the box's next runtime update.
//
// Anything not running and active is skipped; it converges at its next update.
// Never throws: the wallet change has already committed when this runs.

import type { HermesInstanceRow } from "@/app/api/instances/[id]/route";
import { loadGlobalHermesSettingsForUser } from "@/lib/clerk-hermes-settings";
import { redactSensitiveCommandOutput } from "@/lib/command-output-redaction";
import { log } from "@/lib/logger";
import { applyLiveUpdate, resolveInstanceIpv4 } from "@/lib/services/instance-orchestrator";
import { supabaseAdmin } from "@/lib/supabase";
import { isWebfreeBackend } from "@/lib/types/instance";

const LOG_SOURCE = "hermes-webfree-wallet-sync";

export type WebfreeWalletRuntimeSkipReason =
  | "not_webfree"
  | "not_running"
  | "update_in_progress"
  | "not_active_lifecycle"
  | "entitlement_suspended"
  | "no_address";

export type WebfreeWalletRuntimeUpdate =
  | { status: "update_started" }
  | { status: "skipped"; reason: WebfreeWalletRuntimeSkipReason }
  | { status: "failed" };

function skipReason(row: HermesInstanceRow): WebfreeWalletRuntimeSkipReason | null {
  if (!isWebfreeBackend(row.backend)) return "not_webfree";
  // An update already in flight resolved the wallet before this change; the
  // user is told to run Update once it finishes.
  if (row.status === "redeploying") return "update_in_progress";
  if (row.status !== "running") return "not_running";
  // A failed launch stamps lifecycle 'failed', so never start one on a box
  // that isn't plainly healthy.
  if (row.lifecycle_state !== "active") return "not_active_lifecycle";
  // Mirrors ENTITLEMENT_GATED_INSTANCE_ACTIONS in /api/instances/[id].
  if (row.entitlement_state === "suspended") return "entitlement_suspended";
  return null;
}

export async function applyBankrWalletChangeToWebfreeInstance(params: {
  instanceId: string;
  userId: string;
}): Promise<WebfreeWalletRuntimeUpdate> {
  const { instanceId, userId } = params;
  try {
    if (!supabaseAdmin) throw new Error("Database not configured");

    const { data, error } = await supabaseAdmin
      .from("hermes_instances")
      .select("*")
      .eq("id", instanceId)
      .eq("user_id", userId)
      .neq("status", "deleted")
      .maybeSingle();
    if (error) throw new Error(error.message || "Failed to load instance");
    if (!data) throw new Error("Instance not found");
    const row = data as HermesInstanceRow;

    const skipped = skipReason(row);
    if (skipped) return skip(instanceId, userId, skipped);

    const ipv4 = await resolveInstanceIpv4(row, supabaseAdmin);
    if (!ipv4) return skip(instanceId, userId, "no_address");

    const settings = await loadGlobalHermesSettingsForUser(userId, { instanceId });
    const result = await applyLiveUpdate(row, ipv4, settings, supabaseAdmin);
    if (result.applied) {
      log.info("agent wallet change delivered through a runtime update", {
        source: LOG_SOURCE,
        instanceId,
        userId,
      });
      return { status: "update_started" };
    }
    return fail(instanceId, userId, result.error);
  } catch (err) {
    return fail(instanceId, userId, err instanceof Error ? err.message : String(err));
  }
}

function skip(
  instanceId: string,
  userId: string,
  reason: WebfreeWalletRuntimeSkipReason
): WebfreeWalletRuntimeUpdate {
  log.info("agent wallet runtime update skipped", {
    source: LOG_SOURCE,
    instanceId,
    userId,
    failureType: "agent_wallet_runtime_update_skipped",
    reason,
  });
  return { status: "skipped", reason };
}

function fail(instanceId: string, userId: string, error: string | undefined): WebfreeWalletRuntimeUpdate {
  log.warn("agent wallet runtime update failed", {
    source: LOG_SOURCE,
    instanceId,
    userId,
    failureType: "agent_wallet_runtime_update_failed",
    redactedMessage: redactSensitiveCommandOutput(error || "unknown error", 600),
  });
  return { status: "failed" };
}
