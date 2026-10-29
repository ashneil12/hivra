/**
 * getServedHivraAirdrop / hivraAirdropLookupHref: the one check /token/airdrop
 * uses for its 404, and the links on /token and /dashboard/convert reuse, so
 * no link points at a 404. The served list's `claim` plus claimHrefOf: the
 * Sablier claim link, which exists only while the configured claim window is
 * open. getTokenPageAirdropFacts: what /token is given about the airdrop.
 */
import { log } from "@/lib/logger";

import {
  HIVRA_AIRDROP_LOOKUP_PATH,
  getServedHivraAirdrop,
  getTokenPageAirdropFacts,
  hivraAirdropLookupHref,
} from "../hivra-airdrop-data";
import { HIVRA_AIRDROP, type HivraAirdropConfig } from "../hivra-airdrop-config";
import { claimHrefOf } from "../hivra-claim";

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

const HIVRA = "0x1111111111111111111111111111111111111111";
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const CONFIG: HivraAirdropConfig = {
  senderAddress: "0x3333333333333333333333333333333333333333",
  snapshotBlock: 36_000_000,
  snapshotTakenAt: null,
  snapshotUrl: "https://hivra.cloud/token/airdrop-snapshot",
  claim: { campaignUrl: null, opensAt: null, closesAt: null },
};
const RAW = {
  version: 2,
  final: false,
  snapshotBlock: 36_000_000,
  decimals: 18,
  totals: { holders: 1, includedWei: "5", percentOfSupply: "0.01" },
  holders: [{ address: A(1), amountWei: "5" }],
  excluded: [],
};
const ON = { HIVRA_NEW_TOKEN_SURFACES: "1" };
const CAMPAIGN = "https://app.sablier.com/airdrops/campaign/0xabc123/";

describe("served airdrop lookup", () => {
  it("links to the lookup only when the surfaces are on and the list is open", () => {
    const open = { env: ON, hivraAddress: HIVRA, config: CONFIG, raw: RAW };
    expect(getServedHivraAirdrop(open)?.snapshot.block).toBe(36_000_000);
    expect(hivraAirdropLookupHref(open)).toBe(HIVRA_AIRDROP_LOOKUP_PATH);
    expect(HIVRA_AIRDROP_LOOKUP_PATH).toBe("/token/airdrop");
  });

  it.each([
    ["the new token surfaces are off", { env: {}, hivraAddress: HIVRA, config: CONFIG, raw: RAW }],
    ["$HIVRA is dormant", { env: ON, hivraAddress: null, config: CONFIG, raw: RAW }],
    ["the snapshot is not published", { env: ON, hivraAddress: HIVRA, config: { ...CONFIG, snapshotUrl: null }, raw: RAW }],
    ["the list is the committed null", { env: ON, hivraAddress: HIVRA, config: CONFIG, raw: null }],
    ["the list is for another block", { env: ON, hivraAddress: HIVRA, config: { ...CONFIG, snapshotBlock: 1 }, raw: RAW }],
    ["the list is malformed", { env: ON, hivraAddress: HIVRA, config: CONFIG, raw: { ...RAW, decimals: 6 } }],
    ["the list is the old push-airdrop shape", { env: ON, hivraAddress: HIVRA, config: CONFIG, raw: { ...RAW, version: 1 } }],
  ])("gives no link when %s", (_why, inputs) => {
    expect(getServedHivraAirdrop(inputs)).toBeNull();
    expect(hivraAirdropLookupHref(inputs)).toBeNull();
  });

  it("logs a rejected config value once, and still serves the page without it", () => {
    jest.mocked(log.warn).mockClear();
    const config = { ...CONFIG, snapshotTakenAt: "2999-01-01T00:00:00Z" };
    const open = { env: ON, hivraAddress: HIVRA, config, raw: RAW, now: new Date("2026-10-20T12:00:00Z") };
    expect(getServedHivraAirdrop(open)?.snapshot.takenAt).toBeNull();
    expect(getServedHivraAirdrop(open)?.snapshot.block).toBe(36_000_000);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith("HIVRA airdrop config rejected", expect.objectContaining({
      problems: "snapshotTakenAt is in the future",
    }));
  });
});

