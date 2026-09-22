/**
 * In-memory Supabase + Base RPC fakes for crypto billing tests (USDC top-up
 * settlement and reconciliation).
 *
 * Unlike the generic `createSupabaseMock` stub, this fake actually filters and
 * mutates rows, so settlement/reconciliation code runs against real query
 * semantics:
 *   - eq / neq / in / lt / lte / gt / gte / is filters (including PostgREST
 *     JSON paths such as `metadata->>failureType`), multi-key order, and a
 *     chainable + thenable limit;
 *   - update(...).<filters>.select() resolves to the AFFECTED rows, so
 *     compare-and-set code can see "0 rows = lost the race";
 *   - 23505 emulation for the production unique constraints on the tables
 *     these flows write (receipt per transfer and per intent, ledger
 *     idempotency, review item dedupe key, one credit account per user);
 *   - one-shot failure injection, and `beforeUpdate` hooks that let a test
 *     make a concurrent write land between a read and a compare-and-set.
 *
 * The RPC fake models Base: per-block timestamps (2 s blocks by default),
 * eth_getLogs honouring fromBlock/toBlock/address/topics, and the public
 * endpoint's 2,000-block range limit (HTTP 413 + JSON-RPC error body).
 */

import { USDC_BASE_TOKEN_ADDRESS } from "@/lib/billing/crypto-topups";

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

type MutationKind = "insert" | "update" | "upsert" | "select";

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

export interface BeforeUpdateHook {
  table: string;
  /** Only run when the update patch matches. */
  match?: (patch: MemoryRow) => boolean;
  /** Runs against the live tables just before the update's filters apply. */
  run: (tables: Record<string, MemoryRow[]>) => void;
  times?: number;
}

interface UniqueIndex {
  name: string;
  columns: string[];
  where: (row: MemoryRow) => boolean;
}

const UNIQUE_INDEXES: Record<string, UniqueIndex[]> = {
  payment_transactions: [
    {
      name: "payment_transactions_provider_provider_reference_id_key",
      columns: ["provider", "provider_reference_id"],
      where: () => true,
    },
  ],
  crypto_deposit_receipts: [
    {
      name: "crypto_deposit_receipts_chain_id_tx_hash_log_index_key",
      columns: ["chain_id", "tx_hash", "log_index"],
      where: () => true,
    },
    {
      name: "crypto_deposit_receipts_provider_reference_id_key",
      columns: ["provider", "reference_id"],
      where: () => true,
    },
  ],
  crypto_topup_reconciliation_items: [
    {
      name: "crypto_topup_reconciliation_items_dedupe_key_key",
      columns: ["dedupe_key"],
      where: () => true,
    },
  ],
  credit_accounts: [
    {
      name: "credit_accounts_user_id_key",
      columns: ["user_id"],
      where: () => true,
    },
  ],
  credit_ledger_entries: [
    {
      name: "credit_ledger_entries_source_reference_id_reason_key",
      columns: ["source", "reference_id", "reason"],
      where: () => true,
    },
  ],
};

const DEFAULT_TABLES = [
  "payment_transactions",
  "crypto_deposit_receipts",
  "crypto_topup_reconciliation_items",
  "credit_accounts",
  "credit_ledger_entries",
  "deposit_quotes",
  "yearly_token_quotes",
  "managed_venice_token_quotes",
];

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const INTEGER_STRING = /^-?\d+$/;

// `metadata->>key` (text) and `metadata->key` (json) read one level into a
// jsonb column, like PostgREST. Anything else is a plain column.
function readColumn(row: MemoryRow, column: string): unknown {
  const match = /^([a-z_]+)->>?([A-Za-z0-9_]+)$/.exec(column);
  if (!match) return row[column];
  const container = row[match[1]];
  if (!container || typeof container !== "object") return null;
  const value = (container as Record<string, unknown>)[match[2]];
  if (value === undefined || value === null) return null;
  return column.includes("->>") && typeof value !== "string" ? JSON.stringify(value) : value;
}

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
      const a = readColumn(left, order.column);
      const b = readColumn(right, order.column);
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

