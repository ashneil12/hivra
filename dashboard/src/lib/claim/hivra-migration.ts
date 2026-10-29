/**
 * Whether /token/migration is served, and the checked facts it shows.
 *
 * One readiness check (getServedHivraMigration) decides the page's 404 and the
 * links to it on /token and /dashboard/convert, so a link never points at a
 * 404. Served only when ALL of these hold:
 *   1. HIVRA_NEW_TOKEN_SURFACES is on;
 *   2. $HIVRA's launch block is filled in (phase scheduled or active);
 *   3. HIVRA_MIGRATION.published is true.
 * The caller still asks the token geo gate: a blocked viewer gets the notice on
 * the page and no link anywhere.
 *
 * Every other field is checked here (validateHivraMigrationConfig). An invalid
 * value is dropped and logged, never rendered, and the page leaves out the
 * section or line that needed it. Once the airdrop list is open, the founder's
 * wallet must be one of its excluded wallets: the page says his $HermesOS get
 * no $HIVRA, so if the list says otherwise the founder section is left out.
 */
import "server-only";

import {
  HERMESOS_TOKEN,
  getConfiguredHivraToken,
  getHivraTokenPhase,
  type PlatformToken,
} from "@/lib/billing/token-registry";
import { log } from "@/lib/logger";
import { newTokenSurfacesEnabled } from "@/lib/token-surfaces";

import { readEip55Address } from "./eip55";
import { HIVRA_AIRDROP, type HivraAirdropConfig } from "./hivra-airdrop-config";
import { getOpenHivraAirdrop } from "./hivra-airdrop-data";
import { lookupHivraAirdrop } from "./hivra-airdrop-lookup";
import { resolveAirdropFacts, type AirdropSnapshot } from "./conversion-state";
import { NO_CLAIM, readSablierCampaignUrl, readUtcInstant, type ResolvedHivraClaim } from "./hivra-claim";
import { TOKEN_RECEIPTS, type TokenReceiptEntry, type TokenReceiptKind } from "@/lib/token-receipts/token-receipts-config";

import {
  HIVRA_MIGRATION,
  type HivraMigrationConfig,
  type HivraMigrationFee,
  type HivraMigrationReceipt,
  type HivraMigrationReceiptKind,
} from "./hivra-migration-config";

export const HIVRA_MIGRATION_PATH = "/token/migration";

export const RECEIPT_KINDS: readonly HivraMigrationReceiptKind[] = ["claim", "liquidity", "founder-sale"];
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
// A BaseScan page for the campaign contract or one claim transaction: no query, fragment or other path.
const BASESCAN_CLAIM_RECORDS = /^https:\/\/basescan\.org\/(?:address\/0x[0-9a-fA-F]{40}|tx\/0x[0-9a-fA-F]{64})$/;
const ZERO_ADDRESS = /^0x0{40}$/i;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const UTC_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TOKEN_COUNT = /^(\d{1,3}(?:\.\d{1,2})?)([KMB])$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_NOTE_LENGTH = 280;

/** A checked UTC date. `dateOnly` when the config gave a day, not an instant. */
export type MigrationDate = { iso: string; dateOnly: boolean };

export type ResolvedMigrationFounder = {
  /** EIP-55 checksummed. */
  wallet: string | null;
  /** In words, e.g. "11.34 billion". */
  heldTokens: string | null;
  headStartDays: number | null;
  weeklyCapTokens: string | null;
  maxPriceImpactPct: number | null;
  weeks: number | null;
  saleStart: MigrationDate | null;
  saleDay: string | null;
  burnDate: MigrationDate | null;
  /** EIP-55 checksummed. */
  burnAddress: string | null;
};

export type ResolvedMigrationReceipt = {
  date: MigrationDate;
  kind: HivraMigrationReceiptKind;
  txHash: string;
  note: string | null;
};

export type ValidatedHivraMigration = {
  announcedAt: MigrationDate | null;
  /** Where the claims made so far can be checked: https on app.sablier.com, or a BaseScan address or transaction page. */
  claimRecordsUrl: string | null;
  /** EIP-55 checksummed. */
  treasurySafe: string | null;
  fee: HivraMigrationFee | null;
  /** Null when the founder facts are missing or `migrated` is not false. */
  founder: ResolvedMigrationFounder | null;
  /** Newest first. */
  receipts: ResolvedMigrationReceipt[];
};

