/**
 * The public $HIVRA airdrop list and the wallet lookup on /token/airdrop.
 *
 * The list is written by scripts/token/build-hivra-airdrop.mjs from the
 * $HermesOS snapshot and committed as src/data/token/hivra-airdrop.json. It
 * holds snapshot addresses and amounts only: a Hivra-managed wallet is flagged
 * `remapped` with no destination and no batch number, and no user id or email
 * is ever in it. A list that fails any check here is treated as absent, so the
 * lookup stays hidden rather than showing a wrong amount.
 *
 * Every amount is wei as a decimal string, handled with BigInt only.
 *
 * Client-safe: no imports.
 */

export const HIVRA_AIRDROP_DATA_VERSION = 1;
const DECIMALS = 18;
const WEI_PER_TOKEN = 10n ** BigInt(DECIMALS);
const ADDRESS = /^0x[0-9a-f]{40}$/;
const ANY_CASE_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH = /^0x[0-9a-f]{64}$/;
const WEI = /^\d+$/;

export type HivraAirdropHolder =
  | { address: string; amountWei: string; batch: number; remapped?: undefined }
  | { address: string; amountWei: string; remapped: true; sent: boolean };

export type HivraAirdropData = {
  version: typeof HIVRA_AIRDROP_DATA_VERSION;
  snapshotBlock: number;
  totals: { holders: number; includedWei: string; percentOfSupply: string };
  batches: { index: number; recipients: number; totalWei: string; tx: string | null }[];
  holders: HivraAirdropHolder[];
  excluded: { address: string; label: string }[];
};

export type ParsedHivraAirdrop = {
  data: HivraAirdropData;
  holdersByAddress: ReadonlyMap<string, HivraAirdropHolder>;
  excludedByAddress: ReadonlyMap<string, string>;
};

