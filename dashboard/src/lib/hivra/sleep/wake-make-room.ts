import "server-only";

import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import { resolveHivraProxmoxHost } from "../proxmox-target";

/**
 * Making room for a wake on a server short of memory.
 *
 * A napping computer keeps all its memory; a deep sleeper keeps none. So when
 * a wake is refused for memory, the server's longest-idle nappers are put into
 * deep sleep, one at a time, until the wake fits. Their owners lose nothing: a
 * deep sleeper picks up where it left off, a few seconds slower than a nap.
 *
 * Off unless HIVRA_WAKE_MAKES_ROOM is on. Never touches an awake computer.
 */

const LOG_SOURCE = "wake-make-room";

/** Most nappers one wake may put into deep sleep. */
export const MAKE_ROOM_MAX_NAPPERS = 4;
/** Longest one wake spends making room; a deep sleep takes about 10 s. */
export const MAKE_ROOM_BUDGET_MS = 45_000;
const CANDIDATE_SCAN = 200;

export function isWakeMakesRoomEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.HIVRA_WAKE_MAKES_ROOM?.trim().toLowerCase();
  return raw === "on" || raw === "1" || raw === "true";
}

export interface MakeRoomResult {
  /** Whether the wake fits now, as `fits` last said. */
  fits: boolean;
  /** Nappers put into deep sleep. */
  deepened: number;
  /** Nappers asked. */
  tried: number;
  ms: number;
}

type NapperRow = { id: string; proxmox_host: string | null };

export interface MakeRoomDeps {
  loadNappers?: (hostId: string, exceptAgentId: string) => Promise<string[]>;
  deepen?: (agentId: string) => Promise<boolean>;
  now?: () => number;
}

/** The server's napping computers with nobody working on them, longest asleep first. */
async function loadNappersOnHost(hostId: string, exceptAgentId: string): Promise<string[]> {
  if (!supabaseAdmin) return [];
  const { data, error } = await supabaseAdmin
    .from("hivra_agents")
    .select("id, proxmox_host")
    .eq("status", "running")
    .eq("desired_state", "running")
    .eq("sleep_state", "napping")
    .is("operation_id", null)
    .eq("deployment_mode", "hivra-managed")
    .eq("computer_substrate", "proxmox-kvm")
    .eq("always_on", false)
    .in("sleep_policy", ["t3", "full"])
    .neq("id", exceptAgentId)
    .order("sleep_tier_changed_at", { ascending: true })
    .limit(CANDIDATE_SCAN);
  if (error) {
    log.warn("could not read nappers to make room for a wake", { source: LOG_SOURCE, failureType: "wake_make_room_query_failed" });
    return [];
  }
  return ((data ?? []) as NapperRow[])
    .filter((row) => resolveHivraProxmoxHost(typeof row.proxmox_host === "string" ? row.proxmox_host : null) === hostId)
    .map((row) => String(row.id));
}

async function deepenNapper(agentId: string): Promise<boolean> {
  // Loaded here: the sleep module itself reads from the wake module.
  const { sleepHivraAgent } = await import("../agent-sleep");
  const outcome = await sleepHivraAgent(agentId, { tier: "hibernate", trigger: "sweep" });
  return outcome.outcome === "slept";
}

/**
 * Put nappers on `hostId` into deep sleep until `fits` says the wake fits, the
 * nappers run out, or the limits are reached. `fits` is asked after each one.
 */
export async function makeRoomForWake(
  input: { agentId: string; hostId: string; fits: () => Promise<boolean> },
  deps: MakeRoomDeps = {},
): Promise<MakeRoomResult> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const deadline = startedAt + MAKE_ROOM_BUDGET_MS;
  const loadNappers = deps.loadNappers ?? loadNappersOnHost;
  const deepen = deps.deepen ?? deepenNapper;
  const result: MakeRoomResult = { fits: false, deepened: 0, tried: 0, ms: 0 };
  let nappers: string[] = [];
  try {
    nappers = await loadNappers(input.hostId, input.agentId);
  } catch {
    nappers = [];
  }
  for (const napper of nappers) {
    if (result.deepened >= MAKE_ROOM_MAX_NAPPERS || result.tried >= MAKE_ROOM_MAX_NAPPERS * 2 || now() >= deadline) break;
    result.tried += 1;
    let slept = false;
    try {
      slept = await deepen(napper);
    } catch {
      slept = false;
    }
    if (!slept) continue;
    result.deepened += 1;
    if (await input.fits().catch(() => false)) {
      result.fits = true;
      break;
    }
  }
  result.ms = now() - startedAt;
  log.info("made room for a wake", {
    source: LOG_SOURCE,
    agentId: input.agentId,
    hostId: input.hostId,
    deepened: result.deepened,
    tried: result.tried,
    fits: result.fits,
    ms: result.ms,
  });
  return result;
}
