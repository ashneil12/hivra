/**
 * In-memory Supabase fake for billing tests that need real query semantics.
 *
 * Ported from the managed Venice settlement fake so the yearly $HermesOS flow
 * can run against the same behaviour:
 *   - eq / neq / in / lt / lte / gt / gte / is filters, multi-key order
 *     (nullsFirst honoured), and a chainable + thenable limit;
 *   - update(...).<filters>.select() resolves to the AFFECTED rows, so
 *     compare-and-set code can see "0 rows = lost the race";
 *   - 23505 emulation for the unique indexes the caller declares;
 *   - rpc(name, args) dispatches to caller-supplied handlers that run against
 *     the same tables (used to model a plpgsql function's contract);
 *   - one-shot failure injection and stale-read views for crash/race tests.
 */

export type MemoryRow = Record<string, unknown>;

export interface MemoryDbError {
  code?: string;
  message: string;
}

type FilterOp = "eq" | "neq" | "in" | "lt" | "lte" | "gt" | "gte" | "is";

interface Filter {
  column: string;
  op: FilterOp;
  value: unknown;
}

interface Order {
  column: string;
  ascending: boolean;
  nullsFirst: boolean;
}

type MutationKind = "insert" | "update" | "upsert" | "select" | "rpc";

export interface MemoryDbCall {
  table: string;
  kind: MutationKind | "insert_23505" | "update_23505" | "injected_failure";
  payload?: MemoryRow;
  filters?: Filter[];
}

export interface InjectedFailure {
  table: string;
  op: MutationKind;
  /** Only fail when the insert row / update patch / rpc args match. */
  match?: (payload: MemoryRow) => boolean;
  error?: MemoryDbError;
  /** How many matching operations fail before the rule is spent (default 1). */
  times?: number;
}

export interface UniqueIndex {
  name: string;
  columns: string[];
  where: (row: MemoryRow) => boolean;
}

export interface MemoryTables {
  [table: string]: MemoryRow[];
}

export type MemoryRpcHandler = (
  args: MemoryRow,
  context: { tables: MemoryTables; insertRow: (table: string, row: MemoryRow) => MemoryRow }
) => { data: unknown; error: MemoryDbError | null };

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const INTEGER_STRING = /^-?\d+$/;

export function compareValues(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  const leftText = String(left);
  const rightText = String(right);
  if (ISO_TIMESTAMP.test(leftText) && ISO_TIMESTAMP.test(rightText)) {
    return Date.parse(leftText) - Date.parse(rightText);
  }
  if (INTEGER_STRING.test(leftText) && INTEGER_STRING.test(rightText)) {
    const a = BigInt(leftText);
    const b = BigInt(rightText);
    return a === b ? 0 : a < b ? -1 : 1;
  }
  return leftText === rightText ? 0 : leftText < rightText ? -1 : 1;
}

// SQL equality: NULL never equals anything; timestamps and integers compare
// by value so "…T10:20:00.000Z" matches "…T10:20:00+00:00" like timestamptz.
function valuesEqual(left: unknown, right: unknown) {
  if (left == null || right == null) return false;
  if (left === right) return true;
  if (typeof left === "object" || typeof right === "object") return false;
  const leftText = String(left);
  const rightText = String(right);
  if (ISO_TIMESTAMP.test(leftText) && ISO_TIMESTAMP.test(rightText)) {
    return Date.parse(leftText) === Date.parse(rightText);
  }
  if (INTEGER_STRING.test(leftText) && INTEGER_STRING.test(rightText)) {
    return BigInt(leftText) === BigInt(rightText);
  }
  return false;
}

