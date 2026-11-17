import { auth } from "@clerk/nextjs/server";
import { notFound } from "next/navigation";

import { DashboardPageShell } from "@/components/layout/DashboardPageShell";
import { LiteAgentApp } from "@/components/lite-agent/LiteAgentApp";
import { isFreeCloudAgentEnabled } from "@/lib/lite-agents/flag";

export const dynamic = "force-dynamic";

/** The free Lite cloud agent. Preview: absent unless NEXT_PUBLIC_HIVRA_FREE_CLOUD_AGENT is on. */
export default async function FreeAgentPage() {
  if (!isFreeCloudAgentEnabled()) notFound();
  await auth.protect();

  return (
    <DashboardPageShell
      maxWidth={1200}
      marginBottom="4rem"
      padding="0 clamp(16px, 5vw, 24px)"
      topPadding="1rem"
      style={{ position: "relative", zIndex: 1 }}
    >
      <LiteAgentApp />
    </DashboardPageShell>
  );
}
