/**
 * The public receipts page (/token/receipts): which ledger entries it may show,
 * and whether each transaction on Base does what its entry says.
 *
 * Served only when HIVRA_NEW_TOKEN_SURFACES is on and $HIVRA's launch block is
 * filled in (phase scheduled or active). The proxy also holds back everything
 * under /token while the switch is off.
 *
 * The addresses and the founder's sale plan are not repeated here: the treasury
 * Safe, the fee split and the founder's wallet, weekly cap, weeks, sale start,
 * burn date and burn address all come from HIVRA_MIGRATION, checked by the same
 * validator /token/migration uses. The ledger itself is TOKEN_RECEIPTS.
 *
 * Everything in this file is pure: it checks config and judges transaction data
 * handed to it. Reading Base is token-receipts-chain.ts, so these checks run in
 * tests without a network.
 */
import "server-only";

import {
  HERMESOS_TOKEN,
  BASE_WETH_ADDRESS,
  getConfiguredHivraToken,
  getHivraTokenPhase,
  type PlatformToken,
} from "@/lib/billing/token-registry";
import { log } from "@/lib/logger";
import { newTokenSurfacesEnabled } from "@/lib/token-surfaces";
import { readEip55Address } from "@/lib/claim/eip55";
import { HIVRA_AIRDROP, type HivraAirdropConfig } from "@/lib/claim/hivra-airdrop-config";
import {
  readMigrationDate,
  validateHivraMigrationConfig,
  type MigrationDate,
  type ResolvedMigrationFounder,
} from "@/lib/claim/hivra-migration";
import { HIVRA_MIGRATION, type HivraMigrationConfig, type HivraMigrationFee } from "@/lib/claim/hivra-migration-config";

import { TOKEN_RECEIPTS, type TokenReceiptEntry, type TokenReceiptKind } from "./token-receipts-config";
import type { ReceiptToken } from "./token-receipts-format";

export type { ReceiptToken };

export const TOKEN_RECEIPTS_PATH = "/token/receipts";

export const TOKEN_RECEIPT_KINDS: readonly TokenReceiptKind[] = ["fee-claim", "liquidity-add", "liquidity-lock", "founder-sale", "founder-burn"];

/** keccak256("Transfer(address,uint256)") with the ERC-20 / ERC-721 argument list. Checked against viem in the tests. */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** keccak256("SafeReceived(address,uint256)"): a Safe receiving native ETH. */
export const SAFE_RECEIVED_TOPIC = "0x3d0ce9bfc3ed7d6862dbb28b2dea94561fe714a1b4d019aa8af39730d1ad7c3d";
/** keccak256("ExecutionSuccess(bytes32,uint256)"): a Safe transaction its owners approved and that ran. */
export const EXECUTION_SUCCESS_TOPIC = "0x442e715f626346e8c54381002da614f62bee8d27386535b2521ec8540898556e";
/** Selector of the Safe's execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes). */
export const EXEC_TRANSACTION_SELECTOR = "0x6a761202";

/** USDC on Base. */
const BASE_USDC_ADDRESS = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const MAX_NOTE_LENGTH = 280;
const MAX_LOCKER_NAME_LENGTH = 60;
const TOKEN_COUNT = /^(\d{1,3}(?:\.\d{1,2})?)([KMB])$/;

export type ResolvedLock = {
  locker: string;
  /** EIP-55 checksummed. */
  lockerAddress: string;
  url: string | null;
  /** Null means the entry says the lock never ends. */
  unlocksAt: MigrationDate | null;
};

export type ValidatedReceipt = {
  date: MigrationDate;
  kind: TokenReceiptKind;
  /** Lowercase. */
  txHash: string;
  note: string | null;
  lock: ResolvedLock | null;
};

export type TokenReceiptsBase = {
  /** $HIVRA as published in the token registry. */
  hivraAddress: string;
  /** $HermesOS as published. */
  hermesosAddress: string;
  /** EIP-55 checksummed, from HIVRA_MIGRATION. */
  treasurySafe: string | null;
  fee: HivraMigrationFee | null;
  founder: ResolvedMigrationFounder | null;
  /** The founder's weekly cap in wei, or null when it is not set. */
  weeklyCapWei: bigint | null;
  /** Newest first. */
  receipts: ValidatedReceipt[];
};

/** "500M" → 500,000,000 tokens in wei (18 decimals). Anything else is null. */
export function tokenCountToWei(value: string | null | undefined): bigint | null {
  const match = typeof value === "string" ? TOKEN_COUNT.exec(value.trim()) : null;
  if (!match) return null;
  const [whole, fraction = ""] = match[1].split(".");
  const unitDigits = { K: 3, M: 6, B: 9 }[match[2] as "K" | "M" | "B"];
  const scaled = BigInt(`${whole}${fraction.padEnd(2, "0")}`) * 10n ** BigInt(unitDigits - 2);
  return scaled * 10n ** 18n;
}

