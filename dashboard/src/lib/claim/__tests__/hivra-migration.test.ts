/**
 * The /token/migration config checks and the one readiness check the page and
 * its links share.
 */
import { validateHivraLaunchConfig, type PlatformToken } from "@/lib/billing/token-registry";
import { log } from "@/lib/logger";

import {
  HIVRA_MIGRATION_PATH,
  formatTokenCount,
  getServedHivraMigration,
  hivraMigrationHref,
  validateHivraMigrationConfig,
} from "../hivra-migration";
import { HIVRA_MIGRATION, type HivraMigrationConfig } from "../hivra-migration-config";
import type { HivraAirdropConfig } from "../hivra-airdrop-config";

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

const HIVRA_ADDRESS = "0x1111111111111111111111111111111111111111";
const launch = validateHivraLaunchConfig({
  contractAddress: HIVRA_ADDRESS,
  decimals: 18,
  poolId: `0x${"ab".repeat(32)}`,
  activatesAt: "2026-01-01T00:00:00Z",
});
const HIVRA = (launch.status === "configured" ? launch.token : null) as PlatformToken;
const NOW = new Date("2026-12-01T00:00:00Z");
const ON = { HIVRA_NEW_TOKEN_SURFACES: "1" };
const HASH = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const AIRDROP: HivraAirdropConfig = {
  senderAddress: "0x3333333333333333333333333333333333333333",
  snapshotBlock: 36_000_000,
  snapshotUrl: "https://hivra.cloud/token/airdrop-snapshot",
  sentAt: null,
};

function config(overrides: Partial<HivraMigrationConfig> = {}): HivraMigrationConfig {
  return {
    ...HIVRA_MIGRATION,
    published: true,
    announcedAt: "2026-10-21T16:00:00Z",
    founder: {
      ...HIVRA_MIGRATION.founder!,
      // 21 Oct 16:00 UTC + 14 days ends during 4 Nov, so a whole-day start is 5 Nov 2026, a Thursday.
      saleStart: "2026-11-05",
      saleDay: "Thursday",
      burnDate: "2027-02-04",
    },
    ...overrides,
  };
}

function validate(c: HivraMigrationConfig) {
  return validateHivraMigrationConfig(c, { hivraAddress: HIVRA.address, now: NOW });
}

describe("committed config", () => {
  it("is unpublished, with no launch dates and no receipts", () => {
    expect(HIVRA_MIGRATION.published).toBe(false);
    expect(HIVRA_MIGRATION.announcedAt).toBeNull();
    expect(HIVRA_MIGRATION.founder?.saleStart).toBeNull();
    expect(HIVRA_MIGRATION.founder?.saleDay).toBeNull();
    expect(HIVRA_MIGRATION.founder?.burnDate).toBeNull();
    expect(HIVRA_MIGRATION.receipts).toEqual([]);
  });

  it("passes every check with its filled-in values", () => {
    const { migration, problems } = validateHivraMigrationConfig(HIVRA_MIGRATION, { hivraAddress: HIVRA.address, now: NOW });
    expect(problems).toEqual([]);
    expect(migration.treasurySafe).toBe("0x4aCDa6e26929acd34b45beDaEE2f7b8a418ce10C");
    expect(migration.fee).toEqual({ totalPct: 1.58, protocolSharePct: 5, liquiditySharePct: 20 });
    // The lowercase founder wallet is shown in its EIP-55 form.
    expect(migration.founder?.wallet).toBe("0x672b58B6d10413Fe69ab0907db5B17712BD45f7A");
    expect(migration.founder?.burnAddress).toBe("0x000000000000000000000000000000000000dEaD");
    expect(migration.founder?.heldTokens).toBe("11.34 billion");
    expect(migration.founder?.weeklyCapTokens).toBe("500 million");
  });
});

