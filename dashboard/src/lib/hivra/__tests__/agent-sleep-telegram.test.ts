/** @jest-environment node */

const mockReadRow = jest.fn();
const mockHostRow = jest.fn();
const mockListRows = jest.fn();
const mockUpdate = jest.fn();
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "limit"]) q[m] = () => q;
      q.update = (patch: unknown) => { mockUpdate(table, patch); return q; };
      q.maybeSingle = () => (table === "hivra_agents" ? mockReadRow() : mockHostRow());
      q.then = (resolve: (value: unknown) => unknown) => Promise.resolve(mockListRows(table)).then(resolve);
      return q;
    },
  },
}));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

const mockClaim = jest.fn();
const mockFinish = jest.fn();
const mockLogEvent = jest.fn();
jest.mock("../agent-sleep-store", () => ({
  ...jest.requireActual("../agent-sleep-store"),
  claimAgentSleep: (...a: unknown[]) => mockClaim(...a),
  finishAgentSleep: (...a: unknown[]) => mockFinish(...a),
  logAgentSleepEvent: (...a: unknown[]) => mockLogEvent(...a),
}));

const mockResolveTarget = jest.fn();
jest.mock("../agent-lifecycle-host", () => ({
  resolveHivraLifecycleTarget: (...a: unknown[]) => mockResolveTarget(...a),
}));
const mockRunScript = jest.fn();
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  runProxmoxHostScript: (...a: unknown[]) => mockRunScript(...a),
}));
const mockLapsed = jest.fn();
jest.mock("../lapse-gate", () => ({ isStartBlockedForLapse: (...a: unknown[]) => mockLapsed(...a) }));
jest.mock("@/lib/ssrf-safe-fetch", () => ({ ssrfSafeFetch: jest.fn() }));
jest.mock("@/lib/proxmox/wake-admission", () => ({}));

const mockContext = jest.fn();
const mockClear = jest.fn();
const mockPending = jest.fn();
jest.mock("../telegram-wake/lifecycle", () => ({
  ...jest.requireActual("../telegram-wake/lifecycle"),
  readTelegramSleepContext: (...a: unknown[]) => mockContext(...a),
  telegramWebhookIsClear: (...a: unknown[]) => mockClear(...a),
  markTelegramPendingArm: (...a: unknown[]) => mockPending(...a),
}));

const mockEndpoints = jest.fn();
jest.mock("../agent-profiles/resolve", () => ({ resolveChatEndpoints: (...a: unknown[]) => mockEndpoints(...a) }));

import { sleepHivraAgent } from "../agent-sleep";
import { probeLine } from "./sleep-stub-host.fixtures";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const VMID = 1234;
const NOW = Date.parse("2026-11-12T12:00:00Z");
const now = () => NOW;

function eligibleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    user_id: "user-1",
    type: "claude-code",
    status: "running",
    desired_state: "running",
    operation_id: null,
    deployment_mode: "hivra-managed",
    computer_substrate: "proxmox-kvm",
    deployment_target_id: null,
    cf_hostname: "agent-one.example.test",
    vmid: VMID,
    proxmox_host: "host-a",
    infrastructure_binding_token_enforced: true,
    always_on: false,
    bootstrapped_at: "2026-11-01T00:00:00Z",
    bankr_skills_seeded_at: "2026-11-01T00:00:00Z",
    template_skills_seeded_at: "2026-11-01T00:00:00Z",
    template_skills: [],
    sleep_state: "awake",
    sleep_generation: 3,
    sleep_policy: "full",
    next_wake_at: null,
    cpu: 2,
    ram: 4,
    ...overrides,
  };
}
const host = { status: "active", sleep_mode: "canary" };

const target = {
  executionContext: {
    paths: { provisionerDirectory: "/opt/hivra/provisioner" },
    capacityPolicy: { mode: "observe", hostMemoryReserveMb: 2048, cpuCeilingDensity: 1, memoryCeilingDensity: 1 },
  },
  bindingTag: "hivra-tag-1",
  env: {},
  vmid: VMID,
};

function probeObject(overrides: Record<string, unknown> = {}) {
  return JSON.parse(probeLine(overrides).slice("HIVRA_IDLE ".length));
}
function sleepReceipt(over: Record<string, unknown> = {}) {
  return `HIVRA_SLEEP_RESULT ${JSON.stringify({
    ok: true, vmid: VMID, tier: "nap", from: "awake", to: "napping", reason: "napped", ms: 1200,
    steps: { suspend: 300 }, probe: probeObject(), ...over,
  })}\n`;
}
function wakeReceipt(over: Record<string, unknown> = {}) {
  return `HIVRA_WAKE_RESULT ${JSON.stringify({
    ok: true, vmid: VMID, from: "napping", to: "awake", reason: "resumed", ms: 900, steps: { resume: 100 }, ...over,
  })}\n`;
}

