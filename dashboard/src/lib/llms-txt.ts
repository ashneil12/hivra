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
//
// `restricted` is the copy for a viewer the token geo-policy blocks (the route
// decides from the request country): no token sentence, no Tokenomics link, no
// token page link and no "no token" aside. Everything else is the same text.

import { getHivraTokenPhase, type HivraTokenPhase } from "@/lib/billing/token-registry";
import { NON_AFFILIATION_LINE, SITE_DESCRIPTION } from "@/lib/brand-description";
import {
  ENTRY_PLAN_PRICE,
  ENTRY_PLAN_SIZE,
  HOSTED_COMPUTE_NEEDS_PLAN,
  LARGER_PLAN_PRICE,
  LARGER_PLAN_SIZE,
  MONEY_BACK_GUARANTEE,
} from "@/lib/blog/plan-facts";
import { ECOSYSTEM_STAGES } from "@/lib/ecosystem-map";
import { getTokenPhaseCopy } from "@/lib/token-phase-copy";

export interface LlmsTxtSection {
  heading: string;
  links: Array<{ label: string; path: string; note?: string }>;
}

// The curated public surfaces, grouped. Site-relative paths are resolved to
// absolute SITE_URL-based URLs by buildLlmsTxt; the source links are absolute
// GitHub URLs. Every link is a real public page.
export const PUBLIC_REPOSITORY_URL = "https://github.com/ashneil12/hivra";

/** "A", "A and B" or "A, B and C". */
function joinNames(names: readonly string[]): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The products the /ecosystem page puts under "Next" (planned, not available), read
 * from the same module as the page so the two cannot name different products.
 */
const ECOSYSTEM_NEXT_NAMES = joinNames(
  ECOSYSTEM_STAGES.filter((stage) => stage.id === "next").flatMap((stage) => stage.products.map((product) => product.name)),
);

/**
 * The curated sections for a $HIVRA phase (only the Tokenomics note differs).
 * `restricted` leaves out the Tokenomics and Token rows.
 */
