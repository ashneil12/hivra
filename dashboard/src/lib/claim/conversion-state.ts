import {
  HERMESOS_TOKEN,
  getConfiguredHivraToken,
  getHivraTokenPhase,
  type HivraTokenPhase,
  type PlatformToken,
} from "@/lib/billing/token-registry";

import {
  HIVRA_AIRDROP,
  SNAPSHOT_URL_ALLOWED_LOCATIONS,
  type HivraAirdropConfig,
} from "./hivra-airdrop-config";
import { NO_CLAIM, readUtcInstant, resolveHivraClaim, type ResolvedHivraClaim } from "./hivra-claim";
import { normalizeAddress, type AddressCheckState } from "./token-address-check";

// The pasted-address check lives in token-address-check.ts so the client form
// does not import this file (and, through it, the airdrop config). Re-exported
// here for the callers that already import it from this file.
export { checkTokenAddress, normalizeAddress, type AddressCheckState, type TokenAddressCheck } from "./token-address-check";

const ZERO_ADDRESS = /^0x0{40}$/i;

/** $HermesOS exactly as published, for display. */
export const HERMESOS_CONTRACT_ADDRESS = HERMESOS_TOKEN.publishedAddress;

/**
 * This user's platform-token access (lib/billing/token-access.ts), reduced to
 * what decides whether moving $HermesOS out of their verified wallet is safe
 * for their tier:
 * - grandfathered and not yet switched: their tier still counts $HermesOS, so
 *   moving it out drops them below it. They can switch their access first.
 * - switched, or not grandfathered: their tier counts $HIVRA.
 * Null means the access engine can't say (surface off, or it failed).
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
  airdrop: HivraAirdropConfig;
  access: ConversionAccessGate;
  now: Date;
};

/**
 * The published snapshot. `takenAt` is the UTC instant it was taken (ISO 8601),
 * or null when it is not set, invalid, or (with a clock) in the future.
 */
export type AirdropSnapshot = { block: number; url: string; takenAt: string | null };

/**
 * What the page may say about this user's tier:
 * - unknown: $HIVRA is not live yet, or the access engine can't be read.
 * - hermesos: grandfathered, not switched, and switching is not offered yet
 *   because the claim window has not closed. Their $HermesOS access continues.
 * - switch-available: grandfathered, not switched, and the claim window has
 *   closed, so they may choose to switch their tier to $HIVRA.
 * - hivra: their tier counts $HIVRA. graceEndsAt is set for a holder who
 *   switched: either token keeps the tier until then.
 */
export type ConversionAccess =
  | { kind: "unknown" }
  | { kind: "hermesos" }
  | { kind: "switch-available" }
  | { kind: "hivra"; graceEndsAt: string | null };

/**
 * - dormant: $HIVRA is not in the token registry. No contract and nothing about
 *   the airdrop is shown.
 * - launched: the registry names $HIVRA (scheduled or live). The claim facts
 *   that are published (Airdrop wallet, snapshot, claim window) are shown; the
 *   rest stay hidden until a reviewed PR fills them in.
 */
export type ConversionState =
  | { status: "dormant"; problems: string[] }
  | {
      status: "launched";
      hivraAddress: string;
      hivraPublishedAddress: string;
      /** The Airdrop wallet (it funds the Sablier campaign) exactly as configured, or null. */
      senderAddress: string | null;
      snapshot: AirdropSnapshot | null;
      /** The Sablier claim: its phase at `now`, and the validated link and window (hivra-claim.ts). */
      claim: ResolvedHivraClaim;
      access: ConversionAccess;
      problems: string[];
    };

/**
 * Only https links on exactly an allowed host, under that host's path prefix,
 * with no port or credentials, count; anything else is treated as unset. The
 * path is checked after URL normalisation, so dot segments can't escape it.
 */
export function readAllowedUrl(
  value: string | null,
  allowed: readonly { host: string; pathPrefix: string }[],
): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const location = allowed.find((entry) => entry.host === url.hostname);
  if (!location || !url.pathname.startsWith(location.pathPrefix)) return null;
  return url.toString();
}

/** Reads the registry and airdrop config at `now`. The access gate is per user, so the caller supplies it. */
export function readConversionInputs(access: ConversionAccessGate, now: Date = new Date()): ConversionInputs {
  return {
    hivra: getConfiguredHivraToken(),
    phase: getHivraTokenPhase(now),
    airdrop: HIVRA_AIRDROP,
    access,
    now,
  };
}

/**
 * Decides what the $HIVRA-for-holders page may show. Anything missing or
 * invalid is left out; a set but rejected value goes in `problems` so a bad
 * launch value is visible in review and logs.
 */
