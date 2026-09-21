import "server-only";

import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";

/**
 * Telegram activation: of the users who deployed an agent, what share have
 * connected Telegram? This is the metric behind the "70-90% of deployers
 * connect" goal. It reads the persisted channel_connections signal (which
 * outlives any single box) rather than a live probe.
 *
 * "Connected" is counted ever (a connection persists), intersected with the
 * set of users who deployed inside the window — so the rate answers "of recent
 * deployers, how many ever connected", not "connected within N days".
 */

export interface TelegramActivationStats {
  generatedAt: string;
  windowDays: number;
  /** Distinct users who deployed ≥1 agent (either lane) in the window. */
  deployers: number;
  /** Of those deployers, how many have a Telegram connection on record. */
  connectedDeployers: number;
  /** connectedDeployers / deployers (0..1), 0 when there are no deployers. */
  rate: number;
  /** Telegram connections recorded within the window, split by lane. */
  connectionsInWindow: { total: number; hivra: number; hermes: number };
}

const PAGE_SIZE = 1000;
const DAY_MS = 86_400_000;

// ---------- pure helpers (unit-tested) ----------

export function activationRate(deployers: number, connectedDeployers: number): number {
  if (deployers <= 0) return 0;
  return Math.round((connectedDeployers / deployers) * 1000) / 1000;
}

export function intersectionCount(a: Set<string>, b: Set<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let n = 0;
  for (const v of small) if (large.has(v)) n += 1;
  return n;
}

// ---------- queries ----------

type AdminClient = NonNullable<typeof supabaseAdmin>;

async function fetchAllPages<T>(
  label: string,
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message?: string } | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${label}: ${error.message || "query failed"}`);
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return rows;
  }
}

async function fetchDeployerUserIds(client: AdminClient, windowStartIso: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const hermes = await fetchAllPages<{ user_id: string | null }>("activation hermes deployers", (from, to) =>
    client.from("hermes_instances").select("user_id").gte("created_at", windowStartIso).order("id").range(from, to),
  );
  for (const r of hermes) if (r.user_id) ids.add(r.user_id);

  // Hivra agents are the other deploy lane. Isolate this fetch so a surface
  // without the hivra_agents table degrades to a hermes-only deployer count
  // rather than zeroing the whole activation card.
  try {
    const hivra = await fetchAllPages<{ user_id: string | null }>("activation hivra deployers", (from, to) =>
      client.from("hivra_agents").select("user_id").gte("created_at", windowStartIso).order("id").range(from, to),
    );
    for (const r of hivra) if (r.user_id) ids.add(r.user_id);
  } catch {
    log.warn("telegram-activation: hivra_agents unavailable, counting hermes-only deployers", {
      source: "telegram-activation",
    });
  }

  return ids;
}

export async function getTelegramActivationStats(windowDays: number, now = new Date()): Promise<TelegramActivationStats> {
  const empty: TelegramActivationStats = {
    generatedAt: now.toISOString(),
    windowDays,
    deployers: 0,
    connectedDeployers: 0,
    rate: 0,
    connectionsInWindow: { total: 0, hivra: 0, hermes: 0 },
  };
  if (!supabaseAdmin) {
    log.warn("telegram-activation: supabaseAdmin is null (env vars missing)", { source: "telegram-activation" });
    return empty;
  }
  const client = supabaseAdmin;
  const windowStartIso = new Date(now.getTime() - windowDays * DAY_MS).toISOString();

  try {
    const deployerIds = await fetchDeployerUserIds(client, windowStartIso);

    const connections = await fetchAllPages<{ user_id: string; target_kind: string; connected_at: string }>(
      "activation telegram connections",
      (from, to) =>
        client
          .from("channel_connections")
          .select("user_id, target_kind, connected_at")
          .eq("channel", "telegram")
          .order("id")
          .range(from, to),
    );

    const connectedUserIds = new Set(connections.map((c) => c.user_id).filter(Boolean));
    const inWindow = { total: 0, hivra: 0, hermes: 0 };
    for (const c of connections) {
      if (Date.parse(c.connected_at) >= now.getTime() - windowDays * DAY_MS) {
        inWindow.total += 1;
        if (c.target_kind === "hivra") inWindow.hivra += 1;
        else if (c.target_kind === "hermes") inWindow.hermes += 1;
      }
    }

    const connectedDeployers = intersectionCount(deployerIds, connectedUserIds);
    return {
      generatedAt: now.toISOString(),
      windowDays,
      deployers: deployerIds.size,
      connectedDeployers,
      rate: activationRate(deployerIds.size, connectedDeployers),
      connectionsInWindow: inWindow,
    };
  } catch (error) {
    log.error(
      "telegram-activation: query failed",
      error instanceof Error ? error : new Error(String(error)),
      { source: "telegram-activation" },
    );
    return empty;
  }
}
