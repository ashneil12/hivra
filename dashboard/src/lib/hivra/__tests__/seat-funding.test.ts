import { decideSleep, DEFAULT_HIBERNATE_AFTER_SECONDS, DEFAULT_NAP_AFTER_SECONDS } from "../agent-sleep-policy";
import {
  effectiveAlwaysOn,
  effectiveSleepPolicy,
  HOLDER_SEAT_HIBERNATE_AFTER_NAP_SECONDS,
  HOLDER_SEAT_HIBERNATE_TOTAL_SECONDS,
  HOLDER_SEAT_NAP_AFTER_SECONDS,
  holderHibernateBoundaryReason,
  isHolderFundedSeat,
} from "../seat-funding";

const idleSignals = {
  sampledAt: 1_000_000,
  lastActivityAt: 0,
  activeRun: false,
  operationInFlight: false,
  openConnections: 0,
  terminalAttached: false,
  desktopAttached: false,
  cpuPercent: 0,
  nextScheduledJobAt: null,
  socketChannels: [],
  telegramLongPoll: false,
};

describe("seat funding sleep controls", () => {
  it("uses only the authoritative per-seat funding cohort", () => {
    expect(isHolderFundedSeat({ seat_funding: "holder" })).toBe(true);
    expect(isHolderFundedSeat({ seat_funding: "paid" })).toBe(false);
    expect(isHolderFundedSeat({ seat_funding: null })).toBe(false);
    expect(isHolderFundedSeat({ seat_funding: "holder", always_on: true })).toBe(true);
  });

  it("overrides stale holder controls without changing paid or unknown seats", () => {
    expect(effectiveAlwaysOn({ seat_funding: "holder", always_on: true })).toBe(false);
    expect(effectiveSleepPolicy({ seat_funding: "holder", sleep_policy: "off" })).toBe("full");
    expect(effectiveAlwaysOn({ seat_funding: "paid", always_on: true })).toBe(true);
    expect(effectiveSleepPolicy({ seat_funding: "paid", sleep_policy: "off" })).toBe("off");
    expect(effectiveAlwaysOn({ seat_funding: null, always_on: true })).toBe(true);
    expect(effectiveSleepPolicy({ seat_funding: null, sleep_policy: "off" })).toBe("off");
  });

  it("keeps the fixed existing holder timing contract", () => {
    expect(HOLDER_SEAT_NAP_AFTER_SECONDS).toBe(240);
    expect(HOLDER_SEAT_HIBERNATE_AFTER_NAP_SECONDS).toBe(720);
    expect(HOLDER_SEAT_HIBERNATE_TOTAL_SECONDS).toBe(960);
    expect(DEFAULT_NAP_AFTER_SECONDS).toBe(240);
    expect(DEFAULT_HIBERNATE_AFTER_SECONDS).toBe(960);
  });

  it("does not let stale holder always-on or policy-off values make the pure decision ineligible", () => {
    const decision = decideSleep(idleSignals, {
      holderFunded: true,
      alwaysOn: true,
      sleepPolicy: "off",
      napAfterSeconds: 240,
      hibernateAfterNapSeconds: 720,
    }, 1_000_000);
    expect(decision.verdict).toBe("would_hibernate");
    const paid = decideSleep(idleSignals, { alwaysOn: true, sleepPolicy: "off" }, 1_000_000);
    expect(paid.verdict).toBe("ineligible");
    expect(paid.reasons).toEqual(expect.arrayContaining(["always_on", "policy_off"]));
  });

  it("enforces the 16-minute total holder boundary through the nap tier", () => {
    const now = Date.parse("2026-11-24T12:00:00Z");
    expect(holderHibernateBoundaryReason({
      row: { seat_funding: "holder" }, tier: "hibernate", state: "awake", nowMs: now,
    })).toBe("hibernate_before_nap");
    expect(holderHibernateBoundaryReason({
      row: { seat_funding: "holder", sleep_tier_changed_at: "2026-11-24T11:48:30Z" },
      tier: "hibernate", state: "napping", nowMs: now,
    })).toBe("hibernate_window_open");
    expect(holderHibernateBoundaryReason({
      row: { seat_funding: "holder", sleep_tier_changed_at: "2026-11-24T11:48:00Z" },
      tier: "hibernate", state: "napping", nowMs: now,
    })).toBeNull();
    expect(holderHibernateBoundaryReason({
      row: { seat_funding: "paid", sleep_tier_changed_at: "2026-11-24T11:59:59Z" },
      tier: "hibernate", state: "napping", nowMs: now,
    })).toBeNull();
  });
});
