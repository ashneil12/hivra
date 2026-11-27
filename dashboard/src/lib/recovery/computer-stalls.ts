import "server-only";

import { reportOpsEvent } from "@/lib/ops-events";
import { supabaseAdmin } from "@/lib/supabase";

export const COMPUTER_STALL_CRON = "computer-stalls";
export const COMPUTER_STALL_ROUTE = "/api/cron/computer-stalls";

const sources = {
  provisioning: "synthetic.computer-stall.provisioning",
  health: "synthetic.computer-stall.health",
} as const;

interface StallSignal {
  signal_key: string;
  kind: "classic" | "native";
  instance_id: string;
  reason: keyof typeof sources;
  host: string | null;
  since: string | null;
  verdict: "open" | "cleared" | "unknown" | "pending";
}

interface OpenIncident {
  id: string;
  instance_id: string;
  source: string;
  last_seen_at: string;
}

const PAGE_SIZE = 250;

export async function runComputerStallScan() {
  const db = supabaseAdmin;
  if (!db) throw new Error("Supabase admin client not configured");

  const now = new Date().toISOString();
  const open: OpenIncident[] = [];
  const signals = new Map<string, StallSignal>();

  for (let cursor = ""; ;) {
    const query = db.from("ops_events")
      .select("id,instance_id,source,last_seen_at")
      .in("source", Object.values(sources))
      .is("archived_at", null)
      .lt("last_seen_at", now)
      .order("id")
      .limit(PAGE_SIZE);
    const { data, error } = await (cursor ? query.gt("id", cursor) : query);
    if (error) throw new Error("Could not read open computer stall incidents");
    open.push(...data);
    if (data.length < PAGE_SIZE) break;
    cursor = data[data.length - 1].id;
  }

  for (let cursor = ""; ;) {
    const query = db.rpc("list_computer_stalls", { p_now: now }).order("signal_key").limit(PAGE_SIZE);
    const { data, error } = await (cursor ? query.gt("signal_key", cursor) : query);
    if (error) throw new Error("Could not read computer stall signals");
    for (const signal of data as StallSignal[]) {
      signals.set(`${sources[signal.reason]}:${signal.instance_id}`, signal);
    }
    if (data.length < PAGE_SIZE) break;
    cursor = data[data.length - 1].signal_key;
  }

  const summary = { reported: 0, archived: 0, failed: 0 };
  for (const signal of signals.values()) {
    if (signal.verdict !== "open") continue;
    const provisioning = signal.reason === "provisioning";
    const result = await reportOpsEvent({
      source: sources[signal.reason],
      route: COMPUTER_STALL_ROUTE,
      instanceId: signal.instance_id,
      severity: "error",
      title: provisioning ? "Computer stuck provisioning" : "Running computer unhealthy",
      message: provisioning
        ? "The computer has been in provisioning for more than an hour."
        : "The running computer has failed its health probe for more than an hour.",
      metadata: {
        instance_id: signal.instance_id,
        host: signal.host,
        computer_kind: signal.kind,
        since: signal.since,
      },
      page: true,
      resetFirstSeenOnReopen: true,
      observedAt: now,
    });
    if (!result) summary.failed++;
    else if (result.id) summary.reported++;
  }

  for (const incident of open) {
    const signal = signals.get(`${incident.source}:${incident.instance_id}`);
    if (signal && signal.verdict !== "cleared") continue;
    const { data, error } = await db.from("ops_events")
      .update({ archived_at: now, archived_by_user_id: null })
      .eq("id", incident.id)
      .eq("last_seen_at", incident.last_seen_at)
      .is("archived_at", null)
      .select("id");
    if (error) summary.failed++;
    else summary.archived += data.length;
  }

  return summary;
}
