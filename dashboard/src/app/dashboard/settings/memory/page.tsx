// Shared account memory (Wave 5.1) — the user writes what EVERY one of their
// agents should know. The blob is read-only fanned out into each NEW Hivra box's
// USER.md at bootstrap. Existing boxes keep their own evolving USER.md (no
// write-back), so per-box isolation is preserved.
//
// Server shell: Clerk-gates the route, then renders the self-contained client
// editor which loads/saves via /api/account/memory.

import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { DashboardPageShell } from "@/components/layout/DashboardPageShell";
import { AccountMemoryEditor } from "@/components/dashboard/AccountMemoryEditor";
import styles from "../Settings.module.css";

export const dynamic = "force-dynamic";

export default async function AccountMemoryPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  return (
    <DashboardPageShell maxWidth={824} padding="clamp(1rem, 3vw, 2rem)" topPadding="clamp(1rem, 3vw, 2rem)">
      <div className={styles.page}>
        <header className={styles.header}>
          <Link href="/dashboard/settings" className={styles.backLink}>
            <ArrowLeft size={14} aria-hidden="true" />Back to settings
          </Link>
          <h1 className={styles.title}>Shared agent memory<span aria-hidden="true">.</span></h1>
          <p className={styles.intro}>
            Anything you write here is given to every <em>new</em> agent you deploy, so they start
            already knowing the basics about you. Each agent still keeps its own private notes as it
            works with you — this is just the warm start they all share.
          </p>
        </header>

        <AccountMemoryEditor />
      </div>
    </DashboardPageShell>
  );
}
