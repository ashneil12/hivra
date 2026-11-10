"use client";

// Launch → "Put an agent on a computer I already have" (design 5.8). A link,
// not a new launch lane: it opens the computer list, where the owner picks the
// computer and adds the agent through that computer's own gate and Review.
// Shown only where attach is offered, and only to someone who has a computer
// to put an agent on: with none, the link would lead nowhere.

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { fetchOwnerAttachedAgents } from "@/lib/agent-computers/attach-client";
import { listAgentsResult } from "@/lib/hivra/agent-api";
import { getAgent } from "@/lib/hivra/agent-catalog";

export const ATTACH_ENTRY_HREF = "/dashboard/computers?addAgent=1";

/** Whether the person has any computer. A list that can't be read counts as
 * yes, so a failed read never hides the way in. */
async function hasComputers(): Promise<boolean> {
  try {
    const { agents, error } = await listAgentsResult();
    if (error) return true;
    return agents.some((agent) => agent.status !== "deleted" && getAgent(agent.type)?.resourceKind === "computer");
  } catch {
    return true;
  }
}

/** Where attach is offered: read here unless the caller already knows. */
export function AttachEntryLink({ className, offered: known }: { className?: string; offered?: boolean }) {
  const [read, setRead] = useState(false);
  useEffect(() => {
    if (known !== undefined) return;
    let alive = true;
    void Promise.all([fetchOwnerAttachedAgents(), hasComputers()]).then(([result, computers]) => {
      if (alive) setRead(Boolean(result?.enabled) && computers);
    });
    return () => { alive = false; };
  }, [known]);
  if (!(known ?? read)) return null;
  return (
    <Link className={className} href={ATTACH_ENTRY_HREF}>
      Put an agent on a computer I already have <ArrowRight size={13} aria-hidden />
    </Link>
  );
}
