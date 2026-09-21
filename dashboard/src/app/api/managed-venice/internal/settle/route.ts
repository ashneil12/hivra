import { NextRequest } from "next/server";

import { apiError } from "@/lib/api-response";
import type { ManagedVeniceWalletType } from "@/lib/billing/managed-venice-wallets";
import { releaseManagedVeniceChatReservation } from "@/lib/venice/proxy-settlement";
import { assertManagedVeniceInternalSecret } from "@/lib/venice/internal-secret";
import { settleManagedVeniceChatUsage } from "@/lib/venice/proxy-chat-core";

export const runtime = "nodejs";

/**
 * Internal settle endpoint for the off-Vercel chat proxy (Cloudflare Worker).
 *
 * After the Worker finishes streaming a completion to the box, it POSTs the
 * `usage` frame here (or `usage:null` if none was seen). This captures the
 * actual cost against the reservation, or files a reconciliation item while
 * keeping the proxy key live. The orphaned-reservation backstop remains the
 * `managed-venice-token-reconciliation` cron if the Worker never reaches here.
 * See docs/PRODUCT-ARCHITECTURE.md.
 */
export async function POST(req: NextRequest) {
  const denied = assertManagedVeniceInternalSecret(req);
  if (denied) return denied;

  let payload: Record<string, unknown>;
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch {
    return apiError("Invalid JSON body.", 400);
  }

  const userId = typeof payload.userId === "string" ? payload.userId : null;
  const proxyKeyId =
    typeof payload.proxyKeyId === "string" ? payload.proxyKeyId : null;
  const referenceId =
    typeof payload.referenceId === "string" ? payload.referenceId : null;
  const model = typeof payload.model === "string" ? payload.model : null;
  // "release" returns the held reservation (upstream failed before producing
  // billable usage — mirrors the in-Vercel route's releaseReservation on a
  // fetch error / non-2xx). "settle" (default) captures actual usage.
  const outcome = payload.outcome === "release" ? "release" : "settle";

  if (outcome === "release") {
    if (!userId || !referenceId) {
      return apiError("Missing release fields.", 400, {
        failureType: "managed_venice_internal_release_missing_fields",
      });
    }
    await releaseManagedVeniceChatReservation({ userId, referenceId });
    return Response.json({ ok: true, released: true });
  }
  const walletType: ManagedVeniceWalletType =
    payload.walletType === "card" ? "card" : "hermesos";
  const upstreamStatus =
    typeof payload.upstreamStatus === "number" ? payload.upstreamStatus : 200;
  // `usage` is intentionally optional: null/absent means the stream finished
  // without a usage frame, which settle handles via reconciliation.
  const usage = "usage" in payload ? payload.usage : null;

  if (!userId || !proxyKeyId || !referenceId || !model) {
    return apiError("Missing settlement fields.", 400, {
      failureType: "managed_venice_internal_settle_missing_fields",
    });
  }

  const result = await settleManagedVeniceChatUsage({
    userId,
    proxyKeyId,
    walletType,
    referenceId,
    model,
    upstreamStatus,
    usage,
  });

  return Response.json({ ok: true, ...result });
}
