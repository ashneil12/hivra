import { randomUUID } from "node:crypto";

import { paymentDustFloor, tokenDustFloor, type ScannedTransfer } from "@/lib/billing/base-transfer-scan";
import { livePlatformTokens } from "@/lib/billing/token-registry";
import { normalizeEvmAddress } from "@/lib/billing/token-holdings";
import type { YearlyTokenQuote } from "@/lib/billing/yearly-token-quotes";

import type { createYearlyFinalizedTransferReader } from "./yearly-finalized-transfer-reader";

const BLOCKS_PER_QUOTE_TICK = 24;
const MAX_WINDOW_BLOCKS = 50_000;
const MAX_CHECKPOINT_TRANSFERS = 2_000;
const CHECKPOINT_TABLE = "yearly_token_attribution_checkpoints";

export type FinalizedReader = ReturnType<typeof createYearlyFinalizedTransferReader>;
type StoredTransfer = Omit<ScannedTransfer, "amount"> & { tokenAddress: string; amount: string };
type State = {
  key: string;
  nextBlock: number;
  endBlock: number | null;
  lastHash: string;
  transfers: StoredTransfer[];
};
type Row = { quote_id: string; revision: string; state: State; progressed_at: string };
type Query = {
  eq: (column: string, value: unknown) => Query;
  in: (column: string, values: string[]) => Query;
  select: (columns: string) => Query;
  then: Promise<{ data: Row[] | null; error: { code?: string } | null }>["then"];
};
type Db = { from: (table: string) => unknown };
function checkpoints(db: Db) {
  return db.from(CHECKPOINT_TABLE) as {
    select: (columns: string) => Query;
    insert: (row: Row) => Query;
    update: (row: Omit<Row, "quote_id">) => Query;
  };
}

export async function loadYearlyCheckpoints(db: Db, quoteIds: string[]) {
  if (!quoteIds.length) return new Map<string, Row>();
  const { data, error } = await checkpoints(db).select("quote_id, revision, state, progressed_at").in("quote_id", quoteIds);
  if (error) throw new Error("Failed to load yearly attribution checkpoints");
  return new Map((data ?? []).map((row) => [row.quote_id, row]));
}

type FinalizedHead = Awaited<ReturnType<FinalizedReader["finalized"]>>;

async function blockAtOrAfter(reader: FinalizedReader, head: FinalizedHead, targetMs: number) {
  let low = 0;
  let high = head.number;
  let guess = Math.max(0, head.number - Math.floor((head.timestampMs - targetMs) / 2_000));
  for (let i = 0; i < 4; i++) {
    const block = await reader.block(guess);
    if (block.timestampMs >= targetMs && (guess === 0 || (await reader.block(guess - 1)).timestampMs < targetMs)) return guess;
    if (block.timestampMs < targetMs) low = Math.max(low, guess + 1);
    else high = Math.min(high, guess);
    if (low >= high) return high;
    guess = Math.min(high, Math.max(low, guess + Math.ceil((targetMs - block.timestampMs) / 2_000)));
  }
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if ((await reader.block(mid)).timestampMs < targetMs) low = mid + 1;
    else high = mid;
  }
  return high;
}

export async function checkpointYearlyWindow(params: {
  db: Db;
  reader: FinalizedReader;
  quote: YearlyTokenQuote;
  prior?: Row;
  fromMs: number;
  toMs: number;
  now: Date;
}) {
  const { db, reader, quote, prior, fromMs, toMs, now } = params;
  const head = await reader.finalized();
  const pending = { complete: false, blocks: 0, transfers: [], confirmedHeadMs: 0 } as const;
  if (head.timestampMs < fromMs) return pending;

  const wallet = normalizeEvmAddress(quote.depositAddress);
  const floors = new Map(livePlatformTokens(now).map((token) => [token.address, tokenDustFloor(token.decimals)]));
  floors.set(quote.tokenAddress.toLowerCase(), paymentDustFloor(quote.tokensRequiredRaw));
  const tokenAddresses = [...floors.keys()].sort();
  const key = JSON.stringify([wallet, fromMs, toMs, tokenAddresses.map((address) => [address, String(floors.get(address))])]);
  let state = prior?.state.key === key ? prior.state : undefined;
  if (!state) {
    const first = await blockAtOrAfter(reader, head, fromMs);
    if (first === 0) throw new Error("Invalid finalized yearly attribution block range");
    state = { key, nextBlock: first, endBlock: null, lastHash: (await reader.block(first - 1)).hash, transfers: [] };
  }
  if (state.endBlock === null && head.timestampMs > toMs) {
    state = { ...state, endBlock: (await blockAtOrAfter(reader, head, toMs + 1)) - 1 };
  }
  const available = Math.min(head.number, state.endBlock ?? head.number);
  if (available - state.nextBlock + 1 > MAX_WINDOW_BLOCKS) {
    throw new Error("Invalid finalized yearly attribution block range");
  }

  let blocks = 0;
  if (state.nextBlock <= available) {
    const last = Math.min(available, state.nextBlock + BLOCKS_PER_QUOTE_TICK - 1);
    const chunk = await reader.scan({
      fromBlock: state.nextBlock,
      toBlock: last,
      recipient: wallet,
      tokenAddresses,
      priorHash: state.lastHash,
    });
    const transfers = [...state.transfers];
    for (const transfer of chunk.transfers) {
      const floor = floors.get(transfer.tokenAddress);
      if (floor === undefined || transfer.amount <= 0n || transfer.amount < floor ||
          transfer.timestampMs < fromMs || transfer.timestampMs > toMs) continue;
      transfers.push({ ...transfer, amount: transfer.amount.toString() });
      if (transfers.length > MAX_CHECKPOINT_TRANSFERS) throw new Error("Yearly attribution checkpoint needs operator review");
    }
    blocks = last - state.nextBlock + 1;
    state = { ...state, nextBlock: last + 1, lastHash: chunk.lastHash, transfers };
  } else if ((await reader.block(state.nextBlock - 1)).hash !== state.lastHash) {
    throw new Error("Finalized yearly attribution checkpoint disagrees with chain");
  }

  if (blocks > 0 || prior?.state.key !== key || prior.state.endBlock !== state.endBlock) {
    const record = { revision: randomUUID(), state, progressed_at: now.toISOString() };
    const write = prior
      ? checkpoints(db).update(record).eq("quote_id", quote.id).eq("revision", prior.revision)
      : checkpoints(db).insert({ quote_id: quote.id, ...record });
    const { data, error } = await write.select("quote_id");
    if (error?.code === "23505" || (!error && !data?.length)) return pending;
    if (error) throw new Error("Failed to save yearly attribution checkpoint");
  }

  return {
    complete: state.endBlock !== null && state.nextBlock > state.endBlock && head.number >= state.endBlock,
    blocks,
    transfers: state.transfers.map((transfer) => ({
      ...transfer,
      amount: BigInt(transfer.amount),
      confirmations: head.number - transfer.blockNumber + 1,
    })),
    confirmedHeadMs: head.timestampMs,
  } as const;
}
