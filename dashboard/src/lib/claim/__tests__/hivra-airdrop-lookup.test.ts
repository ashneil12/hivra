import {
  CLAIM_STATE_LABELS,
  claimStateLabel,
  formatHivraAmount,
  formatWholeNumber,
  lookupHivraAirdrop,
  normalizeLookupAddress,
  parseHivraAirdropData,
} from "../hivra-airdrop-lookup";
import { getOpenHivraAirdrop } from "../hivra-airdrop-data";
import type { HivraAirdropConfig } from "../hivra-airdrop-config";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const HIVRA = "0x1111111111111111111111111111111111111111";

function validList() {
  return {
    version: 2,
    final: true,
    snapshotBlock: 36000000,
    decimals: 18,
    ratio: "1:1",
    totals: { holders: 3, includedWei: "6500000000000000001", excludedWallets: 1, excludedWei: "9", percentOfSupply: "0.01" },
    holders: [
      { address: A(1), amountWei: "4000000000000000000" },
      { address: A(0xa1), amountWei: "2000000000000000000", remapped: true },
      { address: A(2), amountWei: "500000000000000001" },
    ],
    excluded: [{ address: A(0xbeef), label: "Uniswap pool" }],
  };
}

function parsed(raw: unknown = validList()) {
  const result = parseHivraAirdropData(raw);
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.airdrop;
}

describe("parseHivraAirdropData", () => {
  it("accepts a well-formed list", () => {
    expect(parsed().data.totals).toEqual({ holders: 3, includedWei: "6500000000000000001", percentOfSupply: "0.01" });
    expect(parsed().data.final).toBe(true);
  });

  it("accepts amounts that add up to exactly the whole supply", () => {
    const wholeSupply = "100000000000000000000000000000";
    expect(parseHivraAirdropData({
      ...validList(),
      totals: { ...validList().totals, holders: 1, includedWei: wholeSupply },
      holders: [{ address: A(1), amountWei: wholeSupply }],
    }).ok).toBe(true);
  });

  it("reads a list without a final flag as not final, and a dry run as not final", () => {
    const withoutFlag: Record<string, unknown> = { ...validList() };
    delete withoutFlag.final;
    expect(parsed(withoutFlag).data.final).toBe(false);
    expect(parsed({ ...validList(), final: false }).data.final).toBe(false);
  });

  it.each([
    ["the committed placeholder", null],
    ["the old version", { ...validList(), version: 1 }],
    ["a final flag that is not a boolean", { ...validList(), final: "true" }],
    ["a total that does not add up", { ...validList(), totals: { ...validList().totals, includedWei: "6500000000000000000" } }],
    ["a holder count that does not add up", { ...validList(), totals: { ...validList().totals, holders: 4 } }],
    ["leftover Disperse batches", { ...validList(), batches: [{ index: 1, recipients: 3, totalWei: "6500000000000000001", tx: null }] }],
    ["a holder with a batch", { ...validList(), holders: [{ ...validList().holders[0], batch: 1 }, ...validList().holders.slice(1)] }],
    ["a holder with a sent flag", { ...validList(), holders: [{ ...validList().holders[0], sent: true }, ...validList().holders.slice(1)] }],
    ["a managed wallet that carries its destination", { ...validList(), holders: [validList().holders[0], { ...validList().holders[1], sendTo: A(5) }, validList().holders[2]] }],
    ["a managed wallet that carries a sent flag", { ...validList(), holders: [validList().holders[0], { ...validList().holders[1], sent: true }, validList().holders[2]] }],
    ["a remapped flag that is not true", { ...validList(), holders: [{ ...validList().holders[0], remapped: false }, ...validList().holders.slice(1)] }],
    ["an upper-case address", { ...validList(), holders: [{ ...validList().holders[0], address: A(0xab).toUpperCase().replace("0X", "0x") }, ...validList().holders.slice(1)] }],
    ["a float amount", { ...validList(), holders: [{ ...validList().holders[0], amountWei: "4e18" }, ...validList().holders.slice(1)] }],
    ["a holder listed twice", { ...validList(), holders: [...validList().holders, validList().holders[0]] }],
    ["a wallet both included and excluded", { ...validList(), excluded: [{ address: A(1), label: "x" }] }],
    ["amounts that add up to more than the 100 billion supply", {
      ...validList(),
      totals: { ...validList().totals, holders: 2, includedWei: "100000000000000000000000000001" },
      holders: [{ address: A(1), amountWei: "100000000000000000000000000000" }, { address: A(2), amountWei: "1" }],
    }],
  ])("rejects %s", (_name, raw) => {
    expect(parseHivraAirdropData(raw).ok).toBe(false);
  });
});