export function llmsTxtSections(
  phase: HivraTokenPhase = getHivraTokenPhase(),
  { restricted = false, tokenSurfaces = true }: { restricted?: boolean; tokenSurfaces?: boolean } = {}
): readonly LlmsTxtSection[] {
  const { tokenomicsNote } = getTokenPhaseCopy(phase).llmsTxt;
  return [
    {
      heading: "Product",
      links: [
        { label: "Home", path: "/", note: "Launch an agent on a computer of its own, or start with a computer and use it yourself, on Hivra Cloud, your own server or self-hosted" },
        { label: "Agents", path: "/agents", note: "Claude Code, Codex, Hermes, OpenClaw, Agent Zero and Aeon, each on a computer of its own, with what each one suits and how its model access works" },
        { label: "Pricing", path: "/pricing", note: `Self-host free, or Hivra Cloud at ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE} or ${LARGER_PLAN_PRICE} a month for ${LARGER_PLAN_SIZE}, with a ${MONEY_BACK_GUARANTEE}. The plan does not include AI usage. Every Hivra Cloud computer needs a paid plan, and a free account works with a computer or server you connect yourself` },
        { label: "Free tools", path: "/tools", note: "Keep-awake commands, a tmux cheat sheet, Claude Code plan and limit-reset calculators, an agent survival check and a hosting cost calculator. Free, with no signup" },
        { label: "Keep a Mac awake (caffeinate)", path: "/tools/keep-mac-awake", note: "Builds the caffeinate (macOS) or systemd-inhibit (Linux) command that keeps a laptop awake while an agent runs, and lists what it does not cover" },
        { label: "tmux cheat sheet", path: "/tools/tmux-cheat-sheet", note: "tmux commands and keys with copy buttons, plus running AI coding agents in named sessions" },
        { label: "Ecosystem", path: "/ecosystem", note: "What is available now, what is planned next and then, and what is still research, with the status of each product" },
        { label: "Features", path: "/features", note: "Persistent memory, browser automation, scheduled tasks and several agents on one account, and which agent and plan each depends on" },
        { label: "About", path: "/about", note: "How Hivra began as HermesOS, what it does today and what it is not, its open source code, what it costs, where it is going and how to contact it" },
        { label: "Why I'm building Hivra", path: "/why-hivra", note: "The founder's note on why AI agents need separate computers, meaningful limits and infrastructure people can inspect" },
        { label: "Compare", path: "/compare", note: "Hivra vs Agent 37, Hostinger, xCloud, Nous Hermes Cloud, a self-hosted VPS, Railway and Render, plus OpenClaw to Hermes and broader hosting choices, with a dated price table" },
      ],
    },
    ...(tokenSurfaces ? [    {
      heading: "Papers",
      links: [
        { label: "Litepaper", path: "/LITEPAPER.md", note: "The short version of what Hivra is building and why" },
        { label: "White paper", path: "/WHITEPAPER.md", note: "The long-form design and security paper" },
        ...(restricted
          ? []
          : [
              { label: "Tokenomics", path: "/TOKENOMICS.md", note: tokenomicsNote },
              { label: "Token", path: "/token", note: "The canonical contract page. Check token addresses here and nowhere else" },
            ]),
      ],
    }] : []),
    {
      heading: "Source and self-hosting",
      links: [
        { label: "Source code", path: PUBLIC_REPOSITORY_URL, note: "The open source repository" },
        { label: "Self-host quickstart", path: `${PUBLIC_REPOSITORY_URL}/blob/main/docs/self-host/QUICKSTART.md`, note: "Run the platform on your own hardware with your own sign-in" },
      ],
    },
    {
      heading: "Updates",
      links: [
        { label: "Blog", path: "/blog", note: "Guides and explainers on AI agents, hosting, and memory" },
        { label: "Changelog", path: "/changelog", note: "A dated shipping history of notable changes: new features, fixes, upstream syncs and infrastructure work. Not a promise of future features" },
        { label: "Changelog RSS feed", path: "/changelog/rss.xml", note: "Subscribe to product ships" },
        { label: "Roadmap", path: "/roadmap", note: "What is available today, what is planned next and then, what is still research and what happened to the original 2026 plan" },
      ],
    },
    {
      heading: "Status",
      links: [
        { label: "Status", path: "/status", note: "Live status of the public pages, checked from your browser in real time" },
        { label: "Stats", path: "/stats", note: "A live, dated count of the agents and computers launched on Hivra, with a 30-day chart when one is available" },
      ],
    },
    {
      heading: "Legal",
      links: [
        { label: "Security", path: "/security", note: "How to report a vulnerability privately, which versions receive fixes and the limits of the agent security model" },
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
  restricted = false,
  tokenSurfaces = true,
}: {
  siteUrl: string;
  phase?: HivraTokenPhase;
  restricted?: boolean;
  /** False while HIVRA_NEW_TOKEN_SURFACES is off: no papers section, no token sentence. */
  tokenSurfaces?: boolean;
}): string {
  const lines: string[] = [];

  lines.push("# Hivra");
  lines.push("");
  lines.push(`> ${SITE_DESCRIPTION}`);
  lines.push("");
  lines.push(
    `Available now on Hivra Cloud: launch Claude Code, Codex, Hermes, Agent Zero, OpenClaw or Aeon on a computer of its own, or launch an Ubuntu computer and use it yourself. ${HOSTED_COMPUTE_NEEDS_PLAN} Hermes runs on Hivra Cloud only. You can also self-host the platform on your own server, with no Hivra account${restricted ? "" : " and no token"}.`
  );
  lines.push("");
  lines.push(
    `Also offered, with conditions: Omarchy (prepared computer), and Windows on your own server with your licensed image (your own Proxmox host and your own licensed ISO). In preview: DeepSeek. Coming next, planned and not yet available: ${ECOSYSTEM_NEXT_NAMES} on the ecosystem map. We also intend to explore an Orchestrator, macOS computers where technically and legally feasible, and custom images.${restricted || !tokenSurfaces ? "" : ` ${getTokenPhaseCopy(phase).llmsTxt.tokenStatus}`}`
  );
  lines.push("");
  lines.push(NON_AFFILIATION_LINE);
  lines.push("");

  for (const section of llmsTxtSections(phase, { restricted, tokenSurfaces })) {
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
