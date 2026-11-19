"use client";

import { AlertTriangle, Bot, Link2, Monitor, Plus, RotateCcw, Search, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useLayoutEffect, useMemo, useState } from "react";

import { useWorkspaceAgents } from "@/components/workspace/useWorkspaceAgents";
import {
  duplicateFleetNames,
  fleetEntryHref,
  fleetEntryOpenLabel,
  fleetSections,
  relaunchHref,
} from "@/lib/hivra/fleet-sections";
import { attentionFallbackReason, attentionLabel, needsOwnerAttention } from "@/lib/hivra/resource-attention";
import { deleteAgent, startAgent } from "@/lib/hivra/agent-api";
import styles from "./HomeWorkspace.module.css";
import { HomeContinue } from "./HomeContinue";
import { FirstRunCard } from "./FirstRunCard";
import { InboxAnswer } from "./InboxAnswer";
import { OnboardingChecklist } from "@/components/dashboard/OnboardingChecklist";
import { StatusText } from "@/components/ui/StatusText";
import { inRecentOrder } from "@/lib/workspace/recent-order";
import { listRecents, visitHref, type RecentVisit } from "@/lib/workspace/recents";
import { isAppOpenAtHome, markHomeOpened } from "@/lib/workspace/app-open";
import { isRunningState, unifiedStateLabel, type UnifiedAgent } from "@/lib/hivra/unified-agent";
import { agentComputerPairDetail } from "@/lib/agent-computers/agent-surfaces";
import { offeredAgentTiles } from "@/components/launch/launch-tiles";
import { isLaunchCatalogEnabled, primaryCatalogJob, tryNextSuggestions } from "@/lib/launch/launch-catalog";
import { isLocalAuthMode } from "@/lib/self-host/config";

const NO_RECENTS: RecentVisit[] = [];

/** Home lists your agents and computers, led by the one you were last in and
 * the others you used recently. Only opening the app at Home resumes it
 * straight away; the Home link and the logo inside the app always show the
 * list. */
