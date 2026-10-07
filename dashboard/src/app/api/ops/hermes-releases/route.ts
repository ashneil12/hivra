import { NextRequest } from "next/server";
import { z } from "zod";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { requireOpsAdmin } from "@/lib/hermes-releases/ops-auth";
import { DIGEST_PATTERN, releaseStage, type HermesRelease } from "@/lib/hermes-releases/policy";
import { ReleaseRegistryError, resolveGhcrTag } from "@/lib/hermes-releases/registry";
import {
  loadReleaseHealth,
  loadReleases,
  registerRelease,
  ReleaseStoreError,
} from "@/lib/hermes-releases/store";
import { reportOpsEvent } from "@/lib/ops-events";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const RegisterBody = z
  .object({
    imageRepo: z.string().trim().min(3).max(200),
    /** Resolve the digest from the registry by tag... */
    tag: z.string().trim().min(1).max(128).optional(),
    /** ...or supply it. */
    digest: z.string().trim().regex(DIGEST_PATTERN).optional(),
    version: z.string().trim().min(1).max(128).optional(),
    notes: z.string().trim().max(500).optional(),
  })
  .refine((body) => body.tag || (body.digest && body.version), {
    message: "Provide a tag, or a digest together with a version",
  });

interface AttentionBox {
  instanceId: string;
  name: string | null;
  updateHealth: string;
  detail: string | null;
  at: string | null;
  digest: string | null;
  version: string | null;
}

/**
 * GET /api/ops/hermes-releases: every release with its stage, how many boxes
 * run it and how it is doing, plus the boxes whose update stack is paused,
 * failed or rolled back.
 */
export async function GET() {
  try {
    const admin = await requireOpsAdmin();
    if (!admin.ok) return apiError(admin.message, admin.status);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const releases = await loadReleases(supabaseAdmin);
    const { data: boxes, error } = await supabaseAdmin
      .from("hermes_instances")
      .select("id, name, agent_image_digest, agent_version, update_health, update_health_detail, update_health_at, update_stack_version")
      .is("deleted_at", null)
      .neq("status", "deleted")
      .limit(5000);
    if (error) return apiError("Failed to load boxes", 500);

    const rows = (boxes ?? []) as unknown as Array<{
      id: string;
      name: string | null;
      agent_image_digest: string | null;
      agent_version: string | null;
      update_health: string | null;
      update_health_detail: string | null;
      update_health_at: string | null;
      update_stack_version: number | null;
    }>;
    const boxesByDigest = new Map<string, number>();
    let reporting = 0;
    let onNewStack = 0;
    for (const row of rows) {
      if (row.agent_image_digest) {
        reporting += 1;
        boxesByDigest.set(row.agent_image_digest, (boxesByDigest.get(row.agent_image_digest) ?? 0) + 1);
      }
      if ((row.update_stack_version ?? 0) >= 2) onNewStack += 1;
    }

    const withHealth = await Promise.all(
      releases.map(async (release: HermesRelease) => ({
        ...release,
        stage: releaseStage(release),
        boxes: boxesByDigest.get(release.digest) ?? 0,
        health: await loadReleaseHealth(supabaseAdmin!, release.id),
      }))
    );
    const versionByDigest = new Map(releases.map((release) => [release.digest, release.version]));
    const attention: AttentionBox[] = rows
      .filter((row) => row.update_health && row.update_health !== "ok")
      .map((row) => ({
        instanceId: row.id,
        name: row.name,
        updateHealth: row.update_health as string,
        detail: row.update_health_detail,
        at: row.update_health_at,
        digest: row.agent_image_digest,
        version: row.agent_image_digest ? versionByDigest.get(row.agent_image_digest) ?? row.agent_version : null,
      }))
      .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));

    return apiSuccess({
      releases: withHealth,
      attention,
      fleet: { total: rows.length, reporting, onNewUpdateStack: onNewStack },
    });
  } catch (err) {
    return handleApiError(err);
  }
}

/** POST /api/ops/hermes-releases: register an immutable image as a release (canary channel, not yet promoted). */
export async function POST(request: NextRequest) {
  try {
    const admin = await requireOpsAdmin();
    if (!admin.ok) return apiError(admin.message, admin.status);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const parsed = RegisterBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return apiError(parsed.error.issues[0]?.message ?? "Invalid request", 400);
    const body = parsed.data;

    let digest = body.digest;
    if (body.tag && !digest) {
      try {
        digest = await resolveGhcrTag(body.imageRepo, body.tag);
      } catch (err) {
        if (err instanceof ReleaseRegistryError) return apiError(err.message, 422);
        throw err;
      }
    }
    const { release, created } = await registerRelease(supabaseAdmin, {
      imageRepo: body.imageRepo,
      version: body.version ?? body.tag ?? "",
      digest: digest as string,
      actor: admin.actor,
      notes: body.notes,
    });
    if (created) {
      await reportOpsEvent({
        source: "hermes-release",
        severity: "info",
        title: `Hermes release ${release.version} registered`,
        message: `Registered ${release.image_repo} ${release.version} as a release. It is not offered to any box until promoted to the canary stage.`,
        route: "/api/ops/hermes-releases",
        metadata: { releaseId: release.id, version: release.version },
      });
    }
    return apiSuccess({ release: { ...release, stage: releaseStage(release) }, created }, created ? 201 : 200);
  } catch (err) {
    if (err instanceof ReleaseStoreError) return apiError(err.message, err.status);
    return handleApiError(err);
  }
}
