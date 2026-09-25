/**
 * @jest-environment node
 */
import {
  DEFAULT_DEDUPE_HOURS,
  DEFAULT_MIN_ATTEMPTS,
  DEFAULT_MIN_UPSTREAM_BALANCE_USD,
  DEFAULT_SETTLE_GRACE_MINUTES,
  DEFAULT_WARN_CAPTURE_RATIO,
  DEFAULT_WARN_MIN_ATTEMPTS,
  DEFAULT_WINDOW_HOURS,
  VENICE_RATE_LIMITS_URL,
  buildDroughtOpsEvent,
  buildProbeOpsEvent,
  evaluateCaptureDrought,
  probeManagedVeniceUpstream,
  readCaptureDroughtCounts,
  resolveManagedVeniceHealthConfig,
  resolveProbeKey,
  runCaptureDroughtDetector,
  wasOpsEventRecentlyReported,
  type CaptureDroughtResult,
  type ManagedVeniceHealthConfig,
  type SupabaseLike,
} from "@/lib/ops/managed-venice-health";

const CONFIG: ManagedVeniceHealthConfig = resolveManagedVeniceHealthConfig({});
const WINDOW_START = "2026-07-16T00:00:00.000Z";

function droughtInput(attempts: number, captured: number) {
  return { attempts, captured, windowStartIso: WINDOW_START, config: CONFIG };
}

describe("resolveManagedVeniceHealthConfig", () => {
  it("returns the documented defaults with an empty env", () => {
    expect(CONFIG).toEqual({
      windowHours: DEFAULT_WINDOW_HOURS,
      minAttempts: DEFAULT_MIN_ATTEMPTS,
      warnMinAttempts: DEFAULT_WARN_MIN_ATTEMPTS,
      warnCaptureRatio: DEFAULT_WARN_CAPTURE_RATIO,
      settleGraceMinutes: DEFAULT_SETTLE_GRACE_MINUTES,
      dedupeHours: DEFAULT_DEDUPE_HOURS,
      minUpstreamBalanceUsd: DEFAULT_MIN_UPSTREAM_BALANCE_USD,
    });
  });

  it("honors env overrides", () => {
    const config = resolveManagedVeniceHealthConfig({
      MANAGED_VENICE_HEALTH_WINDOW_HOURS: "12",
      MANAGED_VENICE_HEALTH_MIN_ATTEMPTS: "10",
      MANAGED_VENICE_HEALTH_WARN_MIN_ATTEMPTS: "20",
      MANAGED_VENICE_HEALTH_WARN_CAPTURE_RATIO: "0.5",
      MANAGED_VENICE_HEALTH_SETTLE_GRACE_MINUTES: "2",
      MANAGED_VENICE_HEALTH_DEDUPE_HOURS: "1",
      MANAGED_VENICE_HEALTH_MIN_UPSTREAM_BALANCE_USD: "25",
    });
    expect(config).toEqual({
      windowHours: 12,
      minAttempts: 10,
      warnMinAttempts: 20,
      warnCaptureRatio: 0.5,
      settleGraceMinutes: 2,
      dedupeHours: 1,
      minUpstreamBalanceUsd: 25,
    });
  });

  it("falls back to defaults on garbage / non-positive / out-of-range values", () => {
    const config = resolveManagedVeniceHealthConfig({
      MANAGED_VENICE_HEALTH_WINDOW_HOURS: "banana",
      MANAGED_VENICE_HEALTH_MIN_ATTEMPTS: "-3",
      MANAGED_VENICE_HEALTH_WARN_MIN_ATTEMPTS: "0",
      // A ratio > 1 makes no sense — reject it, keep the default.
      MANAGED_VENICE_HEALTH_WARN_CAPTURE_RATIO: "4",
      MANAGED_VENICE_HEALTH_DEDUPE_HOURS: "",
    });
    expect(config).toEqual(CONFIG);
  });
});

