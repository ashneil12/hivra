import {
  createOfficialDashboardLoginUrl,
  normalizeOfficialDashboardPath,
  resolveOfficialDashboardGatewayUrl,
} from "@/lib/official-dashboard-handoff";

describe("official dashboard handoff", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("allows normal in-gateway paths", () => {
    expect(normalizeOfficialDashboardPath("/")).toBe("/");
    expect(normalizeOfficialDashboardPath("/sessions?tab=active")).toBe("/sessions?tab=active");
  });

  it("rejects scheme-relative redirect paths", () => {
    expect(() => normalizeOfficialDashboardPath("//evil.example")).toThrow(
      "Official dashboard redirects must stay on the gateway host"
    );
  });

  it("rejects backslash-containing redirect paths", () => {
    expect(() => normalizeOfficialDashboardPath("/\\evil.example")).toThrow(
      "Official dashboard redirects must stay on the gateway host"
    );
  });

  it("does not generate login URLs for scheme-relative redirect paths", () => {
    expect(() =>
      createOfficialDashboardLoginUrl({
        gatewayUrl: "https://agent.example.com",
        apiServerKey: "server-key",
        nextPath: "//evil.example",
      })
    ).toThrow("Official dashboard redirects must stay on the gateway host");
  });

  it("keeps custom-domain gateways on their original HTTPS host", () => {
    expect(
      resolveOfficialDashboardGatewayUrl({
        gatewayUrl: "https://agent.example.com",
        instanceIpv4: "203.0.113.10",
      })
    ).toBe("https://agent.example.com");
  });

  it("keeps managed sslip.io gateways on their issued HTTPS host", () => {
    expect(
      resolveOfficialDashboardGatewayUrl({
        gatewayUrl: "https://203-0-113-10.sslip.io",
        instanceIpv4: "203.0.113.10",
      })
    ).toBe("https://203-0-113-10.sslip.io");
  });

  it("drops profile path suffixes before building the sidecar login URL", () => {
    const loginUrl = createOfficialDashboardLoginUrl({
      gatewayUrl: "https://agent.example.com/profiles/research",
      apiServerKey: "server-key",
      nextPath: "/",
    });

    expect(new URL(loginUrl).pathname).toBe("/_sidecar/dashboard-login");
  });

  it("leaves clock-skew headroom under the sidecar maximum login expiry", () => {
    const issuedAt = 1_800_000_000_000;
    jest.spyOn(Date, "now").mockReturnValue(issuedAt);

    const loginUrl = createOfficialDashboardLoginUrl({
      gatewayUrl: "https://agent.example.com",
      apiServerKey: "server-key",
      nextPath: "/",
    });

    const expiresAt = Number(new URL(loginUrl).searchParams.get("exp"));

    expect(expiresAt - issuedAt).toBeLessThanOrEqual(45_000);
  });
});
