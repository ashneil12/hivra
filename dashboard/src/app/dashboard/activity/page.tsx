import { auth } from "@clerk/nextjs/server";
import { ActivityObservatory } from "@/components/dashboard/activity/ActivityObservatory";
import { DashboardPageShell } from "@/components/layout/DashboardPageShell";
import { isLocalAuthMode } from "@/lib/self-host/config";

export const dynamic = "force-dynamic";

export default async function ActivityPage() {
  await auth.protect();
  return (
    <DashboardPageShell
      maxWidth={1200}
      marginBottom="8rem"
      padding="0 clamp(16px, 5vw, 24px)"
      topPadding="1rem"
    >
      <ActivityObservatory showUsage={!isLocalAuthMode()} />
    </DashboardPageShell>
  );
}
