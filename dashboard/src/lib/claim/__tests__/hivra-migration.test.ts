/**
 * The /token/migration config checks and the one readiness check the page and
 * its links share.
 */
import { validateHivraLaunchConfig, type PlatformToken } from "@/lib/billing/token-registry";
import { log } from "@/lib/logger";

import {
  HIVRA_MIGRATION_PATH,
  RECEIPT_KINDS,
  formatTokenCount,
  getServedHivraMigration,
  hivraMigrationHref,
  readClaimRecordsUrl,
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
  snapshotTakenAt: "2026-10-20T16:30:00Z",
  snapshotUrl: "https://hivra.cloud/token/airdrop-snapshot",
  claim: { campaignUrl: null, opensAt: null, closesAt: null },
};

function config(overrides: Partial<HivraMigrationConfig> = {}): HivraMigrationConfig {
  return {
    ...HIVRA_MIGRATION,
    published: true,
    announcedAt: "2026-10-21T16:00:00Z",
    founder: {
      ...HIVRA_MIGRATION.founder!,
      // These fixtures model a 13-week plan ending 28 Jan 2027; the shipped default plan is 12 weeks (see the 90-day test below).
      weeks: 13,
      // 21 Oct 16:00 UTC + 14 days ends during 4 Nov, so a whole-day start is 5 Nov 2026, a Thursday.
      saleStart: "2026-11-05",
      saleDay: "Thursday",
      burnDate: "2027-02-04",
    },
    ...overrides,
  };
}

