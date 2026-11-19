// Sends the Google Analytics `sign_up` conversion from the server.
//
// Only while NEXT_PUBLIC_HIVRA_GA_PUBLIC_PAGES_ONLY is on (lib/telemetry/
// ga-config). Google Analytics then never loads on a signed-in page, so the
// browser cannot send the conversion that happens there. The browser calls this
// route once, at the first signed-in render of a new account, and only when the
// visitor has accepted analytics.
//
// The server checks again before sending: the account is signed in and less
// than an hour old, the stored consent choice is "accepted", and GA's own
// `_ga` cookie is present (GA set it on a public page, which it only does with
// consent). The event carries GA's client id and session id from those
// cookies, the sign-up method and the fixed-list "heard about" answer. No
// email, name or user id is sent.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import type { NextRequest } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { CONSENT_COOKIE_NAME, parseConsentCookieValue } from "@/lib/consent/cookie-consent";
import { log } from "@/lib/logger";
import { readHeardAboutAnswer } from "@/lib/signup/heard-about";
import { GOOGLE_ANALYTICS_ID, isGaPublicPagesOnly } from "@/lib/telemetry/ga-config";
import {
  gaClientIdFromCookie,
  gaSessionCookieName,
  gaSessionIdFromCookie,
  sendGaMeasurementProtocolEvent,
} from "@/lib/telemetry/ga-measurement-protocol";
import { isSameOriginMutationRequest } from "@/app/api/infrastructure/connections/request-security";

// Same window as the browser's sign-up detection (PostHogProvider).
const SIGN_UP_RECENCY_WINDOW_MS = 60 * 60 * 1000;

type SkipReason = "no_consent" | "no_ga_cookie" | "not_a_new_account" | "not_configured" | "send_failed";

function noStore(response: Response) {
  response.headers.set("Cache-Control", "no-store, private");
  return response;
}

function skipped(reason: SkipReason) {
  return noStore(apiSuccess({ sent: false, reason }, 202));
}

type SignUpUser = {
  createdAt?: number | null;
  externalAccounts?: ReadonlyArray<{ provider?: string | null }> | null;
  primaryEmailAddressId?: string | null;
  unsafeMetadata?: unknown;
};

// GA4's sign_up `method`: the OAuth provider, or email. Never an address.
function signUpMethod(user: SignUpUser): string {
  const provider = user.externalAccounts?.find((account) => typeof account?.provider === "string")?.provider;
  if (provider) return provider.replace(/^oauth_/, "");
  return user.primaryEmailAddressId ? "email" : "clerk";
}

export async function POST(request: NextRequest) {
  if (!isGaPublicPagesOnly()) {
    return noStore(apiError("Not found", 404, undefined, { code: "feature_disabled" }));
  }
  if (!isSameOriginMutationRequest(request)) {
    return noStore(apiError("Forbidden", 403));
  }
  const { userId } = await auth();
  if (!userId) return noStore(apiError("Unauthorized", 401));

  const limited = enforceAuthenticatedRouteRateLimit(request, {
    routeKey: "telemetry_ga_sign_up",
    userId,
    limit: 3,
    windowMs: 60 * 60 * 1000,
  });
  if (limited) return noStore(limited);

  if (parseConsentCookieValue(request.cookies.get(CONSENT_COOKIE_NAME)?.value)?.choice !== "accepted") {
    return skipped("no_consent");
  }
  const clientId = gaClientIdFromCookie(request.cookies.get("_ga")?.value);
  if (!clientId) return skipped("no_ga_cookie");

  const apiSecret = process.env.GA_MEASUREMENT_PROTOCOL_API_SECRET?.trim();
  if (!apiSecret) {
    log.warn("GA sign-up not sent: GA_MEASUREMENT_PROTOCOL_API_SECRET is not set", {
      source: "telemetry.ga_sign_up",
      route: "/api/telemetry/ga-sign-up",
      failureType: "ga_mp_secret_missing",
    });
    return skipped("not_configured");
  }

  const clerk = await clerkClient();
  const user = (await clerk.users.getUser(userId)) as unknown as SignUpUser;
  const createdAt = typeof user.createdAt === "number" ? user.createdAt : null;
  if (createdAt === null || Date.now() - createdAt > SIGN_UP_RECENCY_WINDOW_MS) {
    return skipped("not_a_new_account");
  }

  const heardAbout = readHeardAboutAnswer(user.unsafeMetadata);
  const result = await sendGaMeasurementProtocolEvent({
    measurementId: GOOGLE_ANALYTICS_ID,
    apiSecret,
    clientId,
    sessionId: gaSessionIdFromCookie(request.cookies.get(gaSessionCookieName(GOOGLE_ANALYTICS_ID))?.value),
    name: "sign_up",
    params: {
      method: signUpMethod(user),
      // A fixed-list value; the free-text "other" detail stays out of GA.
      ...(heardAbout ? { heard_about: heardAbout.heard_about } : {}),
    },
  });
  if (!result.ok) {
    log.warn("GA sign-up not sent: Measurement Protocol refused or failed", {
      source: "telemetry.ga_sign_up",
      route: "/api/telemetry/ga-sign-up",
      failureType: "ga_mp_send_failed",
      ...(result.status !== undefined ? { status: result.status } : {}),
    }, result.error ? new Error(result.error) : undefined);
    return skipped("send_failed");
  }
  return noStore(apiSuccess({ sent: true }));
}