describe("the Sablier claim link", () => {
  const NOW = new Date("2026-11-10T12:00:00Z");
  const claim = (overrides: Partial<HivraAirdropConfig["claim"]> = {}): HivraAirdropConfig => ({
    ...CONFIG,
    claim: { campaignUrl: CAMPAIGN, opensAt: "2026-11-01T00:00:00Z", closesAt: "2026-12-01T00:00:00Z", ...overrides },
  });
  const served = (config: HivraAirdropConfig, now: Date) => getServedHivraAirdrop({ env: ON, hivraAddress: HIVRA, config, raw: RAW, now });

  it("ships the tested Sablier campaign and its 90-day window; an unset claim gives no link", () => {
    expect(HIVRA_AIRDROP.claim).toEqual({
      campaignUrl: "https://app.sablier.com/airdrops/campaign/0x4131ab8f9797bb4887a72470b8af48fbec37522f-8453",
      opensAt: "2026-10-29T13:30:00Z",
      closesAt: "2027-01-27T13:30:00Z",
    });
    const open = served(CONFIG, NOW);
    expect(open?.claim.phase).toBe("unpublished");
    expect(claimHrefOf(open?.claim)).toBeNull();
  });

  it("gives the validated link only while the claim is open", () => {
    expect(served(claim(), NOW)?.claim.phase).toBe("open");
    expect(claimHrefOf(served(claim(), NOW)?.claim)).toBe(CAMPAIGN);
    const before = new Date("2026-10-31T23:59:59Z");
    expect(served(claim(), before)?.claim.phase).toBe("not_open");
    expect(claimHrefOf(served(claim(), before)?.claim)).toBeNull();
    const after = new Date("2026-12-01T00:00:00Z");
    expect(served(claim(), after)?.claim.phase).toBe("closed");
    expect(claimHrefOf(served(claim(), after)?.claim)).toBeNull();
  });

  it("stays unpublished, with no link, for an invalid campaign link", () => {
    jest.mocked(log.warn).mockClear();
    const open = served(claim({ campaignUrl: "https://app.sablier.com.evil.example/x" }), NOW);
    expect(open?.claim.phase).toBe("unpublished");
    expect(claimHrefOf(open?.claim)).toBeNull();
    expect(log.warn).toHaveBeenCalledWith("HIVRA airdrop config rejected", expect.objectContaining({
      problems: "claim.campaignUrl must be a plain https link on app.sablier.com",
    }));
  });
});

describe("what /token is given about the airdrop", () => {
  const NOW = new Date("2026-11-10T12:00:00Z");

  it("is the snapshot and the Airdrop wallet, and never the Sablier link or the claim window", () => {
    const config: HivraAirdropConfig = {
      ...CONFIG,
      snapshotTakenAt: "2026-10-20T16:00:00Z",
      claim: { campaignUrl: CAMPAIGN, opensAt: "2026-11-01T00:00:00Z", closesAt: "2026-12-01T00:00:00Z" },
    };
    const facts = getTokenPageAirdropFacts(HIVRA, { now: NOW, config });
    expect(facts).toEqual({
      snapshot: { block: 36_000_000, url: "https://hivra.cloud/token/airdrop-snapshot", takenAt: "2026-10-20T16:00:00.000Z" },
      senderAddress: "0x3333333333333333333333333333333333333333",
    });
    expect(JSON.stringify(facts)).not.toMatch(/sablier|opensAt|closesAt|campaign/i);
  });

  it("drops a snapshot time that is in the future, as /token/airdrop and /token/migration do, and keeps the block", () => {
    const config = { ...CONFIG, snapshotTakenAt: "2999-01-01T00:00:00Z" };
    expect(getTokenPageAirdropFacts(HIVRA, { now: NOW, config }).snapshot?.takenAt).toBeNull();
    expect(getTokenPageAirdropFacts(HIVRA, { now: NOW, config }).snapshot?.block).toBe(36_000_000);
  });

  it("reports a snapshot time that is not a UTC instant, once, and shows no date", () => {
    jest.mocked(log.warn).mockClear();
    const config = { ...CONFIG, snapshotTakenAt: "last Tuesday" };
    expect(getTokenPageAirdropFacts(HIVRA, { now: NOW, config }).snapshot?.takenAt).toBeNull();
    expect(getTokenPageAirdropFacts(HIVRA, { now: NOW, config }).snapshot?.takenAt).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith("HIVRA airdrop config rejected", expect.objectContaining({
      problems: expect.stringContaining("snapshotTakenAt must be a real UTC instant"),
    }));
  });

  it("has no snapshot until the block and the link are both published", () => {
    expect(getTokenPageAirdropFacts(HIVRA, { now: NOW, config: { ...CONFIG, snapshotUrl: null } }).snapshot).toBeNull();
  });
});
