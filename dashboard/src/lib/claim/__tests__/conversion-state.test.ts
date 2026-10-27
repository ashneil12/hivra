import { isAddress } from "viem";

import { HERMESOS_TOKEN, validateHivraLaunchConfig, type PlatformToken } from "@/lib/billing/token-registry";

import {
  checkTokenAddress,
  readAllowedUrl,
  readConversionInputs,
  resolveAirdropFacts,
  resolveConversionState,
  type ConversionInputs,
} from "../conversion-state";
import { HIVRA_AIRDROP, SNAPSHOT_URL_ALLOWED_LOCATIONS, type HivraAirdropConfig } from "../hivra-airdrop-config";

// Stand-in addresses for tests only. They are not, and must never be treated as, $HIVRA or Hivra's wallet.
const TEST_HIVRA = "0x1111111111111111111111111111111111111111";
const TEST_SENDER = "0x3333333333333333333333333333333333333333";
const SNAPSHOT_URL = "https://hivra.cloud/token/airdrop-snapshot";
const CAMPAIGN_URL = "https://app.sablier.com/airdrops/campaign/0xabc123/";
const NOW = new Date("2026-10-03T12:00:00Z");

const PUBLISHED: HivraAirdropConfig = {
  senderAddress: TEST_SENDER,
  snapshotBlock: 36_000_000,
  snapshotTakenAt: null,
  snapshotUrl: SNAPSHOT_URL,
  claim: { campaignUrl: null, opensAt: null, closesAt: null },
};
// The claim opened on 1 October and closed on 2 October, before NOW.
const CLOSED: HivraAirdropConfig = {
  ...PUBLISHED,
  claim: { campaignUrl: CAMPAIGN_URL, opensAt: "2026-10-01T00:00:00Z", closesAt: "2026-10-02T18:00:00Z" },
};
// The claim is open at NOW and closes later.
const OPEN: HivraAirdropConfig = {
  ...PUBLISHED,
  claim: { campaignUrl: CAMPAIGN_URL, opensAt: "2026-10-01T00:00:00Z", closesAt: "2026-10-31T18:00:00Z" },
};

function testHivraToken(): PlatformToken {
  const validation = validateHivraLaunchConfig({
    contractAddress: TEST_HIVRA,
    decimals: 18,
    poolId: `0x${"ab".repeat(32)}`,
    activatesAt: "2026-10-01T16:00:00Z",
  });
  if (validation.status !== "configured") throw new Error("test launch block should validate");
  return validation.token;
}

function inputs(overrides: Partial<ConversionInputs> = {}): ConversionInputs {
  return {
    hivra: testHivraToken(),
    phase: "active",
    airdrop: CLOSED,
    access: { grandfathered: false, convertedAt: null, conversionGraceEndsAt: null },
    now: NOW,
    ...overrides,
  };
}

describe("committed configuration", () => {
  it("ships with the airdrop wallet and the published snapshot, and no claim yet", () => {
    expect(HIVRA_AIRDROP).toEqual({
      senderAddress: "0x3B954866d4329E19C1B9165774c88508f2fefA0c",
      snapshotBlock: 53005062,
      snapshotTakenAt: "2026-10-23T23:51:11Z",
      snapshotUrl: "https://github.com/ashneil12/hivra/blob/main/dashboard/src/data/token/hivra-airdrop.json",
      claim: { campaignUrl: null, opensAt: null, closesAt: null },
    });
  });

  it("the committed snapshot passes its own checks: an allowed URL, a real past instant and a positive block", () => {
    const facts = resolveAirdropFacts(HIVRA_AIRDROP, TEST_HIVRA, new Date("2026-10-27T00:00:00Z"));
    expect(facts.problems).toEqual([]);
    expect(facts.snapshot).toEqual({
      block: 53005062,
      url: "https://github.com/ashneil12/hivra/blob/main/dashboard/src/data/token/hivra-airdrop.json",
      takenAt: "2026-10-23T23:51:11.000Z",
    });
    expect(facts.claim?.phase).toBe("unpublished");
  });

  it("the committed airdrop wallet passes its EIP-55 checksum and is not a token contract", () => {
    const sender = HIVRA_AIRDROP.senderAddress;
    if (!sender) return;
    expect(isAddress(sender, { strict: true })).toBe(true);
    expect(sender.toLowerCase()).not.toBe(HERMESOS_TOKEN.address);
  });

  it("is launched from the committed registry, with the snapshot shown and no claim or switch offered yet", () => {
    const access = { grandfathered: true, convertedAt: null, conversionGraceEndsAt: null };
    const before = resolveConversionState(readConversionInputs(access, new Date("2026-10-27T12:00:00Z")));
    if (before.status !== "launched") throw new Error(`expected launched, got ${before.status}`);
    expect(before.hivraPublishedAddress).toBe("0xe3a1F26440A9FDf5d17b6B3F12F5ebB290080871");
    expect(before.snapshot?.block).toBe(53005062);
    expect(before.claim.phase).toBe("unpublished");
    expect(before.access).toEqual({ kind: "unknown" });
    expect(before.problems).toEqual([]);
    // After activation a grandfathered holder keeps $HermesOS: the claim has not closed, so no switch is offered.
    const after = resolveConversionState(readConversionInputs(access, new Date("2026-11-01T12:00:00Z")));
    if (after.status !== "launched") throw new Error(`expected launched, got ${after.status}`);
    expect(after.access).toEqual({ kind: "hermesos" });
  });

  it("stays dormant while the registry has no $HIVRA, whatever the committed airdrop config says", () => {
    const state = resolveConversionState({
      ...readConversionInputs({ grandfathered: true, convertedAt: null, conversionGraceEndsAt: null }),
      hivra: null,
      phase: "dormant",
    });
    expect(state.status).toBe("dormant");
  });

  it("pins the exact locations the snapshot may be published on", () => {
    expect(SNAPSHOT_URL_ALLOWED_LOCATIONS).toEqual([
      { host: "hivra.cloud", pathPrefix: "/" },
      { host: "canary.hermesos.cloud", pathPrefix: "/" },
      { host: "github.com", pathPrefix: "/ashneil12/hivra/" },
    ]);
  });
});

