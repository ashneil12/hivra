import fs from "node:fs";
import path from "node:path";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";

jest.mock("@clerk/nextjs/server", () => ({
  clerkMiddleware: jest.fn((handler: unknown) => handler),
  createRouteMatcher: jest.fn(() => () => false),
}));

jest.mock("@/lib/protected-routes", () => ({
  isProtectedPath: jest.fn(() => false),
  PROTECTED_ROUTE_MATCHERS: [],
}));

const API_ROUTES_ROOT = path.join(process.cwd(), "src/app/api");

/** The `/api/((?!a|b).*)` entry — the canonical list of api middleware exclusions. */
function apiMatcherEntry(matcher: readonly string[]): string {
  const entry = matcher.find((m) => m.startsWith("/api/((?!"));
  if (!entry) throw new Error("no /api/ matcher entry found");
  return entry;
}

/** Alternatives inside that entry's negative lookahead, e.g. `instances/[^/]+/aeon-gate`. */
function apiExclusions(matcher: readonly string[]): string[] {
  const inner = apiMatcherEntry(matcher).match(/^\/api\/\(\(\?!([^)]*)\)/)?.[1];
  if (inner === undefined) throw new Error("could not parse the /api/ lookahead");
  // A nested group would silently truncate the parse above. Fail loudly instead.
  if (inner.includes("(")) throw new Error(`unsupported nested group: ${inner}`);
  return inner.length === 0 ? [] : inner.split("|");
}

/**
 * Split `instances/[^/]+/aeon-gate` into ["instances", "[^/]+", "aeon-gate"].
 * A plain `.split("/")` would shred the `[^/]+` token, which itself contains a
 * slash, so match segments explicitly: either the literal dynamic token, or a
 * run of non-slash characters.
 */
function exclusionSegments(exclusion: string): string[] {
  return exclusion.match(/\[\^\/\]\+|[^/]+/g) ?? [];
}

/**
 * Resolve an exclusion against src/app/api, treating `[^/]+` as "any single
 * dynamic segment". True iff some concrete route.ts exists behind it.
 */
function apiRouteExists(exclusion: string): boolean {
  let dirs = [API_ROUTES_ROOT];

  for (const segment of exclusionSegments(exclusion.replace(/\$$/, ""))) {
    const next: string[] = [];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      if (segment === "[^/]+") {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) next.push(path.join(dir, entry.name));
        }
      } else {
        const candidate = path.join(dir, segment);
        if (fs.existsSync(candidate)) next.push(candidate);
      }
    }
    dirs = next;
  }

  return dirs.some((dir) => fs.existsSync(path.join(dir, "route.ts")));
}

describe("proxy config", () => {
  it("routes only the exact machine-authenticated enrollment endpoint around Clerk", async () => {
    const { config } = await import("@/proxy");
    for (const url of ["/api/infrastructure/first-boot/enroll", "/api/infrastructure/first-boot/enroll?unexpected=1"]) {
      expect(unstable_doesMiddlewareMatch({config,url})).toBe(false);
    }
    for (const url of ["/api/infrastructure/first-boot/enroll/extra", "/api/infrastructure/first-boot/enroll-other",
      "/api/infrastructure/connections/test/hetzner-cloud/capacity/setup", "/api/hivra/agents", "/dashboard/infrastructure"]) {
      expect(unstable_doesMiddlewareMatch({config,url})).toBe(true);
    }
  });
  it("keeps /api/instances/:id/aeon-gate out of the Clerk proxy matcher", async () => {
    const { config } = await import("@/proxy");

    expect(apiExclusions(config.matcher)).toEqual(["instances/[^/]+/aeon-gate", "infrastructure/first-boot/enroll$", "activity/ingest$"]);
  });

  it("lets the scoped collector receiver authenticate OTLP without exempting Activity reads", async () => {
    const { config } = await import("@/proxy");
    expect(unstable_doesMiddlewareMatch({ config, url: "/api/activity/ingest" })).toBe(false);
    for (const url of ["/api/activity", "/api/activity/ingest/extra", "/api/activity/ingest-other", "/dashboard/activity"]) {
      expect(unstable_doesMiddlewareMatch({ config, url })).toBe(true);
    }
  });

  it("splits exclusions without shredding the dynamic-segment token", () => {
    expect(exclusionSegments("instances/[^/]+/aeon-gate")).toEqual([
      "instances",
      "[^/]+",
      "aeon-gate",
    ]);
  });

  /**
   * The matcher array is an OR. An exclusion present in the `/api/(...)` entry
   * but missing from the broad `/(...)` entry does nothing — the broad entry
   * still matches and the middleware still runs.
   */
  it("declares every api exclusion in BOTH matcher entries", async () => {
    const { config } = await import("@/proxy");

    const broadEntry = config.matcher.find((m) => m.startsWith("/((?!"));
    expect(broadEntry).toBeTruthy();

    for (const exclusion of apiExclusions(config.matcher)) {
      expect(broadEntry).toContain(`api/${exclusion}`);
    }
  });

  /**
   * `api/streaming` sat here naming a route this app has never served — the name
   * was cargo from hermes-webui's `api/streaming.py`, a Python module in a
   * different repo, so every grep for it found "hits". A bypass for a
   * nonexistent route is dead weight at best; if someone later creates that
   * route it silently ships exempt from Clerk.
   */
  it("only excludes api routes that actually exist", async () => {
    const { config } = await import("@/proxy");

    const exclusions = apiExclusions(config.matcher);
    expect(exclusions.length).toBeGreaterThan(0);

    const missing = exclusions.filter((exclusion) => !apiRouteExists(exclusion));
    expect(missing).toEqual([]);
  });

  // send-stream proxied to hermes-webui's removed POST /api/chat/start; responses
  // proxied to the agent's POST /v1/responses on :8642, which the per-instance
  // Caddyfile never exposes (bearer -> dashboard-sidecar:9090 ->
  // official-dashboard:9119 -> 405). Both routes are gone. A lingering bypass
  // would silently exempt a resurrected route from Clerk.
  it("carries no bypass for the retired send-stream, responses, or streaming routes", async () => {
    const { config } = await import("@/proxy");
    const matcherText = config.matcher.join("\n");

    expect(matcherText).not.toContain("send-stream");
    expect(matcherText).not.toContain("responses");
    expect(matcherText).not.toContain("streaming");
  });

  it("no longer exports an SSE bypass list (no SSE route needs one)", async () => {
    const proxyModule = await import("@/proxy");

    expect(proxyModule).not.toHaveProperty("SSE_BYPASS_PATH_PATTERNS");
  });

  it("keeps the exported matcher config statically analyzable for Next.js builds", () => {
    const proxySource = fs.readFileSync(path.join(process.cwd(), "src/proxy.ts"), "utf8");
    const configBlock = proxySource.match(/export const config = \{[\s\S]*?\n\};/);

    expect(configBlock?.[0]).toBeTruthy();
    expect(configBlock?.[0]).not.toContain("${");
    expect(configBlock?.[0]).not.toContain(".join(");
    expect(configBlock?.[0]).not.toContain(".map(");
  });
});