export function FleetControlPane({ requested = false, attentionRequested = false }: { requested?: boolean; attentionRequested?: boolean }) {
  const router = useRouter();
  // Whether this view opened the app. Decided before paint, after the first
  // render, so the server and the first client render agree on the list.
  const [appOpen, setAppOpen] = useState(false);
  // What this browser used, most recently used first, and when it was read.
  // Read after mounting, not while rendering: the page being left records its
  // last use as it closes, which comes after this view first renders. Read
  // before paint, and Home counts as loading until it has been.
  const [recentView, setRecentView] = useState<{ recents: RecentVisit[]; now: number } | null>(null);
  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Deliberate post-hydration flip of a render-gating flag read from browser-only state.
    if (isAppOpenAtHome()) setAppOpen(true);
    markHomeOpened();
    setRecentView({ recents: listRecents(), now: Date.now() });
  }, []);
  // Home acts on this list (Continue, resuming on app open), so it waits for
  // a read made since it opened: a held one can still list an agent deleted
  // or stopped a moment ago.
  const { agents, loading: listLoading, hermesError, hivraError, attachedError, retryHermes, retryHivra } =
    useWorkspaceAgents();
  const loading = listLoading || recentView === null;
  const recents = recentView?.recents ?? NO_RECENTS;
  // Which failed list a row came from: an agent added to a computer has its own.
  const staleSource = useCallback(
    (agent: UnifiedAgent) => agent.kind === "hermes" ? hermesError : agent.attachment ? attachedError || hivraError : hivraError,
    [attachedError, hermesError, hivraError],
  );
  const [query, setQuery] = useState("");
  // Set by the "needs attention" button: narrows the list to the broken ones.
  const [attentionOnly, setAttentionOnly] = useState(attentionRequested);
  // Failed refreshes retain inventory for browsing, but cannot validate attention or resumption.
  const currentAgents = useMemo(
    () => agents.filter((agent) => !staleSource(agent)),
    [agents, staleSource],
  );
  const attention = useMemo(
    // An agent added to a computer is not counted on its own: its computer is
    // listed, and the sidebar badge counts the same rows.
    () => currentAgents.filter((agent) => !agent.attachment && needsOwnerAttention(agent)),
    [currentAgents],
  );
  const visible = useMemo(
    () => (attentionOnly ? attention : agents),
    [agents, attention, attentionOnly],
  );
  const sections = useMemo(() => fleetSections(visible, query), [visible, query]);
  const duplicates = useMemo(() => duplicateFleetNames(agents), [agents]);
  const recent = useMemo(() => inRecentOrder(agents, recents), [agents, recents]);
  const isStale = useCallback((agent: UnifiedAgent) => Boolean(staleSource(agent)), [staleSource]);
  const searching = query.trim().length > 0;
  // "Try next": agents the owner does not run yet, where the catalog view of
  // Launch is on. Each opens its page there.
  const tryNext = useMemo(() => {
    if (!isLaunchCatalogEnabled()) return [];
    const runtimeIds = currentAgents.flatMap((agent) =>
      agent.resourceKind === "computer" ? [] : agent.kind === "hermes" ? ["hermes"] : agent.agentType ? [agent.agentType] : []);
    return tryNextSuggestions(offeredAgentTiles({ selfHosted: isLocalAuthMode() }), runtimeIds);
  }, [currentAgents]);
  const empty = !loading && agents.length === 0 && !hermesError && !hivraError;

  /**
   * Opening the app at Home resumes the last resource you were in, on the
   * surface you left it on, but only while it is actually usable: resuming a
   * stopped computer, or one whose state could not be checked, would open a
   * dead end. Otherwise Home shows the list, led by "Pick up where you left
   * off", which follows the same rule.
   */
  const resume = useMemo(() => {
    const last = recents[0];
    if (!last) return null;
    const agent = currentAgents.find((candidate) => candidate.uid === last.uid);
    if (!agent || !isRunningState(agent.state)) return null;
    return { agent, href: visitHref(agent.uid, last.tab, fleetEntryHref(agent)) };
  }, [currentAgents, recents]);

  // Opening the app at Home resumes, once both inventory sources have
  // settled. Everywhere else the saved surface is offered, never followed.
  useLayoutEffect(() => {
    if (!appOpen || requested || attentionRequested || loading || !resume) return;
    router.replace(resume.href);
  }, [appOpen, requested, attentionRequested, loading, resume, router]);


  // Opening the app at Home is a doorway to the working surface: do not paint
  // the list while inventory loads or while the resume navigation is pending.
  if (appOpen && !requested && !attentionRequested && (loading || resume)) {
    return <div className={styles.opening} role="status">
      <span>{resume && !loading ? `Opening ${resume.agent.name}…` : "Loading your agents and computers…"}</span>
      <Link href="/dashboard?runtimes=1">Choose another agent or computer</Link>
    </div>;
  }


  return (
    <div className={styles.home}>
      {empty && !attentionOnly ? <FirstRunCard /> : (
        <>
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <p className={styles.eyebrow}>Your workspace</p>
            <h1 className={styles.title}>{attentionOnly ? "Needs your attention" : "Where will you work?"}</h1>
            <p className="mt-1 text-[13px] leading-[1.5] text-[var(--text-muted)]">
              {attentionOnly ? "Each one says what is wrong and what to do about it." : "Open an agent to start working, or go straight to your desktop."}
            </p>
          </div>
          <label className="flex min-h-[44px] min-w-[200px] flex-1 items-center gap-2 rounded-[10px] border border-[var(--hg-stroke)] bg-[var(--hg-glass)] px-3 transition-colors focus-within:border-[var(--hg-stroke-strong)] focus-within:bg-[var(--hg-fill-1)] sm:max-w-[280px]">
            <Search
              aria-hidden="true"
              size={13}
              className="shrink-0 text-[var(--text-muted)]"
            />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search agents and computers"
              placeholder="Find an agent or computer"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="search"
              className="w-full bg-transparent py-1 text-[13px] text-[var(--hg-text)] outline-none placeholder:text-[var(--text-muted)]"
            />
          </label>
        </header>

        </>
      )}

      {/* Day-one guide: after a first launch, for two weeks. It decides for
          itself whether to show. */}
      {!loading && !empty && !attentionOnly && !searching ? <OnboardingChecklist instances={[]} includeHivra /> : null}

      {/* Where you were, first: one click back into the resource and surface
          you left, and the others you used recently. Hidden while searching
          or filtering, where the list below is the answer. */}
      {!loading && !attentionOnly && !searching ? (
        <HomeContinue entries={recent} isStale={isStale} now={recentView?.now ?? 0} />
      ) : null}

      {/* A count of anything broken, a single click into the filtered list.
          It renders nothing at all when there is nothing to say. */}
      {!loading && !attentionOnly && attention.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <button
            type="button"
            onClick={() => {
              setQuery("");
              // Filtering to the broken ones is the useful action here; a
              // count alone would just be a statistic.
              setAttentionOnly(true);
            }}
            className="flex min-h-[32px] pointer-coarse:min-h-[44px] items-center gap-1.5 border border-[color:var(--yellow)]/40 px-2.5 text-[12px] font-medium text-[var(--yellow)] outline-none transition-colors hover:border-[color:var(--yellow)] focus-visible:ring-2 focus-visible:ring-[var(--hivra-red)] focus-visible:ring-offset-1"
          >
            <AlertTriangle aria-hidden="true" size={13} />
            {attention.length} needs attention
          </button>
        </div>
      ) : null}

      {/* One message, whichever list failed: how Hivra stores an agent is
          not something the owner should have to know (FTUE-03). */}
      {hermesError || hivraError || attachedError ? (
        <SourceFailure onRetry={() => {
          if (hermesError) void retryHermes();
          if (hivraError || attachedError) void retryHivra();
        }} />
      ) : null}

      {/* The attention filter must be escapable — a view you cannot leave is
          worse than no filter. */}
      {attentionOnly ? (
        <button
          type="button"
          onClick={() => setAttentionOnly(false)}
          className="mono inline-flex min-h-[28px] pointer-coarse:min-h-[44px] w-fit items-center gap-1.5 pointer-coarse:-ml-2 pointer-coarse:px-2 text-[11px] font-semibold text-[var(--text-muted)] outline-none hover:text-[var(--ink-black)] focus-visible:ring-2 focus-visible:ring-[var(--hivra-red)] focus-visible:ring-offset-1"
        >
          <X aria-hidden="true" size={12} />
          Show all agents and computers
        </button>
      ) : null}

      {loading ? (
        <p className="text-[13px] text-[var(--text-muted)]">Loading your agents and computers…</p>
      ) : empty && !attentionOnly ? null : sections.length === 0 ? (
        <p className="text-[13px] text-[var(--text-muted)]">
          {searching
            ? "Nothing matches that search."
            : attentionOnly
              ? hermesError || hivraError ? "Attention could not be checked for every resource. Retry the unavailable source above." : "Nothing needs you right now. Everything is running as it should."
              : hermesError || hivraError ? "Your workspace could not be loaded. Retry the unavailable source above." : "No agents or computers yet. Launch one to get started."}
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {sections.map((section) => (
            <section key={section.key} className="mb-6 last:mb-0">
              <h2 className="mono mb-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--text-muted)]">
                {section.label}
              </h2>
              <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {section.items.map((agent) => (
                  <li key={agent.uid} className="min-w-0">
                    <FleetEntry agent={agent} duplicate={duplicates.has(agent.name)} stale={Boolean(staleSource(agent))}
                      showResolution={attentionOnly && !agent.attachment && needsOwnerAttention(agent)} onResolved={() => void retryHivra()} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {tryNext.length > 0 && !searching && !attentionOnly ? (
            <section className="mb-6 last:mb-0" aria-labelledby="home-try-next-heading">
              <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <h2 id="home-try-next-heading" className="mono text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--text-muted)]">
                  Try next
                </h2>
                <Link
                  href="/dashboard/launch?start=1"
                  className="mono inline-flex min-h-[28px] pointer-coarse:min-h-[44px] items-center text-[11px] font-semibold text-[var(--text-muted)] outline-none hover:text-[var(--ink-black)] focus-visible:ring-2 focus-visible:ring-[var(--hivra-red)] focus-visible:ring-offset-1"
                >
                  See everything you can launch
                </Link>
              </div>
              <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {tryNext.map(({ item, because }) => {
                  const Icon = item.icon ?? Bot;
                  const job = primaryCatalogJob(item.id);
                  return (
                    <li key={item.id} className="min-w-0">
                      <Link
                        href={`/dashboard/launch?start=1&about=${item.id}`}
                        className="group flex min-h-[96px] min-w-0 items-center gap-3 border border-[var(--etched-border)] bg-[var(--bg-surface)] px-4 py-4 outline-none transition-colors hover:border-[var(--hivra-red-line)] hover:bg-[var(--bg-elevated)] focus-visible:ring-2 focus-visible:ring-[var(--hivra-red)] focus-visible:ring-offset-1"
                      >
                        <span className={styles.resourceIcon} aria-hidden="true"><Icon size={21} /></span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px] font-medium leading-[1.4]">{item.name}</span>
                          <span className="mono block truncate text-[11px] leading-[1.35] text-[var(--text-muted)]">
                            {[job?.label, because ? `Because you run ${because}` : null].filter(Boolean).join(" · ")}
                          </span>
                          <span className="mt-3 block text-[12px] font-medium text-[var(--text-secondary)] group-hover:text-[var(--ink-black)]">
                            See what it does <span aria-hidden="true">→</span>
                          </span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
        </div>
      )}

      {!empty && <footer className="shrink-0 border-t border-[var(--etched-border)] pt-3">
        <Link
          href="/dashboard/launch"
          className="mono inline-flex min-h-[32px] pointer-coarse:min-h-[44px] items-center gap-2 text-[12px] font-semibold text-[var(--text-muted)] outline-none hover:text-[var(--ink-black)] focus-visible:ring-2 focus-visible:ring-[var(--hivra-red)] focus-visible:ring-offset-1"
        >
          <Plus aria-hidden="true" size={13} />
          Launch an agent or computer
        </Link>
      </footer>}
    </div>
  );
}

function FleetEntry({
  agent,
  duplicate,
  stale,
  showResolution = false,
  onResolved,
}: {
  agent: UnifiedAgent;
  duplicate: boolean;
  stale: boolean;
  showResolution?: boolean;
  onResolved?: () => void;
}) {
  const card = (
    <Link
      href={fleetEntryHref(agent)}
      className="group flex min-h-[96px] min-w-0 items-center gap-3 border border-[var(--etched-border)] bg-[var(--bg-surface)] px-4 py-4 outline-none transition-colors hover:border-[var(--hivra-red-line)] hover:bg-[var(--bg-elevated)] focus-visible:ring-2 focus-visible:ring-[var(--hivra-red)] focus-visible:ring-offset-1"
    >
      <span className={styles.resourceIcon} aria-hidden="true">{agent.resourceKind === "computer" ? <Monitor size={21} /> : <Bot size={21} />}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium leading-[1.4]">
          {agent.emoji ? `${agent.emoji} ` : ""}
          {agent.name}
          {duplicate ? (
            <span className="ml-1.5 text-[11px] font-normal text-[var(--text-muted)]">
              #{agent.id.slice(-4)}
            </span>
          ) : null}
        </span>
        <span className="mono block truncate text-[11px] leading-[1.35] text-[var(--text-muted)]">
          {agent.typeLabel} · <StatusText value={stale ? `Last known: ${unifiedStateLabel(agent.state)}` : agent.attention ? attentionLabel(agent.attention) : unifiedStateLabel(agent.state)} />
        </span>
        {/* The linked pair: an agent and the computer it runs on (ATT-11). */}
        {agent.computerPair ? (
          <span data-testid="fleet-computer-pair" className="mt-1 flex min-w-0 items-start gap-1.5 text-[11.5px] leading-[1.35] text-[var(--text-secondary)]">
            <Link2 aria-hidden="true" size={11} className="mt-[2px] shrink-0 text-[var(--text-muted)]" />
            {/* Wraps rather than truncates: the size is the part that matters. */}
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {[agent.computerPair.relation, agentComputerPairDetail(agent.computerPair)].filter(Boolean).join(" · ")}
            </span>
          </span>
        ) : null}
        <span className="mt-3 block text-[12px] font-medium text-[var(--text-secondary)] group-hover:text-[var(--ink-black)]">
          {stale ? "View details" : agent.attention === "approval" || agent.attention === "clarify" ? "Open to respond" : !isRunningState(agent.state) ? "View details" : fleetEntryOpenLabel(agent)} <span aria-hidden="true">→</span>
        </span>
      </span>
    </Link>
  );
  if (!showResolution || stale) return card;
  return (
    <div className="flex min-w-0 flex-col">
      {card}
      <AttentionResolution agent={agent} onResolved={onResolved} />
    </div>
  );
}

/** What is wrong with a row that needs the owner, and the one action that fixes it. */
function AttentionResolution({ agent, onResolved }: { agent: UnifiedAgent; onResolved?: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<"remove" | "retry" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const reason = agent.failureReason || attentionFallbackReason(agent.attention);
  const failed = async (kind: "remove" | "retry", action: () => Promise<void>, fallback: string) => {
    setBusy(kind);
    setMessage(null);
    try {
      await action();
      onResolved?.();
    } catch (error) {
      setMessage(error instanceof Error && error.message ? error.message : fallback);
      setBusy(null);
    }
  };
  const button = "mono inline-flex min-h-[32px] pointer-coarse:min-h-[44px] items-center border border-[var(--etched-border)] px-3 text-[12px] font-semibold text-[var(--ink-black)] outline-none hover:border-[var(--hivra-red-line)] focus-visible:ring-2 focus-visible:ring-[var(--hivra-red)] disabled:opacity-60";
  // What the agent is waiting on, answered right here (approvals) or opened in its chat (questions).
  if (agent.prompt && (agent.attention === "approval" || agent.attention === "clarify")) {
    return (
      <div data-testid="attention-resolution" className="flex flex-col gap-2 border border-t-0 border-[var(--etched-border)] bg-[var(--bg-surface)] px-4 py-3">
        <InboxAnswer agentId={agent.id} agentName={agent.name} chatHref={fleetEntryHref(agent)} prompt={agent.prompt}
          onAnswered={() => window.setTimeout(() => onResolved?.(), 6000)} />
      </div>
    );
  }
  return (
    <div data-testid="attention-resolution" className="flex flex-col gap-2 border border-t-0 border-[var(--etched-border)] bg-[var(--bg-surface)] px-4 py-3">
      <p className="text-[12.5px] leading-[1.45] text-[var(--text-secondary)]">{reason}</p>
      {agent.attention === "approval" || agent.attention === "clarify" ? null : agent.missingOnHost ? (
        confirming ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-[var(--text-muted)]">This removes it from Hivra. It can&apos;t be undone.</span>
            <button type="button" className={button} disabled={busy !== null} onClick={() => setConfirming(false)}>Cancel</button>
            <button type="button" className={button} disabled={busy !== null}
              onClick={() => void failed("remove", () => deleteAgent(agent.id, { recordOnly: true }), "Hivra could not remove it. Nothing was changed.")}>
              {busy === "remove" ? "Removing…" : "Remove from Hivra"}
            </button>
          </div>
        ) : (
          <div><button type="button" className={button} onClick={() => setConfirming(true)}>Remove</button></div>
        )
      ) : agent.kind === "hivra" ? (
        <div>
          {agent.canTryAgain ? (
            <button type="button" className={button} disabled={busy !== null}
              onClick={() => void failed("retry", () => startAgent(agent.id).then(() => undefined), "Hivra could not try again. Nothing was changed.")}>
              {busy === "retry" ? "Trying again…" : "Try again"}
            </button>
          ) : (
            <Link href={relaunchHref(agent)} className={button}>Launch again</Link>
          )}
        </div>
      ) : null}
      {message ? <p role="alert" className="text-[12px] text-[var(--hg-bad)]">{message}</p> : null}
    </div>
  );
}

function SourceFailure({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border border-[color:var(--yellow)]/40 bg-[var(--bg-elevated)] px-3 py-2">
      <p className="text-[12px] leading-[1.4] text-[var(--yellow)]">
        Some agents and computers couldn&apos;t be loaded. The rest are listed.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mono inline-flex min-h-[28px] pointer-coarse:min-h-[44px] items-center gap-1.5 pointer-coarse:px-2 text-[11px] font-semibold text-[var(--yellow)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--hivra-red)] focus-visible:ring-offset-1"
      >
        <RotateCcw aria-hidden="true" size={12} />
        Retry
      </button>
    </div>
  );
}
