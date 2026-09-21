// Init-safe posthog client wrappers: queue calls made before init, flush them
// in order once init completes, and never throw. Regression coverage for
// canary #129 (PostHog API called before deferred init completes).

type PosthogMock = {
  capture: jest.Mock;
  identify: jest.Mock;
  reset: jest.Mock;
  get_distinct_id: jest.Mock;
  _isIdentified: jest.Mock;
  __loaded: boolean;
};

jest.mock("posthog-js", () => ({
  __esModule: true,
  default: {
    capture: jest.fn(),
    identify: jest.fn(),
    reset: jest.fn(),
    // Anonymous state by default; individual tests override.
    get_distinct_id: jest.fn(() => "anon-device-id"),
    _isIdentified: jest.fn(() => false),
    __loaded: false,
  },
}));

type ClientModule = typeof import("../posthog-client");

async function load(): Promise<{ posthog: PosthogMock; mod: ClientModule }> {
  jest.resetModules();
  const posthog = (await import("posthog-js")).default as unknown as PosthogMock;
  const mod = await import("../posthog-client");
  return { posthog, mod };
}

describe("posthog-client init-safe wrappers", () => {
  it("queues captures fired before init and does not touch posthog yet", async () => {
    const { posthog, mod } = await load();

    mod.captureClient("before_init", { a: 1 });

    expect(posthog.capture).not.toHaveBeenCalled();
    expect(mod.isPostHogReady()).toBe(false);
  });

  it("flushes queued calls in FIFO order once init completes", async () => {
    const { posthog, mod } = await load();
    posthog._isIdentified.mockReturnValue(true);

    mod.captureClient("first", { n: 1 });
    mod.identifyUserClient("user-123", { email: "x@y.z" });
    mod.captureClient("second", { n: 2 });
    mod.resetIfIdentifiedClient();

    expect(posthog.capture).not.toHaveBeenCalled();
    expect(posthog.identify).not.toHaveBeenCalled();
    expect(posthog.reset).not.toHaveBeenCalled();

    mod.flushPostHogQueue();

    expect(posthog.capture.mock.calls).toEqual([
      ["first", { n: 1 }],
      ["second", { n: 2 }],
    ]);
    expect(posthog.identify).toHaveBeenCalledWith("user-123", { email: "x@y.z" });
    expect(posthog.reset).toHaveBeenCalledTimes(1);
    expect(mod.isPostHogReady()).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Stitch-safe identify/reset semantics. The whole point of these wrappers is
  // the anon→identified person merge: identify must fire on a real identity
  // change, and reset must NEVER touch an anonymous visitor (an unconditional
  // reset regenerated the anon distinct_id and orphaned all pre-auth pageviews
  // — 2026-07 PostHog audit).
  // -------------------------------------------------------------------------

  it("identifyUserClient identifies when the current distinct_id differs", async () => {
    const { posthog, mod } = await load();
    mod.flushPostHogQueue();
    posthog.get_distinct_id.mockReturnValue("anon-abc");

    mod.identifyUserClient("user_clerk_1", { email: "a@b.c" });

    expect(posthog.identify).toHaveBeenCalledTimes(1);
    expect(posthog.identify).toHaveBeenCalledWith("user_clerk_1", { email: "a@b.c" });
  });

  it("identifyUserClient no-ops when posthog already carries the same user id", async () => {
    const { posthog, mod } = await load();
    mod.flushPostHogQueue();
    posthog.get_distinct_id.mockReturnValue("user_clerk_1");

    mod.identifyUserClient("user_clerk_1", { email: "a@b.c" });

    expect(posthog.identify).not.toHaveBeenCalled();
  });

  it("evaluates a queued identify against the LIVE distinct_id at flush time", async () => {
    const { posthog, mod } = await load();
    // Queued while uninitialized; by flush time the persisted distinct_id is
    // already this user (returning visitor) — no redundant identify.
    posthog.get_distinct_id.mockReturnValue("user_clerk_1");

    mod.identifyUserClient("user_clerk_1");
    mod.flushPostHogQueue();

    expect(posthog.identify).not.toHaveBeenCalled();
  });

  it("resetIfIdentifiedClient never resets an anonymous visitor", async () => {
    const { posthog, mod } = await load();
    mod.flushPostHogQueue();
    posthog._isIdentified.mockReturnValue(false);

    mod.resetIfIdentifiedClient();

    expect(posthog.reset).not.toHaveBeenCalled();
  });

  it("resetIfIdentifiedClient resets a genuinely signed-out (identified) visitor", async () => {
    const { posthog, mod } = await load();
    mod.flushPostHogQueue();
    posthog._isIdentified.mockReturnValue(true);

    mod.resetIfIdentifiedClient();

    expect(posthog.reset).toHaveBeenCalledTimes(1);
  });

  it("fails safe (no reset) when identity state cannot be determined", async () => {
    const { posthog, mod } = await load();
    mod.flushPostHogQueue();
    // Simulate a client with no introspection surface at all.
    (posthog as unknown as Record<string, unknown>)._isIdentified = undefined;
    (posthog as unknown as Record<string, unknown>).get_distinct_id = undefined;

    mod.resetIfIdentifiedClient();

    expect(posthog.reset).not.toHaveBeenCalled();
  });

  it("passes calls straight through after the queue has flushed", async () => {
    const { posthog, mod } = await load();

    mod.flushPostHogQueue();
    mod.captureClient("after_init", { ok: true });

    expect(posthog.capture).toHaveBeenCalledTimes(1);
    expect(posthog.capture).toHaveBeenCalledWith("after_init", { ok: true });
  });

  it("treats posthog.__loaded === true as ready even without an explicit flush", async () => {
    const { posthog, mod } = await load();
    posthog.__loaded = true;

    expect(mod.isPostHogReady()).toBe(true);
    mod.captureClient("loaded_direct");

    expect(posthog.capture).toHaveBeenCalledWith("loaded_direct", undefined);
  });

  it("never throws when the underlying posthog call throws", async () => {
    const { posthog, mod } = await load();
    posthog.capture.mockImplementation(() => {
      throw new Error("posthog boom");
    });
    mod.flushPostHogQueue();

    expect(() => mod.captureClient("explosive")).not.toThrow();
    expect(posthog.capture).toHaveBeenCalledTimes(1);
  });

  it("swallows a throw inside a queued call and still flushes the rest", async () => {
    const { posthog, mod } = await load();
    posthog.capture.mockImplementationOnce(() => {
      throw new Error("first call explodes");
    });

    mod.captureClient("explodes");
    mod.captureClient("survives", { ok: true });

    expect(() => mod.flushPostHogQueue()).not.toThrow();
    expect(posthog.capture).toHaveBeenCalledTimes(2);
    expect(posthog.capture).toHaveBeenLastCalledWith("survives", { ok: true });
  });

  it("bounds the pre-init queue, dropping the oldest calls past the cap", async () => {
    const { posthog, mod } = await load();

    const MAX = 50;
    const total = MAX + 10;
    for (let i = 0; i < total; i += 1) {
      mod.captureClient(`event_${i}`);
    }

    mod.flushPostHogQueue();

    expect(posthog.capture).toHaveBeenCalledTimes(MAX);
    // The oldest 10 were dropped; the first surviving call is event_10.
    expect(posthog.capture.mock.calls[0]).toEqual(["event_10", undefined]);
    expect(posthog.capture.mock.calls[MAX - 1]).toEqual([`event_${total - 1}`, undefined]);
  });

  it("is idempotent across repeated flushes", async () => {
    const { posthog, mod } = await load();

    mod.captureClient("queued");
    mod.flushPostHogQueue();
    mod.flushPostHogQueue();

    expect(posthog.capture).toHaveBeenCalledTimes(1);
  });
});
