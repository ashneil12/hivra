/**
 * In-memory Supabase + Base RPC fakes for managed Venice $HermesOS deposit
 * tests (quote settlement, reconciliation, sweeps).
 *
 * Unlike the generic `createSupabaseMock` stub, this fake actually filters and
 * mutates rows, so settlement/reconciliation code runs against real query
 * semantics:
 *   - eq / neq / in / lt / lte / gt / gte / is filters (also on a jsonb text
 *     path, `metadata->>key`, like PostgREST), multi-key order, and a
 *     chainable + thenable limit;
 *   - update(...).<filters>.select() resolves to the AFFECTED rows, so
 *     compare-and-set code can see "0 rows = lost the race";
 *   - 23505 emulation for the production unique indexes on the venice tables
 *     (quote tx hash, one claim-or-review binding per deposit address and tx,
 *     one deposit lot per quote, financial event idempotency key,
 *     reconciliation item dedupe key, one wallet account per user);
 *   - managed_venice_financial_events is append-only (update fails);
 *   - NOT NULL column defaults the code relies on (quotes'
 *     transfer_surfacing_pending = false) are applied on insert;
 *   - one-shot failure injection and stale-read views for crash/race tests;
 *   - `rpc` runs the wallet debit functions (capture_managed_venice_reservation,
 *     debit_managed_venice_wallet) atomically, like the SQL under its lock
 *     (see managed-venice-wallet-rpc.ts). Failures inject with
 *     { table: <function name>, op: "rpc" }.
 *
 * The RPC fake models Base: per-block timestamps (2 s blocks by default),
 * eth_getLogs honouring fromBlock/toBlock/address/topics, the public
 * endpoint's 2,000-block range limit (HTTP 413 + JSON-RPC error body), and
 * eth_getTransactionReceipt carrying every log of the tx (null until mined).
 */

import { HERMESOS_TOKEN_ADDRESS } from "@/lib/billing/token-holdings";

import { runManagedVeniceWalletRpc } from "./managed-venice-wallet-rpc";

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
  /** Only fail when the insert row / update patch matches. */
  match?: (payload: MemoryRow) => boolean;
  error?: MemoryDbError;
  /** How many matching operations fail before the rule is spent (default 1). */
  times?: number;
}

interface UniqueIndex {
  name: string;
  // The indexed key of a row, or null when the row is outside the (partial)
  // index. Two rows clash when their keys are element-wise equal.
  key: (row: MemoryRow) => unknown[] | null;
}

function columnIndex(name: string, columns: string[], where: (row: MemoryRow) => boolean): UniqueIndex {
  return { name, key: (row) => (where(row) ? columns.map((column) => row[column]) : null) };
}

function lowerText(value: unknown) {
  return typeof value === "string" ? value.toLowerCase() : value == null ? null : String(value).toLowerCase();
}

// The quote a (deposit address, tx) is bound to: its settlement claim
// (transaction_hash) or, for a quote in review without a claim, its review
// trigger (metadata->>'reviewTransactionHash'). Mirrors the expression index
// uq_managed_venice_token_quotes_address_transfer_binding.
function addressTransferBindingKey(row: MemoryRow) {
  const reviewTransactionHash =
    row.status === "manual_review_required" ? readColumn(row, "metadata->>reviewTransactionHash") : null;
  const transactionHash = lowerText(row.transaction_hash ?? reviewTransactionHash);
  if (transactionHash == null) return null;
  return [lowerText(row.deposit_address), transactionHash];
}

