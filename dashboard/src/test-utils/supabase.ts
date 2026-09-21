/**
 * Shared Supabase query-builder stub for tests.
 *
 * Every chained method returns the same builder so call sites can be written
 * in any order -- which is how the production code calls Supabase. Terminal
 * methods (`single`, `maybeSingle`, `rpc`) settle; everything else stays
 * chainable, and awaiting the builder directly settles too.
 *
 * Usage:
 *   const sb = createSupabaseMock();
 *   jest.mock("@/lib/supabase", () => ({ supabaseAdmin: sb.admin }));
 */
export interface SupabaseQueryStub {
  [key: string]: unknown;
}

export interface SupabaseMock {
  /** The object to hand to `jest.mock("@/lib/supabase", ...)`. */
  admin: { from: jest.Mock; storage: { from: jest.Mock }; rpc: jest.Mock };
  /** The builder every `from()` call returns. */
  query: SupabaseQueryStub;
  rows: unknown[];
  error: unknown;
  /** Table names passed to `from()`, in call order. */
  tables: string[];
  reset: () => void;
}

const CHAIN_METHODS = [
  "select", "insert", "update", "upsert", "delete",
  "eq", "neq", "in", "or", "not", "is", "order", "limit", "range", "filter", "match",
];

export function createSupabaseMock(initialRows: unknown[] = []): SupabaseMock {
  const state = { rows: initialRows, error: null as unknown };

  const query: Record<string, unknown> = {};
  for (const method of CHAIN_METHODS) {
    query[method] = jest.fn(() => query);
  }
  const settle = async () => ({ data: state.rows, error: state.error, count: state.rows.length });
  query.single = jest.fn(settle);
  query.maybeSingle = jest.fn(settle);
  query.then = (resolve: (value: unknown) => unknown) => settle().then(resolve);

  const tables: string[] = [];
  const admin = {
    from: jest.fn((table: string) => { tables.push(table); return query; }),
    storage: { from: jest.fn(() => query) },
    rpc: jest.fn(settle),
  };

  return {
    admin: admin as SupabaseMock["admin"],
    query: query as SupabaseQueryStub,
    get rows() { return state.rows; },
    set rows(value: unknown[]) { state.rows = value; },
    get error() { return state.error; },
    set error(value: unknown) { state.error = value; },
    tables,
    reset: () => {
      for (const fn of Object.values(query)) if (jest.isMockFunction(fn)) fn.mockClear();
      admin.from.mockClear();
      admin.storage.from.mockClear();
      admin.rpc.mockClear();
      state.error = null;
      tables.length = 0;
    },
  };
}