function validate(c: HivraMigrationConfig, claimClosesAt: string | null = null) {
  return validateHivraMigrationConfig(c, { hivraAddress: HIVRA.address, now: NOW, claimClosesAt });
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
        { date: "2026-11-02", kind: "claim", txHash: HASH(3), note: "First claims" },
      ],
    }));
    expect(problems).toEqual([]);
    expect(migration.founder?.saleStart).toEqual({ iso: "2026-11-05T00:00:00.000Z", dateOnly: true });
    expect(migration.founder?.saleDay).toBe("Thursday");
    expect(migration.receipts.map((receipt) => receipt.kind)).toEqual(["liquidity", "founder-sale", "claim"]);
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

  describe("the founder's last sale against the claim window", () => {
    // 13 weekly sales from Thursday 5 Nov 2026 end on Thursday 28 Jan 2027: the day after the window's last day (27 Jan).
    it.each([
      ["a window that closes in the last second of its last day", "2027-01-27T23:59:59Z"],
      ["a window that closes at the start of the day after", "2027-01-28T00:00:00Z"],
      ["a window that closes at the start of its last day plus a second", "2027-01-27T00:00:01Z"],
    ])("keeps the sale start for %s", (_why, closesAt) => {
      const { migration, problems } = validate(config(), closesAt);
      expect(problems).toEqual([]);
      expect(migration.founder?.saleStart).toEqual({ iso: "2026-11-05T00:00:00.000Z", dateOnly: true });
    });

    it.each([
      ["a window that closes the same day as the last sale", "2027-01-28T12:00:00Z"],
      ["a window that closes a day early", "2027-01-26T23:59:59Z"],
      ["a window that closes well after", "2027-02-10T16:00:00Z"],
    ])("drops a sale start whose last sale is not the day after the claim window's last day (%s) and says why", (_why, closesAt) => {
      const { migration, problems } = validate(config(), closesAt);
      expect(migration.founder?.saleStart).toBeNull();
      expect(problems).toContain("founder.saleStart plus weeks - 1 whole weeks (the last sale) is not the day after the claim window's last day");
      // Everything else about the founder is kept.
      expect(migration.founder?.weeks).toBe(13);
    });

    it("checks nothing without a closing time or a number of weeks", () => {
      expect(validate(config(), null).problems).toEqual([]);
      const founder = { ...config().founder!, weeks: null };
      const { migration, problems } = validate(config({ founder }), "2027-03-01T00:00:00Z");
      expect(problems.join()).not.toMatch(/last sale/);
      expect(migration.founder?.saleStart).not.toBeNull();
    });
  });

  describe("the founder's burn date against the claim window", () => {
    // 13 weekly sales from 5 Nov 2026 end on 28 Jan 2027, the day after the window's last day.
    const CLOSES = "2027-01-27T23:59:59Z";

    it("keeps a burn date after claim.closesAt", () => {
      const { migration, problems } = validate(config(), CLOSES);
      expect(problems).toEqual([]);
      expect(migration.founder?.burnDate).toEqual({ iso: "2027-02-04T00:00:00.000Z", dateOnly: true });
    });

    // With no sale start there is no last sale to check, so only the burn date is held to the window.
    const noSaleStart = () => ({ ...config().founder!, saleStart: null, saleDay: null });

    it.each([
      ["a window that closes after the burn day starts", "2027-02-04T12:00:00Z"],
      ["a window that closes at the burn instant", "2027-02-04T00:00:00Z"],
      ["a window that closes well after the burn date", "2027-02-10T16:00:00Z"],
    ])("drops a burn date that is not after claim.closesAt (%s) and says why", (_why, closesAt) => {
      const { migration, problems } = validate(config({ founder: noSaleStart() }), closesAt);
      expect(migration.founder?.burnDate).toBeNull();
      expect(problems).toContain("founder.burnDate is not after claim.closesAt");
      // Everything else about the founder is kept.
      expect(migration.founder?.weeks).toBe(13);
    });

    it("checks nothing when the claim has no closing time, or the value is not a UTC instant to the second", () => {
      expect(validate(config(), null).migration.founder?.burnDate?.iso).toBe("2027-02-04T00:00:00.000Z");
      expect(validate(config(), "2027-03-01").migration.founder?.burnDate?.iso).toBe("2027-02-04T00:00:00.000Z");
      expect(validate(config(), "2027-03-01T00:00:00.000Z").problems).toEqual([]);
    });

    it("does nothing when there is no burn date to check", () => {
      const founder = { ...noSaleStart(), burnDate: null };
      const { migration, problems } = validate(config({ founder }), "2027-03-01T00:00:00Z");
      expect(migration.founder?.burnDate).toBeNull();
      expect(problems).toEqual([]);
    });
  });

  describe("claimRecordsUrl", () => {
    it.each([
      ["a Sablier campaign page", "https://app.sablier.com/airdrops/campaign/0xabc123/"],
      ["a BaseScan address page", "https://basescan.org/address/0x3333333333333333333333333333333333333333"],
      ["a BaseScan transaction page", `https://basescan.org/tx/${HASH(7)}`],
    ])("keeps %s", (_why, claimRecordsUrl) => {
      const { migration, problems } = validate(config({ claimRecordsUrl }));
      expect(problems).toEqual([]);
      expect(migration.claimRecordsUrl).toBe(claimRecordsUrl);
    });

    it.each([
      ["another host", "https://evil.example/airdrops/x"],
      ["http", "http://app.sablier.com/airdrops/x"],
      ["a lookalike BaseScan host", "https://basescan.org.evil.example/address/0x3333333333333333333333333333333333333333"],
      ["a BaseScan page with a query", "https://basescan.org/address/0x3333333333333333333333333333333333333333?a=1"],
      ["a BaseScan page that is not an address or transaction", "https://basescan.org/token/0x3333333333333333333333333333333333333333"],
      ["a short BaseScan address", "https://basescan.org/address/0x1234"],
      ["the Sablier front page", "https://app.sablier.com/"],
    ])("drops %s and says why", (_why, claimRecordsUrl) => {
      const { migration, problems } = validate(config({ claimRecordsUrl }));
      expect(migration.claimRecordsUrl).toBeNull();
      expect(problems).toContain("claimRecordsUrl must be a plain https link on app.sablier.com or a BaseScan address or transaction page");
    });

    it("is null when it is not set, and never read from anything but a string", () => {
      expect(validate(config()).migration.claimRecordsUrl).toBeNull();
      expect(validate(config({ claimRecordsUrl: undefined })).problems).toEqual([]);
      expect(readClaimRecordsUrl(42)).toBeNull();
      expect(readClaimRecordsUrl(null)).toBeNull();
    });
  });

  it("drops bad receipts and logs why, never rendering them", () => {
    const { migration, problems } = validate(config({
      receipts: [
        { date: "2026-11-20", kind: "liquidity", txHash: HASH(1), note: "Week 2" },
        { date: "2026-11-20", kind: "liquidity", txHash: "0x1234", note: null },
        { date: "2026-11-20", kind: "swap" as never, txHash: HASH(2), note: null },
        { date: "not a date", kind: "founder-sale", txHash: HASH(3), note: null },
        { date: "2027-06-01", kind: "liquidity", txHash: HASH(4), note: null },
        { date: "2026-11-04T23:59:59Z", kind: "founder-sale", txHash: HASH(5), note: null },
        { date: "2026-11-21", kind: "liquidity", txHash: HASH(1), note: "again" },
        { date: "2026-11-22", kind: "claim", txHash: HASH(6), note: "" },
      ],
    }));
    expect(migration.receipts).toEqual([{ date: { iso: "2026-11-20T00:00:00.000Z", dateOnly: true }, kind: "liquidity", txHash: HASH(1), note: "Week 2" }]);
    expect(problems).toHaveLength(7);
  });

  it("no longer takes the burn and airdrop-batch receipt kinds (a burn is recorded as a founder sale)", () => {
    expect(RECEIPT_KINDS).toEqual(["claim", "liquidity", "founder-sale"]);
    const { migration, problems } = validate(config({
      receipts: [
        { date: "2026-11-20", kind: "burn" as never, txHash: HASH(1), note: null },
        { date: "2026-11-20", kind: "airdrop-batch" as never, txHash: HASH(2), note: null },
        { date: "2026-11-20", kind: "founder-sale", txHash: HASH(3), note: "Burn of the remainder" },
      ],
    }));
    expect(migration.receipts.map((receipt) => [receipt.kind, receipt.txHash])).toEqual([["founder-sale", HASH(3)]]);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("kind is not one of claim, liquidity, founder-sale");
  });

  it("checks a claim receipt like any other: a real hash, not in the future, not repeated", () => {
    const { migration, problems } = validate(config({
      receipts: [
        { date: "2026-11-20", kind: "claim", txHash: HASH(1), note: "Claim transactions" },
        { date: "2026-11-21", kind: "claim", txHash: HASH(1), note: null },
        { date: "2027-06-01", kind: "claim", txHash: HASH(2), note: null },
        { date: "2026-11-22", kind: "claim", txHash: "0xabc", note: null },
      ],
    }));
    expect(migration.receipts).toHaveLength(1);
    expect(problems).toHaveLength(3);
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
    expect(served?.snapshot).toEqual({ block: 36_000_000, url: "https://hivra.cloud/token/airdrop-snapshot", takenAt: "2026-10-20T16:30:00.000Z" });
    expect(hivraMigrationHref(ready)).toBe(HIVRA_MIGRATION_PATH);
    expect(HIVRA_MIGRATION_PATH).toBe("/token/migration");
  });

  it("carries the Sablier claim from the airdrop config, at the clock it was given", () => {
    expect(getServedHivraMigration(ready)?.claim).toEqual({ phase: "unpublished", campaignUrl: null, opensAt: null, closesAt: null });
    const claim = { campaignUrl: "https://app.sablier.com/airdrops/campaign/0xabc/", opensAt: "2026-11-01T16:00:00Z", closesAt: "2027-01-27T23:59:59Z" };
    expect(getServedHivraMigration({ ...ready, airdrop: { ...AIRDROP, claim } })?.claim).toEqual({
      phase: "open",
      campaignUrl: claim.campaignUrl,
      opensAt: "2026-11-01T16:00:00.000Z",
      closesAt: "2027-01-27T23:59:59.000Z",
    });
    expect(getServedHivraMigration({ ...ready, now: new Date("2027-02-01T00:00:00Z"), airdrop: { ...AIRDROP, claim } })?.claim.phase).toBe("closed");
    // An invalid claim keeps the whole claim hidden.
    expect(getServedHivraMigration({ ...ready, airdrop: { ...AIRDROP, claim: { ...claim, campaignUrl: "https://evil.example/x" } } })?.claim.phase).toBe("unpublished");
  });

  it("drops the founder's burn date when it is not after the airdrop config's claim.closesAt, and logs it", () => {
    const warn = jest.mocked(log.warn);
    warn.mockClear();
    const claim = { campaignUrl: "https://app.sablier.com/airdrops/campaign/0xabc/", opensAt: "2026-11-01T16:00:00Z", closesAt: "2027-02-10T16:00:00Z" };
    // No sale start, so only the burn date is held to the window.
    const noSaleStart = config({ founder: { ...config().founder!, saleStart: null, saleDay: null } });
    const served = getServedHivraMigration({ ...ready, config: noSaleStart, airdrop: { ...AIRDROP, claim } });
    expect(served?.founder?.burnDate).toBeNull();
    expect(warn).toHaveBeenCalledWith("HIVRA migration config rejected", expect.objectContaining({ problems: expect.stringContaining("founder.burnDate is not after claim.closesAt") }));
    // With a window that closes earlier, the date stays.
    const earlier = { ...claim, closesAt: "2027-01-27T23:59:59Z" };
    expect(getServedHivraMigration({ ...ready, airdrop: { ...AIRDROP, claim: earlier } })?.founder?.burnDate?.iso).toBe("2027-02-04T00:00:00.000Z");
  });

  it("drops the sale start, and logs it, when the last sale is not the day after the airdrop config's claim window ends", () => {
    const warn = jest.mocked(log.warn);
    warn.mockClear();
    const claim = { campaignUrl: "https://app.sablier.com/airdrops/campaign/0xabc/", opensAt: "2026-11-01T16:00:00Z", closesAt: "2027-01-30T12:00:00Z" };
    const served = getServedHivraMigration({ ...ready, airdrop: { ...AIRDROP, claim } });
    expect(served?.founder?.saleStart).toBeNull();
    expect(warn).toHaveBeenCalledWith("HIVRA migration config rejected", expect.objectContaining({ problems: expect.stringContaining("is not the day after the claim window's last day") }));
  });

  describe("the founder's wallet against the published airdrop list", () => {
    const FOUNDER = "0x672b58b6d10413fe69ab0907db5b17712bd45f7a";
    const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
    const list = (overrides: Record<string, unknown> = {}) => ({
      version: 2,
      final: false,
      snapshotBlock: 36_000_000,
      decimals: 18,
      totals: { holders: 1, includedWei: "5", percentOfSupply: "0.01" },
      holders: [{ address: address(1), amountWei: "5" }],
      excluded: [{ address: FOUNDER, label: "Founder wallet (not migrated)" }],
      ...overrides,
    });
    const problemLogged = () => jest.mocked(log.warn).mock.calls.some(([message, meta]) =>
      message === "HIVRA migration config rejected" && String((meta as { problems?: string }).problems).includes("founder.wallet is not an excluded wallet"));

    beforeEach(() => jest.mocked(log.warn).mockClear());

    it("keeps the founder section when his wallet is one of the list's excluded wallets", () => {
      const served = getServedHivraMigration({ ...ready, airdropList: list() });
      expect(served?.founder?.wallet).toBe("0x672b58B6d10413Fe69ab0907db5B17712BD45f7A");
      expect(problemLogged()).toBe(false);
    });

    it.each([
      ["a holder who can claim", { holders: [{ address: FOUNDER, amountWei: "5" }], excluded: [] }],
      ["a Hivra-managed holder", { holders: [{ address: FOUNDER, amountWei: "5", remapped: true }], excluded: [] }],
      ["not in the list at all", { excluded: [] }],
    ])("leaves out the whole founder section, and logs why, when his wallet is %s", (_why, overrides) => {
      const served = getServedHivraMigration({ ...ready, airdropList: list({ totals: { holders: 1, includedWei: "5", percentOfSupply: "0.01" }, ...overrides }) });
      expect(served).not.toBeNull();
      expect(served?.founder).toBeNull();
      // The rest of the page is still served.
      expect(served?.treasurySafe).not.toBeNull();
      expect(problemLogged()).toBe(true);
    });

    it.each([
      ["the list is not published yet (the committed null)", null],
      ["the list is for another snapshot block", list({ snapshotBlock: 1 })],
      ["the list is malformed", list({ decimals: 6 })],
    ])("has nothing to check against when %s, so the section stays", (_why, airdropList) => {
      expect(getServedHivraMigration({ ...ready, airdropList })?.founder?.wallet).not.toBeNull();
      expect(problemLogged()).toBe(false);
    });

    it("checks nothing when the founder section has no wallet", () => {
      const founder = { ...config().founder!, wallet: null };
      const served = getServedHivraMigration({ ...ready, config: config({ founder }), airdropList: list({ excluded: [] }) });
      expect(served?.founder).not.toBeNull();
      expect(problemLogged()).toBe(false);
    });
  });

  it("leaves out a snapshot time that is in the future, and keeps the snapshot", () => {
    const served = getServedHivraMigration({ ...ready, airdrop: { ...AIRDROP, snapshotTakenAt: "2026-12-02T00:00:00Z" } });
    expect(served?.snapshot).toEqual({ block: 36_000_000, url: "https://hivra.cloud/token/airdrop-snapshot", takenAt: null });
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

describe("the shipped plan: a 90-day claim window and 12 weekly sales", () => {
  // Announcement 22 Oct, claim opens 23 Oct 11:00 UTC and closes 90 days later (21 Jan 2027, its last day).
  // 12 weekly sales from Friday 6 Nov 2026 (just after the 14-day head start) end on Friday 22 Jan, the day after.
  const CLAIM_CLOSES = "2027-01-21T11:00:00Z";
  const plan = (overrides: Partial<NonNullable<HivraMigrationConfig["founder"]>> = {}) => ({
    ...HIVRA_MIGRATION,
    published: true,
    announcedAt: "2026-10-22T10:00:00Z",
    founder: { ...HIVRA_MIGRATION.founder!, saleStart: "2026-11-06", saleDay: "Friday", burnDate: "2027-02-05", ...overrides },
  });

  it("defaults to 12 weekly sales", () => {
    expect(HIVRA_MIGRATION.founder?.weeks).toBe(12);
  });

  it("accepts the 12-week plan against the 90-day window", () => {
    const { migration, problems } = validate(plan(), CLAIM_CLOSES);
    expect(problems).toEqual([]);
    expect(migration.founder?.saleStart).toMatchObject({ iso: "2026-11-06T00:00:00.000Z" });
    expect(migration.founder?.burnDate).toMatchObject({ iso: "2027-02-05T00:00:00.000Z" });
  });

  it("does not accept 13 weekly sales against the same window", () => {
    const { migration } = validate(plan({ weeks: 13 }), CLAIM_CLOSES);
    expect(migration.founder?.saleStart).toBeNull();
  });
});
