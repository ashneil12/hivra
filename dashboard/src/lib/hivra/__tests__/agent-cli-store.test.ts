/** @jest-environment node */
import {
  readAgentSoftwareRecordsForAgents,
  recordOwnerAgentSoftwareRequest,
  requestResultOf,
  saveAgentSoftwareAutoUpdate,
  saveAgentSoftwareObservation,
  type StoredAgentSoftware,
} from "../agent-cli-store";
import { agentSoftwareSubject, type AgentSoftwareSubject } from "../agent-cli-status";

const mockLogEvent = jest.fn(async () => undefined);
jest.mock("../agent-events", () => ({ logHivraAgentEvent: (...args: unknown[]) => mockLogEvent(...(args as [])) }));
jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

type Call = { op: string; payload?: unknown; filters: Array<[string, unknown]>; options?: unknown };
const calls: Call[] = [];
let updateRows: unknown[] = [{ agent_id: "agent-1" }];
let insertError: { code?: string; message: string } | null = null;
let listed: unknown[] = [];
let listError: { message: string } | null = null;
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => {
      const call: Call = { op: "", filters: [] };
      calls.push(call);
      const chain = {
        update(payload: unknown) { call.op = "update"; call.payload = payload; return chain; },
        insert(payload: unknown) { call.op = "insert"; call.payload = payload; return chain; },
        upsert(payload: unknown, options: unknown) { call.op = "upsert"; call.payload = payload; call.options = options; return Promise.resolve({ error: null }); },
        eq(column: string, value: unknown) { call.filters.push([column, value]); return chain; },
        in(column: string, value: unknown) { call.op = "list"; call.filters.push([column, value]); return Promise.resolve({ data: listError ? null : listed, error: listError }); },
        select() {
          if (call.op === "insert") return Promise.resolve({ data: insertError ? null : [{ agent_id: "agent-1" }], error: insertError });
          if (call.op === "update") return Promise.resolve({ data: updateRows, error: null });
          return chain;
        },
      };
      return chain;
    },
  },
}));

const agent = { id: "agent-1", user_id: "owner", type: "codex" };
const codex = agentSoftwareSubject({ type: "codex" }) as AgentSoftwareSubject;
const NOW = new Date("2026-09-25T12:00:00.000Z");
const previous = (extra: Partial<StoredAgentSoftware> = {}): StoredAgentSoftware => ({
  agent_id: "agent-1", user_id: "owner", observation: "reported", installed_version: "0.149.0", updated_at: "2026-09-25T11:59:00.000+00:00", ...extra,
});
const reported = (version: string | null, update: { state: string; target: string; reason?: string | null } | null = null) => ({
  observation: "reported" as const,
  report: { name: "codex" as const, version, update: update ? { state: update.state as "done", target: update.target, updatedAt: "2026-09-25T11:59:30Z", reason: update.reason ?? null } : null },
});

beforeEach(() => {
  calls.length = 0;
  updateRows = [{ agent_id: "agent-1" }];
  insertError = null;
  listError = null;
  mockLogEvent.mockClear();
});

