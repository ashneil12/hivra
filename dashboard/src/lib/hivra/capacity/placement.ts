import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import { CAPACITY_READING_MAX_AGE_MS, hostCapacityAlertsEnabled } from "@/lib/hivra/capacity/classify";
import { readStoredCapacity } from "@/lib/hivra/capacity/sweep";

/**
 * Placement's use of the capacity readings: a new agent is not put on a host
 * whose latest reading is critical, as long as another host can take it.
 *
 * Fails open everywhere. Flag off, no database, a failed query, no reading, an
 * old reading, or every host critical: nothing is skipped and placement
 * behaves exactly as it did before.
 */

type EnvLike = Record<string, string | undefined>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the admin client is untyped here, as in the other sweeps
type Db = any;

export { CAPACITY_READING_MAX_AGE_MS };

export async function loadCapacityCriticalHostIds(
  deps: { db?: Db; env?: EnvLike; now?: () => number } = {},
): Promise<string[]> {
  try {
    if (!hostCapacityAlertsEnabled(deps.env ?? process.env)) return [];
    const db = deps.db ?? supabaseAdmin;
    if (!db) return [];
    const { data, error } = await db
      .from("proxmox_hosts")
      .select("id, capacity_reading")
      .eq("status", "active");
    if (error || !Array.isArray(data) || data.length === 0) return [];
    const now = (deps.now ?? Date.now)();
    const critical = data.filter((row: { capacity_reading: unknown }) => {
      const reading = readStoredCapacity(row.capacity_reading);
      if (!reading || reading.level !== "critical") return false;
      const age = now - Date.parse(reading.at);
      return Number.isFinite(age) && age >= 0 && age <= CAPACITY_READING_MAX_AGE_MS;
    }).map((row: { id: unknown }) => String(row.id));
    // Every host critical: skipping them all would only block the launch.
    return critical.length === data.length ? [] : critical;
  } catch {
    return [];
  }
}

/**
 * Runs a placement first without the critical hosts, and again with every host
 * when that finds nothing, so a launch is never refused because of a reading.
 * A forced host (the caller's sticky or pinned choice) is left alone.
 */
export async function selectAvoidingCriticalHosts<T extends { ok: boolean }>(
  select: (excludeTargetIds: string[] | undefined) => Promise<T>,
  options: { forced?: boolean; db?: Db; env?: EnvLike; now?: () => number } = {},
): Promise<T> {
  const critical = options.forced ? [] : await loadCapacityCriticalHostIds(options);
  if (critical.length === 0) return select(undefined);
  const preferred = await select(critical);
  if (preferred.ok) return preferred;
  log.warn("host capacity: no other host could take the launch; trying the critical hosts too", {
    source: "hivra-host-capacity",
    failureType: "host_capacity_placement_fell_back",
    skippedHosts: critical,
  });
  return select(undefined);
}
