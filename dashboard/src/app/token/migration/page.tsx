import type { Metadata } from "next";
import { notFound } from "next/navigation";

import MigrationView, { type MigrationViewState } from "@/components/token/MigrationView";
import { hivraAirdropLookupHref } from "@/lib/claim/hivra-airdrop-data";
import { claimHrefOf } from "@/lib/claim/hivra-claim";
import { getServedHivraMigration } from "@/lib/claim/hivra-migration";
import { resolveTokenGeoBlockForPage } from "@/lib/compliance/token-geo-page";
import { buildWebsiteMetadata } from "@/lib/metadata";
import { RESTRICTED_TOKEN_METADATA } from "@/lib/token-phase-copy";

// Per request: the page reads the geo decision, the $HIVRA phase and the clock.
export const dynamic = "force-dynamic";

// Ash's pack, 02-token-migration.md: browser title and search description, verbatim.
const TITLE = "$HermesOS to $HIVRA | Migration, claims and on-chain records | Hivra";
const DESCRIPTION = "How the $HermesOS to $HIVRA transition works, who can claim through Sablier, what happens to existing access, and where to verify the contracts and transactions.";

export async function generateMetadata(): Promise<Metadata> {
  if (!getServedHivraMigration()) return { robots: { index: false, follow: false } };
  const restricted = (await resolveTokenGeoBlockForPage()).blocked;
  const { title, description } = restricted ? RESTRICTED_TOKEN_METADATA : { title: TITLE, description: DESCRIPTION };
  return {
    // The pack's title already ends in "| Hivra", so it skips the root layout's "%s | Hivra" template.
    title: restricted ? title : { absolute: title },
    description,
    ...buildWebsiteMetadata({ path: "/token/migration", title, description }),
  };
}

/**
 * Hidden (404) until HIVRA_NEW_TOKEN_SURFACES is on, $HIVRA's launch block is
 * filled in and HIVRA_MIGRATION.published is true (getServedHivraMigration in
 * lib/claim/hivra-migration.ts; the links on /token and /dashboard/convert use
 * the same check). The proxy also holds back everything under /token while
 * HIVRA_NEW_TOKEN_SURFACES is off.
 */
export default async function HivraMigrationPage() {
  const now = new Date();
  const migration = getServedHivraMigration({ now });
  if (!migration) notFound();

  // The token geo list names GB (token-geo-list.ts): a blocked viewer gets the
  // notice and no migration details.
  const geo = await resolveTokenGeoBlockForPage();
  const state: MigrationViewState = geo.blocked
    ? { kind: "blocked", notice: geo.message }
    : {
        kind: "open",
        migration,
        airdropLookupHref: hivraAirdropLookupHref({ now }),
        // The Sablier link exists only while the claim is open (claimHrefOf).
        claimHref: claimHrefOf(migration.claim),
      };
  return <MigrationView state={state} />;
}
