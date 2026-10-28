import { describe, expect, it, vi } from "vitest";
import {
  isBlockedNavigationHost,
  assertNavigationAllowed,
  BlockedNavigationError,
  gotoWithNavigationGuard,
  installNavigationRouteGuard,
  installPageNavigationWatchdog,
  navigationChainBlockCode,
} from "../src/navigation-guard.js";

// isBlockedNavigationHost receives URL.hostname, which keeps IPv6 literals
// wrapped in brackets — so the cases below mirror what the /goto route passes.
describe("isBlockedNavigationHost", () => {
  it.each([
    "localhost",
    "127.0.0.1",
    "127.5.1.1",
    "0.0.0.0",
    "[::1]",
    "[::]",
    "169.254.169.254",
    "169.254.170.2",
    "warden",
    "metadata.google.internal",
    // Normalization-bypass variants Node leaves as distinct hostnames:
    "[::ffff:7f00:1]", // canonical hex form of ::ffff:127.0.0.1
    "[::ffff:127.0.0.1]",
    "[::ffff:a9fe:a9fe]", // ::ffff:169.254.169.254
    "[::ffff:169.254.169.254]",
  ])("blocks %s", (host) => {
    expect(isBlockedNavigationHost(host)).toBe(true);
  });

  it.each([
    "example.com",
    "203.0.113.10",
    // RFC1918 is intentionally allowed (tenant-owned LAN services):
    "10.240.0.5",
    "192.168.1.10",
    "172.16.0.1",
    "[::ffff:192.168.1.1]", // mapped RFC1918 stays allowed
    "[2001:db8::1]",
  ])("allows %s", (host) => {
    expect(isBlockedNavigationHost(host)).toBe(false);
  });
});

describe("assertNavigationAllowed", () => {
  it("returns the parsed URL for an allowed destination", () => {
    expect(assertNavigationAllowed("https://example.com/path").hostname).toBe("example.com");
  });

  it.each([
    ["http://[::ffff:127.0.0.1]/", "BLOCKED_DESTINATION"],
    ["http://[::]/", "BLOCKED_DESTINATION"],
    ["http://169.254.169.254/", "BLOCKED_DESTINATION"],
    ["http://warden:7070/", "BLOCKED_DESTINATION"],
    ["file:///etc/passwd", "UNSUPPORTED_SCHEME"],
    ["not a url", "INVALID_URL"],
  ])("throws for %s", (url, code) => {
    let thrown: unknown;
    try {
      assertNavigationAllowed(url);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BlockedNavigationError);
    expect((thrown as BlockedNavigationError).code).toBe(code);
  });
});

// A fake Playwright redirect chain: hops are listed first-request-first.
function chain(hops: Array<{ url: string; ip?: string }>) {
  type Req = {
    url(): string;
    redirectedFrom(): Req | null;
    response(): Promise<{ request(): Req; serverAddr(): Promise<{ ipAddress: string; port: number } | null> } | null>;
  };
  let prev: Req | null = null;
  let last: Req | null = null;
  for (const hop of hops) {
    const from: Req | null = prev;
    const req: Req = {
      url: () => hop.url,
      redirectedFrom: () => from,
      response: async () => ({
        request: () => req,
        serverAddr: async () => (hop.ip ? { ipAddress: hop.ip, port: 80 } : null),
      }),
    };
    prev = req;
    last = req;
  }
  const finalReq = last as Req;
  return { request: () => finalReq, serverAddr: async () => null };
}

describe("navigationChainBlockCode", () => {
  it("passes a plain public navigation", async () => {
    const res = chain([{ url: "https://example.com/", ip: "203.0.113.10" }]);
    expect(await navigationChainBlockCode(res, "https://example.com/")).toBeNull();
  });

  it("blocks a public URL that redirects to the metadata address", async () => {
    const res = chain([
      { url: "https://redirector.example/go", ip: "203.0.113.10" },
      { url: "http://169.254.169.254/latest/meta-data/", ip: "169.254.169.254" },
    ]);
    expect(await navigationChainBlockCode(res, "http://169.254.169.254/latest/meta-data/")).toBe(
      "BLOCKED_DESTINATION",
    );
  });

  it("blocks a redirect hop to a sibling service even if the final page is public", async () => {
    const res = chain([
      { url: "https://a.example/", ip: "203.0.113.10" },
      { url: "http://warden:7070/keys/anthropic" },
      { url: "https://b.example/", ip: "203.0.113.11" },
    ]);
    expect(await navigationChainBlockCode(res, "https://b.example/")).toBe("BLOCKED_DESTINATION");
  });

  it("blocks a public name that resolved to loopback", async () => {
    const res = chain([{ url: "http://localtest.example/", ip: "127.0.0.1" }]);
    expect(await navigationChainBlockCode(res, "http://localtest.example/")).toBe("BLOCKED_DESTINATION");
  });

  it("checks the final URL even without a response (same-document navigations)", async () => {
    expect(await navigationChainBlockCode(null, "http://127.0.0.1/")).toBe("BLOCKED_DESTINATION");
    expect(await navigationChainBlockCode(null, "about:blank")).toBeNull();
  });
});

