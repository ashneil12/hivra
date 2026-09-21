import type { HivraAgent } from "./agent-api";

/** Older servers may omit activity. Do not infer a fresh install from a URL or
 * the overloaded provisioning status, which also covers restarts and resizes. */
export function agentActivityPresentation(
  agent: Pick<HivraAgent, "activity" | "provisioned_at" | "cpu" | "ram" | "computer_profile" | "type">,
  productName: string,
) {
  const freshLaunch = agent.activity === "provision" && !agent.provisioned_at;
  const computerOnly = agent.type === "linux-desktop" || agent.computer_profile !== null;
  if (freshLaunch) return {
    label: "setting up",
    verb: "Setting up",
    body: computerOnly
      ? `Preparing your ${agent.cpu} CPU / ${agent.ram} GB computer and installing ${productName}. Once it is ready, you can open its desktop, terminal, and files. No agent is attached. First-time installations can take longer. You can leave this page and return later; status checks continue automatically while it is open.`
      : `Preparing your ${agent.cpu} CPU / ${agent.ram} GB computer and installing ${productName}. Once it is ready, you can open the agent and connect any accounts it needs. First-time installations can take longer. You can leave this page and return later; status checks continue automatically while it is open.`,
    freshLaunch,
  };
  const activity = {
    cancelling: { label: "cancelling", verb: "Cancelling", body: "Deletion was requested. Waiting for the current operation to stop before removing this computer and its access resources. This page updates automatically." },
    start: { label: "starting", verb: "Starting", body: "Starting your existing computer and checking its access services. Your files stay on its disk. This page updates automatically." },
    stop: { label: "stopping", verb: "Stopping", body: "Stopping your computer. Files remain on its disk. Stopping does not cancel your plan or any provider billing. This page updates automatically." },
    restart: { label: "restarting", verb: "Restarting", body: "Rebooting your existing computer and checking its access services. This does not reinstall the agent or erase your files. This page updates automatically." },
    resize: { label: "resizing", verb: "Resizing", body: "Applying your resource change and rebooting your existing computer. This does not reinstall the agent or erase your files. This page updates automatically." },
    delete: { label: "deleting", verb: "Deleting", body: "Removing this computer and its access resources. Cleanup must finish before it is marked deleted. This page updates automatically." },
  };
  const knownActivity = agent.activity && Object.prototype.hasOwnProperty.call(activity, agent.activity)
    ? activity[agent.activity as keyof typeof activity]
    : null;
  return {
    ...(knownActivity ?? {
      label: "updating",
      verb: "Updating",
      body: "Waiting for the computer’s latest state. This page updates automatically.",
    }),
    freshLaunch: false,
  };
}
