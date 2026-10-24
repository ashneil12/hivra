// Shared pieces of the /agents copy: prices and sizes read from billing, the repo-approved
// sentences, and fill() which puts them into the md text.
//
// Copy modules write {entry}, {larger}, {aiNote} and so on instead of typing a price or a
// size, so the words move with checkout (lib/blog/plan-facts.ts) and the agent catalog
// (resizeFloor, BROWSER_ADD). fill() throws on a token it does not know, so a typo cannot
// reach a page.

import { SELF_HOST_SOURCE_URL } from "@/app/pricing/pricing-content";
import {
  ENTRY_PLAN_SIZE,
  HOSTED_COMPUTE_NEEDS_PLAN,
  HOSTED_COMPUTE_NEEDS_PLAN_SHORT,
  LARGER_PLAN_SIZE,
  MONEY_BACK_GUARANTEE,
  formatPlanSize,
  planSizeParts,
} from "@/lib/blog/plan-facts";
import { BROWSER_ADD, resizeFloor } from "@/lib/hivra/agent-catalog";

function compute(cpu: number, ramGb: number): string {
  return `${cpu} vCPU and ${ramGb} GB of RAM`;
}

const BROWSER_ADDON = compute(BROWSER_ADD.cpu, BROWSER_ADD.ram);
const OPENCLAW_MINIMUM = resizeFloor("openclaw", false);
const OPENCLAW_WITH_BROWSER = resizeFloor("openclaw", true);
const AGENT_ZERO_MINIMUM = resizeFloor("agent-zero", false);

/**
 * Owner decision for every page that says you bring your own sign-in or key: hosting does not
 * buy AI usage (the 2026-10-20 copy decision C6). "Hivra credits" is the launch flow's own name
 * for the pay-as-you-go balance.
 */
export const AI_USAGE_NOTE =
  "The plan does not include AI usage. Bring your own account or key where the agent supports it, or pay with Hivra credits.";

/**
 * The repo-approved stays-on sentence (decision C5): it is a paid-plan claim about the computer. It follows any
 * sentence of Ash's that says a computer stays on or stays available, wherever a headline cannot carry the qualifier.
 */
export const STAYS_ON = "A paid Hivra Cloud computer stays on and is not paused for inactivity.";

/** The shared guarantee wording (card payments only), as a sentence with the terms link. */
export const REFUND_SENTENCE = `There is a ${MONEY_BACK_GUARANTEE}, subject to the [published terms](/terms).`;

export const REPOSITORY_URL = SELF_HOST_SOURCE_URL;

const TOKENS: Record<string, string> = {
  /** "$9.99 a month for 2 vCPU and 4 GB of RAM" */
  entry: formatPlanSize("entry"),
  /** "$19.99 a month for 4 vCPU and 8 GB of RAM" */
  larger: formatPlanSize("larger"),
  entryPrice: planSizeParts("entry").price,
  largerPrice: planSizeParts("larger").price,
  /** "2 vCPU and 4 GB of RAM" */
  entryCompute: ENTRY_PLAN_SIZE,
  /** "4 vCPU and 8 GB of RAM" */
  largerCompute: LARGER_PLAN_SIZE,
  /** What the live browser adds to a computer: "1 vCPU and 2 GB of RAM". */
  browserAdd: BROWSER_ADDON,
  openclawMinimum: compute(OPENCLAW_MINIMUM.cpu, OPENCLAW_MINIMUM.ram),
  openclawWithBrowser: compute(OPENCLAW_WITH_BROWSER.cpu, OPENCLAW_WITH_BROWSER.ram),
  agentZeroMinimum: compute(AGENT_ZERO_MINIMUM.cpu, AGENT_ZERO_MINIMUM.ram),
  aiNote: AI_USAGE_NOTE,
  /**
   * "Every computer that Hivra Cloud runs for you needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM.
   * A free account works with a computer or server you connect yourself." Not for Hermes, which runs on Hivra Cloud only.
   * Owner decision 2026-10-21: the same rule for every agent, so no page names one agent as the paid one.
   */
  paidNote: HOSTED_COMPUTE_NEEDS_PLAN,
  /** "Every Hivra Cloud computer needs a paid plan." */
  paidShort: HOSTED_COMPUTE_NEEDS_PLAN_SHORT,
  staysOn: STAYS_ON,
  refund: REFUND_SENTENCE,
  repo: REPOSITORY_URL,
};

/** Replaces {token} with its value. Throws on an unknown token. */
export function fill(text: string): string {
  return text.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = TOKENS[name];
    if (value === undefined) throw new Error(`Unknown copy token {${name}} in: ${text.slice(0, 80)}`);
    return value;
  });
}