/** A plain https link: no credentials, port or fragment. */
export function readPlainHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() !== value || value.length > 500) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return null;
  return url.toString() === value || url.toString() === `${value}/` ? value : null;
}

function readAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || /^0x0{40}$/i.test(text)) return null;
  return readEip55Address(text);
}

/**
 * Checks every ledger entry. Anything invalid is left out and named in
 * `problems`, never shown. `saleStart` is the founder's checked sale start: a
 * founder sale dated before its UTC day is refused, as on /token/migration.
 */
export function validateTokenReceipts(
  entries: readonly TokenReceiptEntry[],
  { now, saleStart = null }: { now: Date; saleStart?: MigrationDate | null },
): { receipts: ValidatedReceipt[]; problems: string[] } {
  const problems: string[] = [];
  const nowMs = now.getTime();
  const saleStartDayMs = saleStart ? Date.parse(saleStart.iso) - (Date.parse(saleStart.iso) % DAY_MS) : null;
  const receipts: (ValidatedReceipt & { ms: number })[] = [];
  const seen = new Set<string>();

  (Array.isArray(entries) ? entries : []).forEach((entry, index) => {
    const where = `receipts[${index}]`;
    const date = readMigrationDate(entry?.date);
    if (!date) return void problems.push(`${where}.date must be a real UTC date or instant`);
    if (!TOKEN_RECEIPT_KINDS.includes(entry.kind)) return void problems.push(`${where}.kind is not one of ${TOKEN_RECEIPT_KINDS.join(", ")}`);
    if (typeof entry.txHash !== "string" || !TX_HASH.test(entry.txHash.trim())) {
      return void problems.push(`${where}.txHash must be 0x followed by 64 hex characters`);
    }
    if (date.ms > nowMs) return void problems.push(`${where}.date is in the future`);
    if (entry.kind === "founder-sale" && saleStartDayMs !== null && date.ms < saleStartDayMs) {
      return void problems.push(`${where} is a founder-sale dated before founder.saleStart`);
    }
    const note = entry.note === null || entry.note === undefined ? null : String(entry.note).trim();
    if (note !== null && (note.length === 0 || note.length > MAX_NOTE_LENGTH)) {
      return void problems.push(`${where}.note must be null or 1 to ${MAX_NOTE_LENGTH} characters`);
    }

    let lock: ResolvedLock | null = null;
    if (entry.kind === "liquidity-lock") {
      const raw = entry.lock;
      const locker = typeof raw?.locker === "string" ? raw.locker.trim() : "";
      const lockerAddress = readAddress(raw?.lockerAddress);
      const url = raw?.url === null ? null : readPlainHttpsUrl(raw?.url);
      const unlocksAt = raw?.unlocksAt === "never" ? null : readMigrationDate(raw?.unlocksAt);
      if (!raw) return void problems.push(`${where} is a liquidity-lock without lock details`);
      if (!locker || locker.length > MAX_LOCKER_NAME_LENGTH) return void problems.push(`${where}.lock.locker must be 1 to ${MAX_LOCKER_NAME_LENGTH} characters`);
      if (!lockerAddress) return void problems.push(`${where}.lock.lockerAddress must be a non-zero EIP-55 address`);
      if (raw.url !== null && url === null) return void problems.push(`${where}.lock.url must be null or a plain https link`);
      if (raw.unlocksAt !== "never" && unlocksAt === null) return void problems.push(`${where}.lock.unlocksAt must be "never" or a real UTC date or instant`);
      lock = { locker, lockerAddress, url, unlocksAt: unlocksAt ? { iso: unlocksAt.iso, dateOnly: unlocksAt.dateOnly } : null };
    } else if (entry.lock !== undefined) {
      return void problems.push(`${where} has lock details but is not a liquidity-lock`);
    }

    const txHash = entry.txHash.trim().toLowerCase();
    const key = `${entry.kind}:${txHash}`;
    if (seen.has(key)) return void problems.push(`${where} repeats a ${entry.kind} transaction`);
    seen.add(key);
    receipts.push({ date: { iso: date.iso, dateOnly: date.dateOnly }, kind: entry.kind, txHash, note, lock, ms: date.ms });
  });
  receipts.sort((a, b) => b.ms - a.ms);
  return { receipts: receipts.map(({ date, kind, txHash, note, lock }) => ({ date, kind, txHash, note, lock })), problems };
}

