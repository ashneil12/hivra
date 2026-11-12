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

import { readSleepFacts, resolveSleepTimings, sleepEligibility, sleepHivraAgent, type SleepFacts } from "../agent-sleep";
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
const okFacts: SleepFacts = { activeMove: false, openAttachment: false, ownerLapsed: false };
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
const ranScript = (marker: string) => mockRunScript.mock.calls.some((c) => String(c[0]).includes(marker));

const canary = { HIVRA_SLEEP_MODE: "canary" };
const run = (options: Parameters<typeof sleepHivraAgent>[1]) => sleepHivraAgent(AGENT_ID, { now, env: canary, ...options });

describe("sleepEligibility", () => {
  it("accepts a plain eligible agent on a canary host", () => {
    expect(sleepEligibility(eligibleRow(), host, okFacts, { serverMode: "canary", tier: "nap" })).toEqual({ eligible: true, reasons: [] });
  });

  it.each([
    ["not running", { status: "stopped" }, "not_running"],
    ["desired state", { desired_state: "stopped" }, "desired_state_not_running"],
    ["operation in flight", { operation_id: "x" }, "operation_in_flight"],
    ["not hivra managed", { deployment_mode: "self-managed" }, "not_hivra_managed"],
    ["not proxmox", { computer_substrate: "gvisor" }, "not_proxmox_kvm"],
    ["own server", { deployment_target_id: "t" }, "own_server"],
    ["no tunnel", { cf_hostname: null }, "no_named_tunnel"],
    ["no vm", { vmid: null }, "no_computer"],
    ["tag not enforced", { infrastructure_binding_token_enforced: false }, "binding_not_enforced"],
    ["aeon", { type: "aeon" }, "kind_aeon"],
    ["desktop", { type: "linux-desktop" }, "kind_linux-desktop"],
    ["always on", { always_on: true }, "always_on"],
    ["always_on unknown", { always_on: null }, "always_on"],
    ["not bootstrapped", { bootstrapped_at: null }, "not_bootstrapped"],
    ["bankr seed missing", { bankr_skills_seeded_at: null }, "bankr_seed_pending"],
    ["template seed missing", { template_skills_seeded_at: null, template_skills: ["a-skill"] }, "template_seed_pending"],
  ])("refuses %s", (_name, overrides, reason) => {
    const result = sleepEligibility(eligibleRow(overrides as Record<string, unknown>), host, okFacts, { serverMode: "canary" });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain(reason);
  });

  it("does not need a template seed when the agent has no template skills", () => {
    const row = eligibleRow({ template_skills_seeded_at: null, template_skills: [] });
    expect(sleepEligibility(row, host, okFacts, { serverMode: "canary" }).eligible).toBe(true);
  });

  it("treats unknown facts as not eligible", () => {
    const result = sleepEligibility(eligibleRow(), host, { activeMove: null, openAttachment: null, ownerLapsed: null }, { serverMode: "canary" });
    expect(result.reasons).toEqual(expect.arrayContaining(["move_unknown", "attachment_unknown", "lapse_unknown"]));
    const known = sleepEligibility(eligibleRow(), host, { activeMove: true, openAttachment: true, ownerLapsed: true }, { serverMode: "canary" });
    expect(known.reasons).toEqual(expect.arrayContaining(["move_active", "attachment_open", "owner_lapsed"]));
  });

  it("refuses an unknown host, a host in maintenance, and a host whose sleep switch is not canary or on", () => {
    expect(sleepEligibility(eligibleRow(), null, okFacts, { serverMode: "canary" }).reasons).toContain("host_unknown");
    expect(sleepEligibility(eligibleRow(), { status: "maintenance", sleep_mode: "on" }, okFacts, { serverMode: "on" }).reasons).toContain("host_maintenance");
    expect(sleepEligibility(eligibleRow(), { status: "active", sleep_mode: "off" }, okFacts, { serverMode: "on" }).reasons).toContain("host_sleep_mode_off");
    expect(sleepEligibility(eligibleRow(), { status: "active", sleep_mode: "observe" }, okFacts, { serverMode: "on" }).reasons).toContain("host_sleep_mode_off");
    expect(sleepEligibility(eligibleRow(), { status: "active", sleep_mode: "on" }, okFacts, { serverMode: "on" }).eligible).toBe(true);
  });

  it("lets a manual sleep skip the host switch on a canary server only", () => {
    const off = { status: "active", sleep_mode: "off" };
    expect(sleepEligibility(eligibleRow(), off, okFacts, { manual: true, serverMode: "canary" }).eligible).toBe(true);
    expect(sleepEligibility(eligibleRow(), off, okFacts, { manual: true, serverMode: "on" }).reasons).toContain("host_sleep_mode_off");
    expect(sleepEligibility(eligibleRow(), { status: "maintenance", sleep_mode: "off" }, okFacts, { manual: true, serverMode: "canary" }).reasons).toContain("host_maintenance");
    expect(sleepEligibility(eligibleRow({ always_on: true }), off, okFacts, { manual: true, serverMode: "canary" }).reasons).toContain("always_on");
  });

  it("asks for the agent's policy on canary and honours t1 and t3, but not in on mode or for a manual sleep", () => {
    const off = eligibleRow({ sleep_policy: "off" });
    expect(sleepEligibility(off, host, okFacts, { serverMode: "canary", tier: "nap" }).reasons).toContain("policy_off");
    expect(sleepEligibility(off, host, okFacts, { serverMode: "on", tier: "nap" }).eligible).toBe(true);
    expect(sleepEligibility(off, host, okFacts, { serverMode: "canary", manual: true }).eligible).toBe(true);
    expect(sleepEligibility(eligibleRow({ sleep_policy: "t1" }), host, okFacts, { serverMode: "canary", tier: "hibernate" }).reasons).toContain("policy_tier_not_allowed");
    expect(sleepEligibility(eligibleRow({ sleep_policy: "t1" }), host, okFacts, { serverMode: "canary", tier: "nap" }).eligible).toBe(true);
    expect(sleepEligibility(eligibleRow({ sleep_policy: "t3" }), host, okFacts, { serverMode: "canary", tier: "nap" }).reasons).toContain("policy_tier_not_allowed");
  });
});

