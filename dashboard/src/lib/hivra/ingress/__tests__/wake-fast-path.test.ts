/** @jest-environment node */

// The server's ticket fast path in performWakeSteps: channel arms come down
// before the ticket, a good receipt skips SSH and the public health check, and
// anything else falls back to the SSH wake with the host-ingress script.

const mockReadRow = jest.fn();
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) q[m] = () => q;
      q.maybeSingle = () => mockReadRow();
      return q;
    },
  },
}));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

const mockClaim = jest.fn();
const mockFinish = jest.fn();
const mockLogEvent = jest.fn();
jest.mock("../../agent-sleep-store", () => ({
  ...jest.requireActual("../../agent-sleep-store"),
  claimAgentWake: (...a: unknown[]) => mockClaim(...a),
  finishAgentWake: (...a: unknown[]) => mockFinish(...a),
  logAgentSleepEvent: (...a: unknown[]) => mockLogEvent(...a),
}));

const mockResolveTarget = jest.fn();
jest.mock("../../agent-lifecycle-host", () => ({
  resolveHivraLifecycleTarget: (...a: unknown[]) => mockResolveTarget(...a),
}));

const mockRunScript = jest.fn();
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  runProxmoxHostScript: (...a: unknown[]) => mockRunScript(...a),
}));

jest.mock("@/lib/proxmox/wake-admission", () => ({
  ...jest.requireActual("@/lib/proxmox/wake-admission"),
  acquireHostWakeSlot: jest.fn(async () => ({ admitted: true, freeMb: 9000, activeWakes: 0 })),
  releaseHostWakeSlot: jest.fn(async () => undefined),
}));
jest.mock("../../lapse-gate", () => ({ isStartBlockedForLapse: jest.fn(async () => false) }));
jest.mock("../../sleep-reconcile", () => ({ reconcileAgentSleep: jest.fn() }));

const mockHealthz = jest.fn();
jest.mock("@/lib/ssrf-safe-fetch", () => ({ ssrfSafeFetch: (...a: unknown[]) => mockHealthz(...a) }));

const order: string[] = [];
const mockDisarm = jest.fn();
jest.mock("../../channel-wake/lifecycle", () => ({
  ...jest.requireActual("../../channel-wake/lifecycle"),
  disarmChannelsForWake: (...a: unknown[]) => mockDisarm(...a),
  settleChannelsAfterWake: jest.fn(async () => undefined),
  rearmChannelsAfterFailedWake: jest.fn(async () => undefined),
}));

const mockLoadIngress = jest.fn();
const mockTicket = jest.fn();
jest.mock("../wake-client", () => ({
  ...jest.requireActual("../wake-client"),
  loadAgentIngressState: (...a: unknown[]) => mockLoadIngress(...a),
  wakeViaIngress: (...a: unknown[]) => mockTicket(...a),
}));

import { ensureHivraAgentAwake } from "../../agent-wake";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const VMID = 1234;

const row = (over: Record<string, unknown> = {}) => ({
  id: AGENT_ID, user_id: "user-1", status: "running", sleep_state: "napping", sleep_generation: 4,
  operation_id: null, cf_hostname: "agent-one.example.test", cf_tunnel_id: "22222222-2222-4222-8222-222222222222", ram: 4,
  ...over,
});

const target = {
  executionContext: {
    host: "host_a",
    paths: { provisionerDirectory: "/opt/hivra/provisioner" },
    capacityPolicy: { mode: "observe", hostMemoryReserveMb: 2048, cpuCeilingDensity: 1, memoryCeilingDensity: 1 },
  },
  bindingTag: "hivra-tag-1",
  env: {},
  vmid: VMID,
};

const wakeReceipt = () => `HIVRA_WAKE_RESULT ${JSON.stringify({
  ok: true, vmid: VMID, from: "napping", to: "awake", reason: "resumed", ms: 900, steps: { resume: 120 }, via: "socket", tries: 1,
})}\n`;

const hostState = (acts: boolean) => ({
  kind: "row",
  state: { row: { generation: 3 }, hostIngress: true, acts, needsAwake: !acts, leaseHeld: false },
});

const disarms = { telegram: null, generic: [], killStaleSockets: false, ms: 3 };

const ORIGINAL_FLAG = process.env.HIVRA_FAST_WAKE;

beforeEach(() => {
  jest.clearAllMocks();
  order.length = 0;
  mockReadRow.mockResolvedValue({ data: row(), error: null });
  mockClaim.mockResolvedValue("claimed");
  mockFinish.mockResolvedValue(true);
  mockLogEvent.mockResolvedValue(true);
  mockResolveTarget.mockResolvedValue({ ok: true, target });
  mockRunScript.mockImplementation(async () => {
    order.push("ssh");
    return { ok: true, stdout: wakeReceipt(), stderr: "" };
  });
  mockHealthz.mockImplementation(async () => {
    order.push("healthz");
    return { status: 200 };
  });
  mockDisarm.mockImplementation(async () => {
    order.push("disarm");
    return disarms;
  });
  mockTicket.mockImplementation(async () => {
    order.push("ticket");
    return { ok: true, receipt: { vmid: VMID, woke: "nap", ms: 14, contMs: 3, guestMs: 9 }, ms: 40 };
  });
  process.env.HIVRA_FAST_WAKE = "ingress_ticket";
});

