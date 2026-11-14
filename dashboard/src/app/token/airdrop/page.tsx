import type { Metadata } from "next";
import { notFound } from "next/navigation";

import AirdropLookupView, { type AirdropLookupViewState } from "@/components/token/AirdropLookupView";
import { getServedHivraAirdrop } from "@/lib/claim/hivra-airdrop-data";
import { lookupHivraAirdrop } from "@/lib/claim/hivra-airdrop-lookup";
import { claimHrefOf } from "@/lib/claim/hivra-claim";
import { hivraMigrationHref } from "@/lib/claim/hivra-migration";
import { resolveTokenGeoBlockForPage } from "@/lib/compliance/token-geo-page";
import { buildWebsiteMetadata } from "@/lib/metadata";
import { RESTRICTED_TOKEN_METADATA } from "@/lib/token-phase-copy";

// Per request: the lookup reads the query, the geo decision and the $HIVRA phase.
export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// Ash's pack, 03-token-airdrop.md: browser title and search description, verbatim.
const TITLE = "Check your $HIVRA allocation and claim | Hivra";
const DESCRIPTION = "Check whether your wallet qualified in the $HermesOS snapshot, see your $HIVRA allocation and find the official Sablier claim process.";

function firstValue(value: string | string[] | undefined): string | null {
  const text = Array.isArray(value) ? value[0] : value;
  return typeof text === "string" && text.trim() ? text.trim().slice(0, 100) : null;
}

export async function generateMetadata({ searchParams }: { searchParams: SearchParams }): Promise<Metadata> {
  if (!getServedHivraAirdrop()) return { robots: { index: false, follow: false } };
  const restricted = (await resolveTokenGeoBlockForPage()).blocked;
  const { title, description } = restricted ? RESTRICTED_TOKEN_METADATA : { title: TITLE, description: DESCRIPTION };
  const looked = firstValue((await searchParams).address) !== null;
  return {
    // The pack's title already ends in "| Hivra", so it skips the root layout's "%s | Hivra" template.
    title: restricted ? title : { absolute: title },
    description,
    ...buildWebsiteMetadata({ path: "/token/airdrop", title, description }),
    // A lookup result is one wallet's answer, not a page to index.
    ...(looked ? { robots: { index: false, follow: true } } : {}),
  };
}

/**
 * Hidden (404) until HIVRA_NEW_TOKEN_SURFACES is on and $HIVRA's launch block,
 * the published snapshot and the committed list are all in place
 * (getServedHivraAirdrop in lib/claim/hivra-airdrop-data.ts; the links on /token
 * and /dashboard/convert use the same check). The proxy also holds back
 * everything under /token while HIVRA_NEW_TOKEN_SURFACES is off.
 */
export default async function HivraAirdropLookupPage({ searchParams }: { searchParams: SearchParams }) {
  const open = getServedHivraAirdrop();
  if (!open) notFound();

  // The token geo list names GB (token-geo-list.ts), so this reads the viewer's
  // country; a blocked viewer gets the notice and the query is never read.
  const geo = await resolveTokenGeoBlockForPage();
  let state: AirdropLookupViewState;
  if (geo.blocked) {
    // Never read or answer the query for a blocked viewer.
    state = { kind: "blocked", notice: geo.message };
  } else {
    const query = firstValue((await searchParams).address);
    const { claim, airdrop, snapshot } = open;
    state = {
      kind: "open",
      snapshot,
      // The Sablier link exists only while the claim is open (claimHrefOf).
      claim: { phase: claim.phase, href: claimHrefOf(claim), opensAt: claim.opensAt, closesAt: claim.closesAt },
      // Counts are shown only for the verified final list, never for dry-run data.
      counts: airdrop.data.final ? airdrop.data.totals : null,
      // Only when /token/migration is actually served.
      migrationHref: hivraMigrationHref(),
      query,
      result: query ? lookupHivraAirdrop(airdrop, query) : null,
    };
  }
  return <AirdropLookupView state={state} />;
}
