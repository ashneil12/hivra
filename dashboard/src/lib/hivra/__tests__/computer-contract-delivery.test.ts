/** @jest-environment node */
import { createHash, randomUUID } from "node:crypto";

import type { ComputerContractGuestOutcome, ComputerContractGuestRequest } from "../computer-contract-seed";

type Row = Record<string, unknown>;
const table: Row[] = [];
let tableDeployed = true;

// A small stand-in for the service-role client: enough of PostgREST's builder
// for the contract store, with the unique (agent, revision) key enforced.
function query() {
  const filters: Array<[string, unknown]> = [];
  let order: { column: string; ascending: boolean } | null = null;
  let limit = Infinity;
  let pending: { kind: "select" } | { kind: "insert"; row: Row } | { kind: "update"; patch: Row } = { kind: "select" };
  const matching = () => table.filter((row) => filters.every(([column, value]) => row[column] === value));
  const missing = { data: null, error: { code: "PGRST205" } };
  const builder = {
    select() { return builder; },
    eq(column: string, value: unknown) { filters.push([column, value]); return builder; },
    order(column: string, options: { ascending: boolean }) { order = { column, ascending: options.ascending }; return builder; },
    limit(count: number) { limit = count; return builder; },
    insert(row: Row) { pending = { kind: "insert", row }; return builder; },
    update(patch: Row) { pending = { kind: "update", patch }; return builder; },
    async single() {
      if (!tableDeployed) return missing;
      if (pending.kind === "insert") {
        const row = pending.row;
        if (table.some((existing) => existing.agent_id === row.agent_id && existing.revision === row.revision)) {
          return { data: null, error: { code: "23505" } };
        }
        const stored = { id: randomUUID(), rendered_at: new Date(0).toISOString(), delivery_state: "pending", delivered_at: null,
          receipt: null, checked_at: null, last_attempt_at: null, last_error: null, ...row };
        table.push(stored);
        return { data: structuredClone(stored), error: null };
      }
      if (pending.kind === "update") {
        const [row] = matching();
        if (!row) return { data: null, error: { code: "PGRST116" } };
        Object.assign(row, pending.patch);
        return { data: structuredClone(row), error: null };
      }
      return { data: structuredClone(matching()[0] ?? null), error: null };
    },
    then(resolve: (value: unknown) => void) {
      if (!tableDeployed) return resolve(missing);
      let rows = matching();
      if (order) {
        const { column, ascending } = order;
        rows = rows.slice().sort((a, b) => (Number(a[column]) - Number(b[column])) * (ascending ? 1 : -1));
      }
      return resolve({ data: structuredClone(rows.slice(0, limit)), error: null });
    },
  };
  return builder;
}

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: () => query() } }));
jest.mock("@/lib/logger", () => ({ log: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } }));
jest.mock("@/lib/services/proxmox-instance-service", () => ({ runProxmoxHostScript: jest.fn() }));

import { advanceProxmoxComputerContract, computerContractStatusFor, COMPUTER_CONTRACT_RETRY_MS } from "../computer-contract-delivery";

const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const USER = "user_1";
const AGENT = {
  id: "11111111-1111-4111-8111-111111111111", user_id: USER, type: "codex", name: "Codex 1", status: "running",
  ip: "10.253.0.90", computer_substrate: "proxmox-kvm", deployment_mode: "hivra-managed", cpu: 1.5, ram: 3, cpu_max: 2, ram_max: 4,
};

let clock = Date.parse("2026-09-24T12:00:00.000Z");
const now = () => new Date(clock);
const seed = jest.fn<Promise<ComputerContractGuestOutcome>, [string, ComputerContractGuestRequest, unknown]>();

function delivered(request: ComputerContractGuestRequest, overrides: Record<string, unknown> = {}): ComputerContractGuestOutcome {
  return { ok: true, result: { status: "delivered", revision: request.revision, contentSha256: request.contentSha256,
    observed: request.contentSha256, replay: false, bootId: null, ...overrides } as never };
}

