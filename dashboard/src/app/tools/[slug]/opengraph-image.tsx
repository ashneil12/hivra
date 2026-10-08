// Branded Open Graph card for /tools/<slug>, served at
// /tools/<slug>/opengraph-image and wired into the page's image metadata
// through toolOgImage() in lib/tools/tool-catalog.

import { renderOgCard } from "@/lib/og-card";
import { OG_CONTENT_TYPE, OG_SIZE } from "@/lib/og-meta";
import { TOOL_ENTRIES, getToolEntry } from "@/lib/tools/tool-catalog";

export const alt = "A free tool from Hivra";
export const size = { width: OG_SIZE.width, height: OG_SIZE.height };
export const contentType = OG_CONTENT_TYPE;

// Re-exported into the generated image route, so every card is rendered at
// build time like the page itself (the card reads the brand mark from public/).
export function generateStaticParams() {
  return TOOL_ENTRIES.map((entry) => ({ slug: entry.slug }));
}

// The page's dynamicParams=false does not reach this route (Next's metadata
// route loader drops it), so an unknown slug gets a real 404 here instead of a
// generic 200 card for a page that does not exist.
export default async function ToolOpengraphImage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const entry = getToolEntry(slug);
  if (!entry) {
    return new Response("Not Found", { status: 404 });
  }
  // The H1 reads better than a repeat of the name when the two differ.
  const subtitle = entry.h1.toLowerCase() !== entry.name.toLowerCase() ? entry.h1 : "Every number states its assumptions.";
  return renderOgCard({
    eyebrow: "Free tool. No signup.",
    title: entry.name,
    subtitle,
  });
}
