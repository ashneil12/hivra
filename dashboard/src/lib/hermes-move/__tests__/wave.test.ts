jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import type { MoveDeps, MoveRow } from "@/lib/hermes-move/orchestrator";
import { runMoveWave, type WaveCandidate, type WaveDeps, type WaveSettings } from "@/lib/hermes-move/wave";

const NOW = Date.parse("2026-11-12T10:00:00.000Z");
const H = 60 * 60 * 1000;
const iso = (t: number) => new Date(t).toISOString();

function agent(id: string, extra: Partial<WaveCandidate> = {}, config: Record<string, unknown> = {}): WaveCandidate {
  return {
    id, user_id: `user-${id}`, name: `Agent ${id}`, status: "running", backend: "gateway", deleted_at: null,
    created_at: iso(NOW - 100 * H), last_agent_activity_at: null,
    config: { infrastructure: { provider: "proxmox", vmid: 100 }, ...config },
    ...extra,
  };
}

function world(opts: {
  settings?: Partial<WaveSettings> | null;
  candidates?: WaveCandidate[];
  failed?: Partial<MoveRow>[];
  autoToday?: number;
  noticesToday?: number;
  undone?: string[];
  active?: string[];
} = {}) {
  const w = {
    paused: null as string | null,
    notices: [] as Array<{ id: string; at: string }>,
    emails: [] as Array<{ userId: string; agentName: string; moveAfter: string }>,
    inserted: [] as Array<{ instance_id: string; initiated_by: string }>,
    alerts: [] as string[],
    failedSince: [] as Array<string | null>,
  };
  const settings: WaveSettings | null = opts.settings === null ? null : {
    enabled: true, per_day: 2, paused_at: null, paused_reason: null, resumed_at: null, ...opts.settings,
  };
  const candidates = opts.candidates ?? [];
  const moves = {
    now: () => new Date(NOW),
    randomKeyHex: () => "k".repeat(64),
    encrypt: (s: string) => `enc:${s.length}`,
    alert: async (e: { title: string }) => { w.alerts.push(e.title); },
    store: {
      listActiveMoves: async () => (opts.active ?? []).map((id) => ({ instance_id: id, state: "packing" }) as MoveRow),
      getInstance: async (id: string) => candidates.find((c) => c.id === id) ?? null,
      activeMoveForInstance: async () => null,
      insertMove: async (row: { instance_id: string; initiated_by: string }) => {
        w.inserted.push({ instance_id: row.instance_id, initiated_by: row.initiated_by });
        return { id: `move-${row.instance_id}`, state: "queued", ...row } as unknown as MoveRow;
      },
    },
  } as unknown as MoveDeps;
  const deps: WaveDeps = {
    moves,
    store: {
      getSettings: async () => settings,
      pause: async (reason) => { w.paused = reason; },
      failedAutoMovesSince: async (since) => { w.failedSince.push(since); return (opts.failed ?? []) as MoveRow[]; },
      countAutoMovesSince: async () => opts.autoToday ?? 0,
      countNoticesSince: async () => opts.noticesToday ?? 0,
      undoneInstanceIds: async () => new Set(opts.undone ?? []),
      listCandidates: async () => candidates,
      setNotice: async (row, at) => { w.notices.push({ id: row.id, at }); },
    },
    sendNotice: async (p) => { w.emails.push(p); return { sent: true }; },
  };
  return { w, deps };
}

