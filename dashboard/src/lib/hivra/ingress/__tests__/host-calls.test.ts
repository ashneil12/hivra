/** @jest-environment node */
jest.mock("server-only", () => ({}));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/hivra/agent-wake", () => ({ ensureHivraAgentAwake: jest.fn() }));
jest.mock("@/lib/hivra/channel-wake/lifecycle", () => ({ disarmChannelsForWake: jest.fn(), settleChannelsAfterWake: jest.fn() }));

import { handleWakeReport, handleWakeRequest, type HostCallDeps } from "../host-calls";
import type { ChannelDisarms } from "@/lib/hivra/channel-wake/lifecycle";

const HOST = "fixturehost";
const AGENT = "11111111-1111-4111-8111-111111111111";

function napping(extra: Record<string, unknown> = {}) {
  return { id: AGENT, vmid: 1234, proxmox_host: HOST, status: "running", sleep_state: "napping", sleep_generation: 7, operation_id: null, ...extra };
}

const TELEGRAM_DISARMED: ChannelDisarms = {
  telegram: { ok: true, ms: 120 } as unknown as ChannelDisarms["telegram"],
  generic: [],
  killStaleSockets: true,
  ms: 120,
};

function deps(overrides: Partial<HostCallDeps> = {}) {
  return {
    findAgent: jest.fn(async () => [napping()]),
    reconcileAwake: jest.fn(async () => true),
    logEvent: jest.fn(async () => true),
    disarm: jest.fn(async () => TELEGRAM_DISARMED),
    settle: jest.fn(async () => undefined),
    ensureAwake: jest.fn(async () => ({ state: "waking" as const, reason: "in_progress" })),
    nowMs: () => 1_800_000_000_000,
    ...overrides,
  } satisfies HostCallDeps;
}

describe("wake-report", () => {
  it("sets a napping agent awake and takes its Telegram arm down within a second", async () => {
    const d = deps();
    const started = Date.now();
    const answer = await handleWakeReport(HOST, { vmid: 1234, woke: "nap", at: 1_799_999_999.5, from: "ticket" }, d);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(answer).toEqual({ status: 200, body: { ok: true, vmid: 1234, action: "reconciled", disarm_ms: 120 } });
    expect(d.findAgent).toHaveBeenCalledWith(HOST, 1234);
    expect(d.reconcileAwake).toHaveBeenCalledWith(AGENT, 7);
    expect(d.disarm).toHaveBeenCalledWith(AGENT);
    expect(d.settle).toHaveBeenCalledWith(AGENT, TELEGRAM_DISARMED);
    expect(d.logEvent).toHaveBeenCalledWith(expect.objectContaining({
      agentId: AGENT, kind: "wake", trigger: "ingress", fromState: "napping", toState: "awake", generation: 8, reason: "proxy_report",
      detail: expect.objectContaining({ proxy_from: "ticket", lag_ms: 500, tg_disarm_ok: true }),
    }));
  });

  it("still sets the agent awake when a disarm throws", async () => {
    const d = deps({ disarm: jest.fn(async () => { throw new Error("telegram down"); }) });
    const answer = await handleWakeReport(HOST, { vmid: 1234, woke: "nap" }, d);
    expect(answer.body).toMatchObject({ ok: true, action: "reconciled", disarm_ms: null });
    expect(d.reconcileAwake).toHaveBeenCalled();
  });

  it("leaves alone an agent that is awake, hibernated, under a lease, or moved on meanwhile", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ sleep_state: "awake" }, "already_awake"],
      [{ sleep_state: "hibernated" }, "ignored"],
      [{ operation_id: "op" }, "busy"],
      [{ sleep_generation: "x" }, "ignored"],
    ];
    for (const [extra, action] of cases) {
      const d = deps({ findAgent: jest.fn(async () => [napping(extra)]) });
      expect((await handleWakeReport(HOST, { vmid: 1234, woke: "nap" }, d)).body).toMatchObject({ ok: true, action });
      expect(d.reconcileAwake).not.toHaveBeenCalled();
      expect(d.disarm).not.toHaveBeenCalled();
    }
    const raced = deps({ reconcileAwake: jest.fn(async () => false) });
    expect((await handleWakeReport(HOST, { vmid: 1234, woke: "nap" }, raced)).body).toMatchObject({ action: "raced" });
    expect(raced.disarm).not.toHaveBeenCalled();
  });

  it("only knows the calling host's own computers", async () => {
    expect((await handleWakeReport(HOST, { vmid: 1234, woke: "nap" }, deps({ findAgent: jest.fn(async () => []) }))).status).toBe(404);
    expect((await handleWakeReport(HOST, { vmid: 1234, woke: "nap" }, deps({ findAgent: jest.fn(async () => [napping(), napping()]) }))).status).toBe(409);
    expect((await handleWakeReport(HOST, { vmid: 1234, woke: "nap" }, deps({ findAgent: jest.fn(async () => { throw new Error("db"); }) }))).status).toBe(503);
  });

  it("refuses a malformed report", async () => {
    for (const body of [null, [], { vmid: "1234", woke: "nap" }, { vmid: 99, woke: "nap" }, { vmid: 1234, woke: "already" }, { vmid: 1234 }]) {
      const d = deps();
      expect((await handleWakeReport(HOST, body, d)).status).toBe(400);
      expect(d.findAgent).not.toHaveBeenCalled();
    }
  });
});

