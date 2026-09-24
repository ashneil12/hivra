"use client";

import { ArrowRight, Bot, Monitor } from "lucide-react";
import Link from "next/link";

import { fleetEntryHref } from "@/lib/hivra/fleet-sections";
import { unifiedStateLabel, type UnifiedAgent } from "@/lib/hivra/unified-agent";
import type { RecentEntry } from "@/lib/workspace/recent-order";
import { recentSurfaceLabel, usedAgoLabel } from "@/lib/workspace/recent-presentation";
import { visitHref } from "@/lib/workspace/recents";

import styles from "./HomeWorkspace.module.css";

/** How many more recent resources Home lists beside the one to continue. */
export const HOME_RECENT_LIMIT = 5;

export interface HomeContinueProps {
  /** Listed resources you used in this browser, most recently used first. */
  entries: readonly RecentEntry<UnifiedAgent>[];
  /** Whether a resource's list failed to refresh, so its state is last known. */
  isStale: (agent: UnifiedAgent) => boolean;
  now: number;
}

/**
 * The resource Home offers to continue: the most recent one that is running
 * and whose list is current. A stopped one, or one whose state could not be
 * checked, would send you into a dead end, so it is listed under Recent
 * instead, where it says "View details".
 */
export function continueEntry(
  entries: readonly RecentEntry<UnifiedAgent>[],
  isStale: (agent: UnifiedAgent) => boolean,
): RecentEntry<UnifiedAgent> | null {
  return entries.find(({ item }) => item.state === "running" && !isStale(item)) ?? null;
}

function needsResponse(agent: UnifiedAgent): boolean {
  return agent.attention === "approval" || agent.attention === "clarify";
}

function ResourceIcon({ agent, size }: { agent: UnifiedAgent; size: number }) {
  return agent.resourceKind === "computer" ? <Monitor size={size} /> : <Bot size={size} />;
}

/**
 * "Pick up where you left off": the resource you were last working in, one
 * click back into the exact surface you left it on, and a Recent row of the
 * next few in the order you used them. Renders nothing until something has
 * been used in this browser.
 */
export function HomeContinue({ entries, isStale, now }: HomeContinueProps) {
  const current = continueEntry(entries, isStale);
  const others = entries.filter((entry) => entry !== current).slice(0, HOME_RECENT_LIMIT);
  if (!current && others.length === 0) return null;

  return (
    <div className={styles.recents}>
      {current ? <ContinueCard entry={current} now={now} /> : null}
      {others.length > 0 ? (
        <section aria-labelledby="home-recent-heading">
          <h2 id="home-recent-heading" className={styles.recentHeading}>Recent</h2>
          <ul className={styles.recentRow}>
            {others.map((entry) => (
              <li key={entry.item.uid} className="min-w-0">
                <RecentItem entry={entry} stale={isStale(entry.item)} now={now} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function ContinueCard({ entry, now }: { entry: RecentEntry<UnifiedAgent>; now: number }) {
  const { item: agent, visit } = entry;
  const used = usedAgoLabel(visit.usedAt, now);
  return (
    <Link
      href={visitHref(agent.uid, visit.tab, fleetEntryHref(agent))}
      className={styles.continueCard}
      data-testid="home-continue"
    >
      <span className={styles.continueEyebrow}>Pick up where you left off</span>
      <span className={styles.continueBody}>
        <span className={styles.resourceIcon} aria-hidden="true"><ResourceIcon agent={agent} size={21} /></span>
        <span className={styles.continueCopy}>
          <span className={styles.continueName}>
            {agent.emoji ? `${agent.emoji} ` : ""}{agent.name}
          </span>
          <span className={styles.continueMeta}>
            <span className={styles.statusDot} style={{ backgroundColor: agent.dot }} aria-hidden="true" />
            <span>{unifiedStateLabel(agent.state)}</span>
            <span aria-hidden="true">·</span>
            <span>{recentSurfaceLabel(visit.tab, agent)}</span>
            {used ? <><span aria-hidden="true">·</span><span>{used}</span></> : null}
          </span>
        </span>
        {needsResponse(agent) ? <span className={styles.respondBadge}>Open to respond</span> : null}
        <span className={styles.continueAction}>Continue <ArrowRight size={14} aria-hidden="true" /></span>
      </span>
    </Link>
  );
}

function RecentItem({ entry, stale, now }: { entry: RecentEntry<UnifiedAgent>; stale: boolean; now: number }) {
  const { item: agent, visit } = entry;
  const usable = !stale && agent.state === "running";
  const used = usedAgoLabel(visit.usedAt, now);
  // Only a running resource reopens on the surface you left: anything else
  // goes to its page, which explains its state.
  const href = usable ? visitHref(agent.uid, visit.tab, fleetEntryHref(agent)) : fleetEntryHref(agent);
  const action = !usable
    ? "View details"
    : needsResponse(agent) ? "Open to respond" : recentSurfaceLabel(visit.tab, agent);
  return (
    <Link href={href} className={styles.recentItem}>
      <span className={styles.recentName}>
        <ResourceIcon agent={agent} size={13} />
        <span className="truncate">{agent.emoji ? `${agent.emoji} ` : ""}{agent.name}</span>
      </span>
      <span className={styles.recentMeta}>
        <span className={styles.statusDot} style={{ backgroundColor: agent.dot }} aria-hidden="true" />
        <span className="truncate">
          {stale ? `Last known: ${unifiedStateLabel(agent.state)}` : unifiedStateLabel(agent.state)}
          {used ? ` · ${used}` : ""}
        </span>
      </span>
      <span className={styles.recentAction}>{action} <span aria-hidden="true">→</span></span>
    </Link>
  );
}
