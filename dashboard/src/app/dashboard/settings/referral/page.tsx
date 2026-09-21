// Invite & Earn (paioclaw rip-list) — the user's referral code/link + a copy
// button + a count of rewarded referrals. Server shell Clerk-gates the route,
// then renders the self-contained client card which loads from
// /api/account/referral. Gated by NEXT_PUBLIC_HIVRA_REFERRAL_ENABLED: when the
// flag is off, the route 404s so the feature is fully invisible on canary.

import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { DashboardPageShell } from "@/components/layout/DashboardPageShell";
import { ReferralCard } from "@/components/dashboard/ReferralCard";
import { isReferralEnabled } from "@/lib/referral";

export const dynamic = "force-dynamic";

export default async function ReferralPage() {
  if (!isReferralEnabled()) notFound();

  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  return (
    <DashboardPageShell maxWidth={800}>
      <Link
        href="/dashboard/settings"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          textDecoration: "none",
          color: "var(--ink-black)",
          marginBottom: "2rem",
          fontFamily: "var(--font-mono), monospace",
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.2em",
          opacity: 0.5,
        }}
      >
        <ArrowLeft size={12} /> Back to settings
      </Link>

      <h1
        className="serif"
        style={{ fontSize: "2.5rem", fontWeight: 300, lineHeight: 1.1, marginBottom: "0.75rem" }}
      >
        Invite &amp; Earn
      </h1>
      <p style={{ opacity: 0.8, fontSize: 14, maxWidth: 600, lineHeight: 1.6, marginBottom: "2rem" }}>
        Invite people who&apos;d get real use out of an agent. When they get going, you both get
        credits — no cap on how many you can send, capped on how many pay out.
      </p>

      <ReferralCard />
    </DashboardPageShell>
  );
}