describe("saveAgentSoftwareObservation", () => {
  it("writes a first observation and marks the tested version as Hivra's", async () => {
    const merged = await saveAgentSoftwareObservation({ agent, subject: codex, tested: "0.149.1", reading: reported("0.149.1"), previous: null, now: NOW });
    expect(calls[0]).toMatchObject({ op: "insert", payload: expect.objectContaining({
      agent_id: "agent-1", user_id: "owner", cli_name: "codex", observation: "reported", installed_version: "0.149.1",
      tested_version: "0.149.1", hivra_installed_version: "0.149.1", update_state: null, observed_at: NOW.toISOString(),
    }) });
    expect(merged.installed_version).toBe("0.149.1");
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it("never marks an owner's own version as Hivra's", async () => {
    await saveAgentSoftwareObservation({ agent, subject: codex, tested: "0.149.1", reading: reported("0.150.0"), previous: previous(), now: NOW });
    expect(calls[0].payload).not.toHaveProperty("hivra_installed_version");
  });

  it("writes over exactly the row it read (a compare on updated_at)", async () => {
    await saveAgentSoftwareObservation({ agent, subject: codex, tested: "0.149.1", reading: { observation: "unreachable" }, previous: previous(), now: NOW });
    expect(calls[0]).toMatchObject({ op: "update", filters: [["agent_id", "agent-1"], ["user_id", "owner"], ["updated_at", "2026-09-25T11:59:00.000+00:00"]] });
    // What the computer couldn't say leaves the last version it did say.
    expect(calls[0].payload).toEqual(expect.not.objectContaining({ installed_version: expect.anything() }));
    expect(calls[0].payload).toMatchObject({ observation: "unreachable" });
  });

  it("records a finished update Hivra asked for once, with who asked", async () => {
    const asked = previous({ requested_at: "2026-09-25T11:50:00Z", requested_target: "0.149.1", requested_by: "owner", request_result: "scheduled", update_state: "installing", update_target: "0.149.1" });
    await saveAgentSoftwareObservation({ agent, subject: codex, tested: "0.149.1", reading: reported("0.149.1", { state: "done", target: "0.149.1" }), previous: asked, now: NOW });
    expect(mockLogEvent).toHaveBeenCalledTimes(1);
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "agent_cli_updated", agentId: "agent-1", detail: { cli: "codex", target: "0.149.1", from: "0.149.0", trigger: "owner" },
    }));
    expect(calls[0].payload).toMatchObject({ hivra_installed_version: "0.149.1", update_state: "done" });

    // Read again with the same ending: nothing more is recorded.
    mockLogEvent.mockClear();
    await saveAgentSoftwareObservation({ agent, subject: codex, tested: "0.149.1", reading: reported("0.149.1", { state: "done", target: "0.149.1" }), previous: { ...asked, update_state: "done" }, now: NOW });
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it("leaves the recording to the reader that saved the change first", async () => {
    updateRows = [];
    const asked = previous({ requested_at: "2026-09-25T11:50:00Z", requested_target: "0.149.1", requested_by: "owner", request_result: "scheduled" });
    await saveAgentSoftwareObservation({ agent, subject: codex, tested: "0.149.1", reading: reported("0.149.1", { state: "done", target: "0.149.1" }), previous: asked, now: NOW });
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it("doesn't take a stale result on a computer's first reading for an update of its own", async () => {
    await saveAgentSoftwareObservation({ agent, subject: codex, tested: "0.149.1", reading: reported("0.149.1", { state: "done", target: "0.149.1" }), previous: null, now: NOW });
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it("pauses automatic updates for a target an automatic update couldn't install", async () => {
    const auto = previous({ requested_at: "2026-09-25T11:50:00Z", requested_target: "0.149.1", requested_by: "auto", request_result: "scheduled", update_state: "installing", update_target: "0.149.1" });
    await saveAgentSoftwareObservation({ agent, subject: codex, tested: "0.149.1", reading: reported("0.149.0", { state: "rolled_back", target: "0.149.1", reason: "install_failed" }), previous: auto, now: NOW });
    expect(calls[0].payload).toMatchObject({ auto_paused_target: "0.149.1", auto_paused_reason: "rolled_back" });
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "agent_cli_update_failed", detail: { cli: "codex", target: "0.149.1", state: "rolled_back", reason: "install_failed", trigger: "auto" },
    }));
  });

  it("doesn't pause automatic updates after an owner's update failed", async () => {
    const owner = previous({ requested_at: "2026-09-25T11:50:00Z", requested_target: "0.149.1", requested_by: "owner", request_result: "scheduled" });
    await saveAgentSoftwareObservation({ agent, subject: codex, tested: "0.149.1", reading: reported("0.149.0", { state: "failed", target: "0.149.1", reason: "download_failed" }), previous: owner, now: NOW });
    expect(calls[0].payload).not.toHaveProperty("auto_paused_target");
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "agent_cli_update_failed" }));
  });
});

