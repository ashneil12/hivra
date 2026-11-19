import "server-only";

import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import { isAgentAwake, parseSleepGeneration } from "./agent-sleep-store";

/**
 * Small helpers that make the rest of the system sleep-aware.
 *
 * `wakeForUserAction` is what every user-started path calls before it touches
 * a computer: it is a no-op for an agent that is awake (no database read, no
 * host call), and otherwise wakes the agent or says plainly that it is still
 * waking. `markAgentAwake` is for the paths that switch a computer off: a
 * stopped computer has no saved memory and nothing napping, so the sleep
 * record goes back to awake.
 *
 * Fail toward awake: nothing here sets hivra_agents.status, and no unknown
 * answer is read as "safe to act on a sleeping computer".
 */

const LOG_SOURCE = "sleep-aware";

/** How long a user's request waits for a wake before it answers "still waking". */
export const USER_ACTION_WAKE_WAIT_MS = 45_000;

export const STILL_WAKING_MESSAGE = "Your computer is still waking up. Try again in a few seconds.";
export const WAKE_FAILED_MESSAGE = "Your computer could not wake up just now. Try again in a moment.";
export const ASLEEP_LAPSED_MESSAGE = "This computer is asleep, and it cannot be woken until you have a plan.";

export type WakeForActionFailure = {
  ok: false;
  reason: "waking" | "lapsed" | "failed";
  /** 503 for a wake that has not finished or did not work, 402 for a lapsed owner. */
  status: 503 | 402;
  code: "computer_asleep" | "instance_entitlement_suspended";
  message: string;
};

export type WakeForActionResult =
  | {
      ok: true;
      /** True when this call woke the computer, so the caller's copy of the row is stale. */
      woke: boolean;
      /** True when the computer was off with nothing saved. The normal start path owns that. */
      cold: boolean;
    }
  | WakeForActionFailure;

export interface WakeForActionOptions {
  /** How long to wait for the wake. Default 45 s. */
  waitMs?: number;
  /**
   * Let the action go ahead when the owner's plan has lapsed instead of
   * refusing. For paths that switch the computer off, which are sleep-aware
   * themselves and must stay open for a lapsed owner.
   */
  allowLapsed?: boolean;
  /** Gets wake work still running when the wait ends, so a route can keep it alive. */
  onBackground?: (work: Promise<unknown>) => void;
}

type SleepRow = { id?: unknown; status?: unknown; sleep_state?: unknown };

/**
 * Wakes the agent if it is asleep. `row` is the caller's copy of the agent row;
 * an agent that is awake (or whose row does not carry a sleep state) returns at
 * once with no database or host work. A computer that is not running has
 * nothing to wake.
 */
export async function wakeForUserAction(
  row: SleepRow | null | undefined,
  options: WakeForActionOptions = {},
): Promise<WakeForActionResult> {
  if (!row || isAgentAwake(row) || row.status !== "running" || typeof row.id !== "string") {
    return { ok: true, woke: false, cold: false };
  }
  return wakeAgentForUserAction(row.id, options);
}

/**
 * The same wake for a caller that holds only the agent's id, or a row that does
 * not carry the sleep state. It reads the live row, so an awake agent costs one
 * database read and no host call.
 */
export async function wakeAgentForUserAction(
  agentId: string,
  options: WakeForActionOptions = {},
): Promise<WakeForActionResult> {
  const { ensureHivraAgentAwake } = await import("./agent-wake");
  let result: Awaited<ReturnType<typeof ensureHivraAgentAwake>>;
  try {
    result = await ensureHivraAgentAwake(agentId, {
      trigger: "action",
      waitMs: options.waitMs ?? USER_ACTION_WAKE_WAIT_MS,
      onBackground: options.onBackground,
    });
  } catch (error) {
    log.error("wake before a user action threw", error instanceof Error ? error : new Error(String(error)), {
      source: LOG_SOURCE,
      failureType: "wake_before_action_threw",
      agentId,
    });
    return { ok: false, reason: "failed", status: 503, code: "computer_asleep", message: WAKE_FAILED_MESSAGE };
  }
  if (result.state === "awake") return { ok: true, woke: true, cold: false };
  if (result.state === "cold") return { ok: true, woke: true, cold: true };
  if (result.state === "waking") {
    return { ok: false, reason: "waking", status: 503, code: "computer_asleep", message: STILL_WAKING_MESSAGE };
  }
  if (result.reason === "lapsed") {
    if (options.allowLapsed) return { ok: true, woke: false, cold: false };
    return {
      ok: false,
      reason: "lapsed",
      status: 402,
      code: "instance_entitlement_suspended",
      message: ASLEEP_LAPSED_MESSAGE,
    };
  }
  return { ok: false, reason: "failed", status: 503, code: "computer_asleep", message: WAKE_FAILED_MESSAGE };
}

/**
 * Puts the sleep record back to awake after a computer was switched off. A
 * stopped computer has no saved memory (a hibernation is discarded by the stop
 * script) and nothing paused. Compare-and-set on the generation, so a change
 * made in the meantime wins. Returns true when the record is awake afterwards.
 * Never throws and never touches status.
 */
export async function markAgentAwake(agentId: string): Promise<boolean> {
  if (!supabaseAdmin) return false;
  try {
    const { data, error } = await supabaseAdmin
      .from("hivra_agents")
      .select("sleep_state,sleep_generation")
      .eq("id", agentId)
      .maybeSingle();
    if (error || !data) return false;
    if (isAgentAwake(data)) return true;
    const generation = parseSleepGeneration((data as { sleep_generation?: unknown }).sleep_generation);
    if (generation == null) return false;
    const { data: updated, error: updateError } = await supabaseAdmin
      .from("hivra_agents")
      .update({
        sleep_state: "awake",
        sleep_generation: generation + 1,
        sleep_tier_changed_at: new Date().toISOString(),
        next_wake_at: null,
      })
      .eq("id", agentId)
      .eq("sleep_generation", generation)
      .select("id");
    if (updateError) throw new Error("sleep_reset_failed");
    return Array.isArray(updated) && updated.length > 0;
  } catch {
    log.warn("sleep record could not be reset after a stop", {
      source: LOG_SOURCE,
      failureType: "sleep_reset_after_stop_failed",
      instanceId: agentId,
    });
    return false;
  }
}
