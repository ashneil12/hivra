// Builder for the public /llms.txt — the emerging AI-crawler discovery
// convention (like robots.txt, but a curated plain-text map of the product for
// LLM agents/search). Pure string output: public marketing/docs links only, no
// auth, no tenant/instance/ops data. (#llms-txt)
//
// Kept separate from the route handler so the content is unit-testable in
// isolation, mirroring lib/changelog-rss.ts + app/changelog/rss.xml/route.ts.
//
// The $HIVRA sentences follow the token phase (token-phase-copy.ts). Dormant,
// the document is exactly what it was before the phase copy existed.

import { getHivraTokenPhase, type HivraTokenPhase } from "@/lib/billing/token-registry";
import { getTokenPhaseCopy } from "@/lib/token-phase-copy";

export interface LlmsTxtSection {
  heading: string;
  links: Array<{ label: string; path: string; note?: string }>;
}

// The curated public surfaces, grouped. Site-relative paths are resolved to
// absolute SITE_URL-based URLs by buildLlmsTxt; the source links are absolute
// GitHub URLs. Every link is a real public page.
export const PUBLIC_REPOSITORY_URL = "https://github.com/ashneil12/hivra";

/** The curated sections for a $HIVRA phase (only the Tokenomics note differs). */
export function llmsTxtSections(phase: HivraTokenPhase = getHivraTokenPhase()): readonly LlmsTxtSection[] {
  const { tokenomicsNote } = getTokenPhaseCopy(phase).llmsTxt;
  return [
    {
      heading: "Product",
      links: [
        { label: "Home", path: "/", note: "Launch an agent on a computer of its own, or launch a computer and use it yourself" },
        { label: "Ecosystem", path: "/ecosystem", note: "What is available now, next, later and still research" },
        { label: "Features", path: "/features", note: "Persistent memory, browser automation, scheduled tasks, multi-agent" },
        { label: "Why I'm building Hivra", path: "/why-hivra", note: "The founder's note on AI, accountability and why the limits should live outside the model" },
        { label: "Compare", path: "/compare", note: "Hivra vs self-hosting and other agent-hosting options" },
      ],
    },
    {
      heading: "Papers",
      links: [
        { label: "Litepaper", path: "/LITEPAPER.md", note: "The short version of what Hivra is building and why" },
        { label: "White paper", path: "/WHITEPAPER.md", note: "The long-form design and security paper" },
        { label: "Tokenomics", path: "/TOKENOMICS.md", note: tokenomicsNote },
        { label: "Token", path: "/token", note: "The canonical contract page. Check token addresses here and nowhere else" },
      ],
    },
    {
      heading: "Source and self-hosting",
      links: [
        { label: "Source code", path: PUBLIC_REPOSITORY_URL, note: "The public repository, under the Apache-2.0 license" },
        { label: "Self-host quickstart", path: `${PUBLIC_REPOSITORY_URL}/blob/main/docs/self-host/QUICKSTART.md`, note: "Run the platform on your own hardware with your own sign-in" },
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
}

function absoluteUrl(siteUrl: string, path: string): string {
  if (path === "/") return siteUrl;
  if (path.startsWith("https://")) return path;
  return `${siteUrl}${path}`;
}

// Serialises the curated sections into a well-formed llms.txt document:
// an H1 product line, a short '> ' blurb, then Markdown link sections.
export function buildLlmsTxt({
  siteUrl,
  phase = getHivraTokenPhase(),
}: {
  siteUrl: string;
  phase?: HivraTokenPhase;
}): string {
  const lines: string[] = [];

  lines.push("# Hivra");
  lines.push("");
  lines.push(
    "> Hivra (formerly HermesOS) gives AI agents computers of their own. Available now: launch Claude Code, Codex, Hermes, Agent Zero, OpenClaw or Aeon on a computer of its own, or launch an Ubuntu computer and use it yourself, on Hivra Cloud or your own cloud account or server. Self-hosting the platform needs no Hivra account and no token."
  );
  lines.push("");
  lines.push(
    `In private preview: Windows (on your own Proxmox host, from your own licensed ISO) and Omarchy. In preview: DeepSeek. Coming next: Hivra Orchestrator, macOS computers and custom images. ${getTokenPhaseCopy(phase).llmsTxt.tokenStatus}`
  );
  lines.push("");

  for (const section of llmsTxtSections(phase)) {
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
