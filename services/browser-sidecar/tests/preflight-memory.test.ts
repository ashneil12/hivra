import { describe, expect, it } from "vitest";
import {
  hasSufficientMemory,
  totalRamMb,
  MIN_VM_RAM_BYTES,
} from "../src/preflight/memory.js";

const MB = 1024 * 1024;

describe("browser-sidecar memory pre-flight", () => {
  it("rejects VMs below the floor (would OOM under Chromium)", () => {
    expect(hasSufficientMemory(1024 * MB)).toBe(false); // 1 GB box (e.g. stale ram_limit)
    expect(hasSufficientMemory(MIN_VM_RAM_BYTES - 1)).toBe(false);
  });

  it("admits VMs at or above the floor", () => {
    expect(hasSufficientMemory(MIN_VM_RAM_BYTES)).toBe(true);
    expect(hasSufficientMemory(4096 * MB)).toBe(true); // operator
    expect(hasSufficientMemory(8192 * MB)).toBe(true); // fleet
  });

  it("fails closed on non-finite readings", () => {
    expect(hasSufficientMemory(Number.NaN)).toBe(false);
    expect(hasSufficientMemory(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("reports whole MB for logging", () => {
    expect(totalRamMb(2048 * MB)).toBe(2048);
    expect(totalRamMb(1024 * MB)).toBe(1024);
  });
});