describe("resolveConversionState", () => {
  it("is dormant while the registry has no $HIVRA, even with a published snapshot and a closed claim", () => {
    expect(resolveConversionState(inputs({ hivra: null, phase: "dormant" }))).toEqual({ status: "dormant", problems: [] });
  });

  it("shows the published claim facts once $HIVRA is live", () => {
    expect(resolveConversionState(inputs())).toEqual({
      status: "launched",
      hivraAddress: TEST_HIVRA,
      hivraPublishedAddress: TEST_HIVRA,
      senderAddress: TEST_SENDER,
      snapshot: { block: 36_000_000, url: SNAPSHOT_URL, takenAt: null },
      claim: { phase: "closed", campaignUrl: CAMPAIGN_URL, opensAt: "2026-10-01T00:00:00.000Z", closesAt: "2026-10-02T18:00:00.000Z" },
      access: { kind: "hivra", graceEndsAt: null },
      problems: [],
    });
  });

  it("shows the contract and sender but no snapshot until both the block and the list are set", () => {
    for (const airdrop of [
      { ...PUBLISHED, snapshotBlock: null },
      { ...PUBLISHED, snapshotUrl: null },
    ]) {
      const state = resolveConversionState(inputs({ airdrop }));
      expect(state).toMatchObject({ status: "launched", senderAddress: TEST_SENDER, snapshot: null, claim: { phase: "unpublished" }, problems: [] });
    }
  });

  it("carries the snapshot time only when it is a real instant that is not in the future", () => {
    expect(resolveConversionState(inputs({ airdrop: { ...PUBLISHED, snapshotTakenAt: "2026-10-02T16:30:00Z" } }))).toMatchObject({
      snapshot: { block: 36_000_000, takenAt: "2026-10-02T16:30:00.000Z" },
      problems: [],
    });
    expect(resolveConversionState(inputs({ airdrop: { ...PUBLISHED, snapshotTakenAt: "2026-10-04T00:00:00Z" } }))).toMatchObject({
      snapshot: { block: 36_000_000, takenAt: null },
      problems: ["snapshotTakenAt is in the future"],
    });
  });

  describe("the optional switch for a grandfathered holder", () => {
    const grandfathered = { grandfathered: true, convertedAt: null, conversionGraceEndsAt: null };

    it("is offered only once the claim window has closed", () => {
      expect(resolveConversionState(inputs({ access: grandfathered, airdrop: CLOSED }))).toMatchObject({ access: { kind: "switch-available" } });
      expect(resolveConversionState(inputs({ access: grandfathered, airdrop: OPEN }))).toMatchObject({ claim: { phase: "open" }, access: { kind: "hermesos" } });
      expect(resolveConversionState(inputs({ access: grandfathered, airdrop: PUBLISHED }))).toMatchObject({ claim: { phase: "unpublished" }, access: { kind: "hermesos" } });
    });

    it("waits for a claim that has not opened yet", () => {
      const notOpen = { ...OPEN, claim: { ...OPEN.claim, opensAt: "2026-10-10T00:00:00Z" } };
      expect(resolveConversionState(inputs({ access: grandfathered, airdrop: notOpen }))).toMatchObject({ claim: { phase: "not_open" }, access: { kind: "hermesos" } });
    });

    it("never counts a claim that closes after the current instant, or a closed claim without a published snapshot", () => {
      const closesLater = { ...CLOSED, claim: { ...CLOSED.claim, closesAt: "2026-10-03T12:00:01Z" } };
      expect(resolveConversionState(inputs({ access: grandfathered, airdrop: closesLater }))).toMatchObject({ claim: { phase: "open" }, access: { kind: "hermesos" } });
      const noSnapshot = { ...CLOSED, snapshotUrl: null };
      expect(resolveConversionState(inputs({ access: grandfathered, airdrop: noSnapshot }))).toMatchObject({ snapshot: null, claim: { phase: "closed" }, access: { kind: "hermesos" } });
    });

    it("is opened by the instant the claim closes, to the second", () => {
      const closesNow = { ...CLOSED, claim: { ...CLOSED.claim, closesAt: "2026-10-03T12:00:00Z" } };
      expect(resolveConversionState(inputs({ access: grandfathered, airdrop: closesNow }))).toMatchObject({ access: { kind: "switch-available" } });
    });

    it("stays hidden when the claim config is invalid, even if its closing time has passed", () => {
      const badLink = { ...CLOSED, claim: { ...CLOSED.claim, campaignUrl: "https://evil.example/x" } };
      expect(resolveConversionState(inputs({ access: grandfathered, airdrop: badLink }))).toMatchObject({
        claim: { phase: "unpublished" },
        access: { kind: "hermesos" },
        problems: ["claim.campaignUrl must be a plain https link on app.sablier.com"],
      });
    });
  });

  it.each<[string, Partial<ConversionInputs>]>([
    ["$HIVRA is scheduled but not live", { phase: "scheduled" }],
    ["the user's access can't be read", { access: null }],
  ])("says nothing about the user's tier when %s", (_label, overrides) => {
    expect(resolveConversionState(inputs(overrides))).toMatchObject({ status: "launched", access: { kind: "unknown" } });
  });

  it("carries a switched holder's grace end", () => {
    expect(
      resolveConversionState(
        inputs({
          access: { grandfathered: true, convertedAt: "2026-10-02T00:00:00.000Z", conversionGraceEndsAt: "2026-10-05T00:00:00.000Z" },
        }),
      ),
    ).toMatchObject({ access: { kind: "hivra", graceEndsAt: "2026-10-05T00:00:00.000Z" } });
  });

  it.each<[string, Partial<HivraAirdropConfig>, string]>([
    ["a snapshot list on an unapproved host", { snapshotUrl: "https://hivra-cloud.io/snapshot" }, "snapshotUrl must be https on an allowed Hivra location"],
    ["a GitHub list outside Hivra's repository", { snapshotUrl: "https://github.com/someone/hivra/snapshot.csv" }, "snapshotUrl must be https on an allowed Hivra location"],
    ["a block that is not a whole positive number", { snapshotBlock: 12.5 }, "snapshotBlock must be a positive whole block number"],
    ["a snapshot time without seconds or zone", { snapshotTakenAt: "2026-10-02 18:00" }, "snapshotTakenAt must be a real UTC instant to the second, e.g. 2026-10-20T16:00:00Z"],
    ["a snapshot time that is not a real date", { snapshotTakenAt: "2026-02-30T16:00:00Z" }, "snapshotTakenAt must be a real UTC instant to the second, e.g. 2026-10-20T16:00:00Z"],
    ["a malformed sender", { senderAddress: "0x1234" }, "senderAddress must be a non-zero 0x-prefixed 20-byte address"],
    ["the $HIVRA contract as the sender", { senderAddress: TEST_HIVRA }, "senderAddress is a token contract, not the airdrop wallet"],
    ["the $HermesOS contract as the sender", { senderAddress: HERMESOS_TOKEN.publishedAddress }, "senderAddress is a token contract, not the airdrop wallet"],
    ["a claim link on another host", { claim: { ...CLOSED.claim, campaignUrl: "https://app.sablier.com.evil.example/x" } }, "claim.campaignUrl must be a plain https link on app.sablier.com"],
    ["a claim opening time without seconds", { claim: { ...CLOSED.claim, opensAt: "2026-10-01T00:00Z" } }, "claim.opensAt must be a real UTC instant to the second, e.g. 2026-10-21T16:00:00Z"],
    ["a claim window that closes before it opens", { claim: { ...CLOSED.claim, opensAt: "2026-10-02T18:00:00Z", closesAt: "2026-10-01T00:00:00Z" } }, "claim.opensAt must be before claim.closesAt"],
  ])("leaves out and reports %s", (_label, change, problem) => {
    const state = resolveConversionState(inputs({ airdrop: { ...CLOSED, ...change } }));
    expect(state.problems).toContain(problem);
  });

  it("reads a config without the new fields (an older mock or snapshot) as nothing published", () => {
    const old = { senderAddress: TEST_SENDER, snapshotBlock: 36_000_000, snapshotUrl: SNAPSHOT_URL } as unknown as HivraAirdropConfig;
    expect(resolveConversionState(inputs({ airdrop: old }))).toMatchObject({
      snapshot: { block: 36_000_000, takenAt: null },
      claim: { phase: "unpublished" },
      problems: [],
    });
  });
});

