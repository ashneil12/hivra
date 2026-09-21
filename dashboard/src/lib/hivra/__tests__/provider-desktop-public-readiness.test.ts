import { verifyProviderDesktopPublicRuntime } from "../provider-desktop-public-readiness";
// Exercise the real sealed broker document, not a second handoff implementation.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { handoffHtml } = require("../../../../provisioner/remote-desktop/broker.cjs") as { handoffHtml: (origin: string) => string };
const input = { access: { mode: "cloudflare-named" as const, hostname: "desktop.example.test", tunnelId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  controlOrigin: "https://canary.hermesos.cloud" };
function setup() {
  return jest.fn(async (url: string, options?: RequestInit): Promise<Response> => {
    void options;
    const path = new URL(url).pathname;
    if (path === "/healthz") return new Response("ok");
    if (path === "/api/meta") return Response.json({ agentKind: "linux-desktop", resourceKind: "computer", chatAvailable: false,
      loginAvailable: false, workspace: "Hivra", surfaceAuth: "post-cookie-v1" });
    if (path === "/") return new Response(null, { status: 404 });
    if (path === "/desktop/handoff") return new Response(handoffHtml(input.controlOrigin), { headers: {
      "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store", "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'self'; frame-ancestors ${input.controlOrigin}`,
    } });
    return new Response(null, { status: 401 });
  });
}
it.each(["cloudflare-named", "direct-https"] as const)("checks %s ingress without session authority", async mode => {
  const fetcher = setup(), unused = jest.fn();
  const access = mode === "direct-https" ? { mode, hostname: "93-184-216-34.sslip.io", tunnelId: null } : input.access;
  expect(await verifyProviderDesktopPublicRuntime({ ...input, access }, mode === "direct-https" ? unused : fetcher,
    mode === "direct-https" ? fetcher : unused)).toBe(true);
  expect(unused).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(5);
  expect(fetcher.mock.calls.map(([url]) => new URL(url).pathname)).toContain("/desktop/sessions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/");
  for (const [url, options] of fetcher.mock.calls) {
    expect(new URL(url).origin).toBe(`https://${access.hostname}`);
    expect(options).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit", cache: "no-store" });
    expect(options?.headers).toBeUndefined(); expect(options?.body).toBeUndefined();
  }
});
it.each(["http://example.test", "https://example.test/", "https://localhost", "https://user:secret@example.test"])("rejects control origin %s before network", async controlOrigin => {
  const fetcher = setup(); expect(await verifyProviderDesktopPublicRuntime({ ...input, controlOrigin }, fetcher)).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(["health", "metadata", "redirect", "redirected", "wrong-url", "cookie", "html", "large", "csp", "control", "protocol", "root", "media"])("rejects %s without retry", async fault => {
  const fetcher = setup(), normal = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, options) => {
    const path = new URL(url).pathname, response = await normal(url, options);
    if (fault === "health" && path === "/healthz") return Response.json({ status: "ok", protocol: "other" });
    if (fault === "metadata" && path === "/api/meta") return Response.json({ agentKind: "codex" });
    if (fault === "root" && path === "/" || fault === "media" && path.startsWith("/desktop/sessions/")) return new Response(null);
    if (path !== "/desktop/handoff") return response;
    if (fault === "redirect") return new Response(null, { status: 302 });
    if (fault === "redirected") Object.defineProperty(response, "redirected", { value: true });
    if (fault === "wrong-url") Object.defineProperty(response, "url", { value: "https://other.example.test/desktop/handoff" });
    if (fault === "cookie") response.headers.set("set-cookie", "unexpected=x");
    if (fault === "html") response.headers.set("content-type", "text/plain");
    if (fault === "csp") response.headers.set("content-security-policy", "frame-ancestors *");
    if (["large", "control", "protocol"].includes(fault)) return new Response(fault === "large" ? "x".repeat(128 * 1024 + 1)
      : handoffHtml(fault === "control" ? "https://wrong.example.test" : input.controlOrigin).replace(fault === "protocol" ? "hivra.remote-desktop.handoff.v2" : "UNUSED", "other"), { headers: response.headers });
    return response;
  });
  expect(await verifyProviderDesktopPublicRuntime(input, fetcher)).toBe(false); expect(fetcher).toHaveBeenCalledTimes(5);
});
it("aborts stalled requests within eight seconds", async () => {
  jest.useFakeTimers();
  try {
    const fetcher = jest.fn((_url: string, options?: RequestInit) => new Promise<Response>((_resolve, reject) =>
      options?.signal?.addEventListener("abort", () => reject(new Error("private")), { once: true })));
    const pending = verifyProviderDesktopPublicRuntime(input, fetcher); await jest.advanceTimersByTimeAsync(8000);
    expect(await pending).toBe(false); expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});
