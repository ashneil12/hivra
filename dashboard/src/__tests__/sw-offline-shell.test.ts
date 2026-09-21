import fs from "fs";
import path from "path";
import vm from "vm";

// The service worker ships as a plain script in dashboard/public/sw.js (outside
// the bundle, so it cannot be imported). We load its source into a sandboxed VM
// with mocked Service Worker globals and drive the lifecycle/fetch handlers to
// assert the offline-shell behaviour described in the PWA offline-shell item.
const SW_PATH = path.join(__dirname, "..", "..", "public", "sw.js");

type EventHandler = (event: Record<string, unknown>) => void;

function loadServiceWorker() {
  const listeners: Record<string, EventHandler> = {};
  const stores = new Map<string, Map<string, unknown>>();
  const cacheCalls = {
    open: [] as string[],
    addAll: [] as string[][],
    match: [] as string[],
    put: [] as string[],
    delete: [] as string[],
  };

  function openStore(name: string) {
    if (!stores.has(name)) {
      stores.set(name, new Map());
    }
    const store = stores.get(name)!;
    return {
      async addAll(urls: string[]) {
        cacheCalls.addAll.push([...urls]);
        for (const url of urls) {
          store.set(url, { url, fromPrecache: true });
        }
      },
      async put(request: { url: string } | string, response: unknown) {
        const key = typeof request === "string" ? request : request.url;
        cacheCalls.put.push(key);
        store.set(key, response);
      },
      async match(request: { url: string } | string) {
        const key = typeof request === "string" ? request : request.url;
        cacheCalls.match.push(key);
        return store.has(key) ? store.get(key) : undefined;
      },
    };
  }

  const caches = {
    open: async (name: string) => {
      cacheCalls.open.push(name);
      return openStore(name);
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => {
      cacheCalls.delete.push(name);
      return stores.delete(name);
    },
  };

  const self: Record<string, unknown> = {
    location: { origin: "https://canary.test" },
    addEventListener: (type: string, handler: EventHandler) => {
      listeners[type] = handler;
    },
    skipWaiting: jest.fn(async () => {}),
    clients: { claim: jest.fn(async () => {}) },
  };

  const harness = {
    fetchImpl: (async () => {
      throw new Error("unexpected fetch");
    }) as (...args: unknown[]) => Promise<unknown>,
  };

  const sandbox: Record<string, unknown> = {
    self,
    caches,
    Response: { error: () => ({ type: "error" }) },
    URL,
    console,
    fetch: (...args: unknown[]) => harness.fetchImpl(...args),
  };

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SW_PATH, "utf8"), sandbox);

  const cacheName = "hivra-pwa-" + (self.HERMES_SW_BUILD as string);

  return { listeners, self, caches, stores, harness, cacheName, cacheCalls };
}

async function runLifecycle(handler: EventHandler) {
  let waited: Promise<unknown> | undefined;
  handler({ waitUntil: (p: Promise<unknown>) => { waited = p; } });
  await waited;
}

function makeRequest(url: string, { method = "GET", mode = "navigate" } = {}) {
  return { url, method, mode };
}

function dispatchFetch(
  listeners: Record<string, EventHandler>,
  request: ReturnType<typeof makeRequest>,
  extended: Array<Promise<unknown>> = []
): Promise<unknown> | undefined {
  let responded: Promise<unknown> | undefined;
  listeners.fetch({
    request,
    respondWith: (p: Promise<unknown>) => { responded = p; },
    waitUntil: (p: Promise<unknown>) => { extended.push(p); },
  });
  return responded;
}

