/**
 * The public $HIVRA claim list and the wallet lookup on /token/airdrop.
 *
 * The list is written by scripts/token/build-hivra-airdrop.mjs from the
 * $HermesOS snapshot and committed as src/data/token/hivra-airdrop.json. It
 * holds snapshot addresses and amounts only: a Hivra-managed wallet is flagged
 * `remapped` with no destination, and no user id or email is ever in it. A list
 * that fails any check here is treated as absent, so the lookup stays hidden
 * rather than showing a wrong amount.
 *
 * Eligible holders start the claim themselves on Sablier, so the list carries
 * no "sent" state: nothing is pushed to a wallet, and the app cannot tell
 * whether a wallet has claimed. `final` is true only when the generator was run
 * with --final on the verified snapshot; until then the counts in `totals` are
 * dry-run figures and the page must not show them.
 *
 * Every amount is wei as a decimal string, handled with BigInt only.
 *
 * Client-safe: type-only imports.
 */
import type { HivraClaimPhase } from "./hivra-claim";

export const HIVRA_AIRDROP_DATA_VERSION = 2;
const DECIMALS = 18;
const WEI_PER_TOKEN = 10n ** BigInt(DECIMALS);
const ADDRESS = /^0x[0-9a-f]{40}$/;
const ANY_CASE_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const WEI = /^\d+$/;

export type HivraAirdropHolder = { address: string; amountWei: string; remapped?: true };

export type HivraAirdropData = {
  version: typeof HIVRA_AIRDROP_DATA_VERSION;
  /** True only for the verified final list; counts may be shown only then. */
  final: boolean;
  snapshotBlock: number;
  totals: { holders: number; includedWei: string; percentOfSupply: string };
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
 * that is not whole wei, a field a holder should not carry, totals that do not
 * add up exactly) rejects the whole list.
 */
export function parseHivraAirdropData(raw: unknown): AirdropParseResult {
  const problems: string[] = [];
  if (!isRecord(raw)) return { ok: false, problems: ["the airdrop list is not a JSON object"] };
  if (raw.version !== HIVRA_AIRDROP_DATA_VERSION) problems.push(`version must be ${HIVRA_AIRDROP_DATA_VERSION}`);
  if (!isPositiveInteger(raw.snapshotBlock)) problems.push("snapshotBlock must be a positive whole block number");
  if (raw.decimals !== DECIMALS) problems.push(`decimals must be ${DECIMALS}`);
  // Absent means "not final", the safe reading; anything but a boolean is a malformed list.
  if (raw.final !== undefined && typeof raw.final !== "boolean") problems.push("final must be true or false");
  if ("batches" in raw) problems.push("the list still carries Disperse batches; rebuild it with the claim generator");
  const totals = isRecord(raw.totals) ? raw.totals : null;
  if (!totals || !isPositiveInteger(totals.holders) || typeof totals.includedWei !== "string" || !WEI.test(totals.includedWei)
    || typeof totals.percentOfSupply !== "string" || !/^\d+\.\d{2}$/.test(totals.percentOfSupply)) {
    problems.push("totals must give holders, includedWei and percentOfSupply");
  }

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
    // A holder carries an address, an amount and, for a managed wallet, remapped: true. Nothing
    // else: not a destination (it would point at the owner's wallet), a batch or a sent flag.
    const extra = Object.keys(holder).filter((key) => key !== "address" && key !== "amountWei" && key !== "remapped");
    if (extra.length > 0 || (holder.remapped !== undefined && holder.remapped !== true)) {
      problems.push(`holder ${holder.address} must carry only address, amountWei and, for a Hivra-managed wallet, remapped: true`);
      continue;
    }
    const entry: HivraAirdropHolder = holder.remapped === true
      ? { address: holder.address, amountWei: holder.amountWei, remapped: true }
      : { address: holder.address, amountWei: holder.amountWei };
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
  }

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    airdrop: {
      data: {
        version: HIVRA_AIRDROP_DATA_VERSION,
        final: raw.final === true,
        snapshotBlock: raw.snapshotBlock as number,
        totals: { holders: holders.length, includedWei: includedWei.toString(), percentOfSupply: totals!.percentOfSupply as string },
        holders,
        excluded,
      },
      holdersByAddress,
      excludedByAddress,
    },
  };
}

/**
 * What a lookup can say. There is deliberately no "claimed" or "unable to
 * verify": the app reads a published list and a configured claim window, and
 * cannot see Sablier's on-chain claims.
 */
export type AirdropLookupResult =
  | { kind: "invalid" }
  | { kind: "holder"; address: string; amountWei: string }
  | { kind: "managed"; address: string; amountWei: string }
  | { kind: "excluded"; address: string; label: string }
  | { kind: "absent"; address: string };

/** The state words the page shows, as written in Ash's pack (03-token-airdrop.md). */
export const CLAIM_STATE_LABELS = {
  eligible: "Eligible",
  notEligible: "Not eligible",
  notYetOpen: "Claim not yet open",
  available: "Available to claim",
  closed: "Claim window closed",
} as const;

/**
 * The claim state for an eligible wallet: from the claim window alone. No
 * campaign link yet reads as "not yet open"; "available" means the window is
 * open, not that this wallet has not already claimed.
 */
export function claimStateLabel(phase: HivraClaimPhase): string {
  switch (phase) {
    case "open":
      return CLAIM_STATE_LABELS.available;
    case "closed":
      return CLAIM_STATE_LABELS.closed;
    case "not_open":
    case "unpublished":
      return CLAIM_STATE_LABELS.notYetOpen;
  }
}

/** The lower-cased address a viewer pasted, or null when it is not one. */
export function normalizeLookupAddress(input: string): string | null {
  const value = input.trim();
  return ANY_CASE_ADDRESS.test(value) ? value.toLowerCase() : null;
}

export function lookupHivraAirdrop(airdrop: ParsedHivraAirdrop, input: string): AirdropLookupResult {
  const address = normalizeLookupAddress(input);
  if (!address) return { kind: "invalid" };
  const holder = airdrop.holdersByAddress.get(address);
  if (holder?.remapped) return { kind: "managed", address, amountWei: holder.amountWei };
  if (holder) return { kind: "holder", address, amountWei: holder.amountWei };
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

/** "52,826,055" for a whole number such as a block or a wallet count. */
export function formatWholeNumber(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
