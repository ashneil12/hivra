import type { Metadata } from "next";

import TokenPageClient from "@/components/token/TokenPageClient";
import { resolveTokenGeoBlockForPage } from "@/lib/compliance/token-geo-page";
import { isTokenGeoPolicyActive } from "@/lib/compliance/token-geo-policy";
import { buildWebsiteMetadata } from "@/lib/metadata";
import { getTokenPageEntries, tokenVerificationContent } from "@/lib/token-verification-content";

// The $HIVRA entry changes at its activation instant: re-render at least every
// minute rather than freezing the build-time phase into static HTML.
export const revalidate = 60;

export const metadata: Metadata = {
  title: tokenVerificationContent.metadata.title,
  description: tokenVerificationContent.metadata.description,
  ...buildWebsiteMetadata({
    path: "/token",
    title: tokenVerificationContent.metadata.title,
    description: tokenVerificationContent.metadata.description,
  }),
};

export default function TokenVerificationPage() {
  // Token geo-policy dormant: the page renders exactly as before, without
  // reading the request country.
  if (!isTokenGeoPolicyActive()) return <TokenPageClient entries={getTokenPageEntries()} />;
  // A country is listed: render per request, with the notice for a blocked viewer.
  return renderForViewer();
}

async function renderForViewer() {
  const geo = await resolveTokenGeoBlockForPage();
  return <TokenPageClient entries={getTokenPageEntries()} geoNotice={geo.blocked ? geo.message : null} />;
}
