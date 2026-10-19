/** @jest-environment node */
// The automatic-update sweep against the real store and service, with only the
// database, the computer and the update itself stubbed: an owner's "off" (and
// a pause) must hold when the stored rows can't be read or appear mid-run.
import { runAgentCliAutoUpdateSweep } from "../agent-cli-auto-update";
import { AGENT_CLI_VERSIONS } from "@/lib/infrastructure/portable-provisioner-contract";

const TESTED = AGENT_CLI_VERSIONS.codex;
const NOW = Date.parse("2026-09-25T12:00:00.000Z");

const mockUpdate = jest.fn();
const mockReadBox = jest.fn();
const mockIdle = jest.fn();
const mockRpc = jest.fn();

type Result = { data?: unknown; error?: { message: string; code?: string } | null };
let recordsList: Result;
let insertResult: Result;
let rereadResult: Result;
const tableOps: Array<{ table: string; ops: string[] }> = [];

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (table: string) => {
      const entry = { table, ops: [] as string[] };
      tableOps.push(entry);
      const resolve = (): Result => {
        if (table === "hivra_agents") return { data: [agentRow], error: null };
        if (table === "hivra_activity_collectors") return { data: [], error: null };
        if (entry.ops.includes("insert")) return insertResult;
        if (entry.ops.includes("update")) return { data: [{ agent_id: agentRow.id }], error: null };
        if (entry.ops.includes("maybeSingle")) return rereadResult;
        return recordsList;
      };
      const chain: Record<string, unknown> = {};
      for (const op of ["select", "eq", "in", "is", "not", "or", "order", "insert", "update"]) {
        chain[op] = () => { entry.ops.push(op); return chain; };
      }
      chain.limit = async () => { entry.ops.push("limit"); return resolve(); };
      chain.maybeSingle = async () => { entry.ops.push("maybeSingle"); return resolve(); };
      chain.then = (onFulfilled: (value: Result) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(resolve()).then(onFulfilled, onRejected);
      return chain;
    },
  },
}));
jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock("../agent-events", () => ({ logHivraAgentEvent: jest.fn(async () => undefined) }));
jest.mock("../agent-cli-meta", () => ({
  readAgentSoftwareFromBox: (...args: unknown[]) => mockReadBox(...args),
  readAgentIdleEvidence: (...args: unknown[]) => mockIdle(...args),
}));
jest.mock("../agent-runtime-update", () => ({ runHivraAgentRuntimeUpdate: (...args: unknown[]) => mockUpdate(...args) }));

const agentRow = {
  id: "agent-a", user_id: "owner", type: "codex", status: "running", deployment_mode: "hivra-managed", computer_profile: null,
  computer_substrate: "proxmox-kvm", proxmox_host: "node-a", chat_url: "https://box-a.hivra.example", cf_hostname: "box-a.hivra.example",
  api_token: "e".repeat(64), operation_id: null, created_at: "2026-09-01T00:00:00Z",
};
const optedOut = {
  agent_id: "agent-a", user_id: "owner", cli_name: "codex", observation: "reported", installed_version: "0.140.0",
  auto_update: false, observed_at: "2026-09-24T12:00:00.000Z", updated_at: "2026-09-24T12:00:00.000+00:00",
};
const run = () => runAgentCliAutoUpdateSweep({ env: { HIVRA_AGENT_CLI_AUTO_UPDATE: "on" }, now: () => NOW });

beforeEach(() => {
  jest.clearAllMocks();
  tableOps.length = 0;
  recordsList = { data: [], error: null };
  insertResult = { data: [{ agent_id: "agent-a" }], error: null };
  rereadResult = { data: null, error: null };
  mockReadBox.mockResolvedValue({ observation: "reported", report: { name: "codex", version: "0.140.0", update: null } });
  mockIdle.mockResolvedValue({ runningReplies: 0, lastReplyActivityAt: NOW - 2 * 60 * 60_000, terminalAttached: false });
  mockRpc.mockResolvedValue({ data: true, error: null });
  mockUpdate.mockResolvedValue({ ok: true, agentCli: { name: "codex", version: "0.140.0", target: TESTED, state: "scheduled" } });
});

it("reads and updates nobody when the owners' stored choices can't be read", async () => {
  recordsList = { data: null, error: { message: "statement timeout" } };
  const summary = await run();
  expect(summary).toMatchObject({ scanned: 0, observed: 0, updated: 0 });
  expect(mockReadBox).not.toHaveBeenCalled();
  expect(mockIdle).not.toHaveBeenCalled();
  expect(mockRpc).not.toHaveBeenCalled();
  expect(mockUpdate).not.toHaveBeenCalled();
});

it("keeps an owner's off when their row appears between the sweep's read and its first save", async () => {
  // The list read found no row, the insert then collides with the owner's.
  insertResult = { data: null, error: { message: "duplicate key value", code: "23505" } };
  rereadResult = { data: optedOut, error: null };
  const summary = await run();
  expect(summary.skipped).toEqual({ disabled: 1 });
  expect(mockRpc).not.toHaveBeenCalled();
  expect(mockUpdate).not.toHaveBeenCalled();
  // The reading was saved over the owner's row, not dropped.
  const writes = tableOps.filter((entry) => entry.table === "hivra_agent_cli_updates").map((entry) => entry.ops[0]);
  expect(writes).toEqual(["select", "insert", "select", "update"]);
});

it("counts the reading as failed, and updates nothing, when that row can't be read either", async () => {
  insertResult = { data: null, error: { message: "duplicate key value", code: "23505" } };
  rereadResult = { data: null, error: { message: "statement timeout" } };
  const summary = await run();
  expect(summary).toMatchObject({ observed: 0, failed: 1, updated: 0 });
  expect(mockRpc).not.toHaveBeenCalled();
  expect(mockUpdate).not.toHaveBeenCalled();
});

it("still updates an agent whose owner left automatic updates on", async () => {
  expect(await run()).toMatchObject({ updated: 1 });
  expect(mockRpc).toHaveBeenCalledWith("claim_hivra_agent_cli_update_request", expect.objectContaining({ p_agent_id: "agent-a", p_requested_by: "auto", p_target: TESTED }));
});
