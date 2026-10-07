import { parseImageRepo, ReleaseRegistryError, resolveGhcrTag } from "../registry";

const DIGEST = `sha256:${"a".repeat(64)}`;

function fakeFetch(handlers: { token?: () => Response; manifest?: () => Response }) {
  return jest.fn(async (url: string | URL | Request) => {
    const href = String(url);
    if (href.startsWith("https://ghcr.io/token")) return handlers.token?.() ?? new Response(JSON.stringify({ token: "t" }));
    return handlers.manifest?.() ?? new Response("{}", { headers: { "docker-content-digest": DIGEST } });
  }) as unknown as typeof fetch;
}

describe("resolveGhcrTag", () => {
  it("returns the digest GHCR reports for the tag", async () => {
    const fetchImpl = fakeFetch({});
    await expect(resolveGhcrTag("ghcr.io/example/agent", "v1-abc1234", fetchImpl)).resolves.toBe(DIGEST);
    const calls = (fetchImpl as unknown as jest.Mock).mock.calls.map((call) => String(call[0]));
    expect(calls[0]).toContain("scope=repository%3Aexample%2Fagent%3Apull");
    expect(calls[1]).toBe("https://ghcr.io/v2/example/agent/manifests/v1-abc1234");
  });

  it("reports a missing tag plainly", async () => {
    const fetchImpl = fakeFetch({ manifest: () => new Response("", { status: 404 }) });
    await expect(resolveGhcrTag("ghcr.io/example/agent", "nope", fetchImpl)).rejects.toThrow(/was not found/);
  });

  it("rejects a response without a valid digest", async () => {
    const fetchImpl = fakeFetch({ manifest: () => new Response("{}", { headers: { "docker-content-digest": "md5:abc" } }) });
    await expect(resolveGhcrTag("ghcr.io/example/agent", "t", fetchImpl)).rejects.toBeInstanceOf(ReleaseRegistryError);
  });

  it("only talks to ghcr.io and only with sane tags and paths", async () => {
    const fetchImpl = fakeFetch({});
    await expect(resolveGhcrTag("evil.example/example/agent", "t", fetchImpl)).rejects.toThrow(/Only ghcr.io/);
    await expect(resolveGhcrTag("ghcr.io/example/agent", "../x", fetchImpl)).rejects.toThrow(/tag is not valid/);
    expect(() => parseImageRepo("ghcr.io/Example/../agent")).toThrow(/path is not valid/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
