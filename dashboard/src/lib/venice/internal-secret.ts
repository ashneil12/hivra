import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

import { apiError } from "@/lib/api-response";

/**
 * Header carrying the shared secret between the off-Vercel Cloudflare Worker
 * and the internal managed-Venice endpoints (`/api/managed-venice/internal/*`).
 * The Worker is the only legitimate caller of those endpoints — they expose the
 * resolved upstream Venice key (authorize) and settle wallets (settle), so they
 * must never be open to the public internet.
 */
const MANAGED_VENICE_INTERNAL_SECRET_HEADER =
  "x-managed-venice-internal-secret";

/**
 * Returns `null` when the caller presented the correct internal secret, or an
 * error Response to return otherwise:
 *  - 503 when the secret is not configured (fail closed — endpoints disabled).
 *  - 403 on mismatch. Distinct from the 401/402 a proxy key produces so the
 *    Worker can tell "my config is wrong" (→ 502 to the box) apart from "the
 *    box's key/balance is the problem" (→ relay verbatim).
 */
export function assertManagedVeniceInternalSecret(
  req: NextRequest
): Response | null {
  const expected = process.env.MANAGED_VENICE_INTERNAL_SECRET?.trim();
  if (!expected) {
    return apiError(
      "Managed Venice internal endpoints are not configured.",
      503,
      { failureType: "managed_venice_internal_secret_unset" }
    );
  }

  const provided = req.headers
    .get(MANAGED_VENICE_INTERNAL_SECRET_HEADER)
    ?.trim();
  if (!provided) {
    return apiError("Forbidden", 403, {
      failureType: "managed_venice_internal_secret_missing",
    });
  }

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return apiError("Forbidden", 403, {
      failureType: "managed_venice_internal_secret_mismatch",
    });
  }

  return null;
}
