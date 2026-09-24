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
 * UK financial-promotion / legal review before any Promote.
 *
 * Client-safe: no server imports.
 */
import type { HivraTokenPhase } from "@/lib/billing/token-registry";

export interface TokenPagePhaseCopy {
  metadataTitle: string;
  metadataDescription: string;
  heroTitle: string;
  heroLead: string;
  migrationEyebrow: string;
  migrationHeading: string;
  migrationParagraphs: readonly [string, string];
}

export interface TokenomicsPhaseCopy {
  metadataTitle: string;
  metadataDescription: string;
  /** FullTokenomicsSection header paragraph. */
  headerLead: string;
  /** Header paragraph a viewer the token geo-policy blocks sees. */
  restrictedHeaderLead: string;
  /** The migration article's two paragraphs. */
  migrationParagraphs: readonly [string, string];
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
  tokenPage: TokenPagePhaseCopy;
  tokenomics: TokenomicsPhaseCopy;
  evolution: EvolutionPhaseCopy;
  llmsTxt: LlmsTxtPhaseCopy;
}

const HOLDERS_KEEP_ACCESS =
  "Holders of $HermesOS keep their existing access. Conversion terms are published before conversion opens.";
const LAUNCHED_TOKEN_PAGE_DESCRIPTION_TAIL =
  "contract addresses on Base and understand current holder access. A wallet is optional.";
const LAUNCHED_TOKENOMICS_DESCRIPTION =
  "$HIVRA is live on Base. Existing token access, optional conversion from $HermesOS, and the proposed uses and treasury. Final terms are published before proposals take effect.";
const LAUNCHED_TOKEN_PAGE_MIGRATION = {
  migrationEyebrow: "OPTIONAL. NOT OFFERED ON THIS PAGE.",
  migrationHeading: "Converting from $HermesOS",
  migrationParagraphs: [
    "Holders of $HermesOS keep their existing access. Keeping access and converting tokens are separate decisions, and converting is optional.",
    "Conversion terms are published before conversion opens, including its steps, rate, fees and risks. No conversion action is offered on this page.",
  ],
} as const;
const LAUNCHED_TOKENOMICS_MIGRATION_INTRO =
  "$HIVRA is live on Base, launched through Bankr. Under the proposal, an active claim would sell your old tokens into their existing pool and swap the ETH proceeds for $HIVRA in the new pool. Bankr would run the conversion.";
const DORMANT_TOKENOMICS_MIGRATION_TERMS =
  "Existing holders keep their access, without forced conversion or a claim deadline. The conversion rate, the fees and how price movement during a conversion is handled get published before claims open, along with the exact steps.";
const LAUNCHED_TOKENOMICS_MIGRATION_TERMS =
  "Existing holders keep their access, without forced conversion or a claim deadline. The steps, rate, fees and risks of a conversion get published before claims open.";

