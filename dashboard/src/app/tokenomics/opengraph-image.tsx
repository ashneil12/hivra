// Open Graph card for /tokenomics (#public-og-images). Served at
// /tokenomics/opengraph-image; buildWebsiteMetadata wires it in for the
// "/tokenomics" path through OG_IMAGE_BY_PATH. Token-facing copy: factual only,
// no price, returns, discount, urgency or call to buy.

import { renderOgCard } from "@/lib/og-card";
import { OG_IMAGE, OG_CONTENT_TYPE } from "@/lib/og-meta";

export const alt = OG_IMAGE.tokenomics.alt;
export const size = { width: OG_IMAGE.tokenomics.width, height: OG_IMAGE.tokenomics.height };
export const contentType = OG_CONTENT_TYPE;

export default async function TokenomicsOpengraphImage() {
  return renderOgCard({
    eyebrow: "Tokenomics",
    title: "Proposed $HIVRA tokenomics",
    subtitle: "Existing token access and the proposed migration and treasury. This is information, not an offer.",
  });
}
