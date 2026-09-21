import { buildProxmoxGatewayCaddySite } from "../proxmox-gateway-caddy-site";

describe("buildProxmoxGatewayCaddySite", () => {
  const base = {
    privateIp: "10.250.20.77",
    instanceId: "00000000-0000-4000-8000-000000001012",
    dashboardOrigin: "https://hermesos.cloud",
  };

  it("pins current one-label routes to the static Origin CA certificate", () => {
    const out = buildProxmoxGatewayCaddySite({
      ...base,
      gatewayHost: "abc123.hermesos.cloud",
    });

    expect(out).toContain(
      "tls /etc/caddy/wildcards/hermesos.cloud.crt /etc/caddy/wildcards/hermesos.cloud.key",
    );
    expect(out).toContain("reverse_proxy 10.250.20.77:80");
    expect(out).toContain("flush_interval -1");
  });

  it.each(["abc123.203-0-113-10.sslip.io", "abc.example.com"])(
    "does not attach the one-label wildcard to uncovered host %s",
    (gatewayHost) => {
    const out = buildProxmoxGatewayCaddySite({ ...base, gatewayHost });

    expect(out).not.toContain("tls /etc/caddy/wildcards/hermesos.cloud.crt");
    },
  );

  it("rejects legacy nested Hermes hosts instead of re-enabling CertMagic", () => {
    expect(() =>
      buildProxmoxGatewayCaddySite({
        ...base,
        gatewayHost: "abc123.agents.hermesos.cloud",
      }),
    ).toThrow("not covered by the static Origin CA certificate");
  });

  it("emits the bearer-only variant when the dashboard origin is absent", () => {
    const out = buildProxmoxGatewayCaddySite({
      ...base,
      gatewayHost: "abc123.hermesos.cloud",
      dashboardOrigin: "",
    });

    expect(out).not.toContain("Access-Control-Allow-Origin");
    expect(out).toContain("flush_interval -1");
  });

  it("accepts a shell-expanded wake URL for the provision heredoc", () => {
    const out = buildProxmoxGatewayCaddySite({
      ...base,
      gatewayHost: "${GATEWAY_SITE_LABEL}",
      privateIp: "${PRIVATE_IP}",
      wakeRedirectUrl: "${WAKE_REDIRECT_URL}",
      useStaticOriginTls: true,
    });

    expect(out).toContain("${GATEWAY_SITE_LABEL} {");
    expect(out).toContain("redir ${WAKE_REDIRECT_URL} 302");
    expect(out).not.toContain("`");
  });
});
