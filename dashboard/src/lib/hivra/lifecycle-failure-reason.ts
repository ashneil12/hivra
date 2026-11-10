/**
 * User-safe wording for lifecycle failures and busy refusals.
 *
 * Host script stderr can carry hostnames, IPs, VMIDs, paths and tokens, so it
 * is never returned. It is only classified against a fixed set of patterns,
 * and the reason returned is always one of the static strings below.
 */
export type LifecycleFailureCode =
  | "shutdown_timeout"
  | "host_unreachable"
  | "host_busy"
  | "host_capacity"
  | "computer_not_found"
  | "host_error";

const REASONS: Record<LifecycleFailureCode, string> = {
  shutdown_timeout: "The computer did not shut down in time.",
  host_unreachable: "Hivra could not reach the server this computer runs on.",
  host_busy: "The server is busy with another change.",
  host_capacity: "The server does not have enough free resources.",
  computer_not_found: "The server could not find this computer.",
  host_error: "The server reported an error.",
};

const PATTERNS: Array<[RegExp, LifecycleFailureCode]> = [
  [/did not switch off|qm stop did not complete|shutdown/i, "shutdown_timeout"],
  [/ssh|connection (refused|reset|closed)|unreachable|econn|enotfound|network|could not (connect|resolve)/i, "host_unreachable"],
  [/timed? ?out|timeout/i, "host_unreachable"],
  [/\block(ed)?\b|flock|already running|busy/i, "host_busy"],
  [/capacity|out of memory|no space|not enough|exceeds selected host/i, "host_capacity"],
  [/does not exist|not found|no such|binding|ownership/i, "computer_not_found"],
];

export function classifyLifecycleFailure(detail: string | null | undefined): { code: LifecycleFailureCode; reason: string } {
  const text = String(detail ?? "");
  for (const [pattern, code] of PATTERNS) {
    if (pattern.test(text)) return { code, reason: REASONS[code] };
  }
  return { code: "host_error", reason: REASONS.host_error };
}

/** `{ message, extra }` for apiError: "Stop failed: <reason>" plus a stable code. */
export function lifecycleFailureResponse(verb: string, detail: string | null | undefined) {
  const { code, reason } = classifyLifecycleFailure(detail);
  return { message: `${verb} failed. ${reason}`, extra: { code, reason } };
}

const BUSY_KIND: Record<string, string> = {
  provision: "Setup is still running on this computer",
  start: "This computer is still starting",
  stop: "This computer is still stopping",
  restart: "This computer is still restarting",
  resize: "A resize is still running on this computer",
  snapshot: "A restore point is still being saved",
  restore: "A restore is still running on this computer",
  desktop_prepare: "The desktop is still being prepared",
  private_access: "Private access is still being changed",
  delete: "This computer is being deleted",
};

/** Says what is running (from the stored row) and that retrying shortly is fine. */
export function lifecycleBusyResponse(row: { operation_kind?: unknown; status?: unknown } | null | undefined) {
  const kind = typeof row?.operation_kind === "string" ? row.operation_kind : null;
  const running = (kind && BUSY_KIND[kind])
    || (row?.status === "provisioning" ? BUSY_KIND.provision : "Another change is still running on this computer");
  const operation = kind && BUSY_KIND[kind] ? kind : row?.status === "provisioning" ? "provision" : null;
  return {
    message: `${running}. Try again in a minute.`,
    extra: { code: "busy", ...(operation ? { operation } : {}) },
  };
}
