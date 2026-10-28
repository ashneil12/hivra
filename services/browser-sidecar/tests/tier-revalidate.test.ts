import { afterEach, describe, expect, it, vi } from "vitest";
import { revalidateTierOrExit } from "../src/tier/revalidate.js";
import type { Config } from "../src/config.js";

function buildConfig(overrides: Partial<Config>): Config {
  return {
    PORT: 8789,
    HOST: "0.0.0.0",
    LOG_LEVEL: "info",
    NODE_ENV: "test",
    PROFILES_DIR: "/tmp/p",
    FLOWS_DIR: "/tmp/f",
    SCREENSHOTS_DIR: "/tmp/s",
    SIGNING_SECRET: "x".repeat(32),
    CLERK_POST_LOGIN_PATH: "/dashboard",
    IMAP_PORT: 993,
    IMAP_TLS: true,
    IMAP_MAILBOX: "INBOX",
    IMAP_CODE_SUBJECT_PATTERN: "verify",
    NOVNC_INTERNAL_PORT: 6080,
    DISPLAY: ":99",
    PLAYWRIGHT_HEADLESS: true,
    PLAYWRIGHT_SLOW_MO_MS: 0,
    DEFAULT_NAVIGATION_TIMEOUT_MS: 30000,
    DEFAULT_ACTION_TIMEOUT_MS: 15000,
    TIER_CHECK_URL: undefined,
    TIER_CHECK_INSTANCE_ID: undefined,
    TIER_CHECK_TOKEN: undefined,
    SIDECAR_ALLOW_UNAUTHENTICATED: false,
    CLERK_EMAIL: undefined,
    CLERK_PASSWORD: undefined,
    CLERK_LOGIN_URL: undefined,
    IMAP_HOST: undefined,
    IMAP_USER: undefined,
    IMAP_PASS: undefined,
    ...overrides,
  } as Config;
}

function buildLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  };
}

describe("revalidateTierOrExit", () => {
  it("fails OPEN when all three TIER_CHECK env vars are empty (intentional disable)", async () => {
    const logger = buildLogger();
    const result = await revalidateTierOrExit(buildConfig({}), logger as never);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("disabled");
    expect(logger.warn).toHaveBeenCalled();
  });

  it.each([
    ["URL only", { TIER_CHECK_URL: "https://dash.example/api/internal/tier-check" }],
    ["INSTANCE_ID only", { TIER_CHECK_INSTANCE_ID: "inst-123" }],
    ["TOKEN only", { TIER_CHECK_TOKEN: "tok" }],
    ["URL + INSTANCE_ID, no TOKEN", {
      TIER_CHECK_URL: "https://dash.example/api/internal/tier-check",
      TIER_CHECK_INSTANCE_ID: "inst-123",
    }],
    ["URL + TOKEN, no INSTANCE_ID", {
      TIER_CHECK_URL: "https://dash.example/api/internal/tier-check",
      TIER_CHECK_TOKEN: "tok",
    }],
    ["INSTANCE_ID + TOKEN, no URL", {
      TIER_CHECK_INSTANCE_ID: "inst-123",
      TIER_CHECK_TOKEN: "tok",
    }],
  ])(
    "fails CLOSED on partial tier-check misconfig: %s",
    async (_label, overrides) => {
      // Regression guard: previously the sidecar silently disabled tier-check
      // if any of the three env vars was unset. That hid operator typos. The
      // partial-misconfig branch now refuses to start.
      const logger = buildLogger();
      const result = await revalidateTierOrExit(
        buildConfig(overrides as Partial<Config>),
        logger as never,
      );
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("tier-check-misconfigured");
      expect(logger.error).toHaveBeenCalled();
    },
  );
});

describe("revalidateTierOrExit — live check", () => {
  const ALL_SET = {
    TIER_CHECK_URL: "https://dash.example/api/internal/tier-check",
    TIER_CHECK_INSTANCE_ID: "inst-123",
    TIER_CHECK_TOKEN: "tok",
  } as Partial<Config>;

  function fakeResponse(status: number, body: unknown = {}) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fails CLOSED on 4xx — a definitive refusal, not an outage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakeResponse(403)));
    const result = await revalidateTierOrExit(buildConfig(ALL_SET), buildLogger() as never);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("tier-check-refused");
  });

  it("fails OPEN on 5xx — transient dashboard outage (reconcile owns enforcement)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakeResponse(503)));
    const result = await revalidateTierOrExit(buildConfig(ALL_SET), buildLogger() as never);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("dashboard-unreachable");
  });

  it("fails OPEN on network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const result = await revalidateTierOrExit(buildConfig(ALL_SET), buildLogger() as never);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("fetch-error");
  });

  it("fails CLOSED on tier_ok=false in a 200 body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakeResponse(200, { tier_ok: false, tier: "free" })));
    const result = await revalidateTierOrExit(buildConfig(ALL_SET), buildLogger() as never);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("tier-revoked");
  });

  it("passes on tier_ok=true", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakeResponse(200, { tier_ok: true, tier: "operator" })));
    const result = await revalidateTierOrExit(buildConfig(ALL_SET), buildLogger() as never);
    expect(result.ok).toBe(true);
  });
});
