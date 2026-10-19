/**
 * The $HermesOS → $HIVRA holder airdrop.
 *
 * There is no claim and no swap. Wallets that held $HermesOS at the snapshot
 * block are sent $HIVRA directly (a push airdrop), one $HIVRA for each
 * $HermesOS. Holders do nothing: they never connect a wallet, sign a message or
 * approve a transaction to receive it.
 *
 * The $HIVRA contract itself is NOT set here: it comes only from the platform
 * token registry (lib/billing/hivra-token-launch.ts via token-registry.ts), the
 * one place that activates $HIVRA. Nothing below is shown anywhere until that
 * launch block is filled in. Never take a token address from user input, a
 * query string, a token search or a price site: several tokens using the
 * Hivra name already exist on Base, and none of them is Hivra's.
 *
 * Each field is filled in by a reviewed pull request once it is true, never at
 * runtime (docs/token/HIVRA-ACTIVATION.md, "Holder airdrop"):
 *
 *   senderAddress  the wallet every airdrop transfer is sent from, EIP-55
 *                  checksummed. Shown so a holder can check that an incoming
 *                  transfer is Hivra's.
 *   snapshotBlock  the Base block whose $HermesOS balances decide the airdrop.
 *   snapshotUrl    the published list of every snapshot wallet and the $HIVRA
 *                  it is sent, on an allowed location below.
 *   sentAt         the UTC instant, to the second, by which every transfer in
 *                  the snapshot was confirmed on Base. Null until then. It opens
 *                  the optional "switch your access" step for grandfathered
 *                  holders, so never set it before the last transfer confirms.
 *
 * The snapshot is shown only when snapshotBlock and snapshotUrl are both set and
 * valid, and sentAt counts only once the snapshot is shown. A set but invalid
 * value is reported (conversion-state.ts `problems`) and treated as unset.
 *
 * Client-safe: no imports.
 */
export type HivraAirdropConfig = {
  senderAddress: string | null;
  snapshotBlock: number | null;
  snapshotUrl: string | null;
  sentAt: string | null;
};

export const HIVRA_AIRDROP: HivraAirdropConfig = {
  senderAddress: "0x3B954866d4329E19C1B9165774c88508f2fefA0c",
  snapshotBlock: null,
  snapshotUrl: null,
  sentAt: null,
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
