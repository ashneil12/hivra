// Branded Open Graph card for the apex / marketing pages (#public-og-images).
// File-based dynamic image: Next.js serves this at /opengraph-image and
// page.tsx wires it into openGraph/twitter image metadata.

import { renderOgCard } from "@/lib/og-card";
import { OG_IMAGE, OG_CONTENT_TYPE } from "@/lib/og-meta";

export const alt = OG_IMAGE.home.alt;
export const size = { width: OG_IMAGE.home.width, height: OG_IMAGE.home.height };
export const contentType = OG_CONTENT_TYPE;

export default async function OpengraphImage() {
  return renderOgCard({
    title: "A computer for you and your agents",
    subtitle: "Run it on Hivra Cloud, on a server you already have, or yourself from the open source code.",
  });
}
