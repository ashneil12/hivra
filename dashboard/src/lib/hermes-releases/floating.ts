import { log } from "@/lib/logger";

import { DIGEST_PATTERN, imageRepoOf } from "./policy";
import { resolveGhcrTag } from "./registry";

/**
 * The digest a floating image reference (`repo:stable`) points at right now.
 *
 * A box the release registry does not govern follows its floating tag: its
 * UPDATE pulls exactly that reference. Comparing the digest the box reported
 * with the tag's current digest is how the agent page knows a newer build is
 * waiting without a registered release. Best effort: any lookup failure
 * answers null, so the page shows no notice rather than a wrong one.
 */

const CACHE_TTL_MS = 5 * 60_000;
// A failed lookup is remembered briefly, so a GHCR outage costs one slow
// request per minute per tag instead of one per page view.
const FAILURE_TTL_MS = 60_000;
const cache = new Map<string, { digest: string | null; at: number }>();
const inFlight = new Map<string, Promise<string | null>>();

export interface FloatingImageTarget {
  imageRepo: string;
  /** The tag the box follows, or null when the reference is pinned by digest. */
  tag: string | null;
  digest: string;
}

export function splitImageReference(ref: string): { imageRepo: string; tag: string | null; digest: string | null } {
  const trimmed = ref.trim();
  const at = trimmed.indexOf("@");
  if (at >= 0) {
    const digest = trimmed.slice(at + 1);
    return { imageRepo: imageRepoOf(trimmed), tag: null, digest: DIGEST_PATTERN.test(digest) ? digest : null };
  }
  const imageRepo = imageRepoOf(trimmed);
  const tag = trimmed.length > imageRepo.length ? trimmed.slice(imageRepo.length + 1) : "latest";
  return { imageRepo, tag, digest: null };
}

export async function resolveFloatingImageTarget(
  ref: string,
  options: { fetchImpl?: typeof fetch; now?: () => number } = {}
): Promise<FloatingImageTarget | null> {
  const { imageRepo, tag, digest } = splitImageReference(ref);
  if (!tag) return digest ? { imageRepo, tag: null, digest } : null;
  // Only GHCR tags can be looked up; a box on any other image (a local
  // build, for one) has no floating tag the dashboard can read.
  if (!imageRepo.toLowerCase().startsWith("ghcr.io/")) return null;
  const now = options.now ?? Date.now;
  const key = `${imageRepo}:${tag}`;
  const cached = cache.get(key);
  if (cached && now() - cached.at < (cached.digest ? CACHE_TTL_MS : FAILURE_TTL_MS)) {
    return cached.digest ? { imageRepo, tag, digest: cached.digest } : null;
  }
  // Page views that arrive together share one lookup.
  let lookup = inFlight.get(key);
  if (!lookup) {
    lookup = resolveGhcrTag(imageRepo, tag, options.fetchImpl)
      .catch((err) => {
        log.warn("floating image tag lookup failed", {
          source: "hermes-releases/floating",
          imageRepo,
          tag,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        return null;
      })
      .then((digest) => {
        cache.set(key, { digest, at: now() });
        return digest;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, lookup);
  }
  const resolved = await lookup;
  return resolved ? { imageRepo, tag, digest: resolved } : null;
}

/** Test seam: forget cached tag lookups. */
export function clearFloatingImageCache(): void {
  cache.clear();
  inFlight.clear();
}
