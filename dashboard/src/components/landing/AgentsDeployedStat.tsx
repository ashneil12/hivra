import { getAgentsDeployedStats } from "@/lib/agents-deployed-stats";
import { log } from "@/lib/logger";

import AgentsDeployedStatClient from "./AgentsDeployedStat.client";

/**
 * Server wrapper: fetches the initial agents-deployed count so the hero readout
 * renders with a real number on first paint (then the client polls for updates).
 */
export default async function AgentsDeployedStat() {
  let initial: { total: number; last24h: number; last7d: number } | null = null;
  try {
    const stats = await getAgentsDeployedStats();
    initial = { total: stats.total, last24h: stats.last24h, last7d: stats.last7d };
  } catch (err) {
    log.error("agents-deployed hero stat initial fetch failed", err as Error, {
      source: "AgentsDeployedStat",
    });
  }
  return <AgentsDeployedStatClient initial={initial} />;
}
