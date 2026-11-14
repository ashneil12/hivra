import type { Metadata } from "next";
import { notFound } from "next/navigation";

import ReceiptsView, { type ReceiptsViewState } from "@/components/token/ReceiptsView";
import { hivraMigrationHref } from "@/lib/claim/hivra-migration";
import { resolveTokenGeoBlockForPage } from "@/lib/compliance/token-geo-page";
import { buildWebsiteMetadata } from "@/lib/metadata";
import { RESTRICTED_TOKEN_METADATA } from "@/lib/token-phase-copy";
import { getServedTokenReceiptsBase, TOKEN_RECEIPTS_PATH } from "@/lib/token-receipts/token-receipts";
import { loadTokenReceipts } from "@/lib/token-receipts/token-receipts-chain";

// Per request: the page reads the geo decision and the clock. Base itself is
// read through the caches in token-receipts-chain.ts, not on every view.
export const dynamic = "force-dynamic";

const TITLE = "Token receipts | Fees, liquidity, founder sales and burn | Hivra";
const DESCRIPTION = "Every $HIVRA fee claim, liquidity addition and lock, founder $HermesOS sale and the final burn, each read from its transaction on Base.";

export async function generateMetadata(): Promise<Metadata> {
  if (!getServedTokenReceiptsBase()) return { robots: { index: false, follow: false } };
  const restricted = (await resolveTokenGeoBlockForPage()).blocked;
  const { title, description } = restricted ? RESTRICTED_TOKEN_METADATA : { title: TITLE, description: DESCRIPTION };
  return {
    title: restricted ? title : { absolute: title },
    description,
    ...buildWebsiteMetadata({ path: TOKEN_RECEIPTS_PATH, title, description }),
  };
}

/**
 * Hidden (404) until HIVRA_NEW_TOKEN_SURFACES is on and $HIVRA's launch block is
 * filled in (getServedTokenReceiptsBase). The proxy also holds back everything
 * under /token while the switch is off.
 */
export default async function TokenReceiptsPage() {
  const now = new Date();
  const base = getServedTokenReceiptsBase({ now });
  if (!base) notFound();

  // The token geo list names GB (token-geo-list.ts): a blocked viewer gets the
  // notice and no receipts, and Base is not read for them.
  const geo = await resolveTokenGeoBlockForPage();
  const state: ReceiptsViewState = geo.blocked
    ? { kind: "blocked", notice: geo.message }
    : { kind: "open", receipts: await loadTokenReceipts(base, { now }), migrationHref: hivraMigrationHref({ now }) };
  return <ReceiptsView state={state} />;
}
