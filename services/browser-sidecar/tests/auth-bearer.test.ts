import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import sensible from "@fastify/sensible";

import { buildBearerAuthPreHandler } from "../src/auth/bearer.js";
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
    SIDECAR_AUTH_TOKEN: undefined,
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

async function buildApp(config: Config, logger: ReturnType<typeof buildLogger>) {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.addHook("onRequest", buildBearerAuthPreHandler(config, logger as never));
  app.get("/health", async () => ({ ok: true }));
  app.get("/internal/verify-novnc-url", async () => ({ ok: true, verified: true }));
  app.post("/goto", async () => ({ ok: true, current_url: "https://example.com/" }));
  app.post("/screenshot", async () => ({ ok: true, png_base64: "" }));
  await app.ready();
  return app;
}

describe("bearer auth preHandler", () => {
  const TOKEN = "z".repeat(32);
  let logger: ReturnType<typeof buildLogger>;

  beforeEach(() => {
    logger = buildLogger();
  });

  describe("strict mode (SIDECAR_AUTH_TOKEN set)", () => {
    it("rejects requests with no Authorization header", async () => {
      const app = await buildApp(buildConfig({ SIDECAR_AUTH_TOKEN: TOKEN }), logger);
      const res = await app.inject({ method: "POST", url: "/goto", payload: {} });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("UNAUTHORIZED");
    });

    it("rejects requests with the wrong bearer token", async () => {
      const app = await buildApp(buildConfig({ SIDECAR_AUTH_TOKEN: TOKEN }), logger);
      const res = await app.inject({
        method: "POST",
        url: "/screenshot",
        payload: {},
        headers: { authorization: `Bearer ${"q".repeat(32)}` },
      });
      expect(res.statusCode).toBe(401);
    });

    it("accepts requests with the correct bearer token", async () => {
      const app = await buildApp(buildConfig({ SIDECAR_AUTH_TOKEN: TOKEN }), logger);
      const res = await app.inject({
        method: "POST",
        url: "/goto",
        payload: {},
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it("rejects malformed Authorization headers", async () => {
      const app = await buildApp(buildConfig({ SIDECAR_AUTH_TOKEN: TOKEN }), logger);
      const cases = ["", "Basic abc", `Bearer`, `bearer${TOKEN}`];
      for (const authorization of cases) {
        const res = await app.inject({
          method: "POST",
          url: "/goto",
          payload: {},
          headers: authorization ? { authorization } : {},
        });
        expect(res.statusCode).toBe(401);
      }
    });

    it("lets /health through without a bearer (so the container healthcheck still works)", async () => {
      const app = await buildApp(buildConfig({ SIDECAR_AUTH_TOKEN: TOKEN }), logger);
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
    });

    it("lets /internal/verify-novnc-url through without a bearer (HMAC signed-URL contract owns its own auth)", async () => {
      const app = await buildApp(buildConfig({ SIDECAR_AUTH_TOKEN: TOKEN }), logger);
      const res = await app.inject({ method: "GET", url: "/internal/verify-novnc-url" });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("explicit warn-only mode (SIDECAR_ALLOW_UNAUTHENTICATED=1, no token)", () => {
    it("accepts unauth requests only under the explicit opt-in", async () => {
      const app = await buildApp(
        buildConfig({ SIDECAR_ALLOW_UNAUTHENTICATED: true }),
        logger,
      );
      const res = await app.inject({ method: "POST", url: "/goto", payload: {} });
      expect(res.statusCode).toBe(200);
    });

    it("logs a warning on every gated request so operators can see what's still unauth", async () => {
      const app = await buildApp(
        buildConfig({ SIDECAR_ALLOW_UNAUTHENTICATED: true }),
        logger,
      );
      await app.inject({ method: "POST", url: "/goto", payload: {} });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ auth_disabled: true, tool: "/goto" }),
        expect.stringContaining("sidecar bearer auth not configured"),
      );
    });

    it("does not log the warn for /health (so the docker healthcheck doesn't spam)", async () => {
      const app = await buildApp(
        buildConfig({ SIDECAR_ALLOW_UNAUTHENTICATED: true }),
        logger,
      );
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe("fail-closed mode (no token, no opt-in)", () => {
    it("rejects gated routes with 503 AUTH_NOT_CONFIGURED", async () => {
      const app = await buildApp(buildConfig({}), logger);
      const res = await app.inject({ method: "POST", url: "/goto", payload: {} });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("AUTH_NOT_CONFIGURED");
    });

    it("rejects even when a bearer is presented (no configured token to compare)", async () => {
      const app = await buildApp(buildConfig({}), logger);
      const res = await app.inject({
        method: "POST",
        url: "/screenshot",
        payload: {},
        headers: { authorization: `Bearer ${"z".repeat(32)}` },
      });
      expect(res.statusCode).toBe(503);
    });

    it("logs an error naming the fix on every refused request", async () => {
      const app = await buildApp(buildConfig({}), logger);
      await app.inject({ method: "POST", url: "/goto", payload: {} });
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ auth_disabled: true, tool: "/goto" }),
        expect.stringContaining("SIDECAR_ALLOW_UNAUTHENTICATED"),
      );
    });

    it("lets /health through without a bearer (healthcheck must keep working)", async () => {
      const app = await buildApp(buildConfig({}), logger);
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
    });

    it("lets /internal/verify-novnc-url through (its HMAC contract owns auth)", async () => {
      const app = await buildApp(buildConfig({}), logger);
      const res = await app.inject({ method: "GET", url: "/internal/verify-novnc-url" });
      expect(res.statusCode).toBe(200);
    });
  });
});
