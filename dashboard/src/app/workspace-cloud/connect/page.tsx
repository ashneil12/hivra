import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";

import { AuthClerkProvider } from "@/components/auth/AuthClerkProvider";
import { ConnectClient } from "./connect-client";

export const metadata: Metadata = {
  title: "Connect Cloud Agent | Hermes Workspace",
  robots: { index: false, follow: false },
};

/**
 * Workspace Cloud handoff landing page. The Hermes Workspace app sends the
 * user here with ?callback=&state=&challenge=. Middleware (protected-routes)
 * redirects unauthenticated users to sign-in; once signed in, the user picks
 * or launches a lane instance and we hand a one-time code back to the local
 * Workspace callback.
 */
export default async function WorkspaceCloudConnectPage() {
  await auth.protect();
  return (
    <AuthClerkProvider>
      <ConnectClient />
    </AuthClerkProvider>
  );
}