describe("resolveAirdropFacts", () => {
  it("skips the clock-dependent facts (the claim, the future check) when no clock is given", () => {
    expect(resolveAirdropFacts({ ...CLOSED, snapshotTakenAt: "2026-10-02T16:30:00Z" }, TEST_HIVRA, null)).toEqual({
      senderAddress: TEST_SENDER,
      snapshot: { block: 36_000_000, url: SNAPSHOT_URL, takenAt: "2026-10-02T16:30:00.000Z" },
      claim: null,
      problems: [],
    });
  });

  it("still rejects a malformed snapshot time without a clock", () => {
    expect(resolveAirdropFacts({ ...PUBLISHED, snapshotTakenAt: "yesterday" }, TEST_HIVRA, null)).toMatchObject({
      snapshot: { takenAt: null },
      problems: ["snapshotTakenAt must be a real UTC instant to the second, e.g. 2026-10-20T16:00:00Z"],
    });
  });

  it("resolves the claim at the given instant", () => {
    expect(resolveAirdropFacts(OPEN, TEST_HIVRA, NOW).claim?.phase).toBe("open");
    expect(resolveAirdropFacts(OPEN, TEST_HIVRA, new Date("2026-11-01T00:00:00Z")).claim?.phase).toBe("closed");
  });
});


