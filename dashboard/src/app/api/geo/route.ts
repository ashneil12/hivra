import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { isConsentRequiredCountry } from "@/lib/consent/cookie-consent";

// Returns the visitor's coarse geo + whether prior opt-in consent is required
// for analytics/session-replay, derived server-side from Vercel's
// `x-vercel-ip-country` edge header. The cookie-consent banner calls this once
// on mount to decide whether to gate PostHog.
//
// Why a Route Handler (not Proxy/middleware):
//   - Next 16 allows exactly one Proxy file and we already have one
//     (`src/proxy.ts`) wiring Clerk auth. Folding consent/geo logic into the
//     auth path is risk we don't need.
//   - Reading `headers()` makes THIS handler request-time dynamic on its own,
//     so static pages are never deopted — the cost is scoped to this endpoint.
//   - `/api/geo` is not in the protected-route matchers, so Clerk passes it
//     through unauthenticated for both signed-out and signed-in visitors.
//
// `headers()` is a request-time API, so this route is dynamic by default; the
// explicit `force-dynamic` documents intent and guards against accidental
// prerender/caching of one visitor's country.
export const dynamic = "force-dynamic";

export async function GET() {
  const headerStore = await headers();
  const raw = headerStore.get("x-vercel-ip-country");
  // Normalize: Vercel sends ISO-3166 alpha-2; "XX"/"T1" (Tor/unknown) and an
  // absent header all collapse to null, which isConsentRequiredCountry treats
  // as consent-REQUIRED (fail safe).
  const normalized = raw ? raw.trim().toUpperCase() : null;
  // Vercel emits "XX" (and "T1") for unknown / anonymized / Tor IPs. Collapse
  // those — and anything not a real ISO-3166 alpha-2 — to null so they hit the
  // consent-REQUIRED fail-safe rather than being read as a real country.
  const country =
    normalized && normalized !== "XX" && /^[A-Z]{2}$/.test(normalized)
      ? normalized
      : null;

  const response = NextResponse.json({
    country,
    consentRequired: isConsentRequiredCountry(country),
  });
  // Per-visitor + privacy-sensitive: must never be shared/cached.
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
}
