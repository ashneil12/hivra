/**
 * Token-facing copy that depends on the $HIVRA phase (token-registry.ts):
 *
 *   dormant    hivra-token-launch.ts has no address. Every string here is
 *              exactly the copy the site showed before this module existed,
 *              so nothing visible changes until the activation PR merges.
 *              token-phase-copy.test.ts pins these strings byte for byte.
 *   scheduled  the address is set and activatesAt is still in the future
 *              ("launching"): $HIVRA exists on Base, Hivra has not switched.
 *   active     activatesAt has passed.
 *
 * The scheduled and active strings are FACTUAL ONLY: no price, discount,
 * returns, urgency or invitation to buy. They are token-facing copy and need
 * UK financial-promotion / legal review before any Promote. The launched /token
 * body is Ash's rewrite v2, applied verbatim in components/token/TokenLaunchedView.tsx.
 *
 * Client-safe: no server imports.
 */
import type { HivraTokenPhase } from "@/lib/billing/token-registry";

/** /token head copy, in every phase. */
export interface TokenPageMetadataCopy {
  metadataTitle: string;
  metadataDescription: string;
}

/**
 * The dormant /token body copy (TokenPageClient). Launched phases render Ash's
 * rewrite (TokenLaunchedView.tsx) instead, so they carry only the head copy.
 */
export interface TokenPagePhaseCopy extends TokenPageMetadataCopy {
  heroTitle: string;
  heroLead: string;
  migrationEyebrow: string;
  migrationHeading: string;
  migrationParagraphs: readonly [string, string];
  /** "Existing holder access" paragraph for a viewer the token geo-policy does not block. */
  accessParagraph: string;
}

export interface TokenomicsPhaseCopy {
  metadataTitle: string;
  metadataDescription: string;
  /** FullTokenomicsSection header paragraph. */
  headerLead: string;
  /** The migration article's eyebrow, heading and two paragraphs. */
  migrationEyebrow: string;
  migrationHeading: string;
  migrationParagraphs: readonly [string, string];
  /** The three steps drawn between the migration paragraphs, and their list label. */
  flowLabel: string;
  flowSteps: readonly [string, string, string];
  /** The note above the uses. */
  proposalNote: string;
  /** The closing line about supply. */
  supplyLine: string;
}

export interface EvolutionPhaseCopy {
  /** The first line of the $HIVRA box in "What happens to $HermesOS?". */
  hivraStatus: string;
  /** Lines under it, hidden from a viewer the token geo-policy blocks. */
  hivraDetails: readonly string[];
  /** Text before the token page link; the page appends " token page." as a link. */
  addressNote: string;
  /** Section 06, second line of the relationship box. */
  relationship: string;
}

export interface LlmsTxtPhaseCopy {
  /** The note on the /TOKENOMICS.md link. */
  tokenomicsNote: string;
  /** The token sentence closing the status paragraph. */
  tokenStatus: string;
}

export interface TokenPhaseCopy {
  tokenPage: TokenPageMetadataCopy;
  tokenomics: TokenomicsPhaseCopy;
  evolution: EvolutionPhaseCopy;
  llmsTxt: LlmsTxtPhaseCopy;
}

const HOLDERS_KEEP_ACCESS =
  "Holders of legacy $HermesOS keep their existing access. Wallets that held $HermesOS at the snapshot block are sent $HIVRA automatically, with nothing to claim.";
const DORMANT_ACCESS_PARAGRAPH =
  "Eligible $HermesOS holdings are one way to qualify for compute access. Your account shows the verified wallet, balance and access status where holder access is enabled. Existing token payment options are shown only where available.";
const DORMANT_PROPOSAL_NOTE =
  "The migration, new uses and treasury plans are proposals. Their final terms get published before they take effect. Nothing here is an offer or an inducement to buy any asset.";
const LAUNCHED_PROPOSAL_NOTE =
  "The new uses and treasury plans are proposals. Their final terms get published before they take effect. Nothing here is an offer or an inducement to acquire any asset.";
const DORMANT_SUPPLY_LINE =
  "No presale or private round. The supply is fixed at 100 billion by the Bankr launch. Any founder allocation and its vesting get published before launch.";
const LAUNCHED_SUPPLY_LINE =
  "BaseScan shows the total $HIVRA supply. Check the contract address on the token page.";
const LAUNCHED_TOKENOMICS_DESCRIPTION =
  "$HIVRA is live on Base. Existing token access, the $HIVRA airdrop to $HermesOS holders, and the proposed uses and treasury. Final terms are published before proposals take effect.";
const LAUNCHED_TOKENOMICS_MIGRATION = {
  migrationEyebrow: "Holder airdrop",
  migrationHeading: "Nothing to claim. Nothing to swap.",
  flowLabel: "Airdrop flow",
  flowSteps: ["$HermesOS", "Snapshot block", "$HIVRA"],
  proposalNote: LAUNCHED_PROPOSAL_NOTE,
  supplyLine: LAUNCHED_SUPPLY_LINE,
} as const;
const LAUNCHED_TOKENOMICS_MIGRATION_INTRO =
  "$HIVRA is live on Base. Every holder on the published snapshot list is sent one $HIVRA for each $HermesOS they held at the snapshot block, with nothing to claim or swap.";
