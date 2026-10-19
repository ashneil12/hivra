import type { Metadata } from "next";
import { notFound } from "next/navigation";

import AirdropLookupView, { type AirdropLookupViewState } from "@/components/token/AirdropLookupView";
import { getOpenHivraAirdrop } from "@/lib/claim/hivra-airdrop-data";
import { lookupHivraAirdrop } from "@/lib/claim/hivra-airdrop-lookup";
import { resolveTokenGeoBlockForPage } from "@/lib/compliance/token-geo-page";
import { buildWebsiteMetadata } from "@/lib/metadata";
import { RESTRICTED_TOKEN_METADATA } from "@/lib/token-phase-copy";
import { newTokenSurfacesEnabled } from "@/lib/token-surfaces";

// Per request: the lookup reads the query, the geo decision and the $HIVRA phase.
export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const TITLE = "Check a wallet for the $HIVRA airdrop";
const DESCRIPTION = "Paste a Base wallet address to see the $HIVRA it is sent from the $HermesOS snapshot, and whether it was sent.";

function firstValue(value: string | string[] | undefined): string | null {
  const text = Array.isArray(value) ? value[0] : value;
  return typeof text === "string" && text.trim() ? text.trim().slice(0, 100) : null;
}

export async function generateMetadata({ searchParams }: { searchParams: SearchParams }): Promise<Metadata> {
  if (!newTokenSurfacesEnabled() || !getOpenHivraAirdrop()) return { robots: { index: false, follow: false } };
  const restricted = (await resolveTokenGeoBlockForPage()).blocked;
  const { title, description } = restricted ? RESTRICTED_TOKEN_METADATA : { title: TITLE, description: DESCRIPTION };
  const looked = firstValue((await searchParams).address) !== null;
  return {
    title,
    description,
    ...buildWebsiteMetadata({ path: "/token/airdrop", title, description }),
    // A lookup result is one wallet's answer, not a page to index.
    ...(looked ? { robots: { index: false, follow: true } } : {}),
  };
}

/**
 * Hidden (404) until $HIVRA's launch block, the published snapshot and the
 * committed list are all in place (lib/claim/hivra-airdrop-data.ts). The proxy
 * also holds back everything under /token while HIVRA_NEW_TOKEN_SURFACES is off.
 */
export default async function HivraAirdropLookupPage({ searchParams }: { searchParams: SearchParams }) {
  if (!newTokenSurfacesEnabled()) notFound();
  const open = getOpenHivraAirdrop();
  if (!open) notFound();

  // With the dormant (empty) geo list this returns "not blocked" without reading the request.
  const geo = await resolveTokenGeoBlockForPage();
  let state: AirdropLookupViewState;
  if (geo.blocked) {
    // Never read or answer the query for a blocked viewer.
    state = { kind: "blocked", notice: geo.message };
  } else {
    const query = firstValue((await searchParams).address);
    state = {
      kind: "open",
      snapshot: open.snapshot,
      senderAddress: open.senderAddress,
      totals: open.airdrop.data.totals,
      query,
      result: query ? lookupHivraAirdrop(open.airdrop, query) : null,
    };
  }
  return <AirdropLookupView state={state} />;
}
