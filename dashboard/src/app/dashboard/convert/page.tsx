import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";

import { ConvertPanel } from "@/components/claim/ConvertPanel";
import { DashboardPageShell } from "@/components/layout/DashboardPageShell";
import { getHivraTokenPhase } from "@/lib/billing/token-registry";
import { readConversionAccessGate } from "@/lib/claim/conversion-access.server";
import { resolveTokenGeoBlockForPage } from "@/lib/compliance/token-geo-page";
import { readConversionInputs, resolveConversionState } from "@/lib/claim/conversion-state";
import { log } from "@/lib/logger";

// The title follows the $HIVRA phase: dormant, it is the title from before launch.
export function generateMetadata(): Metadata {
  return { title: getHivraTokenPhase() === "dormant" ? "Convert $HermesOS" : "$HIVRA for $HermesOS holders" };
}

// $HIVRA's phase and the user's access change over time, so never serve a cached render.
export const dynamic = "force-dynamic";

export default async function ConvertPage() {
  const now = new Date();
  const { userId } = await auth();
  // Token geo-policy: a blocked viewer gets the notice and no airdrop details or
  // switch step; the contracts, the no-claim warning and their access (and any
  // post-switch deadline) still show.
  // With the dormant policy this reads nothing.
  const geo = await resolveTokenGeoBlockForPage(userId ?? null);
  const access = await readConversionAccessGate(userId ?? null, now);
  const state = resolveConversionState(readConversionInputs(access, now));
  if (state.problems.length > 0) {
    // A set but invalid airdrop value is a release defect: surface it instead of
    // silently showing the page as if it had not been configured.
    log.warn("HIVRA airdrop config rejected", { source: "dashboard/convert", problems: state.problems.join("; ") });
  }

  return (
    <DashboardPageShell maxWidth={900}>
      <ConvertPanel state={state} geoNotice={geo.blocked ? geo.message : null} />
    </DashboardPageShell>
  );
}
