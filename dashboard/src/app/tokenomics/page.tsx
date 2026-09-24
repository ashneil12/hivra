import type { Metadata } from "next";
import PublicSite from "@/components/public-site/PublicSite";
import FullTokenomicsSection from "@/components/landing/FullTokenomicsSection";
import { resolveTokenGeoBlockForPage } from "@/lib/compliance/token-geo-page";
import { isTokenGeoPolicyActive } from "@/lib/compliance/token-geo-policy";
import { buildWebsiteMetadata } from "@/lib/metadata";
import { getTokenPageEntries } from "@/lib/token-verification-content";
const TITLE = "Proposed $HIVRA tokenomics";
const DESCRIPTION = "Existing token access and the proposed migration, uses and treasury. Final terms are published before proposals take effect.";
// buildWebsiteMetadata sets only canonical, Open Graph and Twitter fields.
export const metadata: Metadata = { title: TITLE, description: DESCRIPTION, ...buildWebsiteMetadata({ path: "/tokenomics", title: TITLE, description: DESCRIPTION }) };
export default function TokenomicsPage() {
  // Token geo-policy dormant: render exactly as before, without reading the request country.
  if (!isTokenGeoPolicyActive()) return <PublicSite><main id="main-content"><FullTokenomicsSection headingLevel={1} /></main></PublicSite>;
  // A country is listed: render per request; a blocked viewer gets the facts and the notice only.
  return renderForViewer();
}
async function renderForViewer() {
  const geo = await resolveTokenGeoBlockForPage();
  const geoRestriction = geo.blocked ? { notice: geo.message, entries: getTokenPageEntries() } : null;
  return <PublicSite><main id="main-content"><FullTokenomicsSection headingLevel={1} geoRestriction={geoRestriction} /></main></PublicSite>;
}
