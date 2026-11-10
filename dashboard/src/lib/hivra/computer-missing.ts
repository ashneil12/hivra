// When a computer's host positively reports the VM gone (the usage read's
// definite "missing" answer), the stored row must stop saying Running or
// Stopped. Conservative on purpose: only a definite missing answer calls this
// (never a timeout, network failure or unreadable output), only rows that are
// settled in a running or stopped state with no operation in flight change,
// and no VM is touched. Best effort: a failure here never breaks the read.

import "server-only";

import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import { logHivraAgentEvent } from "@/lib/hivra/agent-events";
import { COMPUTER_MISSING_ON_HOST_ERROR } from "@/lib/hivra/computer-usage-contract";

const SOURCE = "hivra/computer-missing";

/** Records "error / no longer exists on its host". True when this call changed the row. */
export async function recordComputerMissingOnHost(input: {
  userId: string;
  agentId: string;
  agentType?: string | null;
}): Promise<boolean> {
  if (!supabaseAdmin) return false;
  try {
    const { data, error } = await supabaseAdmin
      .from("hivra_agents")
      .update({ status: "error", error: COMPUTER_MISSING_ON_HOST_ERROR })
      .eq("id", input.agentId)
      .eq("user_id", input.userId)
      .in("status", ["running", "stopped"])
      .is("operation_id", null)
      .select("id")
      .maybeSingle();
    if (error || !data) return false;
    await logHivraAgentEvent({
      userId: input.userId,
      event: "failed",
      agentId: input.agentId,
      agentType: input.agentType ?? null,
      detail: { reason: "computer_missing_on_host" },
    });
    return true;
  } catch {
    log.warn("could not record a computer missing on its host", {
      source: SOURCE, failureType: "computer_missing_record_failed", userId: input.userId, agentId: input.agentId,
    });
    return false;
  }
}