const UNIQUE_INDEXES: Record<string, UniqueIndex[]> = {
  managed_venice_token_quotes: [
    columnIndex("managed_venice_token_quotes_tx_hash_idx", ["transaction_hash"], (row) => row.transaction_hash != null),
    { name: "uq_managed_venice_token_quotes_address_transfer_binding", key: addressTransferBindingKey },
  ],
  managed_venice_token_lots: [
    columnIndex(
      "uq_managed_venice_token_lots_deposit_quote",
      ["quote_id"],
      // 20260923204000: one deposit lot per quote in either platform token.
      (row) => (row.source === "hermesos_deposit" || row.source === "hivra_deposit") && row.quote_id != null
    ),
  ],
  managed_venice_financial_events: [
    columnIndex("managed_venice_financial_events_idempotency_idx", ["idempotency_key"], () => true),
  ],
  managed_venice_reconciliation_items: [
    columnIndex("uq_managed_venice_reconciliation_items_dedupe_key", ["dedupe_key"], (row) => row.dedupe_key != null),
  ],
  managed_venice_wallet_accounts: [
    columnIndex("managed_venice_wallet_accounts_user_id_key", ["user_id"], () => true),
  ],
  // 20260512180000: reference_id text not null unique.
  managed_venice_reservations: [
    columnIndex("managed_venice_reservations_reference_id_key", ["reference_id"], (row) => row.reference_id != null),
  ],
};

function sameIndexKey(left: unknown[] | null, right: unknown[] | null) {
  return Boolean(left && right && left.every((value, position) => value === right[position]));
}

const APPEND_ONLY_TABLES = new Set(["managed_venice_financial_events"]);

// Column defaults applied on insert, like the schema's NOT NULL DEFAULTs.
const COLUMN_DEFAULTS: Record<string, MemoryRow> = {
  managed_venice_token_quotes: { transfer_surfacing_pending: false },
};

const DEFAULT_TABLES = [
  "managed_venice_wallet_accounts",
  "managed_venice_token_quotes",
  "managed_venice_token_lots",
  "managed_venice_financial_events",
  "managed_venice_reconciliation_items",
  "managed_venice_platform_state",
  "yearly_token_quotes",
  "yearly_token_subscriptions",
  "bankr_deposit_wallet_credentials",
];

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const INTEGER_STRING = /^-?\d+$/;

