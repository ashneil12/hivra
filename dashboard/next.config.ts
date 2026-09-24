import path from "node:path";
import type { NextConfig } from "next";

// This is build-generation provenance only. Vercel's authoritative deployment
// createdAt is collected from `vercel inspect --json` during Plan 08 rather
// than being inferred from when this configuration module was evaluated.
const buildGeneratedAt = new Date().toISOString();

function resolveSiteHost(): string {
  try {
    return new URL(process.env.NEXT_PUBLIC_APP_URL || "https://hermesos.cloud").hostname;
  } catch {
    return "hermesos.cloud";
  }
}

const selfHostAuthEnabled = process.env.HIVRA_AUTH_MODE?.trim().toLowerCase() === "local";

const selfHostOperationalSecretKeys = new Set([
  // Named access is part of the self-hosted deployment contract. These values
  // belong to the operator's own Cloudflare account and are required to give a
  // newly installed agent a stable, TLS-protected URL.
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_DNS_DOMAIN",
  "CLOUDFLARE_DNS_PROXIED",
  "CLOUDFLARE_TUNNEL_API_TOKEN",
  "CLOUDFLARE_TUNNEL_DOMAIN",
  "CLOUDFLARE_ZONE_ID",
]);

export function scrubHostedEnvironmentForSelfHost(
  env: Record<string, string | undefined> = process.env,
  enabled = selfHostAuthEnabled,
): void {
  if (!enabled) return;
  const allowedPublic = new Set([
    "NEXT_PUBLIC_APP_URL",
    "NEXT_PUBLIC_HIVRA_AGENTS",
    "NEXT_PUBLIC_SITE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "NEXT_PUBLIC_SUPABASE_URL",
  ]);
  const hostedSecretPrefixes = [
    "AEON_DISPATCH_", "ANTHROPIC_", "APPLE_", "BANKR_", "BASE_RPC_",
    "CLERK_", "CLOUDFLARE_", "CROF_", "CRYPTO_", "FINGERPRINT_",
    "GEMINI_", "GHCR_", "HERMESOS_BACKUP_", "MANAGED_VENICE_",
    "MODEL_SYNC_", "OPENAI_", "PINATA_", "POSTHOG_", "PRODUCTCLANK_",
    "PROXMOX_", "RESEND_", "STRIPE_", "VERCEL_",
  ];
  for (const key of Object.keys(env)) {
    if (
      !selfHostOperationalSecretKeys.has(key) &&
      ((key.startsWith("NEXT_PUBLIC_") && !allowedPublic.has(key)) ||
        hostedSecretPrefixes.some((prefix) => key.startsWith(prefix)))
    ) {
      delete env[key];
    }
  }
}

scrubHostedEnvironmentForSelfHost();

const siteHost = resolveSiteHost();
const localLiveAuthHost = `local.${siteHost}`;

