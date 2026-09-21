export type ProviderAgentReadinessStage = "installer_pending" | "cancellation_pending" | "provider_pending"
  | "runtime_pending" | "public_access_pending" | "verification_unavailable" | "failed" | "running";

const messages: Record<ProviderAgentReadinessStage, string> = {
  installer_pending: "Checking the original agent installer. No replacement computer is being launched.",
  cancellation_pending: "Deletion was requested. The original installer must stop before removal can continue. You can inspect or resume removal in Manage.",
  provider_pending: "Waiting for the cloud provider to confirm this computer’s current state.",
  runtime_pending: "The installer finished. Checking the agent services, authentication and native interfaces.",
  public_access_pending: "The agent is installed, but its public connection has not passed verification yet. Your original computer is retained.",
  verification_unavailable: "Couldn’t verify readiness on the last check. The original computer and operation are retained; no reinstall or replacement was started.",
  failed: "The original launch did not complete. Inspect or remove this computer in Manage; provider billing may continue.",
  running: "The runtime and public connection passed readiness checks. Your agent’s own sign-in or API-key setup may still be required.",
};

export function providerReadinessMessage(stage: unknown): string | null {
  return typeof stage === "string" && Object.hasOwn(messages, stage) ? messages[stage as ProviderAgentReadinessStage] : null;
}
