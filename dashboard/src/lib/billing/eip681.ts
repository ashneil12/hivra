/**
 * EIP-681 "Open in wallet" links for ERC-20 transfers on Base.
 *
 * A phone that shows a deposit QR code cannot scan itself, so crypto payment
 * surfaces also offer an `ethereum:` link that opens the user's wallet app
 * with the token, recipient and amount already filled in:
 *
 *   ethereum:<token>@8453/transfer?address=<recipient>&uint256=<raw amount>
 *
 * The link is money-moving, so it is built only when every part is known
 * exactly. Anything missing, malformed or ambiguous returns null and the
 * caller shows no link (the copy buttons and QR code still work):
 *
 *   - the chain is Base (8453), the only chain our deposit watchers read;
 *   - token and recipient are 20-byte hex addresses (checksummed or
 *     lowercase), never the zero address;
 *   - the amount is the exact raw integer in the token's smallest unit, as a
 *     base-10 string or bigint. Numbers are refused outright: a JS number
 *     cannot hold an 18-decimal token amount without rounding, and a
 *     rounded amount would not match the quote.
 *
 * Client-safe: no server imports.
 */
import { BASE_CHAIN_ID, HERMESOS_TOKEN, platformTokenByAddress } from "@/lib/billing/token-registry";

export { BASE_CHAIN_ID };

/**
 * The $HermesOS ERC-20 on Base, from the platform token registry the server
 * reads too. A $HermesOS quote settles only in this token on this chain.
 */
export const HERMESOS_BASE_TOKEN = {
  chainId: BASE_CHAIN_ID,
  address: HERMESOS_TOKEN.publishedAddress,
  symbol: HERMESOS_TOKEN.symbol,
  decimals: HERMESOS_TOKEN.decimals,
} as const;

const LEGACY_HERMESOS_SYMBOL = "Hivra";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = /^0x0{40}$/;
const RAW_INTEGER = /^[0-9]+$/;
const UINT256_LIMIT = 1n << 256n;

export interface Erc20TransferRequest {
  /** ERC-20 contract address. */
  tokenAddress: string | null | undefined;
  /** EIP-155 chain id. Only Base (8453) produces a link. */
  chainId: number | null | undefined;
  /** Address that receives the tokens (the user's deposit address). */
  recipient: string | null | undefined;
  /** Exact amount in the token's smallest unit, as a base-10 integer string or bigint. */
  amountRaw: string | bigint | null | undefined;
}

function knownAddress(value: unknown): string | null {
  if (typeof value !== "string" || !EVM_ADDRESS.test(value) || ZERO_ADDRESS.test(value)) {
    return null;
  }
  return value;
}

/** The canonical base-10 form of a positive uint256, or null. */
export function exactRawAmount(value: unknown): string | null {
  let amount: bigint;
  if (typeof value === "bigint") {
    amount = value;
  } else if (typeof value === "string" && RAW_INTEGER.test(value)) {
    amount = BigInt(value);
  } else {
    // Numbers (floats or not), decimals, exponents, signs, hex and blanks.
    return null;
  }
  if (amount <= 0n || amount >= UINT256_LIMIT) return null;
  return amount.toString(10);
}

/**
 * `ethereum:` URI for an ERC-20 transfer on Base, or null unless every input
 * is known exactly.
 */
export function buildBaseErc20TransferUri(request: Erc20TransferRequest): string | null {
  if (request.chainId !== BASE_CHAIN_ID) return null;
  const token = knownAddress(request.tokenAddress);
  const recipient = knownAddress(request.recipient);
  const amount = exactRawAmount(request.amountRaw);
  if (!token || !recipient || !amount) return null;
  return `ethereum:${token}@${BASE_CHAIN_ID}/transfer?address=${recipient}&uint256=${amount}`;
}

/**
 * Link for paying a platform-token quote ($HermesOS or $HIVRA). The token is
 * only treated as known when the quote's contract (or, for older payloads
 * without one, its symbol) names a registered platform token with the same
 * decimals, so a quote in any other asset never gets a link pointing at the
 * wrong contract.
 */
export function hermesosTransferUri(quote: {
  tokenSymbol: string | null | undefined;
  tokenDecimals: number | null | undefined;
  tokenAddress?: string | null;
  depositAddress: string | null | undefined;
  amountRaw: string | bigint | null | undefined;
}): string | null {
  let token: { publishedAddress: string; decimals: number; chainId: number } | null;
  if (quote.tokenAddress) {
    token = platformTokenByAddress(quote.tokenAddress);
  } else {
    // "Hivra" is the symbol $HermesOS quotes carried before the token
    // registry named the legacy token "HermesOS".
    token =
      quote.tokenSymbol === HERMESOS_BASE_TOKEN.symbol || quote.tokenSymbol === LEGACY_HERMESOS_SYMBOL
        ? HERMESOS_TOKEN
        : null;
  }
  if (!token || quote.tokenDecimals !== token.decimals) return null;
  return buildBaseErc20TransferUri({
    tokenAddress: token.publishedAddress,
    chainId: token.chainId,
    recipient: quote.depositAddress,
    amountRaw: quote.amountRaw,
  });
}

/** The same link, named for what it does now. */
export const platformTokenTransferUri = hermesosTransferUri;