// When PostHog is proxied through the Cloudflare posthog-proxy-worker
// (NEXT_PUBLIC_POSTHOG_API_HOST set to an absolute URL), its origin must be
// allowed to serve the recorder/array bundles (script-src) and to receive
// events + session replay (connect-src). Empty when unset — the default `/p`
// proxy is same-origin, already covered by 'self'. CSP is report-only, so a
// miss only adds report noise, but keep it correct.
const posthogProxyOrigin = (() => {
  const raw = process.env.NEXT_PUBLIC_POSTHOG_API_HOST;
  if (!raw) return "";
  try {
    return new URL(raw).origin;
  } catch {
    return "";
  }
})();
const posthogProxyCsp = posthogProxyOrigin ? ` ${posthogProxyOrigin}` : "";

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_BUILD_GENERATED_AT: buildGeneratedAt,
    NEXT_PUBLIC_HIVRA_AUTH_MODE: selfHostAuthEnabled ? "local" : "hosted",
  },
  distDir: process.env.VERCEL ? ".next" : ".next.nosync", // Prevent iCloud Drive thrashing locally
  trailingSlash: false,
  compress: false, // Disable built-in gzip — it buffers entire responses, defeating SSE streaming
  crossOrigin: "anonymous",
  allowedDevOrigins: [localLiveAuthHost, `*.${localLiveAuthHost}`],
  productionBrowserSourceMaps: true, // Upload to PostHog after builds so minified client errors resolve to source.
  serverExternalPackages: ["ssh2", "ws"],
  webpack(config) {
    if (!selfHostAuthEnabled) {
      return config;
    }

    const selfHostRoot = path.resolve(process.cwd(), "src/lib/self-host");
    config.resolve.alias = {
      ...config.resolve.alias,
      "@clerk/nextjs$": path.join(selfHostRoot, "clerk-client-shim.tsx"),
      "@clerk/nextjs/server$": path.join(
        selfHostRoot,
        "clerk-server-shim.ts",
      ),
    };
    return config;
  },
  turbopack: selfHostAuthEnabled
    ? {
        resolveAlias: {
          "@clerk/nextjs": "./src/lib/self-host/clerk-client-shim.tsx",
          "@clerk/nextjs/server": "./src/lib/self-host/clerk-server-shim.ts",
        },
      }
    : {},
  outputFileTracingIncludes: {
    "/changelog": ["./hermes_changelog.md"],
    "/changelog/rss.xml": ["./hermes_changelog.md"],
    // Apple JWS verification reads hash-pinned root certificates downloaded
    // directly from Apple during prebuild. Every route that can construct a
    // SignedDataVerifier must carry the generated certs in its lambda.
    "/api/webhooks/apple": ["./.generated/apple-certs/*.cer"],
    "/api/cron/reconcile-apple-subscriptions": ["./.generated/apple-certs/*.cer"],
    "/api/mobile/iap/attach": ["./.generated/apple-certs/*.cer"],
    // Every entrypoint that loads the reviewed provisioner bundle must ship
    // its dotfile too: automatic tracing/globs omit it, but the integrity
    // allowlist requires it before pinned SSH preparation or agent launch.
    "/api/infrastructure/connections/*/prepare": [
      "./provisioner/**/*",
      "./provisioner/.gitignore",
    ],
    "/api/infrastructure/connections/*/gvisor/prepare": [
      "./provisioner/gvisor/**/*",
    ],
    "/api/infrastructure/connections/*/gvisor/preflight": [
      "./provisioner/gvisor/**/*",
    ],
    "/api/infrastructure/connections/*/hetzner-cloud/capacity/setup": [
      "./provisioner/**/*",
      "./provisioner/.gitignore",
    ],
    "/api/hivra/agents": [
      "./provisioner/**/*",
      "./provisioner/.gitignore",
    ],
    "/api/hivra/agents/*": [
      "./provisioner/**/*",
      "./provisioner/.gitignore",
    ],
  },
  async redirects() {
    return [
      // A standalone installation is an application, not a mirror of Hivra's
      // commercial website. Keep these temporary so operators can change mode.
      ...(selfHostAuthEnabled
        ? [
            "/",
            "/blog/:path*",
            "/features/:path*",
            "/compare/:path*",
            "/token",
            "/tokenomics",
            "/why-hivra/:path*",
          ].map(source => ({
            source,
            destination: "/dashboard",
            permanent: false as const,
          }))
        : []),
      // Legacy/intent URLs that the retired site served as permanent redirects
      // and that search engines and old links still carry. The homepage FAQ
      // section is id="faq".
      { source: "/faq", destination: "/#faq", permanent: true },
      { source: "/about", destination: "/why-hivra", permanent: true },
      // Keep the static document's relative assets under /docs/litepaper/.
      // trailingSlash:false normalizes the directory URL before this redirect.
      { source: "/docs/litepaper", destination: "/docs/litepaper/index.html", permanent: false },
    ];
  },
  async rewrites() {
    return [
      // UK Dental DBR GTM landing page lives on a separate Vercel project
      // (clearweb.one/dental). Proxy /dental through the dashboard origin so
      // hivra.cloud/dental returns HTTP 200 instead of 404 — marketing/outreach
      // traffic was hitting a dead route since the 22 Jul 2026 launch.
      {
        source: "/dental",
        destination: "https://clearweb.one/dental",
      },
      // Cold outreach GTM landing page (same clearweb.one pattern as /dental).
      // Proxy /outreach through the dashboard origin so hivra.cloud/outreach
      // returns HTTP 200 instead of 404.
      {
        source: "/outreach",
        destination: "https://clearweb.one/outreach",
      },
      // US Roofing GTM landing page — static HTML in public/.
      // Serves hivra.cloud/roofing as a self-contained landing page.
      {
        source: "/roofing",
        destination: "/roofing.html",
      },
      {
        source: "/p/static/:path*",
        destination: "https://us-assets.i.posthog.com/static/:path*",
      },
      {
        source: "/p/:path*",
        destination: "https://us.i.posthog.com/:path*",
      },
      {
        source: "/p/decide",
        destination: "https://us.i.posthog.com/decide",
      },
      // Same-origin proxy for Clerk's pinned npm assets (clerk.browser.js +
      // ui.browser.js and the named sub-chunks ui.browser.js fans out into —
      // Clerk resolves those relative to its own URL, so the rewrite must
      // cover the whole /npm/* dist path). cdn.jsdelivr.net times out for a
      // slice of users every week and takes sign-in down with it; serving
      // through our origin rides Vercel's edge instead.
      {
        source: "/clerk-assets/:path*",
        destination: "https://cdn.jsdelivr.net/npm/:path*",
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          // Configuration headers also cover auth redirects and static assets,
          // which do not all pass through the application proxy.
          ...(selfHostAuthEnabled ? [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] : []),
          { key: "X-DNS-Prefetch-Control", value: "on" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Content-Security-Policy-Report-Only ships a draft policy that
          // browsers VALIDATE but DO NOT enforce — violations show up in
          // browser console (and a future report-uri endpoint) without
          // taking down hydration. Once the policy looks clean in
          // production, switch the header name to
          // `Content-Security-Policy` to enforce.
          //
          // Allow-list rationale per directive:
          //   default-src 'self' — no third-party origins by default.
          //   script-src — Next.js needs 'unsafe-inline' for hydration
          //     bootstrap; Stripe + Clerk + Google Tag Manager + PostHog (proxied via /p/*)
          //     load via dynamic <script>. Fingerprint Pro is not bundled in
          //     the public artifact; managed deployments with an explicit
          //     browser token opt in to its fpjscdn/fpnpmcdn runtime loader.
          //     'wasm-unsafe-eval' covers any
          //     wasm modules the bundle pulls in. 'unsafe-eval' covers a
          //     Next.js framework chunk that runs raw eval() in production
          //     bundles (surfaced as recurring CSP report-only violations
          //     pointing at hashed chunks like `00wc6kd8v012v.js`; report-uri
          //     was getting hundreds of these per page load on /dashboard).
          //     cdn.jsdelivr.net hosts Clerk's lazy-loaded UI chunks
          //     (@clerk/ui >= 1.7 + @clerk/clerk-js >= 6.8 fan out from
          //     ui.browser.js into named sub-chunks like vendors_ui_*.js,
          //     userbutton_ui_*.js, framework_ui_*.js, etc. — these are
          //     fetched after first render and were the dominant CSP report
          //     source until allow-listed). The DEFAULT Clerk asset URLs now
          //     proxy through the same-origin /clerk-assets rewrite (covered
          //     by 'self'); cdn.jsdelivr.net stays allow-listed for the
          //     NEXT_PUBLIC_CLERK_JS_URL/NEXT_PUBLIC_CLERK_UI_URL direct-CDN
          //     escape hatch.
          //   style-src — Next.js / framer-motion inject inline styles.
          //   img-src — avatars, mux thumbnails, posthog assets, generic
          //     https + data: + blob: for user-uploaded images.
          //   media-src — Mux video player.
          //   font-src — self-hosted fonts only; data: covers font preloads.
          //   connect-src — every host the app fetches/posts/streams to:
          //     Clerk (auth), Stripe (billing), Supabase (DB + storage),
          //     PostHog (analytics — direct, not just proxied), Mux,
          //     *.hermesos.cloud (per-instance agent gateways with real
          //     DNS subdomains) + *.sslip.io (per-instance gateways using
          //     the IP-based DNS fallback when no real subdomain is
          //     provisioned — built by buildAgentSubdomain when
          //     NEXT_PUBLIC_DNS_DOMAIN_DEPLOY is unset, see
          //     hetzner-instance-builders.ts), Cloudflare turnstile
          //     (Clerk's bot challenge).
          //   frame-src — Stripe Checkout, Clerk's hosted UI, Cloudflare
          //     turnstile, Mux player iframe.
          //   frame-ancestors 'self' — preserves the X-Frame-Options
          //     SAMEORIGIN behaviour.
          //   form-action 'self' — POSTs target only the dashboard.
          //   base-uri 'self' — block <base href="..."> injection.
          {
            key: "Content-Security-Policy-Report-Only",
            value: [
              "default-src 'self'",
              // clerk.hivra.cloud is the production Clerk Frontend API custom
              // domain (post-Hivra-rebrand); it can serve clerk.browser.js, so
              // it belongs in script-src alongside the dev FAPI *.clerk.accounts.dev.
              // We do NOT put the *.hivra.cloud gateway wildcards here — the app
              // never loads scripts from agent gateways (matching *.hermesos.cloud,
              // which is connect/frame only).
              `script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https://js.stripe.com https://*.stripe.com https://*.clerk.accounts.dev https://clerk.hivra.cloud https://cdn.jsdelivr.net https://www.googletagmanager.com https://challenges.cloudflare.com https://fpjscdn.net https://fpnpmcdn.net${posthogProxyCsp}`,
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob: https:",
              "media-src 'self' blob: https://stream.mux.com https://*.mux.com",
              "font-src 'self' data:",
              // Hivra rebrand (2026-06): Clerk's Frontend API moved to the
              // custom domain clerk.hivra.cloud — client bootstrap XHRs
              // (/v1/environment, /v1/client, session /tokens) hit it on every
              // signed-in page, so it MUST be allow-listed (this omission was
              // ~8k report-only violations across ~960 sessions on /dashboard/*).
              // *.hivra.cloud + *.agents.hivra.cloud mirror the hermesos gateway
              // wildcards ahead of the instance-DNS cutover (CSP wildcards match
              // one label, so both the single- and two-label forms are needed).
              // Legacy *.hermesos.cloud / *.agents.hermesos.cloud STAY: live
              // instances still hand out <id>.agents.hermesos.cloud gateway URLs,
              // so removing them would break their chat/embeds the moment this
              // policy is promoted to enforcing. Retire once no instance resolves
              // on hermesos.cloud.
              `connect-src 'self' https://api.stripe.com https://*.stripe.com https://*.clerk.accounts.dev https://api.clerk.com https://clerk.hivra.cloud https://*.supabase.co https://*.supabase.in https://us.i.posthog.com https://us-assets.i.posthog.com https://www.google-analytics.com https://region1.google-analytics.com https://analytics.google.com https://*.mux.com https://challenges.cloudflare.com https://*.fpjs.io https://*.hermesos.cloud https://*.agents.hermesos.cloud https://*.hivra.cloud https://*.agents.hivra.cloud https://*.sslip.io wss://*.supabase.co${posthogProxyCsp}`,
              // frame-src: per-VM webui iframes live on hermesos.cloud
              // subdomains (managed) or sslip.io (ACME-rate-limit fallback).
              // frame-ancestors stays 'self' below — these are who we frame,
              // not who frames us.
              "frame-src 'self' https://js.stripe.com https://*.stripe.com https://*.clerk.accounts.dev https://clerk.hivra.cloud https://challenges.cloudflare.com https://stream.mux.com https://*.hermesos.cloud https://*.agents.hermesos.cloud https://*.hivra.cloud https://*.agents.hivra.cloud https://*.sslip.io",
              "worker-src 'self' blob:",
              "frame-ancestors 'self'",
              "form-action 'self'",
              "base-uri 'self'",
              // Receiver for CSP violations — the 2026-04-30 debug session
              // had a 6-hour stretch where Chrome was CSP-blocking the SW's
              // cross-origin GET, surfaced only as a "CORS error" badge in
              // DevTools. With report-uri every violation (current and
              // future) lands in ops_events the moment any user trips it.
              "report-uri /api/csp/report",
            ].join("; "),
          },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          // The SW has its own CSP (Chrome enforces the response-header
          // CSP on fetches inside the SW context). Without an explicit
          // `connect-src`, the directive falls back to `default-src 'self'`
          // and the SW's cross-origin GET to the agent gateway's chat-jobs
          // sidecar SSE URL gets blocked with "Refused to connect because
          // it violates the document's Content Security Policy" — which
          // surfaces to the page as a bare `TypeError: Failed to fetch`
          // (sometimes labelled "CORS error" in the network tab even
          // though the actual cause is CSP).
          //
          // CSP wildcards only match ONE label level, so `*.hermesos.cloud`
          // covers `agents.hermesos.cloud` but NOT
          // `<instance>.agents.hermesos.cloud` — Proxmox-provisioned
          // gateway URLs are exactly that two-level shape and were being
          // blocked even though the wildcard "looked" right. Listing
          // `*.agents.hermesos.cloud` explicitly fixes the deeper-subdomain
          // case while keeping the original `*.hermesos.cloud` for any
          // single-level subdomain we might use later.
          //
          // Unlike the document policy above, THIS header is enforcing
          // (`Content-Security-Policy`, not -Report-Only). The `*.hivra.cloud`
          // + `*.agents.hivra.cloud` entries are pre-added so that when instance
          // gateway DNS finishes cutting over from hermesos.cloud to hivra.cloud
          // the SW's cross-origin SSE keeps working without an emergency deploy;
          // the hermesos wildcards stay until no instance resolves there.
          {
            key: "Content-Security-Policy",
            value:
              "default-src 'self'; script-src 'self'; " +
              "connect-src 'self' https://*.hermesos.cloud https://*.agents.hermesos.cloud https://*.hivra.cloud https://*.agents.hivra.cloud https://*.sslip.io; " +
              // SW CSP violations also flow into the report-uri
              // receiver. Without this, the SW's cross-origin block (the
              // exact bug class we fought today) is invisible server-side.
              "report-uri /api/csp/report",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
