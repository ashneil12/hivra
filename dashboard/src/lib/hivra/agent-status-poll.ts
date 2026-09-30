import { manageAwaitsOperation, type ManageCapabilities } from "@/lib/hivra/manage-sections";

/** While an operation is converging, the page's read is what completes it. */
export const CONVERGING_AGENT_POLL_MS = 5_000;
/**
 * A settled page still re-reads its computer. A Start, Restart or Stop can be
 * sent from another tab, the computer list or the API, and on Hivra-managed
 * computers the agent page's read is what drives that operation to completion.
 * A page that stopped reading at Error or Stopped left such an operation open
 * (status `provisioning`) until the page was reloaded.
 */
export const SETTLED_AGENT_POLL_MS = 15_000;

type PolledAgent = { status?: string | null; manage?: ManageCapabilities | null };

/**
 * Delay before the agent page reads the computer again, or null to wait until
 * the tab is visible again (a visible tab resumes reading at once).
 */
export function nextAgentStatusPollMs(agent: PolledAgent | null | undefined, visible: boolean): number | null {
  if (agent?.status === "provisioning" || manageAwaitsOperation(agent?.manage)) return CONVERGING_AGENT_POLL_MS;
  return visible ? SETTLED_AGENT_POLL_MS : null;
}
