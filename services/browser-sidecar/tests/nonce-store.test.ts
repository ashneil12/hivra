import { describe, expect, it } from "vitest";
import { NonceStore } from "../src/auth/nonce-store.js";
import { silentLogger } from "./_fakes.js";
import type { Logger } from "../src/logger.js";

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
});
