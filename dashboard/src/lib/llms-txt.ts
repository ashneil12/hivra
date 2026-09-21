// Builder for the public /llms.txt — the emerging AI-crawler discovery
// convention (like robots.txt, but a curated plain-text map of the product for
// LLM agents/search). Pure string output: public marketing/docs links only, no
// auth, no tenant/instance/ops data. (#llms-txt)
//
// Kept separate from the route handler so the content is unit-testable in
// isolation, mirroring lib/changelog-rss.ts + app/changelog/rss.xml/route.ts.

export interface LlmsTxtSection {
  heading: string;
  links: Array<{ label: string; path: string; note?: string }>;
}

// The curated public surfaces, grouped. Paths are site-relative and resolved to
// absolute SITE_URL-based URLs by buildLlmsTxt — every link is a real public page.
export const LLMS_TXT_SECTIONS: readonly LlmsTxtSection[] = [
  {
    heading: "Product",
    links: [
      { label: "Home", path: "/", note: "Deploy any AI agent to managed cloud hosting in one click" },
      { label: "Features", path: "/features", note: "Persistent memory, browser automation, scheduled tasks, multi-agent" },
      { label: "Why Hivra", path: "/why-hivra", note: "The evolution of HermesOS into Hivra — what changed and what stayed" },
      { label: "Compare", path: "/compare", note: "Hivra vs self-hosting and other agent-hosting options" },
    ],
  },
  {
    heading: "Updates",
    links: [
      { label: "Blog", path: "/blog", note: "Guides and explainers on AI agents, hosting, and memory" },
      { label: "Changelog", path: "/changelog", note: "Dated entries for every notable ship" },
      { label: "Changelog RSS feed", path: "/changelog/rss.xml", note: "Subscribe to product ships" },
      { label: "Roadmap", path: "/roadmap", note: "What is being built next" },
    ],
  },
  {
    heading: "Status",
    links: [
      { label: "Status", path: "/status", note: "Live operational health of the public surfaces" },
      { label: "Stats", path: "/stats", note: "Live deploy counter" },
    ],
  },
  {
    heading: "Legal",
    links: [
      { label: "Privacy", path: "/privacy" },
      { label: "Terms", path: "/terms" },
    ],
  },
];

function absoluteUrl(siteUrl: string, path: string): string {
  if (path === "/") return siteUrl;
  return `${siteUrl}${path}`;
}

// Serialises the curated sections into a well-formed llms.txt document:
// an H1 product line, a short '> ' blurb, then Markdown link sections.
export function buildLlmsTxt({ siteUrl }: { siteUrl: string }): string {
  const lines: string[] = [];

  lines.push("# Hivra");
  lines.push("");
  lines.push(
    "> Hivra (formerly HermesOS) is managed cloud hosting for AI agents — deploy Hermes Agent, Claude Code, and more in one click with persistent memory, browser automation, and tool use. Free tier is live; Pro agents stay always-on."
  );
  lines.push("");

  for (const section of LLMS_TXT_SECTIONS) {
    lines.push(`## ${section.heading}`);
    lines.push("");
    for (const link of section.links) {
      const url = absoluteUrl(siteUrl, link.path);
      lines.push(link.note ? `- [${link.label}](${url}): ${link.note}` : `- [${link.label}](${url})`);
    }
    lines.push("");
  }

  // Single trailing newline.
  return `${lines.join("\n").trimEnd()}\n`;
}