const DORMANT_TOKENOMICS_MIGRATION_TERMS =
  "Existing holders keep their access, without forced conversion or a claim deadline. The conversion rate, the fees and how price changes during a conversion are handled get published before claims open, along with the exact steps.";
const LAUNCHED_TOKENOMICS_MIGRATION_TERMS =
  "Holders of legacy $HermesOS keep their existing access, with no forced conversion and no deadline. The snapshot block and the full list of wallets are published on the token page.";

/**
 * The /token copy before $HIVRA launches, byte for byte as the site showed it
 * (token-phase-copy.test.ts pins it). TokenPageClient renders it while $HIVRA
 * is dormant.
 */
export const DORMANT_TOKEN_PAGE_COPY: TokenPagePhaseCopy = {
  metadataTitle: "Hivra token: current access and proposals",
  metadataDescription:
    "Verify the existing $HermesOS contract, understand current holder access, and read the proposed $HIVRA migration. A wallet is optional.",
  heroTitle: "$HermesOS and Hivra.",
  heroLead:
    "Use Hivra and pay by card without connecting a wallet. This page explains existing holder access and the proposed $HIVRA token.",
  migrationEyebrow: "PROPOSED. NOT AVAILABLE HERE.",
  migrationHeading: "The proposed $HIVRA migration",
  migrationParagraphs: [
    "The litepaper proposes a Hivra token on Base through Bankr, with an optional active claim from $HermesOS. Keeping access and converting tokens are separate decisions.",
    "The proposed claim would sell the old tokens into their existing pool and use the ETH proceeds to buy from the new pool. Conversion terms, fees and price protections must be published with the contract before claims open. No migration action is offered on this page.",
  ],
  accessParagraph: DORMANT_ACCESS_PARAGRAPH,
};

/**
 * The /token head once $HIVRA is launched (scheduled or active), verbatim from
 * Ash's rewrite v2 (20 October 2026). The page sets the title as absolute, so
 * the root layout's "%s | Hivra" template does not add a second "Hivra".
 */
const LAUNCHED_TOKEN_PAGE_METADATA: TokenPageMetadataCopy = {
  metadataTitle: "Hivra tokens | Official contracts, migration and holder access",
  metadataDescription:
    "Verify the official $HIVRA and legacy $HermesOS contracts on Base. Understand the automatic holder airdrop, existing access and proposed token uses.",
};