interface Scripts { probe?: string; sleep?: string; wake?: string }
function stubScripts(scripts: Scripts) {
  mockRunScript.mockImplementation(async (script: string) => {
    let stdout: string | undefined;
    if (script.includes("HIVRA_SLEEP_RESULT")) stdout = scripts.sleep;
    else if (script.includes("HIVRA_WAKE_RESULT")) stdout = scripts.wake;
    else stdout = scripts.probe;
    return { ok: stdout !== undefined, stdout: stdout ?? "", stderr: "" };
  });
}

const canary = { HIVRA_SLEEP_MODE: "canary" };
const run = (options: Parameters<typeof sleepHivraAgent>[1]) => sleepHivraAgent(AGENT_ID, { now, env: canary, ...options });

const FP = "0123456789abcdef";
const tgFacts = { hermesFp: FP, hermesTokenInEnv: true, hermesWebhookMode: false, hermesConfigToken: false };
const context = {
  config: { mode: "canary", secret: "x".repeat(40), baseUrl: "https://hooks.example.test/w" },
  row: { agent_id: AGENT_ID, enabled: true, token_enc: "enc", token_fp: FP, state: "idle", blocked_until: null },
  hostAllowed: true,
};
const telegramProbe = (over: Record<string, unknown> = {}) => ({ liveChannels: ["hermes:telegram"], telegram: tgFacts, ...over });
const sleepScript = () => String(mockRunScript.mock.calls.find((c) => String(c[0]).includes("HIVRA_SLEEP_RESULT"))?.[0] ?? "");

describe("sleepHivraAgent with Telegram wake", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockReadRow.mockResolvedValue({ data: eligibleRow({ type: "hermes" }), error: null });
    mockHostRow.mockResolvedValue({ data: host, error: null });
    mockListRows.mockReturnValue({ data: [], error: null });
    mockLapsed.mockResolvedValue(false);
    mockResolveTarget.mockResolvedValue({ ok: true, target });
    mockClaim.mockResolvedValue(4);
    mockFinish.mockResolvedValue(true);
    mockLogEvent.mockResolvedValue(true);
    mockContext.mockResolvedValue(context);
    mockClear.mockResolvedValue(true);
    mockPending.mockResolvedValue(true);
    stubScripts({
      probe: probeLine(telegramProbe()),
      sleep: sleepReceipt({ probe: probeObject(telegramProbe()) }),
      wake: wakeReceipt(),
    });
  });

  it("naps a covered agent: Telegram probe, no webhook, the host gate told, then waiting to be armed", async () => {
    const result = await run({ tier: "nap", trigger: "sweep" });
    expect(result.outcome).toBe("slept");
    expect(mockContext).toHaveBeenCalledWith(AGENT_ID, "canary", canary);
    expect(String(mockRunScript.mock.calls[0][0])).toContain('OUT["telegram"]');
    expect(mockClear).toHaveBeenCalledTimes(1);
    expect(mockClear.mock.invocationCallOrder[0]).toBeLessThan(mockClaim.mock.invocationCallOrder[0]);
    expect(sleepScript()).toContain("HIVRA_COVERED_CHANNELS='hermes:telegram'");
    expect(sleepScript()).toContain(`HIVRA_TG_FP='${FP}'`);
    expect(mockPending).toHaveBeenCalledWith(AGENT_ID);
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "nap", detail: expect.objectContaining({ tg_covered: true }) }));
  });

  it("marks the row while the sleep still holds the agent, so a finish that is not recorded still leaves it waiting", async () => {
    mockFinish.mockResolvedValue(false);
    await expect(run({ tier: "nap", trigger: "sweep" })).resolves.toMatchObject({ outcome: "failed", reason: "finish_not_recorded" });
    expect(mockPending).toHaveBeenCalledWith(AGENT_ID);
    expect(mockPending.mock.invocationCallOrder[0]).toBeLessThan(mockFinish.mock.invocationCallOrder[0]);
  });

  it("wakes the agent instead of leaving it asleep and deaf when the row cannot be marked", async () => {
    for (const marked of [() => Promise.resolve(false), () => Promise.reject(new Error("db"))]) {
      mockPending.mockImplementationOnce(marked);
      mockFinish.mockClear();
      mockRunScript.mockClear();
      await expect(run({ tier: "nap", trigger: "sweep" })).resolves.toMatchObject({ outcome: "failed", state: "awake", reason: "telegram_mark_failed" });
      expect(mockRunScript.mock.calls.some((c) => String(c[0]).includes("HIVRA_WAKE_RESULT"))).toBe(true);
      expect(mockFinish).toHaveBeenCalledWith(expect.objectContaining({ result: "awake" }));
    }
  });

  it("stays awake when the bot already has a webhook, before any lease", async () => {
    mockClear.mockResolvedValue(false);
    await expect(run({ tier: "nap", trigger: "sweep" })).resolves.toMatchObject({ outcome: "not_idle", reason: "telegram_webhook_set" });
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockPending).not.toHaveBeenCalled();
  });

  it("stays awake as before when Telegram is not covered (another channel)", async () => {
    stubScripts({ probe: probeLine(telegramProbe({ liveChannels: ["hermes:telegram", "hermes:discord"] })) });
    await expect(run({ tier: "nap", trigger: "sweep" })).resolves.toMatchObject({ outcome: "not_idle", reason: "live_channels" });
    expect(mockClear).not.toHaveBeenCalled();
  });

  it("stays awake as before with the feature off: the plain probe, no Telegram calls", async () => {
    mockContext.mockResolvedValue(null);
    await expect(run({ tier: "nap", trigger: "sweep" })).resolves.toMatchObject({ outcome: "not_idle", reason: "live_channels" });
    expect(String(mockRunScript.mock.calls[0][0])).not.toContain('OUT["telegram"]');
    expect(mockClear).not.toHaveBeenCalled();
  });

  it("wakes it again when the script's own probe shows the token changed (the re-check agrees with the host gate)", async () => {
    stubScripts({
      probe: probeLine(telegramProbe()),
      sleep: sleepReceipt({ probe: probeObject(telegramProbe({ telegram: { ...tgFacts, hermesFp: "fedcba9876543210" } })) }),
      wake: wakeReceipt(),
    });
    await expect(run({ tier: "nap", trigger: "sweep" })).resolves.toMatchObject({ outcome: "aborted", reason: "recheck_not_idle" });
    expect(mockPending).not.toHaveBeenCalled();
  });
});

