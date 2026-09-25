/**
 * The dashboard proxy refuses state-changing API requests that a browser sent
 * from another origin.
 *
 * Canary (canary.hermesos.cloud) shares its registrable domain with the agent
 * boxes (box-*.hermesos.cloud). A page on a box is therefore "same-site" with
 * the dashboard: the browser attaches the SameSite=Lax Clerk session cookie to
 * a POST it sends from there, and Clerk authenticates it. Before this guard, a
 * box page could drive any cookie-authenticated mutation route that did not
 * check the origin itself.
 */
import { NextRequest } from "next/server";

const protect = jest.fn(async () => undefined);

jest.mock("@clerk/nextjs/server", () => ({
  clerkMiddleware: jest.fn(
    (handler: (auth: unknown, request: NextRequest) => unknown) =>
      (request: NextRequest) =>
        handler(Object.assign(async () => ({ userId: "user_123" }), { protect }), request),
  ),
  createRouteMatcher: jest.fn(() => () => false),
}));

const DASHBOARD = "https://canary.hermesos.cloud";
const BOX = "https://box-7f3a.hermesos.cloud";
const MUTATION_PATH = "/api/instances/inst_123/terminal/interactive";

type Headers = Record<string, string>;

async function runProxy(path: string, method: string, headers: Headers): Promise<Response> {
  const { default: proxy } = await import("@/proxy");
  const request = new NextRequest(`${DASHBOARD}${path}`, {
    method,
    headers: { cookie: "__session=session-token", ...headers },
    body: method === "GET" || method === "HEAD" ? undefined : '{"action":"start"}',
  });
  const run = proxy as unknown as (request: NextRequest) => Promise<Response>;
  return run(request);
}

function passedThrough(response: Response): boolean {
  return response.headers.get("x-middleware-next") === "1";
}

describe("proxy: cross-origin API mutations", () => {
  beforeEach(() => {
    protect.mockClear();
    delete process.env.HIVRA_AUTH_MODE;
  });

  it("refuses a POST a box page sends to the dashboard with the session cookie", async () => {
    const response = await runProxy(MUTATION_PATH, "POST", {
      origin: BOX,
      "sec-fetch-site": "same-site",
      "content-type": "text/plain;charset=UTF-8",
    });

    expect(response.status).toBe(403);
    expect(passedThrough(response)).toBe(false);
    await expect(response.json()).resolves.toEqual({ error: "Cross-origin request refused." });
    expect(response.headers.get("cache-control")).toBe("no-store");
    // The request never reaches Clerk or the route.
    expect(protect).not.toHaveBeenCalled();
  });

  it.each(["PUT", "PATCH", "DELETE"])("refuses a same-site %s", async (method) => {
    const response = await runProxy("/api/hivra/agents/agent_1", method, {
      origin: BOX,
      "sec-fetch-site": "same-site",
    });
    expect(response.status).toBe(403);
  });

  it("refuses a cross-site POST", async () => {
    const response = await runProxy(MUTATION_PATH, "POST", {
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
    });
    expect(response.status).toBe(403);
  });

  it("refuses a browser without Fetch Metadata when its Origin is another origin", async () => {
    const response = await runProxy(MUTATION_PATH, "POST", { origin: BOX });
    expect(response.status).toBe(403);
  });

  it("refuses an opaque (null) Origin", async () => {
    const response = await runProxy(MUTATION_PATH, "POST", { origin: "null" });
    expect(response.status).toBe(403);
  });

  it("keeps the dashboard's own same-origin calls working", async () => {
    const withMetadata = await runProxy(MUTATION_PATH, "POST", {
      origin: DASHBOARD,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    });
    expect(passedThrough(withMetadata)).toBe(true);
    expect(protect).toHaveBeenCalled();

    // Older browsers send only Origin.
    const originOnly = await runProxy(MUTATION_PATH, "POST", { origin: DASHBOARD });
    expect(passedThrough(originOnly)).toBe(true);
  });

  it("keeps user-initiated requests (Sec-Fetch-Site: none) working", async () => {
    const response = await runProxy(MUTATION_PATH, "POST", { "sec-fetch-site": "none" });
    expect(passedThrough(response)).toBe(true);
  });

  it("keeps machine callers without browser headers working (cron, box scripts, native apps)", async () => {
    for (const path of [MUTATION_PATH, "/api/cron/purge-expired", "/api/internal/agent-notify", "/api/instances/inst_123/update-report"]) {
      const response = await runProxy(path, "POST", { authorization: "Bearer machine-token" });
      expect(passedThrough(response)).toBe(true);
    }
  });

  it("does not gate reads, preflights or page navigations", async () => {
    for (const [path, method] of [
      [MUTATION_PATH, "GET"],
      [MUTATION_PATH, "HEAD"],
      [MUTATION_PATH, "OPTIONS"],
      ["/dashboard", "GET"],
    ] as const) {
      const response = await runProxy(path, method, { origin: BOX, "sec-fetch-site": "same-site" });
      expect(response.status).not.toBe(403);
    }
  });

  it("leaves signed provider webhooks and the public CSP report sink alone", async () => {
    for (const path of ["/api/webhooks/stripe", "/api/webhooks/clerk", "/api/webhooks/apple", "/api/csp/report"]) {
      const response = await runProxy(path, "POST", {
        origin: "https://sender.example",
        "sec-fetch-site": "cross-site",
      });
      expect(passedThrough(response)).toBe(true);
    }
  });

  it("does not exempt look-alike paths", async () => {
    for (const path of ["/api/webhooksx/stripe", "/api/csp/report/extra", "/api/csp/reports"]) {
      const response = await runProxy(path, "POST", { origin: BOX, "sec-fetch-site": "same-site" });
      expect(response.status).toBe(403);
    }
  });
});
