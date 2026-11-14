import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain .mjs module shipped beside cdp-proxy.mjs, no types
import { cdpRequestRejection, isAllowedCdpHostname } from "../docker/cdp-request-guard.mjs";

describe("cdp-request-guard", () => {
  it("accepts the docker service name the agent's BROWSER_CDP_URL uses", () => {
    expect(cdpRequestRejection({ host: "agent-abc123-browser-sidecar:9224" })).toBeNull();
  });

  it("accepts loopback and IP literals, like Chrome's own rule", () => {
    expect(cdpRequestRejection({ host: "localhost:9224" })).toBeNull();
    expect(cdpRequestRejection({ host: "127.0.0.1:9224" })).toBeNull();
    expect(cdpRequestRejection({ host: "172.18.0.5:9224" })).toBeNull();
    expect(cdpRequestRejection({ host: "[::1]:9224" })).toBeNull();
  });

  it("refuses a DNS-rebound public hostname", () => {
    expect(cdpRequestRejection({ host: "evil.example:9224" })).toBe("host-not-allowed");
    expect(cdpRequestRejection({ host: "127.0.0.1.nip.io:9224" })).toBe("host-not-allowed");
  });

  it("refuses a missing or malformed Host", () => {
    expect(cdpRequestRejection({})).toBe("host-not-allowed");
    expect(cdpRequestRejection({ host: "" })).toBe("host-not-allowed");
    expect(cdpRequestRejection({ host: "a:b:c" })).toBe("host-not-allowed");
    expect(cdpRequestRejection({ host: "localhost:abc" })).toBe("host-not-allowed");
  });

  it("refuses a WebSocket handshake from a web page on another origin", () => {
    expect(
      cdpRequestRejection({ host: "127.0.0.1:9224", origin: "https://evil.example" }),
    ).toBe("origin-not-allowed");
    // A page on another localhost port is still another origin.
    expect(
      cdpRequestRejection({ host: "localhost:9224", origin: "http://localhost:3000" }),
    ).toBe("origin-not-allowed");
    expect(cdpRequestRejection({ host: "localhost:9224", origin: "null" })).toBe(
      "origin-not-allowed",
    );
  });

  it("lets a client whose Origin names the proxy itself through", () => {
    expect(
      cdpRequestRejection({
        host: "agent-abc123-browser-sidecar:9224",
        origin: "http://agent-abc123-browser-sidecar:9224",
      }),
    ).toBeNull();
  });

  it("classifies hostnames", () => {
    expect(isAllowedCdpHostname("browser-sidecar")).toBe(true);
    expect(isAllowedCdpHostname("Browser-Sidecar")).toBe(true);
    expect(isAllowedCdpHostname("a.b")).toBe(false);
    expect(isAllowedCdpHostname("-bad")).toBe(false);
    expect(isAllowedCdpHostname("")).toBe(false);
  });
});
