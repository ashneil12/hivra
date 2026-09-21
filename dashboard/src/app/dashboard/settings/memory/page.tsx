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

export const dynamic = "force-dynamic";

export default async function AccountMemoryPage() {
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
        Shared agent memory
      </h1>
      <p style={{ opacity: 0.8, fontSize: 14, maxWidth: 600, lineHeight: 1.6, marginBottom: "2rem" }}>
        Anything you write here is given to every <em>new</em> agent you deploy, so they start
        already knowing the basics about you. Each agent still keeps its own private notes as it
        works with you — this is just the warm start they all share.
      </p>

      <AccountMemoryEditor />
    </DashboardPageShell>
  );
}
