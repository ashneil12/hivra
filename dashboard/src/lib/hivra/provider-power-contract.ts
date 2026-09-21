export type ProviderAgentPowerStage = "dispatch_pending" | "request_uncertain" | "action_pending"
  | "provider_pending" | "runtime_pending" | "public_access_pending" | "reboot_pending"
  | "cancelled" | "cancellation_pending" | "verification_unavailable" | "failed" | "running" | "stopped";

const messages: Record<ProviderAgentPowerStage, string> = {
  dispatch_pending: "The original power request has not been sent yet. Status checks will not send another request.",
  request_uncertain: "The power request may have reached Hetzner, but its receipt could not be confirmed. No retry or forced power-off was sent. Inspect this computer in Hetzner before recovery.",
  action_pending: "Waiting for Hetzner to finish the original power action. This does not yet confirm the computer’s final state.",
  provider_pending: "Checking this computer’s actual power state. No replacement or forced power-off is being started.",
  runtime_pending: "The computer is on. Checking the agent services and native interfaces before reconnecting.",
  public_access_pending: "The agent is available inside its computer. Its public connection has not passed verification yet.",
  reboot_pending: "The computer is still on its previous boot. Restart is not confirmed yet; no forced reset was sent.",
  cancelled: "The power request was not sent. The computer is retained; refresh its state before trying again.",
  cancellation_pending: "Deletion was requested. The original power action must finish before removal can continue in Manage.",
  verification_unavailable: "The last power check could not be verified. The original operation and computer are retained; no automatic retry was sent.",
  failed: "Hetzner reported that the power action failed. The computer is retained for inspection; provider billing may continue.",
  running: "The computer, agent services and public connection passed the power checks.",
  stopped: "Hetzner confirms this computer is off. Its storage and provider charges may remain until you explicitly remove it.",
};

export function providerPowerMessage(stage: unknown): string | null {
  return typeof stage === "string" && Object.hasOwn(messages, stage) ? messages[stage as ProviderAgentPowerStage] : null;
}
