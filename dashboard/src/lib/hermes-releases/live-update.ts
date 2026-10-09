import type { SupabaseClient } from "@supabase/supabase-js";

import { log } from "@/lib/logger";
import type { UpdateImagePolicy } from "@/lib/services/webui-instance-builder";

import { NOFORK_LOCAL_REPO } from "@/lib/services/no-fork-migration-builder";

import { loadBoxRelease, type BoxReleaseState } from "./box";
import { releaseImageRef } from "./policy";

/**
 * What an update should do about the agent image:
 *   release: this update is meant to bring the box onto its release (the
 *            UPDATE NOW button, the fleet-sync cron).
 *   current: this update is something else (a config redeploy, a resize,
 *            recovery) and must leave the image the box runs alone.
 */
export type UpdateImageIntent = "release" | "current";

export interface ResolvedUpdateImage {
  /** Undefined while the registry does not govern the box: follow the floating tag as before. */
  policy: UpdateImagePolicy | undefined;
  state: BoxReleaseState | null;
}

// PostgREST / Postgres codes for "the registry's tables or columns are not
// there yet" (an environment the migration has not reached).
const REGISTRY_MISSING_CODES = new Set(["42P01", "42703", "PGRST205", "PGRST204"]);

export function isRegistryMissingError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return typeof code === "string" && REGISTRY_MISSING_CODES.has(code);
}

/**
 * Decide the image policy for one update. A box the registry does not govern
 * (no release of its repository, or the registry tables are not in this
 * database yet) keeps its old behaviour exactly. For a governed box, only an
 * update with release intent and a newer eligible release moves it; every other
 * update keeps the image it runs.
 */
export async function resolveUpdateImagePolicy(
  db: SupabaseClient,
  instanceId: string,
  intent: UpdateImageIntent
): Promise<ResolvedUpdateImage> {
  let state: BoxReleaseState | null;
  try {
    state = await loadBoxRelease(db, instanceId);
  } catch (err) {
    if (isRegistryMissingError(err)) return { policy: undefined, state: null };
    throw err;
  }
  // A box that follows upstream Hermes by itself owns its image (stock upstream plus its own
  // overlay tools, tagged locally). The control plane never pulls or moves it.
  if (state?.imageRepo === NOFORK_LOCAL_REPO) return { policy: { kind: "keep" }, state };
  if (!state || !state.governed) return { policy: undefined, state };

  const target = state.decision.target;
  if (intent === "release" && target && state.decision.updateAvailable) {
    log.info("update pinned to release", {
      source: "hermes-releases",
      instanceId,
      version: target.version,
      direction: state.decision.direction,
    });
    return { policy: { kind: "pinned", ref: releaseImageRef(target), digest: target.digest }, state };
  }
  return { policy: { kind: "keep" }, state };
}