const reported = new Set<string>();

function reportOnce(message: string, problems: string[]) {
  const key = `${message}|${problems.join("; ")}`;
  if (reported.has(key)) return;
  if (reported.size > 50) reported.clear();
  reported.add(key);
  log.warn(message, {
    source: "token-receipts",
    failureType: "token_receipts_rejected",
    problems: problems.slice(0, 20).join("; "),
  });
}

/** Logs ledger entries the chain check refused. Exported for the chain reader. */
export function reportRejectedReceipts(problems: string[]): void {
  if (problems.length > 0) reportOnce("Token receipts rejected", problems);
}

export type TokenReceiptsInputs = {
  /** Test seams; default to process.env, the clock, the registry and the committed configs. */
  env?: Record<string, string | undefined>;
  now?: Date;
  hivra?: PlatformToken | null;
  migration?: HivraMigrationConfig;
  airdrop?: HivraAirdropConfig;
  ledger?: readonly TokenReceiptEntry[];
};

/**
 * The page's checked config when /token/receipts is served, else null (the page
 * 404s on null and nothing links to it). It does not read Base.
 */
export function getServedTokenReceiptsBase(inputs: TokenReceiptsInputs = {}): TokenReceiptsBase | null {
  if (!newTokenSurfacesEnabled(inputs.env)) return null;
  const now = inputs.now ?? new Date();
  const hivra = inputs.hivra !== undefined
    ? inputs.hivra
    : getHivraTokenPhase(now) === "dormant" ? null : getConfiguredHivraToken();
  if (!hivra) return null;

  const airdrop = inputs.airdrop ?? HIVRA_AIRDROP;
  const migrationConfig = inputs.migration ?? HIVRA_MIGRATION;
  const { migration, problems: migrationProblems } = validateHivraMigrationConfig(migrationConfig, {
    hivraAddress: hivra.address,
    now,
    claimClosesAt: airdrop.claim?.closesAt ?? null,
  });
  const { receipts, problems } = validateTokenReceipts(inputs.ledger ?? TOKEN_RECEIPTS, { now, saleStart: migration.founder?.saleStart ?? null });
  const allProblems = [...migrationProblems.map((problem) => `migration: ${problem}`), ...problems];
  if (allProblems.length > 0) reportOnce("Token receipts config rejected", allProblems);

  return {
    hivraAddress: hivra.publishedAddress,
    hermesosAddress: HERMESOS_TOKEN.publishedAddress,
    treasurySafe: migration.treasurySafe,
    fee: migration.fee,
    founder: migration.founder,
    // Only a cap the validator accepted (it shows as weeklyCapTokens in words).
    weeklyCapWei: migration.founder?.weeklyCapTokens ? tokenCountToWei(migrationConfig.founder?.weeklyCapTokens) : null,
    receipts,
  };
}

/** The link for another page, or null when /token/receipts is not served. The caller passes null for a geo-blocked viewer. */
export function tokenReceiptsHref(inputs: TokenReceiptsInputs = {}): string | null {
  if (!newTokenSurfacesEnabled(inputs.env)) return null;
  const now = inputs.now ?? new Date();
  const hivra = inputs.hivra !== undefined
    ? inputs.hivra
    : getHivraTokenPhase(now) === "dormant" ? null : getConfiguredHivraToken();
  return hivra ? TOKEN_RECEIPTS_PATH : null;
}

// ---------------------------------------------------------------------------
// Judging one transaction against its entry
// ---------------------------------------------------------------------------

export type ChainLog = { address: string; topics: readonly string[]; data: string };

/** What the chain reader fetched for one transaction. */
export type ChainTx = {
  status: "success" | "reverted";
  blockNumber: bigint;
  /** Block time, in seconds. */
  timestamp: number;
  to: string | null;
  input: string;
  logs: readonly ChainLog[];
};

export type TokenAmount = { token: ReceiptToken; wei: bigint };

export type ReceiptCheck =
  | {
      ok: true;
      blockNumber: bigint;
      timestamp: number;
      /** Per token, in the direction the kind cares about (into the Safe, out of the Safe, out of the founder wallet). */
      amounts: TokenAmount[];
      /** ERC-721 positions moved out of the Safe (liquidity-lock), as decimal ids. */
      positionIds: string[];
      /** Transfers of tokens this page does not name (an LP token, say), counted. */
      otherTransfers: number;
    }
  | { ok: false; reason: string };

export type ReceiptAddresses = {
  treasurySafe: string | null;
  founderWallet: string | null;
  burnAddress: string | null;
  hivraAddress: string;
};