function rowMatches(row: MemoryRow, filter: Filter) {
  const value = row[filter.column];
  switch (filter.op) {
    case "eq":
      return valuesEqual(value, filter.value);
    case "neq":
      return value != null && !valuesEqual(value, filter.value);
    case "in":
      return Array.isArray(filter.value) && filter.value.some((candidate) => valuesEqual(value, candidate));
    case "lt":
      return value != null && compareValues(value, filter.value) < 0;
    case "lte":
      return value != null && compareValues(value, filter.value) <= 0;
    case "gt":
      return value != null && compareValues(value, filter.value) > 0;
    case "gte":
      return value != null && compareValues(value, filter.value) >= 0;
    case "is":
      return filter.value === null ? value == null : value === filter.value;
  }
}

function sortRows(rows: MemoryRow[], orders: Order[]) {
  if (orders.length === 0) return rows;
  return [...rows].sort((left, right) => {
    for (const order of orders) {
      const a = left[order.column];
      const b = right[order.column];
      if (a == null && b == null) continue;
      if (a == null) return order.nullsFirst ? -1 : 1;
      if (b == null) return order.nullsFirst ? 1 : -1;
      const comparison = compareValues(a, b);
      if (comparison !== 0) return order.ascending ? comparison : -comparison;
    }
    return 0;
  });
}