export const TOKEN_PHASE_COPY: Readonly<Record<HivraTokenPhase, TokenPhaseCopy>> = {
  dormant: {
    tokenPage: {
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
    },
    tokenomics: {
      metadataTitle: "Proposed $HIVRA tokenomics",
      metadataDescription:
        "Existing token access and the proposed migration, uses and treasury. Final terms are published before proposals take effect.",
      headerLead:
        "$HermesOS is the existing token. $HIVRA is the proposed new token as HermesOS evolves into Hivra. This page explains existing compute access, the optional migration and the uses being planned.",
      restrictedHeaderLead: "$HermesOS is the existing token. $HIVRA is the proposed new token as HermesOS evolves into Hivra.",
      migrationParagraphs: [
        "The proposal is $HIVRA on Base, launched through Bankr. An active claim would sell your old tokens into their existing pool and use the ETH proceeds to buy $HIVRA in the new pool. Bankr would run the conversion.",
        `${DORMANT_TOKENOMICS_MIGRATION_TERMS} Once $HIVRA launches, new users hold and pay with $HIVRA.`,
      ],
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
    tokenPage: {
      metadataTitle: "Hivra token: official contracts and current access",
      metadataDescription: `Verify the official $HermesOS and $HIVRA ${LAUNCHED_TOKEN_PAGE_DESCRIPTION_TAIL}`,
      heroTitle: "$HermesOS and $HIVRA.",
      heroLead:
        "Use Hivra and pay by card without connecting a wallet. $HIVRA is live on Base. Its contract address is listed on this page, with the time Hivra starts using it.",
      ...LAUNCHED_TOKEN_PAGE_MIGRATION,
    },
    tokenomics: {
      metadataTitle: "$HIVRA tokenomics",
      metadataDescription: LAUNCHED_TOKENOMICS_DESCRIPTION,
      headerLead:
        "$HIVRA is live on Base, and Hivra starts using it at the launch time on the token page. $HermesOS is the existing token, and its holders keep their existing access. This page explains existing compute access, the optional conversion and the uses being planned.",
      restrictedHeaderLead:
        "$HIVRA is live on Base, and Hivra starts using it at the launch time on the token page. $HermesOS is the existing token.",
      migrationParagraphs: [
        LAUNCHED_TOKENOMICS_MIGRATION_INTRO,
        `${LAUNCHED_TOKENOMICS_MIGRATION_TERMS} From the launch time on the token page, new users hold and pay with $HIVRA.`,
      ],
    },
    evolution: {
      hivraStatus:
        "$HIVRA is live on Base, launched through Bankr. Its contract address is on the token page, and Hivra starts using it at the launch time shown there.",
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
        "Existing token access, optional conversion from $HermesOS to $HIVRA, and the proposed uses and treasury (proposals, not final terms)",
      tokenStatus:
        "$HIVRA is live on Base, and Hivra starts using it at the launch time on the token page. $HermesOS is the existing token, and its holders keep their existing access.",
    },
  },
  active: {
    tokenPage: {
      metadataTitle: "Hivra token: official contracts and current access",
      metadataDescription: `Verify the official $HIVRA and $HermesOS ${LAUNCHED_TOKEN_PAGE_DESCRIPTION_TAIL}`,
      heroTitle: "$HIVRA and $HermesOS.",
      heroLead:
        "Use Hivra and pay by card without connecting a wallet. $HIVRA is live on Base. Its contract address is listed on this page.",
      ...LAUNCHED_TOKEN_PAGE_MIGRATION,
    },
    tokenomics: {
      metadataTitle: "$HIVRA tokenomics",
      metadataDescription: LAUNCHED_TOKENOMICS_DESCRIPTION,
      headerLead:
        "$HIVRA is live on Base, and new Hivra accounts use it for token access and token payment. $HermesOS is the earlier token, and its holders keep their existing access. This page explains existing compute access, the optional conversion and the uses being planned.",
      restrictedHeaderLead: "$HIVRA is live on Base. $HermesOS is the earlier token.",
      migrationParagraphs: [
        LAUNCHED_TOKENOMICS_MIGRATION_INTRO,
        `${LAUNCHED_TOKENOMICS_MIGRATION_TERMS} New users hold and pay with $HIVRA.`,
      ],
    },
    evolution: {
      hivraStatus: "$HIVRA is live on Base, launched through Bankr. Its contract address is on the token page.",
      hivraDetails: ["New accounts use $HIVRA for token access and token payment.", HOLDERS_KEEP_ACCESS],
      addressNote: "Check contract addresses only on the",
      relationship: "$HIVRA is the live token. $HermesOS is the earlier token, and its holders keep their existing access.",
    },
    llmsTxt: {
      tokenomicsNote:
        "Existing token access, optional conversion from $HermesOS to $HIVRA, and the proposed uses and treasury (proposals, not final terms)",
      tokenStatus:
        "$HIVRA is live on Base, and new Hivra accounts use it for token access and token payment. $HermesOS is the earlier token, and its holders keep their existing access.",
    },
  },
};

export function getTokenPhaseCopy(phase: HivraTokenPhase): TokenPhaseCopy {
  return TOKEN_PHASE_COPY[phase];
}