describe("sleepHivraAgent with agent wake profiles on", () => {
  const profilesOn = { ...canary, HIVRA_AGENT_PROFILES: "on" };
  const ocProbe = (over: Record<string, unknown> = {}) => ({ liveChannels: ["openclaw:telegram"], telegram: tgFacts, ...over });
  const probeScript = () => String(mockRunScript.mock.calls[0][0]);
  beforeEach(() => {
    jest.resetAllMocks();
    mockReadRow.mockResolvedValue({ data: eligibleRow({ type: "openclaw" }), error: null });
    mockHostRow.mockResolvedValue({ data: host, error: null });
    mockListRows.mockReturnValue({ data: [], error: null });
    mockLapsed.mockResolvedValue(false);
    mockResolveTarget.mockResolvedValue({ ok: true, target });
    mockClaim.mockResolvedValue(4);
    mockFinish.mockResolvedValue(true);
    mockLogEvent.mockResolvedValue(true);
    mockContext.mockResolvedValue(context);
    mockClear.mockResolvedValue(true);
    mockPending.mockResolvedValue(true);
    mockEndpoints.mockResolvedValue([{ p: "telegram", ports: [443], a: ["0A0200C0"] }]);
    stubScripts({ probe: probeLine(ocProbe()), sleep: sleepReceipt({ probe: probeObject(ocProbe()) }), wake: wakeReceipt() });
  });

  it("covers OpenClaw's own Telegram bot through its profile, with the profile probe on both sides", async () => {
    await expect(sleepHivraAgent(AGENT_ID, { now, env: profilesOn, tier: "nap", trigger: "sweep" })).resolves.toMatchObject({ outcome: "slept" });
    expect(probeScript()).toContain("PROFILE_B64");
    expect(sleepScript()).toContain("PROFILE_B64");
    expect(sleepScript()).toContain("HIVRA_COVERED_CHANNELS='openclaw:telegram'");
    expect(sleepScript()).toContain(`my %allowed = map { $_ => 1 } ("openclaw:telegram");`);
    expect(mockPending).toHaveBeenCalledWith(AGENT_ID);
  });

  it("with profiles off, OpenClaw's bot keeps it awake as before, and nothing is resolved", async () => {
    await expect(run({ tier: "nap", trigger: "sweep" })).resolves.toMatchObject({ outcome: "not_idle", reason: "live_channels" });
    expect(probeScript()).not.toContain("PROFILE_B64");
    expect(mockEndpoints).not.toHaveBeenCalled();
  });

  it("never covers an unknown chat connection, or Telegram on a type whose profile declares none", async () => {
    stubScripts({ probe: probeLine(ocProbe({ liveChannels: ["openclaw:telegram", "unknown:telegram"] })) });
    await expect(sleepHivraAgent(AGENT_ID, { now, env: profilesOn, tier: "nap", trigger: "sweep" })).resolves.toMatchObject({ outcome: "not_idle", reason: "live_channels" });
    mockReadRow.mockResolvedValue({ data: eligibleRow({ type: "codex" }), error: null });
    stubScripts({ probe: probeLine(telegramProbe()) });
    await expect(sleepHivraAgent(AGENT_ID, { now, env: profilesOn, tier: "nap", trigger: "sweep" })).resolves.toMatchObject({ outcome: "not_idle", reason: "live_channels" });
    expect(mockClear).not.toHaveBeenCalled();
  });

  it("probes with an empty safety net when the chat services cannot be resolved", async () => {
    mockEndpoints.mockRejectedValue(new Error("dns"));
    await expect(sleepHivraAgent(AGENT_ID, { now, env: profilesOn, tier: "nap", trigger: "sweep" })).resolves.toMatchObject({ outcome: "slept" });
  });
});