function clone<T>(value: T): T {
  return value == null ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function thenable<T>(run: () => T) {
  return (resolve?: (value: T) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve().then(run).then(resolve, reject);
}

export function createSupabaseMemoryDb(options: {
  tables: string[];
  seed?: Record<string, MemoryRow[]>;
  uniqueIndexes?: Record<string, UniqueIndex[]>;
  rpc?: Record<string, MemoryRpcHandler>;
}) {
  const tables: MemoryTables = {};
  for (const name of options.tables) tables[name] = [];
  for (const [name, rows] of Object.entries(options.seed ?? {})) tables[name] = rows.map((row) => ({ ...row }));
  const uniqueIndexes = options.uniqueIndexes ?? {};

  const calls: MemoryDbCall[] = [];
  const failures: Array<InjectedFailure & { remaining: number }> = [];
  let sequence = 0;

  function nextDefaults(tableName: string) {
    sequence += 1;
    const stamp = new Date(Date.UTC(2026, 0, 1) + sequence * 1000).toISOString();
    return { id: `${tableName}_${sequence}`, created_at: stamp, updated_at: stamp };
  }

  function takeFailure(tableName: string, op: MutationKind, payload: MemoryRow) {
    const index = failures.findIndex(
      (failure) => failure.table === tableName && failure.op === op && (!failure.match || failure.match(payload))
    );
    if (index < 0) return null;
    const failure = failures[index];
    failure.remaining -= 1;
    if (failure.remaining <= 0) failures.splice(index, 1);
    calls.push({ table: tableName, kind: "injected_failure", payload });
    return failure.error ?? { code: "XX000", message: `injected ${op} failure on ${tableName}` };
  }

  function uniqueViolationAgainst(tableName: string, candidate: MemoryRow, others: MemoryRow[]) {
    for (const index of uniqueIndexes[tableName] ?? []) {
      if (!index.where(candidate)) continue;
      const clash = others.some(
        (other) => index.where(other) && index.columns.every((column) => valuesEqual(other[column], candidate[column]))
      );
      if (clash) {
        return { code: "23505", message: `duplicate key value violates unique constraint "${index.name}"` };
      }
    }
    return null;
  }

  function uniqueViolation(tableName: string, candidate: MemoryRow, ignore: Set<MemoryRow>) {
    return uniqueViolationAgainst(
      tableName,
      candidate,
      tables[tableName].filter((row) => !ignore.has(row))
    );
  }

  function requireTable(tableName: string) {
    const rows = tables[tableName];
    if (!rows) throw new Error(`Unexpected table ${tableName}`);
    return rows;
  }

  function insertRow(tableName: string, row: MemoryRow) {
    const stored = { ...nextDefaults(tableName), ...clone(row) };
    const error = uniqueViolation(tableName, stored, new Set());
    if (error) throw Object.assign(new Error(error.message), error);
    requireTable(tableName).push(stored);
    return stored;
  }

  function filterBuilder(query: Record<string, unknown>, filters: Filter[]) {
    for (const op of ["eq", "neq", "in", "lt", "lte", "gt", "gte", "is"] as FilterOp[]) {
      query[op] = (column: string, value: unknown) => {
        filters.push({ column, op, value });
        return query;
      };
    }
  }

  function buildSelect(tableName: string, readRows: () => MemoryRow[]) {
    const filters: Filter[] = [];
    const orders: Order[] = [];
    let rowLimit: number | null = null;

    const run = () => {
      const failure = takeFailure(tableName, "select", {});
      if (failure) return { rows: null, error: failure };
      const selected = sortRows(
        readRows().filter((row) => filters.every((filter) => rowMatches(row, filter))),
        orders
      );
      return { rows: (rowLimit === null ? selected : selected.slice(0, rowLimit)).map(clone), error: null };
    };

    const query: Record<string, unknown> = {};
    filterBuilder(query, filters);
    query.select = () => query;
    query.order = (column: string, orderOptions?: { ascending?: boolean; nullsFirst?: boolean }) => {
      const ascending = orderOptions?.ascending !== false;
      // Postgres default: NULLS LAST for ASC, NULLS FIRST for DESC.
      orders.push({ column, ascending, nullsFirst: orderOptions?.nullsFirst ?? !ascending });
      return query;
    };
    query.limit = (count: number) => {
      rowLimit = count;
      return query;
    };
    query.maybeSingle = async () => {
      const { rows, error } = run();
      if (error || !rows) return { data: null, error };
      if (rows.length > 1) {
        return { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple rows returned" } };
      }
      return { data: rows[0] ?? null, error: null };
    };
    query.single = async () => {
      const { rows, error } = run();
      if (error || !rows) return { data: null, error };
      if (rows.length !== 1) {
        return { data: null, error: { code: "PGRST116", message: "JSON object requested, not exactly one row returned" } };
      }
      return { data: rows[0], error: null };
    };
    query.then = thenable(() => {
      const { rows, error } = run();
      return { data: rows, error };
    });
    return query;
  }

  function insertRows(tableName: string, input: MemoryRow | MemoryRow[]) {
    const rows = requireTable(tableName);
    const payloads = Array.isArray(input) ? input : [input];
    for (const payload of payloads) {
      const failure = takeFailure(tableName, "insert", payload);
      if (failure) return { data: null, error: failure };
    }
    const stored = payloads.map((payload) => ({ ...nextDefaults(tableName), ...clone(payload) }));
    const pending: MemoryRow[] = [];
    for (const row of stored) {
      const error =
        uniqueViolation(tableName, row, new Set()) ??
        // Duplicates inside one multi-row insert violate too.
        uniqueViolationAgainst(tableName, row, pending);
      if (error) {
        calls.push({ table: tableName, kind: "insert_23505", payload: row });
        return { data: null, error };
      }
      pending.push(row);
    }
    rows.push(...stored);
    for (const row of stored) calls.push({ table: tableName, kind: "insert", payload: clone(row) });
    return { data: stored.map(clone), error: null };
  }

  function buildInsert(tableName: string, input: MemoryRow | MemoryRow[]) {
    let result: { data: MemoryRow[] | null; error: MemoryDbError | null } | null = null;
    const execute = () => {
      result ??= insertRows(tableName, input);
      return result;
    };
    const single = async () => {
      const { data, error } = execute();
      return { data: data ? data[0] ?? null : null, error };
    };
    return {
      select: () => ({
        single,
        maybeSingle: single,
        then: thenable(() => execute()),
      }),
      // Supabase returns data: null for an insert without .select().
      then: thenable(() => ({ data: null, error: execute().error })),
    };
  }

  function buildUpdate(tableName: string, patch: MemoryRow) {
    const rows = requireTable(tableName);
    const filters: Filter[] = [];
    let result: { data: MemoryRow[] | null; error: MemoryDbError | null } | null = null;

    const execute = () => {
      if (result) return result;
      const failure = takeFailure(tableName, "update", patch);
      if (failure) {
        result = { data: null, error: failure };
        return result;
      }
      const targets = rows.filter((row) => filters.every((filter) => rowMatches(row, filter)));
      const ignore = new Set(targets);
      const updatedTargets: MemoryRow[] = [];
      for (const target of targets) {
        const candidate = { ...target, ...patch };
        const error =
          uniqueViolation(tableName, candidate, ignore) ?? uniqueViolationAgainst(tableName, candidate, updatedTargets);
        if (error) {
          calls.push({ table: tableName, kind: "update_23505", payload: clone(patch), filters: [...filters] });
          result = { data: null, error };
          return result;
        }
        updatedTargets.push(candidate);
      }
      for (const target of targets) Object.assign(target, clone(patch));
      calls.push({ table: tableName, kind: "update", payload: clone(patch), filters: [...filters] });
      result = { data: targets.map(clone), error: null };
      return result;
    };

    const query: Record<string, unknown> = {};
    filterBuilder(query, filters);
    query.select = () => {
      const selected: Record<string, unknown> = {};
      selected.single = async () => {
        const { data, error } = execute();
        if (error || !data) return { data: null, error };
        if (data.length !== 1) {
          return { data: null, error: { code: "PGRST116", message: "JSON object requested, not exactly one row returned" } };
        }
        return { data: data[0], error: null };
      };
      selected.maybeSingle = async () => {
        const { data, error } = execute();
        if (error || !data) return { data: null, error };
        return { data: data[0] ?? null, error: null };
      };
      selected.order = () => selected;
      selected.limit = () => selected;
      selected.then = thenable(() => execute());
      return selected;
    };
    query.then = thenable(() => ({ data: null, error: execute().error }));
    return query;
  }

  function runRpc(name: string, args: MemoryRow) {
    const failure = takeFailure(name, "rpc", args);
    if (failure) return { data: null, error: failure };
    const handler = options.rpc?.[name];
    if (!handler) return { data: null, error: { code: "PGRST202", message: `function ${name} not found` } };
    calls.push({ table: name, kind: "rpc", payload: clone(args) });
    try {
      const outcome = handler(clone(args), { tables, insertRow });
      return { data: clone(outcome.data), error: outcome.error };
    } catch (error) {
      const record = error as MemoryDbError;
      return { data: null, error: { code: record.code ?? "XX000", message: record.message } };
    }
  }

  function makeClient(readOverrides: Record<string, () => MemoryRow[]> = {}) {
    return {
      from(tableName: string) {
        const rows = requireTable(tableName);
        const readRows = readOverrides[tableName] ?? (() => rows);
        return {
          select: () => buildSelect(tableName, readRows),
          insert: (input: MemoryRow | MemoryRow[]) => buildInsert(tableName, input),
          update: (patch: MemoryRow) => buildUpdate(tableName, patch),
        };
      },
      rpc(name: string, args: MemoryRow = {}) {
        return { then: thenable(() => runRpc(name, args)) };
      },
    };
  }

  const db = makeClient();

  return {
    db,
    tables,
    calls,
    /** Seed a row directly (defaults id/created_at/updated_at like an insert). */
    insertRow,
    /** Make the next matching operation fail with `error` (default a generic DB error). */
    failNext(failure: InjectedFailure) {
      failures.push({ ...failure, remaining: failure.times ?? 1 });
    },
    /**
     * A client whose reads of `tableName` return a frozen snapshot while every
     * write still hits the live tables: a deterministic read-then-write race.
     */
    withStaleReads(tableName: string, snapshot: MemoryRow[]) {
      const frozen = snapshot.map(clone);
      return makeClient({ [tableName]: () => frozen });
    },
  };
}

export type SupabaseMemoryDb = ReturnType<typeof createSupabaseMemoryDb>;