describe("readAllowedUrl", () => {
  const allowed = [
    { host: "hivra.cloud", pathPrefix: "/" },
    { host: "github.com", pathPrefix: "/ashneil12/hivra/" },
  ];

  it.each([
    ["https://hivra.cloud/x", "https://hivra.cloud/x"],
    ["https://HIVRA.cloud/x", "https://hivra.cloud/x"],
    ["https://hivra.cloud:443/x", "https://hivra.cloud/x"],
    ["https://github.com/ashneil12/hivra/blob/main/snapshot.csv", "https://github.com/ashneil12/hivra/blob/main/snapshot.csv"],
  ])("accepts %s", (input, expected) => {
    expect(readAllowedUrl(input, allowed)).toBe(expected);
  });

  it.each([
    "http://hivra.cloud/x",
    "https://evilhivra.cloud/x",
    "https://www.hivra.cloud/x",
    "https://hivra.cloud./x",
    "https://hivra.cloud:8443/x",
    "https://hivra.cloud.evil.example/x",
    "https://user:pass@hivra.cloud/x",
    "https://github.com/ashneil12/hivra-fake/x",
    "https://github.com/ashneil12/hivra/../evil/x",
    "https://github.com/ashneil12/hivra/%2e%2e/evil/x",
    "javascript:alert(1)",
    "not a url",
    "",
  ])("rejects %s", (input) => {
    expect(readAllowedUrl(input, allowed)).toBeNull();
  });
});

describe("checkTokenAddress", () => {
  const dormant = resolveConversionState(inputs({ hivra: null, phase: "dormant" }));
  const launched = resolveConversionState(inputs({ phase: "scheduled" }));

  it("recognises the $HermesOS contract in any case", () => {
    expect(checkTokenAddress(` ${HERMESOS_TOKEN.publishedAddress.toUpperCase().replace("0X", "0x")} `, dormant)).toEqual({
      kind: "hermesos",
    });
  });

  it("says any other token is not Hivra's while $HIVRA has not launched, even the airdrop wallet", () => {
    expect(checkTokenAddress(TEST_HIVRA, dormant)).toEqual({ kind: "hivra-not-launched" });
    expect(checkTokenAddress(TEST_SENDER, dormant)).toEqual({ kind: "hivra-not-launched" });
  });

  it("recognises the registry $HIVRA contract and the airdrop wallet once launched", () => {
    expect(checkTokenAddress(TEST_HIVRA, launched)).toEqual({ kind: "hivra" });
    expect(checkTokenAddress(TEST_SENDER.toUpperCase().replace("0X", "0x"), launched)).toEqual({ kind: "airdrop-sender" });
  });

  it("flags a lookalike once $HIVRA is launched", () => {
    expect(checkTokenAddress("0x2222222222222222222222222222222222222222", launched)).toEqual({ kind: "not-official" });
  });

  it("rejects partial input", () => {
    expect(checkTokenAddress("0x1111", launched)).toEqual({ kind: "invalid" });
  });
});
