/** @jest-environment node */
import { COMPUTER_MISSING_ON_HOST_ERROR, isComputerMissingOnHostRow } from "../computer-usage-contract";

// Writing "the host no longer has this computer" back to its row is
// deliberately narrow: running or stopped rows only, nothing in flight, one
// exact error text, and an event for support.

const mockLogEvent = jest.fn();
const calls: Array<[string, ...unknown[]]> = [];
let mockResult: { data: unknown; error: unknown } = { data: { id: "a" }, error: null };
let mockThrow = false;

jest.mock("@/lib/hivra/agent-events", () => ({ logHivraAgentEvent: (...args: unknown[]) => mockLogEvent(...args) }));
jest.mock("@/lib/logger", () => ({ log: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      calls.push(["from", table]);
      const chain: Record<string, unknown> = {};
      for (const method of ["update", "eq", "in", "is", "select"]) {
        chain[method] = (...args: unknown[]) => { calls.push([method, ...args]); return chain; };
      }
      chain.maybeSingle = async () => {
        if (mockThrow) throw new Error("boom");
        return mockResult;
      };
      return chain;
    },
  },
}));

import { recordComputerMissingOnHost } from "../computer-missing";

beforeEach(() => {
  jest.clearAllMocks();
  calls.length = 0;
  mockThrow = false;
  mockResult = { data: { id: "a" }, error: null };
});

describe("recordComputerMissingOnHost", () => {
  it("marks only this owner's settled running or stopped row as an error with the plain reason", async () => {
    expect(await recordComputerMissingOnHost({ userId: "owner", agentId: "a", agentType: "linux-desktop" })).toBe(true);
    expect(calls).toEqual(expect.arrayContaining([
      ["from", "hivra_agents"],
      ["update", { status: "error", error: "This computer no longer exists on its host." }],
      ["eq", "id", "a"],
      ["eq", "user_id", "owner"],
      ["in", "status", ["running", "stopped"]],
      ["is", "operation_id", null],
    ]));
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      userId: "owner", agentId: "a", event: "failed", detail: { reason: "computer_missing_on_host" },
    }));
  });

  it("changes nothing, and records no event, when no row matched (already an error, busy or not this owner's)", async () => {
    mockResult = { data: null, error: null };
    expect(await recordComputerMissingOnHost({ userId: "owner", agentId: "a" })).toBe(false);
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it("never throws when the database fails", async () => {
    mockResult = { data: null, error: { message: "nope" } };
    expect(await recordComputerMissingOnHost({ userId: "owner", agentId: "a" })).toBe(false);
    mockThrow = true;
    expect(await recordComputerMissingOnHost({ userId: "owner", agentId: "a" })).toBe(false);
  });
});

describe("isComputerMissingOnHostRow", () => {
  it("matches only an error row carrying the exact reason", () => {
    expect(isComputerMissingOnHostRow({ status: "error", error: COMPUTER_MISSING_ON_HOST_ERROR })).toBe(true);
    expect(isComputerMissingOnHostRow({ status: "error", error: "Setup failed" })).toBe(false);
    expect(isComputerMissingOnHostRow({ status: "running", error: COMPUTER_MISSING_ON_HOST_ERROR })).toBe(false);
  });
});
