import { verifyProviderNativePublicRuntime } from "../provider-native-public-readiness";

const cookie = `__Host-hivra_auth=${"b".repeat(64)}`;
const input = { access: { mode: "cloudflare-named" as const, hostname: "native.example.test", tunnelId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, sessionCookie: cookie };
function setup() {
  return jest.fn(async (url: string, options?: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname, headers = new Headers(options?.headers);
    if (path === "/healthz") return new Response("ok");
    if (path === "/api/meta") return Response.json({ agentKind: "deepseek-harness", surfaceAuth: "post-cookie-v1", nativeSurface: "/", nativeReady: true });
    if (!headers.has("cookie") || path === "/api/browser/status") return new Response(null, { status: 401 });
    return new Response('<!doctype html><html><head><base href="/"></head><body>native fixture</body></html>', { headers: { "content-type": "text/html; charset=utf-8" } });
  });
}
it("gates native and shell surfaces before relaying only the opaque native session", async () => {
  const fetcher = setup(); expect(await verifyProviderNativePublicRuntime(input, fetcher)).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(11);
  for (const [url, options] of fetcher.mock.calls) {
    expect(new URL(url).origin).toBe(`https://${input.access.hostname}`); expect(url).not.toContain(cookie);
    expect(options).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit", cache: "no-store" });
    expect(options?.signal?.aborted).toBe(true); expect(options?.body).toBeUndefined();
    expect(new Headers(options?.headers).has("authorization")).toBe(false);
  }
  for (const [, options] of fetcher.mock.calls.slice(0, 6)) expect(options?.headers).toEqual({});
  for (const [, options] of fetcher.mock.calls.slice(6)) expect(new Headers(options?.headers).get("cookie")).toBe(cookie);
});
it.each(["127.0.0.1", "localhost", "example.test:443", "Example.test", "example.test/path", "user:password@example.test", "xn--a.example", "example.test."])("rejects noncanonical native host %s", async hostname => {
  const fetcher = setup(); expect(await verifyProviderNativePublicRuntime({ ...input, access: { ...input.access, hostname } }, fetcher)).toBe(false); expect(fetcher).not.toHaveBeenCalled();
});
it.each([`hivra_auth=${"b".repeat(64)}`, `dsh-auth-secret=${"b".repeat(64)}`, cookie + "; Secure", "__Host-hivra_auth=secret", "a".repeat(64)])("rejects invalid session authority", async sessionCookie => {
  const fetcher = setup(); expect(await verifyProviderNativePublicRuntime({ ...input, sessionCookie }, fetcher)).toBe(false); expect(fetcher).not.toHaveBeenCalled();
});
it("accepts canonical standalone access without changing authority", async () => {
  const fetcher = setup();
  expect(await verifyProviderNativePublicRuntime({ ...input, access: { mode: "direct-https", hostname: "93-184-216-34.sslip.io", tunnelId: null } }, setup(), fetcher)).toBe(true);
  expect(fetcher.mock.calls.every(([url]) => new URL(url).hostname === "93-184-216-34.sslip.io")).toBe(true);
});
it.each(["health", "metadata", "nativeReady", "nativeSurface", "runtime", "oldAuth", "root", "terminal", "box", "vnc", "largeBody", "cookie"])("does not relay session after public %s failure", async fault => {
  const fetcher = setup(), normal = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, options) => {
    const path = new URL(url).pathname;
    if (fault === "health" && path === "/healthz") return new Response("ok", { status: 302 });
    if (path === "/api/meta") {
      if (fault === "largeBody") return new Response("x".repeat(8193)); if (fault === "metadata") return new Response("not json");
      return Response.json({ agentKind: fault === "runtime" ? "codex" : "deepseek-harness", surfaceAuth: fault === "oldAuth" ? "query" : "post-cookie-v1", nativeSurface: fault === "nativeSurface" ? "/untrusted" : "/", nativeReady: fault !== "nativeReady" });
    }
    if ((fault === "root" && path === "/") || (fault === "terminal" && path === "/terminal/") || (fault === "box" && path === "/box-terminal/") || (fault === "vnc" && path === "/vnc/")) return new Response(null);
    if (fault === "cookie" && path === "/") return new Response(null, { status: 401, headers: { "Set-Cookie": "unexpected=x" } });
    return normal(url, options);
  });
  expect(await verifyProviderNativePublicRuntime(input, fetcher)).toBe(false); expect(fetcher).toHaveBeenCalledTimes(6);
  expect(fetcher.mock.calls.every(([, options]) => !new Headers(options?.headers).has("cookie"))).toBe(true);
});
it.each(["root", "terminal", "box", "vnc", "managementAllowed", "notHtml", "wrongBase", "largeHtml", "cookieLeak", "sessionLeak"])("rejects authenticated native %s failure", async fault => {
  const fetcher = setup(), normal = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, options) => {
    if (!new Headers(options?.headers).has("cookie")) return normal(url, options);
    const path = new URL(url).pathname;
    if ((fault === "root" && path === "/") || (fault === "terminal" && path === "/terminal/") || (fault === "box" && path === "/box-terminal/") || (fault === "vnc" && path === "/vnc/")) return new Response(null, { status: 503 });
    if (fault === "managementAllowed" && path === "/api/browser/status") return new Response(null);
    if (path === "/") {
      let body = '<html><base href="/"></html>'; if (fault === "wrongBase") body = '<html><base href="/other"></html>';
      if (fault === "largeHtml") body += "x".repeat(1024 * 1024); if (fault === "sessionLeak") body += "b".repeat(64);
      return new Response(body, { headers: { "Content-Type": fault === "notHtml" ? "text/plain" : "text/html", ...(fault === "cookieLeak" ? { "Set-Cookie": "dsh-auth-private=secret" } : {}) } });
    }
    return normal(url, options);
  });
  expect(await verifyProviderNativePublicRuntime(input, fetcher)).toBe(false);
});
it("does not follow transport redirects or retry private failures", async () => {
  const redirect = setup(), normal = redirect.getMockImplementation()!;
  redirect.mockImplementation(async (url, options) => { const response = await normal(url, options); Object.defineProperty(response, "redirected", { value: true }); return response; });
  expect(await verifyProviderNativePublicRuntime(input, redirect)).toBe(false); expect(redirect).toHaveBeenCalledTimes(6);
  const failed = setup(); failed.mockRejectedValue(new Error("private-network-value"));
  expect(await verifyProviderNativePublicRuntime(input, failed)).toBe(false); expect(failed).toHaveBeenCalledTimes(6);
});
it("aborts stalled fetches within the public readiness budget", async () => {
  jest.useFakeTimers();
  try {
    const fetcher = jest.fn((_url: string, options?: RequestInit) => new Promise<Response>((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })));
    const result = verifyProviderNativePublicRuntime(input, fetcher); await jest.advanceTimersByTimeAsync(8000);
    expect(await result).toBe(false); expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});
