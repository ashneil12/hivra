import { fetchWithInsecureTLS, insecureAgent } from "../lib/insecure-fetch";

describe("fetchWithInsecureTLS", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("exposes a reusable insecure dispatcher for the break-glass TLS path", () => {
    expect(insecureAgent).toBeDefined();
    expect(insecureAgent).not.toBeNull();
  });

  it("uses the platform fetch implementation without overriding TLS validation", async () => {
    const mockResponse = new Response("ok", { status: 200 });
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(mockResponse);

    const url = "https://10.240.0.1:8000/v1/models";
    const options = { method: "POST" };

    const res = await fetchWithInsecureTLS(url, options);

    expect(fetchSpy).toHaveBeenCalledWith(url, options);
    expect(res).toBe(mockResponse);
    fetchSpy.mockRestore();
  });

  it("attaches the insecure dispatcher only for managed sslip.io gateways", async () => {
    const mockResponse = new Response("ok", { status: 200 });
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(mockResponse);

    await fetchWithInsecureTLS("https://203-0-113-11.sslip.io/v1/models");

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://203-0-113-11.sslip.io/v1/models",
      expect.objectContaining({ dispatcher: insecureAgent })
    );
    fetchSpy.mockRestore();
  });

  it("does not trust arbitrary sslip.io subdomains unless explicitly overridden", async () => {
    const mockResponse = new Response("ok", { status: 200 });
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(mockResponse);

    await fetchWithInsecureTLS("https://agent.sslip.io/v1/models");

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://agent.sslip.io/v1/models",
      expect.not.objectContaining({ dispatcher: insecureAgent })
    );
    fetchSpy.mockRestore();
  });
});
