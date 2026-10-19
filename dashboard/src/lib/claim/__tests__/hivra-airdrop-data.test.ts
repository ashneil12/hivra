/**
 * getServedHivraAirdrop / hivraAirdropLookupHref: the one check /token/airdrop
 * uses for its 404, and the links on /token and /dashboard/convert reuse, so
 * no link points at a 404.
 */
import { HIVRA_AIRDROP_LOOKUP_PATH, getServedHivraAirdrop, hivraAirdropLookupHref } from "../hivra-airdrop-data";
import type { HivraAirdropConfig } from "../hivra-airdrop-config";

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

const HIVRA = "0x1111111111111111111111111111111111111111";
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const CONFIG: HivraAirdropConfig = {
  senderAddress: "0x3333333333333333333333333333333333333333",
  snapshotBlock: 36_000_000,
  snapshotUrl: "https://hivra.cloud/token/airdrop-snapshot",
  sentAt: null,
};
const RAW = {
  version: 1,
  snapshotBlock: 36_000_000,
  decimals: 18,
  totals: { holders: 1, includedWei: "5", percentOfSupply: "0.01" },
  batches: [{ index: 1, recipients: 1, totalWei: "5", tx: null }],
  holders: [{ address: A(1), amountWei: "5", batch: 1 }],
  excluded: [],
};
const ON = { HIVRA_NEW_TOKEN_SURFACES: "1" };

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
  ])("gives no link when %s", (_why, inputs) => {
    expect(getServedHivraAirdrop(inputs)).toBeNull();
    expect(hivraAirdropLookupHref(inputs)).toBeNull();
  });
});