describe("readSleepFacts", () => {
  beforeEach(() => { jest.resetAllMocks(); mockLapsed.mockResolvedValue(false); });
  const facts = (rows: Record<string, unknown>) => {
    mockListRows.mockImplementation((table: string) => rows[table] ?? { data: [], error: null });
    return readSleepFacts(eligibleRow());
  };

  it("sees an open attachment, or an open detach or access step, as not safe to sleep", async () => {
    expect((await facts({})).openAttachment).toBe(false);
    expect((await facts({ hivra_agent_attachments: { data: [{ id: "a" }], error: null } })).openAttachment).toBe(true);
    expect((await facts({ hivra_agent_attachment_operations: { data: [{ id: "o" }], error: null } })).openAttachment).toBe(true);
  });

  it("calls an attachment read that failed unknown, unless the other read already found one", async () => {
    const failed = { data: null, error: { message: "x" } };
    expect((await facts({ hivra_agent_attachments: failed })).openAttachment).toBeNull();
    expect((await facts({ hivra_agent_attachment_operations: failed })).openAttachment).toBeNull();
    expect((await facts({ hivra_agent_attachments: { data: [{ id: "a" }], error: null }, hivra_agent_attachment_operations: failed })).openAttachment).toBe(true);
  });
});

describe("resolveSleepTimings", () => {
  it("defaults to 300 and 900 seconds and ignores nonsense", () => {
    expect(resolveSleepTimings({})).toEqual({ napAfterSeconds: 300, hibernateAfterSeconds: 900, horizonSeconds: 1200 });
    expect(resolveSleepTimings({ HIVRA_SLEEP_NAP_AFTER_SECONDS: "120", HIVRA_SLEEP_HIBERNATE_AFTER_SECONDS: "600" }))
      .toEqual({ napAfterSeconds: 120, hibernateAfterSeconds: 600, horizonSeconds: 1200 });
    expect(resolveSleepTimings({ HIVRA_SLEEP_NAP_AFTER_SECONDS: "abc", HIVRA_SLEEP_HIBERNATE_AFTER_SECONDS: "1" }).napAfterSeconds).toBe(300);
    expect(resolveSleepTimings({ HIVRA_SLEEP_HIBERNATE_AFTER_SECONDS: "1" }).hibernateAfterSeconds).toBe(900);
  });
});

