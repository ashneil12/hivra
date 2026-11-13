/** @jest-environment node */
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock("@/lib/logger", () => ({ log: mockLog }));

const mockConnections = jest.fn();
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) q[m] = () => q;
      q.limit = async () => mockConnections();
      return q;
    },
  },
}));
const mockHost = jest.fn();
jest.mock("../../agent-sleep", () => ({ readSleepHostRow: (...a: unknown[]) => mockHost(...a) }));
const mockTarget = jest.fn();
jest.mock("../../agent-wake", () => ({ resolveSleepTarget: (...a: unknown[]) => mockTarget(...a) }));
const mockRunScript = jest.fn();
jest.mock("@/lib/services/proxmox-instance-service", () => ({ runProxmoxHostScript: (...a: unknown[]) => mockRunScript(...a) }));

type Row = Record<string, unknown> & { state: string };
let stored: Row | null = null;
const mockSave = jest.fn();
jest.mock("../store", () => ({
  readTelegramWakeRow: async () => stored,
  saveTelegramWakeOptIn: (...a: unknown[]) => mockSave(...a),
  updateTelegramWakeRow: async (_id: string, from: string[], patch: Record<string, unknown>) => {
    if (!stored || !from.includes(stored.state)) return false;
    Object.assign(stored, patch);
    return true;
  },
}));

import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { disableTelegramWake, enableTelegramWake, readTelegramWakeView } from "../owner";
import { telegramTokenFingerprint } from "../bot-api";

const FINGERPRINT = ["0123", "4567", "89ab", "cdef"].join("");
const AGENT = "11111111-1111-4111-8111-111111111111";
const sample = [String(7_000_000_000 + 4321), "Ab_-".repeat(9)].join(":");
const env = { HIVRA_TELEGRAM_WAKE: "canary", HIVRA_TELEGRAM_WAKE_SECRET: "x".repeat(40), HIVRA_TELEGRAM_WAKE_BASE_URL: "https://hooks.example.test/w" };
const agent = (over: Record<string, unknown> = {}) => ({
  id: AGENT, user_id: "user-1", type: "hermes", status: "running", sleep_state: "awake",
  deployment_mode: "hivra-managed", computer_substrate: "proxmox-kvm", proxmox_host: "local", ...over,
});
const target = { vmid: 1234, bindingTag: "tag-1", env: {} };
function fetchWith(status: number, body: unknown) {
  return jest.fn(async () => new Response(JSON.stringify(body), { status }));
}

beforeAll(() => { process.env.ENCRYPTION_KEY = "cd".repeat(32); });
beforeEach(() => {
  jest.clearAllMocks();
  stored = null;
  mockConnections.mockResolvedValue({ data: [{ target_id: AGENT }], error: null });
  mockHost.mockResolvedValue({ status: "active", sleep_mode: "canary" });
  mockTarget.mockResolvedValue({ ok: true, target });
  mockRunScript.mockResolvedValue({ ok: true, stdout: `HIVRA_TG_TOKEN ${sample}\n`, stderr: "" });
  mockSave.mockResolvedValue(true);
});
afterEach(() => {
  const logged = JSON.stringify([mockLog.info.mock.calls, mockLog.warn.mock.calls, mockLog.error.mock.calls]);
  expect(logged).not.toContain(sample);
});

describe("availability", () => {
  it("shows the switch only with the server switch on, a Hermes agent, an allowed host and a Telegram bot", async () => {
    await expect(readTelegramWakeView(agent(), "user-1", { env })).resolves.toEqual({ available: true, enabled: false, armed: false });
    await expect(readTelegramWakeView(agent(), "user-1", { env: {} })).resolves.toMatchObject({ available: false });
    await expect(readTelegramWakeView(agent({ type: "openclaw" }), "user-1", { env })).resolves.toMatchObject({ available: false });
    mockHost.mockResolvedValueOnce({ status: "active", sleep_mode: "off" });
    await expect(readTelegramWakeView(agent(), "user-1", { env })).resolves.toMatchObject({ available: false });
    mockConnections.mockResolvedValueOnce({ data: [], error: null });
    await expect(readTelegramWakeView(agent(), "user-1", { env })).resolves.toMatchObject({ available: false });
  });
});