export function resolveConversionState({ hivra, phase, airdrop, access, now }: ConversionInputs): ConversionState {
  if (!hivra || phase === "dormant") return { status: "dormant", problems: [] };
  const facts = resolveAirdropFacts(airdrop, hivra.address, now);
  return {
    status: "launched",
    hivraAddress: hivra.address,
    hivraPublishedAddress: hivra.publishedAddress,
    senderAddress: facts.senderAddress,
    snapshot: facts.snapshot,
    claim: facts.claim ?? NO_CLAIM,
    // The claim only counts as closed once the snapshot it belongs to is published.
    access: resolveAccess(phase, access, facts.snapshot !== null && facts.claim?.phase === "closed"),
    problems: facts.problems,
  };
}

export type AirdropFacts = {
  senderAddress: string | null;
  snapshot: AirdropSnapshot | null;
  /** The Sablier claim at `now`; null when no clock was given. */
  claim: ResolvedHivraClaim | null;
  problems: string[];
};

/**
 * What /token shows about the airdrop: the published snapshot and the Airdrop
 * wallet, and nothing else. /token is a client component, so the server resolves
 * this and passes it down (getTokenPageAirdropFacts in hivra-airdrop-data.ts);
 * the page never imports the airdrop config, which also holds the Sablier
 * campaign link and the claim window, and sends them to every viewer.
 */
export type TokenPageAirdropFacts = {
  snapshot: AirdropSnapshot | null;
  senderAddress: string | null;
};

/**
 * The airdrop facts that may be shown once $HIVRA (`hivraAddress`, lower-cased)
 * is in the registry. Pass `now: null` to skip everything that depends on the
 * clock (the claim phase, and the check that snapshotTakenAt is not in the
 * future): a client render must not depend on the viewer's clock. Invalid
 * values are left out and reported.
 */
export function resolveAirdropFacts(airdrop: HivraAirdropConfig, hivraAddress: string, now: Date | null): AirdropFacts {
  const problems: string[] = [];
  let senderAddress: string | null = null;
  const sender = airdrop.senderAddress?.trim() ?? "";
  if (sender) {
    const normalized = normalizeAddress(sender);
    if (!normalized || ZERO_ADDRESS.test(sender)) {
      problems.push("senderAddress must be a non-zero 0x-prefixed 20-byte address");
    } else if (normalized === HERMESOS_TOKEN.address || normalized === hivraAddress.toLowerCase()) {
      problems.push("senderAddress is a token contract, not the airdrop wallet");
    } else {
      senderAddress = sender;
    }
  }

  let takenAt: string | null = null;
  const taken = airdrop.snapshotTakenAt?.trim() ?? "";
  if (taken) {
    const takenMs = readUtcInstant(taken);
    if (takenMs === null) problems.push("snapshotTakenAt must be a real UTC instant to the second, e.g. 2026-10-20T16:00:00Z");
    else if (now && takenMs > now.getTime()) problems.push("snapshotTakenAt is in the future");
    else takenAt = new Date(takenMs).toISOString();
  }

  let snapshot: AirdropSnapshot | null = null;
  const block = airdrop.snapshotBlock;
  const blockValid = block !== null && Number.isSafeInteger(block) && block > 0;
  if (block !== null && !blockValid) problems.push("snapshotBlock must be a positive whole block number");
  const snapshotUrl = readAllowedUrl(airdrop.snapshotUrl, SNAPSHOT_URL_ALLOWED_LOCATIONS);
  if (airdrop.snapshotUrl && !snapshotUrl) problems.push("snapshotUrl must be https on an allowed Hivra location");
  if (blockValid && snapshotUrl) snapshot = { block: block as number, url: snapshotUrl, takenAt };

  let claim: ResolvedHivraClaim | null = null;
  if (now) {
    const resolved = resolveHivraClaim(airdrop.claim, now);
    claim = resolved.claim;
    problems.push(...resolved.problems);
  }

  return { senderAddress, snapshot, claim, problems };
}

function resolveAccess(phase: HivraTokenPhase, access: ConversionAccessGate, claimClosed: boolean): ConversionAccess {
  // The switch (POST /api/billing/token-access) needs $HIVRA live, and the
  // user's access must be readable, or the page could cost them their tier.
  if (phase !== "active" || !access) return { kind: "unknown" };
  if (access.grandfathered && !access.convertedAt) {
    // Offer the switch only once the claim window has closed (the conservative
    // gate): after the switch's grace only $HIVRA counts, so switching while
    // holders can still claim could drop a tier.
    return claimClosed ? { kind: "switch-available" } : { kind: "hermesos" };
  }
  return { kind: "hivra", graceEndsAt: access.convertedAt ? access.conversionGraceEndsAt : null };
}

/**
 * What the "Check a token address" form is given: the two addresses it compares
 * with, and nothing else. The form is a client component, so everything passed
 * to it reaches the browser, including a viewer the token geo-policy blocks and
 * a viewer before the claim opens. The whole ConversionState would carry the
 * Sablier campaign link, the claim window, the snapshot link and any config
 * problems with it; this carries none of them.
 *
 * Dormant, the state has no data to leave out, so it is passed as it is.
 */
export function addressCheckStateOf(state: ConversionState): AddressCheckState {
  if (state.status === "dormant") return state;
  return { status: "launched", hivraAddress: state.hivraAddress, senderAddress: state.senderAddress };
}
