/** @jest-environment node */
import { runAgentCliAutoUpdateSweep, UPDATE_READ_BUDGET_MS, UPDATE_START_BUDGET_MS, AUTO_UPDATE_FUNCTION_LIMIT_MS } from "../agent-cli-auto-update";
import { AGENT_COMPUTER_READ_TIMEOUT_MS, HOST_READINESS_TIMEOUT_MS, RUNTIME_UPDATE_TIMEOUT_MS } from "../lifecycle-timeouts";
import { AGENT_CLI_VERSIONS } from "@/lib/infrastructure/portable-provisioner-contract";

const TESTED = AGENT_CLI_VERSIONS.codex;
const NOW = Date.parse("2026-09-25T12:00:00.000Z");
const HOUR = 60 * 60_000;

const mockFrom = jest.fn();
const mockObserve = jest.fn();
const mockReadRecords = jest.fn();
const mockClaim = jest.fn();
const mockIdle = jest.fn();
const mockUpdate = jest.fn();

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: (...args: unknown[]) => mockFrom(...args) } }));
const mockUserList = jest.fn();
jest.mock("@clerk/nextjs/server", () => ({ clerkClient: async () => ({ users: { getUserList: (...args: unknown[]) => mockUserList(...args) } }) }));
jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock("../agent-software-service", () => ({
  ...jest.requireActual("../agent-software-service"),
  observeAgentSoftware: (...args: unknown[]) => mockObserve(...args),
}));
jest.mock("../agent-cli-store", () => ({
  readAgentSoftwareRecordsForAgents: (...args: unknown[]) => mockReadRecords(...args),
  claimAutomaticAgentSoftwareUpdate: (...args: unknown[]) => mockClaim(...args),
}));
jest.mock("../agent-cli-meta", () => ({ readAgentIdleEvidence: (...args: unknown[]) => mockIdle(...args) }));
jest.mock("../agent-runtime-update", () => ({ runHivraAgentRuntimeUpdate: (...args: unknown[]) => mockUpdate(...args) }));

type Row = Record<string, unknown> & { id: string };
let rows: Row[];
let records: Map<string, Record<string, unknown>>;
let collectors: Array<{ agent_id: string; last_event_at: string }>;
let collectorsError: unknown;
const queries: Array<Record<string, unknown>> = [];

function row(id: string, extra: Record<string, unknown> = {}): Row {
  return {
    id, user_id: "owner", type: "codex", status: "running", deployment_mode: "hivra-managed", computer_profile: null,
    computer_substrate: "proxmox-kvm", proxmox_host: `node-${id}`, chat_url: `https://box-${id}.hivra.example`,
    cf_hostname: `box-${id}.hivra.example`, api_token: "d".repeat(64), operation_id: null, created_at: "2026-09-01T00:00:00Z", ...extra,
  };
}
const observed = (installed: string | null, extra: Record<string, unknown> = {}) => ({
  observation: installed === null ? "older_connection_service" : "reported", installed_version: installed, observed_at: new Date(NOW).toISOString(), ...extra,
});
const idle = { runningReplies: 0, lastReplyActivityAt: NOW - 2 * HOUR, terminalAttached: false };
const run = (mode: string | undefined, dryRun = false) =>
  runAgentCliAutoUpdateSweep({ env: mode === undefined ? {} : { HIVRA_AGENT_CLI_AUTO_UPDATE: mode }, dryRun, now: () => NOW });

beforeEach(() => {
  jest.clearAllMocks();
  queries.length = 0;
  rows = [row("a")];
  records = new Map([["a", observed("0.140.0")]]);
  collectors = [];
  collectorsError = null;
  mockFrom.mockImplementation((table: string) => {
    const query: Record<string, unknown> = { table };
    queries.push(query);
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "eq", "in", "is", "not", "or", "order"]) {
      chain[method] = (...args: unknown[]) => { query[method] = [...((query[method] as unknown[]) ?? []), args]; return chain; };
    }
    chain.limit = async () => ({ data: rows, error: null });
    if (table === "hivra_activity_collectors") {
      chain.in = async () => ({ data: collectorsError ? null : collectors, error: collectorsError });
    }
    return chain;
  });
  mockReadRecords.mockImplementation(async () => new Map());
  mockObserve.mockImplementation(async (agent: Row) => ({ agent_id: agent.id, user_id: "owner", ...(records.get(agent.id) ?? {}) }));
  mockIdle.mockResolvedValue(idle);
  mockUserList.mockImplementation(async ({ userId }: { userId: string[] }) => ({ data: userId.map((id) => ({ id })) }));
  mockClaim.mockResolvedValue(true);
  mockUpdate.mockResolvedValue({ ok: true, agentCli: { name: "codex", version: "0.140.0", target: TESTED, state: "scheduled" } });
});

