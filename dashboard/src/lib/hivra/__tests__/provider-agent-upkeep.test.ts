/** @jest-environment node */
// Provider launch seeds and the Computer Contract run after the agent page's
// response (ATT-05). An attempt is claimed first, so page loads never overlap
// and a seed that keeps failing waits before it is tried again.

type Row = Record<string, unknown>;
type Update = { patch: Row; filters: Array<[string, string, unknown]> };

let agentRow: Row;
let claimAvailable: boolean;
let claimError: { code: string } | null;
const updates: Update[] = [];

function builder() {
  let patch: Row | null = null;
  const filters: Array<[string, string, unknown]> = [];
  const chain = {
    update(next: Row) { patch = next; return chain; },
    eq(column: string, value: unknown) { filters.push(["eq", column, value]); return chain; },
    is(column: string, value: unknown) { filters.push(["is", column, value]); return chain; },
    or(value: string) { filters.push(["or", "", value]); return chain; },
    select() { return chain; },
    async maybeSingle() {
      if (!patch) return { data: agentRow, error: null };
      updates.push({ patch, filters: [...filters] });
      if ("provider_seed_attempted_at" in patch) {
        if (claimError) return { data: null, error: claimError };
        if (!claimAvailable) return { data: null, error: null };
        claimAvailable = false;
        return { data: { id: agentRow.id }, error: null };
      }
      agentRow = { ...agentRow, ...patch };
      return { data: agentRow, error: null };
    },
  };
  return chain;
}

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: () => builder() } }));
const mockWarn = jest.fn();
jest.mock("@/lib/logger", () => ({ log: { warn: (...args: unknown[]) => mockWarn(...args), error: jest.fn(), info: jest.fn() } }));
const mockEvent = jest.fn();
jest.mock("../agent-events", () => ({ logHivraAgentEvent: (...args: unknown[]) => mockEvent(...args) }));
jest.mock("../computer-contract-delivery", () => ({ advanceProviderComputerContract: jest.fn() }));
jest.mock("../provider-agent-seed", () => ({
  ...jest.requireActual("../provider-agent-seed"),
  seedProviderAgent: jest.fn(),
}));
jest.mock("@/lib/account-memory", () => ({ getAccountMemory: jest.fn(async () => "") }));

import {
  advanceProviderAgentUpkeep,
  providerAgentUpkeepApplies,
  providerSeedRetryWaitMs,
  PROVIDER_SEED_RETRY_MS,
  PROVIDER_SEED_SETTLED_RETRY_MS,
} from "../provider-agent-upkeep";

const USER = "user_1";
const NOW = Date.parse("2026-09-24T12:00:00.000Z");
const now = () => new Date(NOW);
const seed = jest.fn();
const contract = jest.fn();

function baseRow(): Row {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", user_id: USER, type: "codex", name: "Researcher", status: "running",
    desired_state: "running", operation_id: null, operation_kind: null, computer_substrate: "provider-vm",
    deployment_mode: "self-managed", ip: "203.0.113.10", cpu: 2, ram: 4, template_skills: [],
    bootstrapped_at: null, bankr_skills_seeded_at: null, template_skills_seeded_at: null,
    provider_install_stopped_at: "2026-09-20T08:00:00.000Z", provider_seed_attempted_at: null,
  };
}
const run = (row: Row = agentRow, deadline = NOW + 110_000) =>
  advanceProviderAgentUpkeep(USER, row, { deadline, now, seed, contract });

beforeEach(() => {
  agentRow = baseRow();
  claimAvailable = true;
  claimError = null;
  updates.length = 0;
  for (const mock of [mockWarn, mockEvent, seed, contract]) mock.mockReset();
  seed.mockResolvedValue({ attempted: ["bootstrap", "bankr-skills"], confirmed: ["bootstrap"] });
  contract.mockResolvedValue({ kind: "tracked" });
});