describe("wake-request", () => {
  it("starts the normal wake with trigger ingress and answers at once", async () => {
    const d = deps({ findAgent: jest.fn(async () => [napping({ sleep_state: "hibernated" })]) });
    const answer = await handleWakeRequest(HOST, { vmid: 1234, reason: "ticket" }, { deps: d });
    expect(answer).toEqual({ status: 200, body: { ok: true, vmid: 1234, state: "waking" } });
    expect(d.ensureAwake).toHaveBeenCalledWith(AGENT, "ingress");
  });

  it("records a doorbell as a channel wake", async () => {
    const d = deps();
    await handleWakeRequest(HOST, { vmid: 1234, reason: "doorbell" }, { deps: d });
    expect(d.ensureAwake).toHaveBeenCalledWith(AGENT, "channel");
  });

  it("does not wake an awake agent, and reports a refused wake", async () => {
    const awake = deps({ findAgent: jest.fn(async () => [napping({ sleep_state: "awake" })]) });
    expect((await handleWakeRequest(HOST, { vmid: 1234, reason: "client" }, { deps: awake })).body).toMatchObject({ ok: true, state: "awake" });
    expect(awake.ensureAwake).not.toHaveBeenCalled();
    const lapsed = deps({ ensureAwake: jest.fn(async () => ({ state: "failed" as const, reason: "lapsed" })) });
    expect((await handleWakeRequest(HOST, { vmid: 1234, reason: "client" }, { deps: lapsed })).body)
      .toEqual({ ok: false, vmid: 1234, state: "failed", error: "lapsed" });
    const broken = deps({ ensureAwake: jest.fn(async () => { throw new Error("x"); }) });
    expect((await handleWakeRequest(HOST, { vmid: 1234, reason: "client" }, { deps: broken })).status).toBe(503);
  });

  it("refuses an unknown reason or vmid", async () => {
    for (const body of [{ vmid: 1234, reason: "because" }, { vmid: 1234 }, { reason: "client" }, null]) {
      const d = deps();
      expect((await handleWakeRequest(HOST, body, { deps: d })).status).toBe(400);
      expect(d.ensureAwake).not.toHaveBeenCalled();
    }
    expect((await handleWakeRequest(HOST, { vmid: 1234, reason: "client" }, { deps: deps({ findAgent: jest.fn(async () => []) }) })).status).toBe(404);
  });
});
