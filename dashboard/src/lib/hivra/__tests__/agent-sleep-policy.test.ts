import {
  AUTONOMOUS_KINDS,
  DEFAULT_HIBERNATE_AFTER_NAP_SECONDS,
  DEFAULT_HIBERNATE_AFTER_SECONDS,
  DEFAULT_NAP_AFTER_SECONDS,
  GHOST_TIMER_SECONDS,
  THRASH_MAX_IDLE_SECONDS,
  applyThrashBackoff,
  decideSleep,
  isGhostWake,
  parseSleepMode,
  type SleepPolicyInput,
  type SleepSignals,
} from "../agent-sleep-policy";

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);
const ago = (seconds: number) => NOW - seconds * 1000;

/** Every signal known and quiet, idle for `idle` seconds. */
function quiet(idle: number, extra: SleepSignals = {}): SleepSignals {
  return {
    agentType: "claude-code",
    sampledAt: NOW,
    lastActivityAt: ago(idle),
    activeRun: false,
    operationInFlight: false,
    openConnections: 0,
    terminalAttached: false,
    desktopAttached: false,
    cpuPercent: 0.5,
    nextScheduledJobAt: null,
    socketChannels: [],
    telegramLongPoll: false,
    ...extra,
  };
}
const full: SleepPolicyInput = { sleepPolicy: "full" };

describe("parseSleepMode", () => {
  it.each([
    ["observe", "observe"],
    ["canary", "canary"],
    ["on", "on"],
    ["off", "off"],
    [" ON ", "on"],
    ["Observe", "observe"],
  ])("parses %p", (raw, expected) => expect(parseSleepMode(raw)).toBe(expected));

  it.each([undefined, null, "", "true", "1", "enabled", "yes"])("treats %p as off", (raw) => {
    expect(parseSleepMode(raw)).toBe("off");
  });
});

describe("decideSleep: fail toward awake", () => {
  it("is awake with nothing known, listing every unknown signal", () => {
    const d = decideSleep({}, full, NOW);
    expect(d.verdict).toBe("awake");
    expect(d.idleSeconds).toBeNull();
    expect(d.reasons).toEqual(
      expect.arrayContaining([
        "unknown_signal:sampledAt",
        "unknown_signal:lastActivityAt",
        "unknown_signal:activeRun",
        "unknown_signal:operationInFlight",
        "unknown_signal:openConnections",
        "unknown_signal:terminalAttached",
        "unknown_signal:desktopAttached",
        "unknown_signal:cpuPercent",
        "unknown_signal:nextScheduledJobAt",
        "unknown_signal:socketChannels",
        "unknown_signal:telegramLongPoll",
      ]),
    );
  });

  it.each([
    "lastActivityAt",
    "activeRun",
    "operationInFlight",
    "openConnections",
    "terminalAttached",
    "desktopAttached",
    "cpuPercent",
    "nextScheduledJobAt",
    "socketChannels",
    "telegramLongPoll",
    "sampledAt",
  ] as const)("is awake when only %s is unknown", (field) => {
    const signals = { ...quiet(3600), [field]: undefined };
    const d = decideSleep(signals, full, NOW);
    expect(d.verdict).toBe("awake");
    expect(d.reasons).toContain(`unknown_signal:${field}`);
  });

  it.each([
    ["sampledAt", NaN],
    ["sampledAt", Infinity],
    ["sampledAt", -1],
    ["cpuPercent", NaN],
    ["cpuPercent", -5],
    ["openConnections", NaN],
    ["openConnections", Infinity],
    ["nextScheduledJobAt", NaN],
    ["nextScheduledJobAt", -1],
    ["lastActivityAt", NaN],
  ] as const)("treats %s = %p as unknown, not quiet", (field, value) => {
    const d = decideSleep({ ...quiet(3600), [field]: value }, full, NOW);
    expect(d.verdict).toBe("awake");
    expect(d.reasons).toContain(`unknown_signal:${field}`);
  });

  it("is awake when the signals are dated in the future beyond clock skew", () => {
    const d = decideSleep(quiet(3600, { sampledAt: NOW + 10 * 60_000 }), full, NOW);
    expect(d.verdict).toBe("awake");
    expect(d.reasons).toContain("stale_signals");
  });

  it("tolerates a small clock skew on sampledAt", () => {
    expect(decideSleep(quiet(3600, { sampledAt: NOW + 30_000 }), full, NOW).verdict).toBe("would_hibernate");
  });

  it("is awake when the signals are stale", () => {
    const d = decideSleep(quiet(3600, { sampledAt: ago(10 * 60) }), full, NOW);
    expect(d.verdict).toBe("awake");
    expect(d.reasons).toContain("stale_signals");
  });

  it("is awake, not idle, when the agent has never been active", () => {
    const d = decideSleep(quiet(0, { lastActivityAt: null }), full, NOW);
    expect(d.verdict).toBe("awake");
    expect(d.reasons).toContain("no_activity_baseline");
  });

  it("treats activity in the future as no idle time", () => {
    const d = decideSleep(quiet(0, { lastActivityAt: NOW + 60_000 }), full, NOW);
    expect(d).toMatchObject({ verdict: "awake", idleSeconds: 0 });
  });
});