it("claims the attempt, stamps only what the computer confirmed, then keeps the contract current", async () => {
  await run();
  const [claim, stamp] = updates;
  expect(claim.patch).toEqual({ provider_seed_attempted_at: new Date(NOW).toISOString() });
  expect(claim.filters).toEqual(expect.arrayContaining([
    ["eq", "id", agentRow.id], ["eq", "user_id", USER], ["eq", "status", "running"], ["is", "operation_id", null],
    ["or", "", `provider_seed_attempted_at.is.null,provider_seed_attempted_at.lt.${new Date(NOW - PROVIDER_SEED_SETTLED_RETRY_MS).toISOString()}`],
  ]));
  expect(seed).toHaveBeenCalledWith(USER, expect.objectContaining({ id: agentRow.id }));
  expect(stamp).toEqual({ patch: { bootstrapped_at: new Date(NOW).toISOString() }, filters: expect.arrayContaining([["is", "bootstrapped_at", null]]) });
  expect(updates).toHaveLength(2);
  expect(mockEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "bootstrapped", agentId: agentRow.id }));
  expect(mockWarn).toHaveBeenCalledWith("provider agent seed not confirmed; retrying later", expect.objectContaining({ detail: { unconfirmed: ["bankr-skills"] } }));
  expect(contract).toHaveBeenCalledWith(USER, expect.objectContaining({ bootstrapped_at: expect.any(String) }), "auto",
    expect.objectContaining({ deadline: NOW + 110_000 }));
});

it("makes no connection while another page load holds the attempt or the wait isn't over", async () => {
  claimAvailable = false;
  await run();
  expect(seed).not.toHaveBeenCalled();
  expect(contract).toHaveBeenCalledTimes(1);
});

it("sends nothing when the attempt can't be claimed, for example before the column is deployed", async () => {
  claimError = { code: "PGRST204" };
  await run();
  expect(seed).not.toHaveBeenCalled();
  expect(mockWarn).toHaveBeenCalledWith("provider agent seed attempt could not be claimed", expect.objectContaining({ code: "PGRST204" }));
});

it("leaves the seeds for the next page load when the request has no room for a connection", async () => {
  await run(agentRow, NOW + 30_000);
  expect(updates).toHaveLength(0);
  expect(seed).not.toHaveBeenCalled();
  expect(contract).toHaveBeenCalledWith(USER, expect.anything(), "auto", expect.objectContaining({ deadline: NOW + 30_000 }));
});

it("still keeps the contract current when the seed step throws", async () => {
  seed.mockRejectedValueOnce(new Error("provider unreachable"));
  await run();
  expect(mockWarn).toHaveBeenCalledWith("provider agent seed step skipped", expect.objectContaining({ errorMessage: "provider unreachable" }));
  expect(contract).toHaveBeenCalledTimes(1);
});

it("only keeps the contract current once every seed is stamped", async () => {
  await run({ ...agentRow, bootstrapped_at: "x", bankr_skills_seeded_at: "x" });
  expect(updates).toHaveLength(0);
  expect(seed).not.toHaveBeenCalled();
  expect(contract).toHaveBeenCalledTimes(1);
});

it.each([
  ["a computer that isn't running", { status: "stopped" }],
  ["a lifecycle operation in flight", { status: "provisioning", operation_id: "op", operation_kind: "restart" }],
  ["a dashboard runtime with its own instructions", { type: "openclaw" }],
  ["a Hivra Cloud agent", { computer_substrate: "proxmox-kvm", deployment_mode: "hivra-managed" }],
])("leaves %s alone", async (_label, patch) => {
  const row = { ...baseRow(), ...patch };
  expect(providerAgentUpkeepApplies(row)).toBe(false);
  await run(row);
  expect(updates).toHaveLength(0);
  expect(seed).not.toHaveBeenCalled();
  expect(contract).not.toHaveBeenCalled();
});

it("retries after a minute while the computer is new, then at most every 15 minutes", () => {
  const at = new Date("2026-09-24T12:00:00.000Z");
  expect(providerSeedRetryWaitMs({ provider_install_stopped_at: "2026-09-24T11:50:00.000Z" }, at)).toBe(PROVIDER_SEED_RETRY_MS);
  expect(providerSeedRetryWaitMs({ provider_install_stopped_at: "2026-09-24T11:00:00.000Z" }, at)).toBe(PROVIDER_SEED_SETTLED_RETRY_MS);
  expect(providerSeedRetryWaitMs({ provider_install_stopped_at: null }, at)).toBe(PROVIDER_SEED_SETTLED_RETRY_MS);
});
