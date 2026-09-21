/**
 * Tests for src/lib/hetzner/client.ts — mapHetznerStatus
 *
 * Pure function, no network calls, no env vars required.
 */
import { mapHetznerStatus } from "@/lib/hetzner/client";

describe("mapHetznerStatus", () => {
  it.each([
    ["maps 'running' → 'running'", "running", "running"],
    ["maps 'off' → 'stopped'", "off", "stopped"],
    ["maps 'initializing' → 'provisioning'", "initializing", "provisioning"],
    ["maps 'starting' → 'provisioning'", "starting", "provisioning"],
    ["maps 'rebuilding' → 'redeploying'", "rebuilding", "redeploying"],
    ["maps 'stopping' → 'error' (catch-all for non-tracked transition states)", "stopping", "error"],
    ["maps 'deleting' → 'error'", "deleting", "error"],
    ["maps 'migrating' → 'error'", "migrating", "error"],
    ["maps 'unknown' → 'error'", "unknown", "error"],
  ] as const)("%s", (_label, input, expected) => {
    expect(mapHetznerStatus(input)).toBe(expected);
  });
});
