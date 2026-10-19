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

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = /^0x0{40}$/i;
// UTC only, to the second, like hivra-token-launch.ts: "2026-10-01T16:00:00Z".
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

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

export type AirdropSnapshot = { block: number; url: string };

/**
 * What the page may say about this user's tier:
 * - unknown: $HIVRA is not live yet, or the access engine can't be read.
 * - hermesos: grandfathered, not switched, and switching is not offered yet
 *   because the airdrop has not been sent. Their $HermesOS access continues.
 * - switch-available: grandfathered, not switched, and the airdrop has been
 *   sent, so they may choose to switch their tier to $HIVRA.
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
 * - launched: the registry names $HIVRA (scheduled or live). The airdrop facts
 *   that are published (sender, snapshot, sent time) are shown; the rest stay
 *   hidden until a reviewed PR fills them in.
 */
export type ConversionState =
  | { status: "dormant"; problems: string[] }
  | {
      status: "launched";
      hivraAddress: string;
      hivraPublishedAddress: string;
      /** The airdrop sender exactly as configured, or null. */
      senderAddress: string | null;
      snapshot: AirdropSnapshot | null;
      /** Set once every airdrop transfer is confirmed; never without a snapshot. */
      sentAt: string | null;
      access: ConversionAccess;
      problems: string[];
    };

export function normalizeAddress(value: string): string | null {
  const trimmed = value.trim();
  if (!EVM_ADDRESS.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

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

function readUtcInstant(value: string): number | null {
  if (!UTC_INSTANT.test(value)) return null;
  const ms = Date.parse(value);
  // Date.parse rolls impossible dates over (2026-02-30 → 2026-03-02); refuse them.
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19)) return null;
  return ms;
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
    sentAt: facts.sentAt,
    access: resolveAccess(phase, access, facts.sentAt),
    problems: facts.problems,
  };
}

export type AirdropFacts = {
  senderAddress: string | null;
  snapshot: AirdropSnapshot | null;
  sentAt: string | null;
  problems: string[];
};

/**
 * The airdrop facts that may be shown once $HIVRA (`hivraAddress`, lower-cased)
 * is in the registry. Pass `now: null` to skip sentAt (a client render must not
 * depend on the viewer's clock). Invalid values are left out and reported.
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

  let snapshot: AirdropSnapshot | null = null;
  const block = airdrop.snapshotBlock;
  const blockValid = block !== null && Number.isSafeInteger(block) && block > 0;
  if (block !== null && !blockValid) problems.push("snapshotBlock must be a positive whole block number");
  const snapshotUrl = readAllowedUrl(airdrop.snapshotUrl, SNAPSHOT_URL_ALLOWED_LOCATIONS);
  if (airdrop.snapshotUrl && !snapshotUrl) problems.push("snapshotUrl must be https on an allowed Hivra location");
  if (blockValid && snapshotUrl) snapshot = { block: block as number, url: snapshotUrl };

  let sentAt: string | null = null;
  const sent = airdrop.sentAt?.trim() ?? "";
  if (sent && now) {
    const sentMs = readUtcInstant(sent);
    if (sentMs === null) problems.push("sentAt must be a real UTC instant to the second, e.g. 2026-10-02T16:00:00Z");
    else if (!snapshot) problems.push("sentAt is set but the snapshot is not published");
    else if (sentMs > now.getTime()) problems.push("sentAt is in the future");
    else sentAt = new Date(sentMs).toISOString();
  }

  return { senderAddress, snapshot, sentAt, problems };
}

function resolveAccess(phase: HivraTokenPhase, access: ConversionAccessGate, sentAt: string | null): ConversionAccess {
  // The switch (POST /api/billing/token-access) needs $HIVRA live, and the
  // user's access must be readable, or the page could cost them their tier.
  if (phase !== "active" || !access) return { kind: "unknown" };
  if (access.grandfathered && !access.convertedAt) {
    // Offer the switch only once the airdrop is in wallets: after the switch's
    // grace only $HIVRA counts, so switching before it arrives could drop the tier.
    return sentAt ? { kind: "switch-available" } : { kind: "hermesos" };
  }
  return { kind: "hivra", graceEndsAt: access.convertedAt ? access.conversionGraceEndsAt : null };
}

export type TokenAddressCheck =
  | { kind: "invalid" }
  | { kind: "hermesos" }
  | { kind: "hivra" }
  | { kind: "airdrop-sender" }
  | { kind: "hivra-not-launched" }
  | { kind: "not-official" };

/**
 * Tells a holder whether a pasted address is one of Hivra's tokens, or Hivra's
 * airdrop wallet. The pasted value is only ever compared against the registry
 * and the airdrop config; it is never used as a token, a link target or a swap
 * input.
 */
export function checkTokenAddress(input: string, state: ConversionState): TokenAddressCheck {
  const address = normalizeAddress(input);
  if (!address) return { kind: "invalid" };
  if (address === HERMESOS_TOKEN.address) return { kind: "hermesos" };
  if (state.status === "dormant") return { kind: "hivra-not-launched" };
  if (address === state.hivraAddress) return { kind: "hivra" };
  if (state.senderAddress && address === state.senderAddress.toLowerCase()) return { kind: "airdrop-sender" };
  return { kind: "not-official" };
}