describe("gotoWithNavigationGuard", () => {
  it("parks the page on about:blank and throws when a redirect lands somewhere blocked", async () => {
    let current = "about:blank";
    const visited: string[] = [];
    const page = {
      goto: vi.fn(async (url: string) => {
        visited.push(url);
        if (url === "about:blank") {
          current = url;
          return null;
        }
        current = "http://169.254.169.254/latest/meta-data/";
        return chain([
          { url, ip: "203.0.113.10" },
          { url: current, ip: "169.254.169.254" },
        ]);
      }),
      url: () => current,
    };
    await expect(gotoWithNavigationGuard(page, "https://redirector.example/go")).rejects.toBeInstanceOf(
      BlockedNavigationError,
    );
    expect(visited).toEqual(["https://redirector.example/go", "about:blank"]);
    expect(current).toBe("about:blank");
  });

  it("refuses a blocked URL before navigating at all", async () => {
    const page = { goto: vi.fn(async () => null), url: () => "about:blank" };
    await expect(gotoWithNavigationGuard(page, "http://127.0.0.1/")).rejects.toBeInstanceOf(
      BlockedNavigationError,
    );
    expect(page.goto).not.toHaveBeenCalled();
  });
});

describe("gotoWithNavigationGuard when goto throws", () => {
  it("still parks a page left on a blocked URL and reports BLOCKED_DESTINATION", async () => {
    let current = "about:blank";
    const page = {
      goto: vi.fn(async (url: string) => {
        if (url === "about:blank") {
          current = url;
          return null;
        }
        current = "http://127.0.0.1:9223/json";
        throw new Error("page.goto: Timeout 30000ms exceeded.");
      }),
      url: () => current,
    };
    await expect(gotoWithNavigationGuard(page, "https://redirector.example/slow")).rejects.toBeInstanceOf(
      BlockedNavigationError,
    );
    expect(current).toBe("about:blank");
  });

  it("rethrows the navigation error when nothing blocked was reached", async () => {
    const page = {
      goto: vi.fn(async () => {
        throw new Error("net::ERR_NAME_NOT_RESOLVED");
      }),
      url: () => "about:blank",
    };
    await expect(gotoWithNavigationGuard(page, "https://nowhere.example/")).rejects.toThrow(
      "ERR_NAME_NOT_RESOLVED",
    );
  });
});

describe("installNavigationRouteGuard", () => {
  async function routeFor(url: string) {
    let handler: ((route: unknown) => Promise<void>) | undefined;
    await installNavigationRouteGuard({
      route: async (_pattern: string, h: (route: never) => Promise<void>) => {
        handler = h as (route: unknown) => Promise<void>;
      },
    });
    const route = { request: () => ({ url: () => url }), abort: vi.fn(async () => {}), fallback: vi.fn(async () => {}) };
    await handler!(route);
    return route;
  }

  it.each([
    "http://127.0.0.1:18081/",
    "http://169.254.169.254/latest/meta-data/",
    "http://warden:7070/keys/anthropic",
    "http://[::ffff:127.0.0.1]/",
  ])("aborts a page-initiated request to %s (meta refresh, script redirect, iframe)", async (url) => {
    const route = await routeFor(url);
    expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(route.fallback).not.toHaveBeenCalled();
  });

  it.each(["https://example.com/", "data:text/html,hi", "http://10.0.5.7/lan-service"])(
    "lets %s through",
    async (url) => {
      const route = await routeFor(url);
      expect(route.fallback).toHaveBeenCalled();
      expect(route.abort).not.toHaveBeenCalled();
    },
  );
});

describe("installPageNavigationWatchdog", () => {
  function watchedPage() {
    const listeners: Record<string, (arg: never) => void> = {};
    const page = {
      goto: vi.fn(async () => null),
      on: vi.fn((event: string, listener: (arg: never) => void) => {
        listeners[event] = listener;
      }),
      url: () => "https://example.com/",
    };
    installPageNavigationWatchdog(page as never);
    return { page, listeners };
  }

  it("parks the page when any frame commits a blocked URL", async () => {
    const { page, listeners } = watchedPage();
    listeners.framenavigated({ url: () => "http://169.254.169.254/" } as never);
    expect(page.goto).toHaveBeenCalledWith("about:blank");
  });

  it("parks the page when a document arrives from a blocked address", async () => {
    const { page, listeners } = watchedPage();
    listeners.response({
      request: () => ({ resourceType: () => "document" }),
      serverAddr: async () => ({ ipAddress: "127.0.0.1", port: 80 }),
    } as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(page.goto).toHaveBeenCalledWith("about:blank");
  });

  it("leaves ordinary navigations alone", async () => {
    const { page, listeners } = watchedPage();
    listeners.framenavigated({ url: () => "https://example.com/next" } as never);
    listeners.response({
      request: () => ({ resourceType: () => "document" }),
      serverAddr: async () => ({ ipAddress: "203.0.113.10", port: 443 }),
    } as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(page.goto).not.toHaveBeenCalled();
  });

  it("makes the next guarded goto report the block it parked", async () => {
    const listeners: Record<string, (arg: never) => void> = {};
    let current = "about:blank";
    const page = {
      on: vi.fn((event: string, listener: (arg: never) => void) => {
        listeners[event] = listener;
      }),
      goto: vi.fn(async (url: string) => {
        if (url === "about:blank") {
          current = url;
          return null;
        }
        current = "https://public.example/";
        // The page redirects itself somewhere blocked while goto is in flight.
        listeners.framenavigated({ url: () => "http://127.0.0.1:9223/json" } as never);
        return null;
      }),
      url: () => current,
    };
    installPageNavigationWatchdog(page as never);
    await expect(gotoWithNavigationGuard(page, "https://public.example/")).rejects.toBeInstanceOf(
      BlockedNavigationError,
    );
  });
});
