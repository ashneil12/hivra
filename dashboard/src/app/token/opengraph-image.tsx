// Open Graph card for /token (#public-og-images). Served at
// /token/opengraph-image; buildWebsiteMetadata wires it in for the "/token" path
// through OG_IMAGE_BY_PATH. Token-facing copy: factual only, no price, returns,
// discount, urgency or call to buy.

import { renderOgCard } from "@/lib/og-card";
import { OG_IMAGE, OG_CONTENT_TYPE } from "@/lib/og-meta";

export const alt = OG_IMAGE.token.alt;
export const size = { width: OG_IMAGE.token.width, height: OG_IMAGE.token.height };
export const contentType = OG_CONTENT_TYPE;

export default async function TokenOpengraphImage() {
  return renderOgCard({
    eyebrow: "Token",
    title: "Hivra token contracts",
    subtitle: "Official contract addresses are listed here. This is information, not an offer.",
  });
}
