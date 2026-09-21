// Hivra agent templates — change visibility (PATCH) + delete (DELETE).
//
// Wave 5.2. Visibility transitions (private | link | public) mint/keep a
// share_token on link/public and clear it on private. Owner-scoped: every op is
// gated on owner_user_id, so a user can only mutate their own templates.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import { setTemplateVisibility, deleteTemplate } from "@/lib/hivra/agent-templates";

// PATCH /api/hivra/templates/[id] { visibility } — private | link | public.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isHivraApiAllowed(req.headers.get("host"))) return apiError("Not found", 404);
    const { id } = await params;
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const visibility = typeof body.visibility === "string" ? body.visibility : "";
    if (visibility !== "private" && visibility !== "link" && visibility !== "public") {
      return apiError("visibility must be private, link, or public", 400);
    }

    const template = await setTemplateVisibility(userId, id, visibility);
    if (!template) return apiError("Template not found", 404);
    return apiSuccess({ template });
  } catch (err) {
    return handleApiError(err);
  }
}

// DELETE /api/hivra/templates/[id].
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isHivraApiAllowed(req.headers.get("host"))) return apiError("Not found", 404);
    const { id } = await params;
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);

    const ok = await deleteTemplate(userId, id);
    if (!ok) return apiError("Template not found", 404);
    return apiSuccess({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
