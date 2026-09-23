import type { Metadata } from "next";

import { ConvertPanel } from "@/components/claim/ConvertPanel";
import { DashboardPageShell } from "@/components/layout/DashboardPageShell";
import { readConversionInputs, resolveConversionState } from "@/lib/claim/conversion-state";
import { log } from "@/lib/logger";

export const metadata: Metadata = {
  title: "Convert $HermesOS | Hivra",
};

// $HIVRA's phase depends on the current time, so never serve a cached render.
export const dynamic = "force-dynamic";

export default function ConvertPage() {
  // The per-user access gate is not wired yet: until eligibility counts $HIVRA,
  // converting could drop a holder below their tier, so conversion stays closed.
  const state = resolveConversionState(readConversionInputs(null));
  if (state.status !== "open" && state.problems.length > 0) {
    // A set but invalid launch value is a release defect: surface it instead of
    // silently showing the page as if conversion had not been configured.
    log.warn("HIVRA conversion links rejected", { source: "dashboard/convert", problems: state.problems.join("; ") });
  }

  return (
    <DashboardPageShell maxWidth={900}>
      <ConvertPanel state={state} />
    </DashboardPageShell>
  );
}
