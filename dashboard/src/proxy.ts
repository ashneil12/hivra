import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { isProtectedPath, PROTECTED_ROUTE_MATCHERS } from "@/lib/protected-routes";
import { isHostedBillingPath } from "@/lib/self-host/hosted-surface-guard";
import { isCanaryHost } from "@/lib/seo-host";

const requiresAuth = createRouteMatcher(PROTECTED_ROUTE_MATCHERS);

export default clerkMiddleware(async (auth, request) => {
  const canaryHost = isCanaryHost(request.headers.get("host"));
  const response = NextResponse.next();
  if (canaryHost) {
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
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
    if (canaryHost) {
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
     * - /api/instances/:id/aeon-gate, which the in-box aeon setup script calls
     *   without a Clerk session.
     * - exactly /api/infrastructure/first-boot/enroll: its one-time bearer
     *   capability is authenticated by the receiver, not as a Clerk token.
     *   Siblings and child paths remain covered by Clerk. The receiver still
     *   rejects missing/invalid tokens, browser origins and query parameters.
     * - exactly /api/activity/ingest: the OTLP receiver verifies its own
     *   tenant/resource-scoped collector capability. Clerk cannot decode that
     *   capability as a session JWT. Activity reads still use Clerk.
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
    "/((?!_next|api/instances/[^/]+/aeon-gate|api/infrastructure/first-boot/enroll$|api/activity/ingest$|apple-icon|pwa-icon-192|pwa-icon-512|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/api/((?!instances/[^/]+/aeon-gate|infrastructure/first-boot/enroll$|activity/ingest$).*)",
    "/trpc/(.*)",
  ],
};