describe("lookupHivraAirdrop", () => {
  const airdrop = parsed();

  it("answers a holder with the amount only: no sent or transaction state", () => {
    expect(lookupHivraAirdrop(airdrop, `  ${A(1)}  `)).toEqual({ kind: "holder", address: A(1), amountWei: "4000000000000000000" });
    expect(lookupHivraAirdrop(airdrop, A(2))).toEqual({ kind: "holder", address: A(2), amountWei: "500000000000000001" });
  });

  it("answers a Hivra-managed wallet without any destination", () => {
    expect(lookupHivraAirdrop(airdrop, A(0xa1).replace("a1", "A1"))).toEqual({ kind: "managed", address: A(0xa1), amountWei: "2000000000000000000" });
  });

  it("answers an excluded wallet with its reason, and an unknown one as absent", () => {
    expect(lookupHivraAirdrop(airdrop, A(0xbeef))).toEqual({ kind: "excluded", address: A(0xbeef), label: "Uniswap pool" });
    expect(lookupHivraAirdrop(airdrop, A(7))).toEqual({ kind: "absent", address: A(7) });
  });

  it("rejects what is not an address", () => {
    expect(lookupHivraAirdrop(airdrop, "vitalik.eth")).toEqual({ kind: "invalid" });
    expect(normalizeLookupAddress("0x123")).toBeNull();
  });
});

describe("claim states", () => {
  it("uses the pack's state words, and only states the app can verify", () => {
    expect(CLAIM_STATE_LABELS).toEqual({
      eligible: "Eligible",
      notEligible: "Not eligible",
      notYetOpen: "Claim not yet open",
      available: "Available to claim",
      closed: "Claim window closed",
    });
    // The app cannot see Sablier's on-chain claims: there is no "Claimed" and no "Unable to verify".
    expect(Object.values(CLAIM_STATE_LABELS)).not.toContain("Claimed");
    expect(Object.values(CLAIM_STATE_LABELS)).not.toContain("Unable to verify");
  });

  it.each([
    ["unpublished", "Claim not yet open"],
    ["not_open", "Claim not yet open"],
    ["open", "Available to claim"],
    ["closed", "Claim window closed"],
  ] as const)("reads the %s claim window as %s", (phase, label) => {
    expect(claimStateLabel(phase)).toBe(label);
  });
});

describe("formatHivraAmount", () => {
  it("is exact to the wei with thousands separators", () => {
    expect(formatHivraAmount("1")).toBe("0.000000000000000001");
    expect(formatHivraAmount("1234567000000000000000000")).toBe("1,234,567");
    expect(formatHivraAmount("99999999999999999999999999999")).toBe("99,999,999,999.999999999999999999");
  });

  it("puts thousands separators in whole numbers such as a block", () => {
    expect(formatWholeNumber(52826055)).toBe("52,826,055");
    expect(formatWholeNumber(2049)).toBe("2,049");
    expect(formatWholeNumber(999)).toBe("999");
  });
});

describe("getOpenHivraAirdrop", () => {
  const config: HivraAirdropConfig = {
    senderAddress: "0x3B954866d4329E19C1B9165774c88508f2fefA0c",
    snapshotBlock: 36000000,
    snapshotTakenAt: null,
    snapshotUrl: "https://hivra.cloud/token/airdrop",
    claim: { campaignUrl: null, opensAt: null, closesAt: null },
  };

  it("is closed with the committed launch block, config and list (dormant)", () => {
    expect(getOpenHivraAirdrop()).toBeNull();
  });

  it("is closed while $HIVRA is dormant, the snapshot is unpublished or the list is absent", () => {
    expect(getOpenHivraAirdrop({ hivraAddress: null, config, raw: validList() })).toBeNull();
    expect(getOpenHivraAirdrop({ hivraAddress: HIVRA, config: { ...config, snapshotUrl: null }, raw: validList() })).toBeNull();
    expect(getOpenHivraAirdrop({ hivraAddress: HIVRA, config, raw: null })).toBeNull();
  });

  it("is closed when the list is malformed, in the old shape, or for another block", () => {
    expect(getOpenHivraAirdrop({ hivraAddress: HIVRA, config, raw: { ...validList(), version: 9 } })).toBeNull();
    expect(getOpenHivraAirdrop({ hivraAddress: HIVRA, config, raw: { ...validList(), version: 1 } })).toBeNull();
    expect(getOpenHivraAirdrop({ hivraAddress: HIVRA, config: { ...config, snapshotBlock: 36000001 }, raw: validList() })).toBeNull();
  });

  it("opens with the published snapshot, the Airdrop wallet, the claim and the list", () => {
    const open = getOpenHivraAirdrop({ hivraAddress: HIVRA, config, raw: validList() });
    expect(open?.snapshot).toEqual({ block: 36000000, url: "https://hivra.cloud/token/airdrop", takenAt: null });
    expect(open?.senderAddress).toBe(config.senderAddress);
    expect(open?.claim).toEqual({ phase: "unpublished", campaignUrl: null, opensAt: null, closesAt: null });
    expect(open?.airdrop.data.holders).toHaveLength(3);
  });

  it("carries the claim phase at the request time", () => {
    const claim = { campaignUrl: "https://app.sablier.com/airdrops/campaign/0xabc", opensAt: "2026-11-01T00:00:00Z", closesAt: "2026-12-01T00:00:00Z" };
    const at = (now: string) => getOpenHivraAirdrop({ hivraAddress: HIVRA, config: { ...config, claim }, raw: validList(), now: new Date(now) });
    expect(at("2026-10-31T23:59:59Z")?.claim.phase).toBe("not_open");
    expect(at("2026-11-15T00:00:00Z")?.claim.phase).toBe("open");
    expect(at("2026-12-01T00:00:00Z")?.claim.phase).toBe("closed");
  });
});