describe("decideSleep: ineligible", () => {
  it("is ineligible when always_on, whatever the policy", () => {
    const d = decideSleep(quiet(3600), { ...full, alwaysOn: true }, NOW);
    expect(d).toMatchObject({ verdict: "ineligible", reasons: ["always_on"] });
  });

  it("is ineligible when the agent policy is off or unset", () => {
    expect(decideSleep(quiet(3600), { sleepPolicy: "off" }, NOW).reasons).toContain("policy_off");
    expect(decideSleep(quiet(3600), {}, NOW).verdict).toBe("ineligible");
  });

  it.each(AUTONOMOUS_KINDS)("is ineligible for the autonomous kind %s", (kind) => {
    const d = decideSleep(quiet(3600, { agentType: kind }), full, NOW);
    expect(d).toMatchObject({ verdict: "ineligible", reasons: [`autonomous_kind:${kind}`] });
  });

  it.each(["discord", "whatsapp", "slack"])("is ineligible with a live %s socket", (channel) => {
    const d = decideSleep(quiet(3600, { socketChannels: [channel] }), full, NOW);
    expect(d).toMatchObject({ verdict: "ineligible", reasons: [`socket_channel:${channel}`] });
  });

  it("ignores channels that hold no socket", () => {
    expect(decideSleep(quiet(3600, { socketChannels: ["email"] }), full, NOW).verdict).toBe("would_hibernate");
  });

  it("is ineligible on Telegram long-poll unless opted in", () => {
    const signals = quiet(3600, { telegramLongPoll: true });
    expect(decideSleep(signals, full, NOW).reasons).toEqual(["telegram_long_poll"]);
    expect(decideSleep(signals, { ...full, telegramOptIn: true }, NOW).verdict).toBe("would_hibernate");
  });

  it("reports ineligibility even when other signals are unknown", () => {
    const d = decideSleep({ agentType: "aeon" }, full, NOW);
    expect(d.verdict).toBe("ineligible");
  });
});

describe("decideSleep: anything in flight keeps the agent awake", () => {
  it.each([
    ["an active run", { activeRun: true }, "active_run"],
    ["a lifecycle operation", { operationInFlight: true }, "operation_in_flight"],
    ["open connections", { openConnections: 2 }, "open_connections"],
    ["an attached terminal", { terminalAttached: true }, "terminal_attached"],
    ["an attached desktop", { desktopAttached: true }, "desktop_attached"],
    ["high CPU", { cpuPercent: 40 }, "cpu_busy"],
    ["a job in 10 minutes", { nextScheduledJobAt: NOW + 10 * 60_000 }, "scheduled_job_soon"],
    ["a job that is overdue", { nextScheduledJobAt: NOW - 60_000 }, "scheduled_job_soon"],
  ] as const)("is awake with %s", (_label, extra, reason) => {
    const d = decideSleep(quiet(3600, extra), full, NOW);
    expect(d.verdict).toBe("awake");
    expect(d.reasons).toContain(reason);
  });

  it("does not mind a job more than 15 minutes away", () => {
    const d = decideSleep(quiet(3600, { nextScheduledJobAt: NOW + 20 * 60_000 }), full, NOW);
    expect(d.verdict).toBe("would_hibernate");
  });
});

