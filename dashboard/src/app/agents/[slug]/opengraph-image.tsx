// Branded Open Graph card for /agents/<slug>, from the shared public renderer.
// Served at /agents/<slug>/opengraph-image; page.tsx wires it into the image metadata.

import { renderOgCard } from "@/lib/og-card";
import { OG_CONTENT_TYPE, OG_SIZE } from "@/lib/og-meta";
import { AGENT_SEO_ENTRIES, getAgentSeoEntry } from "@/lib/hivra/agent-seo-catalog";
import { getAgent } from "@/lib/hivra/agent-catalog";

export const alt = "An AI agent you can run in the cloud on Hivra";
export const size = { width: OG_SIZE.width, height: OG_SIZE.height };
export const contentType = OG_CONTENT_TYPE;

export function generateStaticParams() {
  return AGENT_SEO_ENTRIES.map((entry) => ({ slug: entry.slug }));
}

// The page's dynamicParams=false does not reach this route (Next's metadata
// route loader drops it), so an unknown slug gets a real 404 here instead of a
// generic 200 card for a page that does not exist.
export default async function AgentOpengraphImage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const entry = getAgentSeoEntry(slug);
  const agent = entry ? getAgent(entry.slug) : undefined;
  if (!entry || !agent) {
    return new Response("Not Found", { status: 404 });
  }

  return renderOgCard({
    eyebrow: "Agents",
    title: `${agent.name}, in the cloud`,
    subtitle: entry.cardSummary,
  });
}