it("ships dark: with the switch unset or off it reads nothing", async () => {
  for (const mode of [undefined, "off", "nonsense"]) {
    expect(await run(mode)).toMatchObject({ mode: "off", scanned: 0, updated: 0 });
  }
  expect(mockFrom).not.toHaveBeenCalled();
  expect(mockObserve).not.toHaveBeenCalled();
});

it("selects only running Claude Code / Codex agents on Proxmox with no operation in progress", async () => {
  await run("preview");
  const candidates = queries.find((query) => query.table === "hivra_agents")!;
  expect(candidates.eq).toEqual([["status", "running"]]);
  expect(candidates.in).toEqual([["type", ["claude-code", "codex"]]]);
  expect(candidates.is).toEqual([["computer_profile", null], ["operation_id", null]]);
  expect(candidates.not).toEqual([["chat_url", "is", null]]);
  expect(candidates.or).toEqual([["computer_substrate.is.null,computer_substrate.eq.proxmox-kvm"]]);
});

it("previews what it would update without claiming or updating", async () => {
  const summary = await run("preview");
  expect(summary).toMatchObject({ mode: "preview", dryRun: true, scanned: 1, observed: 1, wouldUpdate: 1, updated: 0 });
  expect(summary.results).toEqual([{ agentId: "a", action: "would_update", target: TESTED }]);
  expect(mockClaim).not.toHaveBeenCalled();
  expect(mockUpdate).not.toHaveBeenCalled();
});

it("updates an idle, behind agent through the owner's own update path", async () => {
  const summary = await run("on");
  expect(summary).toMatchObject({ mode: "on", dryRun: false, updated: 1, failed: 0 });
  expect(mockClaim).toHaveBeenCalledWith({ id: "a", user_id: "owner", type: "codex" }, expect.objectContaining({ cli: "codex" }), TESTED);
  expect(mockUpdate).toHaveBeenCalledWith({ userId: "owner", agent: rows[0], trigger: "auto", source: "cron/update-hivra-agent-clis" });
});

it("?dryRun=1 still only reports when the switch is on", async () => {
  expect(await run("on", true)).toMatchObject({ dryRun: true, wouldUpdate: 1, updated: 0 });
  expect(mockUpdate).not.toHaveBeenCalled();
});

it.each([
  ["the owner turned it off", {}, { auto_update: false }, "disabled"],
  ["on My server by default", { deployment_mode: "self-managed" }, {}, "disabled"],
  ["on Hivra's tested version already", {}, { installed_version: TESTED }, "not_behind"],
  ["on the owner's own newer version", {}, { installed_version: "0.999.0" }, "owner_version"],
  ["paused after a failed update to this target", {}, { auto_paused_target: TESTED, auto_paused_reason: "rolled_back" }, "paused"],
  ["on an older connection service that reports no version", {}, { observation: "older_connection_service", installed_version: null }, "not_reported"],
  ["already updating", {}, { update_state: "waiting", update_target: TESTED, update_updated_at: new Date(NOW - 60_000).toISOString() }, "updating"],
])("leaves an agent alone when %s", async (_case, rowExtra, recordExtra, reason) => {
  rows = [row("a", rowExtra)];
  records.set("a", { ...observed("0.140.0"), ...recordExtra });
  const summary = await run("on");
  expect(summary.skipped).toEqual({ [reason]: 1 });
  expect(mockUpdate).not.toHaveBeenCalled();
});

it("never reads the computer of an agent whose automatic updates are off", async () => {
  rows = [row("a", { deployment_mode: "self-managed" }), row("b")];
  mockReadRecords.mockImplementation(async () => new Map([["b", { agent_id: "b", user_id: "owner", auto_update: false }]]));
  const summary = await run("on");
  expect(summary).toMatchObject({ scanned: 0, observed: 0, skipped: { disabled: 2 } });
  expect(mockObserve).not.toHaveBeenCalled();
  expect(mockReadRecords).toHaveBeenCalledTimes(1);
});

