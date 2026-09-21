import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";

import { AuthClerkProvider } from "@/components/auth/AuthClerkProvider";
import { DashboardClient } from "./dashboard-client";

export const metadata: Metadata = {
  title: "Workspace Cloud | Hermes",
  robots: { index: false, follow: false },
};

/**
 * Hermes Workspace Cloud — the simple management dashboard for Workspace users.
 * Deliberately minimal: list your cloud agents, basic VM ops (pause/restart/
 * delete), and billing. The actual agent UX lives in the Hermes Workspace app;
 * this is just the lightweight control panel.
 */
export default async function WorkspaceCloudDashboardPage() {
  await auth.protect();
  return (
    <AuthClerkProvider>
      <DashboardClient />
    </AuthClerkProvider>
  );
}