describe("evaluateCaptureDrought", () => {
  it("is CRITICAL at exactly the minimum attempts with zero captures", () => {
    const result = evaluateCaptureDrought(droughtInput(3, 0));
    expect(result.level).toBe("critical");
    expect(result.reason).toContain("3 attempts, 0 captures");
    expect(result.reason).toContain(WINDOW_START);
  });

  it("is CRITICAL on many attempts with zero captures (beats the WARN rule)", () => {
    const result = evaluateCaptureDrought(droughtInput(40, 0));
    expect(result.level).toBe("critical");
  });

  it("stays quiet below the minimum attempts even with zero captures", () => {
    expect(evaluateCaptureDrought(droughtInput(2, 0)).level).toBe("healthy");
    expect(evaluateCaptureDrought(droughtInput(0, 0)).level).toBe("healthy");
    expect(evaluateCaptureDrought(droughtInput(0, 0)).captureRatio).toBeNull();
  });

  it("WARNs when the capture ratio is below 25% with enough attempts", () => {
    const result = evaluateCaptureDrought(droughtInput(5, 1)); // 20%
    expect(result.level).toBe("warn");
    expect(result.captureRatio).toBeCloseTo(0.2);
  });

  it("does not WARN below the warn attempt floor", () => {
    // 1/4 = 25%... make it strictly below: 4 attempts, 0 captured is critical,
    // so use 4 attempts / 1 captured = 25% (not below floor anyway) — the
    // interesting case is a degraded ratio with too few attempts:
    const result = evaluateCaptureDrought({
      attempts: 4,
      captured: 1,
      windowStartIso: WINDOW_START,
      config: { ...CONFIG, warnCaptureRatio: 0.5 },
    });
    expect(result.level).toBe("healthy");
  });

  it("treats a ratio exactly at the floor as healthy (strictly-below semantics)", () => {
    const result = evaluateCaptureDrought(droughtInput(8, 2)); // exactly 25%
    expect(result.level).toBe("healthy");
  });

  it("is healthy on a normal capture ratio", () => {
    const result = evaluateCaptureDrought(droughtInput(10, 9));
    expect(result.level).toBe("healthy");
    expect(result.captureRatio).toBeCloseTo(0.9);
  });
});

interface RecordedFilter {
  capturedOnly: boolean;
  gte: [string, string] | null;
  lt: [string, string] | null;
  in: [string, readonly string[]] | null;
}

function makeReservationDb(counts: { attempts: number; captured: number }) {
  const filters: RecordedFilter[] = [];
  const db: SupabaseLike = {
    from: (table: string) => {
      if (table !== "managed_venice_reservations") {
        throw new Error(`unexpected table ${table}`);
      }
      return {
        select: () => {
          const recorded: RecordedFilter = { capturedOnly: false, gte: null, lt: null, in: null };
          filters.push(recorded);
          const chain = {
            eq: (col: string, val: string) => {
              if (col === "status" && val === "captured") recorded.capturedOnly = true;
              return chain;
            },
            gte: (col: string, val: string) => {
              recorded.gte = [col, val];
              return chain;
            },
            lt: (col: string, val: string) => {
              recorded.lt = [col, val];
              return chain;
            },
            in: (col: string, vals: readonly string[]) => {
              recorded.in = [col, vals];
              return chain;
            },
            then: (resolve: (value: { count: number; error: null }) => unknown) =>
              Promise.resolve({
                count: recorded.capturedOnly ? counts.captured : counts.attempts,
                error: null,
              }).then(resolve),
          };
          return chain;
        },
      };
    },
  };
  return { db, filters };
}

describe("readCaptureDroughtCounts", () => {
  it("counts attempts and captures over the same created_at window", async () => {
    const { db, filters } = makeReservationDb({ attempts: 7, captured: 2 });
    const window = {
      windowStartIso: "2026-07-16T00:00:00.000Z",
      windowEndIso: "2026-07-16T05:50:00.000Z",
    };

    const counts = await readCaptureDroughtCounts(db, window);

    expect(counts).toEqual({ attempts: 7, captured: 2 });
    expect(filters).toHaveLength(2);
    const attemptsFilter = filters.find((f) => !f.capturedOnly);
    const capturedFilter = filters.find((f) => f.capturedOnly);
    for (const filter of [attemptsFilter, capturedFilter]) {
      expect(filter?.gte).toEqual(["created_at", window.windowStartIso]);
      expect(filter?.lt).toEqual(["created_at", window.windowEndIso]);
    }
  });

  it("counts only chat holds, so media holds the billing-off gate releases are not read as failures", async () => {
    const { db, filters } = makeReservationDb({ attempts: 7, captured: 2 });
    await readCaptureDroughtCounts(db, {
      windowStartIso: "2026-07-16T00:00:00.000Z",
      windowEndIso: "2026-07-16T05:50:00.000Z",
    });
    for (const filter of filters) {
      expect(filter.in).toEqual(["endpoint", ["/api/v1/chat/completions", "/api/v1/responses"]]);
    }
  });

  it("throws on a query error", async () => {
    const db: SupabaseLike = {
      from: () => ({
        select: () => {
          const chain = {
            eq: () => chain,
            gte: () => chain,
            lt: () => chain,
            in: () => chain,
            then: (resolve: (value: unknown) => unknown) =>
              Promise.resolve({ count: null, error: { message: "boom" } }).then(resolve),
          };
          return chain;
        },
      }),
    };
    await expect(
      readCaptureDroughtCounts(db, {
        windowStartIso: WINDOW_START,
        windowEndIso: WINDOW_START,
      })
    ).rejects.toThrow("boom");
  });
});