export function createBillingMemoryDb(seed: Record<string, MemoryRow[]> = {}) {
  const tables: Record<string, MemoryRow[]> = {};
  for (const name of DEFAULT_TABLES) tables[name] = [];
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((row) => ({ ...row }));

  const calls: MemoryDbCall[] = [];
  const failures: Array<InjectedFailure & { remaining: number }> = [];
  const hooks: Array<BeforeUpdateHook & { remaining: number }> = [];
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

  function runBeforeUpdateHooks(tableName: string, patch: MemoryRow) {
    for (let index = 0; index < hooks.length; index += 1) {
      const hook = hooks[index];
      if (hook.table !== tableName || (hook.match && !hook.match(patch))) continue;
      hook.remaining -= 1;
      if (hook.remaining <= 0) {
        hooks.splice(index, 1);
        index -= 1;
      }
      hook.run(tables);
    }
  }

  function uniqueViolation(tableName: string, candidate: MemoryRow, others: MemoryRow[]) {
    for (const index of UNIQUE_INDEXES[tableName] ?? []) {
      if (!index.where(candidate)) continue;
      const clash = others.find(
        (other) => index.where(other) && index.columns.every((column) => other[column] === candidate[column])
      );
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

  function buildSelect(tableName: string) {
    const filters: Filter[] = [];
    const orders: Order[] = [];
    let rowLimit: number | null = null;

    const run = () => {
      const failure = takeFailure(tableName, "select", {});
      if (failure) return { rows: null, error: failure };
      const selected = sortRows(
        requireTable(tableName).filter((row) => filters.every((filter) => rowMatches(row, filter))),
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
    const pending: MemoryRow[] = [];
    for (const row of stored) {
      const error = uniqueViolation(tableName, row, [...rows, ...pending]);
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
        const error = uniqueViolation(
          tableName,
          { ...existing, ...input },
          rows.filter((row) => row !== existing)
        );
        if (error) {
          result = { data: null, error };
          return result;
        }
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
      runBeforeUpdateHooks(tableName, patch);
      const targets = rows.filter((row) => filters.every((filter) => rowMatches(row, filter)));
      const others = rows.filter((row) => !targets.includes(row));
      for (const target of targets) {
        const error = uniqueViolation(tableName, { ...target, ...patch }, others);
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
      selected.then = thenable(() => execute());
      return selected;
    };
    query.then = thenable(() => ({ data: null, error: execute().error }));
    return query;
  }

  const db = {
    from(tableName: string) {
      requireTable(tableName);
      return {
        select: () => buildSelect(tableName),
        insert: (input: MemoryRow | MemoryRow[]) => buildInsert(tableName, input),
        upsert: (input: MemoryRow, options?: { onConflict?: string }) => buildUpsert(tableName, input, options),
        update: (patch: MemoryRow) => buildUpdate(tableName, patch),
      };
    },
  };

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
    /** Run `hook.run` just before the next matching update applies (a concurrent writer). */
    beforeUpdate(hook: BeforeUpdateHook) {
      hooks.push({ ...hook, remaining: hook.times ?? 1 });
    },
  };
}

export type BillingMemoryDb = ReturnType<typeof createBillingMemoryDb>;

// ── Base RPC fake ─────────────────────────────────────────────────────────

export const FAKE_ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export function addressTopic(address: string) {
  return `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

export interface FakeTransfer {
  txHash: string;
  amountRaw: bigint | string | number;
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
  /** Largest eth_getLogs range served (Base's public endpoint: 2,000). */
  maxLogRangeBlocks?: number;
  /** Token a transfer defaults to (USDC on Base). */
  defaultTokenAddress?: string;
}) {
  const blockTimeSec = options.blockTimeSec ?? 2;
  const anchorBlock = options.latestBlock;
  const anchorSec = Math.floor(Date.parse(options.latestTimestamp) / 1000);
  const maxLogRange = options.maxLogRangeBlocks ?? 2_000;
  const defaultToken = options.defaultTokenAddress ?? USDC_BASE_TOKEN_ADDRESS;
  let latestBlock = options.latestBlock;
  const transfers: FakeTransfer[] = [...(options.transfers ?? [])];
  const failures: Array<FakeRpcFailure & { remaining: number }> = [];
  const requests: JsonRpcRequestBody[] = [];

  function blockTimestampSec(block: number) {
    return anchorSec + (block - anchorBlock) * blockTimeSec;
  }

  function toLog(transfer: FakeTransfer) {
    return {
      address: (transfer.tokenAddress ?? defaultToken).toLowerCase(),
      topics: [
        FAKE_ERC20_TRANSFER_TOPIC,
        addressTopic(transfer.from ?? "0x1111111111111111111111111111111111111111"),
        addressTopic(transfer.to),
      ],
      data: `0x${BigInt(transfer.amountRaw).toString(16).padStart(64, "0")}`,
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

    if (request.method === "eth_getLogs") {
      const filter = request.params[0] as {
        address?: string;
        fromBlock: string;
        toBlock: string;
        topics?: Array<string | null>;
      };
      const fromBlock = Number.parseInt(filter.fromBlock, 16);
      const toBlock = filter.toBlock === "latest" ? latestBlock : Number.parseInt(filter.toBlock, 16);
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
    /** Every eth_getLogs block span requested so far. */
    logRanges() {
      return requests
        .filter((request) => request.method === "eth_getLogs")
        .map((request) => {
          const filter = request.params[0] as { fromBlock: string; toBlock: string };
          const from = Number.parseInt(filter.fromBlock, 16);
          const to = filter.toBlock === "latest" ? latestBlock : Number.parseInt(filter.toBlock, 16);
          return { from, to, span: to - from + 1 };
        });
    },
  };
}

export type BaseRpcFake = ReturnType<typeof createBaseRpcFake>;
