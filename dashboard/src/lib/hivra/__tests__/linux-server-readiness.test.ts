import { LINUX_SERVER_WRONG_KIND_MESSAGE, verifyLinuxServerPublicRuntime } from "../linux-server-readiness";

const ORIGIN = "https://box.example.com";
const meta = (overrides: Record<string, unknown> = {}) => ({
  agentKind: "linux-server", resourceKind: "computer", chatAvailable: false, loginAvailable: false,
  workspace: "Hivra", surfaceAuth: "post-cookie-v1", bootId: "x", ...overrides,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("Linux computer gateway readiness", () => {
  it("accepts a gateway that answers as a linux-server computer, asking with a plain GET", async () => {
    const fetcher = jest.fn().mockResolvedValue(json(meta()));
    await expect(verifyLinuxServerPublicRuntime(ORIGIN, fetcher)).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledWith(`${ORIGIN}/api/meta`, expect.objectContaining({ method: "GET", credentials: "omit", redirect: "manual" }));
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty("headers");
  });

  it.each([
    ["the desktop kind", meta({ agentKind: "linux-desktop" })],
    ["an agent kind", meta({ agentKind: "claude" })],
    ["a missing computer resource kind", meta({ resourceKind: undefined })],
    ["a different surface auth", meta({ surfaceAuth: "bearer" })],
  ])("fails for good on %s", async (_label, body) => {
    await expect(verifyLinuxServerPublicRuntime(ORIGIN, jest.fn().mockResolvedValue(json(body)))).resolves.toEqual({
      ok: false, retryable: false, failureCode: "wrong_kind", ownerMessage: LINUX_SERVER_WRONG_KIND_MESSAGE,
    });
  });

  it.each([
    ["a network error", () => jest.fn().mockRejectedValue(new Error("ETIMEDOUT"))],
    ["a 404", () => jest.fn().mockResolvedValue(json({}, 404))],
    ["a redirect", () => jest.fn().mockResolvedValue(json({}, 302))],
    ["a followed redirect", () => jest.fn().mockResolvedValue({ redirected: true, status: 200, body: null })],
    ["text that is not JSON", () => jest.fn().mockResolvedValue(new Response("nope", { status: 200 }))],
    ["JSON that names no kind", () => jest.fn().mockResolvedValue(json({ ok: true }))],
    ["JSON that is not an object", () => jest.fn().mockResolvedValue(json([1, 2]))],
    ["an oversized answer", () => jest.fn().mockResolvedValue(new Response("x".repeat(20 * 1024), { status: 200 }))],
  ])("can be retried after %s", async (_label, makeFetcher) => {
    await expect(verifyLinuxServerPublicRuntime(ORIGIN, makeFetcher())).resolves.toEqual({
      ok: false, retryable: true, failureCode: "meta_unavailable",
    });
  });

  it.each(["http://box.example.com", "https://box.example.com/path", "https://127.0.0.1", "not a url"])(
    "never fetches %s",
    async (origin) => {
      const fetcher = jest.fn();
      await expect(verifyLinuxServerPublicRuntime(origin, fetcher)).resolves.toMatchObject({ ok: false, retryable: true });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
});
