import { describe, expect, it, vi } from "vitest";
import {
  isBlockedNavigationHost,
  assertNavigationAllowed,
  BlockedNavigationError,
  gotoWithNavigationGuard,
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
    const res = chain([{ url: "https://example.com/", ip: "93.184.216.34" }]);
    expect(await navigationChainBlockCode(res, "https://example.com/")).toBeNull();
  });

  it("blocks a public URL that redirects to the metadata address", async () => {
    const res = chain([
      { url: "https://redirector.example/go", ip: "93.184.216.34" },
      { url: "http://169.254.169.254/latest/meta-data/", ip: "169.254.169.254" },
    ]);
    expect(await navigationChainBlockCode(res, "http://169.254.169.254/latest/meta-data/")).toBe(
      "BLOCKED_DESTINATION",
    );
  });

  it("blocks a redirect hop to a sibling service even if the final page is public", async () => {
    const res = chain([
      { url: "https://a.example/", ip: "93.184.216.34" },
      { url: "http://warden:7070/keys/anthropic" },
      { url: "https://b.example/", ip: "93.184.216.35" },
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
          { url, ip: "93.184.216.34" },
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
