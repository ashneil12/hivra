// Where the md's link labels point. The md writes intended destinations such as
// /launch?agent=aeon; the pages map them to the routes that exist.

import {
  AGENTS_HUB_DEPLOY_HREF,
  PRICING_HREF,
  agentDeployHref,
  type AgentSeoEntry,
} from "@/lib/hivra/agent-seo-catalog";
import type { AgentActionLink, AgentLinkTarget } from "./types";

export const AGENTS_HREF = "/agents";
export const FEATURES_HREF = "/features";
/** The id of the directory section on /agents (the slug of its heading). */
export const DIRECTORY_HREF = "#choose-an-agent";

/**
 * The href for a link target. "deploy" is sign-up with the agent named, which opens Launch on that
 * agent (agentDeployHref); on the directory, which names no agent, it is the public start link.
 */
export function resolveTarget(target: AgentLinkTarget, entry?: Pick<AgentSeoEntry, "agentType">): string {
  switch (target) {
    case "deploy":
      return entry ? agentDeployHref(entry) : AGENTS_HUB_DEPLOY_HREF;
    case "pricing":
      return PRICING_HREF;
    case "agents":
      return AGENTS_HREF;
    case "features":
      return FEATURES_HREF;
    case "directory":
      return DIRECTORY_HREF;
  }
}

export interface ResolvedActionLink {
  label: string;
  href: string;
  kind: "primary" | "secondary";
  cta?: string;
}

/** The first link is the one button of its row; the rest are text links. */
export function resolveLinks(
  links: readonly AgentActionLink[],
  entry: Pick<AgentSeoEntry, "agentType"> | undefined,
  ctaPrefix: string,
): ResolvedActionLink[] {
  return links.map((link, index) => ({
    label: link.label,
    href: resolveTarget(link.target, entry),
    kind: index === 0 ? "primary" : "secondary",
    cta: `${ctaPrefix}-${link.target}`,
  }));
}
