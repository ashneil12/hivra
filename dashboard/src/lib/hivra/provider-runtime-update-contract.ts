// What the owner is told about a My cloud runtime update while the agent poll
// observes it (provider-runtime-update.ts). Isomorphic: no server imports.

export type ProviderRuntimeUpdateStage = "updating" | "updated" | "failed" | "verification_unavailable";

export const PROVIDER_RUNTIME_UPDATE_FAILED = "The connection service update didn't finish, so the previous version was put back. Try again.";
export const PROVIDER_RUNTIME_UPDATE_NOT_STARTED = "The connection service update didn't start. Nothing was changed. Try again.";
export const PROVIDER_RUNTIME_UPDATE_LOST = "The connection service update stopped without finishing. If the agent isn't working, restart the computer.";

const messages: Record<Exclude<ProviderRuntimeUpdateStage, "failed">, string> = {
  updating: "Updating the connection service on this computer. It takes a minute or two, and this page shows when it's done.",
  verification_unavailable: "Hivra couldn't reach this computer to check on the update just now. It keeps checking; nothing else was started.",
  updated: "The connection service is up to date.",
};

/** The line for a stage; a failed update is told by the reason the poll recorded. */
export function providerRuntimeUpdateMessage(stage: unknown, error?: string | null): string | null {
  if (stage === "failed") return typeof error === "string" && error ? error : PROVIDER_RUNTIME_UPDATE_FAILED;
  return typeof stage === "string" && Object.hasOwn(messages, stage) ? messages[stage as keyof typeof messages] : null;
}
