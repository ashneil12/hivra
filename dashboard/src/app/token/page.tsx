import type { Metadata } from "next";

import TokenPageClient from "@/components/token/TokenPageClient";
import { resolveTokenGeoBlockForPage } from "@/lib/compliance/token-geo-page";
import { isTokenGeoPolicyActive } from "@/lib/compliance/token-geo-policy";
import { getHivraTokenPhase } from "@/lib/billing/token-registry";
import type { TokenPageAirdropFacts } from "@/lib/claim/conversion-state";
import { getTokenPageAirdropFacts, hivraAirdropLookupHref } from "@/lib/claim/hivra-airdrop-data";
import { hivraMigrationHref } from "@/lib/claim/hivra-migration";
import { buildWebsiteMetadata } from "@/lib/metadata";
import { RESTRICTED_TOKEN_METADATA, getTokenPhaseCopy } from "@/lib/token-phase-copy";
import { newTokenSurfacesEnabled } from "@/lib/token-surfaces";
import { tokenReceiptsHref } from "@/lib/token-receipts/token-receipts";
import { getTokenPageEntries, tokenPhaseFromEntries, type TokenPageEntry } from "@/lib/token-verification-content";

// The $HIVRA entry changes at its activation instant: re-render at least every
// minute rather than freezing the build-time phase into static HTML.
export const revalidate = 60;

// Generated, not a constant, so the title and description follow the $HIVRA
// phase through each revalidation, and a viewer the token geo-policy blocks gets
// a head that names only the contracts. Dormant: exactly the copy from before,
// with no request read.
export async function generateMetadata(): Promise<Metadata> {
  const phase = getHivraTokenPhase();
  const phaseCopy = getTokenPhaseCopy(phase).tokenPage;
  const restricted = isTokenGeoPolicyActive() && (await resolveTokenGeoBlockForPage()).blocked;
  const { title, description } = restricted
    ? RESTRICTED_TOKEN_METADATA
    : { title: phaseCopy.metadataTitle, description: phaseCopy.metadataDescription };
  return {
    // The launched title already ends in its own wording ("Hivra tokens | ..."), so it
    // skips the root layout's "%s | Hivra" template: the browser title is exactly it.
    title: restricted || phase === "dormant" ? title : { absolute: title },
    description,
    ...buildWebsiteMetadata({ path: "/token", title, description }),
  };
}

/**
 * What the launched page shows about the airdrop (the published snapshot and the
 * Airdrop wallet), resolved here on the server at render. TokenPageClient is a
 * client component, so the page never imports the airdrop config itself: it
 * also holds the Sablier campaign link and the claim window. Dormant, nothing
 * is read and no prop is added, so the page and its props are as before.
 */
function launchedAirdropProps(entries: readonly TokenPageEntry[]): { airdropFacts?: TokenPageAirdropFacts } {
  if (tokenPhaseFromEntries(entries) === "dormant") return {};
  const hivra = entries.find((entry) => entry.key === "hivra");
  return hivra?.contractAddress ? { airdropFacts: getTokenPageAirdropFacts(hivra.contractAddress) } : {};
}

export default function TokenVerificationPage() {
  const entries = getTokenPageEntries();
  // The switch is server-only; the client header and footer are told its value so they render as the server did.
  const tokenSurfaces = newTokenSurfacesEnabled();
  // No country is listed (the list is empty, so the policy is dormant): the
  // page renders as before, without reading the request country.
  if (!isTokenGeoPolicyActive()) {
    return <TokenPageClient entries={entries} {...launchedAirdropProps(entries)} airdropLookupHref={hivraAirdropLookupHref()} migrationHref={hivraMigrationHref()} receiptsHref={tokenReceiptsHref()} tokenSurfaces={tokenSurfaces} />;
  }
  // A country is listed (GB today): render per request, with the notice for a blocked viewer.
  return renderForViewer(entries, tokenSurfaces);
}

async function renderForViewer(entries: TokenPageEntry[], tokenSurfaces: boolean) {
  const geo = await resolveTokenGeoBlockForPage();
  // A blocked viewer gets no airdrop facts and no link to the airdrop lookup or the migration page.
  return (
    <TokenPageClient
      entries={entries}
      geoNotice={geo.blocked ? geo.message : null}
      {...(geo.blocked ? {} : launchedAirdropProps(entries))}
      airdropLookupHref={geo.blocked ? null : hivraAirdropLookupHref()}
      migrationHref={geo.blocked ? null : hivraMigrationHref()}
      receiptsHref={geo.blocked ? null : tokenReceiptsHref()}
      tokenSurfaces={tokenSurfaces}
    />
  );
}