describe("runCaptureDroughtDetector", () => {
  it("derives the window from now minus grace, then applies the drought math", async () => {
    const { db, filters } = makeReservationDb({ attempts: 5, captured: 0 });
    const nowMs = Date.parse("2026-07-16T12:00:00.000Z");

    const result = await runCaptureDroughtDetector(db, CONFIG, nowMs);

    expect(result.level).toBe("critical");
    // Window end = now - 10min grace; window start = end - 6h.
    expect(filters[0].lt?.[1]).toBe("2026-07-16T11:50:00.000Z");
    expect(filters[0].gte?.[1]).toBe("2026-07-16T05:50:00.000Z");
    expect(result.windowStartIso).toBe("2026-07-16T05:50:00.000Z");
  });
});

function rateLimitsResponse(
  body: unknown,
  status = 200
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("resolveProbeKey", () => {
  it("prefers the FIRST pool key over the legacy key", () => {
    const resolved = resolveProbeKey({
      MANAGED_VENICE_INFERENCE_KEYS: JSON.stringify(["pool_key_1", "pool_key_2"]),
      VENICE_API_KEY: "legacy_key",
    });
    expect(resolved).toEqual({ key: "pool_key_1", source: "pool", poolSize: 2 });
  });

  it("falls back to the legacy VENICE_API_KEY", () => {
    const resolved = resolveProbeKey({ VENICE_API_KEY: " legacy_key " });
    expect(resolved).toEqual({ key: "legacy_key", source: "legacy", poolSize: 1 });
  });

  it("returns null when nothing is configured", () => {
    expect(resolveProbeKey({})).toBeNull();
  });
});

describe("probeManagedVeniceUpstream", () => {
  const env = { VENICE_API_KEY: "venice_test_key" };

  it("skips when no key is configured server-side", async () => {
    const fetchImpl = jest.fn();
    const result = await probeManagedVeniceUpstream({ env: {}, fetchImpl });
    expect(result.status).toBe("skipped");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("probes the rate-limits endpoint with the resolved key", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      rateLimitsResponse({ data: { accessPermitted: true, balances: { USD: 120.5, DIEM: 3 } } })
    );

    const result = await probeManagedVeniceUpstream({ env, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(
      VENICE_RATE_LIMITS_URL,
      expect.objectContaining({
        headers: { Authorization: "Bearer venice_test_key" },
      })
    );
    expect(result.status).toBe("healthy");
    expect(result.balanceUsd).toBe(120.5);
    expect(result.balanceDiem).toBe(3);
    expect(result.accessPermitted).toBe(true);
    expect(result.keySource).toBe("legacy");
  });

  it("maps a 402 to CRITICAL (upstream out of funds)", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response("Payment Required", { status: 402 }));
    const result = await probeManagedVeniceUpstream({ env, fetchImpl });
    expect(result.status).toBe("critical");
    expect(result.httpStatus).toBe(402);
    expect(result.reason).toContain("out of funds");
  });

  it.each([401, 403])("maps a %i to CRITICAL (key rejected)", async (status) => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response("nope", { status }));
    const result = await probeManagedVeniceUpstream({ env, fetchImpl });
    expect(result.status).toBe("critical");
    expect(result.httpStatus).toBe(status);
  });

  it("maps accessPermitted=false to CRITICAL even on a 200", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      rateLimitsResponse({ data: { accessPermitted: false, balances: { USD: 0 } } })
    );
    const result = await probeManagedVeniceUpstream({ env, fetchImpl });
    expect(result.status).toBe("critical");
    expect(result.balanceUsd).toBe(0);
  });

  it("WARNs on a low USD balance", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      rateLimitsResponse({ data: { accessPermitted: true, balances: { USD: 2.25 } } })
    );
    const result = await probeManagedVeniceUpstream({ env, fetchImpl, minBalanceUsd: 5 });
    expect(result.status).toBe("warn");
    expect(result.balanceUsd).toBe(2.25);
  });

  it("is healthy when the response exposes no balance block", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(rateLimitsResponse({ data: {} }));
    const result = await probeManagedVeniceUpstream({ env, fetchImpl });
    expect(result.status).toBe("healthy");
    expect(result.balanceUsd).toBeNull();
  });

  it.each([404, 429, 500])("treats HTTP %i as inconclusive (no page)", async (status) => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response("err", { status }));
    const result = await probeManagedVeniceUpstream({ env, fetchImpl });
    expect(result.status).toBe("inconclusive");
  });

  it("treats a network failure as inconclusive, never throws", async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new TypeError("fetch failed"));
    const result = await probeManagedVeniceUpstream({ env, fetchImpl });
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toContain("TypeError");
  });

  it("treats an unparseable 2xx body as inconclusive", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(new Response("<html>not json</html>", { status: 200 }));
    const result = await probeManagedVeniceUpstream({ env, fetchImpl });
    expect(result.status).toBe("inconclusive");
  });
});