export type ServedHivraMigration = ValidatedHivraMigration & {
  /** $HIVRA exactly as published in the token registry. */
  hivraAddress: string;
  /** $HermesOS exactly as published. */
  hermesosAddress: string;
  /** From the airdrop config: shown only once block and list are both published. */
  snapshot: AirdropSnapshot | null;
  /** The Sablier claim at the time of the request (hivra-claim.ts); phase "unpublished" when there is no valid campaign link. */
  claim: ResolvedHivraClaim;
};

/** A real UTC date ("2026-11-04") or instant to the second, else null. */
export function readMigrationDate(value: string | null | undefined): (MigrationDate & { ms: number }) | null {
  const text = typeof value === "string" ? value.trim() : "";
  const dateOnly = UTC_DATE.test(text);
  if (!dateOnly && !UTC_INSTANT.test(text)) return null;
  const ms = Date.parse(dateOnly ? `${text}T00:00:00Z` : text);
  if (!Number.isFinite(ms)) return null;
  const iso = new Date(ms).toISOString();
  // Date.parse rolls impossible dates over (2026-02-30 → 2026-03-02); refuse them.
  if (iso.slice(0, text.length > 10 ? 19 : 10) !== text.slice(0, text.length > 10 ? 19 : 10)) return null;
  return { iso, dateOnly, ms };
}

function publicDate(date: (MigrationDate & { ms: number }) | null): MigrationDate | null {
  return date ? { iso: date.iso, dateOnly: date.dateOnly } : null;
}

/** EIP-55: all lowercase, or mixed case with a valid checksum. Returns the checksummed form. */
function readAddress(value: string | null | undefined, hivraAddress: string | null): string | null | "invalid" {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  const checksummed = readEip55Address(text);
  if (!checksummed || ZERO_ADDRESS.test(text)) return "invalid";
  const lower = text.toLowerCase();
  if (lower === HERMESOS_TOKEN.address || (hivraAddress && lower === hivraAddress.toLowerCase())) return "invalid";
  return checksummed;
}

/** The claim-records link: a plain Sablier link (as the campaign link) or a BaseScan address or transaction page, else null. */
export function readClaimRecordsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return readSablierCampaignUrl(value) ?? (BASESCAN_CLAIM_RECORDS.test(value) ? value : null);
}

const UNIT_WORDS = { K: "thousand", M: "million", B: "billion" } as const;

/** "11.34B" → "11.34 billion". Anything else is rejected. */
export function formatTokenCount(value: string | null | undefined): string | null {
  const match = typeof value === "string" ? TOKEN_COUNT.exec(value.trim()) : null;
  if (!match) return null;
  return `${match[1]} ${UNIT_WORDS[match[2] as keyof typeof UNIT_WORDS]}`;
}

function isPct(value: unknown, { allowZero = false, allowHundred = false } = {}): value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (allowZero ? value < 0 : value <= 0) return false;
  return allowHundred ? value <= 100 : value < 100;
}

function isWholeInRange(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max;
}

/**
 * Checks every field of the migration config. Anything set but invalid, or out
 * of date order, is left out and named in `problems`.
 */
