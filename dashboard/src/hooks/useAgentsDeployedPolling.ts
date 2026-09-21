"use client";

import { useEffect, useState } from "react";
import { pollWhenVisible } from "@/lib/poll-when-visible";

export interface AgentsDeployedPollState {
  total: number;
  last24h: number;
  last7d: number;
  series?: { date: string; count: number }[];
  generatedAt?: string;
}

interface UseAgentsDeployedPollingOpts {
  initial?: AgentsDeployedPollState | null;
  includeSeries?: boolean;
  pollMs?: number;
  bumpDurationMs?: number;
}

export function useAgentsDeployedPolling({
  initial = null,
  includeSeries = false,
  pollMs = 60_000,
  bumpDurationMs = 1200,
}: UseAgentsDeployedPollingOpts = {}) {
  const [stats, setStats] = useState<AgentsDeployedPollState | null>(initial);
  const [bumped, setBumped] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const url = includeSeries
      ? "/api/stats/agents-deployed?series=1"
      : "/api/stats/agents-deployed";

    async function fetchOnce() {
      try {
        // Plain fetch (no `cache: "no-store"`): the route returns a
        // `public, s-maxage` response, so polls collapse onto Vercel's edge
        // cache instead of hitting the Fluid function on every visitor's tick.
        // `no-store` sent a no-cache request header that bypassed the edge and
        // ran the 2 GB function ~once per visitor per poll — the dominant
        // source of this endpoint's invocation + Fluid cost.
        const res = await fetch(url);
        if (!res.ok) return;
        const data = (await res.json()) as AgentsDeployedPollState;
        if (cancelled) return;
        setStats((prev) => {
          if (prev && data.total > prev.total) {
            setBumped(true);
            window.setTimeout(() => setBumped(false), bumpDurationMs);
          }
          return data;
        });
      } catch {
        // ignore — next poll retries
      }
    }

    fetchOnce();
    const id = window.setInterval(pollWhenVisible(fetchOnce), pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [includeSeries, pollMs, bumpDurationMs]);

  return { stats, bumped };
}