export const TOKEN_PHASE_COPY: Readonly<Record<HivraTokenPhase, TokenPhaseCopy>> = {
  dormant: {
    tokenPage: DORMANT_TOKEN_PAGE_COPY,
    tokenomics: {
      metadataTitle: "Proposed $HIVRA tokenomics",
      metadataDescription:
        "Existing token access and the proposed migration, uses and treasury. Final terms are published before proposals take effect.",
      headerLead:
        "$HermesOS is the existing token. $HIVRA is the proposed new token as HermesOS evolves into Hivra. This page explains existing compute access, the optional migration and the uses being planned.",
      migrationEyebrow: "Proposed migration",
      migrationHeading: "Keeping access and converting tokens are separate decisions.",
      migrationParagraphs: [
        "The proposal is $HIVRA on Base, launched through Bankr. An active claim would sell your old tokens into their existing pool and use the ETH proceeds to buy $HIVRA in the new pool. Bankr would run the conversion.",
        `${DORMANT_TOKENOMICS_MIGRATION_TERMS} Once $HIVRA launches, new users hold and pay with $HIVRA.`,
      ],
      flowLabel: "Proposed claim flow",
      flowSteps: ["$HermesOS", "ETH proceeds", "$HIVRA"],
      proposalNote: DORMANT_PROPOSAL_NOTE,
      supplyLine: DORMANT_SUPPLY_LINE,
    },
    evolution: {
      hivraStatus: "$HIVRA is a proposed new token on Base, to be launched through Bankr. It does not exist yet.",
      hivraDetails: [
        "Under the proposal, new users would use $HIVRA once it launches.",
        "Under the proposal, converting your $HermesOS would be optional, and the terms would be published before claims open.",
        "Under the proposal, paying in the token keeps its discount.",
      ],
      addressNote: "Everything about $HIVRA here is a proposal, not final terms. Check contract addresses only on the",
      relationship: "$HermesOS is the live token today. $HIVRA is the proposed next one.",
    },
    llmsTxt: {
      tokenomicsNote:
        "The live $HermesOS access tier, and the proposed $HIVRA migration and treasury (proposals, not final terms)",
      tokenStatus: "$HermesOS is the live token. $HIVRA is a proposed new token and does not exist yet.",
    },
  },
  scheduled: {
    tokenPage: LAUNCHED_TOKEN_PAGE_METADATA,
    tokenomics: {
      metadataTitle: "$HIVRA tokenomics",
      metadataDescription: LAUNCHED_TOKENOMICS_DESCRIPTION,
      headerLead:
        "$HIVRA is live on Base, and Hivra starts using it at the launch time on the token page. $HermesOS is the existing token, and its holders keep their existing access. This page explains existing compute access, the $HIVRA airdrop to $HermesOS holders and the uses being planned.",
      ...LAUNCHED_TOKENOMICS_MIGRATION,
      migrationParagraphs: [
        LAUNCHED_TOKENOMICS_MIGRATION_INTRO,
        `${LAUNCHED_TOKENOMICS_MIGRATION_TERMS} From the launch time on the token page, new users hold and pay with $HIVRA.`,
      ],
    },
    evolution: {
      hivraStatus:
        "$HIVRA is live on Base. Its contract address is on the token page, and Hivra starts using it at the launch time shown there.",
      hivraDetails: [
        "From the launch time, new accounts use $HIVRA for token access and token payment.",
        HOLDERS_KEEP_ACCESS,
      ],
      addressNote: "Check contract addresses only on the",
      relationship:
        "$HermesOS is the live token today. $HIVRA is live on Base, and Hivra starts using it at the launch time on the token page.",
    },
    llmsTxt: {
      tokenomicsNote:
        "Existing token access, the $HIVRA airdrop to $HermesOS holders, and the proposed uses and treasury (proposals, not final terms)",
      tokenStatus:
        "$HIVRA is live on Base, and Hivra starts using it at the launch time on the token page. $HermesOS is the existing token, and its holders keep their existing access.",
    },
  },
  active: {
    tokenPage: LAUNCHED_TOKEN_PAGE_METADATA,
    tokenomics: {
      metadataTitle: "$HIVRA tokenomics",
      metadataDescription: LAUNCHED_TOKENOMICS_DESCRIPTION,
      headerLead:
        "$HIVRA is live on Base, and new Hivra accounts use it for token access and token payment. $HermesOS is the legacy token, and its holders keep their existing access. This page explains existing compute access, the $HIVRA airdrop to $HermesOS holders and the uses being planned.",
      ...LAUNCHED_TOKENOMICS_MIGRATION,
      migrationParagraphs: [
        LAUNCHED_TOKENOMICS_MIGRATION_INTRO,
        `${LAUNCHED_TOKENOMICS_MIGRATION_TERMS} New users hold and pay with $HIVRA.`,
      ],
    },
    evolution: {
      hivraStatus: "$HIVRA is live on Base. Its contract address is on the token page.",
      hivraDetails: ["New accounts use $HIVRA for token access and token payment.", HOLDERS_KEEP_ACCESS],
      addressNote: "Check contract addresses only on the",
      relationship: "$HIVRA is the live token. $HermesOS is the legacy token, and its holders keep their existing access.",
    },
    llmsTxt: {
      tokenomicsNote:
        "Existing token access, the $HIVRA airdrop to $HermesOS holders, and the proposed uses and treasury (proposals, not final terms)",
      tokenStatus:
        "$HIVRA is live on Base, and new Hivra accounts use it for token access and token payment. $HermesOS is the legacy token, and its holders keep their existing access.",
    },
  },
};

export function getTokenPhaseCopy(phase: HivraTokenPhase): TokenPhaseCopy {
  return TOKEN_PHASE_COPY[phase];
}

/**
 * The title and description of /token and /tokenomics for a viewer the token
 * geo-policy blocks. Those pages show that viewer the contract addresses and the
 * notice only, so the head says no more than that: no mention of a proposal, a
 * migration or a wallet. The same words for both pages and every phase.
 */
export const RESTRICTED_TOKEN_METADATA = {
  title: "Hivra token contracts",
  description: "Official contract addresses. Information, not an offer.",
} as const;

/**
 * The words a viewer the token geo-policy blocks reads on /token, /tokenomics and
 * /why-hivra/evolution in place of the status, proposal and hold-to-qualify
 * lines. The contract addresses, how to verify them and the access they already
 * have stay; nothing says what the token is for or what is proposed. One set for
 * every phase, so a launch does not add a status sentence to a blocked viewer's page.
 */
export const RESTRICTED_TOKEN_PAGE_COPY = {
  /** /token hero. */
  eyebrow: "CONTRACT ADDRESSES",
  heroTitle: RESTRICTED_TOKEN_METADATA.title,
  heroLead: "Use Hivra and pay by card without connecting a wallet. This page lists the official contract addresses.",
  /** /token, in place of the line about holdings qualifying for compute access. */
  accessParagraph:
    "Existing $HermesOS holders keep the access they already have. Your account shows the verified wallet, balance and access status where holder access is enabled.",
  /** /tokenomics, under the heading. */
  tokenomicsLead: "The official contract addresses, and where to check them.",
  /** /why-hivra/evolution, before the token page link. */
  evolutionAddressNote: "Check contract addresses only on the",
} as const;
