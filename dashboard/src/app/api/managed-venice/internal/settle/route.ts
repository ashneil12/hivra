import { NextRequest } from "next/server";

import { apiError } from "@/lib/api-response";
import type { ManagedVeniceWalletType } from "@/lib/billing/managed-venice-wallets";
import {
  loadManagedVeniceReservationOwner,
  releaseManagedVeniceChatReservationOrFile,
} from "@/lib/venice/proxy-settlement";
import { assertManagedVeniceInternalSecret } from "@/lib/venice/internal-secret";
import { settleManagedVeniceChatUsage } from "@/lib/venice/proxy-chat-core";

export const runtime = "nodejs";

/**
 * Internal settle endpoint for the off-Vercel chat proxy (Cloudflare Worker).
 *
 * After the Worker finishes streaming a completion to the box, it POSTs the
 * `usage` frame here (or `usage:null` if none was seen, with the output it
 * forwarded as `observedOutputTokens`). This captures the actual cost against
 * the reservation, or the input estimate plus the observed output, keeping
 * the proxy key live. The Worker retries until it gets a 2xx, so a 5xx here
 * means nothing was written and the call is safe to repeat: a hold that is
 * already settled is never charged again. If the Worker never reaches here,
 * the hold expires a day after the request and the stale-hold sweep captures
 * its estimate (lib/venice/reservation-sweep.ts).
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
    if (!referenceId) {
      return apiError("Missing release fields.", 400, {
        failureType: "managed_venice_internal_release_missing_fields",
      });
    }
    // A Worker whose authorize response was lost knows only the reference it
    // chose; find the hold's owner from it.
    const owner = userId
      ? { userId, proxyKeyId }
      : await loadManagedVeniceReservationOwner(referenceId);
    if (!owner) return Response.json({ ok: true, released: false });
    const result = await releaseManagedVeniceChatReservationOrFile({
      userId: owner.userId,
      proxyKeyId: owner.proxyKeyId ?? null,
      referenceId,
      cause: typeof payload.cause === "string" ? payload.cause.slice(0, 64) : "worker_release",
      upstreamStatus: typeof payload.upstreamStatus === "number" ? payload.upstreamStatus : null,
      source: "managed-venice-internal-settle",
    });
    // Neither released nor filed for the sweep: answer 5xx so the Worker
    // retries rather than leave the hold to expire and be charged.
    if (result.failed) {
      return apiError("Release could not be recorded.", 503, {
        failureType: "managed_venice_internal_release_failed",
      });
    }
    return Response.json({ ok: true, released: result.released, filed: result.filed });
  }
  const walletType: ManagedVeniceWalletType =
    payload.walletType === "card" ? "card" : "hermesos";
  const upstreamStatus =
    typeof payload.upstreamStatus === "number" ? payload.upstreamStatus : 200;
  // `usage` is intentionally optional: null/absent means the stream finished
  // without a usage frame, which settle handles via reconciliation.
  const usage = "usage" in payload ? payload.usage : null;
  const observedOutputTokens =
    typeof payload.observedOutputTokens === "number" &&
    Number.isSafeInteger(payload.observedOutputTokens) &&
    payload.observedOutputTokens >= 0
      ? payload.observedOutputTokens
      : null;
  const cause = typeof payload.cause === "string" ? payload.cause.slice(0, 64) : null;

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
    // Sent by a Worker that counts the output it forwarded (and why the
    // stream ended); an older Worker sends neither.
    ...(observedOutputTokens !== null ? { observedOutputTokens } : {}),
    ...(cause !== null ? { cause } : {}),
  });

  return Response.json({ ok: true, ...result });
}
