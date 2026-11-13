/** @jest-environment node */
jest.mock("server-only", () => ({}));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

import { buildDoorbellArmsScript, parseDoorbellArms } from "../doorbell-scripts";
import { DOORBELL_RECONCILE_INTERVAL_MS, reconcileDoorbellArms } from "../doorbell-reconcile";
import type { ChannelWakeAgentFacts, ChannelWakeRow } from "../store";

const ARM = "00000000-0000-4fea-8ccd-25ce867dc960";
const OTHER_ARM = "00000000-0000-444e-8495-0040dd178a63";
const agentId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const row = (n: number, over: Partial<ChannelWakeRow> = {}) => ({
  agent_id: agentId(n), channel: "email", enabled: true, state: "armed", arm_id: ARM, arm_data: {}, ...over,
}) as unknown as ChannelWakeRow;
const facts = (n: number, over: Partial<ChannelWakeAgentFacts> = {}): [string, ChannelWakeAgentFacts] =>
  [agentId(n), { status: "running", sleep_state: "napping", operation_id: null, vmid: 500 + n, proxmox_host: "hosta", ...over }];
const armsLine = (vms: Record<string, unknown>) => `HIVRA_DOORBELL_ARMS ${JSON.stringify({ ok: true, vms })}\n`;

function reconcile(rows: ChannelWakeRow[], agents: Array<[string, ChannelWakeAgentFacts]>, stdout: string | Error) {
  const wake = jest.fn();
  const runOnHost = jest.fn(async () => {
    if (stdout instanceof Error) throw stdout;
    return { ok: true, stdout };
  });
  const result = reconcileDoorbellArms(rows, new Map(agents), {
    now: () => 10 * DOORBELL_RECONCILE_INTERVAL_MS, timeLeft: () => 60_000, wake, runOnHost, lastAsked: new Map(),
  });
  return { wake, runOnHost, result };
}

describe("the doorbell arms script", () => {
  it("is read-only, bound to the host, and says when the doorbell is absent or silent", () => {
    const script = buildDoorbellArmsScript("hosta");
    expect(script).toContain('{"cmd":"status"}');
    expect(script).toContain("EXPECTED_HOSTNAME='hosta'");
    expect(script).not.toMatch(/"cmd":"(arm|disarm)"/);
    expect(script.includes("\u0000")).toBe(false);
    expect(() => buildDoorbellArmsScript("bad host")).toThrow();
    expect(parseDoorbellArms('HIVRA_DOORBELL_ARMS {"ok":false,"error":"absent"}\n')).toEqual({ answered: false });
    expect(parseDoorbellArms("garbage")).toBeNull();
    const parsed = parseDoorbellArms(armsLine({ 501: { arm_id: ARM, state: "armed" } }));
    expect(parsed).toEqual({ answered: true, arms: new Map([[501, { armId: ARM, state: "armed" }]]) });
  });
});

describe("reconcileDoorbellArms", () => {
  it("leaves an agent alone while the doorbell holds its arm", async () => {
    const { wake, result } = reconcile([row(1)], [facts(1)], armsLine({ 501: { arm_id: ARM, state: "armed" } }));
    await expect(result).resolves.toEqual([]);
    expect(wake).not.toHaveBeenCalled();
  });

  it.each([
    ["no arm", {}],
    ["another arm", { 501: { arm_id: OTHER_ARM, state: "armed" } }],
    ["a ring in progress", { 501: { arm_id: ARM, state: "fired" } }],
  ])("wakes a sleeping agent whose arm the doorbell lost (%s)", async (_name, vms) => {
    const { wake, result } = reconcile([row(1)], [facts(1)], armsLine(vms));
    await expect(result).resolves.toEqual([agentId(1)]);
    expect(wake).toHaveBeenCalledWith(agentId(1));
  });

  it("wakes every sleeping armed agent on a host whose doorbell is absent or silent", async () => {
    const { wake } = reconcile([row(1), row(2, { channel: "discord" })], [facts(1), facts(2)], 'HIVRA_DOORBELL_ARMS {"ok":false,"error":"unreachable"}\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(wake.mock.calls.map((call) => call[0]).sort()).toEqual([agentId(1), agentId(2)]);
  });

  it("changes nothing when the host call fails or its output cannot be read", async () => {
    for (const stdout of [new Error("ssh"), "nothing useful"]) {
      const { wake, result } = reconcile([row(1)], [facts(1)], stdout);
      await expect(result).resolves.toEqual([]);
      expect(wake).not.toHaveBeenCalled();
    }
  });

  it("asks only about armed doorbell rows of sleeping agents, and each host at most once an interval", async () => {
    const { runOnHost, result } = reconcile(
      [row(1, { state: "idle" }), row(2, { channel: "matrix" }), row(3)],
      [facts(1), facts(2), facts(3, { sleep_state: "awake" })],
      armsLine({}),
    );
    await result;
    expect(runOnHost).not.toHaveBeenCalled();

    const lastAsked = new Map([["hosta", 10 * DOORBELL_RECONCILE_INTERVAL_MS - 1000]]);
    const runAgain = jest.fn(async () => ({ ok: true, stdout: armsLine({}) }));
    await reconcileDoorbellArms([row(1)], new Map([facts(1)]), {
      now: () => 10 * DOORBELL_RECONCILE_INTERVAL_MS, timeLeft: () => 60_000, wake: jest.fn(), runOnHost: runAgain, lastAsked,
    });
    expect(runAgain).not.toHaveBeenCalled();
  });
});
