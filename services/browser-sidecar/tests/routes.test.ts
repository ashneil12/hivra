import { describe, expect, it, beforeEach, vi } from "vitest";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { fakeConfig, fakeSessionManager } from "./_fakes.js";
import { registerHealthRoutes } from "../src/routes/health.js";
import { registerSessionRoutes } from "../src/routes/session.js";
import { registerNavigationRoutes } from "../src/routes/navigation.js";
import { registerInteractionRoutes } from "../src/routes/interaction.js";
import { registerAssertionRoutes } from "../src/routes/assertion.js";
import { registerCaptureRoutes } from "../src/routes/capture.js";
import type { Config } from "../src/config.js";
import type { SessionManager } from "../src/playwright/session-manager.js";

async function buildApp(sessions: SessionManager, config: Config) {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  registerHealthRoutes(app, { sessions, startedAt: Date.now() - 1000, tierOk: true });
  registerSessionRoutes(app, { sessions });
  registerNavigationRoutes(app, { sessions });
  registerInteractionRoutes(app, { sessions });
  registerAssertionRoutes(app, { sessions });
  registerCaptureRoutes(app, { sessions, config });
  await app.ready();
  return app;
}

describe("routes", () => {
  let sessions: SessionManager;
  let config: Config;

  beforeEach(() => {
    sessions = fakeSessionManager("fake-session-id");
    config = fakeConfig() as Config;
  });

  it("GET /health returns ok and uptime", async () => {
    const app = await buildApp(sessions, config);
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.uptime_s).toBeGreaterThanOrEqual(1);
    expect(body.tier_ok).toBe(true);
  });

  it("POST /session/start returns a session_id", async () => {
    const app = await buildApp(sessions, config);
    const res = await app.inject({
      method: "POST",
      url: "/session/start",
      payload: { identity: "vex" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, session_id: "fake-session-id" });
  });

  it("POST /session/start rejects missing identity", async () => {
    const app = await buildApp(sessions, config);
    const res = await app.inject({ method: "POST", url: "/session/start", payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_ARGS");
  });

  it("POST /session/end returns ok when teardown succeeds", async () => {
    const app = await buildApp(sessions, config);
    const res = await app.inject({
      method: "POST",
      url: "/session/end",
      payload: { session_id: "fake-session-id" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });

  it("POST /session/end returns 500 when teardown fails instead of falsely reporting success", async () => {
    vi.mocked(sessions.end).mockRejectedValueOnce(new Error("page close failed"));
    const app = await buildApp(sessions, config);
    const res = await app.inject({
      method: "POST",
      url: "/session/end",
      payload: { session_id: "fake-session-id" },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ ok: false, error: "INTERNAL" });
  });

  it("POST /goto navigates and returns current url + title", async () => {
    const app = await buildApp(sessions, config);
    const res = await app.inject({
      method: "POST",
      url: "/goto",
      payload: { session_id: "fake-session-id", url: "https://example.com/" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      current_url: "https://example.com/",
      title: "Example",
    });
  });

  it("POST /goto returns 404 for unknown session", async () => {
    const app = await buildApp(sessions, config);
    const res = await app.inject({
      method: "POST",
      url: "/goto",
      payload: { session_id: "unknown", url: "https://example.com/" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("SESSION_NOT_FOUND");
  });

  it.each([
    ["loopback IPv4", "http://127.0.0.1/admin"],
    ["loopback IPv4 range", "http://127.5.1.1/admin"],
    ["localhost hostname", "http://localhost:9090/dashboard-session-check"],
    ["IPv6 loopback", "http://[::1]/"],
    ["AWS metadata", "http://169.254.169.254/latest/meta-data/"],
    ["GCP metadata", "http://metadata.google.internal/"],
    ["docker bridge: warden", "http://warden:7070/keys/anthropic"],
    ["docker bridge: dashboard-sidecar", "http://dashboard-sidecar:9090/health"],
    ["docker bridge: autoheal", "http://autoheal:1234/"],
    ["docker bridge: official-dashboard", "http://official-dashboard:9119/api/status"],
    ["docker bridge: webui", "https://webui/api/profiles"],
    ["docker bridge: hermes-agent", "http://hermes-agent:8642/api/config"],
    // Normalization-bypass variants that literal-string matching missed:
    ["IPv4-mapped IPv6 loopback", "http://[::ffff:127.0.0.1]/"],
    ["IPv4-mapped IPv6 metadata", "http://[::ffff:169.254.169.254]/latest/meta-data/"],
    ["IPv6 unspecified", "http://[::]/"],
    ["IPv6 unspecified with port", "http://[::]:9090/dashboard-session-check"],
    ["link-local ECS creds variant", "http://169.254.170.2/v2/credentials/"],
    ["decimal-encoded loopback", "http://2130706433/"],
    ["hex-encoded loopback", "http://0x7f000001/"],
  ])("POST /goto blocks SSRF target: %s", async (_label, url) => {
    const app = await buildApp(sessions, config);
    const res = await app.inject({
      method: "POST",
      url: "/goto",
      payload: { session_id: "fake-session-id", url },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("BLOCKED_DESTINATION");
  });

  it("POST /goto rejects non-http(s) schemes", async () => {
    const app = await buildApp(sessions, config);
    // The zod schema accepts file:// as a valid URL — without an explicit
    // scheme check the sidecar would happily navigate Chromium there.
    const res = await app.inject({
      method: "POST",
      url: "/goto",
      payload: { session_id: "fake-session-id", url: "file:///etc/passwd" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("UNSUPPORTED_SCHEME");
  });

  it("POST /click_text accepts an nth index", async () => {
    const app = await buildApp(sessions, config);
    const res = await app.inject({
      method: "POST",
      url: "/click_text",
      payload: { session_id: "fake-session-id", text: "Sign in", nth: 2 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("POST /fill validates required fields", async () => {
    const app = await buildApp(sessions, config);
    const res = await app.inject({
      method: "POST",
      url: "/fill",
      payload: { session_id: "fake-session-id", selector: "input" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /assert_visible accepts either selector or text", async () => {
    const app = await buildApp(sessions, config);
    const r1 = await app.inject({
      method: "POST",
      url: "/assert_visible",
      payload: { session_id: "fake-session-id", selector: "button" },
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({ ok: true, visible: true });

    const r2 = await app.inject({
      method: "POST",
      url: "/assert_visible",
      payload: { session_id: "fake-session-id", text: "Welcome" },
    });
    expect(r2.statusCode).toBe(200);
    expect(r2.json()).toMatchObject({ ok: true, visible: true });

    const r3 = await app.inject({
      method: "POST",
      url: "/assert_visible",
      payload: { session_id: "fake-session-id" },
    });
    expect(r3.statusCode).toBe(400);
  });

  it("POST /get_text returns inner text", async () => {
    const app = await buildApp(sessions, config);
    const res = await app.inject({
      method: "POST",
      url: "/get_text",
      payload: { session_id: "fake-session-id", selector: "h1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, text: "fake text" });
  });

  it("POST /screenshot writes file and optionally returns base64", async () => {
    const tmpdir = `/tmp/test-screenshots-${Date.now()}`;
    const cfg = fakeConfig({ SCREENSHOTS_DIR: tmpdir }) as Config;
    const app = await buildApp(sessions, cfg);
    const res = await app.inject({
      method: "POST",
      url: "/screenshot",
      payload: { session_id: "fake-session-id", base64: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.path).toMatch(/\.png$/);
    expect(typeof body.base64).toBe("string");
  });
});
