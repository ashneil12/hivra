/** @jest-environment jsdom */
import { createSurfaceMetadataCache, SURFACE_RECHECK_INTERVAL_MS } from "../useSurfaceBootstrap";

// The agent page's shared first check of a computer's gateway: every surface
// of that computer opens on one /api/meta answer, but only a usable one, and
// only while it is fresh enough to carry the current bootId.
describe("surface metadata cache", () => {
  const META = "https://box.example.com/api/meta";
  let answers: unknown[];
  let fetchMock: jest.Mock;
  beforeEach(() => {
    jest.useFakeTimers();
    answers = [];
    fetchMock = jest.fn(async () => ({ ok: true, json: async () => answers.shift() }));
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => jest.useRealTimers());
  const ready = (bootId: string) => ({ agentKind: "claude", surfaceAuth: "post-cookie-v1", bootId });

  it("answers every surface of a computer from one check, without sending the bearer", async () => {
    answers.push(ready("aaaaaaaa"));
    const cache = createSurfaceMetadataCache();
    const [first, second] = await Promise.all([cache.read(META, "token-1"), cache.read(META, "token-1")]);
    expect(first).toBe(second);
    expect(first.metadata).toEqual(ready("aaaaaaaa"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(META, expect.objectContaining({ credentials: "omit", cache: "no-store" }));
  });

  it("asks again once the answer is older than a background re-check, so a new surface learns the current bootId", async () => {
    answers.push(ready("aaaaaaaa"), ready("bbbbbbbb"));
    const cache = createSurfaceMetadataCache();
    await cache.read(META, "token-1");
    await jest.advanceTimersByTimeAsync(SURFACE_RECHECK_INTERVAL_MS);
    expect((await cache.read(META, "token-1")).metadata).toEqual(ready("bbbbbbbb"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never reuses an answer a surface cannot open on, a changed credential, or Try again", async () => {
    answers.push({ agentKind: "claude" }, ready("aaaaaaaa"), ready("bbbbbbbb"), ready("cccccccc"));
    const cache = createSurfaceMetadataCache();
    expect((await cache.read(META, "token-1")).metadata).toEqual({ agentKind: "claude" }); // needs an update
    expect((await cache.read(META, "token-1")).metadata).toEqual(ready("aaaaaaaa"));
    expect((await cache.read(META, "token-2")).metadata).toEqual(ready("bbbbbbbb"));
    expect((await cache.read(META, "token-2", true)).metadata).toEqual(ready("cccccccc"));
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not reuse a native interface that is still starting", async () => {
    answers.push({ ...ready("aaaaaaaa"), nativeSurface: "/", nativeReady: false }, { ...ready("aaaaaaaa"), nativeSurface: "/", nativeReady: true });
    const cache = createSurfaceMetadataCache();
    await cache.read(META, "token-1");
    expect((await cache.read(META, "token-1")).metadata).toMatchObject({ nativeReady: true });
  });

  it("reports why there was no answer, and asks again next time", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({}) });
    answers.push(ready("aaaaaaaa"));
    const cache = createSurfaceMetadataCache();
    expect(await cache.read(META, "token-1")).toMatchObject({ metadata: null, failure: "metadata answered HTTP 502" });
    expect((await cache.read(META, "token-1")).metadata).toEqual(ready("aaaaaaaa"));
  });
});