export function validateHivraMigrationConfig(
  config: HivraMigrationConfig,
  { hivraAddress, now, claimClosesAt = null }: {
    hivraAddress: string | null;
    now: Date;
    /** HIVRA_AIRDROP.claim.closesAt as configured (a UTC instant to the second), or null. A value that is not one is ignored here; the airdrop config reports it. */
    claimClosesAt?: string | null;
  },
): { migration: ValidatedHivraMigration; problems: string[] } {
  const problems: string[] = [];
  const nowMs = now.getTime();
  const claimClosesMs = typeof claimClosesAt === "string" ? readUtcInstant(claimClosesAt) : null;

  let announced = config.announcedAt ? readMigrationDate(config.announcedAt) : null;
  if (config.announcedAt && (!announced || announced.dateOnly)) {
    problems.push("announcedAt must be a real UTC instant to the second, e.g. 2026-10-21T16:00:00Z");
    announced = null;
  } else if (announced && announced.ms > nowMs) {
    problems.push("announcedAt is in the future");
    announced = null;
  }

  let claimRecordsUrl: string | null = null;
  if (config.claimRecordsUrl !== undefined && config.claimRecordsUrl !== null) {
    claimRecordsUrl = readClaimRecordsUrl(config.claimRecordsUrl);
    if (claimRecordsUrl === null) problems.push("claimRecordsUrl must be a plain https link on app.sablier.com or a BaseScan address or transaction page");
  }

  let treasurySafe: string | null = null;
  const safe = readAddress(config.treasurySafe, hivraAddress);
  if (safe === "invalid") problems.push("treasurySafe must be a non-zero EIP-55 address that is not a token contract");
  else treasurySafe = safe;

  let fee: HivraMigrationFee | null = null;
  if (config.fee) {
    const { totalPct, protocolSharePct, liquiditySharePct } = config.fee;
    if (isPct(totalPct) && isPct(protocolSharePct, { allowZero: true }) && isPct(liquiditySharePct, { allowHundred: true })) {
      fee = { totalPct, protocolSharePct, liquiditySharePct };
    } else {
      problems.push("fee percentages must be numbers: totalPct and protocolSharePct below 100, liquiditySharePct up to 100");
    }
  }

  let founder: ResolvedMigrationFounder | null = null;
  let saleStartMs: number | null = null;
  const f = config.founder;
  if (f && f.migrated !== false) {
    problems.push("founder.migrated is not false; the page has wording only for unmigrated founder tokens");
  } else if (f) {
    const field = <T,>(name: string, set: boolean, value: T | null): T | null => {
      if (set && value === null) problems.push(`founder.${name} is invalid`);
      return value;
    };
    const wallet = readAddress(f.wallet, hivraAddress);
    const burn = readAddress(f.burnAddress, hivraAddress);
    const headStartDays = field("headStartDays", f.headStartDays !== null, isWholeInRange(f.headStartDays, 365) ? f.headStartDays : null);
    const weeks = field("weeks", f.weeks !== null, isWholeInRange(f.weeks, 104) ? f.weeks : null);

    let saleStart = f.saleStart ? readMigrationDate(f.saleStart) : null;
    if (f.saleStart && !saleStart) problems.push("founder.saleStart must be a real UTC date or instant");
    if (saleStart && announced) {
      const earliest = announced.ms + (headStartDays ?? 0) * DAY_MS;
      if (saleStart.ms < earliest) {
        problems.push("founder.saleStart is before the no-sale period after announcedAt ends");
        saleStart = null;
      }
    }

    // The final planned sale is the day after the claim window's last day (the window ends at
    // claim.closesAt, so its last day is the day of the last second before it).
    if (saleStart && weeks !== null && claimClosesMs !== null) {
      const dayStart = (ms: number) => ms - (ms % DAY_MS);
      const lastSaleDay = dayStart(saleStart.ms + (weeks - 1) * 7 * DAY_MS);
      const dayAfterClaims = dayStart(claimClosesMs - 1000) + DAY_MS;
      if (lastSaleDay !== dayAfterClaims) {
        problems.push("founder.saleStart plus weeks - 1 whole weeks (the last sale) is not the day after the claim window's last day");
        saleStart = null;
      }
    }

    let saleDay = f.saleDay ? (WEEKDAYS as readonly string[]).includes(f.saleDay) ? f.saleDay : null : null;
    if (f.saleDay && !saleDay) problems.push("founder.saleDay must be a weekday name, e.g. Wednesday");
    if (saleDay && saleStart && WEEKDAYS[new Date(saleStart.ms).getUTCDay()] !== saleDay) {
      problems.push("founder.saleDay does not match saleStart's weekday");
      saleDay = null;
    }

    let burnDate = f.burnDate ? readMigrationDate(f.burnDate) : null;
    if (f.burnDate && !burnDate) problems.push("founder.burnDate must be a real UTC date or instant");
    if (burnDate) {
      const lastSaleMs = saleStart ? saleStart.ms + ((weeks ?? 1) - 1) * 7 * DAY_MS : announced?.ms ?? null;
      if (lastSaleMs !== null && burnDate.ms <= lastSaleMs) {
        problems.push("founder.burnDate is not after the last sale week");
        burnDate = null;
      }
    }
    // The final planned sale is the day after the claim window's last day, and the burn follows it.
    if (burnDate && claimClosesMs !== null && burnDate.ms <= claimClosesMs) {
      problems.push("founder.burnDate is not after claim.closesAt");
      burnDate = null;
    }

    saleStartMs = saleStart?.ms ?? null;
    founder = {
      wallet: wallet === "invalid" ? field<string>("wallet", true, null) : wallet,
      heldTokens: field("heldTokens", f.heldTokens !== null, formatTokenCount(f.heldTokens)),
      headStartDays,
      weeklyCapTokens: field("weeklyCapTokens", f.weeklyCapTokens !== null, formatTokenCount(f.weeklyCapTokens)),
      maxPriceImpactPct: field("maxPriceImpactPct", f.maxPriceImpactPct !== null, isPct(f.maxPriceImpactPct) ? f.maxPriceImpactPct : null),
      weeks,
      saleStart: publicDate(saleStart),
      saleDay,
      burnDate: publicDate(burnDate),
      burnAddress: burn === "invalid" ? field<string>("burnAddress", true, null) : burn,
    };
  }

  const receipts: (ResolvedMigrationReceipt & { ms: number })[] = [];
  const seen = new Set<string>();
  (Array.isArray(config.receipts) ? config.receipts : []).forEach((receipt, index) => {
    const where = `receipts[${index}]`;
    const date = readMigrationDate(receipt?.date);
    if (!date) return void problems.push(`${where}.date must be a real UTC date or instant`);
    if (!RECEIPT_KINDS.includes(receipt.kind)) return void problems.push(`${where}.kind is not one of ${RECEIPT_KINDS.join(", ")}`);
    if (typeof receipt.txHash !== "string" || !TX_HASH.test(receipt.txHash.trim())) {
      return void problems.push(`${where}.txHash must be 0x followed by 64 hex characters`);
    }
    if (date.ms > nowMs) return void problems.push(`${where}.date is in the future`);
    // Compared by UTC day, so a day-only receipt on the first sale day counts.
    if (receipt.kind === "founder-sale" && saleStartMs !== null && date.ms < saleStartMs - (saleStartMs % DAY_MS)) {
      return void problems.push(`${where} is a ${receipt.kind} dated before founder.saleStart`);
    }
    const note = receipt.note === null || receipt.note === undefined ? null : String(receipt.note).trim();
    if (note !== null && (note.length === 0 || note.length > MAX_NOTE_LENGTH)) {
      return void problems.push(`${where}.note must be null or 1 to ${MAX_NOTE_LENGTH} characters`);
    }
    const txHash = receipt.txHash.trim().toLowerCase();
    const key = `${receipt.kind}:${txHash}`;
    if (seen.has(key)) return void problems.push(`${where} repeats a ${receipt.kind} transaction`);
    seen.add(key);
    receipts.push({ date: publicDate(date) as MigrationDate, kind: receipt.kind, txHash, note, ms: date.ms });
  });
  receipts.sort((a, b) => b.ms - a.ms);

  return {
    migration: {
      announcedAt: publicDate(announced),
      claimRecordsUrl,
      treasurySafe,
      fee,
      founder,
      receipts: receipts.map(({ date, kind, txHash, note }) => ({ date, kind, txHash, note })),
    },
    problems,
  };
}

