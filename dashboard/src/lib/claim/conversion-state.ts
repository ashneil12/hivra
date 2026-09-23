import {
  HERMESOS_TOKEN,
  getConfiguredHivraToken,
  getHivraTokenPhase,
  type HivraTokenPhase,
  type PlatformToken,
} from "@/lib/billing/token-registry";

import {
  CONVERSION_LINKS,
  CONVERSION_URL_ALLOWED_HOSTS,
  TERMS_URL_ALLOWED_HOSTS,
  type ConversionLinksConfig,
} from "./conversion-links-config";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** $HermesOS exactly as published, for display. */
export const HERMESOS_CONTRACT_ADDRESS = HERMESOS_TOKEN.publishedAddress;

/**
 * This user's platform-token access (lib/billing/token-access.ts), reduced to
 * what decides whether swapping $HermesOS is safe for their tier:
 * - grandfathered and not yet switched: their tier still counts $HermesOS, so a
 *   swap would drop them below it. They must switch their access first.
 * - switched, or not grandfathered: their tier counts $HIVRA, so a swap is safe.
 * Null means the access engine can't say (surface off, or it failed), and
 * conversion stays closed.
 */
export type ConversionAccessGate = {
  grandfathered: boolean;
  convertedAt: string | null;
  /** End of the post-switch window in which either token keeps the tier. */
  conversionGraceEndsAt: string | null;
} | null;

export type ConversionInputs = {
  hivra: PlatformToken | null;
  phase: HivraTokenPhase;
  links: ConversionLinksConfig;
  access: ConversionAccessGate;
};

/**
 * - dormant: $HIVRA is not in the token registry. No contract is shown and no conversion is offered.
 * - announced: the registry names $HIVRA, but it is not live yet, the terms or
 *   conversion link are not published, or this user's access can't be read, so
 *   nothing can be converted.
 * - switch-access: everything is in place, but this user's tier still counts
 *   $HermesOS. They must switch their access to $HIVRA before swapping.
 * - open: all of the above are in place and this user's tier counts $HIVRA.
 */
export type ConversionState =
  | { status: "dormant"; problems: string[] }
  | { status: "announced"; hivraAddress: string; hivraPublishedAddress: string; problems: string[] }
  | {
      status: "switch-access";
      hivraAddress: string;
      hivraPublishedAddress: string;
      termsUrl: string;
    }
  | {
      status: "open";
      hivraAddress: string;
      hivraPublishedAddress: string;
      termsUrl: string;
      conversionUrl: string;
      /** Set for a holder who switched: either token keeps their tier until then. */
      graceEndsAt: string | null;
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

/** Reads the registry and link config at `now`. The access gate is per user, so the caller supplies it. */
export function readConversionInputs(access: ConversionAccessGate, now: Date = new Date()): ConversionInputs {
  return {
    hivra: getConfiguredHivraToken(),
    phase: getHivraTokenPhase(now),
    links: CONVERSION_LINKS,
    access,
  };
}

/**
 * Decides what the convert page may show. Anything missing or invalid keeps the
 * page at the most restrictive state it supports; a set but rejected link goes
 * in `problems` so a bad launch value is visible in review and logs.
 */
export function resolveConversionState({ hivra, phase, links, access }: ConversionInputs): ConversionState {
  const problems: string[] = [];
  if (!hivra || phase === "dormant") return { status: "dormant", problems };

  const termsUrl = readAllowedUrl(links.termsUrl, TERMS_URL_ALLOWED_HOSTS);
  if (links.termsUrl && !termsUrl) problems.push("termsUrl must be https on an allowed Hivra host");
  const conversionUrl = readAllowedUrl(links.conversionUrl, CONVERSION_URL_ALLOWED_HOSTS);
  if (links.conversionUrl && !conversionUrl) problems.push("conversionUrl must be https on an allowed host");

  const announced = {
    status: "announced" as const,
    hivraAddress: hivra.address,
    hivraPublishedAddress: hivra.publishedAddress,
    problems,
  };
  // Terms are published first, $HIVRA must be live, and the user's access must
  // be readable, or converting could cost them their tier.
  if (phase !== "active" || !termsUrl || !conversionUrl || !access) return announced;
  if (access.grandfathered && !access.convertedAt) {
    return {
      status: "switch-access",
      hivraAddress: hivra.address,
      hivraPublishedAddress: hivra.publishedAddress,
      termsUrl,
    };
  }

  return {
    status: "open",
    hivraAddress: hivra.address,
    hivraPublishedAddress: hivra.publishedAddress,
    termsUrl,
    conversionUrl,
    graceEndsAt: access.convertedAt ? access.conversionGraceEndsAt : null,
  };
}

export type TokenAddressCheck =
  | { kind: "invalid" }
  | { kind: "hermesos" }
  | { kind: "hivra" }
  | { kind: "hivra-not-launched" }
  | { kind: "not-official" };

/**
 * Tells a holder whether a pasted address is one of Hivra's tokens. The pasted
 * value is only ever compared against the registry addresses; it is never used
 * as a token, a link target or a swap input.
 */
export function checkTokenAddress(input: string, state: ConversionState): TokenAddressCheck {
  const address = normalizeAddress(input);
  if (!address) return { kind: "invalid" };
  if (address === HERMESOS_TOKEN.address) return { kind: "hermesos" };
  if (state.status === "dormant") return { kind: "hivra-not-launched" };
  if (address === state.hivraAddress) return { kind: "hivra" };
  return { kind: "not-official" };
}
