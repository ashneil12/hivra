import type { Metadata } from "next";

import { ConvertPanel } from "@/components/claim/ConvertPanel";
import { DashboardPageShell } from "@/components/layout/DashboardPageShell";
import { resolveConversionState } from "@/lib/claim/conversion-state";
import { log } from "@/lib/logger";

export const metadata: Metadata = {
  title: "Convert $HermesOS | Hivra",
};

export default function ConvertPage() {
  const state = resolveConversionState();
  if (state.status !== "open" && state.problems.length > 0) {
    // A set but invalid launch value is a release defect: surface it instead of
    // silently showing the page as if $HIVRA had not launched.
    log.warn("HIVRA launch config rejected", { source: "dashboard/convert", problems: state.problems.join("; ") });
  }

  return (
    <DashboardPageShell maxWidth={900}>
      <ConvertPanel state={state} />
    </DashboardPageShell>
  );
}
