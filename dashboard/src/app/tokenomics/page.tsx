import type { Metadata } from "next";
import PublicSite from "@/components/public-site/PublicSite";
import FullTokenomicsSection from "@/components/landing/FullTokenomicsSection";
import { resolveTokenGeoBlockForPage } from "@/lib/compliance/token-geo-page";
import { isTokenGeoPolicyActive } from "@/lib/compliance/token-geo-policy";
import { getHivraTokenPhase, type HivraTokenPhase } from "@/lib/billing/token-registry";
import { buildWebsiteMetadata } from "@/lib/metadata";
import { getTokenPhaseCopy } from "@/lib/token-phase-copy";
import { getTokenPageEntries } from "@/lib/token-verification-content";
// The $HIVRA copy changes at its activation instant: re-render at least every
// minute rather than freezing the build-time phase into static HTML.
export const revalidate = 60;
// buildWebsiteMetadata sets only canonical, Open Graph and Twitter fields. Generated so the
// title and description follow the $HIVRA phase; dormant, they are exactly the copy from before.
export function generateMetadata(): Metadata {
  const { metadataTitle: title, metadataDescription: description } = getTokenPhaseCopy(getHivraTokenPhase()).tokenomics;
  return { title, description, ...buildWebsiteMetadata({ path: "/tokenomics", title, description }) };
}
export default function TokenomicsPage() {
  const phase = getHivraTokenPhase();
  // Token geo-policy dormant: render exactly as before, without reading the request country.
  if (!isTokenGeoPolicyActive()) return <PublicSite><main id="main-content"><FullTokenomicsSection headingLevel={1} phase={phase} /></main></PublicSite>;
  // A country is listed: render per request; a blocked viewer gets the facts and the notice only.
  return renderForViewer(phase);
}
async function renderForViewer(phase: HivraTokenPhase) {
  const geo = await resolveTokenGeoBlockForPage();
  const geoRestriction = geo.blocked ? { notice: geo.message, entries: getTokenPageEntries() } : null;
  return <PublicSite><main id="main-content"><FullTokenomicsSection headingLevel={1} phase={phase} geoRestriction={geoRestriction} /></main></PublicSite>;
}
