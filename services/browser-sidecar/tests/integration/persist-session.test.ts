import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../../src/playwright/session-manager.js";
import { fakeConfig, silentLogger } from "../_fakes.js";
import type { Config } from "../../src/config.js";
import type { Logger } from "../../src/logger.js";

// Integration test: real Chromium via Playwright.
//
// This is the load-bearing requirement of the whole sidecar — if a value
// stored in localStorage doesn't survive a SessionManager shutdown+restart,
// the persistent context isn't actually persistent and nothing else matters.
//
// Skipped by default. Enable by setting RUN_INTEGRATION=1 in the environment
// AND running `npm run playwright:install` first.
const ENABLED = process.env.RUN_INTEGRATION === "1";

describe.skipIf(!ENABLED)("persistent context survives restart", () => {
  it("retains localStorage across SessionManager instances", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hermes-browser-test-"));
    const config = fakeConfig({ PROFILES_DIR: dir, PLAYWRIGHT_HEADLESS: true }) as Config;
    const logger = silentLogger() as unknown as Logger;
    const m1 = new SessionManager(config, logger);
    const m2 = new SessionManager(config, logger);
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<!doctype html><title>Owned persistence fixture</title>");
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      // First boot — write a localStorage value on a real page.
      const { session_id: sid1 } = await m1.start("test");
      const s1 = m1.get(sid1)!;
      await s1.page.goto(origin);
      await s1.page.evaluate(() => localStorage.setItem("hermes-test", "persisted"));
      await m1.shutdown();

      // Second boot — read it back.
      const { session_id: sid2 } = await m2.start("test");
      const s2 = m2.get(sid2)!;
      await s2.page.goto(origin);
      const value = await s2.page.evaluate(() => localStorage.getItem("hermes-test"));
      expect(value).toBe("persisted");
      await m2.shutdown();
    } finally {
      // Reap both owned browser contexts even when an assertion/navigation fails.
      await m1.shutdown();
      await m2.shutdown();
      await new Promise<void>((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close((error) => error ? reject(error) : resolve());
      });
      await rm(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
