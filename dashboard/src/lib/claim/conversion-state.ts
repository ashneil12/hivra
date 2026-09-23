import { tokenVerificationContent } from "@/lib/token-verification-content";

import {
  CONVERSION_URL_ALLOWED_HOSTS,
  HIVRA_LAUNCH_CONFIG,
  TERMS_URL_ALLOWED_HOSTS,
  type HivraLaunchConfig,
} from "./hivra-launch-config";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const HERMESOS_CONTRACT_ADDRESS = tokenVerificationContent.tokenDetails.contractAddress;

/**
 * - dormant: $HIVRA has not launched. No contract is shown and no conversion is offered.
 * - announced: the official $HIVRA contract is published, but the terms or the
 *   conversion link are not, so nothing can be converted yet.
 * - open: contract, published terms and conversion link are all set.
 */
export type ConversionState =
  | { status: "dormant"; problems: string[] }
  | { status: "announced"; hivraTokenAddress: string; problems: string[] }
  | {
      status: "open";
      hivraTokenAddress: string;
      termsUrl: string;
      conversionUrl: string;
    };

export function normalizeAddress(value: string): string | null {
  const trimmed = value.trim();
  if (!EVM_ADDRESS.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

/** Only https links on exactly an allowed host, with no port or credentials, count; anything else is treated as unset. */
export function readAllowedUrl(value: string | null, allowed: readonly string[]): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  if (!allowed.includes(url.hostname)) return null;
  return url.toString();
}

/**
 * Decides what the convert page may show. Any value that is missing or fails
 * validation keeps the page at the most restrictive state it supports, and the
 * reason goes in `problems` so a bad launch config is visible in review and logs.
 */
export function resolveConversionState(
  config: HivraLaunchConfig = HIVRA_LAUNCH_CONFIG,
): ConversionState {
  const problems: string[] = [];

  if (!config.hivraTokenAddress) {
    return { status: "dormant", problems };
  }

  const hivra = normalizeAddress(config.hivraTokenAddress);
  if (!hivra || hivra === ZERO_ADDRESS) {
    problems.push("hivraTokenAddress is not a valid Base contract address");
    return { status: "dormant", problems };
  }
  if (hivra === normalizeAddress(HERMESOS_CONTRACT_ADDRESS)) {
    problems.push("hivraTokenAddress is the $HermesOS contract");
    return { status: "dormant", problems };
  }

  const termsUrl = readAllowedUrl(config.termsUrl, TERMS_URL_ALLOWED_HOSTS);
  if (config.termsUrl && !termsUrl) {
    problems.push("termsUrl must be https on an allowed Hivra host");
  }
  const conversionUrl = readAllowedUrl(config.conversionUrl, CONVERSION_URL_ALLOWED_HOSTS);
  if (config.conversionUrl && !conversionUrl) {
    problems.push("conversionUrl must be https on an allowed host");
  }

  // Terms are published first: a conversion link without terms stays closed.
  if (!termsUrl || !conversionUrl) {
    return { status: "announced", hivraTokenAddress: hivra, problems };
  }

  return { status: "open", hivraTokenAddress: hivra, termsUrl, conversionUrl };
}

export type TokenAddressCheck =
  | { kind: "invalid" }
  | { kind: "hermesos" }
  | { kind: "hivra" }
  | { kind: "hivra-not-launched" }
  | { kind: "not-official" };

/**
 * Tells a holder whether a pasted address is one of Hivra's tokens. The pasted
 * value is only ever compared against the configured addresses; it is never
 * used as a token, a link target or a swap input.
 */
export function checkTokenAddress(
  input: string,
  state: ConversionState = resolveConversionState(),
): TokenAddressCheck {
  const address = normalizeAddress(input);
  if (!address) return { kind: "invalid" };
  if (address === normalizeAddress(HERMESOS_CONTRACT_ADDRESS)) return { kind: "hermesos" };
  if (state.status === "dormant") return { kind: "hivra-not-launched" };
  if (address === state.hivraTokenAddress) return { kind: "hivra" };
  return { kind: "not-official" };
}
