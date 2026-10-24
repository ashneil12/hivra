/**
 * The one source of truth for the $HIVRA launch and the $HermesOS migration
 * as the website describes them BEFORE anything is live.
 *
 * Every fact that cannot be known until the launch is verified is `null` here.
 * Nothing in this file is a contract address, a date or a link until someone
 * fills it in from a verified source (BaseScan, the Sablier app, the Safe).
 * Pages read this module and render "to be published" for every null, so
 * going live is a data edit, not a page edit.
 *
 * Token-facing copy: factual only. It needs UK financial-promotion / legal
 * review before the token pages are made public (see docs/token/PRELAUNCH.md).
 *
 * Client-safe: no imports.
 */

export type LaunchStage = "preparing" | "live";
export type ClaimStage = "not_open" | "open" | "closed";

export interface FeeLine {
  id: "founder_operations" | "liquidity" | "doppler";
  label: string;
  /** Percentage points of each trade. */
  percent: number;
  /** True for the Doppler share, which is an expected figure. */
  approximate: boolean;
  detail: string;
}

export const TOKEN_LAUNCH_STATUS = {
  /** "preparing" until the $HIVRA contract is verified on Base. */
  launch: "preparing" as LaunchStage,
  /** "not_open" until the Sablier campaign is created and verified. */
  claim: "not_open" as ClaimStage,

  /** The planned launch venue and chain. */
  venue: { chain: "Base", protocol: "Doppler" },

  /** Filled in only after verification. Null renders as "to be published". */
  verified: {
    contractAddress: null as string | null,
    claimStartsAt: null as string | null,
    claimEndsAt: null as string | null,
    sablierClaimUrl: null as string | null,
    feeRoutingContract: null as string | null,
    treasuryWallet: null as string | null,
    liquidityWallet: null as string | null,
    founderSalesStartsAt: null as string | null,
    founderBurnTransaction: null as string | null,
  },

  /** True only once the fee split is confirmed against the deployed contracts. */
  feesVerifiedOnChain: false,

  /** No founder allocation of new $HIVRA is planned. */
  founderTokenAllocation: false,

  fees: {
    totalPercent: 1.58,
    lines: [
      {
        id: "founder_operations",
        label: "Founder and Hivra operations",
        percent: 1.2,
        approximate: false,
        detail: "Paid to the founder and used for development and running costs.",
      },
      {
        id: "liquidity",
        label: "Liquidity reserve",
        percent: 0.3,
        approximate: false,
        detail:
          "Collected in a separate wallet. It is not locked automatically. It is added to liquidity and locked by hand, from time to time, with public records.",
      },
      {
        id: "doppler",
        label: "Doppler protocol",
        percent: 0.08,
        approximate: true,
        detail: "The protocol's own share. The exact figure is confirmed from the deployed contracts.",
      },
    ] as readonly FeeLine[],
  },

  migration: {
    from: "$HermesOS",
    to: "$HIVRA",
    ratio: "1:1",
    /** The eligibility snapshot has been taken. */
    snapshotComplete: true,
    claimWindowDays: 90,
    claimTool: "Sablier",
    holderPaysFees: true,
    burnOrSurrenderRequired: false,
    founder: {
      waitWeeks: 2,
      weeklySaleAmount: "500 million $HermesOS",
      approxMonths: 3,
      remainderBurned: true,
    },
  },

  /** The main call to action: free to start. Prices live on /pricing only. */
  start: {
    signUpUrl: "/sign-up",
    pricingUrl: "/pricing",
  },

  links: {
    xUrl: "https://x.com/HivraOS",
    xHandle: "@HivraOS",
    litepaperUrl: "/docs/litepaper/",
    litepaperMarkdownUrl: "/LITEPAPER.md",
    whitepaperMarkdownUrl: "/WHITEPAPER.md",
  },
} as const;

export function feeSumPercent(lines: readonly FeeLine[] = TOKEN_LAUNCH_STATUS.fees.lines): number {
  return Math.round(lines.reduce((sum, line) => sum + line.percent, 0) * 100) / 100;
}

/** True once a claim link may be shown: the claim is open and a verified URL exists. */
export function claimLinkAvailable(status = TOKEN_LAUNCH_STATUS): boolean {
  return status.claim === "open" && Boolean(status.verified.sablierClaimUrl);
}
