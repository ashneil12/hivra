jest.mock("@/lib/billing/hivra-token-launch", () => ({
  HIVRA_TOKEN_LAUNCH: {
    contractAddress: "0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf",
    decimals: 18,
    poolId: `0x${"cd".repeat(32)}`,
    activatesAt: "2026-01-01T00:00:00Z",
  },
}));

import { hermesosTransferUri } from "@/lib/billing/eip681";
import { HERMESOS_TOKEN } from "@/lib/billing/token-registry";

const DEPOSIT = "0x000000000000000000000000000000000000fEeD";

describe("wallet links name the quote's own token", () => {
  it("links a $HIVRA quote to the $HIVRA contract", () => {
    expect(
      hermesosTransferUri({
        tokenSymbol: "HIVRA",
        tokenDecimals: 18,
        tokenAddress: "0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf",
        depositAddress: DEPOSIT,
        amountRaw: "5",
      })
    ).toBe(`ethereum:0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf@8453/transfer?address=${DEPOSIT}&uint256=5`);
  });

  it("links a $HermesOS quote to the $HermesOS contract", () => {
    expect(
      hermesosTransferUri({
        tokenSymbol: "HermesOS",
        tokenDecimals: 18,
        tokenAddress: HERMESOS_TOKEN.address,
        depositAddress: DEPOSIT,
        amountRaw: "5",
      })
    ).toContain(`ethereum:${HERMESOS_TOKEN.publishedAddress}@8453`);
  });

  it("gives no link for an unregistered token or mismatched decimals", () => {
    const base = { tokenSymbol: "HIVRA", depositAddress: DEPOSIT, amountRaw: "5" };
    expect(hermesosTransferUri({ ...base, tokenDecimals: 18, tokenAddress: "0x3333333333333333333333333333333333333333" })).toBeNull();
    expect(hermesosTransferUri({ ...base, tokenDecimals: 6, tokenAddress: "0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf" })).toBeNull();
    // A $HIVRA symbol with no address is never guessed.
    expect(hermesosTransferUri({ ...base, tokenDecimals: 18 })).toBeNull();
  });
});
