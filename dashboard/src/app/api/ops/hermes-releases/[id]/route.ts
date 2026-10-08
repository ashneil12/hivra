import { NextRequest } from "next/server";
import { z } from "zod";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { requireOpsAdmin } from "@/lib/hermes-releases/ops-auth";
import { nextStage, releaseStage, type ReleaseStage } from "@/lib/hermes-releases/policy";
import {
  haltRelease,
  loadReleases,
  promoteRelease,
  ReleaseStoreError,
  unhaltRelease,
} from "@/lib/hermes-releases/store";
import { reportOpsEvent } from "@/lib/ops-events";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const UUID = z.string().uuid();
const STAGES = ["canary", "pilot", "ten_percent", "full"] as const;

const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("promote"),
    /** Defaults to the next rung. */
    to: z.enum(STAGES).optional(),
    pilotInstanceId: UUID.optional(),
  }),
  z.object({ action: z.literal("halt"), reason: z.string().trim().min(3).max(500) }),
  z.object({ action: z.literal("unhalt") }),
]);

/** POST /api/ops/hermes-releases/[id]: promote one rung, halt or unhalt a release. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const admin = await requireOpsAdmin();
    if (!admin.ok) return apiError(admin.message, admin.status);
    if (!supabaseAdmin) return apiError("Database not configured", 500);
    const { id } = await params;
    if (!UUID.safeParse(id).success) return apiError("Invalid release id", 400);

    const parsed = Body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return apiError(parsed.error.issues[0]?.message ?? "Invalid request", 400);
    const body = parsed.data;

    if (body.action === "halt") {
      const release = await haltRelease(supabaseAdmin, id, { reason: body.reason, actor: admin.actor });
      await reportOpsEvent({
        source: "hermes-release",
        severity: "warn",
        title: `Hermes release ${release.version} halted`,
        message: `Halted by an operator: ${body.reason}. Boxes running it move back to the newest release that is not halted.`,
        route: "/api/ops/hermes-releases/[id]",
        metadata: { releaseId: id, version: release.version },
      });
      return apiSuccess({ release: { ...release, stage: releaseStage(release) } });
    }
    if (body.action === "unhalt") {
      const release = await unhaltRelease(supabaseAdmin, id, { actor: admin.actor });
      return apiSuccess({ release: { ...release, stage: releaseStage(release) } });
    }

    const current = (await loadReleases(supabaseAdmin)).find((release) => release.id === id);
    if (!current) return apiError("Release not found", 404);
    const to: ReleaseStage | null = body.to ?? nextStage(releaseStage(current));
    if (!to) return apiError("The release is already fully rolled out", 409);
    if (body.pilotInstanceId) {
      const { data: box } = await supabaseAdmin
        .from("hermes_instances")
        .select("id")
        .eq("id", body.pilotInstanceId)
        .is("deleted_at", null)
        .maybeSingle();
      if (!box) return apiError("Pilot box not found", 404);
    }
    const release = await promoteRelease(supabaseAdmin, id, {
      to,
      pilotInstanceId: body.pilotInstanceId,
      actor: admin.actor,
    });
    return apiSuccess({ release: { ...release, stage: releaseStage(release) } });
  } catch (err) {
    if (err instanceof ReleaseStoreError) return apiError(err.message, err.status);
    return handleApiError(err);
  }
}