const LEDGER_GROUPS: Partial<Record<TokenReceiptKind, HivraMigrationReceiptKind>> = {
  "liquidity-add": "liquidity",
  "liquidity-lock": "liquidity",
  "founder-sale": "founder-sale",
  "founder-burn": "founder-sale",
};

/**
 * The liquidity and founder entries of the receipts ledger (TOKEN_RECEIPTS), as
 * this page's records, so a transaction is entered once and shows on both pages.
 * An addition and a lock in one transaction show once, as the lock. A lock or a
 * burn without a note gets one, because each shares its group with other kinds.
 * Fee claims have no group on this page and stay on /token/receipts.
 */
export function migrationReceiptsFromLedger(ledger: readonly TokenReceiptEntry[]): HivraMigrationReceipt[] {
  const byKey = new Map<string, HivraMigrationReceipt>();
  const entries: readonly TokenReceiptEntry[] = Array.isArray(ledger) ? ledger : [];
  for (const entry of entries) {
    const kind = entry ? LEDGER_GROUPS[entry.kind] : undefined;
    if (!kind || typeof entry.txHash !== "string") continue;
    const key = `${kind}:${entry.txHash.trim().toLowerCase()}`;
    const fallback = entry.kind === "liquidity-lock" && entry.lock?.locker
      ? `Liquidity locked with ${entry.lock.locker}`
      : entry.kind === "founder-burn" ? "Remaining founder $HermesOS sent to the burn address" : null;
    const receipt = { date: entry.date, kind, txHash: entry.txHash, note: entry.note ?? fallback };
    if (!byKey.has(key) || entry.kind === "liquidity-lock") byKey.set(key, receipt);
  }
  return [...byKey.values()];
}

