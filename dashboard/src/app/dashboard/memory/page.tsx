import { auth } from "@clerk/nextjs/server";
import { notFound } from "next/navigation";

import { DashboardPageShell } from "@/components/layout/DashboardPageShell";
import { MemoryApp } from "@/components/memory/MemoryApp";
import { isHivraMemoryEnabled } from "@/lib/memory/flag";

export const dynamic = "force-dynamic";

/** Hivra Memory: keys and setup. Preview: absent unless NEXT_PUBLIC_HIVRA_MEMORY is on. */
export default async function MemoryPage() {
  if (!isHivraMemoryEnabled()) notFound();
  await auth.protect();

  return (
    <DashboardPageShell maxWidth={900} marginBottom="4rem" padding="0 clamp(16px, 5vw, 24px)" topPadding="1rem" style={{ position: "relative", zIndex: 1 }}>
      <MemoryApp />
    </DashboardPageShell>
  );
}
