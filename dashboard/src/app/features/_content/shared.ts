import { MONEY_BACK_GUARANTEE, formatPlanSize } from "@/lib/blog/plan-facts";
import type { ActionLink } from "@/components/public-editorial/ActionLinks";

/** The two hosted sizes, in the prose form the site uses: "$9.99 a month for 2 vCPU and 4 GB of RAM". */
export const ENTRY_SIZE_PROSE = formatPlanSize("entry");
export const LARGER_SIZE_PROSE = formatPlanSize("larger");

/** Where the source code is (owner decision 2026-09-30): the repository, described as open source and self-hostable. */
export const REPOSITORY_URL = "https://github.com/ashneil12/hivra";

/** Hermes' own guide to `hermes claw migrate`; Hivra has no OpenClaw import of its own. Checked 2026-10-20. */
export const HERMES_OPENCLAW_MIGRATION_GUIDE = "https://hermes-agent.nousresearch.com/docs/guides/migrate-from-openclaw";

/**
 * What the plan buys and what it does not. The wording the owner approved for every
 * place the copy touches model access (decision C6), so the pages cannot drift.
 */
export const AI_USAGE_NOT_INCLUDED =
  "The plan does not include AI usage. Bring your own account or key where the agent supports it, or pay with Hivra credits.";

/** Said where a sign-in with your own Claude or ChatGPT account is promised. */
export const OWN_ACCOUNT_TERMS = "Using your own account is subject to the provider's terms.";

/** The stays-on sentence the repo approves for a paid Hivra Cloud computer. */
export const STAYS_ON = "A paid Hivra Cloud computer stays on and is not paused for inactivity.";

/** The guarantee, as the checkout and /terms word it, with the link a reader can follow. */
export const GUARANTEE_SENTENCE = `A ${MONEY_BACK_GUARANTEE} applies under the [current terms](/terms).`;

/** The two links every feature page closes with: the first is the button. */
export function closingActions(primary: { label: string; href: string }, secondary: { label: string; href: string }): ActionLink[] {
  return [
    { label: primary.label, href: primary.href, kind: "primary" },
    { label: secondary.label, href: secondary.href, kind: "secondary" },
  ];
}