export type AirdropParseResult = { ok: true; airdrop: ParsedHivraAirdrop } | { ok: false; problems: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Validates the committed list. Anything off (a malformed address, an amount
 * that is not whole wei, a holder in a batch that does not exist, totals that
 * do not add up exactly) rejects the whole list.
 */
export function parseHivraAirdropData(raw: unknown): AirdropParseResult {
  const problems: string[] = [];
  if (!isRecord(raw)) return { ok: false, problems: ["the airdrop list is not a JSON object"] };
  if (raw.version !== HIVRA_AIRDROP_DATA_VERSION) problems.push(`version must be ${HIVRA_AIRDROP_DATA_VERSION}`);
  if (!isPositiveInteger(raw.snapshotBlock)) problems.push("snapshotBlock must be a positive whole block number");
  if (raw.decimals !== DECIMALS) problems.push(`decimals must be ${DECIMALS}`);
  const totals = isRecord(raw.totals) ? raw.totals : null;
  if (!totals || !isPositiveInteger(totals.holders) || typeof totals.includedWei !== "string" || !WEI.test(totals.includedWei)
    || typeof totals.percentOfSupply !== "string" || !/^\d+\.\d{2}$/.test(totals.percentOfSupply)) {
    problems.push("totals must give holders, includedWei and percentOfSupply");
  }

  const batchIndexes = new Map<number, bigint>();
  const batches: HivraAirdropData["batches"] = [];
  if (!Array.isArray(raw.batches)) problems.push("batches must be a list");
  else raw.batches.forEach((batch, position) => {
    if (!isRecord(batch) || batch.index !== position + 1 || !isPositiveInteger(batch.recipients)
      || typeof batch.totalWei !== "string" || !WEI.test(batch.totalWei)
      || !(batch.tx === null || (typeof batch.tx === "string" && TX_HASH.test(batch.tx)))) {
      problems.push(`batch ${position + 1} is malformed`);
      return;
    }
    batchIndexes.set(batch.index, 0n);
    batches.push({ index: batch.index, recipients: batch.recipients, totalWei: batch.totalWei, tx: batch.tx as string | null });
  });

  const holdersByAddress = new Map<string, HivraAirdropHolder>();
  const holders: HivraAirdropHolder[] = [];
  let includedWei = 0n;
  if (!Array.isArray(raw.holders)) problems.push("holders must be a list");
  else for (const holder of raw.holders) {
    if (!isRecord(holder) || typeof holder.address !== "string" || !ADDRESS.test(holder.address)
      || typeof holder.amountWei !== "string" || !WEI.test(holder.amountWei) || BigInt(holder.amountWei) === 0n) {
      problems.push(`holder ${isRecord(holder) ? String(holder.address) : "?"} is malformed`);
      continue;
    }
    if (holdersByAddress.has(holder.address)) {
      problems.push(`holder ${holder.address} is listed twice`);
      continue;
    }
    let entry: HivraAirdropHolder;
    if (holder.remapped === true) {
      // A managed wallet's batch would point at its owner's wallet: refuse a list that carries one.
      if (typeof holder.sent !== "boolean" || "batch" in holder || "sendTo" in holder || "send_to" in holder) {
        problems.push(`managed wallet ${holder.address} must carry only address, amountWei, remapped and sent`);
        continue;
      }
      entry = { address: holder.address, amountWei: holder.amountWei, remapped: true, sent: holder.sent };
    } else {
      if (holder.remapped !== undefined || !isPositiveInteger(holder.batch) || !batchIndexes.has(holder.batch)) {
        problems.push(`holder ${holder.address} names no valid batch`);
        continue;
      }
      entry = { address: holder.address, amountWei: holder.amountWei, batch: holder.batch };
      batchIndexes.set(holder.batch, (batchIndexes.get(holder.batch) ?? 0n) + BigInt(holder.amountWei));
    }
    includedWei += BigInt(holder.amountWei);
    holdersByAddress.set(holder.address, entry);
    holders.push(entry);
  }

  const excludedByAddress = new Map<string, string>();
  const excluded: HivraAirdropData["excluded"] = [];
  if (!Array.isArray(raw.excluded)) problems.push("excluded must be a list");
  else for (const item of raw.excluded) {
    if (!isRecord(item) || typeof item.address !== "string" || !ADDRESS.test(item.address)
      || typeof item.label !== "string" || !item.label.trim()) {
      problems.push("an excluded entry is malformed");
      continue;
    }
    if (holdersByAddress.has(item.address) || excludedByAddress.has(item.address)) {
      problems.push(`excluded wallet ${item.address} is listed twice`);
      continue;
    }
    excludedByAddress.set(item.address, item.label.trim());
    excluded.push({ address: item.address, label: item.label.trim() });
  }

  if (totals && problems.length === 0) {
    if (totals.holders !== holders.length) problems.push("totals.holders does not match the holder list");
    if (BigInt(totals.includedWei as string) !== includedWei) problems.push("totals.includedWei does not match the holder amounts");
    const batchSum = batches.reduce((sum, batch) => sum + BigInt(batch.totalWei), 0n);
    if (batchSum !== includedWei) problems.push("the batch totals do not add up to the included total");
    for (const batch of batches) {
      // Ordinary holders alone may not exceed a batch: the rest are managed wallets.
      if ((batchIndexes.get(batch.index) ?? 0n) > BigInt(batch.totalWei)) problems.push(`batch ${batch.index} holds more than its total`);
    }
  }

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    airdrop: {
      data: {
        version: HIVRA_AIRDROP_DATA_VERSION,
        snapshotBlock: raw.snapshotBlock as number,
        totals: { holders: holders.length, includedWei: includedWei.toString(), percentOfSupply: totals!.percentOfSupply as string },
        batches,
        holders,
        excluded,
      },
      holdersByAddress,
      excludedByAddress,
    },
  };
}

export type AirdropLookupResult =
  | { kind: "invalid" }
  | { kind: "holder"; address: string; amountWei: string; sentTx: string | null }
  | { kind: "managed"; address: string; amountWei: string; sent: boolean }
  | { kind: "excluded"; address: string; label: string }
  | { kind: "absent"; address: string };

/** The lower-cased address a viewer pasted, or null when it is not one. */
export function normalizeLookupAddress(input: string): string | null {
  const value = input.trim();
  return ANY_CASE_ADDRESS.test(value) ? value.toLowerCase() : null;
}

export function lookupHivraAirdrop(airdrop: ParsedHivraAirdrop, input: string): AirdropLookupResult {
  const address = normalizeLookupAddress(input);
  if (!address) return { kind: "invalid" };
  const holder = airdrop.holdersByAddress.get(address);
  if (holder?.remapped) return { kind: "managed", address, amountWei: holder.amountWei, sent: holder.sent };
  if (holder) {
    const sentTx = airdrop.data.batches[holder.batch - 1]?.tx ?? null;
    return { kind: "holder", address, amountWei: holder.amountWei, sentTx };
  }
  const label = airdrop.excludedByAddress.get(address);
  if (label) return { kind: "excluded", address, label };
  return { kind: "absent", address };
}

/** "1,234.5" from wei, exact to the last wei, with thousands separators. */
export function formatHivraAmount(wei: string): string {
  const value = BigInt(wei);
  const whole = (value / WEI_PER_TOKEN).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = (value % WEI_PER_TOKEN).toString().padStart(DECIMALS, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}
