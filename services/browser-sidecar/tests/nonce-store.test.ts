import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { NonceStore } from "../src/auth/nonce-store.js";
import { silentLogger } from "./_fakes.js";
import type { Logger } from "../src/logger.js";

const tmpDirs: string[] = [];
function stateDir() {
  const dir = mkdtempSync(join(tmpdir(), "nonce-store-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
});

describe("NonceStore", () => {
  it("first consume returns true, second consume of same key returns false", () => {
    const store = new NonceStore(silentLogger() as unknown as Logger);
    const expiresAt = Date.now() + 60_000;
    expect(store.consume("k1", expiresAt)).toBe(true);
    expect(store.consume("k1", expiresAt)).toBe(false);
  });

  it("expired entries can be consumed again", () => {
    const store = new NonceStore(silentLogger() as unknown as Logger);
    // Already-expired
    expect(store.consume("k2", Date.now() - 1)).toBe(true);
    // Same key: previous record is stale, so consume returns true again
    expect(store.consume("k2", Date.now() + 60_000)).toBe(true);
    // And NOW the fresh record blocks replay
    expect(store.consume("k2", Date.now() + 60_000)).toBe(false);
  });

  it("different keys consume independently", () => {
    const store = new NonceStore(silentLogger() as unknown as Logger);
    const t = Date.now() + 60_000;
    expect(store.consume("a", t)).toBe(true);
    expect(store.consume("b", t)).toBe(true);
    expect(store.consume("a", t)).toBe(false);
    expect(store.consume("b", t)).toBe(false);
  });

  it("persists consumed nonces across instances (restart keeps replay protection)", () => {
    const dir = stateDir();
    const t = Date.now() + 60_000;
    const first = new NonceStore(silentLogger() as unknown as Logger, dir);
    expect(first.consume("persisted", t)).toBe(true);

    // New instance over the same dir = a process restart.
    const second = new NonceStore(silentLogger() as unknown as Logger, dir);
    expect(second.consume("persisted", t)).toBe(false);
    // A different nonce is still fresh.
    expect(second.consume("other", t)).toBe(true);
  });

  it("drops expired entries when loading (stale file can't wedge the store)", () => {
    const dir = stateDir();
    const first = new NonceStore(silentLogger() as unknown as Logger, dir);
    // Consume with an already-past expiry — should not persist as a live entry.
    expect(first.consume("old", Date.now() - 1)).toBe(true);
    const second = new NonceStore(silentLogger() as unknown as Logger, dir);
    expect(second.consume("old", Date.now() + 60_000)).toBe(true);
  });

  it("survives a missing or corrupt state file", () => {
    const dir = stateDir();
    const store = new NonceStore(silentLogger() as unknown as Logger, dir);
    expect(store.consume("k", Date.now() + 60_000)).toBe(true);
    const persisted = JSON.parse(
      readFileSync(join(dir, "consumed-nonces.json"), "utf8"),
    );
    expect(persisted.k.expiresAt).toBeGreaterThan(Date.now());
  });
});
