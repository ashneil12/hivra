// Hivra PWA service worker — public offline shell only.
//
// Chat streaming does NOT run through the browser Service Worker: WebUI sends
// use /api/instances/[id]/chat-start, then the browser opens the signed
// EventSource URL directly to the VM. This worker exists to give the installed
// PWA a branded offline experience instead of the browser's broken-page screen.
//
// Behaviour:
//   - install:  precache the static, public /offline shell so a failed
//               navigation always has something branded to fall back to.
//   - activate: drop every Hivra cache from a previous HERMES_SW_BUILD so a deploy
//               never serves stale assets, then take control of open clients.
//   - fetch:    explicitly public navigations are network-first and fall back
//               to /offline; queryless immutable build assets are cache-first.
//
// Scope guard: authenticated pages, APIs, streams, gateway traffic, agent data,
// signed URLs, cross-origin traffic, and mutations never reach CacheStorage.
self.HERMES_SW_BUILD = "2026-08-24T00:00Z-workspace-public-shell";

// Cache name is keyed off the build marker so a deploy that bumps
// HERMES_SW_BUILD lands in a fresh cache and the old one is purged on activate.
const CACHE_PREFIX = "hivra-pwa-";
const CACHE_NAME = CACHE_PREFIX + self.HERMES_SW_BUILD;

const OFFLINE_URL = "/offline";
const PUBLIC_NAVIGATION_PATHS = new Set(["/", OFFLINE_URL]);
const PRIVATE_PATH_PREFIXES = [
  "/dashboard",
  "/api",
  "/gateway",
  "/agents",
  "/chat",
  "/events",
  "/stream",
];
// The static app shell precached on install. Kept intentionally small — just
// the branded offline fallback, which is a public, auth-free route.
const PRECACHE_URLS = [OFFLINE_URL];

function hasPathPrefix(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(prefix + "/");
}

function isPrivateRuntimePath(pathname) {
  return PRIVATE_PATH_PREFIXES.some((prefix) =>
    hasPathPrefix(pathname, prefix)
  );
}

// Self-heal for the offline shell. If install's precache missed (e.g. a
// transient mid-deploy fetch failure, which install deliberately swallows so it
// never bricks), nothing would otherwise re-cache /offline and the fallback
// would stay broken until the next HERMES_SW_BUILD bump. After a successful
// navigation we re-fetch the PUBLIC /offline route on its own and cache it — we
// never cache the navigation response itself, which may be signed-in HTML.
async function ensureOfflineShellCached() {
  try {
    const cache = await caches.open(CACHE_NAME);
    if (await cache.match(OFFLINE_URL)) {
      return;
    }
    const response = await fetch(OFFLINE_URL, { cache: "reload" });
    if (response && response.ok) {
      await cache.put(OFFLINE_URL, response.clone());
    }
  } catch {
    // Best-effort — a failure here just means the next navigation retries.
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE_NAME);
        await cache.addAll(PRECACHE_URLS);
      } catch {
        // A transient precache miss (e.g. mid-deploy) must not brick install —
        // the worker still activates; the offline fallback fills in on the next
        // successful fetch of /offline.
      }
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only GETs are cacheable/offline-serviceable; everything else passes through.
  if (request.method !== "GET") {
    return;
  }

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // Never touch cross-origin traffic (Clerk CDN, analytics, VM EventSource…).
  if (url.origin !== self.location.origin) {
    return;
  }

  // Query strings and fragments may carry signatures, access grants, or other
  // credential-bearing state. Exclude them before any cache lookup, even when
  // the pathname resembles an otherwise immutable asset.
  if (url.search || url.hash) {
    return;
  }

  // Authenticated HTML, APIs, streams, gateway responses, and agent data always
  // use the browser's normal network path. No cache is opened or consulted.
  if (isPrivateRuntimePath(url.pathname)) {
    return;
  }

  // Only explicitly public navigations receive the public offline fallback.
  // Navigation responses themselves are never cached.
  if (request.mode === "navigate") {
    if (!PUBLIC_NAVIGATION_PATHS.has(url.pathname)) {
      return;
    }
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          // Opportunistically repair a missing offline shell in the background,
          // without delaying or caching this (possibly signed-in) response.
          event.waitUntil(ensureOfflineShellCached());
          return response;
        } catch {
          const cache = await caches.open(CACHE_NAME);
          const cached = await cache.match(OFFLINE_URL);
          return cached || Response.error();
        }
      })()
    );
    return;
  }

  // Immutable build assets: cache-first so the offline shell renders styled.
  // These are content-hashed and public — safe to persist.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(request);
        if (cached) {
          return cached;
        }
        try {
          const response = await fetch(request);
          if (response && response.ok) {
            await cache.put(request, response.clone());
          }
          return response;
        } catch {
          return cached || Response.error();
        }
      })()
    );
  }

  // Everything else (API calls, signed-in HTML fragments, etc.): default
  // network handling — no respondWith, nothing cached.
});