describe("PWA offline-shell service worker", () => {
  describe("install", () => {
    it("precaches the branded /offline shell and activates immediately", async () => {
      const sw = loadServiceWorker();
      await runLifecycle(sw.listeners.install);

      const store = sw.stores.get(sw.cacheName);
      expect(store?.has("/offline")).toBe(true);
      expect(sw.self.skipWaiting).toHaveBeenCalled();
    });
  });

  describe("activate", () => {
    it("purges only older Hivra caches while keeping current and unrelated caches", async () => {
      const sw = loadServiceWorker();
      sw.stores.set("hivra-pwa-2026-05-03T18:30Z-chat-stream-retired", new Map());
      sw.stores.set(sw.cacheName, new Map([["/offline", { url: "/offline" }]]));
      sw.stores.set("hermes-pwa-legacy-offline-shell", new Map());
      sw.stores.set("some-unrelated-cache", new Map());

      await runLifecycle(sw.listeners.activate);

      expect(sw.stores.has("hivra-pwa-2026-05-03T18:30Z-chat-stream-retired")).toBe(false);
      expect(sw.stores.has(sw.cacheName)).toBe(true);
      expect(sw.stores.has("hermes-pwa-legacy-offline-shell")).toBe(true);
      expect(sw.stores.has("some-unrelated-cache")).toBe(true);
      expect(sw.cacheCalls.delete).toEqual([
        "hivra-pwa-2026-05-03T18:30Z-chat-stream-retired",
      ]);
      expect(sw.self.clients).toBeDefined();
      expect((sw.self.clients as { claim: jest.Mock }).claim).toHaveBeenCalled();
    });
  });

  describe("fetch — navigations", () => {
    it("serves the live page when the network is up and never caches it", async () => {
      const sw = loadServiceWorker();
      await runLifecycle(sw.listeners.install);

      const live = { ok: true, body: "live-html" };
      sw.harness.fetchImpl = jest.fn(async () => live);

      const responded = dispatchFetch(sw.listeners, makeRequest("https://canary.test/"));
      await expect(responded).resolves.toBe(live);

      // Signed-in HTML must never enter the cache.
      const store = sw.stores.get(sw.cacheName);
      expect(store?.has("https://canary.test/")).toBe(false);
    });

    it("falls back to the cached offline shell when the network is down", async () => {
      const sw = loadServiceWorker();
      await runLifecycle(sw.listeners.install);

      sw.harness.fetchImpl = jest.fn(async () => {
        throw new Error("offline");
      });

      const responded = dispatchFetch(sw.listeners, makeRequest("https://canary.test/"));
      await expect(responded).resolves.toMatchObject({ url: "/offline", fromPrecache: true });
    });
  });

  describe("fetch — offline-shell self-heal", () => {
    it("re-caches the public /offline shell after a successful navigation when the precache missed", async () => {
      const sw = loadServiceWorker();
      // Simulate a transient precache miss on install: the cache exists but the
      // /offline shell never landed (install deliberately swallows that failure).
      sw.stores.set(sw.cacheName, new Map());
      expect(sw.stores.get(sw.cacheName)?.has("/offline")).toBe(false);

      const offlineShell = { ok: true, clone: () => ({ url: "/offline", healed: true }) };
      const live = { ok: true, body: "live-html" };
      sw.harness.fetchImpl = jest.fn(async (req: unknown) => {
        const url = typeof req === "string" ? req : (req as { url: string }).url;
        return url === "/offline" ? offlineShell : live;
      });

      const extended: Array<Promise<unknown>> = [];
      const responded = dispatchFetch(
        sw.listeners,
        makeRequest("https://canary.test/"),
        extended
      );

      // The live navigation is returned immediately and unmodified...
      await expect(responded).resolves.toBe(live);
      // ...while the offline shell is repaired in the background.
      await Promise.all(extended);

      const store = sw.stores.get(sw.cacheName);
      expect(store?.get("/offline")).toMatchObject({ healed: true });
      // The (possibly signed-in) navigation HTML is never cached.
      expect(store?.has("https://canary.test/")).toBe(false);
    });

    it("does not re-fetch /offline when the shell is already cached", async () => {
      const sw = loadServiceWorker();
      await runLifecycle(sw.listeners.install); // precache succeeds → /offline present

      const live = { ok: true, body: "live-html" };
      const fetchSpy = jest.fn(async () => live);
      sw.harness.fetchImpl = fetchSpy;

      const extended: Array<Promise<unknown>> = [];
      const responded = dispatchFetch(
        sw.listeners,
        makeRequest("https://canary.test/"),
        extended
      );
      await expect(responded).resolves.toBe(live);
      await Promise.all(extended);

      // Only the navigation itself hit the network — no redundant /offline re-fetch.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("fetch — static assets", () => {
    it("cache-first serves immutable build assets and populates the cache", async () => {
      const sw = loadServiceWorker();
      await runLifecycle(sw.listeners.install);

      const asset = { ok: true, clone: () => ({ cloned: true }) };
      const fetchSpy = jest.fn(async () => asset);
      sw.harness.fetchImpl = fetchSpy;

      const assetReq = makeRequest("https://canary.test/_next/static/chunks/main.js", { mode: "no-cors" });

      // First hit: network, then cached.
      await dispatchFetch(sw.listeners, assetReq);
      const store = sw.stores.get(sw.cacheName);
      expect(store?.has("https://canary.test/_next/static/chunks/main.js")).toBe(true);

      // Second hit: served from cache, no extra network call.
      const second = await dispatchFetch(sw.listeners, assetReq);
      expect(second).toMatchObject({ cloned: true });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("fetch — private and signed pass-through (zero CacheStorage interaction)", () => {
    it.each([
      [
        "authenticated dashboard HTML",
        makeRequest("https://canary.test/dashboard/workspace", { mode: "navigate" }),
      ],
      [
        "same-origin agent API JSON",
        makeRequest("https://canary.test/api/hivra/agents", { mode: "cors" }),
      ],
      [
        "chat EventSource traffic",
        makeRequest("https://canary.test/api/instances/abc/chat-stream", { mode: "cors" }),
      ],
      [
        "gateway event traffic",
        makeRequest("https://canary.test/gateway/computers/abc/events", { mode: "cors" }),
      ],
      [
        "agent JSON outside the API prefix",
        makeRequest("https://canary.test/agents/abc.json", { mode: "cors" }),
      ],
      [
        "a signed immutable-looking query",
        makeRequest(
          "https://canary.test/_next/static/chunks/main.js?X-Amz-Signature=SECRET",
          { mode: "no-cors" },
        ),
      ],
      [
        "a fragment-bearing immutable-looking URL",
        makeRequest(
          "https://canary.test/_next/static/chunks/main.js#DO_NOT_CACHE_FRAGMENT",
          { mode: "no-cors" },
        ),
      ],
      [
        "cross-origin traffic",
        makeRequest("https://clerk.hermesos.cloud/v1/health", { mode: "navigate" }),
      ],
      [
        "a mutation",
        makeRequest("https://canary.test/api/instances/x", {
          method: "POST",
          mode: "cors",
        }),
      ],
    ])("passes through %s", (_label, request) => {
      const sw = loadServiceWorker();

      const responded = dispatchFetch(sw.listeners, request);

      expect(responded).toBeUndefined();
      expect(sw.cacheCalls.open).toEqual([]);
      expect(sw.cacheCalls.match).toEqual([]);
      expect(sw.cacheCalls.put).toEqual([]);
    });
  });
});