describe("hermes move wave", () => {
  it("does nothing while off (the default) or with no settings row", async () => {
    for (const settings of [{ enabled: false }, null]) {
      const { w, deps } = world({ settings, candidates: [agent("a")] });
      expect(await runMoveWave(deps)).toEqual({ state: "off" });
      expect(w.notices).toEqual([]);
      expect(w.inserted).toEqual([]);
    }
  });

  it("does nothing while paused", async () => {
    const { w, deps } = world({ settings: { paused_at: iso(NOW - H), paused_reason: "move x failed" }, candidates: [agent("a")] });
    expect(await runMoveWave(deps)).toEqual({ state: "paused", reason: "move x failed" });
    expect(w.notices).toEqual([]);
  });

  it("pauses itself and alerts when an automatic move failed since the last resume", async () => {
    const resumed = iso(NOW - 5 * H);
    const { w, deps } = world({
      settings: { resumed_at: resumed },
      candidates: [agent("a")],
      failed: [{ id: "m1", state: "failed", user_id: "u", instance_id: "i", failure: { failureType: "x", reason: "r", technical: "pack broke" } }],
    });
    const res = await runMoveWave(deps);
    expect(res.state).toBe("paused");
    expect(w.failedSince).toEqual([resumed]);
    expect(w.paused).toContain("m1");
    expect(w.paused).toContain("pack broke");
    expect(w.alerts).toEqual(["The Hermes move wave paused itself"]);
    expect(w.inserted).toEqual([]);
    expect(w.notices).toEqual([]);
  });

  it("tells the oldest owners first, up to the daily limit, and says when", async () => {
    const { w, deps } = world({
      candidates: [agent("new", { created_at: iso(NOW - 2 * H) }), agent("old", { created_at: iso(NOW - 50 * H) }), agent("mid", { created_at: iso(NOW - 10 * H) })],
    });
    const res = await runMoveWave(deps);
    expect(res).toMatchObject({ state: "ran", queued: [], told: ["old", "mid"] });
    expect(w.notices).toEqual([{ id: "old", at: iso(NOW) }, { id: "mid", at: iso(NOW) }]);
    expect(w.emails).toEqual([
      { userId: "user-old", agentName: "Agent old", moveAfter: iso(NOW + 24 * H) },
      { userId: "user-mid", agentName: "Agent mid", moveAfter: iso(NOW + 24 * H) },
    ]);
  });

  it("counts owners already told today against the limit", async () => {
    const { w, deps } = world({ noticesToday: 2, candidates: [agent("a")] });
    await runMoveWave(deps);
    expect(w.notices).toEqual([]);
  });

  it("moves agents told at least a day ago, earliest first, within the limit, and skips busy ones", async () => {
    const told = (hoursAgo: number) => ({ moveNoticeAt: iso(NOW - hoursAgo * H) });
    const { w, deps } = world({
      settings: { per_day: 2 },
      candidates: [
        agent("recent", {}, told(5)),
        agent("busy", { last_agent_activity_at: iso(NOW - 10 * 60 * 1000) }, told(40)),
        agent("second", {}, told(25)),
        agent("first", {}, told(30)),
        agent("third", {}, told(24.5)),
      ],
    });
    const res = await runMoveWave(deps);
    expect(res).toMatchObject({ state: "ran", busy: 1, told: [] });
    expect(w.inserted).toEqual([
      { instance_id: "first", initiated_by: "auto" },
      { instance_id: "second", initiated_by: "auto" },
    ]);
  });

  it("counts automatic moves from the last day against the limit", async () => {
    const { w, deps } = world({ settings: { per_day: 2 }, autoToday: 2, candidates: [agent("a", {}, { moveNoticeAt: iso(NOW - 30 * H) })] });
    await runMoveWave(deps);
    expect(w.inserted).toEqual([]);
  });

  it("leaves alone agents whose owner undid a move, agents already moving, and agents it cannot move", async () => {
    const due = { moveNoticeAt: iso(NOW - 30 * H) };
    const { w, deps } = world({
      settings: { per_day: 10 },
      undone: ["undone"],
      active: ["moving"],
      candidates: [
        agent("undone", {}, due),
        agent("moving", {}, due),
        agent("no-handle", { config: { moveNoticeAt: due.moveNoticeAt } }),
        agent("ok", {}, due),
      ],
    });
    await runMoveWave(deps);
    expect(w.inserted).toEqual([{ instance_id: "ok", initiated_by: "auto" }]);
    expect(w.notices).toEqual([]);
  });
});
