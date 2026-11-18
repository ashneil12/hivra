/** @jest-environment node */
import {
  recordOwnerAgentSoftwareRequest,
  requestResultOf,
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
  mockLogEvent.mockClear();
});

describe("saveAgentSoftwareObservation", () => {
  it("writes a first observation", async () => {
    const merged = await saveAgentSoftwareObservation({ agent, subject: codex, reading: reported("0.149.1"), previous: null, now: NOW });
    expect(calls[0]).toMatchObject({ op: "insert", payload: expect.objectContaining({
      agent_id: "agent-1", user_id: "owner", cli_name: "codex", observation: "reported", installed_version: "0.149.1",
      update_state: null, observed_at: NOW.toISOString(),
    }) });
    expect(calls[0].payload).not.toHaveProperty("tested_version");
    expect(calls[0].payload).not.toHaveProperty("hivra_installed_version");
    expect(merged.installed_version).toBe("0.149.1");
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it("never marks a version as Hivra's without a finished Hivra update", async () => {
    await saveAgentSoftwareObservation({ agent, subject: codex, reading: reported("0.150.0"), previous: previous(), now: NOW });
    expect(calls[0].payload).not.toHaveProperty("hivra_installed_version");
  });

  it("writes over exactly the row it read (a compare on updated_at)", async () => {
    await saveAgentSoftwareObservation({ agent, subject: codex, reading: { observation: "unreachable" }, previous: previous(), now: NOW });
    expect(calls[0]).toMatchObject({ op: "update", filters: [["agent_id", "agent-1"], ["user_id", "owner"], ["updated_at", "2026-09-25T11:59:00.000+00:00"]] });
    // What the computer couldn't say leaves the last version it did say.
    expect(calls[0].payload).toEqual(expect.not.objectContaining({ installed_version: expect.anything() }));
    expect(calls[0].payload).toMatchObject({ observation: "unreachable" });
  });

  it("records a finished update Hivra asked for once, with who asked", async () => {
    const asked = previous({ requested_at: "2026-09-25T11:50:00Z", requested_target: "latest", requested_by: "owner", request_result: "scheduled", update_state: "installing", update_target: "latest" });
    await saveAgentSoftwareObservation({ agent, subject: codex, reading: reported("0.149.1", { state: "done", target: "latest" }), previous: asked, now: NOW });
    expect(mockLogEvent).toHaveBeenCalledTimes(1);
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "agent_cli_updated", agentId: "agent-1", detail: { cli: "codex", target: "latest", from: "0.149.0", to: "0.149.1", trigger: "owner" },
    }));
    expect(calls[0].payload).toMatchObject({ hivra_installed_version: "0.149.1", update_state: "done" });

    // Read again with the same ending: nothing more is recorded.
    mockLogEvent.mockClear();
    await saveAgentSoftwareObservation({ agent, subject: codex, reading: reported("0.149.1", { state: "done", target: "latest" }), previous: { ...asked, update_state: "done" }, now: NOW });
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it("leaves the recording to the reader that saved the change first", async () => {
    updateRows = [];
    const asked = previous({ requested_at: "2026-09-25T11:50:00Z", requested_target: "latest", requested_by: "owner", request_result: "scheduled" });
    await saveAgentSoftwareObservation({ agent, subject: codex, reading: reported("0.149.1", { state: "done", target: "latest" }), previous: asked, now: NOW });
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it("doesn't take a stale result on a computer's first reading for an update of its own", async () => {
    await saveAgentSoftwareObservation({ agent, subject: codex, reading: reported("0.149.1", { state: "done", target: "latest" }), previous: null, now: NOW });
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it("records an owner's update that failed", async () => {
    const owner = previous({ requested_at: "2026-09-25T11:50:00Z", requested_target: "latest", requested_by: "owner", request_result: "scheduled" });
    await saveAgentSoftwareObservation({ agent, subject: codex, reading: reported("0.149.0", { state: "failed", target: "latest", reason: "download_failed" }), previous: owner, now: NOW });
    expect(calls[0].payload).not.toHaveProperty("auto_paused_target");
    expect(calls[0].payload).not.toHaveProperty("hivra_installed_version");
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "agent_cli_update_failed" }));
  });
});

describe("requests", () => {
  it("maps the update's outcome to what is recorded, counting an unconfirmed CLI step as unverified", () => {
    expect(requestResultOf({ ok: true, report: { name: "codex", version: "0.149.0", target: "latest", state: "scheduled" } })).toBe("scheduled");
    expect(requestResultOf({ ok: true, report: { name: "agent-zero", version: null, target: "latest", state: "running" } })).toBe("running");
    expect(requestResultOf({ ok: true, report: null })).toBe("unverified");
    expect(requestResultOf({ ok: false, code: "host_not_ready" })).toBe("host_not_ready");
    expect(requestResultOf({ ok: false, code: "busy" })).toBe("busy");
    expect(requestResultOf({ ok: false, code: "superseded" })).toBe("unverified");
    expect(requestResultOf({ ok: false, code: "not_running" })).toBe("refused");
  });

  it("records an owner's request for the newest release", async () => {
    await recordOwnerAgentSoftwareRequest({
      agent, subject: codex, target: "latest", requestedAt: NOW, result: "scheduled", report: null, previous: previous(),
    });
    expect(calls[0]).toMatchObject({ op: "upsert", options: { onConflict: "agent_id" }, payload: expect.objectContaining({
      requested_at: NOW.toISOString(), requested_target: "latest", requested_by: "owner", request_result: "scheduled",
    }) });
    expect(calls[0].payload).not.toHaveProperty("auto_paused_target");
  });

  it("records a current report as Hivra's own version right away", async () => {
    await recordOwnerAgentSoftwareRequest({
      agent, subject: codex, target: "latest", requestedAt: NOW, result: "current",
      report: { name: "codex", version: "0.149.1", target: "latest", state: "current" }, previous: null,
    });
    expect(calls[0].payload).toMatchObject({ observation: "reported", installed_version: "0.149.1", hivra_installed_version: "0.149.1" });
    expect(calls[0].payload).not.toHaveProperty("auto_paused_target");
  });
});
