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
 * and /tokenomics bodies are Ash's website pack (01-token.md, 04-tokenomics.md),
 * applied verbatim in components/token/TokenLaunchedView.tsx and
 * TokenomicsLaunchedView.tsx. A scheduled and an active $HIVRA read the same
 * launched copy: the pack does not say when Hivra starts to use the token, only
 * that new $HIVRA-based access and payments follow published activation conditions.
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
 * website pack page (TokenLaunchedView.tsx) instead, so they carry only the head copy.
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

/** /tokenomics head copy, in every phase. */
export interface TokenomicsMetadataCopy {
  metadataTitle: string;
  metadataDescription: string;
}

/**
 * The dormant /tokenomics body copy (FullTokenomicsSection). Launched phases render
 * Ash's website pack page (TokenomicsLaunchedView.tsx) instead, so they carry only the head copy.
 */
export interface TokenomicsPhaseCopy extends TokenomicsMetadataCopy {
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
  tokenomics: TokenomicsMetadataCopy;
  evolution: EvolutionPhaseCopy;
  llmsTxt: LlmsTxtPhaseCopy;
}

const DORMANT_ACCESS_PARAGRAPH =
  "Eligible $HermesOS holdings are one way to qualify for compute access. Your account shows the verified wallet, balance and access status where holder access is enabled. Existing token payment options are shown only where available.";
const DORMANT_PROPOSAL_NOTE =
  "The migration, new uses and treasury plans are proposals. Their final terms get published before they take effect. Nothing here is an offer or an inducement to buy any asset.";
const DORMANT_SUPPLY_LINE =
  "No presale or private round. The supply is fixed at 100 billion by the Bankr launch. Any founder allocation and its vesting get published before launch.";
const DORMANT_TOKENOMICS_MIGRATION_TERMS =
  "Existing holders keep their access, without forced conversion or a claim deadline. The conversion rate, the fees and how price changes during a conversion are handled get published before claims open, along with the exact steps.";

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
 * The /tokenomics copy before $HIVRA launches, byte for byte as the site showed it
 * (token-phase-copy.test.ts pins it). FullTokenomicsSection renders it while $HIVRA is dormant.
 */
export const DORMANT_TOKENOMICS_COPY: TokenomicsPhaseCopy = {
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
};

/**
 * The /token head once $HIVRA is launched (scheduled or active), verbatim from
 * Ash's website pack, 01-token.md (v3, 20 October 2026). The page sets the title
 * as absolute, so the root layout's "%s | Hivra" template does not add a second "Hivra".
 */
const LAUNCHED_TOKEN_PAGE_METADATA: TokenPageMetadataCopy = {
  metadataTitle: "Hivra tokens | Official contracts, migration and holder access",
  metadataDescription:
    "Verify the official $HIVRA and legacy $HermesOS contracts on Base. Understand the snapshot-based Sablier claim, existing access and proposed token uses.",
};

/**
 * The /tokenomics head once $HIVRA is launched, verbatim from Ash's website pack,
 * 04-tokenomics.md. The pack's browser title ends in "| Hivra", which the root
 * layout's "%s | Hivra" template adds, so the title here stops before it.
 */
const LAUNCHED_TOKENOMICS_METADATA: TokenomicsMetadataCopy = {
  metadataTitle: "$HIVRA tokenomics: access, migration and future uses",
  metadataDescription:
    "How Hivra's token access works, how eligible $HermesOS holders claim $HIVRA, and what token-based services Hivra is considering next.",
};

/**
 * The /why-hivra/evolution lines once $HIVRA is launched, from Ash's website pack
 * (token-related/why-hivra--evolution.md) word for word: the status, the two lines
 * under it (the pack's replacement paragraphs) and the relationship line.
 */
const LAUNCHED_EVOLUTION: EvolutionPhaseCopy = {
  hivraStatus: "$HIVRA is live on Base. Its contract address is on the token page.",
  hivraDetails: [
    "New $HIVRA-based access and payments become available only once the published activation conditions have been met.",
    "Holders of legacy $HermesOS keep their existing access. Eligible snapshot holders can claim $HIVRA through the official Sablier campaign. The claimant pays the applicable claim and network fees; no legacy-token burn is required.",
  ],
  addressNote: "Check contract addresses only on the",
  relationship: "$HIVRA is the live token. $HermesOS is the legacy token, and its holders keep their existing access.",
};

/**
 * The /llms.txt token lines once $HIVRA is launched. Not a page of the pack: the note
 * is the pack's /tokenomics search description, and the status joins the pack's own
 * evolution-page sentences, so a crawler reads the same facts as a visitor.
 */
const LAUNCHED_LLMS_TXT: LlmsTxtPhaseCopy = {
  tokenomicsNote: LAUNCHED_TOKENOMICS_METADATA.metadataDescription,
  tokenStatus:
    "$HIVRA is live on Base. New $HIVRA-based access and payments become available only once the published activation conditions have been met. $HermesOS is the legacy token, and its holders keep their existing access. Eligible snapshot holders can claim $HIVRA through the official Sablier campaign. The claimant pays the applicable claim and network fees; no legacy-token burn is required.",
};

const LAUNCHED_PHASE_COPY: TokenPhaseCopy = {
  tokenPage: LAUNCHED_TOKEN_PAGE_METADATA,
  tokenomics: LAUNCHED_TOKENOMICS_METADATA,
  evolution: LAUNCHED_EVOLUTION,
  llmsTxt: LAUNCHED_LLMS_TXT,
};

export const TOKEN_PHASE_COPY: Readonly<Record<HivraTokenPhase, TokenPhaseCopy>> = {
  dormant: {
    tokenPage: DORMANT_TOKEN_PAGE_COPY,
    tokenomics: DORMANT_TOKENOMICS_COPY,
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
  scheduled: LAUNCHED_PHASE_COPY,
  active: LAUNCHED_PHASE_COPY,
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
