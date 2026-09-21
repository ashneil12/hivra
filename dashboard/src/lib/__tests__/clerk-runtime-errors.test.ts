import {
  CLERK_CHUNK_RETRY_STORAGE_KEY,
  containsBrowserExtensionOrigin,
  extractRawErrorMetadata,
  isClerkAssetLoadError,
  shouldIgnoreClientError,
  shouldRetryClerkChunkLoad,
  toError,
} from "@/lib/clerk-runtime-errors";

function createFakeStore(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

describe("client runtime error normalization", () => {
  it("uses a fallback title for empty object errors instead of Error: {}", () => {
    const error = toError({}, "Unhandled promise rejection");

    expect(error.message).toBe("Unhandled promise rejection");
    expect(error.message).not.toBe("{}");
  });

  it("preserves JSON-RPC codes that arrive without a message", () => {
    const error = toError({ code: -32603 }, "Unhandled promise rejection");

    expect(error.message).toBe("JSON-RPC error -32603");
    expect((error as Error & { code?: unknown }).code).toBe(-32603);
  });

  it("extracts raw object metadata for PostHog and ops logs", () => {
    expect(extractRawErrorMetadata({ code: -32603, method: "eth_call" })).toEqual(
      expect.objectContaining({
        rawErrorCode: -32603,
        rawErrorMethod: "eth_call",
        rawErrorType: "object",
        rawErrorKeys: ["code", "method"],
      })
    );
  });

  it("extracts safe diagnostic fields attached to Error instances", () => {
    const error = new Error("Unexpected token < in JSON");
    Object.assign(error, {
      apiEndpoint: "/api/billing/usage",
      requestId: "req_123",
      responseStatus: 502,
      rawBodySnippet: "<html>bad gateway</html>",
    });

    expect(extractRawErrorMetadata(error)).toEqual(
      expect.objectContaining({
        apiEndpoint: "/api/billing/usage",
        requestId: "req_123",
        responseStatus: 502,
        rawBodySnippet: "<html>bad gateway</html>",
      })
    );
  });

  it("recognizes the core Clerk JS SDK failing to load from the Clerk CDN", () => {
    const error = new Error(
      "Failed to load Clerk JS SDK (https://clerk.hermesos.cloud/npm/@clerk/clerk-js@6/dist/clerk.browser.js)"
    );

    expect(isClerkAssetLoadError(error)).toBe(true);
  });

  it("recognizes a ChunkLoadError thrown when the @clerk/ui CDN chunk fails to load", () => {
    const error = new Error(
      "Loading chunk 8136 failed.\n(error: /clerk-assets/@clerk/ui@1.7.0/dist/ui.browser.js)"
    );
    error.name = "ChunkLoadError";

    expect(isClerkAssetLoadError(error)).toBe(true);
  });

  it("does not treat a ChunkLoadError on an unrelated app chunk as a Clerk asset error", () => {
    // Scope guard: the one-shot reload must only fire for Clerk chunk failures,
    // never for any other lazy chunk that happens to fail on the auth surface.
    const error = new Error(
      "Loading chunk 42 failed. (error: /_next/static/chunks/dashboard.js)"
    );
    error.name = "ChunkLoadError";

    expect(isClerkAssetLoadError(error)).toBe(false);
  });
});

describe("shouldRetryClerkChunkLoad one-shot guard", () => {
  it("permits exactly one reload per session, then declines", () => {
    const store = createFakeStore();

    // First chunk failure: allowed to reload and recover.
    expect(shouldRetryClerkChunkLoad(store)).toBe(true);
    // The retried page still fails: must NOT reload again (no loop).
    expect(shouldRetryClerkChunkLoad(store)).toBe(false);
    expect(shouldRetryClerkChunkLoad(store)).toBe(false);
  });

  it("records the attempt under the documented session key so it survives a reload", () => {
    const store = createFakeStore();

    shouldRetryClerkChunkLoad(store);

    expect(store.map.get(CLERK_CHUNK_RETRY_STORAGE_KEY)).toBeTruthy();
  });

  it("declines when the attempt flag is already set (e.g. on the reloaded page)", () => {
    const store = createFakeStore({ [CLERK_CHUNK_RETRY_STORAGE_KEY]: "1" });

    expect(shouldRetryClerkChunkLoad(store)).toBe(false);
  });

  it("declines when no storage is available rather than risking a reload loop", () => {
    expect(shouldRetryClerkChunkLoad(null)).toBe(false);
    expect(shouldRetryClerkChunkLoad(undefined)).toBe(false);
  });

  it("declines when storage access throws (private mode / disabled storage)", () => {
    const throwingStore = {
      getItem: () => {
        throw new Error("The operation is insecure.");
      },
      setItem: () => {
        throw new Error("The operation is insecure.");
      },
    };

    expect(shouldRetryClerkChunkLoad(throwingStore)).toBe(false);
  });
});

describe("shouldIgnoreClientError extension-noise filter", () => {
  it("ignores the Chrome extension runtime.sendMessage tab-not-found error", () => {
    expect(
      shouldIgnoreClientError(new Error("Invalid call to runtime.sendMessage(). Tab not found."))
    ).toBe(true);
    // window.onerror string payloads arrive with the Uncaught prefix.
    expect(
      shouldIgnoreClientError(
        new Error("Uncaught Error: Invalid call to runtime.sendMessage(). Tab not found.")
      )
    ).toBe(true);
  });

  it("ignores the Binance Wallet extension sseError bridge failure", () => {
    expect(shouldIgnoreClientError(new Error("func sseError not found"))).toBe(true);
    expect(
      shouldIgnoreClientError(new Error("Uncaught (in promise) Error: func sseError not found"))
    ).toBe(true);
  });

  it("ignores errors whose stack references any extension origin scheme", () => {
    for (const origin of [
      "chrome-extension://abc123/content.js",
      "moz-extension://abc123/content.js",
      "safari-extension://abc123/content.js",
      "safari-web-extension://abc123/content.js",
    ]) {
      const error = new Error("Failed to fetch");
      Object.defineProperty(error, "stack", {
        configurable: true,
        value: `TypeError: Failed to fetch\n    at ${origin}:2:18047`,
      });
      expect(shouldIgnoreClientError(error)).toBe(true);
    }
  });

  it("keeps first-party errors that merely resemble third-party ones", () => {
    const fetchError = new Error("Failed to fetch");
    Object.defineProperty(fetchError, "stack", {
      configurable: true,
      value:
        "TypeError: Failed to fetch\n    at https://hermesos.cloud/_next/static/chunks/app.js:1:100",
    });

    expect(shouldIgnoreClientError(fetchError)).toBe(false);
    expect(shouldIgnoreClientError(new TypeError("Cannot read properties of undefined"))).toBe(false);
    expect(shouldIgnoreClientError(new Error("runtime.sendMessage is not a function"))).toBe(false);
    expect(shouldIgnoreClientError(new Error("sseError"))).toBe(false);
  });
});

describe("shouldIgnoreClientError known-noise filtering", () => {
  it.each([
    // iOS Firefox injected bridge.
    "Error in window.__firefox__.searchQueryForField",
    // Legacy extension content-script callback noise.
    "Object Not Found Matching Id:3, MethodName:update, ParamCount:4",
    // Chrome-on-iOS injected bridge.
    "__gCrWeb.edgeTranslate.detectPageState failed",
  ])("ignores known in-app-browser/extension bridge noise: %s", (message) => {
    expect(shouldIgnoreClientError(new Error(message))).toBe(true);
  });

  it("ignores known noise that only surfaces in the stack", () => {
    const error = new Error("Failed to execute callback");
    Object.defineProperty(error, "stack", {
      configurable: true,
      value: "Error: Failed to execute callback\n    at window.__gCrWeb.message.invokeOnHost",
    });

    expect(shouldIgnoreClientError(error)).toBe(true);
  });

  it("does not ignore real product errors", () => {
    expect(shouldIgnoreClientError(new Error("Failed to load operations data"))).toBe(false);
    expect(shouldIgnoreClientError(new TypeError("Cannot read properties of undefined (reading 'sendMessage')"))).toBe(false);
    expect(
      shouldIgnoreClientError(new Error("ClerkJS: Failed to load Clerk JS SDK from cdn.jsdelivr.net"))
    ).toBe(false);
    // "Object Not Found Matching Id" must be anchored to the start of the
    // message — a first-party error merely quoting it stays reportable.
    expect(
      shouldIgnoreClientError(new Error("Lookup failed: Object Not Found Matching Id:3, MethodName:update"))
    ).toBe(false);
  });

  it("detects browser extension origins in arbitrary strings", () => {
    expect(
      containsBrowserExtensionOrigin("chrome-extension://hoklmmgfnpapgjgcpechhaamimifchmp/frame_ant.js")
    ).toBe(true);
    expect(containsBrowserExtensionOrigin("moz-extension://abc/content.js")).toBe(true);
    expect(containsBrowserExtensionOrigin("https://hermesos.cloud/_next/static/chunks/app.js")).toBe(false);
  });
});
