/**
 * When a sandbox stops and when it is packed into storage. A pure function, like `agent-sleep-policy.ts`, but with
 * its own rule: only a PERSON counts as use (a message, or opening the agent). A scheduled job is not an input at
 * all, so it can never keep a sandbox awake or reset the storage clock. Nothing here ever deletes: packing moves a
 * sandbox to storage, and the person's data stays there until they delete it themselves.
 */
import type { LifecycleSettings } from "./settings";

export type SandboxState = "awake" | "stopped" | "packed" | "restoring" | "flagged";

export interface SandboxSignals {
  state: SandboxState;
  /** The last time the person used the agent; null when they never have since it was placed. */
  personActivityAt: Date | null;
  /** When the sandbox was placed (the clock's start when the person has not used it yet). */
  placedAt: Date;
  /** A run the person started is still going: never stop under it. */
  personRunActive: boolean;
}

export type SandboxDecision =
  | { action: "none"; reason: "busy" | "recent" | "not_managed_here"; nextCheckAt: Date | null }
  | { action: "stop"; reason: "idle" }
  | { action: "pack"; reason: "idle_long" };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** What to do with one sandbox now. `lifecycle` is its plan's clocks (the free section, or the paid plan's). */
export function decideFreeSandbox(signals: SandboxSignals, lifecycle: LifecycleSettings, now: Date): SandboxDecision {
  if (signals.state !== "awake" && signals.state !== "stopped") {
    return { action: "none", reason: "not_managed_here", nextCheckAt: null };
  }
  const lastUse = signals.personActivityAt ?? signals.placedAt;
  const idleMs = Math.max(0, now.getTime() - lastUse.getTime());
  const storeAt = new Date(lastUse.getTime() + lifecycle.storeAfterIdleHours * HOUR);

  if (signals.state === "awake") {
    if (signals.personRunActive) return { action: "none", reason: "busy", nextCheckAt: null };
    if (idleMs >= lifecycle.sleepAfterIdleMinutes * MINUTE) return { action: "stop", reason: "idle" };
    return {
      action: "none",
      reason: "recent",
      nextCheckAt: new Date(lastUse.getTime() + lifecycle.sleepAfterIdleMinutes * MINUTE),
    };
  }
  if (idleMs >= lifecycle.storeAfterIdleHours * HOUR) return { action: "pack", reason: "idle_long" };
  return { action: "none", reason: "recent", nextCheckAt: storeAt };
}