function compareValues(left: unknown, right: unknown): number {
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

// A column, or a PostgREST jsonb text path `column->>key` (->> yields text).
function readColumn(row: MemoryRow, column: string): unknown {
  const path = column.split("->>");
  if (path.length === 1) return row[column];
  const [base, key] = path.map((part) => part.trim());
  const container = row[base];
  if (!container || typeof container !== "object") return null;
  const value = (container as Record<string, unknown>)[key];
  if (value === null || value === undefined) return null;
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function rowMatches(row: MemoryRow, filter: Filter) {
  const value = readColumn(row, filter.column);
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
      // Postgres default: NULLS LAST for ASC, NULLS FIRST for DESC.
      if (a == null) return order.ascending ? 1 : -1;
      if (b == null) return order.ascending ? -1 : 1;
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

export function createManagedVeniceMemoryDb(seed: Record<string, MemoryRow[]> = {}) {
  const tables: Record<string, MemoryRow[]> = {};
  for (const name of DEFAULT_TABLES) tables[name] = [];
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((row) => ({ ...row }));

  const calls: MemoryDbCall[] = [];
  const failures: Array<InjectedFailure & { remaining: number }> = [];
  let sequence = 0;

  function nextDefaults(tableName: string) {
    sequence += 1;
    const stamp = new Date(Date.UTC(2026, 0, 1) + sequence * 1000).toISOString();
    return { id: `${tableName}_${sequence}`, created_at: stamp, updated_at: stamp, ...COLUMN_DEFAULTS[tableName] };
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

  function uniqueViolation(tableName: string, candidate: MemoryRow, ignore: Set<MemoryRow>) {
    for (const index of UNIQUE_INDEXES[tableName] ?? []) {
      const key = index.key(candidate);
      if (!key) continue;
      const clash = tables[tableName].find((other) => !ignore.has(other) && sameIndexKey(index.key(other), key));
      if (clash) {
        return {
          code: "23505",
          message: `duplicate key value violates unique constraint "${index.name}"`,
        };
      }
    }
    return null;
  }

  function requireTable(tableName: string) {
    const rows = tables[tableName];
    if (!rows) throw new Error(`Unexpected table ${tableName}`);
    return rows;
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
    for (const op of ["eq", "neq", "in", "lt", "lte", "gt", "gte", "is"] as FilterOp[]) {
      query[op] = (column: string, value: unknown) => {
        filters.push({ column, op, value });
        return query;
      };
    }
    query.select = () => query;
    query.order = (column: string, options?: { ascending?: boolean }) => {
      orders.push({ column, ascending: options?.ascending !== false });
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
    const pending = new Set<MemoryRow>();
    for (const row of stored) {
      const error =
        uniqueViolation(tableName, row, new Set()) ??
        // Duplicates inside one multi-row insert violate too.
        uniqueViolationAgainst(tableName, row, [...pending]);
      if (error) {
        calls.push({ table: tableName, kind: "insert_23505", payload: row });
        return { data: null, error };
      }
      pending.add(row);
    }
    rows.push(...stored);
    for (const row of stored) calls.push({ table: tableName, kind: "insert", payload: clone(row) });
    return { data: stored.map(clone), error: null };
  }

  function uniqueViolationAgainst(tableName: string, candidate: MemoryRow, others: MemoryRow[]) {
    for (const index of UNIQUE_INDEXES[tableName] ?? []) {
      const key = index.key(candidate);
      if (!key) continue;
      if (others.some((other) => sameIndexKey(index.key(other), key))) {
        return { code: "23505", message: `duplicate key value violates unique constraint "${index.name}"` };
      }
    }
    return null;
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

  function buildUpsert(tableName: string, input: MemoryRow, options?: { onConflict?: string }) {
    const rows = requireTable(tableName);
    const conflictColumns = (options?.onConflict || "id").split(",").map((column) => column.trim());
    let result: { data: MemoryRow | null; error: MemoryDbError | null } | null = null;
    const execute = () => {
      if (result) return result;
      const failure = takeFailure(tableName, "upsert", input);
      if (failure) {
        result = { data: null, error: failure };
        return result;
      }
      const existing = rows.find((row) => conflictColumns.every((column) => row[column] === input[column]));
      if (existing) {
        Object.assign(existing, clone(input));
        calls.push({ table: tableName, kind: "upsert", payload: clone(input) });
        result = { data: clone(existing), error: null };
        return result;
      }
      const inserted = insertRows(tableName, input);
      result = { data: inserted.data ? inserted.data[0] : null, error: inserted.error };
      return result;
    };
    const single = async () => execute();
    return {
      select: () => ({ single, maybeSingle: single }),
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
      if (APPEND_ONLY_TABLES.has(tableName) && targets.length > 0) {
        result = { data: null, error: { code: "P0001", message: `${tableName} is append-only` } };
        return result;
      }
      const ignore = new Set(targets);
      for (const target of targets) {
        const error = uniqueViolation(tableName, { ...target, ...patch }, ignore);
        if (error) {
          calls.push({ table: tableName, kind: "update_23505", payload: clone(patch), filters: [...filters] });
          result = { data: null, error };
          return result;
        }
      }
      for (const target of targets) Object.assign(target, clone(patch));
      calls.push({ table: tableName, kind: "update", payload: clone(patch), filters: [...filters] });
      result = { data: targets.map(clone), error: null };
      return result;
    };

    const query: Record<string, unknown> = {};
    for (const op of ["eq", "neq", "in", "lt", "lte", "gt", "gte", "is"] as FilterOp[]) {
      query[op] = (column: string, value: unknown) => {
        filters.push({ column, op, value });
        return query;
      };
    }
    query.select = () => {
      const selected: Record<string, unknown> = {};
      const single = async () => {
        const { data, error } = execute();
        if (error || !data) return { data: null, error };
        if (data.length !== 1) {
          return { data: null, error: { code: "PGRST116", message: "JSON object requested, not exactly one row returned" } };
        }
        return { data: data[0], error: null };
      };
      selected.single = single;
      selected.maybeSingle = async () => {
        const { data, error } = execute();
        if (error || !data) return { data: null, error };
        return { data: data[0] ?? null, error: null };
      };
      selected.then = thenable(() => execute());
      return selected;
    };
    query.then = thenable(() => ({ data: null, error: execute().error }));
    return query;
  }

  function makeClient(readOverrides: Record<string, () => MemoryRow[]> = {}, onWrite: () => void = () => undefined) {
    return {
      from(tableName: string) {
        const rows = requireTable(tableName);
        const readRows = () => (readOverrides[tableName] ?? (() => rows))();
        return {
          select: () => buildSelect(tableName, readRows),
          insert: (input: MemoryRow | MemoryRow[]) => {
            onWrite();
            return buildInsert(tableName, input);
          },
          upsert: (input: MemoryRow, options?: { onConflict?: string }) => {
            onWrite();
            return buildUpsert(tableName, input, options);
          },
          update: (patch: MemoryRow) => {
            onWrite();
            return buildUpdate(tableName, patch);
          },
        };
      },
      rpc(fn: string, args: Record<string, unknown> = {}) {
        onWrite();
        return {
          then: thenable(() => {
            const failure = takeFailure(fn, "rpc", args);
            if (failure) return { data: null, error: failure };
            calls.push({ table: fn, kind: "rpc", payload: clone(args) });
            return runManagedVeniceWalletRpc(
              {
                rows: requireTable,
                insert: (tableName, row) => ({ error: insertRows(tableName, row).error }),
              },
              fn,
              args
            );
          }),
        };
      },
    };
  }

  const db = makeClient();

  return {
    db,
    tables,
    calls,
    /** Seed a row directly (defaults id/created_at/updated_at like an insert). */
    insertRow(tableName: string, row: MemoryRow) {
      const stored = { ...nextDefaults(tableName), ...row };
      requireTable(tableName).push(stored);
      return stored;
    },
    /** Make the next matching operation fail with `error` (default a generic DB error). */
    failNext(failure: InjectedFailure) {
      failures.push({ ...failure, remaining: failure.times ?? 1 });
    },
    /**
     * A client whose reads of `tableName` return a frozen snapshot while every
     * write still hits the live tables: a deterministic read-then-write race.
     * Pass a { table: snapshot } map to freeze several tables at once.
     * `untilWrite` ends the stale view at this client's first write (insert,
     * update or upsert, whether it succeeds or not), like READ COMMITTED: the
     * reads ran before a concurrent writer committed, every later statement
     * sees that commit.
     */
    withStaleReads(
      tableName: string | Record<string, MemoryRow[]>,
      snapshot: MemoryRow[] = [],
      options: { untilWrite?: boolean } = {}
    ) {
      const snapshots = typeof tableName === "string" ? { [tableName]: snapshot } : tableName;
      let stale = true;
      const readOverrides: Record<string, () => MemoryRow[]> = {};
      for (const [name, rows] of Object.entries(snapshots)) {
        const frozen = rows.map(clone);
        readOverrides[name] = () => (stale ? frozen : requireTable(name));
      }
      return makeClient(readOverrides, () => {
        if (options.untilWrite) stale = false;
      });
    },
  };
}

export type ManagedVeniceMemoryDb = ReturnType<typeof createManagedVeniceMemoryDb>;

// ── Base RPC fake ─────────────────────────────────────────────────────────

export const FAKE_ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export function addressTopic(address: string) {
  return `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

export interface FakeTransfer {
  txHash: string;
  amountRaw: bigint | string;
  block: number;
  logIndex?: number;
  to: string;
  from?: string;
  tokenAddress?: string;
}

interface JsonRpcRequestBody {
  method: string;
  params: unknown[];
}

export interface FakeRpcFailure {
  method: string;
  status?: number;
  body?: unknown;
  times?: number;
}

export function createBaseRpcFake(options: {
  latestBlock: number;
  /** Timestamp of `latestBlock`; other blocks are spaced `blockTimeSec` apart. */
  latestTimestamp: string;
  blockTimeSec?: number;
  transfers?: FakeTransfer[];
  maxLogRangeBlocks?: number;
}) {
  const blockTimeSec = options.blockTimeSec ?? 2;
  const anchorBlock = options.latestBlock;
  const anchorSec = Math.floor(Date.parse(options.latestTimestamp) / 1000);
  const maxLogRange = options.maxLogRangeBlocks ?? 2_000;
  let latestBlock = options.latestBlock;
  const transfers: FakeTransfer[] = [...(options.transfers ?? [])];
  // Receipt status per lowercased tx hash; every other mined tx succeeded.
  const receiptStatuses = new Map<string, string>();
  const failures: Array<FakeRpcFailure & { remaining: number }> = [];
  const requests: JsonRpcRequestBody[] = [];

  function blockTimestampSec(block: number) {
    return anchorSec + (block - anchorBlock) * blockTimeSec;
  }

  function toLog(transfer: FakeTransfer) {
    return {
      address: (transfer.tokenAddress ?? HERMESOS_TOKEN_ADDRESS).toLowerCase(),
      topics: [
        FAKE_ERC20_TRANSFER_TOPIC,
        addressTopic(transfer.from ?? "0x1111111111111111111111111111111111111111"),
        addressTopic(transfer.to),
      ],
      data: `0x${BigInt(transfer.amountRaw).toString(16)}`,
      transactionHash: transfer.txHash,
      logIndex: `0x${(transfer.logIndex ?? 0).toString(16)}`,
      blockNumber: `0x${transfer.block.toString(16)}`,
      blockHash: `0xblock${transfer.block}`,
    };
  }

  const ok = (result: unknown) => ({
    ok: true,
    status: 200,
    json: async () => ({ jsonrpc: "2.0", id: 1, result }),
  });

  const fetchImpl = jest.fn(async (_url: string, init: { body: string }) => {
    const request = JSON.parse(init.body) as JsonRpcRequestBody;
    requests.push(request);

    const failureIndex = failures.findIndex((failure) => failure.method === request.method);
    if (failureIndex >= 0) {
      const failure = failures[failureIndex];
      failure.remaining -= 1;
      if (failure.remaining <= 0) failures.splice(failureIndex, 1);
      return {
        ok: false,
        status: failure.status ?? 500,
        json: async () => failure.body ?? {},
      };
    }

    if (request.method === "eth_blockNumber") return ok(`0x${latestBlock.toString(16)}`);

    if (request.method === "eth_getBlockByNumber") {
      const tag = request.params[0];
      const block = tag === "latest" ? latestBlock : Number.parseInt(String(tag), 16);
      if (!Number.isSafeInteger(block) || block < 0 || block > latestBlock) return ok(null);
      return ok({
        number: `0x${block.toString(16)}`,
        timestamp: `0x${blockTimestampSec(block).toString(16)}`,
      });
    }

    if (request.method === "eth_getTransactionReceipt") {
      const txHash = String(request.params[0]).toLowerCase();
      const txTransfers = transfers
        .filter((transfer) => transfer.txHash.toLowerCase() === txHash)
        .sort((a, b) => (a.logIndex ?? 0) - (b.logIndex ?? 0));
      // Unknown or not mined yet at the current head: no receipt.
      if (txTransfers.length === 0 || txTransfers[0].block > latestBlock) return ok(null);
      const block = txTransfers[0].block;
      return ok({
        transactionHash: txTransfers[0].txHash,
        blockNumber: `0x${block.toString(16)}`,
        blockHash: `0xblock${block}`,
        status: receiptStatuses.get(txHash) ?? "0x1",
        logs: txTransfers.map(toLog),
      });
    }

    if (request.method === "eth_getLogs") {
      const filter = request.params[0] as {
        address?: string;
        fromBlock: string;
        toBlock: string;
        topics?: Array<string | null>;
      };
      const fromBlock = Number.parseInt(filter.fromBlock, 16);
      const toBlock = Number.parseInt(filter.toBlock, 16);
      if (toBlock - fromBlock + 1 > maxLogRange) {
        return {
          ok: false,
          status: 413,
          json: async () => ({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32614, message: "eth_getLogs is limited to a 2,000 range" },
          }),
        };
      }
      const logs = transfers
        .filter((transfer) => transfer.block >= fromBlock && transfer.block <= toBlock && transfer.block <= latestBlock)
        .map(toLog)
        .filter((log) => !filter.address || log.address === filter.address.toLowerCase())
        .filter((log) =>
          (filter.topics ?? []).every((topic, index) => topic == null || log.topics[index] === topic.toLowerCase())
        )
        .sort((a, b) =>
          Number.parseInt(a.blockNumber, 16) - Number.parseInt(b.blockNumber, 16) ||
          Number.parseInt(a.logIndex, 16) - Number.parseInt(b.logIndex, 16)
        );
      return ok(logs);
    }

    throw new Error(`Unexpected RPC method ${request.method}`);
  });

  return {
    fetchImpl,
    requests,
    /** Advance (or rewind) the chain head; timestamps keep the same spacing. */
    setLatestBlock(block: number) {
      latestBlock = block;
    },
    addTransfer(transfer: FakeTransfer) {
      transfers.push(transfer);
    },
    /** The status eth_getTransactionReceipt reports for `txHash` (e.g. "0x0" = reverted). */
    setReceiptStatus(txHash: string, status: string) {
      receiptStatuses.set(txHash.toLowerCase(), status);
    },
    failNext(failure: FakeRpcFailure) {
      failures.push({ ...failure, remaining: failure.times ?? 1 });
    },
    blockTimestamp(block: number) {
      return new Date(blockTimestampSec(block) * 1000).toISOString();
    },
    /** The last block whose timestamp is <= `iso`. */
    blockAt(iso: string) {
      return anchorBlock + Math.floor((Math.floor(Date.parse(iso) / 1000) - anchorSec) / blockTimeSec);
    },
    methodCount(method: string) {
      return requests.filter((request) => request.method === method).length;
    },
  };
}

export type BaseRpcFake = ReturnType<typeof createBaseRpcFake>;

// ── Row builders ──────────────────────────────────────────────────────────

export const TEST_DEPOSIT_ADDRESS = "0x000000000000000000000000000000000000ba5e";

export function managedVeniceQuoteRow(overrides: MemoryRow = {}): MemoryRow {
  return {
    id: "quote_1",
    account_id: "account_1",
    user_id: "user_1",
    token_amount_raw: "1000000000000000000000",
    snapshot_price_usd: "0.05",
    locked_value_micro_usd: 50_000_000,
    deposit_address: TEST_DEPOSIT_ADDRESS,
    quoted_at: "2026-05-16T10:20:00.000Z",
    expires_at: "2026-05-16T10:40:00.000Z",
    status: "active",
    source: "dexscreener",
    cross_check_source: null,
    cross_check_price_usd: null,
    price_last_updated_at: null,
    cross_check_last_updated_at: null,
    transaction_hash: null,
    settled_at: null,
    // NOT NULL DEFAULT false in the schema; only a settle / review flip sets it.
    transfer_surfacing_pending: false,
    sweep_status: "pending",
    metadata: {
      primaryRaw: { pairAddress: "0xpair" },
      crossCheckRaw: null,
      managedVeniceTopUp: {
        policy: "deposit_bonus_v1",
        walletType: "hermesos",
        paidValueMicroUsd: 50_000_000,
        creditValueMicroUsd: 60_000_000,
        bonusValueMicroUsd: 10_000_000,
        launchPaidMicroUsd: 50_000_000,
        standardPaidMicroUsd: 0,
        launchBonusMicroUsd: 10_000_000,
        standardBonusMicroUsd: 0,
        reason: "launch",
      },
    },
    created_at: "2026-05-16T10:20:00.000Z",
    updated_at: "2026-05-16T10:20:00.000Z",
    ...overrides,
  };
}
