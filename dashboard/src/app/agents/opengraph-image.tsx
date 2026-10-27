// Branded Open Graph card for /agents, from the shared public renderer.
// Served at /agents/opengraph-image; page.tsx wires it into the image metadata.

import { renderOgCard } from "@/lib/og-card";
import { OG_CONTENT_TYPE, OG_SIZE } from "@/lib/og-meta";
import { HUB_CONTENT } from "./content";

export const alt = "Agents you can deploy on Hivra";
export const size = { width: OG_SIZE.width, height: OG_SIZE.height };
export const contentType = OG_CONTENT_TYPE;

export default async function AgentsOpengraphImage() {
  return renderOgCard({
    eyebrow: "Agents",
    title: HUB_CONTENT.h1,
    // The first sentence of Ash's search description for this page (page.tsx), so the card says nothing of its own.
    subtitle: "Give Claude Code, Codex, Hermes, Aeon, OpenClaw or Agent Zero a cloud computer.",
  });
}
