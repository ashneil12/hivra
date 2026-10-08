import { NextRequest } from "next/server";
import { z } from "zod";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import {
  CI_IMMUTABLE_TAG,
  CI_MAX_NEW_RELEASES_PER_HOUR,
  isAllowedCiImageRepo,
  requireCiToken,
} from "@/lib/hermes-releases/ci-auth";
import { DIGEST_PATTERN, releaseStage } from "@/lib/hermes-releases/policy";
import { ReleaseRegistryError, resolveGhcrTag } from "@/lib/hermes-releases/registry";
import {
  loadReleases,
  registerRelease,
  ReleaseStoreError,
  reportReleaseRegistered,
} from "@/lib/hermes-releases/store";
import { enforceRateLimit, getIP } from "@/lib/rate-limit";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const ROUTE = "/api/ops/hermes-releases/ci";
const SOURCE = "hermes-release-ci";
const HOUR_MS = 60 * 60 * 1000;

/**
 * Strict on purpose: a field for a stage, channel, halt or rollout is an error,
 * not something quietly ignored, so a caller can never believe it set one.
 */
const CiRegisterBody = z
  .object({
    imageRepo: z.string().trim().min(3).max(200),
    tag: z.string().trim().regex(CI_IMMUTABLE_TAG, "Tag must be an immutable build tag ending in -<7 hex commit>"),
    /** Optional cross-check: the digest the workflow proved. Refused if the registry says otherwise. */
    digest: z.string().trim().regex(DIGEST_PATTERN).optional(),
    notes: z.string().trim().max(500).optional(),
  })
  .strict();

/**
 * POST /api/ops/hermes-releases/ci: the fork's CI registers an immutable image
 * it built and proved. Auth is a bearer token (HERMES_RELEASE_CI_TOKEN), not a
 * Clerk session; the route is outside the Clerk-protected prefixes and
 * authenticates itself.
 *
 * Scope is registration only. The release lands at the "registered" stage
 * (canary channel, 0% rollout, never promoted), where no box is offered it. The
 * digest is always resolved from GHCR by tag, so CI cannot register bytes the
 * registry does not hold under that tag. An already-registered image returns the
 * existing release and changes nothing, including a halted one.
 */
export async function POST(request: NextRequest) {
  try {
    // Before the token check, so guessing the token is braked too.
    const limit = enforceRateLimit(`hermes_release_ci:${getIP(request)}`, { limit: 20, windowMs: 60_000 });
    if (!limit.success) {
      const response = apiError("Too many requests", 429, undefined, undefined, {
        route: ROUTE,
        source: SOURCE,
        failureType: "release_ci_rate_limited",
      });
      response.headers.set("Retry-After", String(Math.max(1, Math.ceil(limit.retryAfterMs / 1000))));
      return response;
    }

    const caller = requireCiToken(request);
    if (!caller.ok) {
      return apiError(caller.message, caller.status, undefined, undefined, {
        route: ROUTE,
        source: SOURCE,
        failureType: caller.status === 401 ? "release_ci_unauthorized" : "release_ci_not_configured",
      });
    }
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const parsed = CiRegisterBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return apiError(parsed.error.issues[0]?.message ?? "Invalid request", 400);
    const body = parsed.data;

    const imageRepo = body.imageRepo.toLowerCase();
    if (!isAllowedCiImageRepo(imageRepo)) {
      return apiError("Image repository is not allowed for CI registration", 400, undefined, undefined, {
        route: ROUTE,
        source: SOURCE,
        failureType: "release_ci_repo_not_allowed",
      });
    }

    let digest: string;
    try {
      digest = await resolveGhcrTag(imageRepo, body.tag);
    } catch (err) {
      if (err instanceof ReleaseRegistryError) return apiError(err.message, 422);
      throw err;
    }
    if (body.digest && body.digest !== digest) {
      return apiError("The registry holds a different digest for that tag", 409, undefined, undefined, {
        route: ROUTE,
        source: SOURCE,
        failureType: "release_ci_digest_mismatch",
      });
    }

    // A repeat of an image already registered is free; only genuinely new
    // releases count toward the hourly cap.
    const known = await loadReleases(supabaseAdmin, imageRepo);
    if (!known.some((release) => release.digest === digest)) {
      const since = Date.now() - HOUR_MS;
      const recent = known.filter(
        (release) => release.created_by === caller.actor && Date.parse(release.created_at) >= since
      ).length;
      if (recent >= CI_MAX_NEW_RELEASES_PER_HOUR) {
        const response = apiError("Too many new releases from CI this hour", 429, undefined, undefined, {
          route: ROUTE,
          source: SOURCE,
          failureType: "release_ci_hourly_cap",
        });
        response.headers.set("Retry-After", "600");
        return response;
      }
    }

    const { release, created } = await registerRelease(supabaseAdmin, {
      imageRepo,
      version: body.tag,
      digest,
      actor: caller.actor,
      notes: body.notes,
    });
    if (created) await reportReleaseRegistered(release, caller.actor);

    return apiSuccess(
      {
        release: {
          id: release.id,
          version: release.version,
          digest: release.digest,
          stage: releaseStage(release),
          halted: release.halted,
        },
        created,
      },
      created ? 201 : 200
    );
  } catch (err) {
    if (err instanceof ReleaseStoreError) return apiError(err.message, err.status);
    return handleApiError(err);
  }
}