export type HivraMigrationInputs = {
  /** Test seams; default to process.env, the clock, the registry and the committed configs. */
  env?: Record<string, string | undefined>;
  now?: Date;
  hivra?: PlatformToken | null;
  config?: HivraMigrationConfig;
  airdrop?: HivraAirdropConfig;
  /** The committed airdrop list (null, or the parsed-JSON shape); defaults to src/data/token/hivra-airdrop.json. */
  airdropList?: unknown;
  /** The receipts ledger; defaults to TOKEN_RECEIPTS. */
  ledger?: readonly TokenReceiptEntry[];
};

const reported = new Set<string>();

function reportOnce(problems: string[]) {
  const key = problems.join("; ");
  if (reported.has(key)) return;
  if (reported.size > 50) reported.clear();
  reported.add(key);
  log.warn("HIVRA migration config rejected", {
    source: "claim/hivra-migration",
    failureType: "hivra_migration_config_rejected",
    problems: problems.slice(0, 20).join("; "),
  });
}

/**
 * The page says the founder's $HermesOS are excluded from the allocation. Once
 * the published list is open, hold it to that: the founder's wallet must be one of
 * its excluded wallets. A holder, a Hivra-managed wallet or a wallet the list does
 * not mention would make the sentence untrue, so the founder section is left out
 * (and the reason logged) instead of printing it. Before the list is open there is
 * nothing to check against.
 */
function checkFounderWalletIsExcluded(
  migration: ValidatedHivraMigration,
  problems: string[],
  list: Parameters<typeof getOpenHivraAirdrop>[0],
) {
  const wallet = migration.founder?.wallet;
  if (!wallet) return;
  const open = getOpenHivraAirdrop(list);
  if (!open) return;
  const found = lookupHivraAirdrop(open.airdrop, wallet);
  if (found.kind === "excluded") return;
  problems.push(`founder.wallet is not an excluded wallet in the published airdrop list (the list has it as: ${found.kind}); the founder section is left out`);
  migration.founder = null;
}

/**
 * The page's data when /token/migration is served (see the top of this file),
 * else null. The page 404s on null, and /token and /dashboard/convert link to
 * it only when this is not null.
 */
export function getServedHivraMigration(inputs: HivraMigrationInputs = {}): ServedHivraMigration | null {
  if (!newTokenSurfacesEnabled(inputs.env)) return null;
  const now = inputs.now ?? new Date();
  const hivra = inputs.hivra !== undefined
    ? inputs.hivra
    : getHivraTokenPhase(now) === "dormant" ? null : getConfiguredHivraToken();
  if (!hivra) return null;
  const config = inputs.config ?? HIVRA_MIGRATION;
  if (config.published !== true) return null;

  const airdrop = inputs.airdrop ?? HIVRA_AIRDROP;
  const ledgerReceipts = migrationReceiptsFromLedger(inputs.ledger ?? TOKEN_RECEIPTS);
  const withLedger = ledgerReceipts.length > 0 ? { ...config, receipts: [...(Array.isArray(config.receipts) ? config.receipts : []), ...ledgerReceipts] } : config;
  const { migration, problems } = validateHivraMigrationConfig(withLedger, {
    hivraAddress: hivra.address,
    now,
    claimClosesAt: airdrop.claim?.closesAt ?? null,
  });
  // `now` is passed so a snapshotTakenAt in the future is dropped and the claim phase is read; this page renders on the server.
  const { snapshot, claim } = resolveAirdropFacts(airdrop, hivra.address, now);
  checkFounderWalletIsExcluded(migration, problems, {
    now,
    hivraAddress: hivra.address,
    config: airdrop,
    ...("airdropList" in inputs ? { raw: inputs.airdropList } : {}),
  });
  if (problems.length > 0) reportOnce(problems);
  return {
    ...migration,
    hivraAddress: hivra.publishedAddress,
    hermesosAddress: HERMESOS_TOKEN.publishedAddress,
    snapshot,
    claim: claim ?? NO_CLAIM,
  };
}

/** The link for another page, or null when the page is not served. The caller passes null for a geo-blocked viewer. */
export function hivraMigrationHref(inputs: HivraMigrationInputs = {}): string | null {
  return getServedHivraMigration(inputs) ? HIVRA_MIGRATION_PATH : null;
}
