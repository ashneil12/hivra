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
const NOW = new Date("2026-10-03T12:00:00Z");

const PUBLISHED: HivraAirdropConfig = {
  senderAddress: TEST_SENDER,
  snapshotBlock: 36_000_000,
  snapshotUrl: SNAPSHOT_URL,
  sentAt: null,
};
const SENT: HivraAirdropConfig = { ...PUBLISHED, sentAt: "2026-10-02T18:00:00Z" };

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
    airdrop: SENT,
    access: { grandfathered: false, convertedAt: null, conversionGraceEndsAt: null },
    now: NOW,
    ...overrides,
  };
}

describe("committed configuration", () => {
  it("ships with the airdrop wallet only: no snapshot and nothing marked sent", () => {
    expect(HIVRA_AIRDROP).toEqual({
      senderAddress: "0x3B954866d4329E19C1B9165774c88508f2fefA0c",
      snapshotBlock: null,
      snapshotUrl: null,
      sentAt: null,
    });
  });

  it("the committed airdrop wallet passes its EIP-55 checksum and is not a token contract", () => {
    const sender = HIVRA_AIRDROP.senderAddress;
    if (!sender) return;
    expect(isAddress(sender, { strict: true })).toBe(true);
    expect(sender.toLowerCase()).not.toBe(HERMESOS_TOKEN.address);
  });

  it("stays dormant from the committed registry, whatever the airdrop config says", () => {
    const state = resolveConversionState(readConversionInputs({ grandfathered: true, convertedAt: null, conversionGraceEndsAt: null }));
    // Holds until the $HIVRA launch block is filled in.
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
  it("is dormant while the registry has no $HIVRA, even with a published, sent airdrop", () => {
    expect(resolveConversionState(inputs({ hivra: null, phase: "dormant" }))).toEqual({ status: "dormant", problems: [] });
  });

  it("shows the published airdrop facts once $HIVRA is live", () => {
    expect(resolveConversionState(inputs())).toEqual({
      status: "launched",
      hivraAddress: TEST_HIVRA,
      hivraPublishedAddress: TEST_HIVRA,
      senderAddress: TEST_SENDER,
      snapshot: { block: 36_000_000, url: SNAPSHOT_URL },
      sentAt: "2026-10-02T18:00:00.000Z",
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
      expect(state).toMatchObject({ status: "launched", senderAddress: TEST_SENDER, snapshot: null, sentAt: null, problems: [] });
    }
  });

  it("offers the switch to a grandfathered holder only once the airdrop is sent", () => {
    const grandfathered = { grandfathered: true, convertedAt: null, conversionGraceEndsAt: null };
    expect(resolveConversionState(inputs({ access: grandfathered }))).toMatchObject({ access: { kind: "switch-available" } });
    expect(resolveConversionState(inputs({ access: grandfathered, airdrop: PUBLISHED }))).toMatchObject({
      access: { kind: "hermesos" },
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

  it("never treats an airdrop as sent before the instant it names", () => {
    const state = resolveConversionState(inputs({ airdrop: { ...PUBLISHED, sentAt: "2026-10-04T00:00:00Z" }, access: { grandfathered: true, convertedAt: null, conversionGraceEndsAt: null } }));
    expect(state).toMatchObject({ sentAt: null, access: { kind: "hermesos" }, problems: ["sentAt is in the future"] });
  });

  it.each<[string, Partial<HivraAirdropConfig>, string]>([
    ["a snapshot list on an unapproved host", { snapshotUrl: "https://hivra-cloud.io/snapshot" }, "snapshotUrl must be https on an allowed Hivra location"],
    ["a GitHub list outside Hivra's repository", { snapshotUrl: "https://github.com/someone/hivra/snapshot.csv" }, "snapshotUrl must be https on an allowed Hivra location"],
    ["a block that is not a whole positive number", { snapshotBlock: 12.5 }, "snapshotBlock must be a positive whole block number"],
    ["a sent time without seconds or zone", { sentAt: "2026-10-02 18:00" }, "sentAt must be a real UTC instant to the second, e.g. 2026-10-02T16:00:00Z"],
    ["a malformed sender", { senderAddress: "0x1234" }, "senderAddress must be a non-zero 0x-prefixed 20-byte address"],
    ["the $HIVRA contract as the sender", { senderAddress: TEST_HIVRA }, "senderAddress is a token contract, not the airdrop wallet"],
    ["the $HermesOS contract as the sender", { senderAddress: HERMESOS_TOKEN.publishedAddress }, "senderAddress is a token contract, not the airdrop wallet"],
  ])("leaves out and reports %s", (_label, change, problem) => {
    const state = resolveConversionState(inputs({ airdrop: { ...SENT, ...change } }));
    expect(state.problems).toContain(problem);
  });

  it("never marks the airdrop sent without a published snapshot", () => {
    const state = resolveConversionState(inputs({ airdrop: { ...SENT, snapshotUrl: null } }));
    expect(state).toMatchObject({ sentAt: null, problems: ["sentAt is set but the snapshot is not published"] });
  });
});

describe("resolveAirdropFacts", () => {
  it("skips sentAt when no clock is given", () => {
    expect(resolveAirdropFacts(SENT, TEST_HIVRA, null)).toEqual({
      senderAddress: TEST_SENDER,
      snapshot: { block: 36_000_000, url: SNAPSHOT_URL },
      sentAt: null,
      problems: [],
    });
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
