/**
 * Tests for the account-level shared memory store (Wave 5.1).
 *
 * Locks in the v0 contract:
 *   - getAccountMemory returns "" when there is no row / no client / a read error
 *     (it must NEVER throw — a bad read can't break the bootstrap fold).
 *   - getAccountMemory returns the stored content when a row exists.
 *   - setAccountMemory upserts on (user_id) with the trimmed value …
 *   - … and clamps to MAX_ACCOUNT_MEMORY_LEN.
 */

const mockSupabaseAdmin = { value: null as unknown };
jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return mockSupabaseAdmin.value;
  },
}));

import {
  getAccountMemory,
  setAccountMemory,
  MAX_ACCOUNT_MEMORY_LEN,
} from "../account-memory";

interface SelectResult {
  data: { content: string } | null;
  error: unknown;
}

/** Minimal chainable mock of `.from(table).select(cols).eq(col, val).maybeSingle()`. */
function makeReadClient(result: SelectResult, capture?: { table?: string; col?: string; val?: string }) {
  return {
    from(table: string) {
      if (capture) capture.table = table;
      return {
        select() {
          return {
            eq(col: string, val: string) {
              if (capture) {
                capture.col = col;
                capture.val = val;
              }
              return {
                maybeSingle: async () => result,
              };
            },
          };
        },
      };
    },
  };
}

/** Minimal mock of `.from(table).upsert(row, opts)`. */
function makeUpsertClient(capture: { table?: string; row?: Record<string, unknown>; opts?: unknown }, error: unknown = null) {
  return {
    from(table: string) {
      capture.table = table;
      return {
        upsert: async (row: Record<string, unknown>, opts: unknown) => {
          capture.row = row;
          capture.opts = opts;
          return { error };
        },
      };
    },
  };
}

afterEach(() => {
  mockSupabaseAdmin.value = null;
});

describe("getAccountMemory", () => {
  it("returns '' when there is no DB client", async () => {
    mockSupabaseAdmin.value = null;
    expect(await getAccountMemory("user_1")).toBe("");
  });

  it("returns '' when no row exists", async () => {
    mockSupabaseAdmin.value = makeReadClient({ data: null, error: null });
    expect(await getAccountMemory("user_1")).toBe("");
  });

  it("returns '' (never throws) on a read error", async () => {
    mockSupabaseAdmin.value = makeReadClient({ data: null, error: { message: "boom" } });
    await expect(getAccountMemory("user_1")).resolves.toBe("");
  });

  it("returns the stored content when a row exists, scoped to the user", async () => {
    const capture: { table?: string; col?: string; val?: string } = {};
    mockSupabaseAdmin.value = makeReadClient({ data: { content: "remember this" }, error: null }, capture);
    expect(await getAccountMemory("user_42")).toBe("remember this");
    expect(capture.table).toBe("user_memory");
    expect(capture.col).toBe("user_id");
    expect(capture.val).toBe("user_42");
  });
});

describe("setAccountMemory", () => {
  it("upserts the trimmed content on (user_id)", async () => {
    const capture: { table?: string; row?: Record<string, unknown>; opts?: unknown } = {};
    mockSupabaseAdmin.value = makeUpsertClient(capture);
    await setAccountMemory("user_7", "  hello world  ");
    expect(capture.table).toBe("user_memory");
    expect(capture.row?.user_id).toBe("user_7");
    expect(capture.row?.content).toBe("hello world");
    expect(capture.opts).toEqual({ onConflict: "user_id" });
  });

  it("clamps content to MAX_ACCOUNT_MEMORY_LEN", async () => {
    const capture: { table?: string; row?: Record<string, unknown>; opts?: unknown } = {};
    mockSupabaseAdmin.value = makeUpsertClient(capture);
    const huge = "x".repeat(MAX_ACCOUNT_MEMORY_LEN + 500);
    await setAccountMemory("user_7", huge);
    expect((capture.row?.content as string).length).toBe(MAX_ACCOUNT_MEMORY_LEN);
  });

  it("throws when there is no DB client", async () => {
    mockSupabaseAdmin.value = null;
    await expect(setAccountMemory("user_7", "x")).rejects.toThrow();
  });

  it("throws when the upsert errors", async () => {
    const capture: { table?: string; row?: Record<string, unknown>; opts?: unknown } = {};
    mockSupabaseAdmin.value = makeUpsertClient(capture, { message: "db down" });
    await expect(setAccountMemory("user_7", "x")).rejects.toThrow("db down");
  });
});
