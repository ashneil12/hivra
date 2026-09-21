import "server-only";

import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";

export interface AgentsDeployedStats {
  total: number;
  last24h: number;
  last7d: number;
  series?: { date: string; count: number }[];
  firstDeployAt?: string | null;
  sourceCounts?: {
    hermesInstances: number;
    hivraAgents: number;
    archivedInstances: number;
  };
  generatedAt: string;
}

interface RpcResult {
  total: number | string;
  last24h: number | string;
  last7d: number | string;
  series?: { date: string; count: number | string }[];
  firstDeployAt?: string | null;
  sourceCounts?: {
    hermesInstances?: number | string | null;
    hivraAgents?: number | string | null;
    archivedInstances?: number | string | null;
  } | null;
  generatedAt: string;
}

function emptyStats(): AgentsDeployedStats {
  return {
    total: 0,
    last24h: 0,
    last7d: 0,
    generatedAt: new Date().toISOString(),
  };
}

function toNumber(value: number | string | null | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export async function getAgentsDeployedStats(opts?: {
  series?: boolean;
  firstDeploy?: boolean;
}): Promise<AgentsDeployedStats> {
  if (!supabaseAdmin) {
    log.warn(
      "agents-deployed: supabaseAdmin is null (env vars missing in this environment)",
      { source: "agents-deployed-stats" },
    );
    return emptyStats();
  }

  const { data, error } = await supabaseAdmin.rpc("get_agents_deployed_stats", {
    p_with_series: Boolean(opts?.series),
    p_with_first_deploy: Boolean(opts?.firstDeploy),
  });

  if (error) {
    log.error(
      "agents-deployed: rpc failed",
      new Error(error.message || "rpc returned error without message"),
      {
        source: "agents-deployed-stats",
        code: error.code ?? null,
        details: error.details ?? null,
        hint: error.hint ?? null,
      },
    );
    return emptyStats();
  }

  if (!data || typeof data !== "object") {
    log.error(
      "agents-deployed: rpc returned no data",
      new Error("rpc returned no data"),
      {
        source: "agents-deployed-stats",
        includeSeries: Boolean(opts?.series),
        includeFirstDeploy: Boolean(opts?.firstDeploy),
        dataType: data === null ? "null" : typeof data,
      },
    );
    return emptyStats();
  }

  const payload = data as RpcResult;

  const result: AgentsDeployedStats = {
    total: toNumber(payload.total),
    last24h: toNumber(payload.last24h),
    last7d: toNumber(payload.last7d),
    generatedAt: payload.generatedAt ?? new Date().toISOString(),
  };

  if (opts?.series && Array.isArray(payload.series)) {
    result.series = payload.series.map((row) => ({
      date: row.date,
      count: toNumber(row.count),
    }));
  }

  if (opts?.firstDeploy) {
    result.firstDeployAt = payload.firstDeployAt ?? null;
  }

  if (payload.sourceCounts && typeof payload.sourceCounts === "object") {
    result.sourceCounts = {
      hermesInstances: toNumber(payload.sourceCounts.hermesInstances),
      hivraAgents: toNumber(payload.sourceCounts.hivraAgents),
      archivedInstances: toNumber(payload.sourceCounts.archivedInstances),
    };
  }

  return result;
}
