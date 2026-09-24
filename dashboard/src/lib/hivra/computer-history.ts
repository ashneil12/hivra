// A computer's lifecycle history as its owner sees it in Manage › Advanced.
// Pure and client-safe; GET /api/hivra/agents/[id]/events serves it.

export const COMPUTER_HISTORY_LIMIT = 20;

/** Lifecycle events a computer's owner sees, in their words. */
export const COMPUTER_HISTORY_LABELS: Record<string, string> = {
  launch_requested: "Launch requested",
  provisioned: "Came online",
  provision_failed: "Setup failed",
  failed: "Didn't come online",
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

export interface ComputerHistoryEvent {
  event: string;
  createdAt: string;
  label: string;
}