describe("validateHivraMigrationConfig", () => {
  it("accepts a full launch config in date order", () => {
    const { migration, problems } = validate(config({
      receipts: [
        { date: "2026-11-05", kind: "founder-sale", txHash: HASH(1), note: "Week 1 sale" },
        { date: "2026-11-10T12:00:00Z", kind: "liquidity", txHash: HASH(2), note: null },
      ],
    }));
    expect(problems).toEqual([]);
    expect(migration.founder?.saleStart).toEqual({ iso: "2026-11-05T00:00:00.000Z", dateOnly: true });
    expect(migration.founder?.saleDay).toBe("Thursday");
    expect(migration.receipts.map((receipt) => receipt.kind)).toEqual(["liquidity", "founder-sale"]);
  });

  it.each([
    ["a bad EIP-55 checksum", { treasurySafe: "0x4aCDa6e26929acd34b45beDaEE2f7b8a418ce10c" }],
    ["the zero address", { treasurySafe: `0x${"0".repeat(40)}` }],
    ["a token contract", { treasurySafe: HIVRA_ADDRESS }],
    ["a short address", { treasurySafe: "0x1234" }],
  ])("drops a treasury Safe with %s", (_why, overrides) => {
    const { migration, problems } = validate(config(overrides));
    expect(migration.treasurySafe).toBeNull();
    expect(problems.join()).toMatch(/treasurySafe/);
  });

  it("drops an invalid founder wallet or burn address but keeps the rest", () => {
    const founder = { ...config().founder!, wallet: "0x672B58B6D10413FE69AB0907DB5B17712BD45F7a", burnAddress: "dead" };
    const { migration, problems } = validate(config({ founder }));
    expect(migration.founder?.wallet).toBeNull();
    expect(migration.founder?.burnAddress).toBeNull();
    expect(migration.founder?.weeks).toBe(13);
    expect(problems).toEqual(expect.arrayContaining(["founder.wallet is invalid", "founder.burnAddress is invalid"]));
  });

  it("drops the founder section when the tokens are marked migrated", () => {
    const { migration, problems } = validate(config({ founder: { ...config().founder!, migrated: true } }));
    expect(migration.founder).toBeNull();
    expect(problems.join()).toMatch(/migrated/);
  });

  it("drops fee percentages out of range", () => {
    const { migration } = validate(config({ fee: { totalPct: 1.58, protocolSharePct: 120, liquiditySharePct: 20 } }));
    expect(migration.fee).toBeNull();
    expect(validate(config({ fee: { totalPct: Number.NaN, protocolSharePct: 5, liquiditySharePct: 20 } })).migration.fee).toBeNull();
  });

  it("drops dates that are impossible, local or in the future", () => {
    expect(validate(config({ announcedAt: "2026-10-21 16:00" })).migration.announcedAt).toBeNull();
    expect(validate(config({ announcedAt: "2026-02-30T00:00:00Z" })).migration.announcedAt).toBeNull();
    expect(validate(config({ announcedAt: "2027-01-01T00:00:00Z" })).problems).toContain("announcedAt is in the future");
    const founder = { ...config().founder!, burnDate: "2027-13-01" };
    expect(validate(config({ founder })).migration.founder?.burnDate).toBeNull();
  });

  it.each([
    ["a week in", "2026-10-28"],
    // A whole day counts from its start, which is before the period ends at 16:00 UTC.
    ["on its last day", "2026-11-04"],
  ])("drops a sale start inside the no-sale period (%s)", (_why, saleStart) => {
    const founder = { ...config().founder!, saleStart, saleDay: "Wednesday" };
    const { migration, problems } = validate(config({ founder }));
    expect(migration.founder?.saleStart).toBeNull();
    expect(problems).toContain("founder.saleStart is before the no-sale period after announcedAt ends");
  });

  it("drops a sale day that does not match the first sale", () => {
    const founder = { ...config().founder!, saleDay: "Friday" };
    expect(validate(config({ founder })).migration.founder?.saleDay).toBeNull();
    expect(validate(config({ founder: { ...founder, saleDay: "wed" } })).migration.founder?.saleDay).toBeNull();
  });

  it("drops a burn date before the last sale week", () => {
    // 13 weekly sales from 5 Nov 2026: the last is 28 Jan 2027.
    const founder = { ...config().founder!, burnDate: "2027-01-28" };
    const { migration, problems } = validate(config({ founder }));
    expect(migration.founder?.burnDate).toBeNull();
    expect(problems).toContain("founder.burnDate is not after the last sale week");
  });

  it("drops bad receipts and logs why, never rendering them", () => {
    const { migration, problems } = validate(config({
      receipts: [
        { date: "2026-11-20", kind: "liquidity", txHash: HASH(1), note: "Week 2" },
        { date: "2026-11-20", kind: "liquidity", txHash: "0x1234", note: null },
        { date: "2026-11-20", kind: "swap" as never, txHash: HASH(2), note: null },
        { date: "not a date", kind: "burn", txHash: HASH(3), note: null },
        { date: "2027-06-01", kind: "liquidity", txHash: HASH(4), note: null },
        { date: "2026-11-04T23:59:59Z", kind: "founder-sale", txHash: HASH(5), note: null },
        { date: "2026-11-21", kind: "liquidity", txHash: HASH(1), note: "again" },
        { date: "2026-11-22", kind: "airdrop-batch", txHash: HASH(6), note: "" },
      ],
    }));
    expect(migration.receipts).toEqual([{ date: { iso: "2026-11-20T00:00:00.000Z", dateOnly: true }, kind: "liquidity", txHash: HASH(1), note: "Week 2" }]);
    expect(problems).toHaveLength(7);
  });
});

