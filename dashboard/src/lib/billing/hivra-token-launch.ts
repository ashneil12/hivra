/**
 * $HIVRA launch details: the ONE place that activates $HIVRA.
 *
 * While `contractAddress` is empty, $HIVRA is DORMANT and the platform behaves
 * exactly as it did with $HermesOS alone. Activating it is one reviewed PR that
 * fills in these fields; nothing else in the code base names the address.
 * Follow docs/token/HIVRA-ACTIVATION.md for what to paste, what runs after the
 * merge and how to verify it.
 *
 *   contractAddress  the $HIVRA ERC-20 on Base, as published: EIP-55
 *                    checksummed (as BaseScan shows it) or all lowercase. Read
 *                    it from the Bankr launch, then confirm it on BaseScan.
 *   decimals         read on-chain (`decimals()`); Bankr tokens use 18.
 *   poolId           the canonical Uniswap v4 pool id (0x + 64 hex) or pair
 *                    address (0x + 40 hex) that prices $HIVRA. The price feed
 *                    only accepts this pool.
 *   activatesAt      UTC instant $HIVRA goes live, to the second, e.g.
 *                    "2026-10-01T16:00:00Z". Users with a
 *                    $HermesOS tier, yearly subscription or token payment
 *                    before this instant are grandfathered on $HermesOS; every
 *                    other user must use $HIVRA from this instant on.
 *
 * All four fields are set together or none is. `token-registry.test.ts` fails
 * the build on a half-filled or malformed block, and
 * `hivra-token-launch.checksum.test.ts` on a checksum typo. At runtime a
 * malformed block keeps $HIVRA dormant.
 *
 * Client-safe: no imports.
 */
export interface HivraTokenLaunchConfig {
  contractAddress: string;
  decimals: number;
  poolId: string;
  activatesAt: string;
}

export const HIVRA_TOKEN_LAUNCH: HivraTokenLaunchConfig = {
  contractAddress: "",
  decimals: 18,
  poolId: "",
  activatesAt: "",
};
