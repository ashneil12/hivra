// Hivra agent templates — public shared view by share_token (GET).
//
// Wave 5.2. Anyone with the link (a 48-hex share_token) can read a shared
// template's identity to preview + "use this template" (fork on launch). This
// read is intentionally UNAUTHENTICATED: the unguessable share_token IS the
// capability, so a logged-out recipient of a share link can view it (the whole
// point of a public share). getPublicTemplateByShareToken only ever resolves a
// link|public template by its token, strips the owner's free-text `context`,
// returns a key-free llm_config, and exposes no owner identity/PII — so there is
// nothing private to leak. Private/revoked templates have no token (and are
// rejected as defense-in-depth) so they remain unreachable. The launch (fork)
// action stays auth-gated downstream — only this read is public. Still gated by
// isHivraApiAllowed (the surface is canary-only).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import type { NextRequest } from "next/server";

import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import { getPublicTemplateByShareToken } from "@/lib/hivra/agent-templates";

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    if (!isHivraApiAllowed(req.headers.get("host"))) return apiError("Not found", 404);
    const { token } = await params;

    // No session required: the share_token is the access capability and the
    // response carries no private/owner data (see getPublicTemplateByShareToken).
    const template = await getPublicTemplateByShareToken(token);
    if (!template) return apiError("Template not found", 404);
    return apiSuccess({ template });
  } catch (err) {
    return handleApiError(err);
  }
}
