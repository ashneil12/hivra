/** What the hero shows: a count and the day it was read (UTC, YYYY-MM-DD). */
export interface AgentsDeployedSnapshot {
  total: number;
  asOf: string;
}

/** "20 October 2026": spelled out, UTC, the same on every server (as the pricing page writes its dates). */
export function formatAsOf(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
