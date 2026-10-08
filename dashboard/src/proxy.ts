import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { canonicalRequestPath } from "@/lib/canonical-request-path";
import { crossOriginMutationRefusal } from "@/lib/cross-origin-mutation-guard";
import { isProtectedPath, PROTECTED_ROUTE_MATCHERS } from "@/lib/protected-routes";
import { isHostedBillingPath } from "@/lib/self-host/hosted-surface-guard";
import { isNoIndexHost } from "@/lib/seo-host";

const requiresAuth = createRouteMatcher(PROTECTED_ROUTE_MATCHERS);

export default clerkMiddleware(async (auth, request) => {
  const noIndexHost = isNoIndexHost(request.headers.get("host"));
  const response = NextResponse.next();
  if (noIndexHost) {
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
  }

  // Before Clerk: a state-changing API request that a browser sent from
  // another origin (for example a box page on the same registrable domain,
  // which still carries the SameSite=Lax session cookie) is refused outright.
  const crossOrigin = crossOriginMutationRefusal(request, request.nextUrl.pathname);
  if (crossOrigin) {
    // eslint-disable-next-line no-console -- The proxy runs on every request; the structured logger pulls in ops_events and Supabase, so this stays a single JSON line on console.
    console.warn(JSON.stringify({
      level: "warn",
      msg: "refused cross-origin API mutation",
      source: "proxy",
      failureType: "cross_origin_api_mutation",
      method: request.method,
      path: request.nextUrl.pathname,
      reason: crossOrigin.reason,
      secFetchSite: crossOrigin.secFetchSite,
      origin: crossOrigin.origin?.slice(0, 200) ?? null,
    }));
    const refused = NextResponse.json(
      { error: "Cross-origin request refused." },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
    if (noIndexHost) {
      refused.headers.set("X-Robots-Tag", "noindex, nofollow");
    }
    return refused;
  }

  // A percent-encoded letter in a path (`/%70ricing`) means the same as the
  // letter, but the app and the platform do not treat the two spellings alike:
  // Vercel answers an encoded app route with a 500 page and serves an encoded
  // static file around the rules written for its plain path. Send the visitor to
  // the plain spelling so every route and rule sees the form it expects. The
  // redirect keeps the method and the query string, and the request it sends the
  // visitor to goes through every check in this file again on the plain path.
  const canonicalPath = canonicalRequestPath(request.nextUrl.pathname);
  if (canonicalPath !== null) {
    const target = request.nextUrl.clone();
    // The setter writes the path as given, so a leading double slash stays a
    // path on this origin and cannot become another host.
    target.pathname = canonicalPath;
    const redirect = NextResponse.redirect(target, 308);
    if (noIndexHost) {
      redirect.headers.set("X-Robots-Tag", "noindex, nofollow");
    }
    return redirect;
  }

  if (
    process.env.HIVRA_AUTH_MODE?.trim().toLowerCase() === "local" &&
    isHostedBillingPath(request.nextUrl.pathname)
  ) {
    const blockedResponse = request.nextUrl.pathname.startsWith("/api/")
      ? NextResponse.json(
          { error: "This hosted billing endpoint is not part of a self-host installation." },
          { status: 404 },
        )
      : NextResponse.redirect(new URL("/dashboard", request.url));
    if (noIndexHost) {
      blockedResponse.headers.set("X-Robots-Tag", "noindex, nofollow");
    }
    return blockedResponse;
  }
  if (isProtectedPath(request.nextUrl.pathname) || requiresAuth(request)) {
    await auth.protect();
  }

  return response;
});

export const config = {
  matcher: [
    /*
     * Match all request paths EXCEPT:
     * - _next static files
     * - static assets
     * - public PWA metadata/icon routes
     * - exactly /api/instances/:id/aeon-gate, which the in-box aeon setup script
     *   calls without a Clerk session. The exclusion ends in `$` like the rest, so
     *   a longer path that only starts with it stays covered by Clerk.
     * - exactly /api/infrastructure/first-boot/enroll: its one-time bearer
     *   capability is authenticated by the receiver, not as a Clerk token.
     *   Siblings and child paths remain covered by Clerk. The receiver still
     *   rejects missing/invalid tokens, browser origins and query parameters.
     * - exactly /api/activity/ingest: the OTLP receiver verifies its own
     *   tenant/resource-scoped collector capability. Clerk cannot decode that
     *   capability as a session JWT. Activity reads still use Clerk.
     * - exactly /api/activity/collector/renew: the guest reporter renews that
     *   same collector capability with the capability itself; the route
     *   verifies it and the computer's ownership. Clerk cannot decode it.
     * - exactly /api/infrastructure/server-enrollments/report: the server
     *   setup script's one-time code is authenticated by the receiver, not as
     *   a Clerk token. The owner routes beside it stay covered by Clerk.
     * - exactly /enroll, /enroll/uninstall, /enroll/script and
     *   /enroll/script.sha256 (page matcher only): `curl … | sudo bash`
     *   downloads the setup script with no session. Siblings stay covered.
     *
     * One entry adds paths back. A path that contains a percent-encoded
     * character is matched by the last entry even when it ends in a static
     * extension or names an excluded route, so the proxy can redirect an encoded
     * spelling such as /%70ricing or /docs/litepaper/%69ndex.html to the plain
     * one (see lib/canonical-request-path.ts). Build assets under /_next/ stay out.
     *
     * An api exclusion must appear in BOTH entries below. The matcher array is
     * an OR: a path excluded from one entry but matched by another still runs
     * the middleware. proxy-config.test.ts pins that, and pins that every api
     * exclusion resolves to a route that actually exists.
     *
     * Three exclusions used to live here. All three named routes that this app
     * does not serve:
     *
     * - /api/streaming never existed in the dashboard. The name was cargo from
     *   hermes-webui's `api/streaming.py` — a Python module in a different repo.
     * - /api/instances/:id/send-stream proxied to hermes-webui's removed
     *   POST /api/chat/start.
     * - /api/instances/:id/responses proxied to the agent's POST /v1/responses.
     *   That endpoint is real, but api_server binds it on the gateway
     *   container's :8642, which the per-instance Caddyfile never exposes: a
     *   bearer-authed request matches @authBearer and goes to
     *   dashboard-sidecar:9090 -> official-dashboard:9119 (the agent's web
     *   dashboard), whose GET-only SPA catch-all answered 405 to every POST.
     *
     * Chat does not ride the dashboard any more: the Hivra lane posts straight
     * to the box (HivraChat -> <box>/api/chat) and the instances lane renders
     * the box's own dashboard in a cross-origin iframe (WebuiIframe). No SSE
     * route needs a bypass, so there is no SSE bypass list.
     */
    "/((?!_next|api/instances/[^/]+/aeon-gate$|api/infrastructure/first-boot/enroll$|api/infrastructure/server-enrollments/report$|api/activity/ingest$|api/activity/collector/renew$|enroll$|enroll/uninstall$|enroll/script$|enroll/script\\.sha256$|apple-icon|pwa-icon-192|pwa-icon-512|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/api/((?!instances/[^/]+/aeon-gate$|infrastructure/first-boot/enroll$|infrastructure/server-enrollments/report$|activity/ingest$|activity/collector/renew$).*)",
    "/trpc/(.*)",
    "/((?!_next/).*%[0-9A-Fa-f]{2}.*)",
  ],
};
