import { describe, expect, it } from "vitest";
import {
  isBlockedNavigationHost,
  assertNavigationAllowed,
  BlockedNavigationError,
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
