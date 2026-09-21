import {
  analyzeClerkRuntimeEnvironment,
  deriveRuntimeOriginFromHeaders,
  parseClerkAllowedOrigins,
} from "../clerk-runtime-config";

describe("clerk-runtime-config", () => {
  it("parses explicit allowed origin patterns", () => {
    // Pin appUrl so the derived site-host defaults collapse onto the configured
    // patterns (otherwise the DEFAULT_APP_URL host adds its own origins too).
    expect(parseClerkAllowedOrigins("hermesos.cloud, *.hermesos.cloud", "https://hermesos.cloud")).toEqual([
      "hermesos.cloud",
      "*.hermesos.cloud",
    ]);
  });

  it("normalizes explicit host entries that include a port", () => {
    expect(parseClerkAllowedOrigins("localhost:3000, https://preview.hermesos.cloud:8443")).toEqual(
      expect.arrayContaining(["localhost", "preview.hermesos.cloud"])
    );
  });

  it("derives the current request origin from forwarded headers", () => {
    const headers = new Headers({
      host: "localhost:3000",
      "x-forwarded-host": "localhost:3000",
      "x-forwarded-proto": "http",
    });

    expect(deriveRuntimeOriginFromHeaders(headers)).toBe("http://localhost:3000");
  });

  it("blocks live Clerk keys on localhost over http", () => {
    expect(
      analyzeClerkRuntimeEnvironment({
        publishableKey: "pk_live_example",
        allowedOrigins: "hermesos.cloud,*.hermesos.cloud",
        appUrl: "https://hermesos.cloud",
        runtimeOrigin: "http://localhost:3000",
      })
    ).toMatchObject({
      isLiveKey: true,
      shouldBlock: true,
      runtimeOrigin: "http://localhost:3000",
      recommendedLiveKeyDebugOrigin: "https://local.hermesos.cloud",
      blockers: expect.arrayContaining(["host", "https", "port"]),
    });
  });

  it("allows live Clerk keys on an approved https subdomain over port 443", () => {
    expect(
      analyzeClerkRuntimeEnvironment({
        publishableKey: "pk_live_example",
        allowedOrigins: "hermesos.cloud,*.hermesos.cloud",
        appUrl: "https://hermesos.cloud",
        runtimeOrigin: "https://local.hermesos.cloud",
      })
    ).toMatchObject({
      isLiveKey: true,
      shouldBlock: false,
      blockers: [],
    });
  });

  it("does not block Clerk development keys on localhost", () => {
    expect(
      analyzeClerkRuntimeEnvironment({
        publishableKey: "pk_test_example",
        allowedOrigins: "hermesos.cloud,*.hermesos.cloud",
        appUrl: "https://hermesos.cloud",
        runtimeOrigin: "http://localhost:3000",
      })
    ).toMatchObject({
      isLiveKey: false,
      shouldBlock: false,
      blockers: expect.arrayContaining(["host", "https", "port"]),
    });
  });

  it("treats localhost with an explicit configured port as a host match", () => {
    expect(
      analyzeClerkRuntimeEnvironment({
        publishableKey: "pk_live_example",
        allowedOrigins: "localhost:3000",
        appUrl: "https://hermesos.cloud",
        runtimeOrigin: "http://localhost:3000",
      })
    ).toMatchObject({
      shouldBlock: true,
      blockers: expect.arrayContaining(["https", "port"]),
    });
  });
});
