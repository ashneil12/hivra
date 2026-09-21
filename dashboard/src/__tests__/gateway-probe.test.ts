import { buildGatewayProbeUrls } from "@/lib/gateway-probe";

describe("buildGatewayProbeUrls", () => {
  it("keeps secure https URLs when the stored gateway URL is already https", () => {
    expect(buildGatewayProbeUrls("https://agent.example.com", "/v1/models")).toEqual([
      "https://agent.example.com/v1/models",
    ]);
  });

  it("upgrades insecure stored gateway URLs to https", () => {
    expect(buildGatewayProbeUrls("http://203.0.113.10", "/v1/chat/completions")).toEqual([
      "https://203.0.113.10/v1/chat/completions",
    ]);
  });

  it("strips a trailing slash from the base URL before joining", () => {
    const urls = buildGatewayProbeUrls("https://agent.example.com/", "/v1/models");
    expect(urls[0]).toBe("https://agent.example.com/v1/models");
    // Should NOT produce double-slash
    expect(urls[0]).not.toContain("//v1");
  });

  it("prepends a slash to the pathname when the caller omits it", () => {
    const urls = buildGatewayProbeUrls("https://agent.example.com", "v1/models");
    expect(urls[0]).toBe("https://agent.example.com/v1/models");
  });

  it("produces exactly 1 secure url", () => {
    const urls = buildGatewayProbeUrls("http://203.0.113.4", "/health");
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/^https:\/\//);
  });

  it("handles bare IP + port correctly", () => {
    const urls = buildGatewayProbeUrls("http://203.0.113.4:8080", "/api");
    expect(urls[0]).toBe("https://203.0.113.4:8080/api");
  });

  it("works with a subdomain FQDN", () => {
    const urls = buildGatewayProbeUrls("https://abc123.hermesdeploy.com", "/v1/chat/completions");
    expect(urls[0]).toBe("https://abc123.hermesdeploy.com/v1/chat/completions");
  });

  it("adds an http IPv4 fallback when provided", () => {
    expect(
      buildGatewayProbeUrls("https://203-0-113-11.sslip.io", "/v1/models", {
        instanceIpv4: "203.0.113.11",
      })
    ).toEqual([
      "https://203-0-113-11.sslip.io/v1/models",
      "http://203.0.113.11/v1/models",
    ]);
  });

  it("preserves profile paths when building the IPv4 fallback", () => {
    expect(
      buildGatewayProbeUrls("https://203-0-113-11.sslip.io/profiles/research", "/api/sessions", {
        instanceIpv4: "203.0.113.11",
      })
    ).toEqual([
      "https://203-0-113-11.sslip.io/profiles/research/api/sessions",
      "http://203.0.113.11/profiles/research/api/sessions",
    ]);
  });

  it("adds a direct profile-port fallback that bypasses Caddy when available", () => {
    expect(
      buildGatewayProbeUrls("https://203-0-113-11.sslip.io/profiles/research", "/api/sessions", {
        instanceIpv4: "203.0.113.11",
        profileGatewayPort: 8650,
      })
    ).toEqual([
      "http://203.0.113.11:8650/api/sessions",
      "https://203-0-113-11.sslip.io/profiles/research/api/sessions",
      "http://203.0.113.11/profiles/research/api/sessions",
    ]);
  });

  it("routes sidecar probes at the instance root even when the gateway URL includes a profile path", () => {
    expect(
      buildGatewayProbeUrls("https://203-0-113-11.sslip.io/profiles/research", "/_sidecar/api/terminal", {
        instanceIpv4: "203.0.113.11",
        profileGatewayPort: 8650,
      })
    ).toEqual([
      "https://203-0-113-11.sslip.io/_sidecar/api/terminal",
      "http://203.0.113.11/_sidecar/api/terminal",
    ]);
  });
});
