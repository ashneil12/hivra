import { readCryptoTopUpIntent } from "../format";

const USDC_CONTRACT = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

function payload(amountMinor: unknown) {
  return {
    intent: {
      referenceId: "crypto_topup:test",
      packageCredits: 1000,
      amountDisplay: "10",
      depositAddress: "0x000000000000000000000000000000000000fEeD",
      amountMinor,
      asset: { symbol: "USDC", network: "Base", tokenAddress: USDC_CONTRACT, chainId: 8453 },
    },
  };
}

describe("readCryptoTopUpIntent", () => {
  it("keeps the exact raw amount, token and chain the server sent", () => {
    const intent = readCryptoTopUpIntent(payload(10_000_000));
    expect(intent?.amountRaw).toBe("10000000");
    expect(intent?.asset.tokenAddress).toBe(USDC_CONTRACT);
    expect(intent?.asset.chainId).toBe(8453);
  });

  it("drops an amount that is not an exact positive integer", () => {
    expect(readCryptoTopUpIntent(payload(10.5))?.amountRaw).toBeUndefined();
    expect(readCryptoTopUpIntent(payload(0))?.amountRaw).toBeUndefined();
    expect(readCryptoTopUpIntent(payload("1e7"))?.amountRaw).toBeUndefined();
    expect(readCryptoTopUpIntent(payload(undefined))?.amountRaw).toBeUndefined();
  });
});
