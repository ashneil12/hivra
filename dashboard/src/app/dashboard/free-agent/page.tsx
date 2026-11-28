import { auth } from "@clerk/nextjs/server";
import { notFound } from "next/navigation";

import { DashboardPageShell } from "@/components/layout/DashboardPageShell";
import { LiteAgentApp } from "@/components/lite-agent/LiteAgentApp";
import { isCanonicalGitCanaryDeployment } from "@/lib/hivra/canonical-git-canary";
import { readCanaryLiteQaConfig } from "@/lib/lite-agents/canary-qa";
import { isFreeCloudAgentEnabled } from "@/lib/lite-agents/flag";

export const dynamic = "force-dynamic";

export default async function FreeAgentPage() {
  let explicitInference = false;
  if (isCanonicalGitCanaryDeployment()) {
    const { userId } = await auth();
    const config = userId ? await readCanaryLiteQaConfig(userId) : null;
    if (!config) notFound();
    explicitInference = config.explicitInference;
  } else {
    if (!isFreeCloudAgentEnabled()) notFound();
    await auth.protect();
  }

  return (
    <DashboardPageShell
      maxWidth={1200}
      marginBottom="4rem"
      padding="0 clamp(16px, 5vw, 24px)"
      topPadding="1rem"
      style={{ position: "relative", zIndex: 1 }}
    >
      <LiteAgentApp explicitInference={explicitInference} />
    </DashboardPageShell>
  );
}