describe("ops-event construction", () => {
  const context = { source: "cron/managed-venice-health", route: "/api/cron/managed-venice-health" };

  function droughtResult(level: CaptureDroughtResult["level"]): CaptureDroughtResult {
    return {
      level,
      attempts: 6,
      captured: level === "critical" ? 0 : 1,
      captureRatio: level === "critical" ? 0 : 1 / 6,
      windowStartIso: WINDOW_START,
      reason: "test reason",
    };
  }

  it("maps CRITICAL drought to a fatal event with volatile numbers in metadata only", () => {
    const event = buildDroughtOpsEvent(droughtResult("critical"), CONFIG, context);
    expect(event?.severity).toBe("fatal");
    // Fingerprint stability: title/message must not embed run-varying counts.
    expect(event?.title).not.toMatch(/\d/);
    expect(event?.message).not.toContain("6 attempts");
    expect(event?.message).not.toContain(WINDOW_START);
    expect(event?.metadata).toMatchObject({
      failureType: "managed_venice_capture_drought",
      attempts: 6,
      captured: 0,
      windowStartIso: WINDOW_START,
    });
  });

  it("maps WARN drought to a warn event", () => {
    const event = buildDroughtOpsEvent(droughtResult("warn"), CONFIG, context);
    expect(event?.severity).toBe("warn");
    expect(event?.metadata?.failureType).toBe("managed_venice_capture_ratio_degraded");
  });

  it("emits nothing for a healthy drought result", () => {
    expect(buildDroughtOpsEvent(droughtResult("healthy"), CONFIG, context)).toBeNull();
  });

  it("maps a CRITICAL probe to a fatal event and surfaces the balance in metadata", () => {
    const event = buildProbeOpsEvent(
      {
        status: "critical",
        reason: "402",
        httpStatus: 402,
        balanceUsd: 0,
        balanceDiem: null,
        accessPermitted: null,
        keySource: "pool",
        poolSize: 2,
      },
      context
    );
    expect(event?.severity).toBe("fatal");
    expect(event?.metadata).toMatchObject({
      failureType: "managed_venice_upstream_probe_failed",
      httpStatus: 402,
      balanceUsd: 0,
    });
  });

  it("emits nothing for healthy / skipped / inconclusive probes", () => {
    for (const status of ["healthy", "skipped", "inconclusive"] as const) {
      const event = buildProbeOpsEvent(
        {
          status,
          reason: "r",
          httpStatus: null,
          balanceUsd: null,
          balanceDiem: null,
          accessPermitted: null,
          keySource: null,
          poolSize: 0,
        },
        context
      );
      expect(event).toBeNull();
    }
  });
});

describe("wasOpsEventRecentlyReported", () => {
  const NOW = Date.parse("2026-07-16T12:00:00.000Z");
  const SIX_HOURS = 6 * 3_600_000;

  function opsEventsDb(row: { last_seen_at: string | null } | null, error: { message: string } | null = null): SupabaseLike {
    return {
      from: (table: string) => {
        if (table !== "ops_events") throw new Error(`unexpected table ${table}`);
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: row, error }),
            }),
          }),
        };
      },
    };
  }

  it("dedupes when the fingerprint was seen inside the window", async () => {
    const db = opsEventsDb({ last_seen_at: "2026-07-16T11:00:00.000Z" });
    await expect(wasOpsEventRecentlyReported(db, "fp", SIX_HOURS, NOW)).resolves.toBe(true);
  });

  it("re-emits when the last sighting is older than the window", async () => {
    const db = opsEventsDb({ last_seen_at: "2026-07-16T05:59:00.000Z" });
    await expect(wasOpsEventRecentlyReported(db, "fp", SIX_HOURS, NOW)).resolves.toBe(false);
  });

  it("emits when the fingerprint has never been seen", async () => {
    await expect(
      wasOpsEventRecentlyReported(opsEventsDb(null), "fp", SIX_HOURS, NOW)
    ).resolves.toBe(false);
  });

  it("fails open (emit) on lookup errors or garbage timestamps", async () => {
    await expect(
      wasOpsEventRecentlyReported(opsEventsDb(null, { message: "db down" }), "fp", SIX_HOURS, NOW)
    ).resolves.toBe(false);
    await expect(
      wasOpsEventRecentlyReported(opsEventsDb({ last_seen_at: "not-a-date" }), "fp", SIX_HOURS, NOW)
    ).resolves.toBe(false);
  });
});
