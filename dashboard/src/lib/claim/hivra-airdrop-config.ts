/**
 * The $HermesOS → $HIVRA holder claim.
 *
 * A snapshot decides who is eligible, and eligible holders then START THE CLAIM
 * THEMSELVES on Sablier (https://app.sablier.com) and pay the claim fee. It is
 * not an automatic airdrop and nothing is pushed to a wallet. One $HIVRA is
 * allocated for each $HermesOS held in an eligible wallet at the snapshot
 * block, and no burn or surrender of $HermesOS is required.
 *
 * The $HIVRA contract itself is NOT set here: it comes only from the platform
 * token registry (lib/billing/hivra-token-launch.ts via token-registry.ts), the
 * one place that activates $HIVRA. Nothing below is shown anywhere until that
 * launch block is filled in. Never take a token address from user input, a
 * query string, a token search or a price site: several tokens using the
 * Hivra name already exist on Base, and none of them is Hivra's.
 *
 * Each field is filled in by a reviewed pull request once it is true, never at
 * runtime (docs/token/HIVRA-ACTIVATION.md, "Holder claim"):
 *
 *   senderAddress     the Airdrop wallet, EIP-55 checksummed. It creates and funds
 *                     the Sablier campaign. Shown so a holder can check it.
 *   snapshotBlock     the Base block whose $HermesOS balances decide eligibility.
 *   snapshotTakenAt   the UTC instant, to the second, the snapshot was taken, e.g.
 *                     "2026-10-20T16:00:00Z". Never in the future.
 *   snapshotUrl       the published list of every snapshot wallet and its $HIVRA
 *                     allocation, on an allowed location below.
 *   claim             the Sablier claim. All three stay null until the campaign
 *                     exists and has been tested:
 *     campaignUrl     the campaign page: https, exactly app.sablier.com, nothing
 *                     else (no credentials, port, fragment, encoded escape or
 *                     path traversal).
 *     opensAt         the UTC instant the claim window opens, to the second.
 *     closesAt        the UTC instant the claim window closes, to the second. It is
 *                     the campaign's expiry. It opens the optional "switch your
 *                     access" step for grandfathered holders.
 *
 * The snapshot is shown only when snapshotBlock and snapshotUrl are both set and
 * valid. The claim link is shown only while the claim is open (hivra-claim.ts).
 * A set but invalid value is reported (conversion-state.ts `problems`, and a
 * "HIVRA airdrop config rejected" log) and treated as unset. For the claim
 * window that means the whole claim stays hidden: a bad opensAt must not open
 * the claim early.
 *
 * Client-safe: no imports.
 */
export type HivraClaimConfig = {
  campaignUrl: string | null;
  opensAt: string | null;
  closesAt: string | null;
};

export type HivraAirdropConfig = {
  senderAddress: string | null;
  snapshotBlock: number | null;
  snapshotTakenAt: string | null;
  snapshotUrl: string | null;
  claim: HivraClaimConfig;
};

export const HIVRA_AIRDROP: HivraAirdropConfig = {
  senderAddress: "0x3B954866d4329E19C1B9165774c88508f2fefA0c",
  snapshotBlock: 53005062,
  snapshotTakenAt: "2026-10-23T23:51:11Z",
  snapshotUrl: "https://github.com/ashneil12/hivra/blob/main/dashboard/src/data/token/hivra-airdrop.json",
  claim: { campaignUrl: null, opensAt: null, closesAt: null },
};

/**
 * Exact hosts the published snapshot may live on (subdomains are not implied),
 * each with the path it must start with. Anything else keeps the snapshot
 * hidden, so a typo or a lookalike domain is never shown as Hivra's list.
 */
export const SNAPSHOT_URL_ALLOWED_LOCATIONS: readonly { host: string; pathPrefix: string }[] = [
  { host: "hivra.cloud", pathPrefix: "/" },
  { host: "canary.hermesos.cloud", pathPrefix: "/" },
  { host: "github.com", pathPrefix: "/ashneil12/hivra/" },
];