const advance = (agent: Row, mode: "auto" | "deliver" | "restore" | "check" = "auto") =>
  advanceProxmoxComputerContract(USER, agent, {}, mode, { seed, now });

beforeEach(() => {
  table.length = 0;
  tableDeployed = true;
  clock = Date.parse("2026-09-24T12:00:00.000Z");
  seed.mockReset();
});

describe("advanceProxmoxComputerContract", () => {
  it("delivers revision 1 over an absent block and shows it only after the read-back receipt", async () => {
    seed.mockImplementation(async (_ip, request) => delivered(request));
    const status = await advance(AGENT);
    expect(seed).toHaveBeenCalledTimes(1);
    const [ip, request] = seed.mock.calls[0];
    expect(ip).toBe("10.253.0.90");
    expect(request).toMatchObject({ mode: "deliver", expected: "absent", revision: 1 });
    expect(request.contentSha256).toBe(sha(request.block));
    expect(request.facts).toMatchObject({ revision: 1, contentSha256: request.contentSha256, account: { user: "bux" } });
    expect(status).toMatchObject({ kind: "tracked", revision: 1, state: "delivered", deliveredAt: now().toISOString(), appliesTo: "new-chats" });
    expect(table[0].receipt).toMatchObject({ channel: "proxmox-seed", revision: 1, attestedBy: "computer" });
  });

  it("does not mint a revision or contact the computer when nothing changed", async () => {
    seed.mockImplementation(async (_ip, request) => delivered(request));
    await advance(AGENT);
    clock += COMPUTER_CONTRACT_RETRY_MS * 5;
    const status = await advance({ ...AGENT });
    expect(seed).toHaveBeenCalledTimes(1);
    expect(table).toHaveLength(1);
    expect(status).toMatchObject({ revision: 1, state: "delivered" });
  });

  it("re-renders on a rename and swaps from the revision it last delivered", async () => {
    seed.mockImplementation(async (_ip, request) => delivered(request));
    await advance(AGENT);
    const first = table[0];
    const status = await advance({ ...AGENT, name: "Codex 2" });
    expect(seed).toHaveBeenCalledTimes(2);
    expect(seed.mock.calls[1][1]).toMatchObject({ mode: "deliver", expected: first.content_sha256, revision: 2 });
    expect(seed.mock.calls[1][1].block).toContain("\"Codex 2\"");
    expect(status).toMatchObject({ revision: 2, state: "delivered" });
  });

  it("never shows a revision delivered on a receipt for other bytes (T17)", async () => {
    seed.mockImplementation(async (_ip, request) => delivered(request, { contentSha256: "f".repeat(64), observed: "f".repeat(64) }));
    const status = await advance(AGENT);
    expect(status).toMatchObject({ revision: 1, state: "pending", deliveredAt: null, lastError: "readback_mismatch" });
  });

  it("never shows a stale revision number as the current delivery (T18)", async () => {
    seed.mockImplementation(async (_ip, request) => delivered(request, { revision: request.revision + 1 }));
    const status = await advance(AGENT);
    expect(status).toMatchObject({ state: "pending", lastError: "readback_mismatch" });
  });

  it("keeps an unreachable computer pending, waits before retrying, then retries", async () => {
    seed.mockResolvedValueOnce({ ok: false, error: "unreachable" });
    expect(await advance(AGENT)).toMatchObject({ state: "pending", lastError: "unreachable", deliveredAt: null });
    clock += COMPUTER_CONTRACT_RETRY_MS - 1;
    await advance(AGENT);
    expect(seed).toHaveBeenCalledTimes(1);
    seed.mockImplementation(async (_ip, request) => delivered(request));
    // "Try again" skips the wait.
    expect(await advance(AGENT, "deliver")).toMatchObject({ state: "delivered" });
    expect(seed).toHaveBeenCalledTimes(2);
  });

  it("never overwrites an edited copy automatically, and Restore is its own action", async () => {
    seed.mockResolvedValueOnce({ ok: true, result: { status: "state_conflict", observed: "e".repeat(64), bootId: null } });
    expect(await advance(AGENT)).toMatchObject({ state: "conflict", lastError: "edited_on_computer" });
    clock += COMPUTER_CONTRACT_RETRY_MS * 2;
    await advance(AGENT);
    expect(seed).toHaveBeenCalledTimes(1);
    seed.mockImplementation(async (_ip, request) => delivered(request));
    expect(await advance(AGENT, "restore")).toMatchObject({ state: "delivered", revision: 1 });
    expect(seed.mock.calls[1][1].mode).toBe("restore");
  });

  it("recovers a lost receipt by swapping from the Hivra revision the computer still holds", async () => {
    seed.mockImplementation(async (_ip, request) => delivered(request));
    await advance(AGENT);
    // Revision 1 is on the computer but its receipt never reached the store.
    Object.assign(table[0], { delivery_state: "pending", delivered_at: null, receipt: null });
    const revisionOne = String(table[0].content_sha256);
    seed.mockReset();
    seed.mockResolvedValueOnce({ ok: true, result: { status: "state_conflict", observed: revisionOne, bootId: null } })
      .mockImplementation(async (_ip, request) => delivered(request));
    const status = await advance({ ...AGENT, name: "Codex 2" });
    expect(seed.mock.calls.map(([, request]) => request.expected)).toEqual(["absent", revisionOne]);
    expect(status).toMatchObject({ revision: 2, state: "delivered" });
  });

  it("checks without writing and reports an edit found later as changed", async () => {
    seed.mockImplementation(async (_ip, request) => delivered(request));
    await advance(AGENT);
    const content = String(table[0].content_sha256);
    seed.mockReset().mockResolvedValueOnce({ ok: true, result: { status: "observed", observed: content, bootId: null } });
    clock += 1000;
    expect(await advance(AGENT, "check")).toMatchObject({ state: "delivered", checkedAt: now().toISOString() });
    expect(seed.mock.calls[0][1].mode).toBe("check");
    seed.mockResolvedValueOnce({ ok: true, result: { status: "observed", observed: "absent", bootId: null } });
    const changed = await advance(AGENT, "check");
    expect(changed).toMatchObject({ state: "conflict", lastError: "edited_on_computer" });
    // The earlier delivery stays on record as history.
    expect(changed).toMatchObject({ deliveredAt: expect.any(String) });
  });

  it("waits for the computer to be running", async () => {
    const status = await advance({ ...AGENT, status: "stopped" });
    expect(seed).not.toHaveBeenCalled();
    expect(status).toEqual({ kind: "not_started", channel: "proxmox-seed" });
  });

  it("claims nothing when the contract store is not deployed", async () => {
    tableDeployed = false;
    expect(await advance(AGENT)).toEqual({ kind: "unavailable" });
    expect(seed).not.toHaveBeenCalled();
  });
});

describe("computerContractStatusFor", () => {
  it("renders a preview for a computer in the owner's own cloud but never claims delivery", async () => {
    const status = await computerContractStatusFor(USER, { ...AGENT, computer_substrate: "provider-vm", deployment_mode: "self-managed" });
    expect(status).toMatchObject({ kind: "not_deliverable", reason: "provider_vm" });
    expect(status.kind === "not_deliverable" && status.preview).toContain("in your user's own cloud account");
    expect(seed).not.toHaveBeenCalled();
  });

  it("says a dashboard runtime reads its own instructions", async () => {
    expect(await computerContractStatusFor(USER, { ...AGENT, type: "openclaw" })).toEqual({ kind: "not_applicable", reason: "own_instructions" });
    expect(await computerContractStatusFor(USER, { ...AGENT, type: "linux-desktop" })).toEqual({ kind: "not_applicable", reason: "computer" });
  });
});