it("updates My server when its owner turned automatic updates on, and moves back a version Hivra itself installed", async () => {
  rows = [row("a", { deployment_mode: "self-managed", deployment_target_id: "target-1" }), row("b")];
  mockReadRecords.mockImplementation(async () => new Map([["a", { agent_id: "a", user_id: "owner", auto_update: true }]]));
  records.set("a", observed("0.140.0", { auto_update: true }));
  records.set("b", observed("0.999.0", { hivra_installed_version: "0.999.0" }));
  expect(await run("on")).toMatchObject({ updated: 2 });
});

it.each([
  ["a reply is being written", { ...idle, runningReplies: 1 }, [], "reply_in_progress"],
  ["an agent terminal is attached", { ...idle, terminalAttached: true }, [], "terminal_attached"],
  ["a reply finished minutes ago", { ...idle, lastReplyActivityAt: NOW - 10 * 60_000 }, [], "recently_used"],
  ["the agent reported work minutes ago", idle, [{ agent_id: "a", last_event_at: new Date(NOW - 5 * 60_000).toISOString() }], "recently_used"],
  ["whether it's in use can't be read", null, [], "activity_unreadable"],
])("waits when %s", async (_case, evidence, activity, reason) => {
  mockIdle.mockResolvedValue(evidence);
  collectors = activity;
  const summary = await run("on");
  expect(summary.skipped).toEqual({ [reason]: 1 });
  expect(mockClaim).not.toHaveBeenCalled();
  expect(mockUpdate).not.toHaveBeenCalled();
});

it("counts an unreadable activity record as in use", async () => {
  collectorsError = { message: "down" };
  expect((await run("on")).skipped).toEqual({ activity_unreadable: 1 });
  expect(mockIdle).not.toHaveBeenCalled();
});

it.each([
  ["the owner's account was deleted", async () => ({ data: [] })],
  ["Hivra couldn't confirm the owner's account", async () => { throw new Error("clerk down"); }],
])("leaves a computer alone when %s", async (_case, lookup) => {
  mockUserList.mockImplementation(lookup);
  expect((await run("on")).skipped).toEqual({ owner_unconfirmed: 1 });
  expect(mockClaim).not.toHaveBeenCalled();
  expect(mockUpdate).not.toHaveBeenCalled();
});

it("doesn't repeat a target inside its cooldown", async () => {
  mockClaim.mockResolvedValue(false);
  expect((await run("on")).skipped).toEqual({ cooldown: 1 });
  expect(mockUpdate).not.toHaveBeenCalled();
});

it("updates at most one agent per host and five per run", async () => {
  rows = ["a", "b", "c", "d", "e", "f", "g"].map((id) => row(id, id === "b" ? { proxmox_host: "node-a" } : {}));
  for (const entry of rows) records.set(entry.id, observed("0.140.0"));
  const summary = await run("on");
  expect(summary.updated).toBe(5);
  expect(summary.skipped).toEqual({ host_limit: 1, run_limit: 1 });
  const updatedHosts = mockUpdate.mock.calls.map(([input]) => (input as { agent: Row }).agent.proxmox_host);
  expect(new Set(updatedHosts).size).toBe(5);
});

it("reads the agents read longest ago first, forty per run", async () => {
  rows = Array.from({ length: 45 }, (_, index) => row(`r${index}`));
  mockReadRecords.mockImplementation(async () => new Map(rows.map((entry, index) => [entry.id, { observed_at: new Date(NOW - index * 60_000).toISOString() }])));
  const summary = await run("preview");
  expect(summary.scanned).toBe(40);
  const read = mockObserve.mock.calls.map(([agent]) => (agent as Row).id);
  expect(read).toHaveLength(40);
  expect(read).toContain("r44");
  expect(read).not.toContain("r0");
});

