/** @jest-environment node */

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

const mockRows: Array<Record<string, unknown>> = [];
const mockUpdates: Array<{ agentId: string; channel: string; patch: Record<string, unknown> }> = [];
jest.mock("../store", () => ({
  readChannelWakeRows: async (agentId: string) => mockRows.filter((r) => r.agent_id === agentId),
  updateChannelWakeRow: async (agentId: string, channel: string, _from: string[], patch: Record<string, unknown>) => {
    mockUpdates.push({ agentId, channel, patch });
    return true;
  },
}));
const mockUpserts: Array<Record<string, unknown>> = [];
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: () => ({ upsert: async (row: Record<string, unknown>) => { mockUpserts.push(row); return { error: null }; } }) },
}));
jest.mock("../../agent-sleep", () => ({ readSleepHostRow: jest.fn() }));
const mockTarget = jest.fn();
jest.mock("../../agent-wake", () => ({ resolveSleepTarget: (...a: unknown[]) => mockTarget(...a), readHivraAgentRow: jest.fn() }));
jest.mock("@/lib/services/proxmox-instance-service", () => ({ runProxmoxHostScript: jest.fn(), runProxmoxHostScriptWithStdin: jest.fn() }));

import { disableChannelWake, enableChannelWake, isOwnerSwitchChannel, readChannelWakeView } from "../owner";
import { readEmailOptIn } from "../adapters/email-imap";

const AGENT = "00000000-0000-4000-8000-0000000a0021";
const FP = "0123456789abcdef";
const ENV = {
  HIVRA_CHANNEL_WAKE: "on",
  HIVRA_CHANNEL_WAKE_CHANNELS: "email",
  HIVRA_CHANNEL_WAKE_SECRET: "s".repeat(40),
  HIVRA_WAKE_DOORBELLS: "email",
};
const agent = {
  id: AGENT, user_id: "user_x", type: "hermes", deployment_mode: "hivra-managed", computer_substrate: "proxmox-kvm",
  status: "running", sleep_state: "awake",
};
const target = { vmid: 123, bindingTag: "hivra-x", env: {} };

beforeEach(() => {
  mockRows.length = 0;
  mockUpdates.length = 0;
  mockUpserts.length = 0;
  mockTarget.mockResolvedValue({ ok: true, target });
});

describe("the email owner switch", () => {
  it("needs the doorbell switch on top of the channel wake switches", async () => {
    expect(isOwnerSwitchChannel("email")).toBe(true);
    expect((await readChannelWakeView(agent, "email", { env: ENV })).available).toBe(true);
    expect((await readChannelWakeView(agent, "email", { env: { ...ENV, HIVRA_WAKE_DOORBELLS: "" } })).available).toBe(false);
  });

  it("stores only the fingerprint and the IMAP host at opt-in", async () => {
    const readEmail = jest.fn(async () => ({ ok: true as const, fp: FP, imapHost: "imap.example.test" }));
    const change = await enableChannelWake(agent, "email", { env: ENV, readEmail, now: () => 0 });
    expect(change).toEqual({ ok: true, view: { channel: "email", available: true, enabled: true, armed: true }, wake: false });
    expect(readEmail).toHaveBeenCalledWith(target);
    expect(mockUpserts[0]).toMatchObject({
      agent_id: AGENT, channel: "email", cred_fp: FP, arm_id: null, enabled: true, state: "idle",
      arm_data: { imapHost: "imap.example.test", optedInAt: "1970-01-01T00:00:00.000Z" },
    });
  });

  it("explains a missing mailbox", async () => {
    const change = await enableChannelWake(agent, "email", { env: ENV, readEmail: async () => ({ ok: false, reason: "no_email" }) });
    expect(change).toMatchObject({ ok: false, status: 409, code: "no_email" });
    expect(mockUpserts).toEqual([]);
  });

  it("turning it off forgets the opt-in and wakes a sleeping agent so its arm comes down", async () => {
    mockRows.push({ agent_id: AGENT, channel: "email", enabled: true, cred_fp: FP, state: "armed", arm_id: "x", arm_data: { vmid: 123 } });
    const change = await disableChannelWake({ ...agent, sleep_state: "napping" }, "email", { env: ENV });
    expect(change).toMatchObject({ ok: true, wake: true });
    expect(mockUpdates[0].patch).toMatchObject({ enabled: false, cred_fp: null, arm_id: null, arm_data: {} });
  });
});

describe("readEmailOptIn", () => {
  it("reads the fingerprint through the probe and never a value", async () => {
    const probe = {
      v: 1, errors: [], activeRuns: 0, cliProcesses: 0, openConnections: 0, gatewayConnections: 0, terminalAttached: false,
      terminalClients: 0, sshSessions: 0, desktopAttached: false, lastUsedAt: null, nextJobAt: null, liveChannels: ["hermes:email"],
      loadavg: [0, 0, 0], cpus: 2, uptimeS: 99999, now: "2026-11-13T00:00:00Z", ms: 5,
      channelFps: { email: FP }, channelFacts: { email: { imapHost: "imap.example.test" } },
    };
    const run = jest.fn(async () => ({ ok: true, stdout: `HIVRA_IDLE ${JSON.stringify(probe)}\n`, stderr: "" }));
    expect(await readEmailOptIn(target, { run: run as never })).toEqual({ ok: true, fp: FP, imapHost: "imap.example.test" });
    expect((run.mock.calls[0] as unknown as [string])[0]).toContain('OUT["channelFps"] = {"email": chan_fp(');
    const refused = jest.fn(async () => ({ ok: true, stdout: "HIVRA_IDLE_REFUSED asleep\n", stderr: "" }));
    expect(await readEmailOptIn(target, { run: refused as never })).toEqual({ ok: false, reason: "asleep" });
  });
});