afterAll(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.HIVRA_FAST_WAKE;
  else process.env.HIVRA_FAST_WAKE = ORIGINAL_FLAG;
});

const lastEvent = () => mockLogEvent.mock.calls.at(-1)?.[0] as { detail: Record<string, unknown>; reason: string };

describe("ticket fast path", () => {
  it("disarms channels, then wakes through the ticket, with no SSH and no public health poll", async () => {
    mockLoadIngress.mockResolvedValue(hostState(true));
    await expect(ensureHivraAgentAwake(AGENT_ID, { trigger: "open" })).resolves.toMatchObject({ state: "awake", reason: "resumed" });
    expect(order).toEqual(["disarm", "ticket"]);
    expect(mockTicket).toHaveBeenCalledWith(expect.objectContaining({ agentId: AGENT_ID, vmid: VMID, generation: 3 }));
    expect(mockFinish).toHaveBeenCalledWith(expect.objectContaining({ result: "awake" }));
    expect(lastEvent().detail).toMatchObject({ via: "ingress", cont_ms: 3, guest_ms: 9 });
  });

  it("falls back to the SSH wake with the host-ingress script when the ticket times out", async () => {
    mockLoadIngress.mockResolvedValue(hostState(true));
    mockTicket.mockImplementation(async () => {
      order.push("ticket");
      return { ok: false, reason: "timeout", ms: 8000 };
    });
    await expect(ensureHivraAgentAwake(AGENT_ID, { trigger: "open" })).resolves.toMatchObject({ state: "awake" });
    expect(order).toEqual(["disarm", "ticket", "ssh", "healthz"]);
    const script = String(mockRunScript.mock.calls[0][0]);
    expect(script).toContain("ingress_unmark");
    expect(script).not.toContain("hivra-cf-tunnel");
    expect(lastEvent().detail).toMatchObject({ via: "ssh", ticket_failed: "timeout", host_ingress: true });
  });

  it("does not use the ticket when the flag is off, but still wakes with the host-ingress script", async () => {
    process.env.HIVRA_FAST_WAKE = "all";
    mockLoadIngress.mockResolvedValue(hostState(true));
    await ensureHivraAgentAwake(AGENT_ID, { trigger: "open" });
    expect(mockTicket).not.toHaveBeenCalled();
    expect(String(mockRunScript.mock.calls[0][0])).toContain("ingress_unmark");
  });

  it("does not use the ticket when ingress may not act (kill switch), and wakes over SSH", async () => {
    mockLoadIngress.mockResolvedValue(hostState(false));
    await ensureHivraAgentAwake(AGENT_ID, { trigger: "ingress" });
    expect(mockTicket).not.toHaveBeenCalled();
    const script = String(mockRunScript.mock.calls[0][0]);
    expect(script).toContain("ingress_unmark");
    expect(script).not.toContain("hivra-cf-tunnel");
  });

  it("never uses the ticket for a hibernated agent", async () => {
    mockReadRow.mockResolvedValue({ data: row({ sleep_state: "hibernated" }), error: null });
    mockLoadIngress.mockResolvedValue(hostState(true));
    await ensureHivraAgentAwake(AGENT_ID, { trigger: "open" });
    expect(mockTicket).not.toHaveBeenCalled();
  });

  it("runs the old wake script when the agent has no ingress row", async () => {
    mockRunScript.mockClear();
    mockLoadIngress.mockResolvedValue({ kind: "none" });
    await ensureHivraAgentAwake(AGENT_ID, { trigger: "open" });
    expect(mockTicket).not.toHaveBeenCalled();
    const script = String(mockRunScript.mock.calls[0][0]);
    expect(script).not.toContain("ingress_unmark");
    expect(script).toContain("hivra-cf-tunnel");
  });

  it("removes the nap marker and leaves the guest tunnel alone when the row cannot be read or a cutover was cut short", async () => {
    const interrupted = { kind: "row", state: { ...hostState(false).state, hostIngress: false, acts: false, needsAwake: true, interrupted: true } };
    for (const loaded of [{ kind: "error" }, interrupted]) {
      mockRunScript.mockClear();
      mockLoadIngress.mockResolvedValue(loaded);
      await ensureHivraAgentAwake(AGENT_ID, { trigger: "open" });
      expect(mockTicket).not.toHaveBeenCalled();
      const script = String(mockRunScript.mock.calls[0][0]);
      expect(script).toContain("ingress_unmark");
      expect(script).not.toContain("hivra-cf-tunnel");
    }
  });
});
