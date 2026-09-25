// What GET /api/hivra/agents/[id]/usage sends: a computer's live usage and
// uptime as its owner may see it. Pure and client-safe. The server builds it
// from one host observation (computer-usage.ts); it never carries a host name,
// address, binding value or another computer's data.

import { z } from "zod";

export const COMPUTER_USAGE_SOURCES = ["proxmox", "hetzner", "gvisor", "digitalocean"] as const;
export type ComputerUsageSource = (typeof COMPUTER_USAGE_SOURCES)[number];

/** How long a stored observation is served without reading the host again. */
export const COMPUTER_USAGE_FRESH_SECONDS = 20;
/** An observation older than this is shown as stale. */
export const COMPUTER_USAGE_STALE_SECONDS = 60;

/**
 * Why part of the usage is missing or out of date, for the page to explain:
 * - vm_missing: the host holds no computer with this ID;
 * - guest_agent_unavailable: running, but its guest agent didn't answer, so
 *   there is no disk use;
 * - resources_unavailable: the host didn't report CPU and power state;
 * - host_unreachable: this read failed, so the last observation is shown;
 * - status_changed: the computer changed state after the last observation
 *   and it couldn't be read again yet.
 */
export const COMPUTER_USAGE_NOTES = [
  "vm_missing", "guest_agent_unavailable", "resources_unavailable", "host_unreachable", "status_changed",
] as const;
export type ComputerUsageNote = (typeof COMPUTER_USAGE_NOTES)[number];

export const COMPUTER_POWER_OBSERVED = ["running", "stopped", "paused", "missing", "unknown"] as const;
export type ComputerPowerObserved = (typeof COMPUTER_POWER_OBSERVED)[number];

const count = z.number().finite().nonnegative();

export const ComputerUsageViewSchema = z.object({
  /** false: Hivra can't read live usage for this computer; `reason` says why. */
  supported: z.boolean(),
  source: z.enum(COMPUTER_USAGE_SOURCES),
  reason: z.string().max(300).optional(),
  /** When the host was read (ISO), or null when it hasn't been yet. */
  observedAt: z.string().max(64).nullable(),
  ageSeconds: count.nullable(),
  stale: z.boolean(),
  /** Another request is reading the host right now; ask again shortly. */
  refreshing: z.boolean(),
  power: z.object({
    observed: z.enum(COMPUTER_POWER_OBSERVED),
    /** The state Hivra has on record. */
    recorded: z.string().max(32),
    /** false: the host and Hivra's record disagree. null: not compared. */
    matches: z.boolean().nullable(),
  }).strict(),
  /** Time since the computer was last switched on (a restart from inside it doesn't reset it). */
  uptimeSeconds: count.nullable(),
  cpu: z.object({ percent: z.number().min(0).max(100), vcpus: count }).strict().nullable(),
  memory: z.object({
    usedBytes: count,
    maximumBytes: count,
    /** The host counts the computer's file cache as in use. */
    includesCache: z.boolean(),
  }).strict().nullable(),
  disk: z.object({
    /** From the computer's own guest agent; null when it didn't answer. */
    usedBytes: count.nullable(),
    sizeBytes: count.nullable(),
    /** The disk the host gave the computer. */
    allocatedBytes: count.nullable(),
    filesystem: z.string().max(16).nullable(),
    guestReported: z.boolean(),
  }).strict().nullable(),
  /** For computers without live usage: the size Hivra has on record. */
  size: z.object({ cpu: count, ramGb: count }).strict().optional(),
  notes: z.array(z.enum(COMPUTER_USAGE_NOTES)).max(COMPUTER_USAGE_NOTES.length),
}).strict();

export type ComputerUsageView = z.infer<typeof ComputerUsageViewSchema>;

const GIB = 1024 ** 3;

/** Bytes as the product's "GB" (binary, like every computer size in Hivra). */
export function formatUsageGb(bytes: number): string {
  const value = bytes / GIB;
  if (value >= 100) return String(Math.round(value));
  const tenths = Math.round(value * 10) / 10;
  return Number.isInteger(tenths) ? String(tenths) : tenths.toFixed(1);
}

function unit(value: number, one: string): string {
  return `${value} ${one}${value === 1 ? "" : "s"}`;
}

/** "7 days 23 hours", "5 hours 12 minutes", "3 minutes", "under a minute". */
export function formatUptime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (days > 0) return hours > 0 ? `${unit(days, "day")} ${unit(hours, "hour")}` : unit(days, "day");
  if (hours > 0) return minutes > 0 ? `${unit(hours, "hour")} ${unit(minutes, "minute")}` : unit(hours, "hour");
  if (minutes > 0) return unit(minutes, "minute");
  return "under a minute";
}

/** "just now", "12 s ago", "3 min ago", "2 h ago", "3 days ago". */
export function formatUsageAge(seconds: number): string {
  const age = Math.max(0, Math.floor(seconds));
  if (age < 5) return "just now";
  if (age < 60) return `${age} s ago`;
  if (age < 3_600) return `${Math.floor(age / 60)} min ago`;
  if (age < 86_400) return `${Math.floor(age / 3_600)} h ago`;
  return `${unit(Math.floor(age / 86_400), "day")} ago`;
}
