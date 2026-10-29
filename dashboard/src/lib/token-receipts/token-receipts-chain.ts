/**
 * Reads Base for /token/receipts. Read-only: it fetches transaction receipts,
 * blocks and balances over JSON-RPC and holds no key, so it cannot sign or move
 * anything.
 *
 * RPC: HERMES_BASE_RPC_URL, then BASE_RPC_URL, then https://mainnet.base.org,
 * as the other Base readers in lib/billing.
 *
 * A confirmed transaction never changes, so each one is fetched at most once a
 * day per server (unstable_cache); balances at most every five minutes. A
 * failed read throws inside the cache callback, so a failure is never stored.
 * When Base cannot be reached the page still lists every entry, marked as not
 * checked, and counts none of them in its totals.
 */
import "server-only";

import { unstable_cache } from "next/cache";
import { createPublicClient, erc20Abi, http, type Hex } from "viem";
import { base } from "viem/chains";

import { HERMESOS_TOKEN } from "@/lib/billing/token-registry";
import { log } from "@/lib/logger";

import {
  checkReceiptOnChain,
  founderWeeks,
  reportRejectedReceipts,
  type ChainTx,
  type FounderWeek,
  type ReceiptCheck,
  type ReceiptToken,
  type TokenAmount,
  type TokenReceiptsBase,
  type ValidatedReceipt,
} from "./token-receipts";

const DEFAULT_BASE_RPC_URL = "https://mainnet.base.org";
const RPC_TIMEOUT_MS = 8_000;
const CONCURRENCY = 4;

/** The JSON-safe form a cached transaction is stored in. */
type StoredTx = Omit<ChainTx, "blockNumber"> & { blockNumber: string };

export type ChainBalances = {
  safeEthWei: bigint | null;
  safeHivraWei: bigint | null;
  founderHermesosWei: bigint | null;
};

/** The reads the page needs. Tests pass their own. */
export interface TokenReceiptsChainReader {
  /** The transaction, or null when Base has no such transaction. Throws when Base cannot be reached. */
  getTransaction(hash: string): Promise<ChainTx | null>;
  getBalances(addresses: { treasurySafe: string | null; founderWallet: string | null; hivraAddress: string }): Promise<ChainBalances>;
}

function rpcUrl(env: Record<string, string | undefined>): string {
  return env.HERMES_BASE_RPC_URL?.trim() || env.BASE_RPC_URL?.trim() || DEFAULT_BASE_RPC_URL;
}

class NotOnChain extends Error {
  constructor() {
    super("transaction not found on Base");
  }
}

/** viem's reader over Base, behind the caches. */
export function createBaseReceiptsReader(env: Record<string, string | undefined> = process.env): TokenReceiptsChainReader {
  const client = createPublicClient({ chain: base, transport: http(rpcUrl(env), { timeout: RPC_TIMEOUT_MS, batch: true }) });

  const fetchTx = unstable_cache(
    async (hash: string): Promise<StoredTx> => {
      const [receipt, tx] = await Promise.all([
        client.getTransactionReceipt({ hash: hash as Hex }).catch((error: unknown) => {
          if (error instanceof Error && error.name === "TransactionReceiptNotFoundError") throw new NotOnChain();
          throw error;
        }),
        client.getTransaction({ hash: hash as Hex }).catch((error: unknown) => {
          if (error instanceof Error && error.name === "TransactionNotFoundError") throw new NotOnChain();
          throw error;
        }),
      ]);
      const block = await client.getBlock({ blockNumber: receipt.blockNumber });
      return {
        status: receipt.status,
        blockNumber: receipt.blockNumber.toString(),
        timestamp: Number(block.timestamp),
        to: tx.to ?? null,
        input: tx.input,
        logs: receipt.logs.map((entry) => ({ address: entry.address, topics: [...entry.topics], data: entry.data })),
      };
    },
    ["token-receipts-tx-v1"],
    { revalidate: 86_400 },
  );

  const fetchBalances = unstable_cache(
    async (treasurySafe: string | null, founderWallet: string | null, hivraAddress: string) => {
      const read = async (run: () => Promise<bigint>) => {
        try {
          return (await run()).toString();
        } catch (error) {
          log.warn("Token receipts balance read failed", { source: "token-receipts", error: error instanceof Error ? error.message : String(error) });
          return null;
        }
      };
      const [safeEthWei, safeHivraWei, founderHermesosWei] = await Promise.all([
        treasurySafe ? read(() => client.getBalance({ address: treasurySafe as Hex })) : null,
        treasurySafe ? read(() => client.readContract({ address: hivraAddress as Hex, abi: erc20Abi, functionName: "balanceOf", args: [treasurySafe as Hex] })) : null,
        founderWallet ? read(() => client.readContract({ address: HERMESOS_TOKEN.address as Hex, abi: erc20Abi, functionName: "balanceOf", args: [founderWallet as Hex] })) : null,
      ]);
      if ((treasurySafe || founderWallet) && safeEthWei === null && safeHivraWei === null && founderHermesosWei === null) {
        throw new Error("no balance could be read");
      }
      return { safeEthWei, safeHivraWei, founderHermesosWei };
    },
    ["token-receipts-balances-v1"],
    { revalidate: 300 },
  );

  return {
    async getTransaction(hash) {
      try {
        const stored = await fetchTx(hash.toLowerCase());
        return { ...stored, blockNumber: BigInt(stored.blockNumber) };
      } catch (error) {
        if (error instanceof NotOnChain || (error instanceof Error && error.message === "transaction not found on Base")) return null;
        throw error;
      }
    },
    async getBalances({ treasurySafe, founderWallet, hivraAddress }) {
      const stored = await fetchBalances(treasurySafe, founderWallet, hivraAddress);
      const big = (value: string | null) => (value === null ? null : BigInt(value));
      return { safeEthWei: big(stored.safeEthWei), safeHivraWei: big(stored.safeHivraWei), founderHermesosWei: big(stored.founderHermesosWei) };
    },
  };
}

