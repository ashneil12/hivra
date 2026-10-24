// Long-form copy model for the /agents pages.
//
// Each page's wording lives in its own content module (hub.ts, claude-code.ts and so
// on) as the text of the page, not as component props, so the words can be read, diffed
// and tested without rendering anything. The text uses a very small inline markup,
// parsed by ./markup.ts:
//
//   **bold**   `code`   [label](href)
//
// plainText() strips the markup, so the FAQPage JSON-LD carries exactly the words the
// reader sees.

import type { AgentSeoSlug } from "@/lib/hivra/agent-seo-catalog";

/** One block of a page section. The kind decides the layout, so pages are not all cards. */
export type AgentBlock =
  /** Article paragraphs at a comfortable measure. */
  | { kind: "prose"; paragraphs: string[] }
  /** Bold-led paragraphs: a short lead line (`term`) and the text under it, as ruled rows. */
  | { kind: "terms"; items: { term: string; text: string }[] }
  /** A short list of what Hivra provides, as the check-mark panel. */
  | { kind: "list"; items: string[] }
  /** Numbered steps, each with a heading and its paragraphs. `title` excludes the "1." marker. */
  | { kind: "steps"; steps: { title: string; paragraphs: string[] }[] };

export interface AgentSection {
  heading: string;
  blocks: AgentBlock[];
}

export interface AgentFaq {
  q: string;
  /** One answer paragraph, with inline markup. */
  a: string;
}

/** Where a closing link goes. Resolved by the page, so the hrefs stay in one place. */
export type AgentLinkTarget = "deploy" | "pricing" | "agents" | "features" | "directory";

export interface AgentActionLink {
  label: string;
  target: AgentLinkTarget;
}

export interface AgentPageContent {
  slug: AgentSeoSlug;
  h1: string;
  /** Paragraphs under the H1. */
  lead: string[];
  /** The primary button first, then the secondary links. */
  heroLinks: AgentActionLink[];
  sections: AgentSection[];
  faqs: AgentFaq[];
  closing: {
    heading: string;
    links: AgentActionLink[];
  };
  /** The independence line, with the vendor named as the md names it. */
  affiliation: string;
  related: {
    heading: string;
    slugs: AgentSeoSlug[];
  };
}

/** One agent card on the /agents directory. */
export interface HubAgentCard {
  slug: AgentSeoSlug;
  /** The H3: the name of the agent. */
  name: string;
  /** The bold line under the name. */
  tagline: string;
  body: string;
  /** The text after "Good fit:". */
  goodFit: string;
  linkLabel: string;
}

export interface HubTopic {
  heading: string;
  paragraphs: string[];
}

export interface HubContent {
  h1: string;
  lead: string[];
  heroLinks: AgentActionLink[];
  intro: {
    heading: string;
    paragraphs: string[];
    topics: HubTopic[];
  };
  directory: {
    heading: string;
    cards: HubAgentCard[];
  };
  choose: {
    heading: string;
    paragraphs: string[];
  };
  boundaries: {
    heading: string;
    items: { term: string; text: string }[];
  };
  closing: {
    heading: string;
    paragraph: string;
    links: AgentActionLink[];
  };
  affiliation: string;
}
