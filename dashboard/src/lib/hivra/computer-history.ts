// A computer's lifecycle history as its owner sees it in Manage › Advanced.
// Pure and client-safe; GET /api/hivra/agents/[id]/events serves it.

export const COMPUTER_HISTORY_LIMIT = 20;

/** Lifecycle events a computer's owner sees, in their words. */
export const COMPUTER_HISTORY_LABELS: Record<string, string> = {
  launch_requested: "Launch requested",
  provisioned: "Came online",
  provision_failed: "Setup failed",
  // A failure's own label comes from its recorded reason (computerHistoryLabel).
  failed: "Something went wrong",
  bootstrapped: "Agent instructions set up",
  bankr_skills_seeded: "Skills added",
  skills_installed: "Skills installed",
  tools_installed: "Tools installed",
  tools_uninstalled: "Tools removed",
  template_skills_seeded: "Template skills added",
  bankr_wallet_provisioned: "Wallet set up",
  started: "Started",
  stopped: "Stopped",
  restarted: "Restarted",
  resized: "Resized",
  runtime_updated: "Connection service updated",
  snapshot_created: "Restore point created",
  snapshot_restored: "Restored from a restore point",
  deleted: "Deleted",
};

/**
 * What a `failed` event was, by the reason it recorded. A delete that failed
 * leaves the computer in place, and a launch can fail before it ever starts,
 * so "failed" alone doesn't say what happened. Only these reasons are read;
 * the route sends the label, never the reason or the rest of the detail.
 */
const FAILED_REASON_LABELS: Record<string, string> = {
  delete_destroy_failed: "Couldn't delete",
  cpu_limit_apply: "Setup failed",
  vm_identity_persist: "Setup failed",
  ssh_kickoff_compensated: "Setup failed",
  stale_provision_intent_missing: "Setup failed",
  provisioner_reported_failure: "Didn't come online",
  stuck_provisioning_no_tunnel: "Didn't come online",
  stuck_provisioning_vm_missing: "Didn't come online",
};

/** The owner's label for one event, or null for an event History doesn't show. */
export function computerHistoryLabel(event: string, reason?: unknown): string | null {
  if (!Object.hasOwn(COMPUTER_HISTORY_LABELS, event)) return null;
  if (event === "failed" && typeof reason === "string" && Object.hasOwn(FAILED_REASON_LABELS, reason)) {
    return FAILED_REASON_LABELS[reason];
  }
  return COMPUTER_HISTORY_LABELS[event];
}

export interface ComputerHistoryEvent {
  event: string;
  createdAt: string;
  label: string;
}