export type ShownReceipt = ValidatedReceipt & (
  | { check: "verified"; blockNumber: bigint; timestamp: number; amounts: TokenAmount[]; positionIds: string[]; otherTransfers: number }
  | { check: "unchecked" }
);

export type ServedTokenReceipts = Omit<TokenReceiptsBase, "receipts"> & {
  /** Newest first. Entries the chain refused are left out. */
  receipts: ShownReceipt[];
  /** False when at least one entry or balance could not be read from Base on this render. */
  chainComplete: boolean;
  balances: ChainBalances;
  totals: {
    feesReceived: TokenAmount[];
    liquidityAdded: TokenAmount[];
    founderSoldWei: bigint;
    founderBurnedWei: bigint;
  };
  /** The planned sale weeks with what verified sales sold in each; null until the sale start and weeks are set. */
  founderWeeks: { rows: FounderWeek[]; afterPlanWei: bigint } | null;
  /** When this render read Base. */
  checkedAt: string;
};

async function inBatches<T, R>(items: readonly T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += size) {
    results.push(...await Promise.all(items.slice(start, start + size).map(run)));
  }
  return results;
}

function sumAmounts(lists: readonly TokenAmount[][]): TokenAmount[] {
  const totals = new Map<ReceiptToken, bigint>();
  for (const list of lists) for (const { token, wei } of list) totals.set(token, (totals.get(token) ?? 0n) + wei);
  return [...totals].map(([token, wei]) => ({ token, wei }));
}

/** Checks every ledger entry against Base and reads the live balances. Never throws. */
export async function loadTokenReceipts(
  served: TokenReceiptsBase,
  { reader = createBaseReceiptsReader(), now = new Date() }: { reader?: TokenReceiptsChainReader; now?: Date } = {},
): Promise<ServedTokenReceipts> {
  const addresses = {
    treasurySafe: served.treasurySafe,
    founderWallet: served.founder?.wallet ?? null,
    burnAddress: served.founder?.burnAddress ?? null,
    hivraAddress: served.hivraAddress,
  };
  let chainComplete = true;
  const problems: string[] = [];

  const checked = await inBatches(served.receipts, CONCURRENCY, async (receipt): Promise<ShownReceipt | null> => {
    let tx: ChainTx | null;
    try {
      tx = await reader.getTransaction(receipt.txHash);
    } catch (error) {
      chainComplete = false;
      log.warn("Token receipts transaction read failed", { source: "token-receipts", txHash: receipt.txHash, error: error instanceof Error ? error.message : String(error) });
      return { ...receipt, check: "unchecked" };
    }
    const result: ReceiptCheck = tx ? checkReceiptOnChain(receipt, tx, addresses) : { ok: false, reason: "Base has no such transaction" };
    if (!result.ok) {
      problems.push(`${receipt.kind} ${receipt.txHash}: ${result.reason}`);
      return null;
    }
    return { ...receipt, check: "verified", blockNumber: result.blockNumber, timestamp: result.timestamp, amounts: result.amounts, positionIds: result.positionIds, otherTransfers: result.otherTransfers };
  });
  reportRejectedReceipts(problems);
  const receipts = checked.filter((receipt): receipt is ShownReceipt => receipt !== null);

  let balances: ChainBalances = { safeEthWei: null, safeHivraWei: null, founderHermesosWei: null };
  try {
    balances = await reader.getBalances(addresses);
  } catch (error) {
    chainComplete = false;
    log.warn("Token receipts balances unavailable", { source: "token-receipts", error: error instanceof Error ? error.message : String(error) });
  }

  const verified = (kind: ShownReceipt["kind"]) =>
    receipts.filter((receipt): receipt is Extract<ShownReceipt, { check: "verified" }> => receipt.kind === kind && receipt.check === "verified");
  const hermesos = (list: ReturnType<typeof verified>) => list.reduce((sum, receipt) => sum + (receipt.amounts.find((amount) => amount.token === "HermesOS")?.wei ?? 0n), 0n);
  const sales = verified("founder-sale");

  const { founder } = served;
  return {
    ...served,
    receipts,
    chainComplete,
    balances,
    totals: {
      feesReceived: sumAmounts(verified("fee-claim").map((receipt) => receipt.amounts)),
      liquidityAdded: sumAmounts(verified("liquidity-add").map((receipt) => receipt.amounts)),
      founderSoldWei: hermesos(sales),
      founderBurnedWei: hermesos(verified("founder-burn")),
    },
    founderWeeks: founder?.saleStart && founder.weeks
      ? founderWeeks(
        sales.map((sale) => ({ timestamp: sale.timestamp, wei: sale.amounts.find((amount) => amount.token === "HermesOS")?.wei ?? 0n })),
        { saleStart: founder.saleStart, weeks: founder.weeks, weeklyCapWei: served.weeklyCapWei, now },
      )
      : null,
    checkedAt: now.toISOString(),
  };
}
