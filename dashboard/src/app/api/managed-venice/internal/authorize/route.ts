import { NextRequest } from "next/server";

import { apiError } from "@/lib/api-response";
import { assertManagedVeniceInternalSecret } from "@/lib/venice/internal-secret";
import { authorizeManagedVeniceChat } from "@/lib/venice/proxy-chat-core";

export const runtime = "nodejs";

/**
 * Internal authorize endpoint for the off-Vercel chat proxy (Cloudflare Worker).
 *
 * The Worker POSTs `{ plaintextKey, body, referenceId }` here (`referenceId`, a
 * fresh UUID the Worker chose, is optional); this verifies the proxy key,
 * reserves wallet funds, and resolves the upstream Venice key — then returns the
 * authorized context so the Worker can hold the long-lived stream itself. All
 * wallet/billing logic stays on Vercel; only the byte-pump moves to the edge.
 * See docs/PRODUCT-ARCHITECTURE.md.
 *
 * Responses:
 *  - 200 `{ ok:true, referenceId, upstreamKey, upstreamUrl, walletType, ... }`
 *  - 401/400/402/503 — relay-able errors (bad key, bad model, no balance, not
 *    configured). The Worker forwards these to the box verbatim.
 *  - 403 — wrong/missing internal secret (Worker config error; not relay-able).
 */
export async function POST(req: NextRequest) {
  const denied = assertManagedVeniceInternalSecret(req);
  if (denied) return denied;

  let payload: { plaintextKey?: unknown; body?: unknown; referenceId?: unknown };
  try {
    payload = (await req.json()) as { plaintextKey?: unknown; body?: unknown; referenceId?: unknown };
  } catch {
    return apiError("Invalid JSON body.", 400);
  }

  const plaintextKey =
    typeof payload.plaintextKey === "string" ? payload.plaintextKey : null;
  const body =
    payload.body && typeof payload.body === "object" && !Array.isArray(payload.body)
      ? (payload.body as Record<string, unknown>)
      : null;
  if (!body) {
    return apiError("Missing chat completion body.", 400, {
      failureType: "managed_venice_internal_authorize_missing_body",
    });
  }

  // The Worker chooses the hold's reference so it can release the hold even if
  // this response never reaches it. An older Worker sends none.
  const referenceId = typeof payload.referenceId === "string" ? payload.referenceId : undefined;
  const auth = await authorizeManagedVeniceChat({ plaintextKey, body, referenceId });
  if (!auth.ok) return auth.response;

  return Response.json({
    ok: true,
    referenceId: auth.value.referenceId,
    upstreamKey: auth.value.upstreamKey,
    upstreamUrl: auth.value.upstreamUrl,
    walletType: auth.value.walletType,
    userId: auth.value.userId,
    proxyKeyId: auth.value.proxyKeyId,
    model: auth.value.model,
  });
}
