import {
  getArchiveCountdownDays,
  shouldShowArchiveUpgradeWall,
  RECLAIM_ARCHIVE_AFTER_DAYS,
  type ArchiveCountdownInstance,
} from "../archive-countdown";
import type { PlanInfo } from "../agent-api";

const NOW = new Date("2026-07-09T12:00:00.000Z");

function pausedDaysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

// An inactivity-paused free agent, paused `pausedDays` ago.
function inactivityPaused(pausedDays: number): ArchiveCountdownInstance {
  return {
    lifecycle_state: "paused",
    paused_reason: "inactivity",
    last_lifecycle_transition_at: pausedDaysAgo(pausedDays),
  };
}

const FREE_PLAN: PlanInfo = {
  subscribed: false,
  name: "Free",
  key: "free",
  maxAgents: 1,
  maxCpuPerAgent: 0.5,
  maxRamPerAgent: 1,
  poolCpu: 0.5,
  poolRam: 1,
};
const PRO_PLAN: PlanInfo = { ...FREE_PLAN, subscribed: true, name: "Pro", key: "operator" };

describe("getArchiveCountdownDays", () => {
  it("counts down to the reclaim deadline (paused_at + reclaim window)", () => {
    // Paused 4 days ago → 7 - 4 = 3 days until archive.
    expect(getArchiveCountdownDays(inactivityPaused(4), NOW)).toBe(3);
    // Just paused → the full window remains.
    expect(getArchiveCountdownDays(inactivityPaused(0), NOW)).toBe(RECLAIM_ARCHIVE_AFTER_DAYS);
  });

  it("clamps an already-overdue row to 0 (imminent), never negative", () => {
    expect(getArchiveCountdownDays(inactivityPaused(9), NOW)).toBe(0);
  });

  it("returns null for a paid/non-inactivity or otherwise ineligible row", () => {
    // Not paused for inactivity — capacity pressure, RAM cap, already archived.
    expect(
      getArchiveCountdownDays({ ...inactivityPaused(4), paused_reason: "capacity_pressure" }, NOW)
    ).toBeNull();
    expect(
      getArchiveCountdownDays({ ...inactivityPaused(4), paused_reason: "ram_cap_hit" }, NOW)
    ).toBeNull();
    expect(
      getArchiveCountdownDays({ ...inactivityPaused(4), paused_reason: "cold_archived" }, NOW)
    ).toBeNull();
    // Not in the paused lifecycle at all (active/running).
    expect(
      getArchiveCountdownDays({ ...inactivityPaused(4), lifecycle_state: "active" }, NOW)
    ).toBeNull();
    // Missing / unparseable transition timestamp.
    expect(
      getArchiveCountdownDays({ lifecycle_state: "paused", paused_reason: "inactivity", last_lifecycle_transition_at: null }, NOW)
    ).toBeNull();
    expect(getArchiveCountdownDays(null, NOW)).toBeNull();
  });
});

describe("shouldShowArchiveUpgradeWall", () => {
  const base = { instance: inactivityPaused(4), now: NOW };

  it("shows only for a FREE plan, an inactivity-archiving agent, and the flag ON", () => {
    expect(shouldShowArchiveUpgradeWall({ enabled: true, plan: FREE_PLAN, ...base })).toBe(true);
  });

  it("NEVER shows for a paying customer (paid-safe)", () => {
    expect(shouldShowArchiveUpgradeWall({ enabled: true, plan: PRO_PLAN, ...base })).toBe(false);
  });

  it("NEVER shows on a non-inactivity archival", () => {
    expect(
      shouldShowArchiveUpgradeWall({
        enabled: true,
        plan: FREE_PLAN,
        instance: { ...inactivityPaused(4), paused_reason: "cold_archived" },
        now: NOW,
      })
    ).toBe(false);
  });

  it("NEVER shows when the flag is OFF", () => {
    expect(shouldShowArchiveUpgradeWall({ enabled: false, plan: FREE_PLAN, ...base })).toBe(false);
  });

  it("does not show before the plan resolves (null plan is treated as NOT free)", () => {
    expect(shouldShowArchiveUpgradeWall({ enabled: true, plan: null, ...base })).toBe(false);
  });
});
