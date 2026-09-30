"use client";

// Launch → "Put an agent on a computer I already have" (design 5.8). A link,
// not a new launch lane: it opens the computer list, where the owner picks the
// computer and adds the agent through that computer's own gate and Review.
// Shown only where attach is offered.

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { fetchOwnerAttachedAgents } from "@/lib/agent-computers/attach-client";

export const ATTACH_ENTRY_HREF = "/dashboard/computers?addAgent=1";

/** Where attach is offered: read here unless the caller already knows. */
export function AttachEntryLink({ className, offered: known }: { className?: string; offered?: boolean }) {
  const [read, setRead] = useState(false);
  useEffect(() => {
    if (known !== undefined) return;
    let alive = true;
    void fetchOwnerAttachedAgents().then((result) => { if (alive) setRead(Boolean(result?.enabled)); });
    return () => { alive = false; };
  }, [known]);
  if (!(known ?? read)) return null;
  return (
    <Link className={className} href={ATTACH_ENTRY_HREF}>
      Put an agent on a computer I already have <ArrowRight size={13} aria-hidden />
    </Link>
  );
}
