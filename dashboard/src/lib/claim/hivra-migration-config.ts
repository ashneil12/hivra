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
 *   - the snapshot block, the time it was taken and the published list come from
 *     HIVRA_AIRDROP in hivra-airdrop-config.ts;
 *   - the Sablier claim campaign link and the claim window (its close date is the
 *     bound for the founder's burn date below) come from HIVRA_AIRDROP.claim.
 *
 * Fields:
 *   published     false hides the page and every link to it.
 *   announcedAt   UTC instant the migration was announced, to the second,
 *                 e.g. "2026-10-20T16:00:00Z". The founder's no-sale period
 *                 counts from it.
 *   claimRecordsUrl  optional. Where anyone can check the claims that have been
 *                 made: the Sablier campaign's claim dashboard (https on exactly
 *                 app.sablier.com, like claim.campaignUrl) or the campaign
 *                 contract's page on BaseScan (https://basescan.org/address/0x...).
 *                 Shown as "Verified claim transactions or claim dashboard" once
 *                 the claim is open or closed, never before.
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
 *                                      it cannot be before the no-sale period ends. Once
 *                                      claim.closesAt is set, the LAST weekly sale
 *                                      (saleStart plus weeks - 1 whole weeks) must fall
 *                                      on the day after the claim window's last day;
 *                   saleDay            the weekday sales happen, e.g. "Wednesday";
 *                                      must match saleStart's weekday. Checked, but
 *                                      the page has no wording for it;
 *                   burnDate           UTC date or instant the unsold rest is burned.
 *                                      It must be after the last sale week and, once
 *                                      claim.closesAt is set, after the claim window
 *                                      closes (the final planned sale is the day after
 *                                      the window's last day, and the burn follows it);
 *                   burnAddress        where the unsold rest is sent.
 *   receipts      on-chain proof, one entry per transaction:
 *                   date    UTC date or instant of the transaction;
 *                   kind    claim | liquidity | founder-sale. A founder burn is
 *                           recorded as founder-sale (the page groups them as
 *                           "Founder sales and burn");
 *                   txHash  0x + 64 hex;
 *                   note    a short plain-English line, or null.
 *                 A group with no receipts shows nothing on the page.
 *                 Liquidity and founder transactions go in the receipts ledger
 *                 (lib/token-receipts/token-receipts-config.ts) instead: the page
 *                 adds them from there, so enter only claim receipts here.
 *
 * A set but invalid value is dropped and logged ("HIVRA migration config
 * rejected"), never rendered: a bad address, tx hash or date, or dates in the
 * wrong order (saleStart before the no-sale period ends or a last sale that is not
 * the day after the claim window's last day, burnDate before the last sale week or
 * not after the claim window closes, a receipt in the future or a founder sale
 * before saleStart). The page shows only the sections and lines whose data is
 * valid. Once the published airdrop list is open, the founder's wallet must be
 * one of its excluded wallets (and not a holder); if it is not, the whole founder
 * section is left out, because the page says his tokens receive no $HIVRA.
 *
 * The page copy is Ash's pack page 02-token-migration.md, applied verbatim in
 * components/token/MigrationView.tsx. It is token-facing and needs UK
 * financial-promotion / legal review before release.
 *
 * Client-safe: type-only imports.
 */
export type HivraMigrationReceiptKind = "claim" | "liquidity" | "founder-sale";

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
  /** Optional; see the header. Absent reads as null. */
  claimRecordsUrl?: string | null;
  treasurySafe: string | null;
  fee: HivraMigrationFee | null;
  founder: HivraMigrationFounder | null;
  receipts: readonly HivraMigrationReceipt[];
};

export const HIVRA_MIGRATION: HivraMigrationConfig = {
  published: true,
  announcedAt: "2026-10-28T05:00:00Z",
  claimRecordsUrl: "https://basescan.org/address/0x4131ab8F9797bB4887A72470B8AF48fBEc37522F",
  treasurySafe: "0x4aCDa6e26929acd34b45beDaEE2f7b8a418ce10C",
  fee: { totalPct: 1.58, protocolSharePct: 5, liquiditySharePct: 20 },
  founder: {
    wallet: "0x672b58b6d10413fe69ab0907db5b17712bd45f7a",
    heldTokens: "11.34B",
    migrated: false,
    headStartDays: 14,
    weeklyCapTokens: "500M",
    maxPriceImpactPct: 5,
    weeks: 12,
    saleStart: "2026-11-12",
    saleDay: "Thursday",
    burnDate: "2027-01-29",
    burnAddress: "0x000000000000000000000000000000000000dEaD",
  },
  receipts: [],
};
