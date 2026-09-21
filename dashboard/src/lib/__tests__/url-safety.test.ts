import { checkOutboundUrlSafety } from "@/lib/url-safety";

describe("checkOutboundUrlSafety", () => {
  it.each([
    "https://api.openai.com/v1",
    "https://api.example.com:8443/path",
    "http://example.com",
    "https://203.0.113.10/v1",
    "https://[2001:db8::1]/v1",
    // Boundary cases that are NOT in any blocked range and must stay allowed:
    "https://11.0.0.1/v1", // not 10.0.0.0/8
    "https://172.15.0.1/v1", // just below 172.16.0.0/12
    "https://172.32.0.1/v1", // just above 172.16.0.0/12
    "https://193.168.0.1/v1", // not 192.168.0.0/16
    "https://100.63.0.1/v1", // just below 100.64.0.0/10 (CGNAT)
    "https://100.128.0.1/v1", // just above 100.64.0.0/10 (CGNAT)
  ])("accepts public URL %s", (url) => {
    expect(checkOutboundUrlSafety(url)).toEqual({ ok: true });
  });

  it.each([
    ["10/8 private", "http://10.240.0.5:8006/"],
    ["10/8 upper", "http://10.255.255.255/"],
    ["172.16/12 lower", "http://172.16.0.1/"],
    ["172.16/12 upper", "http://172.31.255.254/"],
    ["192.168/16", "http://192.168.1.1/api"],
    ["CGNAT 100.64/10 lower", "http://100.64.0.1/"],
    ["CGNAT 100.64/10 upper", "http://100.127.255.254/"],
    ["IPv6 ULA fc00::/7 (fc)", "http://[fc00::1]/x"],
    ["IPv6 ULA fc00::/7 (fd)", "http://[fd12:3456:789a::1]/x"],
    ["IPv6-mapped 10/8", "http://[::ffff:10.240.0.1]/x"],
    ["IPv6-mapped 192.168", "http://[::ffff:192.168.1.1]/x"],
    ["IPv6-mapped full-form 10/8", "http://[0:0:0:0:0:ffff:a00:1]/x"],
  ])("rejects private/reserved %s", (_label, url) => {
    expect(checkOutboundUrlSafety(url).ok).toBe(false);
  });

  it("allows a private address only when the caller explicitly opts in", () => {
    expect(checkOutboundUrlSafety("http://10.240.0.5:8006/").ok).toBe(false);
    expect(
      checkOutboundUrlSafety("http://10.240.0.5:8006/", { allowPrivateNetwork: true }),
    ).toEqual({ ok: true });
    // The opt-out is intentionally narrow: localhost/loopback aliases are
    // still rejected because they are never a real destination host.
    expect(
      checkOutboundUrlSafety("http://localhost:11434/", { allowPrivateNetwork: true }).ok,
    ).toBe(false);
  });

  it.each([
    ["empty string", ""],
    ["whitespace only", "   "],
  ])("rejects %s", (_label, url) => {
    const result = checkOutboundUrlSafety(url);
    expect(result.ok).toBe(false);
  });

  it.each([
    ["file://", "file:///etc/passwd"],
    ["gopher://", "gopher://example.com/"],
    ["ftp://", "ftp://example.com/"],
    ["javascript:", "javascript:alert(1)"],
  ])("rejects scheme %s", (_label, url) => {
    expect(checkOutboundUrlSafety(url)).toEqual({ ok: false, reason: "unsupported_scheme" });
  });

  it.each([
    ["localhost", "http://localhost:11434/v1"],
    ["127.0.0.1", "http://127.0.0.1:8080/api"],
    ["127.255.255.254", "http://127.255.255.254/x"],
    ["AWS metadata", "http://169.254.169.254/latest/meta-data/"],
    ["GCP metadata", "http://169.254.169.254/computeMetadata/v1/"],
    ["::1", "http://[::1]/x"],
    ["::", "http://[::]/x"],
    ["IPv6-mapped 127", "http://[::ffff:127.0.0.1]/x"],
    ["IPv6-mapped full-form 127", "http://[0:0:0:0:0:ffff:7f00:1]/x"],
    ["fe80 link-local", "http://[fe80::1]/x"],
    ["0.0.0.0", "http://0.0.0.0/"],
  ])("rejects %s", (_label, url) => {
    const result = checkOutboundUrlSafety(url);
    expect(result.ok).toBe(false);
  });

  it("rejects garbage that isn't a valid URL", () => {
    expect(checkOutboundUrlSafety("not a url")).toEqual({ ok: false, reason: "invalid_url" });
  });
});
