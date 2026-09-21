import { NextRequest } from "next/server";

import { GET } from "../route";
import { parseAgentProbe, parseAgentUsage, parseHarvestedGoal } from "../usage-parsers";
import { supabaseAdmin } from "@/lib/supabase";
import { sshExec } from "@/lib/hetzner/ssh";
import { getProxmoxInfrastructure } from "@/lib/services/proxmox-infrastructure";

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: jest.fn(), rpc: jest.fn() },
}));

jest.mock("@/lib/posthog", () => ({
  posthogClient: {
    capture: jest.fn(),
    flush: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("@/lib/hetzner/ssh", () => ({
  sshExec: jest.fn(),
}));

jest.mock("@/lib/ops-events", () => ({
  // Keep sanitizeOpsMetadata et al. real (logger.ts depends on them); only the
  // network-ish reporter is stubbed.
  ...jest.requireActual("@/lib/ops-events"),
  reportOpsEvent: jest.fn().mockResolvedValue(null),
}));

import { posthogClient } from "@/lib/posthog";
import { reportOpsEvent } from "@/lib/ops-events";

jest.mock("@/lib/services/proxmox-infrastructure", () => ({
  getProxmoxInfrastructure: jest.fn(),
  getProxmoxHostRoutingConfigFromInfrastructure: jest.fn(() => ({
    hostId: "host-fixturenode7",
    hostSlug: "fixturenode7",
    envPrefix: null,
    failClosed: true,
  })),
}));

const ORIGINAL_ENV = process.env;

const makeRequest = (authorization?: string, url = "http://localhost/api/cron/harvest-agent-usage") =>
  new Request(url, {
    headers: authorization ? { authorization } : {},
  }) as unknown as NextRequest;

// The guest's newest non-cron message. `ok: true` is the guest's explicit
// "I read state.db cleanly" marker — without it the harvester must treat the
// instance's activity as UNKNOWN and refuse to stamp a probe.
const LAST_ACTIVITY_EPOCH = Math.floor(
  Date.parse("2026-05-23T12:00:00.000Z") / 1000
);
const LAST_ACTIVITY_ISO = new Date(LAST_ACTIVITY_EPOCH * 1000).toISOString();

const USAGE_JSON = JSON.stringify({
  daily: [
    { day: "2026-05-22", input_tokens: 100, output_tokens: 40, cache_read_tokens: 5, reasoning_tokens: 1, estimated_cost: 0.02, sessions: 2, api_calls: 6 },
    { day: "2026-05-23", input_tokens: 200, output_tokens: 80, cache_read_tokens: 0, reasoning_tokens: 0, estimated_cost: 0.05, sessions: 3, api_calls: 9 },
  ],
  models: [
    { day: "2026-05-22", model: "gpt-5.5", tokens: 140, requests: 6 },
    { day: "2026-05-23", model: "gpt-5.5", tokens: 280, requests: 9 },
    { day: "2026-05-23", model: "deepseek-v4-flash", tokens: 50, requests: 2 },
  ],
  providers: [
    { day: "2026-05-22", provider: "openai-codex", tokens: 140, requests: 6 },
    { day: "2026-05-23", provider: "venice", tokens: 330, requests: 11 },
  ],
  last_activity: LAST_ACTIVITY_EPOCH,
  ok: true,
});

function mockInstances(
  rows: unknown[],
  recentDone: string[] = [],
  opts: {
    stampAffectsRows?: boolean;
    goalAffectsRows?: boolean;
    probeStampError?: string;
  } = {}
) {
  // hermes_instances.update() is now used by FOUR independent chains off the
  // same builder, distinguished by their payload:
  //   first_usage stamp:   update({first_usage_at}).eq("id", …).is("first_usage_at", null).select("id")
  //   last_activity bump:  update({last_activity_at}).eq("id", …).or("…lt…")
  //   goal capture:        update({first_task}).eq("id", …).is("first_task", null).select("id")
  //   agent-activity probe: update({last_agent_probe_at, …}).eq("id", …)   ← awaited directly
  // Route by payload to separate mocks so each chain's call-count is asserted
  // independently (stampUpdate stays first_usage-only for the existing tests).
  const stampSelect = jest.fn(async () => ({
    data: opts.stampAffectsRows === false ? [] : [{ id: "stamped" }],
    error: null,
  }));
  const stampUpdate = jest.fn((payload: Record<string, unknown>) => {
    void payload; // recorded for toHaveBeenCalledWith; not used to shape the chain
    return {
      eq: jest.fn(() => ({
        is: jest.fn(() => ({
          select: stampSelect,
        })),
      })),
    };
  });
  const activityOr = jest.fn().mockResolvedValue({ error: null });
  const activityUpdate = jest.fn((payload: Record<string, unknown>) => {
    void payload;
    return {
      eq: jest.fn(() => ({
        or: activityOr,
      })),
    };
  });
  const goalSelect = jest.fn(async () => ({
    data: opts.goalAffectsRows === false ? [] : [{ id: "goal-set" }],
    error: null,
  }));
  const goalUpdate = jest.fn((payload: Record<string, unknown>) => {
    void payload;
    return {
      eq: jest.fn(() => ({
        is: jest.fn(() => ({
          select: goalSelect,
        })),
      })),
    };
  });
  // agent-activity probe chain (new): update({last_agent_probe_at, …}).eq("id", …)
  // is awaited directly, so .eq must resolve rather than chain further.
  const probeUpdate = jest.fn((payload: Record<string, unknown>) => {
    void payload;
    return {
      eq: jest.fn(async () => ({
        data: null,
        error: opts.probeStampError ? { message: opts.probeStampError } : null,
      })),
    };
  });
  const update = jest.fn((payload: Record<string, unknown>) =>
    payload && "last_agent_probe_at" in payload
      ? probeUpdate(payload)
      : payload && "first_usage_at" in payload
        ? stampUpdate(payload)
        : payload && "first_task" in payload
          ? goalUpdate(payload)
          : activityUpdate(payload)
  );
  const builder = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    update,
    then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
      resolve({ data: rows, error: null }),
  };
  const upsert = jest.fn().mockResolvedValue({ error: null });
  const snapshots = {
    select: jest.fn().mockReturnThis(),
    gte: jest.fn().mockResolvedValue({
      data: recentDone.map((id) => ({ instance_id: id })),
      error: null,
    }),
    upsert,
  };
  (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
    if (table === "hermes_instances") return builder;
    if (table === "instance_usage_snapshots") return snapshots;
    throw new Error(`Unexpected table ${table}`);
  });
  return { builder, upsert, stampUpdate, activityUpdate, activityOr, goalUpdate, probeUpdate };
}

describe("parseAgentUsage", () => {
  it("parses one row per UTC day with per-day model + provider breakdowns", () => {
    const parsed = parseAgentUsage(USAGE_JSON);
    expect(parsed).not.toBeNull();
    expect(parsed!).toHaveLength(2);

    const d23 = parsed!.find((d) => d.stat_date === "2026-05-23")!;
    expect(d23).toMatchObject({ input_tokens: 200, output_tokens: 80, total_tokens: 280, sessions: 3, api_calls: 9 });
    expect(d23.by_model).toEqual({
      "gpt-5.5": { tokens: 280, requests: 9 },
      "deepseek-v4-flash": { tokens: 50, requests: 2 },
    });
    expect(d23.by_provider).toEqual({ venice: { tokens: 330, requests: 11 } });

    const d22 = parsed!.find((d) => d.stat_date === "2026-05-22")!;
    expect(d22.by_model).toEqual({ "gpt-5.5": { tokens: 140, requests: 6 } });
    expect(d22.by_provider).toEqual({ "openai-codex": { tokens: 140, requests: 6 } });
  });

  it("returns null on non-JSON", () => {
    expect(parseAgentUsage("<html>not json</html>")).toBeNull();
  });

  it("tolerates a daily-only payload", () => {
    const parsed = parseAgentUsage(JSON.stringify({ daily: [{ day: "2026-05-23", input_tokens: 5 }] }));
    expect(parsed![0]).toMatchObject({ stat_date: "2026-05-23", total_tokens: 5 });
    expect(parsed![0].by_model).toEqual({});
    expect(parsed![0].by_provider).toEqual({});
  });
});

describe("parseHarvestedGoal", () => {
  const g = (goal: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ goal, status: "active", created_at: 100, last_turn_at: 100, ...extra });

  it("returns null when there are no goals", () => {
    expect(parseHarvestedGoal(JSON.stringify({ daily: [], goals: [] }))).toBeNull();
    expect(parseHarvestedGoal(JSON.stringify({ daily: [] }))).toBeNull();
    expect(parseHarvestedGoal("not json")).toBeNull();
  });

  it("extracts the goal text, trimmed", () => {
    const raw = JSON.stringify({ goals: [g("  build a trading bot  ")] });
    expect(parseHarvestedGoal(raw)).toBe("build a trading bot");
  });

  it("prefers an active/paused goal over done/cleared", () => {
    const raw = JSON.stringify({
      goals: [
        g("finished thing", { status: "done", last_turn_at: 999 }),
        g("live objective", { status: "active", last_turn_at: 1 }),
      ],
    });
    expect(parseHarvestedGoal(raw)).toBe("live objective");
  });

  it("among same-status goals picks the most recently touched", () => {
    const raw = JSON.stringify({
      goals: [
        g("older", { last_turn_at: 10 }),
        g("newer", { last_turn_at: 500 }),
      ],
    });
    expect(parseHarvestedGoal(raw)).toBe("newer");
  });

  it("skips empty/malformed goal blobs and caps length at 700", () => {
    const long = "x".repeat(900);
    const raw = JSON.stringify({ goals: ["{bad json", g(""), g(long)] });
    const out = parseHarvestedGoal(raw);
    expect(out).toHaveLength(700);
  });
});

describe("parseAgentProbe", () => {
  // Every `ok: false` below must make the inactivity sweep SPARE the instance.
  // The whole point of this parser is that a failed read is never mistaken for
  // an idle agent.
  it("reads a clean probe with a real activity timestamp", () => {
    expect(parseAgentProbe(USAGE_JSON)).toEqual({
      ok: true,
      lastActivityAt: LAST_ACTIVITY_ISO,
    });
  });

  it("treats a clean read of a never-used agent as ok with a null watermark", () => {
    expect(parseAgentProbe(JSON.stringify({ ok: true, last_activity: null }))).toEqual({
      ok: true,
      lastActivityAt: null,
    });
  });

  it("treats an in-band sqlite error as a FAILED probe", () => {
    expect(parseAgentProbe(JSON.stringify({ ok: true, _error: "malformed" }))).toEqual({
      ok: false,
      lastActivityAt: null,
    });
  });

  it("treats a payload with no ok marker as a FAILED probe", () => {
    // Legacy guests (pre-`ok`) and truncated output both land here. Unknown, not idle.
    expect(parseAgentProbe(JSON.stringify({ daily: [] }))).toEqual({
      ok: false,
      lastActivityAt: null,
    });
  });

  it("treats unparseable output as a FAILED probe", () => {
    expect(parseAgentProbe("Traceback (most recent call last):")).toEqual({
      ok: false,
      lastActivityAt: null,
    });
    expect(parseAgentProbe("null")).toEqual({ ok: false, lastActivityAt: null });
  });

  it("clamps a clock-skewed far-future timestamp rather than pinning the agent active forever", () => {
    const farFuture = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60;
    expect(parseAgentProbe(JSON.stringify({ ok: true, last_activity: farFuture }))).toEqual({
      ok: true,
      lastActivityAt: null,
    });
  });

  it("ignores a non-positive epoch", () => {
    expect(parseAgentProbe(JSON.stringify({ ok: true, last_activity: 0 }))).toEqual({
      ok: true,
      lastActivityAt: null,
    });
  });
});

describe("GET /api/cron/harvest-agent-usage", () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV, CRON_SECRET: "cron-secret" };
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: USAGE_JSON, stderr: "" });
    (supabaseAdmin!.rpc as jest.Mock).mockResolvedValue({ error: null });
    (getProxmoxInfrastructure as jest.Mock).mockReturnValue({
      provider: "proxmox",
      vmid: 701,
      node: "fixturenode7",
      privateIpv4: "10.250.20.51",
      gatewayHost: "x.hermesos.cloud",
      hostId: "host-fixturenode7",
      hostSlug: "fixturenode7",
    });
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    consoleErrorSpy.mockRestore();
  });

  it("returns 500 when CRON_SECRET is unset", async () => {
    process.env = { ...ORIGINAL_ENV, CRON_SECRET: "" };
    mockInstances([]);
    const res = await GET(makeRequest("Bearer cron-secret"));
    expect(res.status).toBe(500);
    expect(sshExec).not.toHaveBeenCalled();
  });

  it("returns 401 when the authorization header is wrong", async () => {
    mockInstances([]);
    const res = await GET(makeRequest("Bearer nope"));
    expect(res.status).toBe(401);
    expect(sshExec).not.toHaveBeenCalled();
  });

  it("harvests an active instance and upserts a row per day with model + provider", async () => {
    const { upsert } = mockInstances([{ id: "inst_1", host_id: "host-fixturenode7", proxmox_node: "fixturenode7", config: {} }]);

    const res = await GET(makeRequest("Bearer cron-secret"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ harvested: 1, skipped: 0, errors: 0, total: 1 });
    // The harvest command now resolves the live container from a candidate list
    // (legacy bare name + the webfree gateway/official-dashboard) and execs
    // into whichever is running.
    const sshCall = (sshExec as jest.Mock).mock.calls[0];
    expect(sshCall[0]).toBe("10.250.20.51");
    expect(sshCall[1]).toContain(
      '"agent-inst_1" "agent-inst_1-gateway" "agent-inst_1-official-dashboard"'
    );
    expect(sshCall[1]).toContain('docker exec -i "$AGENT_CONTAINER" python3');
    expect(sshCall[2]).toMatchObject({ proxmoxHostConfig: { hostSlug: "fixturenode7" } });
    // Healthy run emits exactly one info-level ops_event.
    expect(reportOpsEvent).toHaveBeenCalledTimes(1);
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ source: "harvest-agent-usage", severity: "info" })
    );
    const upsertedRows = upsert.mock.calls[0][0];
    expect(upsertedRows).toHaveLength(2);
    const d22 = upsertedRows.find((r: { stat_date: string }) => r.stat_date === "2026-05-22");
    expect(d22.by_model).toEqual({ "gpt-5.5": { tokens: 140, requests: 6 } });
    expect(d22.by_provider).toEqual({ "openai-codex": { tokens: 140, requests: 6 } });
    expect(d22.total_tokens).toBe(140);
  });

  it("respects the days param, capped at 90", async () => {
    mockInstances([{ id: "inst_1", config: {} }]);
    const res = await GET(
      makeRequest("Bearer cron-secret", "http://localhost/api/cron/harvest-agent-usage?days=500")
    );
    const body = await res.json();
    expect(body.data.days).toBe(90);
  });

  it("skips instances with no Proxmox infrastructure", async () => {
    (getProxmoxInfrastructure as jest.Mock).mockReturnValue(null);
    mockInstances([{ id: "inst_x", config: {} }]);
    const res = await GET(makeRequest("Bearer cron-secret"));
    const body = await res.json();
    expect(body.data).toMatchObject({ harvested: 0, skipped: 1, errors: 0 });
    expect(sshExec).not.toHaveBeenCalled();
  });

  it("counts an SSH/host failure as host-unreachable (not the topology alarm)", async () => {
    (sshExec as jest.Mock).mockResolvedValue({ ok: false, stdout: "", stderr: "ssh: connect refused" });
    const { upsert } = mockInstances([{ id: "inst_1", config: {} }]);
    const res = await GET(makeRequest("Bearer cron-secret"));
    const body = await res.json();
    expect(body.data).toMatchObject({
      harvested: 0,
      skipped: 1,
      errors: 0,
      skippedHostUnreachable: 1,
      skippedNoContainer: 0,
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("flags no-running-container as skippedNoContainer and emits a degraded warn ops_event", async () => {
    // Every reachable agent returns the no-container sentinel — the exact rot the
    // webfree migration introduced. Use enough to clear the alarm floor (10).
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "__HARVEST_NO_CONTAINER__\n",
      stderr: "",
    });
    const rows = Array.from({ length: 12 }, (_, i) => ({
      id: `inst_${i}`,
      webfree: true,
      proxmox_node: "fixturenode16",
      config: {},
    }));
    const { upsert } = mockInstances(rows);
    const res = await GET(makeRequest("Bearer cron-secret"));
    const body = await res.json();
    expect(body.data).toMatchObject({
      harvested: 0,
      skippedNoContainer: 12,
      degraded: true,
    });
    expect(upsert).not.toHaveBeenCalled();
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "harvest-agent-usage",
        severity: "warn",
        metadata: expect.objectContaining({
          skippedNoContainer: 12,
          // capped at 12 samples, carrying the webfree flag + node for triage
          unreachableSamples: expect.arrayContaining([
            { id: "inst_0", webfree: true, node: "fixturenode16" },
          ]),
        }),
      })
    );
  });

  it("counts a valid-but-empty usage window as an idle agent, not an error", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: JSON.stringify({ daily: [], models: [], providers: [], ok: true }),
      stderr: "",
    });
    const { upsert } = mockInstances([{ id: "inst_1", config: {} }]);
    const res = await GET(makeRequest("Bearer cron-secret"));
    const body = await res.json();
    expect(body.data).toMatchObject({
      harvested: 0,
      skippedEmpty: 1,
      skippedNoContainer: 0,
      degraded: false,
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  // ── agent-activity probe (feeds the inactivity sweep's fail-safe) ──────────

  it("stamps last_agent_probe_at for a CLEANLY-READ but idle agent", async () => {
    // The load-bearing case. An idle agent emits no usage rows — identical output
    // to an agent whose state.db we could not read. The probe stamp is the only
    // thing that tells the inactivity sweep "we looked, and it really is idle",
    // which is what licenses it to pause the box at all.
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: JSON.stringify({ daily: [], models: [], providers: [], ok: true }),
      stderr: "",
    });
    const { probeUpdate } = mockInstances([{ id: "inst_1", config: {} }]);

    const res = await GET(makeRequest("Bearer cron-secret"));
    const body = await res.json();

    expect(body.data).toMatchObject({ harvested: 0, skippedEmpty: 1, probed: 1 });
    expect(probeUpdate).toHaveBeenCalledTimes(1);
    expect(probeUpdate).toHaveBeenCalledWith({
      last_agent_probe_at: expect.any(String),
    });
  });

  it("stamps NOTHING when the guest could not read state.db (activity stays UNKNOWN)", async () => {
    // A sqlite error is reported in-band. Valid JSON, no `ok` marker. If we stamped
    // a probe here the sweep would believe the signal was fresh and pause a box we
    // are in fact blind to.
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: JSON.stringify({ _error: "database disk image is malformed" }),
      stderr: "",
    });
    const { probeUpdate, upsert } = mockInstances([{ id: "inst_1", config: {} }]);

    const res = await GET(makeRequest("Bearer cron-secret"));
    const body = await res.json();

    expect(body.data).toMatchObject({
      harvested: 0,
      skippedProbeFailed: 1,
      probed: 0,
    });
    expect(probeUpdate).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("moves the activity watermark forward, never backward", async () => {
    // A cold restore can hand us an older state.db. Rolling the watermark back
    // would make an active agent look idle to the sweep.
    const { probeUpdate } = mockInstances([
      {
        id: "inst_1",
        config: {},
        last_agent_activity_at: "2026-06-30T00:00:00.000Z", // newer than the probe
      },
    ]);

    await GET(makeRequest("Bearer cron-secret"));

    expect(probeUpdate).toHaveBeenCalledTimes(1);
    // Probe freshness is still recorded; the stale watermark is simply not written.
    expect(probeUpdate).toHaveBeenCalledWith({
      last_agent_probe_at: expect.any(String),
    });
  });

  it("advances the activity watermark when the probe is newer", async () => {
    const { probeUpdate } = mockInstances([
      {
        id: "inst_1",
        config: {},
        last_agent_activity_at: "2026-01-01T00:00:00.000Z", // older than the probe
      },
    ]);

    await GET(makeRequest("Bearer cron-secret"));

    expect(probeUpdate).toHaveBeenCalledWith({
      last_agent_probe_at: expect.any(String),
      last_agent_activity_at: LAST_ACTIVITY_ISO,
    });
  });

  it("does not count a failed probe stamp as probed (sweep keeps failing safe)", async () => {
    const { probeUpdate } = mockInstances(
      [{ id: "inst_1", config: {} }],
      [],
      { probeStampError: "permission denied for table hermes_instances" }
    );

    const res = await GET(makeRequest("Bearer cron-secret"));
    const body = await res.json();

    expect(probeUpdate).toHaveBeenCalledTimes(1);
    // The harvest itself still succeeds; only the coverage marker is missing, so
    // the sweep conservatively treats this instance as UNKNOWN next tick.
    expect(body.data).toMatchObject({ harvested: 1, probed: 0, errors: 0 });
  });

  it("skips instances harvested within the recent window (hourly re-read dedup)", async () => {
    mockInstances([{ id: "inst_1", config: {} }], ["inst_1"]);
    const res = await GET(makeRequest("Bearer cron-secret"));
    const body = await res.json();
    expect(body.data).toMatchObject({ harvested: 0, skipped: 1, skippedRecent: 1 });
    expect(sshExec).not.toHaveBeenCalled();
  });

  it("force=1 re-harvests even if harvested recently", async () => {
    mockInstances([{ id: "inst_1", config: {} }], ["inst_1"]);
    const res = await GET(
      makeRequest("Bearer cron-secret", "http://localhost/api/cron/harvest-agent-usage?force=1")
    );
    const body = await res.json();
    expect(body.data).toMatchObject({ harvested: 1, force: true });
    expect(sshExec).toHaveBeenCalled();
  });

  // ── agent_first_message_sent revival (Hermes lane) ────────────────────────

  it("stamps first_usage_at write-once and fires agent_first_message_sent when sessions appear", async () => {
    const { stampUpdate } = mockInstances([
      { id: "inst_1", user_id: "user_42", config: {}, first_usage_at: null },
    ]);

    const res = await GET(makeRequest("Bearer cron-secret"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ harvested: 1, errors: 0 });

    // Stamp uses the earliest sessions>0 day (USAGE_JSON: 2026-05-22).
    expect(stampUpdate).toHaveBeenCalledTimes(1);
    expect(stampUpdate).toHaveBeenCalledWith({
      first_usage_at: "2026-05-22T00:00:00.000Z",
    });

    expect(posthogClient.capture).toHaveBeenCalledTimes(1);
    expect(posthogClient.capture).toHaveBeenCalledWith({
      distinctId: "user_42",
      event: "agent_first_message_sent",
      properties: {
        instance_id: "inst_1",
        lane: "hermes",
        $insert_id: "agent_first_message_sent_inst_1",
      },
    });
    expect(posthogClient.flush).toHaveBeenCalled();
  });

  it("does not touch first_usage_at when the instance is already stamped", async () => {
    const { stampUpdate } = mockInstances([
      {
        id: "inst_1",
        user_id: "user_42",
        config: {},
        first_usage_at: "2026-05-20T00:00:00.000Z",
      },
    ]);

    const res = await GET(makeRequest("Bearer cron-secret"));
    const body = await res.json();

    expect(body.data).toMatchObject({ harvested: 1, errors: 0 });
    expect(stampUpdate).not.toHaveBeenCalled();
    expect(posthogClient.capture).not.toHaveBeenCalled();
  });

  it("does not capture when the conditional stamp affects 0 rows (lost the race)", async () => {
    const { stampUpdate } = mockInstances(
      [{ id: "inst_1", user_id: "user_42", config: {}, first_usage_at: null }],
      [],
      { stampAffectsRows: false }
    );

    const res = await GET(makeRequest("Bearer cron-secret"));
    const body = await res.json();

    expect(body.data).toMatchObject({ harvested: 1, errors: 0 });
    expect(stampUpdate).toHaveBeenCalledTimes(1);
    expect(posthogClient.capture).not.toHaveBeenCalled();
  });

  it("stamps but skips the capture when the instance row has no user_id", async () => {
    const { stampUpdate } = mockInstances([
      { id: "inst_1", config: {}, first_usage_at: null },
    ]);

    const res = await GET(makeRequest("Bearer cron-secret"));
    const body = await res.json();

    expect(body.data).toMatchObject({ harvested: 1, errors: 0 });
    expect(stampUpdate).toHaveBeenCalledTimes(1);
    expect(posthogClient.capture).not.toHaveBeenCalled();
  });

  // ── last_activity_at bump (Hermes iframe-blindness fix) ───────────────────

  it("bumps last_activity_at to the latest sessions>0 day, guarded to only move forward", async () => {
    const { activityUpdate, activityOr } = mockInstances([
      { id: "inst_1", user_id: "user_42", config: {}, first_usage_at: null },
    ]);

    const res = await GET(makeRequest("Bearer cron-secret"));
    const body = await res.json();

    expect(body.data).toMatchObject({ harvested: 1, errors: 0 });
    // USAGE_JSON's latest sessions>0 day is 2026-05-23; pinned to noon UTC.
    expect(activityUpdate).toHaveBeenCalledTimes(1);
    expect(activityUpdate).toHaveBeenCalledWith({
      last_activity_at: "2026-05-23T12:00:00Z",
    });
    // The .or() guard makes the bump race-safe and never moves the timestamp
    // backwards over a fresher proxy-route write.
    expect(activityOr).toHaveBeenCalledWith(
      "last_activity_at.is.null,last_activity_at.lt.2026-05-23T12:00:00Z"
    );
  });

  it("does not bump last_activity_at when the box had no sessions", async () => {
    const { activityUpdate } = mockInstances([
      { id: "inst_1", user_id: "user_42", config: {}, first_usage_at: null },
    ]);
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: JSON.stringify({ daily: [], models: [], providers: [], goals: [], ok: true }),
      stderr: "",
    });

    const res = await GET(makeRequest("Bearer cron-secret"));
    await res.json();

    expect(activityUpdate).not.toHaveBeenCalled();
  });

  // ── goal capture → first_task (activation fuel) ───────────────────────────

  it("writes the harvested standing goal to first_task write-once", async () => {
    const { goalUpdate } = mockInstances([
      { id: "inst_1", user_id: "user_42", config: {}, first_usage_at: null },
    ]);
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: JSON.stringify({
        daily: [
          { day: "2026-05-23", sessions: 1, input_tokens: 1, output_tokens: 1 },
        ],
        models: [],
        providers: [],
        goals: [
          JSON.stringify({
            goal: "launch my newsletter",
            status: "active",
            created_at: 1,
            last_turn_at: 2,
          }),
        ],
        ok: true,
      }),
      stderr: "",
    });

    const res = await GET(makeRequest("Bearer cron-secret"));
    const body = await res.json();

    expect(body.data).toMatchObject({ harvested: 1, goalsCaptured: 1 });
    expect(goalUpdate).toHaveBeenCalledTimes(1);
    expect(goalUpdate).toHaveBeenCalledWith({ first_task: "launch my newsletter" });
  });

  it("does not write first_task when the box reports no standing goal", async () => {
    // beforeEach's default USAGE_JSON carries no `goals` key.
    const { goalUpdate } = mockInstances([
      { id: "inst_1", user_id: "user_42", config: {}, first_usage_at: null },
    ]);

    const res = await GET(makeRequest("Bearer cron-secret"));
    const body = await res.json();

    expect(body.data).toMatchObject({ goalsCaptured: 0 });
    expect(goalUpdate).not.toHaveBeenCalled();
  });

  it("counts goalsCaptured=0 when first_task is already set (write-once lost the race)", async () => {
    const { goalUpdate } = mockInstances(
      [{ id: "inst_1", user_id: "user_42", config: {}, first_usage_at: null }],
      [],
      { goalAffectsRows: false }
    );
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: JSON.stringify({
        daily: [{ day: "2026-05-23", sessions: 1, input_tokens: 1, output_tokens: 1 }],
        models: [],
        providers: [],
        goals: [JSON.stringify({ goal: "already captured", status: "active", created_at: 1 })],
        ok: true,
      }),
      stderr: "",
    });

    const res = await GET(makeRequest("Bearer cron-secret"));
    const body = await res.json();

    expect(goalUpdate).toHaveBeenCalledTimes(1);
    expect(body.data).toMatchObject({ goalsCaptured: 0 });
  });
});