describe("enable", () => {
  it("reads the token once, checks it with getMe, and stores it encrypted with its fingerprint", async () => {
    const fetchImpl = fetchWith(200, { ok: true, result: { id: 99 } });
    const result = await enableTelegramWake(agent(), "user-1", { env, fetchImpl });
    expect(result).toEqual({ ok: true, view: { available: true, enabled: true, armed: false }, wake: false });
    expect(JSON.stringify(result)).not.toContain(sample);
    const saved = mockSave.mock.calls[0][0];
    expect(saved).toMatchObject({ agentId: AGENT, userId: "user-1", tokenFp: telegramTokenFingerprint(sample), botId: 99 });
    expect(saved.tokenEnc).not.toContain(sample);
    expect(decryptSecret(saved.tokenEnc)).toBe(sample);
    expect(String(mockRunScript.mock.calls[0][0])).toContain("hivra-tg-token-read");
  });

  it("refuses an asleep agent, a missing token or a token Telegram rejects, without saving", async () => {
    await expect(enableTelegramWake(agent({ sleep_state: "napping" }), "user-1", { env })).resolves.toMatchObject({ ok: false, code: "not_awake" });
    mockRunScript.mockResolvedValueOnce({ ok: true, stdout: "HIVRA_TG_TOKEN_NONE no_token\n", stderr: "" });
    await expect(enableTelegramWake(agent(), "user-1", { env })).resolves.toMatchObject({ ok: false, code: "no_token" });
    const rejected = await enableTelegramWake(agent(), "user-1", { env, fetchImpl: fetchWith(401, { ok: false }) });
    expect(rejected).toMatchObject({ ok: false, code: "token_rejected" });
    expect(JSON.stringify(rejected)).not.toContain(sample);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("is refused when the feature is off", async () => {
    await expect(enableTelegramWake(agent(), "user-1", { env: {} })).resolves.toMatchObject({ ok: false, status: 409, code: "not_available" });
    expect(mockRunScript).not.toHaveBeenCalled();
  });
});

describe("disable", () => {
  const armed = (): Row => ({ agent_id: AGENT, enabled: true, token_enc: encryptSecret(sample), token_fp: FINGERPRINT, state: "armed" });

  it("takes the webhook down first, then forgets the token, and asks for a wake", async () => {
    stored = armed();
    const fetchImpl = fetchWith(200, { ok: true, result: true });
    const result = await disableTelegramWake(agent(), { env, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String((fetchImpl.mock.calls[0] as unknown as [string])[0])).toMatch(/\/deleteWebhook$/);
    expect(stored).toMatchObject({ enabled: false, state: "idle", token_enc: null, token_fp: null });
    expect(result).toMatchObject({ ok: true, wake: true, view: { enabled: false } });
  });

  it("keeps the token for the sweep when Telegram cannot be reached", async () => {
    stored = armed();
    const result = await disableTelegramWake(agent(), { env, fetchImpl: fetchWith(500, { ok: false }) });
    expect(stored).toMatchObject({ enabled: false, state: "disarm_failed" });
    expect(stored!.token_enc).toBeTruthy();
    expect(result).toMatchObject({ ok: true, wake: true });
  });

  it("needs no Telegram call for a row that was idle", async () => {
    stored = { ...armed(), state: "idle" };
    const fetchImpl = fetchWith(200, { ok: true, result: true });
    await expect(disableTelegramWake(agent(), { env, fetchImpl })).resolves.toMatchObject({ ok: true, wake: false });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(stored).toMatchObject({ enabled: false, token_enc: null });
  });
});
