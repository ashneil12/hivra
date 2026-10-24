import "server-only";

import { unstable_cache } from "next/cache";

import { getAgentsDeployedStats, type AgentsDeployedStats } from "@/lib/agents-deployed-stats";
import type { AgentsDeployedSnapshot } from "./agents-deployed-format";

export type { AgentsDeployedSnapshot };

/**
 * A count the page may show, or null. The lookup reports a failure as a total
 * of 0 (it never throws), so 0 means "unknown" here and the stat is hidden:
 * the page never shows 0, and never an old or sample number.
 */
export function toSnapshot(stats: Pick<AgentsDeployedStats, "total" | "generatedAt">, now: Date = new Date()): AgentsDeployedSnapshot | null {
  if (!Number.isFinite(stats.total) || stats.total <= 0) return null;
  const read = new Date(stats.generatedAt);
  const day = Number.isNaN(read.getTime()) ? now : read;
  return { total: Math.floor(stats.total), asOf: day.toISOString().slice(0, 10) };
}

// The same source as /stats (the get_agents_deployed_stats RPC), read at most
// once every five minutes per server. A failed read throws inside the cache
// callback so that it is never stored as a count.
const readCount = unstable_cache(
  async () => {
    const snapshot = toSnapshot(await getAgentsDeployedStats());
    if (!snapshot) throw new Error("agents-deployed count unavailable");
    return snapshot;
  },
  ["home-agents-deployed"],
  { revalidate: 300 },
);

// After a failed read, leave the database alone for a minute instead of
// retrying on every visit.
const RETRY_AFTER_MS = 60_000;
let retryAt = 0;

/** The live count for the hero, or null when it cannot be read or is zero. Never throws. */
export async function getHomeAgentsDeployed(now: number = Date.now()): Promise<AgentsDeployedSnapshot | null> {
  if (now < retryAt) return null;
  try {
    return await readCount();
  } catch {
    retryAt = now + RETRY_AFTER_MS;
    return null;
  }
}
