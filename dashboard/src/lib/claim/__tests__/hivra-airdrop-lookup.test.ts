import {
  formatHivraAmount,
  lookupHivraAirdrop,
  normalizeLookupAddress,
  parseHivraAirdropData,
} from "../hivra-airdrop-lookup";
import { getOpenHivraAirdrop } from "../hivra-airdrop-data";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const HASH = `0x${"ab".repeat(32)}`;
const HIVRA = "0x1111111111111111111111111111111111111111";

function validList() {
  return {
    version: 1,
    snapshotBlock: 36000000,
    decimals: 18,
    ratio: "1:1",
    totals: { holders: 3, includedWei: "6500000000000000001", excludedWallets: 1, excludedWei: "9", percentOfSupply: "0.01" },
    batches: [
      { index: 1, recipients: 2, totalWei: "6000000000000000000", tx: HASH },
      { index: 2, recipients: 1, totalWei: "500000000000000001", tx: null },
    ],
    holders: [
      { address: A(1), amountWei: "4000000000000000000", batch: 1 },
      { address: A(0xa1), amountWei: "2000000000000000000", remapped: true, sent: true },
      { address: A(2), amountWei: "500000000000000001", batch: 2 },
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
  });

  it.each([
    ["the committed placeholder", null],
    ["a wrong version", { ...validList(), version: 2 }],
    ["a total that does not add up", { ...validList(), totals: { ...validList().totals, includedWei: "6500000000000000000" } }],
    ["a batch sum that does not add up", { ...validList(), batches: [validList().batches[0], { ...validList().batches[1], totalWei: "1" }] }],
    ["a holder in a batch that does not exist", { ...validList(), holders: [...validList().holders.slice(0, 2), { address: A(2), amountWei: "500000000000000001", batch: 3 }] }],
    ["a managed wallet that carries a batch", { ...validList(), holders: [validList().holders[0], { ...validList().holders[1], batch: 1 }, validList().holders[2]] }],
    ["a managed wallet that carries its destination", { ...validList(), holders: [validList().holders[0], { ...validList().holders[1], sendTo: A(5) }, validList().holders[2]] }],
    ["an upper-case address", { ...validList(), holders: [{ ...validList().holders[0], address: A(0xab).toUpperCase().replace("0X", "0x") }, ...validList().holders.slice(1)] }],
    ["a float amount", { ...validList(), holders: [{ ...validList().holders[0], amountWei: "4e18" }, ...validList().holders.slice(1)] }],
    ["a malformed tx hash", { ...validList(), batches: [{ ...validList().batches[0], tx: "0x12" }, validList().batches[1]] }],
    ["a wallet both included and excluded", { ...validList(), excluded: [{ address: A(1), label: "x" }] }],
  ])("rejects %s", (_name, raw) => {
    expect(parseHivraAirdropData(raw).ok).toBe(false);
  });
});

describe("lookupHivraAirdrop", () => {
  const airdrop = parsed();

  it("answers a holder with the amount and the batch transaction once sent", () => {
    expect(lookupHivraAirdrop(airdrop, `  ${A(1)}  `)).toEqual({ kind: "holder", address: A(1), amountWei: "4000000000000000000", sentTx: HASH });
    expect(lookupHivraAirdrop(airdrop, A(2))).toEqual({ kind: "holder", address: A(2), amountWei: "500000000000000001", sentTx: null });
  });

  it("answers a Hivra-managed wallet without any destination or transaction", () => {
    expect(lookupHivraAirdrop(airdrop, A(0xa1).replace("a1", "A1"))).toEqual({ kind: "managed", address: A(0xa1), amountWei: "2000000000000000000", sent: true });
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

describe("formatHivraAmount", () => {
  it("is exact to the wei with thousands separators", () => {
    expect(formatHivraAmount("1")).toBe("0.000000000000000001");
    expect(formatHivraAmount("1234567000000000000000000")).toBe("1,234,567");
    expect(formatHivraAmount("99999999999999999999999999999")).toBe("99,999,999,999.999999999999999999");
  });
});

describe("getOpenHivraAirdrop", () => {
  const config = { senderAddress: "0x3B954866d4329E19C1B9165774c88508f2fefA0c", snapshotBlock: 36000000, snapshotUrl: "https://hivra.cloud/token/airdrop", sentAt: null };

  it("is closed with the committed launch block, config and list (dormant)", () => {
    expect(getOpenHivraAirdrop()).toBeNull();
  });

  it("is closed while $HIVRA is dormant, the snapshot is unpublished or the list is absent", () => {
    expect(getOpenHivraAirdrop({ hivraAddress: null, config, raw: validList() })).toBeNull();
    expect(getOpenHivraAirdrop({ hivraAddress: HIVRA, config: { ...config, snapshotUrl: null }, raw: validList() })).toBeNull();
    expect(getOpenHivraAirdrop({ hivraAddress: HIVRA, config, raw: null })).toBeNull();
  });

  it("is closed when the list is malformed or for another block", () => {
    expect(getOpenHivraAirdrop({ hivraAddress: HIVRA, config, raw: { ...validList(), version: 9 } })).toBeNull();
    expect(getOpenHivraAirdrop({ hivraAddress: HIVRA, config: { ...config, snapshotBlock: 36000001 }, raw: validList() })).toBeNull();
  });

  it("opens with the published snapshot, the sender and the list", () => {
    const open = getOpenHivraAirdrop({ hivraAddress: HIVRA, config, raw: validList() });
    expect(open?.snapshot).toEqual({ block: 36000000, url: "https://hivra.cloud/token/airdrop" });
    expect(open?.senderAddress).toBe(config.senderAddress);
    expect(open?.airdrop.data.holders).toHaveLength(3);
  });
});
