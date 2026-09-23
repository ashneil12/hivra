import {
  BASE_CHAIN_ID,
  HERMESOS_BASE_TOKEN,
  buildBaseErc20TransferUri,
  exactRawAmount,
  hermesosTransferUri,
} from "@/lib/billing/eip681";
import {
  BASE_CHAIN_ID as SERVER_BASE_CHAIN_ID,
  HERMESOS_TOKEN_ADDRESS,
  HERMESOS_TOKEN_DECIMALS,
  HERMESOS_TOKEN_SYMBOL,
} from "@/lib/billing/token-holdings";

const HERMESOS_CONTRACT = "0x95ccfD2B81A9667b0Cc979992632F98fc853EBa3";
const DEPOSIT = "0x000000000000000000000000000000000000fEeD";

function request(overrides: Partial<Parameters<typeof buildBaseErc20TransferUri>[0]> = {}) {
  return {
    tokenAddress: HERMESOS_CONTRACT,
    chainId: BASE_CHAIN_ID,
    recipient: DEPOSIT,
    amountRaw: "19600000000000000000000000",
    ...overrides,
  };
}

describe("buildBaseErc20TransferUri", () => {
  it("builds the EIP-681 transfer link with the exact raw amount", () => {
    expect(buildBaseErc20TransferUri(request())).toBe(
      `ethereum:${HERMESOS_CONTRACT}@8453/transfer?address=${DEPOSIT}&uint256=19600000000000000000000000`
    );
  });

  it("keeps amounts far beyond Number precision exact, as a decimal string", () => {
    // 2^53 + 1 cannot be represented as a JS number; 10^30 + 7 neither.
    expect(buildBaseErc20TransferUri(request({ amountRaw: "9007199254740993" }))).toContain(
      "&uint256=9007199254740993"
    );
    expect(buildBaseErc20TransferUri(request({ amountRaw: "1000000000000000000000000000007" }))).toContain(
      "&uint256=1000000000000000000000000000007"
    );
    expect(buildBaseErc20TransferUri(request({ amountRaw: 123456789012345678901234567890n }))).toContain(
      "&uint256=123456789012345678901234567890"
    );
  });

  it("never uses scientific notation or a decimal point", () => {
    const uri = buildBaseErc20TransferUri(request({ amountRaw: "100000000000000000000000000000" }))!;
    expect(uri).not.toMatch(/e\+|\d\.\d/i);
  });

  it("accepts checksummed and lowercase addresses and keeps them as given", () => {
    expect(buildBaseErc20TransferUri(request())).toContain(`ethereum:${HERMESOS_CONTRACT}@`);
    const lower = buildBaseErc20TransferUri(
      request({ tokenAddress: HERMESOS_CONTRACT.toLowerCase(), recipient: DEPOSIT.toLowerCase() })
    );
    expect(lower).toBe(
      `ethereum:${HERMESOS_CONTRACT.toLowerCase()}@8453/transfer?address=${DEPOSIT.toLowerCase()}&uint256=19600000000000000000000000`
    );
  });

  it.each([
    ["token", { tokenAddress: null }],
    ["token (undefined)", { tokenAddress: undefined }],
    ["recipient", { recipient: null }],
    ["recipient (empty)", { recipient: "" }],
    ["amount", { amountRaw: null }],
    ["amount (undefined)", { amountRaw: undefined }],
    ["chain id", { chainId: null }],
  ])("returns null when the %s is missing", (_label, overrides) => {
    expect(buildBaseErc20TransferUri(request(overrides))).toBeNull();
  });

  it("returns null for any chain other than Base", () => {
    expect(buildBaseErc20TransferUri(request({ chainId: 1 }))).toBeNull();
    expect(buildBaseErc20TransferUri(request({ chainId: 84532 }))).toBeNull();
  });

  it.each([
    ["too short", "0x1234"],
    ["no 0x prefix", "95ccfD2B81A9667b0Cc979992632F98fc853EBa3"],
    ["non-hex", "0x95ccfD2B81A9667b0Cc979992632F98fc853EBaZ"],
    ["padded with spaces", ` ${HERMESOS_CONTRACT} `],
    ["the zero address", "0x0000000000000000000000000000000000000000"],
  ])("rejects a token address that is %s", (_label, tokenAddress) => {
    expect(buildBaseErc20TransferUri(request({ tokenAddress }))).toBeNull();
  });

  it("rejects the zero address as the recipient", () => {
    expect(
      buildBaseErc20TransferUri(request({ recipient: "0x0000000000000000000000000000000000000000" }))
    ).toBeNull();
  });

  it.each([
    ["a decimal", "1.5"],
    ["an exponent", "1e18"],
    ["a negative", "-1"],
    ["hex", "0x10"],
    ["blank", ""],
    ["padded", " 10"],
    ["zero", "0"],
    ["zero (bigint)", 0n],
    ["negative (bigint)", -5n],
  ])("rejects %s amount", (_label, amountRaw) => {
    expect(buildBaseErc20TransferUri(request({ amountRaw }))).toBeNull();
  });

  it("refuses JS numbers, even whole ones, so a float can never slip through", () => {
    // Runtime guard for untyped callers: numbers lose precision past 2^53.
    const unsafe = request({ amountRaw: 1e21 as unknown as string });
    expect(buildBaseErc20TransferUri(unsafe)).toBeNull();
    expect(buildBaseErc20TransferUri(request({ amountRaw: 5 as unknown as string }))).toBeNull();
  });

  it("rejects amounts that overflow uint256", () => {
    const max = (1n << 256n) - 1n;
    expect(buildBaseErc20TransferUri(request({ amountRaw: max.toString() }))).toContain(`&uint256=${max}`);
    expect(buildBaseErc20TransferUri(request({ amountRaw: (max + 1n).toString() }))).toBeNull();
  });

  it("normalises leading zeros without changing the value", () => {
    expect(exactRawAmount("000123")).toBe("123");
  });
});

describe("hermesosTransferUri", () => {
  const quote = {
    tokenSymbol: "Hivra",
    tokenDecimals: 18,
    depositAddress: DEPOSIT,
    amountRaw: "1000000000000000000000",
  };

  it("uses the $HermesOS contract on Base", () => {
    expect(hermesosTransferUri(quote)).toBe(
      `ethereum:${HERMESOS_BASE_TOKEN.address}@8453/transfer?address=${DEPOSIT}&uint256=1000000000000000000000`
    );
  });

  it("returns null for a quote in another token or with other decimals", () => {
    expect(hermesosTransferUri({ ...quote, tokenSymbol: "USDC" })).toBeNull();
    expect(hermesosTransferUri({ ...quote, tokenDecimals: 6 })).toBeNull();
    expect(hermesosTransferUri({ ...quote, tokenDecimals: undefined })).toBeNull();
  });

  it("returns null when the deposit address or raw amount is unknown", () => {
    expect(hermesosTransferUri({ ...quote, depositAddress: null })).toBeNull();
    expect(hermesosTransferUri({ ...quote, amountRaw: undefined })).toBeNull();
  });

  it("matches the token the server settles quotes in", () => {
    expect(HERMESOS_BASE_TOKEN.address.toLowerCase()).toBe(HERMESOS_TOKEN_ADDRESS);
    expect(HERMESOS_BASE_TOKEN.symbol).toBe(HERMESOS_TOKEN_SYMBOL);
    expect(HERMESOS_BASE_TOKEN.decimals).toBe(HERMESOS_TOKEN_DECIMALS);
    expect(HERMESOS_BASE_TOKEN.chainId).toBe(SERVER_BASE_CHAIN_ID);
  });
});
