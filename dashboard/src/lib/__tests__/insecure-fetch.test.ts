import { fetchWithInsecureTLS, insecureAgent } from "@/lib/insecure-fetch";

describe("fetchWithInsecureTLS", () => {
  const originalFetch = global.fetch;
  const originalAllowInsecure = process.env.ALLOW_INSECURE_GATEWAY_TLS;
  const originalNodeTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ALLOW_INSECURE_GATEWAY_TLS;
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    global.fetch = jest.fn().mockResolvedValue(new Response("ok", { status: 200 })) as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
    if (originalAllowInsecure === undefined) delete process.env.ALLOW_INSECURE_GATEWAY_TLS;
    else process.env.ALLOW_INSECURE_GATEWAY_TLS = originalAllowInsecure;
    if (originalNodeTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalNodeTls;
  });

  it("uses a request-scoped insecure dispatcher for managed sslip.io gateways", async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response("ok", { status: 200 })) as typeof fetch;

    await fetchWithInsecureTLS("https://203-0-113-11.sslip.io/v1/models");

    expect(global.fetch).toHaveBeenCalledWith(
      "https://203-0-113-11.sslip.io/v1/models",
      expect.objectContaining({ dispatcher: insecureAgent })
    );
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
  });

  it("keeps TLS verification enabled for arbitrary sslip.io subdomains that do not match managed gateway hosts", async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response("ok", { status: 200 })) as typeof fetch;

    await fetchWithInsecureTLS("https://agent.sslip.io/v1/models");

    expect(global.fetch).toHaveBeenCalledWith(
      "https://agent.sslip.io/v1/models",
      expect.not.objectContaining({ dispatcher: insecureAgent })
    );
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
  });

  it("keeps TLS verification enabled for custom domains unless explicitly overridden", async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response("ok", { status: 200 })) as typeof fetch;

    await fetchWithInsecureTLS("https://agent.example.com/v1/models");

    expect(global.fetch).toHaveBeenCalledWith(
      "https://agent.example.com/v1/models",
      expect.not.objectContaining({ dispatcher: insecureAgent })
    );
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
  });

  it("allows an explicit break-glass override for custom domains without mutating global TLS state", async () => {
    process.env.ALLOW_INSECURE_GATEWAY_TLS = "true";
    global.fetch = jest.fn().mockResolvedValue(new Response("ok", { status: 200 })) as typeof fetch;

    await fetchWithInsecureTLS("https://agent.example.com/v1/models");

    expect(global.fetch).toHaveBeenCalledWith(
      "https://agent.example.com/v1/models",
      expect.objectContaining({ dispatcher: insecureAgent })
    );
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
  });
});
