import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../src/playwright/session-manager.js";
import { fakeConfig, silentLogger } from "./_fakes.js";

const launches = vi.hoisted(() => ({ count: 0 }));

// Stub Chromium: each launch takes a moment, so two starts overlap.
vi.mock("playwright", () => ({
  chromium: {
    launchPersistentContext: vi.fn(async () => {
      launches.count += 1;
      await new Promise((r) => setTimeout(r, 30));
      return {
        newPage: async () => ({ setDefaultNavigationTimeout() {}, setDefaultTimeout() {}, close: async () => {} }),
        close: async () => {},
      };
    }),
  },
}));

describe("SessionManager — concurrent starts", () => {
  it("concurrent starts for one identity share one persistent-context launch", async () => {
    launches.count = 0;
    const dir = mkdtempSync(join(tmpdir(), "session-manager-test-"));
    const config = fakeConfig({
      PROFILES_DIR: dir,
      DEFAULT_NAVIGATION_TIMEOUT_MS: 1000,
      DEFAULT_ACTION_TIMEOUT_MS: 1000,
    }) as never;
    const mgr = new SessionManager(config, silentLogger() as never);
    const [a, b] = await Promise.all([mgr.start("vex"), mgr.start("vex")]);
    expect(a.session_id).not.toBe(b.session_id);
    expect(launches.count).toBe(1);
    expect(mgr.contextCount()).toBe(1);
    expect(mgr.activeCount()).toBe(2);
  });
});
