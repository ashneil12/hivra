// Switches for the faster-wake changes. Each one is off unless named in the
// flag's value, so with the flag unset a wake runs exactly as it did before.
//
// The server reads HIVRA_FAST_WAKE and the page reads
// NEXT_PUBLIC_HIVRA_FAST_WAKE. Either holds a comma-separated list of the
// names below, or "all". Each change can be turned off on its own by leaving
// its name out.
//
// No server imports here: the page uses this file too.

export type FastWakeFeature =
  /** Record the host's own time and when SSH became ready in the wake event. */
  | "timing"
  /** Poll the public health check every 150 ms for the first 3 s. */
  | "fast_healthz"
  /** The binding check reads the VM's config file instead of starting the qm CLI. */
  | "fast_qm"
  /** Hand the SSH answer back as soon as the wake receipt line is complete. */
  | "early_finish"
  /** Write the wake event after the answer is sent. */
  | "deferred_log"
  /** The page sends its wake request while it reads the agent for the first time. */
  | "early_wake"
  /**
   * The server wakes through the host ingress ticket before falling back to
   * SSH. Only on when named: "all" does not turn it on.
   */
  | "ingress_ticket";

const FEATURES: readonly FastWakeFeature[] = [
  "timing", "fast_healthz", "fast_qm", "early_finish", "deferred_log", "early_wake", "ingress_ticket",
];

/** Features "all" leaves out: they must be named, so setting "all" earlier never turns them on later. */
const NAMED_ONLY: readonly FastWakeFeature[] = ["ingress_ticket"];

/** The features a flag value turns on. Anything not on the list is ignored. */
export function parseFastWakeFlags(value: string | undefined | null): ReadonlySet<FastWakeFeature> {
  const names = String(value ?? "").split(",").map((name) => name.trim().toLowerCase()).filter(Boolean);
  const all = names.includes("all");
  return new Set(FEATURES.filter((feature) =>
    names.includes(feature) || (all && !NAMED_ONLY.includes(feature))));
}

/** Whether one change is on. The server's flag is read when no value is given. */
export function isFastWakeEnabled(
  feature: FastWakeFeature,
  value: string | undefined | null = process.env.HIVRA_FAST_WAKE,
): boolean {
  return parseFastWakeFlags(value).has(feature);
}
