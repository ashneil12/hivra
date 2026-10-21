/** Pure rules for the public /week page. No network. */

const MS_DAY = 24 * 60 * 60 * 1000;
const STALE_AFTER_MS = 7 * MS_DAY;

export const WEEK_PULL_URL = "https://github.com/ashneil12/hivra/pull";

export interface WeekPull {
  number: number;
  title: string;
  /** GitHub `state`. Missing means treat as open when it was not merged. */
  state?: string;
  draft?: boolean;
  merged_at?: string | null;
  updated_at?: string | null;
  closed_at?: string | null;
}

export interface ShippedPull {
  number: number;
  title: string;
  /** ISO timestamp from GitHub `merged_at`. */
  mergedAt: string;
  url: string;
}

export interface StuckPull {
  number: number;
  title: string;
  /** "Draft", or "No update in N days". */
  reason: string;
  url: string;
}

export function pullUrl(number: number): string {
  return `${WEEK_PULL_URL}/${number}`;
}

/** Monday 00:00:00.000 UTC through the following Monday, end exclusive. */
export function weekRange(now: Date): { start: Date; end: Date } {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const weekday = new Date(midnight).getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  const startMs = midnight - daysSinceMonday * MS_DAY;
  return { start: new Date(startMs), end: new Date(startMs + 7 * MS_DAY) };
}

function time(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? null : value;
}

function isOpen(pull: WeekPull): boolean {
  if (pull.state) return pull.state === "open";
  return time(pull.merged_at) === null;
}

/** Merged into main on or after this Monday UTC, and before next Monday. Closed-unmerged is not shipped. */
export function shippedThisWeek(pulls: readonly WeekPull[], now: Date): ShippedPull[] {
  const { start, end } = weekRange(now);
  const startMs = start.getTime();
  const endMs = end.getTime();

  return pulls
    .flatMap((pull) => {
      const mergedAt = time(pull.merged_at);
      if (mergedAt === null || mergedAt < startMs || mergedAt >= endMs) return [];
      return [{ number: pull.number, title: pull.title, mergedAt: pull.merged_at as string, url: pullUrl(pull.number) }];
    })
    .sort((a, b) => time(b.mergedAt)! - time(a.mergedAt)! || b.number - a.number);
}

function staleDays(updatedAt: string | null | undefined, now: Date): number | null {
  const updated = time(updatedAt);
  if (updated === null) return null;
  const age = now.getTime() - updated;
  if (age <= STALE_AFTER_MS) return null;
  return Math.floor(age / MS_DAY);
}

/**
 * Open pull requests that are drafts, or whose `updated_at` is older than 7 days.
 * A draft is reported as "Draft" even when it is also stale.
 */
export function stuckPulls(pulls: readonly WeekPull[], now: Date): StuckPull[] {
  return pulls
    .flatMap((pull) => {
      if (!isOpen(pull)) return [];
      if (pull.draft) {
        return [{ number: pull.number, title: pull.title, reason: "Draft", url: pullUrl(pull.number) }];
      }
      const days = staleDays(pull.updated_at, now);
      if (days === null) return [];
      return [{ number: pull.number, title: pull.title, reason: `No update in ${days} days`, url: pullUrl(pull.number) }];
    })
    .sort((a, b) => a.number - b.number);
}

/** Open, not a draft, and updated within the last 7 days (the 7-day mark itself still counts as moving). */
export function stillMovingCount(pulls: readonly WeekPull[], now: Date): number {
  return pulls.filter((pull) => {
    if (!isOpen(pull) || pull.draft) return false;
    const updated = time(pull.updated_at);
    if (updated === null) return false;
    const age = now.getTime() - updated;
    return age >= 0 && age <= STALE_AFTER_MS;
  }).length;
}
