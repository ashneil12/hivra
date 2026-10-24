// The long-form copy of every /agents page, by slug. The catalog (lib/hivra/agent-seo-catalog.ts) holds the
// registry and the metadata; the words of each page live here.

import type { AgentSeoSlug } from "@/lib/hivra/agent-seo-catalog";
import { AEON_CONTENT } from "./aeon";
import { AGENT_ZERO_CONTENT } from "./agent-zero";
import { CLAUDE_CODE_CONTENT } from "./claude-code";
import { CODEX_CONTENT } from "./codex";
import { HERMES_CONTENT } from "./hermes";
import { OPENCLAW_CONTENT } from "./openclaw";
import type { AgentPageContent } from "./types";

export { HUB_CONTENT } from "./hub";
export type { AgentPageContent, HubContent } from "./types";

export const AGENT_PAGE_CONTENT: Record<AgentSeoSlug, AgentPageContent> = {
  "claude-code": CLAUDE_CODE_CONTENT,
  codex: CODEX_CONTENT,
  hermes: HERMES_CONTENT,
  aeon: AEON_CONTENT,
  openclaw: OPENCLAW_CONTENT,
  "agent-zero": AGENT_ZERO_CONTENT,
};

export function getAgentPageContent(slug: string): AgentPageContent | undefined {
  return Object.prototype.hasOwnProperty.call(AGENT_PAGE_CONTENT, slug) ? AGENT_PAGE_CONTENT[slug as AgentSeoSlug] : undefined;
}
