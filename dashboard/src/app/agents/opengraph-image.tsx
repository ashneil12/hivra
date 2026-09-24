// Branded Open Graph card for /agents, from the shared public renderer.
// Served at /agents/opengraph-image; page.tsx wires it into the image metadata.

import { renderOgCard } from "@/lib/og-card";
import { OG_CONTENT_TYPE, OG_SIZE } from "@/lib/og-meta";

export const alt = "Agents you can deploy on Hivra";
export const size = { width: OG_SIZE.width, height: OG_SIZE.height };
export const contentType = OG_CONTENT_TYPE;

export default async function AgentsOpengraphImage() {
  return renderOgCard({
    eyebrow: "Agents",
    title: "Agents you can deploy today",
    subtitle: "Claude Code, Codex, Hermes, Aeon, OpenClaw and Agent Zero, each on a private cloud computer.",
  });
}
