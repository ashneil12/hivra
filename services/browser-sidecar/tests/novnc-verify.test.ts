import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { mintSignedUrl } from "../src/auth/signed-url.js";
import { registerNovncVerifyRoute } from "../src/routes/novnc-verify.js";
import { fakeConfig, silentLogger } from "./_fakes.js";

// Caddy's forward_auth sends the original request to this route and sets
// X-Forwarded-Uri (and X-Forwarded-Method) to the client's request URI. The
// client cannot choose those values, so the verifier must read them. Its
// X-Original-URI header is nothing Caddy sets, and a client can send it freely.
// The shared test signing key from _fakes, so no secret-shaped literal lives here.
const SECRET = (fakeConfig() as { SIGNING_SECRET: string }).SIGNING_SECRET;
const PAGE_PATH = "/browser-sidecar/novnc/vnc.html";
const WEBSOCKET_PATH = "/browser-sidecar/novnc/websockify";

let profilesDir: string;
let app: FastifyInstance;

beforeAll(async () => {
  profilesDir = mkdtempSync(join(tmpdir(), "novnc-verify-"));
  app = Fastify({ logger: false });
  registerNovncVerifyRoute(app, {
    config: fakeConfig({ PROFILES_DIR: profilesDir, SIGNING_SECRET: SECRET }) as never,
    logger: silentLogger() as never,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(profilesDir, { recursive: true, force: true });
});

// The request URI a signed URL would arrive with: path plus query.
function signedRequestUri(path: string): string {
  const minted = mintSignedUrl({
    baseUrl: "http://127.0.0.1:8789",
    path,
    scope: "novnc:vex",
    secret: SECRET,
    ttlMs: 600_000,
  });
  const url = new URL(minted);
  return `${url.pathname}${url.search}`;
}

describe("noVNC verify route (forward_auth target)", () => {
  it("accepts a signed page URI carried in X-Forwarded-Uri, which Caddy sets", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/internal/verify-novnc-url",
      headers: { "x-forwarded-uri": signedRequestUri(PAGE_PATH) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("ignores a client-supplied X-Original-URI, so it cannot authorise another path", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/internal/verify-novnc-url",
      headers: { "x-original-uri": signedRequestUri(PAGE_PATH) },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ ok: false, reason: "no_original_uri" });
  });

  it("binds the signature to the requested path: a page signature does not open the websocket", async () => {
    const pageUri = signedRequestUri(PAGE_PATH);
    const forwarded = pageUri.replace(PAGE_PATH, WEBSOCKET_PATH);
    const res = await app.inject({
      method: "GET",
      url: "/internal/verify-novnc-url",
      headers: { "x-forwarded-uri": forwarded },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("denies a websocket request that carries no signed query", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/internal/verify-novnc-url",
      headers: { "x-forwarded-uri": WEBSOCKET_PATH },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ ok: false, reason: "scope_missing_or_wrong_kind" });
  });
});