function knownTokens(hivraAddress: string): Map<string, ReceiptToken> {
  return new Map<string, ReceiptToken>([
    [BASE_WETH_ADDRESS.toLowerCase(), "WETH"],
    [BASE_USDC_ADDRESS, "USDC"],
    [HERMESOS_TOKEN.address, "HermesOS"],
    [hivraAddress.toLowerCase(), "HIVRA"],
  ]);
}

function topicAddress(topic: string | undefined): string | null {
  return typeof topic === "string" && /^0x0{24}[0-9a-fA-F]{40}$/.test(topic) ? `0x${topic.slice(26).toLowerCase()}` : null;
}

/** The last 32-byte word of the data, or null. SafeReceived indexes `sender` in Safe 1.3+ and not before, so the value is always last. */
function lastWord(data: string): bigint | null {
  if (!/^0x([0-9a-fA-F]{64})+$/.test(data)) return null;
  return BigInt(`0x${data.slice(-64)}`);
}

type Transfer = { token: string; from: string; to: string } & ({ erc721: false; value: bigint } | { erc721: true; id: bigint });

function readTransfers(logs: readonly ChainLog[]): Transfer[] {
  const transfers: Transfer[] = [];
  for (const entry of logs) {
    if (entry.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    const from = topicAddress(entry.topics[1]);
    const to = topicAddress(entry.topics[2]);
    if (!from || !to) continue;
    const token = entry.address.toLowerCase();
    if (entry.topics.length === 3) {
      const value = lastWord(entry.data);
      if (value !== null && entry.data.length === 66) transfers.push({ token, from, to, erc721: false, value });
    } else if (entry.topics.length === 4 && /^0x[0-9a-fA-F]{64}$/.test(entry.topics[3])) {
      transfers.push({ token, from, to, erc721: true, id: BigInt(entry.topics[3]) });
    }
  }
  return transfers;
}

function emittedBy(logs: readonly ChainLog[], address: string, topic?: string): boolean {
  return logs.some((entry) => entry.address.toLowerCase() === address && (topic === undefined || entry.topics[0]?.toLowerCase() === topic));
}

/** ETH the Safe sent as the `value` of a plain (call, not delegatecall) execTransaction on itself. */
function execTransactionValue(tx: ChainTx, safe: string): bigint {
  if (tx.to?.toLowerCase() !== safe || !tx.input.toLowerCase().startsWith(EXEC_TRANSACTION_SELECTOR)) return 0n;
  const args = tx.input.slice(10);
  if (args.length < 64 * 4) return 0n;
  const value = BigInt(`0x${args.slice(64, 128)}`);
  const operation = BigInt(`0x${args.slice(192, 256)}`);
  return operation === 0n ? value : 0n;
}

class AmountTally {
  private readonly totals = new Map<ReceiptToken, bigint>();
  add(token: ReceiptToken, wei: bigint) {
    if (wei > 0n) this.totals.set(token, (this.totals.get(token) ?? 0n) + wei);
  }
  list(): TokenAmount[] {
    const order: ReceiptToken[] = ["ETH", "WETH", "HIVRA", "HermesOS", "USDC"];
    return order.filter((token) => this.totals.has(token)).map((token) => ({ token, wei: this.totals.get(token) as bigint }));
  }
}

/**
 * Whether the transaction does what its entry says, and the amounts its own logs
 * show. A refusal names the reason; the page drops the entry and logs it.
 */
export function checkReceiptOnChain(receipt: ValidatedReceipt, tx: ChainTx, addresses: ReceiptAddresses): ReceiptCheck {
  const fail = (reason: string): ReceiptCheck => ({ ok: false, reason });
  if (tx.status !== "success") return fail("the transaction reverted");
  const blockMs = tx.timestamp * 1000;
  const entryDay = Date.parse(receipt.date.iso) - (Date.parse(receipt.date.iso) % DAY_MS);
  if (blockMs - (blockMs % DAY_MS) !== entryDay) return fail(`its block is dated ${new Date(blockMs).toISOString().slice(0, 10)}, not the entry's UTC day`);

  const tokens = knownTokens(addresses.hivraAddress);
  const transfers = readTransfers(tx.logs);
  const amounts = new AmountTally();
  const positionIds: string[] = [];
  let otherTransfers = 0;
  const done = (): ReceiptCheck => ({ ok: true, blockNumber: tx.blockNumber, timestamp: tx.timestamp, amounts: amounts.list(), positionIds, otherTransfers });

  switch (receipt.kind) {
    case "fee-claim": {
      const safe = addresses.treasurySafe?.toLowerCase();
      if (!safe) return fail("no treasury Safe is configured");
      for (const transfer of transfers) {
        if (transfer.erc721 || transfer.to !== safe) continue;
        const token = tokens.get(transfer.token);
        if (token) amounts.add(token, transfer.value);
        else otherTransfers += 1;
      }
      for (const entry of tx.logs) {
        if (entry.address.toLowerCase() !== safe || entry.topics[0]?.toLowerCase() !== SAFE_RECEIVED_TOPIC) continue;
        amounts.add("ETH", lastWord(entry.data) ?? 0n);
      }
      return amounts.list().length > 0 ? done() : fail("nothing it names reached the treasury Safe");
    }
    case "liquidity-add":
    case "liquidity-lock": {
      const safe = addresses.treasurySafe?.toLowerCase();
      if (!safe) return fail("no treasury Safe is configured");
      if (!emittedBy(tx.logs, safe, EXECUTION_SUCCESS_TOPIC)) return fail("the treasury Safe did not execute it");
      for (const transfer of transfers) {
        if (transfer.from !== safe) continue;
        if (transfer.erc721) {
          positionIds.push(transfer.id.toString());
          continue;
        }
        const token = tokens.get(transfer.token);
        if (token) amounts.add(token, transfer.value);
        else otherTransfers += 1;
      }
      amounts.add("ETH", execTransactionValue(tx, safe));
      if (receipt.kind === "liquidity-add") {
        return amounts.list().length > 0 || otherTransfers > 0 ? done() : fail("nothing left the treasury Safe");
      }
      const locker = receipt.lock?.lockerAddress.toLowerCase();
      if (!locker) return fail("no locker is named");
      const touchesLocker = emittedBy(tx.logs, locker) || transfers.some((transfer) => transfer.from === safe && transfer.to === locker);
      return touchesLocker ? done() : fail("it does not touch the named locker");
    }
    case "founder-sale":
    case "founder-burn": {
      const founder = addresses.founderWallet?.toLowerCase();
      if (!founder) return fail("no founder wallet is configured");
      const burn = addresses.burnAddress?.toLowerCase() ?? null;
      const isBurn = (to: string) => to === ZERO_ADDRESS || to === burn;
      for (const transfer of transfers) {
        if (transfer.erc721 || transfer.token !== HERMESOS_TOKEN.address || transfer.from !== founder) continue;
        if (receipt.kind === "founder-burn" ? isBurn(transfer.to) : !isBurn(transfer.to)) amounts.add("HermesOS", transfer.value);
      }
      if (amounts.list().length > 0) return done();
      return fail(receipt.kind === "founder-burn" ? "no $HermesOS went from the founder wallet to the burn address" : "no $HermesOS left the founder wallet");
    }
  }
}

// ---------------------------------------------------------------------------
// The founder's weeks
// ---------------------------------------------------------------------------

export type FounderWeek = {
  /** 1-based. */
  week: number;
  startsAt: string;
  /** Exclusive: the next week's start. */
  endsAt: string;
  soldWei: bigint;
  overCap: boolean;
  /** The week has not started yet. */
  upcoming: boolean;
};

/**
 * The planned sale weeks, counted in whole weeks from the UTC day of the sale
 * start, with what the verified sales sold in each. Sales after the last planned
 * week are summed into `afterPlanWei` (the page says so rather than hiding them).
 */
export function founderWeeks(
  sales: readonly { timestamp: number; wei: bigint }[],
  { saleStart, weeks, weeklyCapWei, now }: { saleStart: MigrationDate; weeks: number; weeklyCapWei: bigint | null; now: Date },
): { rows: FounderWeek[]; afterPlanWei: bigint } {
  const startMs = Date.parse(saleStart.iso) - (Date.parse(saleStart.iso) % DAY_MS);
  const sold = new Array<bigint>(weeks).fill(0n);
  let afterPlanWei = 0n;
  for (const sale of sales) {
    const index = Math.floor((sale.timestamp * 1000 - startMs) / WEEK_MS);
    if (index < 0) continue;
    if (index >= weeks) afterPlanWei += sale.wei;
    else sold[index] += sale.wei;
  }
  const rows = sold.map((soldWei, index) => ({
    week: index + 1,
    startsAt: new Date(startMs + index * WEEK_MS).toISOString(),
    endsAt: new Date(startMs + (index + 1) * WEEK_MS).toISOString(),
    soldWei,
    overCap: weeklyCapWei !== null && soldWei > weeklyCapWei,
    upcoming: startMs + index * WEEK_MS > now.getTime(),
  }));
  return { rows, afterPlanWei };
}