describe("readAgentSoftwareRecordsForAgents", () => {
  it("reads every candidate in one query and keeps a row only for its agent's own owner", async () => {
    listed = [
      { agent_id: "agent-1", user_id: "owner", observation: "reported" },
      { agent_id: "agent-2", user_id: "someone-else", observation: "reported" },
    ];
    const rows = await readAgentSoftwareRecordsForAgents([{ id: "agent-1", user_id: "owner" }, { id: "agent-2", user_id: "owner" }]);
    expect([...(rows?.keys() ?? [])]).toEqual(["agent-1"]);
    expect(calls).toEqual([expect.objectContaining({ op: "list", filters: [["agent_id", ["agent-1", "agent-2"]]] })]);
  });

  it("says the rows couldn't be read instead of answering that there are none", async () => {
    // They hold the owners' automatic-update choices: an empty answer would read as "never chose".
    listError = { message: "statement timeout" };
    expect(await readAgentSoftwareRecordsForAgents([{ id: "agent-1", user_id: "owner" }])).toBeNull();
    expect(await readAgentSoftwareRecordsForAgents([])).toEqual(new Map());
  });
});

describe("requests and choices", () => {
  it("maps the update's outcome to what is recorded, counting an unconfirmed CLI step as unverified", () => {
    expect(requestResultOf({ ok: true, report: { name: "codex", version: "0.149.0", target: "0.149.1", state: "scheduled" } })).toBe("scheduled");
    expect(requestResultOf({ ok: true, report: { name: "agent-zero", version: null, target: `sha256:${"b".repeat(64)}`, state: "running" } })).toBe("running");
    expect(requestResultOf({ ok: true, report: null })).toBe("unverified");
    expect(requestResultOf({ ok: false, code: "host_not_ready" })).toBe("host_not_ready");
    expect(requestResultOf({ ok: false, code: "busy" })).toBe("busy");
    expect(requestResultOf({ ok: false, code: "superseded" })).toBe("unverified");
    expect(requestResultOf({ ok: false, code: "not_running" })).toBe("refused");
  });

  it("records an owner's request, and ends a pause for that target", async () => {
    await recordOwnerAgentSoftwareRequest({
      agent, subject: codex, target: "0.149.1", requestedAt: NOW, result: "scheduled", report: null,
      previous: previous({ auto_paused_target: "0.149.1", auto_paused_reason: "rolled_back" }),
    });
    expect(calls[0]).toMatchObject({ op: "upsert", options: { onConflict: "agent_id" }, payload: expect.objectContaining({
      requested_at: NOW.toISOString(), requested_target: "0.149.1", requested_by: "owner", request_result: "scheduled",
      auto_paused_target: null, auto_paused_reason: null,
    }) });
  });

  it("records a current report as Hivra's own version right away", async () => {
    await recordOwnerAgentSoftwareRequest({
      agent, subject: codex, target: "0.149.1", requestedAt: NOW, result: "current",
      report: { name: "codex", version: "0.149.1", target: "0.149.1", state: "current" }, previous: null,
    });
    expect(calls[0].payload).toMatchObject({ observation: "reported", installed_version: "0.149.1", hivra_installed_version: "0.149.1" });
    expect(calls[0].payload).not.toHaveProperty("auto_paused_target");
  });

  it("saves the owner's automatic-update choice, and turning it on ends a pause", async () => {
    await saveAgentSoftwareAutoUpdate(agent, codex, true);
    expect(calls[0].payload).toMatchObject({ auto_update: true, auto_paused_target: null, auto_paused_reason: null });
    await saveAgentSoftwareAutoUpdate(agent, codex, false);
    expect(calls[1].payload).toMatchObject({ auto_update: false });
    expect(calls[1].payload).not.toHaveProperty("auto_paused_target");
  });
});
