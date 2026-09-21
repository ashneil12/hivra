import {
  parseLogLineTimestampMs,
  countRecentTransportFailures,
  decideRestart,
} from "@/lib/recovery/autoheal-llm-transport-failures";

// Format an epoch-ms as the leading `YYYY-MM-DD HH:MM:SS,mmm` of a hermes log
// line (UTC), then append a representative transport-failure tail.
function logLine(ms: number, tail = "ERROR agent.conversation_loop: API call failed after 3 retries. [Errno 32] Broken pipe"): string {
  const iso = new Date(ms).toISOString(); // 2026-07-07T18:38:34.690Z
  const prefix = `${iso.slice(0, 10)} ${iso.slice(11, 19)},${iso.slice(20, 23)}`;
  return `${prefix} ${tail}`;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

describe("parseLogLineTimestampMs", () => {
  it("parses a valid hermes log prefix as UTC", () => {
    const ms = Date.UTC(2026, 6, 7, 18, 38, 34); // seconds resolution
    expect(parseLogLineTimestampMs(logLine(ms))).toBe(ms);
  });

  it("returns null for lines without a parseable timestamp prefix", () => {
    expect(parseLogLineTimestampMs("not a log line")).toBeNull();
    expect(parseLogLineTimestampMs("")).toBeNull();
    expect(parseLogLineTimestampMs("__SKIP__")).toBeNull();
  });
});

describe("countRecentTransportFailures", () => {
  const now = Date.UTC(2026, 6, 7, 20, 0, 0);

  it("counts only lines inside the freshness window", () => {
    const lines = [
      logLine(now - 2 * MIN), // in
      logLine(now - 10 * MIN), // in
      logLine(now - 25 * MIN), // out (> 20m)
      logLine(now - 3 * HOUR), // out
    ];
    expect(countRecentTransportFailures(lines, now)).toBe(2);
  });

  it("ignores unparseable lines", () => {
    const lines = [logLine(now - 1 * MIN), "garbage", ""];
    expect(countRecentTransportFailures(lines, now)).toBe(1);
  });

  it("returns 0 when every failure is stale", () => {
    expect(
      countRecentTransportFailures([logLine(now - 40 * MIN)], now),
    ).toBe(0);
  });
});

describe("decideRestart", () => {
  const now = Date.UTC(2026, 6, 7, 20, 0, 0);

  it("restarts when there is no prior history", () => {
    expect(decideRestart([], now)).toBe("restart");
  });

  it("holds off while inside the cooldown", () => {
    expect(decideRestart([now - 10 * MIN], now)).toBe("cooldown");
  });

  it("restarts again once cooldown has elapsed and attempts remain", () => {
    expect(decideRestart([now - 40 * MIN], now)).toBe("restart");
  });

  it("gives up (exhausted) after the max restarts within the window", () => {
    const priors = [now - 40 * MIN, now - 2 * HOUR, now - 3 * HOUR];
    expect(decideRestart(priors, now)).toBe("exhausted");
  });

  it("does not count restarts older than the attempt window toward the cap", () => {
    // 2 in-window (40m, 2h) + 1 outside the 6h window (7h) → still allowed.
    const priors = [now - 40 * MIN, now - 2 * HOUR, now - 7 * HOUR];
    expect(decideRestart(priors, now)).toBe("restart");
  });

  it("cooldown takes precedence over an otherwise-exhausted history", () => {
    const priors = [now - 5 * MIN, now - 2 * HOUR, now - 3 * HOUR];
    expect(decideRestart(priors, now)).toBe("cooldown");
  });
});
