/**
 * Token-facing copy that depends on the $HIVRA phase (token-registry.ts):
 *
 *   dormant    hivra-token-launch.ts has no address. The current prelaunch
 *              copy describes existing access and the proposed successor.
 *              token-phase-copy.test.ts pins these strings byte for byte.
 *   scheduled  the address is set and activatesAt is still in the future
 *              ("launching"): $HIVRA exists on Base, Hivra has not switched.
 *   active     activatesAt has passed.
 *
 * NEEDS UK FINANCIAL-PROMOTION / LEGAL REVIEW BEFORE PUBLISHING.
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
  "$HIVRA is live on Base, launched through Doppler. Eligible $HermesOS holders can claim $HIVRA 1:1 through Sablier, within a 90-day window. You pay the claim and network fees, and you do not burn or surrender your $HermesOS.";
const DORMANT_TOKENOMICS_MIGRATION_TERMS =
  "Existing holders keep their access. Claims are not open yet. The claim link, start and end times and the exact steps are published here once verified.";
const LAUNCHED_TOKENOMICS_MIGRATION_TERMS =
  "Existing holders keep their access. The claim runs for 90 days from its verified opening. The steps, fees and risks are on this page.";

export const TOKEN_PHASE_COPY: Readonly<Record<HivraTokenPhase, TokenPhaseCopy>> = {
  dormant: {
    tokenPage: {
      metadataTitle: "Hivra token: current access and proposals",
      metadataDescription:
        "Existing $HermesOS compute access and available token payment options, official contracts, and the planned $HIVRA launch and migration.",
      heroTitle: "$HermesOS and Hivra.",
      heroLead:
        "Existing $HermesOS holdings can qualify for compute access, with token payment options where available. $HIVRA is the planned successor. It has not launched and is not trading.",
      migrationEyebrow: "PROPOSED. NOT AVAILABLE HERE.",
      migrationHeading: "The planned $HIVRA migration",
      migrationParagraphs: [
        "$HIVRA is planned for Base, launched through Doppler. Eligible $HermesOS holders will be able to claim $HIVRA 1:1 through Sablier, without burning anything. Keeping access and claiming are separate decisions.",
        "The eligibility snapshot is complete. Claims are not open yet, and the contract, claim link and times are published here once verified. No migration action is offered on this page.",
      ],
    },
    tokenomics: {
      metadataTitle: "Proposed $HIVRA tokenomics",
      metadataDescription:
        "Existing token access and the proposed migration, uses and treasury. Final terms are published before proposals take effect.",
      headerLead:
        "$HermesOS is the existing token. $HIVRA is the proposed new token as HermesOS evolves into Hivra. This page explains existing compute access, the optional migration and the uses being planned.",
      migrationParagraphs: [
        "The plan is $HIVRA on Base, launched through Doppler. The eligibility snapshot is complete. Eligible $HermesOS holders will be able to claim $HIVRA 1:1 through Sablier, within a 90-day window that starts when claims open. You pay the claim and network fees, and you do not burn or surrender your $HermesOS.",
        `${DORMANT_TOKENOMICS_MIGRATION_TERMS} Once $HIVRA launches, new users hold and pay with $HIVRA.`,
      ],
    },
    evolution: {
      hivraStatus: "$HIVRA is a planned new token on Base, to be launched through Doppler. Launch is in preparation and it does not exist yet.",
      hivraDetails: [
        "Under the proposal, new users would use $HIVRA once it launches.",
        "Claiming $HIVRA from your $HermesOS snapshot is optional, and claims are not open yet.",
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
      migrationParagraphs: [
        LAUNCHED_TOKENOMICS_MIGRATION_INTRO,
        `${LAUNCHED_TOKENOMICS_MIGRATION_TERMS} From the launch time on the token page, new users hold and pay with $HIVRA.`,
      ],
    },
    evolution: {
      hivraStatus:
        "$HIVRA is live on Base, launched through Doppler. Its contract address is on the token page, and Hivra starts using it at the launch time shown there.",
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
      migrationParagraphs: [
        LAUNCHED_TOKENOMICS_MIGRATION_INTRO,
        `${LAUNCHED_TOKENOMICS_MIGRATION_TERMS} New users hold and pay with $HIVRA.`,
      ],
    },
    evolution: {
      hivraStatus: "$HIVRA is live on Base, launched through Doppler. Its contract address is on the token page.",
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
