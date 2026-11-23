import { auth } from "@clerk/nextjs/server";
import Link from "next/link";

import { isHolderTierCarryoverEnabled } from "@/lib/billing/token-access";
import { readConversionAccessGate } from "@/lib/claim/conversion-access.server";
import { resolveTokenGeoBlockForPage } from "@/lib/compliance/token-geo-page";

export async function HolderSwitchNotice({ className = "" }: { className?: string } = {}) {
  if (!isHolderTierCarryoverEnabled()) return null;
  const { userId } = await auth();
  if (!userId || (await resolveTokenGeoBlockForPage(userId)).blocked) return null;
  const access = await readConversionAccessGate(userId, new Date(), { recordMembership: false });
  if (!access?.grandfathered || access.convertedAt || !access.carryover) return null;

  return (
    <aside aria-label="Holder access" className={`rounded-lg border border-[var(--hg-stroke)] bg-[var(--hg-fill-1)] px-4 py-3 text-sm ${className}`}>
      {access.carryover.tiers.length ? (
        <p>Your $HermesOS holder tier can now use the same qualifying amount of $HIVRA. Switching is optional.</p>
      ) : (
        <p>Your account still uses $HermesOS. You can choose $HIVRA for token access whenever you’re ready.</p>
      )}
      <Link className="mt-1 inline-block font-medium underline" href="/dashboard/convert">Review my holder access</Link>
    </aside>
  );
}
