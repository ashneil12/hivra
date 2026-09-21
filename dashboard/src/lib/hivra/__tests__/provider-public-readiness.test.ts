import { verifyProviderPublicRuntime } from "../provider-public-readiness";

const input = { hostname: "box-fixture.hermesos.cloud", runtime: "codex" as const, apiToken: "a".repeat(64) };
function setup(runtime: typeof input.runtime | "aeon" = "codex") {
  const fetcher = jest.fn(async (url: string, options?: RequestInit) => {
    const path = new URL(url).pathname, headers = options?.headers as Record<string, string>;
    if (path === "/healthz") return new Response("ok");
    if (path === "/api/meta") return Response.json({ agentKind: runtime, surfaceAuth: "post-cookie-v1" });
    if (path === "/api/model") return headers.Authorization
      ? Response.json({ agentKind: runtime, model: null }) : Response.json({ error: "unauthorized" }, { status: 401 });
    return new Response("native surface");
  });
  return fetcher;
}
it("checks auth before sending the bearer and never changes its exact HTTPS origin or follows a redirect", async () => {
  const fetcher = setup();
  await expect(verifyProviderPublicRuntime(input, fetcher)).resolves.toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(6);
  for (const [url, options] of fetcher.mock.calls) {
    expect(new URL(url).origin).toBe("https://" + input.hostname);
    expect(url).not.toContain(input.apiToken);
    expect(options).toMatchObject({ method: "GET", redirect: "manual", cache: "no-store" });
    expect(options?.signal?.aborted).toBe(true); // all probes torn down
  }
  expect(fetcher.mock.calls.slice(0, 3).every(([, options]) => !Object.keys(options!.headers!).length)).toBe(true);
  expect(fetcher.mock.calls.slice(3).every(([, options]) => (options!.headers as Record<string, string>).Authorization === `Bearer ${input.apiToken}`)).toBe(true);
});
it.each(["127.0.0.1", "localhost", "169.254.169.254", "user:password@example.com", "example.com:123", "example.com/path"])("rejects unsafe origin %s before any fetch", async hostname => {
  const fetcher = setup();
  await expect(verifyProviderPublicRuntime({ ...input, hostname }, fetcher)).resolves.toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(["wrong_runtime", "old_auth", "health_redirect", "missing_auth", "body_limit"])("does not relay a bearer after %s", async kind => {
  const fetcher = setup(), initial = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, options) => {
    if (url.endsWith("/api/meta")) return kind === "body_limit" ? new Response("x".repeat(8193))
      : Response.json({ agentKind: kind === "wrong_runtime" ? "claude" : "codex", surfaceAuth: kind === "old_auth" ? "query-token" : "post-cookie-v1" });
    if (kind === "health_redirect" && url.endsWith("/healthz")) return new Response("ok", { status: 302 });
    if (kind === "missing_auth" && url.endsWith("/api/model")) return Response.json({ model: null });
    return initial(url, options);
  });
  expect(await verifyProviderPublicRuntime(input, fetcher)).toBe(false);
  expect(fetcher.mock.calls.every(([, options]) => !Object.keys(options!.headers!).length)).toBe(true);
});
it.each(["/api/model", "/terminal/", "/box-terminal/"])("requires authenticated readiness at %s", async broken => {
  const fetcher = setup(), initial = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, options) => new URL(url).pathname === broken && (options?.headers as Record<string, string>).Authorization
    ? new Response("Unavailable", { status: 503 }) : initial(url, options));
  expect(await verifyProviderPublicRuntime(input, fetcher)).toBe(false);
});
it("accepts a native first-run redirect without following it or forwarding its bearer", async () => {
  const fetcher = setup("aeon"), initial = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, options) => url.endsWith("/aeon/")
    ? new Response(null, { status: 308, headers: { Location: "/aeon" } }) : initial(url, options));
  expect(await verifyProviderPublicRuntime({ ...input, runtime: "aeon" }, fetcher)).toBe(true);
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/aeon"))).toHaveLength(0);
});
it("stops on delivery errors and never exposes the private error or retries", async () => {
  const fetcher = setup(); fetcher.mockRejectedValue(new Error("PRIVATE_NETWORK_MESSAGE"));
  expect(await verifyProviderPublicRuntime(input, fetcher)).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it("bounds stalled public requests and tears them down", async () => {
  jest.useFakeTimers();
  try {
    const fetcher = jest.fn((_url: string, options?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const result = verifyProviderPublicRuntime(input, fetcher);
    await jest.advanceTimersByTimeAsync(8000);
    expect(await result).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});
