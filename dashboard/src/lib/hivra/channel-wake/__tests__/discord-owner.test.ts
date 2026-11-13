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
import { createDiscordDoorbellAdapter } from "../adapters/discord-doorbell";
import { createEmailImapAdapter } from "../adapters/email-imap";
import { disarmChannelsForWake } from "../lifecycle";

const AGENT = "00000000-0000-4000-8000-0000000a0022";
const ARM = "0f0e0d0c-0b0a-4908-8706-050403020100";
const FP = "0123456789abcdef";
const ENV = {
  HIVRA_CHANNEL_WAKE: "on",
  HIVRA_CHANNEL_WAKE_CHANNELS: "discord",
  HIVRA_CHANNEL_WAKE_SECRET: "s".repeat(40),
  HIVRA_WAKE_DOORBELLS: "discord",
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

describe("the Discord owner switch", () => {
  it("needs discord in both the channel list and the doorbell switch", async () => {
    expect(isOwnerSwitchChannel("discord")).toBe(true);
    expect((await readChannelWakeView(agent, "discord", { env: ENV })).available).toBe(true);
    expect((await readChannelWakeView(agent, "discord", { env: { ...ENV, HIVRA_WAKE_DOORBELLS: "email" } })).available).toBe(false);
    expect((await readChannelWakeView(agent, "discord", { env: { ...ENV, HIVRA_CHANNEL_WAKE_CHANNELS: "email" } })).available).toBe(false);
    expect((await readChannelWakeView(agent, "discord", { env: {} })).available).toBe(false);
  });

  it("stores only the token's fingerprint at opt-in", async () => {
    const readDiscord = jest.fn(async () => ({ ok: true as const, fp: FP, backfill: true, dmBackfilled: true }));
    const change = await enableChannelWake(agent, "discord", { env: ENV, readDiscord, now: () => 0 });
    expect(change).toEqual({ ok: true, view: { channel: "discord", available: true, enabled: true, armed: true }, wake: false });
    expect(readDiscord).toHaveBeenCalledWith(target);
    expect(mockUpserts[0]).toMatchObject({
      agent_id: AGENT, channel: "discord", cred_fp: FP, arm_id: null, enabled: true, state: "idle",
      arm_data: { optedInAt: "1970-01-01T00:00:00.000Z" },
    });
  });

  it("explains why catch-up must be on first", async () => {
    for (const reason of ["backfill_off", "dm_not_backfilled", "no_discord"]) {
      const change = await enableChannelWake(agent, "discord", { env: ENV, readDiscord: async () => ({ ok: false, reason }) });
      expect(change).toMatchObject({ ok: false, status: 409, code: reason });
      expect((change as { message: string }).message).not.toMatch(/Could not read/);
    }
    expect(mockUpserts).toEqual([]);
  });

  it("turning it off forgets the opt-in and wakes a sleeping agent so its arm comes down", async () => {
    mockRows.push({ agent_id: AGENT, channel: "discord", enabled: true, cred_fp: FP, state: "armed", arm_id: ARM, arm_data: { vmid: 123 } });
    const change = await disableChannelWake({ ...agent, sleep_state: "napping" }, "discord", { env: ENV });
    expect(change).toMatchObject({ ok: true, wake: true });
    expect(mockUpdates[0].patch).toMatchObject({ enabled: false, cred_fp: null, arm_id: null, arm_data: {} });
  });
});

describe("the wake", () => {
  it("takes a Discord arm down and asks the resume to drop the guest's stale sockets", async () => {
    mockRows.push({ agent_id: AGENT, channel: "discord", enabled: true, cred_fp: FP, state: "armed", arm_id: ARM, arm_data: { vmid: 123 } });
    const run = jest.fn(async () => ({ ok: true, stdout: 'HIVRA_DOORBELL_DISARM {"ok":true,"vmid":123,"was":"fired"}\n', stderr: "" }));
    const adapter = createDiscordDoorbellAdapter({ env: ENV, run: run as never, resolveTarget: async () => target });
    const disarms = await disarmChannelsForWake(AGENT, { env: ENV, adapters: [adapter] });
    expect(disarms.generic).toMatchObject([{ channel: "discord", previous: "armed", called: true, ok: true }]);
    expect(disarms.killStaleSockets).toBe(true);
    expect((run.mock.calls[0] as unknown as [string])[0]).toContain(`"cmd":"disarm","vmid":123,"arm_id":"${ARM}"`);
    expect(mockUpdates.at(-1)).toMatchObject({ channel: "discord", patch: { state: "idle" } });
  });

  it("an email arm alone does not (email is not a socket)", async () => {
    mockRows.push({ agent_id: AGENT, channel: "email", enabled: true, cred_fp: FP, state: "armed", arm_id: ARM, arm_data: { vmid: 123 } });
    const run = jest.fn(async () => ({ ok: true, stdout: 'HIVRA_DOORBELL_DISARM {"ok":true,"vmid":123,"was":"armed"}\n', stderr: "" }));
    const adapter = createEmailImapAdapter({ env: ENV, run: run as never, resolveTarget: async () => target });
    const disarms = await disarmChannelsForWake(AGENT, { env: ENV, adapters: [adapter] });
    expect(disarms.generic).toMatchObject([{ channel: "email", ok: true }]);
    expect(disarms.telegram).toBeNull();
    expect(disarms.killStaleSockets).toBe(false);
  });
});
