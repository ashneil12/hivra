// src/lib/daily-brief-shared.ts
//
// Client-SAFE constants + pure matchers for the platform "Daily brief" job, so
// both the server sweep (daily-brief.ts, which re-exports these) and client
// surfaces (TasksPanel) agree on what counts as the platform job. NO server-only
// imports here.

/** The exact job name that marks the platform daily-brief job. */
export const DAILY_BRIEF_NAME = "Daily brief";
/** 08:00 UTC daily — a morning brief. */
export const DAILY_BRIEF_SCHEDULE = "0 8 * * *";
export const DAILY_BRIEF_DELIVER = "local";

/**
 * True when a box cron job is named like the platform "Daily brief" job. Used for
 * read-back lookup + the sweep's own idempotency guard (we control creation, so a
 * name match is enough there).
 */
export function isDailyBriefJob(job: unknown): boolean {
  return Boolean(job) && typeof job === "object" && (job as { name?: unknown }).name === DAILY_BRIEF_NAME;
}

/**
 * Stricter match for the FREE-TIER count exclusion (and the client's own count):
 * the job must look like the platform-seeded brief (our exact name AND schedule),
 * so a user can't win a free extra standing task just by naming a task "Daily
 * brief". They'd have to match both our name and our precise cron string.
 */
export function isPlatformDailyBriefJob(job: unknown): boolean {
  if (!job || typeof job !== "object") return false;
  const j = job as { name?: unknown; schedule?: unknown };
  return j.name === DAILY_BRIEF_NAME && j.schedule === DAILY_BRIEF_SCHEDULE;
}
