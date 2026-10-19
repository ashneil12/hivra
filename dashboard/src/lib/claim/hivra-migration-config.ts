/**
 * The public $HermesOS → $HIVRA migration page (/token/migration).
 *
 * Everything the page says that is not already in another config lives here,
 * and each value goes in by a reviewed pull request once it is true, never at
 * runtime. The page is a 404 until ALL of these hold (getServedHivraMigration
 * in hivra-migration.ts, which the links on /token and /dashboard/convert use
 * too):
 *   1. HIVRA_NEW_TOKEN_SURFACES is on;
 *   2. $HIVRA's launch block is filled in (lib/billing/hivra-token-launch.ts);
 *   3. `published` below is true.
 *
 * Reused, not repeated here:
 *   - the $HIVRA contract comes only from the token registry;
 *   - the snapshot block (and published list) comes from HIVRA_AIRDROP in
 *     hivra-airdrop-config.ts.
 *
 * Fields:
 *   published     false hides the page and every link to it.
 *   announcedAt   UTC instant the migration was announced, to the second,
 *                 e.g. "2026-10-21T16:00:00Z". The founder's no-sale period
 *                 counts from it.
 *   treasurySafe  the Safe that receives Hivra's share of the $HIVRA pool's
 *                 trading fees (EIP-55 checksummed or all lowercase).
 *   fee           the $HIVRA pool's trading fee and how it is split:
 *                   totalPct           the pool fee, as a percentage of each trade;
 *                   protocolSharePct   the share of fees Doppler keeps;
 *                   liquiditySharePct  the share of what the Safe receives that is
 *                                      added to the pool's liquidity each week and locked.
 *   founder       the founder's legacy $HermesOS and the planned sale rules:
 *                   wallet             the founder's wallet;
 *                   heldTokens         his $HermesOS, written like "11.34B";
 *                   migrated           false: his $HermesOS get no $HIVRA. The page
 *                                      has wording only for false;
 *                   headStartDays      days after announcedAt with no founder sale;
 *                   weeklyCapTokens    most $HermesOS sold in one week, like "500M";
 *                   maxPriceImpactPct  most one sale may move the pool, in percent;
 *                   weeks              how many weeks the sales run;
 *                   saleStart          UTC date ("2026-11-04") or instant of the first sale;
 *                   saleDay            the weekday sales happen, e.g. "Wednesday";
 *                                      must match saleStart's weekday;
 *                   burnDate           UTC date or instant the unsold rest is burned;
 *                   burnAddress        where the unsold rest is sent.
 *   receipts      on-chain proof, one entry per transaction:
 *                   date    UTC date or instant of the transaction;
 *                   kind    liquidity | founder-sale | burn | airdrop-batch;
 *                   txHash  0x + 64 hex;
 *                   note    a short plain-English line, or null.
 *
 * A set but invalid value is dropped and logged ("HIVRA migration config
 * rejected"), never rendered: a bad address, tx hash or date, or dates in the
 * wrong order (saleStart before the no-sale period ends, burnDate before the
 * last sale week, a receipt in the future or a founder sale or burn before
 * saleStart). The page shows only the sections whose data is valid.
 *
 * The page copy is token-facing and needs UK financial-promotion / legal
 * review before release.
 *
 * Client-safe: type-only imports.
 */
export type HivraMigrationReceiptKind = "liquidity" | "founder-sale" | "burn" | "airdrop-batch";

export type HivraMigrationReceipt = {
  date: string;
  kind: HivraMigrationReceiptKind;
  txHash: string;
  note: string | null;
};

export type HivraMigrationFee = {
  totalPct: number;
  protocolSharePct: number;
  liquiditySharePct: number;
};

export type HivraMigrationFounder = {
  wallet: string | null;
  heldTokens: string | null;
  migrated: boolean;
  headStartDays: number | null;
  weeklyCapTokens: string | null;
  maxPriceImpactPct: number | null;
  weeks: number | null;
  saleStart: string | null;
  saleDay: string | null;
  burnDate: string | null;
  burnAddress: string | null;
};

export type HivraMigrationConfig = {
  published: boolean;
  announcedAt: string | null;
  treasurySafe: string | null;
  fee: HivraMigrationFee | null;
  founder: HivraMigrationFounder | null;
  receipts: readonly HivraMigrationReceipt[];
};

export const HIVRA_MIGRATION: HivraMigrationConfig = {
  published: false,
  announcedAt: null,
  treasurySafe: "0x4aCDa6e26929acd34b45beDaEE2f7b8a418ce10C",
  fee: { totalPct: 1.58, protocolSharePct: 5, liquiditySharePct: 20 },
  founder: {
    wallet: "0x672b58b6d10413fe69ab0907db5b17712bd45f7a",
    heldTokens: "11.34B",
    migrated: false,
    headStartDays: 14,
    weeklyCapTokens: "500M",
    maxPriceImpactPct: 5,
    weeks: 13,
    saleStart: null,
    saleDay: null,
    burnDate: null,
    burnAddress: "0x000000000000000000000000000000000000dEaD",
  },
  receipts: [],
};
