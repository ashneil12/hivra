// Branded Open Graph card for /tools, served at /tools/opengraph-image and wired
// into the page's image metadata through toolOgImage() in lib/tools/tool-catalog.

import { renderOgCard } from "@/lib/og-card";
import { OG_CONTENT_TYPE, OG_SIZE } from "@/lib/og-meta";
import { TOOL_ENTRIES, toolOgImage } from "@/lib/tools/tool-catalog";

export const alt = toolOgImage().alt;
export const size = { width: OG_SIZE.width, height: OG_SIZE.height };
export const contentType = OG_CONTENT_TYPE;

export default async function ToolsOpengraphImage() {
  return renderOgCard({
    eyebrow: "Free tools",
    title: "Tools for people who run agents.",
    subtitle: `${TOOL_ENTRIES.map((entry) => entry.name).join(". ")}.`,
  });
}
