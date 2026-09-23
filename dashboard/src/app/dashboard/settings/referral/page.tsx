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
import styles from "../Settings.module.css";

export const dynamic = "force-dynamic";

export default async function ReferralPage() {
  if (!isReferralEnabled()) notFound();

  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  return (
    <DashboardPageShell maxWidth={824} padding="clamp(1rem, 3vw, 2rem)" topPadding="clamp(1rem, 3vw, 2rem)">
      <div className={styles.page}>
        <header className={styles.header}>
          <Link href="/dashboard/settings" className={styles.backLink}>
            <ArrowLeft size={14} aria-hidden="true" />Back to settings
          </Link>
          <h1 className={styles.title}>Invite and earn<span aria-hidden="true">.</span></h1>
          <p className={styles.intro}>
            Invite people who&apos;d get real use out of an agent. When they get going, you both get
            credits — no cap on how many you can send, capped on how many pay out.
          </p>
        </header>

        <ReferralCard />
      </div>
    </DashboardPageShell>
  );
}
