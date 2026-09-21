/**
 * /dashboard/welcome — first-run landing for authenticated users.
 *
 * Thin server gate: validates the Clerk session and hands off to the
 * client welcome flow. The flow itself owns the state machine
 * (loading → plan → deploy → deploying) and the entitlement-skip
 * routing — see WelcomeFlow for the details.
 */

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { WelcomeFlow } from "@/components/dashboard/welcome/WelcomeFlow";

const TITLE = "Welcome to Hivra";
const DESCRIPTION =
  "Pick your tier and deploy your first agent. Lock launch rates by holding $HERMESOS — card subscriptions ship after the launch window.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  robots: {
    index: false,
    follow: false,
  },
};

export default async function WelcomePage() {
  const { userId } = await auth();
  if (!userId) {
    redirect("/sign-in");
  }
  return <WelcomeFlow />;
}