it("doesn't count a host that hasn't taken this release as a failure, and reports other failures", async () => {
  rows = [row("a"), row("b")];
  records.set("b", observed("0.140.0"));
  mockUpdate
    .mockResolvedValueOnce({ ok: false, code: "host_not_ready", status: 503, message: "Not ready" })
    .mockResolvedValueOnce({ ok: false, code: "unverified", status: 502, message: "Couldn't confirm" });
  const summary = await run("on");
  expect(summary).toMatchObject({ updated: 0, failed: 1, skipped: { host_not_ready: 1 } });
  expect(summary.results).toContainEqual({ agentId: expect.any(String), action: "failed", reason: "unverified", target: TESTED });
});

describe("time", () => {
  it("claims an update only while its readiness check and host script can still finish inside the function", () => {
    expect(UPDATE_START_BUDGET_MS + HOST_READINESS_TIMEOUT_MS + RUNTIME_UPDATE_TIMEOUT_MS).toBeLessThan(AUTO_UPDATE_FUNCTION_LIMIT_MS);
    expect(UPDATE_START_BUDGET_MS).toBeLessThanOrEqual(25_000);
  });

  it("claims nothing once reading the computer and whether it's idle has used up the start budget", async () => {
    let clock = NOW;
    // A slow first read (15 s) leaves time to start; the idle read (8 s at most, plus the
    // query) then takes it past the budget, before anything is claimed.
    mockObserve.mockImplementation(async (agent: Row) => { clock += 15_000; return { agent_id: agent.id, user_id: "owner", ...(records.get(agent.id) ?? {}) }; });
    mockIdle.mockImplementation(async () => { clock += 11_000; return idle; });
    const summary = await runAgentCliAutoUpdateSweep({ env: { HIVRA_AGENT_CLI_AUTO_UPDATE: "on" }, now: () => clock });
    expect(summary.skipped).toEqual({ out_of_time: 1 });
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("stops starting reads early enough that the last read, the checks and an idle read still fit before claims end", () => {
    expect(UPDATE_READ_BUDGET_MS + 2 * AGENT_COMPUTER_READ_TIMEOUT_MS).toBeLessThan(UPDATE_START_BUDGET_MS);
    expect(UPDATE_READ_BUDGET_MS).toBeGreaterThan(0);
  });

  it("stops reading once the read budget is gone in a run that updates, so the agents it read can still be updated", async () => {
    let clock = NOW;
    rows = Array.from({ length: 20 }, (_, index) => row(`s${index}`));
    for (const entry of rows) records.set(entry.id, observed("0.140.0"));
    // Every read takes 1 s of the run: twenty of them would leave nothing time to start.
    mockObserve.mockImplementation(async (agent: Row) => { clock += 1_000; return { agent_id: agent.id, user_id: "owner", ...(records.get(agent.id) ?? {}) }; });
    const summary = await runAgentCliAutoUpdateSweep({ env: { HIVRA_AGENT_CLI_AUTO_UPDATE: "on" }, now: () => clock });
    expect(summary.observed).toBeLessThanOrEqual(UPDATE_READ_BUDGET_MS / 1_000 + 1);
    expect(summary.skipped.out_of_time).toBe(20 - summary.observed);
    expect(summary.updated).toBe(5);
  });

  it("reads every candidate in a run that only reports", async () => {
    let clock = NOW;
    rows = Array.from({ length: 20 }, (_, index) => row(`s${index}`));
    mockObserve.mockImplementation(async (agent: Row) => { clock += 1_000; return { agent_id: agent.id, user_id: "owner", ...(records.get(agent.id) ?? {}) }; });
    const summary = await runAgentCliAutoUpdateSweep({ env: { HIVRA_AGENT_CLI_AUTO_UPDATE: "preview" }, now: () => clock });
    expect(summary.observed).toBe(20);
  });

  it("doesn't read whether an agent is idle once the start budget is gone", async () => {
    let clock = NOW;
    mockObserve.mockImplementation(async (agent: Row) => { clock += UPDATE_START_BUDGET_MS + 1; return { agent_id: agent.id, user_id: "owner", ...(records.get(agent.id) ?? {}) }; });
    const summary = await runAgentCliAutoUpdateSweep({ env: { HIVRA_AGENT_CLI_AUTO_UPDATE: "on" }, now: () => clock });
    expect(summary.skipped).toEqual({ out_of_time: 1 });
    expect(mockIdle).not.toHaveBeenCalled();
  });
});
