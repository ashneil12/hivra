export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { z } from "zod";

import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import { enforceRateLimit, getIP } from "@/lib/rate-limit";
import { exchangeWorkspaceCloudHandoffCode } from "@/lib/services/workspace-cloud-handoff";

const ROUTE = "/api/workspace-cloud/handoff/exchange";

const ExchangeSchema = z.object({
  code: z.string().min(16).max(512),
  // PKCE code_verifier — only for the browser-redirect flow; omitted for paste-a-code.
  verifier: z.string().min(43).max(128).optional(),
  // Optional per-user model creds the Workspace pushes onto its agent at
  // connect time (BYO). Format is re-validated (strict allowlist) in the
  // provisioner before it ever touches a shell.
  modelApiKey: z.string().min(8).max(256).optional(),
  model: z.string().min(1).max(128).optional(),
});

/**
 * Exchange a one-time code + PKCE verifier for the connection bundle.
 *
 * Intentionally NOT Clerk-authed: the Workspace client is a machine with no
 * Clerk session. The code is the bearer of authorization — it was minted only
 * after the owning user authenticated and authorized the connection at
 * /api/workspace-cloud/handoff, is single-use, short-lived, and only yields a
 * bundle for the exact user+instance it was bound to. The PKCE verifier proves
 * the caller is the same client that began the flow.
 */
export async function POST(request: NextRequest) {
  try {
    const ip = getIP(request);
    const { success } = enforceRateLimit(`workspace_cloud_exchange_${ip}`, {
      limit: 30,
      windowMs: 60 * 1000,
    });
    if (!success) return apiError("Too Many Requests", 429, undefined, undefined, { route: ROUTE });

    const parsed = ExchangeSchema.safeParse(await request.json());
    if (!parsed.success) return apiError(parsed.error.issues[0].message, 400, undefined, undefined, { route: ROUTE });

    const result = await exchangeWorkspaceCloudHandoffCode({
      code: parsed.data.code,
      verifier: parsed.data.verifier,
      modelConfig: parsed.data.modelApiKey
        ? { apiKey: parsed.data.modelApiKey, model: parsed.data.model || "" }
        : undefined,
    });
    if (!result.ok) {
      return apiError(result.error, result.status, undefined, undefined, { route: ROUTE });
    }

    return apiSuccess(result.bundle);
  } catch (err) {
    return handleApiError(err);
  }
}
