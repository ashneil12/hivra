/**
 * Measured memory use per agent, kept as one row: the last sample and a peak
 * per UTC day for two weeks. The capacity sweep writes it from the per-VM
 * lines of the host probe. Nothing here changes an agent or a host.
 */
import { resolveHivraProxmoxHost } from "@/lib/hivra/proxmox-target";
import type { VmMemorySample } from "@/lib/hivra/capacity/host-probe";

type EnvLike = Record<string, string | undefined>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the admin client is untyped here, as in the other sweeps
type Db = any;

export const MEMORY_USE_WINDOW_DAYS = 14;
const DAY_KEY = /^\d{4}-\d\d-\d\d$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const SAMPLE_MAX_MB = 4_194_304;

/** HIVRA_AGENT_MEMORY_SAMPLING=1: the capacity sweep also records each running agent's memory use. Off unless exactly 1. */
export function agentMemorySamplingEnabled(env: EnvLike = process.env): boolean {
  return env.HIVRA_AGENT_MEMORY_SAMPLING?.trim() === "1";
}

export type MemoryUseDays = Record<string, { peak: number; n: number }>;

export type StoredMemoryUse = {
  agent_id: string;
  vmid: number;
  total_mb: number;
  last_used_mb: number;
  first_sample_at: string;
  last_sample_at: string;
  days: MemoryUseDays;
};

/** Only well-formed days inside the window, so a bad stored value never grows or poisons the row. */
function cleanDays(value: unknown, nowMs: number): MemoryUseDays {
  const out: MemoryUseDays = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  const oldest = new Date(nowMs - (MEMORY_USE_WINDOW_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
  const today = new Date(nowMs).toISOString().slice(0, 10);
  for (const [day, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!DAY_KEY.test(day) || day < oldest || day > today) continue;
    const e = entry as { peak?: unknown; n?: unknown } | null;
    if (!e || !Number.isInteger(e.peak) || !Number.isInteger(e.n)) continue;
    const peak = e.peak as number;
    const n = e.n as number;
    if (peak < 0 || peak > SAMPLE_MAX_MB || n <= 0 || n > 1_000_000) continue;
    out[day] = { peak, n };
  }
  return out;
}

/** The row after one more sample. A row for another VM (the agent was rebuilt) starts again. Pure. */
export function foldMemorySample(
  previous: StoredMemoryUse | null,
  agentId: string,
  sample: VmMemorySample,
  nowMs: number,
): StoredMemoryUse {
  const at = new Date(nowMs).toISOString();
  const day = at.slice(0, 10);
  const same = previous !== null && previous.vmid === sample.vmid;
  const days = same ? cleanDays(previous.days, nowMs) : {};
  const before = days[day];
  days[day] = { peak: Math.max(before?.peak ?? 0, sample.usedMb), n: (before?.n ?? 0) + 1 };
  const firstMs = same ? Date.parse(previous.first_sample_at) : Number.NaN;
  return {
    agent_id: agentId,
    vmid: sample.vmid,
    total_mb: sample.totalMb,
    last_used_mb: sample.usedMb,
    first_sample_at: Number.isFinite(firstMs) && firstMs <= nowMs ? new Date(firstMs).toISOString() : at,
    last_sample_at: at,
    days,
  };
}

/** What the floor calculation needs from a stored row: the peak, the sample count and the span, all inside the window. */
export function summarizeMemoryUse(stored: StoredMemoryUse, nowMs: number): { peakUsedMb: number | null; samples: number; spanHours: number } {
  const days = Object.entries(cleanDays(stored.days, nowMs));
  if (days.length === 0) return { peakUsedMb: null, samples: 0, spanHours: 0 };
  const firstMs = Date.parse(stored.first_sample_at);
  const lastMs = Date.parse(stored.last_sample_at);
  const oldestDayMs = Date.parse(`${days.map(([day]) => day).sort()[0]}T00:00:00Z`);
  const fromMs = Math.max(Number.isFinite(firstMs) ? firstMs : oldestDayMs, oldestDayMs);
  const spanHours = Number.isFinite(lastMs) && lastMs > fromMs ? (lastMs - fromMs) / 3_600_000 : 0;
  return {
    peakUsedMb: Math.max(...days.map(([, entry]) => entry.peak)),
    samples: days.reduce((sum, [, entry]) => sum + entry.n, 0),
    spanHours,
  };
}

/**
 * Store one host's samples against the agents that own those VMs on that host.
 * A VM with no agent row on this host is ignored. Never throws.
 */
export async function recordHostMemorySamples(
  db: Db,
  hostId: string,
  samples: VmMemorySample[],
  nowMs: number,
): Promise<{ recorded: number; failed: boolean }> {
  if (samples.length === 0) return { recorded: 0, failed: false };
  try {
    const byVmid = new Map(samples.map((sample) => [sample.vmid, sample]));
    const { data: agentData, error: agentError } = await db
      .from("hivra_agents")
      .select("id, vmid, proxmox_host")
      .eq("deployment_mode", "hivra-managed")
      .eq("computer_substrate", "proxmox-kvm")
      .is("deployment_target_id", null)
      .neq("status", "deleted")
      .in("vmid", [...byVmid.keys()]);
    if (agentError) return { recorded: 0, failed: true };
    const host = hostId.toLowerCase();
    const seen = new Map<number, string | null>();
    for (const row of (agentData ?? []) as Array<{ id: string; vmid: number | null; proxmox_host: string | null }>) {
      if (resolveHivraProxmoxHost(row.proxmox_host).toLowerCase() !== host || row.vmid === null) continue;
      // Two rows claiming one VM: neither gets the sample.
      seen.set(row.vmid, seen.has(row.vmid) ? null : row.id);
    }
    const owners = [...seen].filter((entry): entry is [number, string] => entry[1] !== null);
    if (owners.length === 0) return { recorded: 0, failed: false };

    const { data: storedData, error: storedError } = await db
      .from("hivra_agent_memory_use")
      .select("agent_id, vmid, total_mb, last_used_mb, first_sample_at, last_sample_at, days")
      .in("agent_id", owners.map(([, id]) => id));
    if (storedError) return { recorded: 0, failed: true };
    const stored = new Map(((storedData ?? []) as StoredMemoryUse[]).map((row) => [row.agent_id, row]));
    const updatedAt = new Date(nowMs).toISOString();
    const rows = owners.map(([vmid, id]) => ({
      ...foldMemorySample(stored.get(id) ?? null, id, byVmid.get(vmid) as VmMemorySample, nowMs),
      updated_at: updatedAt,
    }));
    const { error: writeError } = await db.from("hivra_agent_memory_use").upsert(rows, { onConflict: "agent_id" });
    return writeError ? { recorded: 0, failed: true } : { recorded: rows.length, failed: false };
  } catch {
    return { recorded: 0, failed: true };
  }
}
