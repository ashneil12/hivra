import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";

import { AuthClerkProvider } from "@/components/auth/AuthClerkProvider";
import { BillingClient } from "./billing-client";

export const metadata: Metadata = {
  title: "Billing | Workspace Cloud | Hermes",
  robots: { index: false, follow: false },
};

/**
 * Hermes Workspace Cloud — self-contained billing. Deliberately separate from
 * the Hivra billing dashboard: a Workspace Cloud subscriber only ever sees
 * the cloud lane's own paid plans + subscription, never the Hivra plans
 * (or its free tier).
 */
export default async function WorkspaceCloudBillingPage() {
  await auth.protect();
  return (
    <AuthClerkProvider>
      <BillingClient />
    </AuthClerkProvider>
  );
}