describe("sleepHivraAgent", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockReadRow.mockResolvedValue({ data: eligibleRow(), error: null });
    mockHostRow.mockResolvedValue({ data: host, error: null });
    mockListRows.mockReturnValue({ data: [], error: null });
    mockUpdate.mockReturnValue(undefined);
    mockLapsed.mockResolvedValue(false);
    mockResolveTarget.mockResolvedValue({ ok: true, target });
    mockClaim.mockResolvedValue(4);
    mockFinish.mockResolvedValue(true);
    mockLogEvent.mockResolvedValue(true);
    stubScripts({ probe: probeLine(), sleep: sleepReceipt(), wake: wakeReceipt() });
  });

  it("does nothing unless the server mode acts", async () => {
    await expect(run({ tier: "nap", trigger: "sweep", env: {} })).resolves.toEqual({ outcome: "skipped", reason: "sleep_mode_off" });
    await expect(run({ tier: "nap", trigger: "sweep", env: { HIVRA_SLEEP_MODE: "observe" } })).resolves.toEqual({ outcome: "skipped", reason: "observe_only" });
    expect(mockReadRow).not.toHaveBeenCalled();
    expect(mockRunScript).not.toHaveBeenCalled();
  });

  it("returns ineligible with every reason, and touches no host", async () => {
    mockReadRow.mockResolvedValue({ data: eligibleRow({ always_on: true }), error: null });
    mockListRows.mockImplementation((table: string) => ({ data: table === "hermes_computer_moves" ? [{ id: "m" }] : [], error: null }));
    const result = await run({ tier: "nap", trigger: "sweep" });
    expect(result.outcome).toBe("ineligible");
    expect(result.reasons).toEqual(expect.arrayContaining(["always_on", "move_active"]));
    expect(mockRunScript).not.toHaveBeenCalled();
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("treats a failed facts read as unknown, so ineligible", async () => {
    mockListRows.mockReturnValue({ data: null, error: { message: "x" } });
    const result = await run({ tier: "nap", trigger: "sweep" });
    expect(result.outcome).toBe("ineligible");
    expect(result.reasons).toEqual(expect.arrayContaining(["move_unknown", "attachment_unknown"]));
  });

  it("is ineligible for a lapsed owner and for an unreadable host", async () => {
    mockLapsed.mockResolvedValue(true);
    expect((await run({ tier: "nap", trigger: "sweep" })).reasons).toContain("owner_lapsed");
    mockLapsed.mockResolvedValue(false);
    mockHostRow.mockResolvedValue({ data: null, error: { message: "x" } });
    expect((await run({ tier: "nap", trigger: "sweep" })).reasons).toContain("host_unknown");
  });

  it("skips when the agent is not in a state this tier starts from", async () => {
    mockReadRow.mockResolvedValue({ data: eligibleRow({ sleep_state: "napping" }), error: null });
    await expect(run({ tier: "nap", trigger: "sweep" })).resolves.toEqual({ outcome: "skipped", reason: "not_awake" });
    mockReadRow.mockResolvedValue({ data: eligibleRow({ sleep_state: "hibernated" }), error: null });
    await expect(run({ tier: "hibernate", trigger: "sweep" })).resolves.toEqual({ outcome: "skipped", reason: "not_awake_or_napping" });
  });

  it("leaves an agent that is in use alone, with no lease", async () => {
    stubScripts({ probe: probeLine({ activeRuns: 1, nextJobAt: "2026-11-12T12:05:00Z" }) });
    const result = await run({ tier: "nap", trigger: "sweep" });
    expect(result.outcome).toBe("not_idle");
    expect(result.reasons).toEqual(expect.arrayContaining(["active_runs", "job_soon"]));
    expect(mockClaim).not.toHaveBeenCalled();
    expect(ranScript("HIVRA_SLEEP_RESULT")).toBe(false);
  });

  it("skips when the probe is refused or unreadable", async () => {
    stubScripts({ probe: "HIVRA_IDLE_REFUSED asleep\n" });
    await expect(run({ tier: "nap", trigger: "sweep" })).resolves.toEqual({ outcome: "skipped", reason: "asleep" });
    stubScripts({ probe: "garbage" });
    await expect(run({ tier: "nap", trigger: "sweep" })).resolves.toEqual({ outcome: "skipped", reason: "probe_unavailable" });
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("skips when the claim is refused", async () => {
    mockClaim.mockResolvedValue(null);
    await expect(run({ tier: "nap", trigger: "sweep" })).resolves.toEqual({ outcome: "skipped", reason: "claim_refused" });
    expect(ranScript("HIVRA_SLEEP_RESULT")).toBe(false);
  });

  it("naps an idle agent: claim at the current generation, script, finish, event, next wake", async () => {
    stubScripts({
      probe: probeLine({ nextJobAt: "2026-11-12T13:00:00Z" }),
      sleep: sleepReceipt({ probe: probeObject({ nextJobAt: "2026-11-12T13:00:00Z" }) }),
    });
    const result = await run({ tier: "nap", trigger: "sweep" });
    expect(result).toEqual(expect.objectContaining({ outcome: "slept", state: "napping", nextJobAt: "2026-11-12T13:00:00.000Z" }));
    expect(mockClaim).toHaveBeenCalledWith({ agentId: AGENT_ID, operationId: expect.any(String), tier: "nap", expectedGeneration: 3 });
    const op = mockClaim.mock.calls[0][0].operationId;
    expect(mockFinish).toHaveBeenCalledWith({ agentId: AGENT_ID, operationId: op, result: "napping" });
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      agentId: AGENT_ID, kind: "nap", trigger: "sweep", fromState: "awake", toState: "napping", generation: 4,
      detail: expect.objectContaining({ suspend_ms: 300, tier: "nap", manual: false }),
    }));
    expect(mockUpdate).toHaveBeenCalledWith("hivra_agents", { next_wake_at: "2026-11-12T12:58:00.000Z" });
    // The sleep script carries the tag check and the lock.
    const script = String(mockRunScript.mock.calls.find((c) => String(c[0]).includes("HIVRA_SLEEP_RESULT"))![0]);
    expect(script).toContain("hivra-tag-1");
    expect(script).toContain("flock -x -n 9");
  });

  it("clears the next wake when the probe saw no job", async () => {
    await run({ tier: "nap", trigger: "sweep" });
    expect(mockUpdate).toHaveBeenCalledWith("hivra_agents", { next_wake_at: null });
  });

  it("passes manual through, and a manual sleep ignores the open page's connections", async () => {
    stubScripts({ probe: probeLine({ openConnections: 2 }), sleep: sleepReceipt({ probe: probeObject({ openConnections: 2 }) }) });
    expect((await run({ tier: "nap", trigger: "sweep" })).outcome).toBe("not_idle");
    const result = await run({ tier: "nap", trigger: "manual", manual: true });
    expect(result.outcome).toBe("slept");
    expect(String(mockRunScript.mock.calls.find((c) => String(c[0]).includes("HIVRA_SLEEP_RESULT"))![0])).toContain("MANUAL=1");
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({ trigger: "manual", detail: expect.objectContaining({ manual: true }) }));
  });

  it("finishes awake with an abort event when the script finds the agent busy", async () => {
    stubScripts({ probe: probeLine(), sleep: sleepReceipt({ ok: false, to: "awake", reason: "active", probe: null }) });
    const result = await run({ tier: "nap", trigger: "sweep" });
    expect(result).toEqual(expect.objectContaining({ outcome: "aborted", state: "awake", reason: "active" }));
    expect(mockFinish).toHaveBeenCalledWith(expect.objectContaining({ result: "awake" }));
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "abort", toState: "awake", reason: "active" }));
  });

  it("leaves the lease, and never records the observed state, when another script still holds the computer", async () => {
    stubScripts({ probe: probeLine(), sleep: sleepReceipt({ ok: false, to: "awake", reason: "busy", probe: null }) });
    const result = await run({ tier: "nap", trigger: "sweep" });
    expect(result).toEqual(expect.objectContaining({ outcome: "aborted", reason: "busy" }));
    expect(mockFinish).not.toHaveBeenCalled();
    expect(ranScript("HIVRA_WAKE_RESULT")).toBe(false);
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "abort", reason: "busy", detail: expect.objectContaining({ lease_left: true }) }));
  });

  it("does not trust a wake that says busy after a lost receipt: the lease stays for the sweep", async () => {
    stubScripts({ probe: probeLine(), sleep: undefined, wake: wakeReceipt({ ok: false, to: "awake", reason: "busy" }) });
    const result = await run({ tier: "nap", trigger: "sweep" });
    expect(result).toEqual(expect.objectContaining({ outcome: "failed", reason: "no_receipt" }));
    expect(result.state).toBeUndefined();
    expect(mockFinish).not.toHaveBeenCalled();
  });

  it("reports an unrecovered lease when the finish is not recorded after a failed sleep", async () => {
    mockFinish.mockResolvedValue(false);
    stubScripts({ probe: probeLine(), sleep: sleepReceipt({ ok: false, to: "awake", reason: "suspend_failed", probe: null }) });
    const result = await run({ tier: "nap", trigger: "sweep" });
    expect(result.state).toBeUndefined();
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "fail", toState: "unknown", detail: expect.objectContaining({ recovered: false }) }));
  });

  it("recovers a lost hibernate receipt with a restore-length wake", async () => {
    stubScripts({ probe: probeLine(), sleep: undefined, wake: wakeReceipt({ from: "hibernated", reason: "restored" }) });
    await run({ tier: "hibernate", trigger: "sweep" });
    const wakeCall = mockRunScript.mock.calls.find((c) => String(c[0]).includes("HIVRA_WAKE_RESULT"))!;
    expect(wakeCall[2]).toEqual({ timeoutMs: 120_000 });
  });

  it("finishes at the observed state when the script fails, and logs a fail event", async () => {
    stubScripts({ probe: probeLine(), sleep: sleepReceipt({ ok: false, to: "awake", reason: "suspend_failed", probe: null }) });
    const result = await run({ tier: "nap", trigger: "sweep" });
    expect(result).toEqual(expect.objectContaining({ outcome: "failed", state: "awake", reason: "suspend_failed" }));
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "fail" }));
  });

  it("runs the wake script when the receipt is unparseable, and finishes at what it reports", async () => {
    stubScripts({ probe: probeLine(), sleep: "HIVRA_SLEEP_RESULT {oops\n", wake: wakeReceipt() });
    const result = await run({ tier: "nap", trigger: "sweep" });
    expect(result).toEqual(expect.objectContaining({ outcome: "failed", state: "awake", reason: "no_receipt" }));
    expect(ranScript("HIVRA_WAKE_RESULT")).toBe(true);
    expect(mockFinish).toHaveBeenCalledWith(expect.objectContaining({ result: "awake" }));
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "fail", reason: "no_receipt" }));
  });

  it("finishes napping when the unparseable receipt hid a nap and the wake script finds it paused", async () => {
    stubScripts({ probe: probeLine(), sleep: undefined, wake: wakeReceipt({ ok: false, from: "napping", to: "napping", reason: "resume_failed" }) });
    const result = await run({ tier: "nap", trigger: "sweep" });
    expect(result.state).toBe("napping");
    expect(mockFinish).toHaveBeenCalledWith(expect.objectContaining({ result: "napping" }));
  });

  it("leaves the lease for the sweep when even the wake script tells nothing", async () => {
    stubScripts({ probe: probeLine(), sleep: undefined, wake: undefined });
    const result = await run({ tier: "nap", trigger: "sweep" });
    expect(result).toEqual(expect.objectContaining({ outcome: "failed", reason: "no_receipt" }));
    expect(result.state).toBeUndefined();
    expect(mockFinish).not.toHaveBeenCalled();
  });

  it("wakes the agent back when the receipt's probe fails the full rules", async () => {
    stubScripts({ probe: probeLine(), sleep: sleepReceipt({ probe: probeObject({ loadavg: [3, 3, 3] }) }), wake: wakeReceipt() });
    const result = await run({ tier: "nap", trigger: "sweep" });
    expect(result).toEqual(expect.objectContaining({ outcome: "aborted", state: "awake", reason: "recheck_not_idle" }));
    expect(result.reasons).toContain("high_load");
    expect(ranScript("HIVRA_WAKE_RESULT")).toBe(true);
    expect(mockFinish).toHaveBeenCalledWith(expect.objectContaining({ result: "awake" }));
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "abort", reason: "recheck_not_idle" }));
  });

  it("reports a finish that could not be recorded as a failure", async () => {
    mockFinish.mockResolvedValue(false);
    const result = await run({ tier: "nap", trigger: "sweep" });
    expect(result).toEqual(expect.objectContaining({ outcome: "failed", reason: "finish_not_recorded" }));
  });

  it("hibernates a napping agent with no probe, and leaves the next wake alone", async () => {
    mockReadRow.mockResolvedValue({ data: eligibleRow({ sleep_state: "napping", sleep_generation: 7, next_wake_at: "2026-11-12T15:00:00Z" }), error: null });
    stubScripts({ sleep: sleepReceipt({ tier: "hibernate", from: "napping", to: "hibernated", reason: "hibernated", probe: null }) });
    const result = await run({ tier: "hibernate", trigger: "sweep" });
    expect(result).toEqual(expect.objectContaining({ outcome: "slept", state: "hibernated" }));
    expect(mockClaim).toHaveBeenCalledWith(expect.objectContaining({ tier: "hibernate", expectedGeneration: 7 }));
    expect(ranScript("HIVRA_IDLE_REFUSED")).toBe(false);
    expect(mockFinish).toHaveBeenCalledWith(expect.objectContaining({ result: "hibernated" }));
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "hibernate", fromState: "napping", toState: "hibernated" }));
    expect(mockUpdate).not.toHaveBeenCalled();
    // Longer script timeout for a hibernate.
    const call = mockRunScript.mock.calls.find((c) => String(c[0]).includes("HIVRA_SLEEP_RESULT"))!;
    expect(call[2]).toEqual({ timeoutMs: 280_000 });
  });

  it("does not hibernate a napping agent whose next job is inside the horizon", async () => {
    mockReadRow.mockResolvedValue({ data: eligibleRow({ sleep_state: "napping", next_wake_at: "2026-11-12T12:05:00Z" }), error: null });
    const result = await run({ tier: "hibernate", trigger: "sweep" });
    expect(result).toEqual(expect.objectContaining({ outcome: "not_idle", reason: "job_soon" }));
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("keeps a napping agent as napping when the hibernate is refused for pool room", async () => {
    mockReadRow.mockResolvedValue({ data: eligibleRow({ sleep_state: "napping" }), error: null });
    stubScripts({ sleep: sleepReceipt({ ok: false, tier: "hibernate", from: "napping", to: "napping", reason: "pool_full", probe: null }) });
    const result = await run({ tier: "hibernate", trigger: "sweep" });
    expect(result).toEqual(expect.objectContaining({ outcome: "aborted", state: "napping", reason: "pool_full" }));
    expect(mockFinish).toHaveBeenCalledWith(expect.objectContaining({ result: "napping" }));
  });

  it("never touches hivra_agents.status", async () => {
    await run({ tier: "nap", trigger: "sweep" });
    for (const call of mockUpdate.mock.calls) expect(Object.keys(call[1] as object)).not.toContain("status");
  });
});