describe("decideSleep: idle thresholds", () => {
  it("defaults to a 4 minute nap, then 12 minutes napping before hibernate", () => {
    expect(DEFAULT_NAP_AFTER_SECONDS).toBe(240);
    expect(DEFAULT_HIBERNATE_AFTER_NAP_SECONDS).toBe(720);
    expect(DEFAULT_HIBERNATE_AFTER_SECONDS).toBe(960);
    // The design says hibernate after 10-15 min in the nap tier, entered at 3-5 min.
    expect(DEFAULT_HIBERNATE_AFTER_SECONDS).toBeGreaterThanOrEqual(13 * 60);
    expect(DEFAULT_HIBERNATE_AFTER_SECONDS).toBeLessThanOrEqual(20 * 60);
  });

  it("is awake just under the nap window", () => {
    expect(decideSleep(quiet(DEFAULT_NAP_AFTER_SECONDS - 1), full, NOW)).toMatchObject({
      verdict: "awake",
      reasons: ["recently_active"],
    });
  });

  it("naps at the nap window", () => {
    expect(decideSleep(quiet(DEFAULT_NAP_AFTER_SECONDS), full, NOW).verdict).toBe("would_nap");
    expect(decideSleep(quiet(DEFAULT_HIBERNATE_AFTER_SECONDS - 1), full, NOW).verdict).toBe("would_nap");
  });

  it("hibernates at the hibernate window", () => {
    const d = decideSleep(quiet(DEFAULT_HIBERNATE_AFTER_SECONDS), full, NOW);
    expect(d).toMatchObject({ verdict: "would_hibernate", idleSeconds: DEFAULT_HIBERNATE_AFTER_SECONDS });
  });

  it("honours custom windows", () => {
    const input = { ...full, napAfterSeconds: 60, hibernateAfterNapSeconds: 60 };
    expect(decideSleep(quiet(59), input, NOW).verdict).toBe("awake");
    expect(decideSleep(quiet(60), input, NOW).verdict).toBe("would_nap");
    expect(decideSleep(quiet(119), input, NOW).verdict).toBe("would_nap");
    expect(decideSleep(quiet(120), input, NOW).verdict).toBe("would_hibernate");
  });

  it("limits the verdict to the tiers the policy allows", () => {
    expect(decideSleep(quiet(600), { sleepPolicy: "t1" }, NOW).verdict).toBe("would_nap");
    expect(decideSleep(quiet(3600), { sleepPolicy: "t1" }, NOW).verdict).toBe("would_nap");
    expect(decideSleep(quiet(600), { sleepPolicy: "t3" }, NOW)).toMatchObject({
      verdict: "awake",
      reasons: ["policy_tier_not_allowed"],
    });
    expect(decideSleep(quiet(3600), { sleepPolicy: "t3" }, NOW).verdict).toBe("would_hibernate");
  });

  it("only hibernates a desktop kind", () => {
    const desktop = { agentType: "linux-desktop" };
    expect(decideSleep(quiet(600, desktop), full, NOW)).toMatchObject({
      verdict: "awake",
      reasons: ["desktop_kind_hibernate_only"],
    });
    expect(decideSleep(quiet(3600, desktop), full, NOW).verdict).toBe("would_hibernate");
  });

  it("applies thrash backoff to the windows", () => {
    const wakes = [ago(60), ago(300), ago(600)];
    const input = { ...full, recentWakes: wakes };
    expect(decideSleep(quiet(DEFAULT_NAP_AFTER_SECONDS), input, NOW).verdict).toBe("awake");
    expect(decideSleep(quiet(DEFAULT_NAP_AFTER_SECONDS * 2), input, NOW).verdict).toBe("would_nap");
  });
});

describe("applyThrashBackoff", () => {
  const base = 240;

  it("leaves the window alone below 3 wakes in 30 minutes", () => {
    expect(applyThrashBackoff(base, undefined, NOW)).toBe(base);
    expect(applyThrashBackoff(base, [ago(10), ago(20)], NOW)).toBe(base);
  });

  it("ignores wakes older than 30 minutes", () => {
    expect(applyThrashBackoff(base, [ago(10), ago(20), ago(31 * 60)], NOW)).toBe(base);
  });

  it("doubles at 3 wakes and again for each further wake", () => {
    expect(applyThrashBackoff(base, [ago(10), ago(20), ago(30)], NOW)).toBe(base * 2);
    expect(applyThrashBackoff(base, [ago(10), ago(20), ago(30), ago(40)], NOW)).toBe(base * 4);
  });

  it("caps at 2 hours", () => {
    const many = Array.from({ length: 12 }, (_, i) => ago(10 + i));
    expect(applyThrashBackoff(base, many, NOW)).toBe(THRASH_MAX_IDLE_SECONDS);
  });

  it("never shortens a window that is already past the cap", () => {
    const wakes = [ago(10), ago(20), ago(30)];
    expect(applyThrashBackoff(THRASH_MAX_IDLE_SECONDS + 600, wakes, NOW)).toBe(THRASH_MAX_IDLE_SECONDS + 600);
  });
});

describe("ghost timer", () => {
  it("is 2 minutes", () => expect(GHOST_TIMER_SECONDS).toBe(120));

  it("flags a pre-wake with no request once the timer runs out", () => {
    expect(isGhostWake(ago(GHOST_TIMER_SECONDS - 1), NOW)).toBe(false);
    expect(isGhostWake(ago(GHOST_TIMER_SECONDS), NOW)).toBe(true);
  });
});
