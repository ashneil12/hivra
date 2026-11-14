/**
 * /token page entries for an empty (dormant) $HIVRA launch block.
 *
 * The committed hivra-token-launch.ts names the launch, so getTokenPageEntries()
 * returns launched entries. Suites that cover the dormant page build their
 * entries here, through the real getTokenPageEntries with the launch block
 * swapped for an empty one in an isolated module registry, so the rest of the
 * suite keeps the committed registry.
 */
import type { TokenPageEntry } from "@/lib/token-verification-content";

export const DORMANT_HIVRA_LAUNCH = { contractAddress: "", decimals: 18, poolId: "", activatesAt: "" } as const;

export function dormantTokenPageEntries(now: Date = new Date()): TokenPageEntry[] {
  let entries: TokenPageEntry[] = [];
  jest.isolateModules(() => {
    jest.doMock("@/lib/billing/hivra-token-launch", () => ({ HIVRA_TOKEN_LAUNCH: { ...DORMANT_HIVRA_LAUNCH } }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const content = require("@/lib/token-verification-content") as typeof import("@/lib/token-verification-content");
    entries = content.getTokenPageEntries(now);
  });
  jest.dontMock("@/lib/billing/hivra-token-launch");
  return entries;
}