describe("formatTokenCount", () => {
  it.each([["11.34B", "11.34 billion"], ["500M", "500 million"], ["2K", "2 thousand"], ["11.345B", null], ["lots", null], [null, null]])(
    "%s → %s",
    (input, expected) => expect(formatTokenCount(input)).toBe(expected),
  );
});

describe("getServedHivraMigration / hivraMigrationHref", () => {
  const ready = { env: ON, now: NOW, hivra: HIVRA, config: config(), airdrop: AIRDROP };

  it("is served, with the registry's $HIVRA and the airdrop snapshot, when everything is in place", () => {
    const served = getServedHivraMigration(ready);
    expect(served?.hivraAddress).toBe(HIVRA_ADDRESS);
    expect(served?.hermesosAddress).toBe("0x95ccfD2B81A9667b0Cc979992632F98fc853EBa3");
    expect(served?.snapshot).toEqual({ block: 36_000_000, url: "https://hivra.cloud/token/airdrop-snapshot" });
    expect(hivraMigrationHref(ready)).toBe(HIVRA_MIGRATION_PATH);
    expect(HIVRA_MIGRATION_PATH).toBe("/token/migration");
  });

  it.each([
    ["the new token surfaces are off", { ...ready, env: {} }],
    ["$HIVRA is dormant", { ...ready, hivra: null }],
    ["the page is not published", { ...ready, config: config({ published: false }) }],
  ])("is not served when %s", (_why, inputs) => {
    expect(getServedHivraMigration(inputs)).toBeNull();
    expect(hivraMigrationHref(inputs)).toBeNull();
  });

  it("is not served from the committed configs (dormant launch, unpublished page)", () => {
    expect(getServedHivraMigration({ env: ON })).toBeNull();
  });

  it("logs rejected values once", () => {
    const warn = jest.mocked(log.warn);
    warn.mockClear();
    const bad = { ...ready, config: config({ treasurySafe: "0xnope" }) };
    getServedHivraMigration(bad);
    getServedHivraMigration(bad);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("HIVRA migration config rejected", expect.objectContaining({ failureType: "hivra_migration_config_rejected" }));
  });
});
