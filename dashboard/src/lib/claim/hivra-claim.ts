/**
 * The Sablier claim window: what phase it is in and the one link that is safe
 * to show.
 *
 * Eligible $HermesOS holders claim their $HIVRA themselves on Sablier. This
 * file reads `HIVRA_AIRDROP.claim` (hivra-airdrop-config.ts) and answers:
 *
 *   unpublished  no valid campaign link. Nothing about the claim is shown.
 *   not_open     a valid campaign link and an opening time that is still ahead.
 *   open         a valid campaign link, and the window has opened and has not
 *                closed (a missing opensAt or closesAt means no limit on that side).
 *   closed       a valid campaign link and the closing time has passed.
 *
 * Every set value is checked. The campaign link must be https on exactly
 * app.sablier.com, with no credentials, port, fragment, backslash, whitespace,
 * percent-encoding or dot segments, so a lookalike host, a redirect-style
 * trick or a path escape is never shown as Hivra's claim. The two instants
 * must be real UTC instants to the second, with opensAt before closesAt.
 *
 * A set but invalid value is reported in `problems` and the WHOLE claim stays
 * unpublished: dropping only a bad opensAt would open the claim early, and
 * dropping only a bad closesAt would leave it open for ever.
 *
 * Client-safe: type-only imports.
 */
import type { HivraClaimConfig } from "./hivra-airdrop-config";

export type HivraClaimPhase = "unpublished" | "not_open" | "open" | "closed";

export type ResolvedHivraClaim = {
  phase: HivraClaimPhase;
  /** The validated campaign link; null only while the phase is "unpublished". */
  campaignUrl: string | null;
  /** ISO 8601 UTC with milliseconds, e.g. "2026-10-21T16:00:00.000Z"; null if not set (or unpublished). */
  opensAt: string | null;
  closesAt: string | null;
};

export const SABLIER_HOST = "app.sablier.com";
export const NO_CLAIM: ResolvedHivraClaim = { phase: "unpublished", campaignUrl: null, opensAt: null, closesAt: null };

// UTC only, to the second, like hivra-token-launch.ts: "2026-10-01T16:00:00Z".
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
// https://app.sablier.com, then an optional path and query of plain URL characters
// and nothing else: no userinfo (@ before the host), port, fragment, backslash,
// whitespace, percent-encoding or non-ASCII character can appear anywhere.
const URL_CHARS = "A-Za-z0-9\\-._~!$&'()*+,;=:@";
const SABLIER_URL = new RegExp(`^https://app\\.sablier\\.com(?:/[${URL_CHARS}/]*)?(?:\\?[${URL_CHARS}/?]*)?$`, "i");
const MAX_URL_LENGTH = 2048;

/** Milliseconds for a real UTC instant to the second ("2026-10-02T16:00:00Z"), else null. */
export function readUtcInstant(value: string): number | null {
  if (!UTC_INSTANT.test(value)) return null;
  const ms = Date.parse(value);
  // Date.parse rolls impossible dates over (2026-02-30 → 2026-03-02); refuse them.
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19)) return null;
  return ms;
}

/** The normalised Sablier campaign link, or null when it is anything but a plain https link on app.sablier.com. */
export function readSablierCampaignUrl(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH || !SABLIER_URL.test(value)) return null;
  // The raw path is checked, not the normalised one: "/a/../b" must not be quietly rewritten to "/b".
  const rawPath = value.slice("https://app.sablier.com".length).split("?")[0];
  if (rawPath.split("/").some((segment) => segment === "." || segment === "..")) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== SABLIER_HOST || url.username || url.password || url.port || url.hash) return null;
  return url.toString();
}

/**
 * Reads `claim` at `now`. A missing config reads as nothing published. Anything
 * set but invalid is named in `problems` and leaves the whole claim unpublished.
 */
export function resolveHivraClaim(
  claim: HivraClaimConfig | null | undefined,
  now: Date,
): { claim: ResolvedHivraClaim; problems: string[] } {
  const problems: string[] = [];
  const config = claim ?? { campaignUrl: null, opensAt: null, closesAt: null };

  const rawUrl = typeof config.campaignUrl === "string" ? config.campaignUrl : null;
  const campaignUrl = rawUrl === null ? null : readSablierCampaignUrl(rawUrl);
  if (rawUrl !== null && campaignUrl === null) problems.push("claim.campaignUrl must be a plain https link on app.sablier.com");

  const readWindowEnd = (name: "opensAt" | "closesAt", value: string | null | undefined): number | null => {
    if (value === null || value === undefined) return null;
    const ms = typeof value === "string" ? readUtcInstant(value) : null;
    if (ms === null) problems.push(`claim.${name} must be a real UTC instant to the second, e.g. 2026-10-21T16:00:00Z`);
    return ms;
  };
  const opensMs = readWindowEnd("opensAt", config.opensAt);
  const closesMs = readWindowEnd("closesAt", config.closesAt);
  if (opensMs !== null && closesMs !== null && opensMs >= closesMs) {
    problems.push("claim.opensAt must be before claim.closesAt");
  }

  // Any problem keeps the whole claim hidden (see the top of this file).
  if (problems.length > 0 || campaignUrl === null) return { claim: NO_CLAIM, problems };

  const nowMs = now.getTime();
  const phase: HivraClaimPhase = closesMs !== null && closesMs <= nowMs
    ? "closed"
    : opensMs !== null && opensMs > nowMs
      ? "not_open"
      : "open";
  return {
    claim: {
      phase,
      campaignUrl,
      opensAt: opensMs === null ? null : new Date(opensMs).toISOString(),
      closesAt: closesMs === null ? null : new Date(closesMs).toISOString(),
    },
    problems,
  };
}

/** The Sablier link to show: the validated campaign link while the claim is open, else null. */
export function claimHrefOf(claim: ResolvedHivraClaim | null | undefined): string | null {
  return claim?.phase === "open" ? claim.campaignUrl : null;
}

/** "21 October 2026 at 16:00 UTC" (en-GB, always UTC). */
export function formatUtcInstant(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}
