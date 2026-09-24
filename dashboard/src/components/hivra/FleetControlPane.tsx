"use client";

import { AlertTriangle, Bot, Monitor, Clock, Plus, RotateCcw, Search, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLayoutEffect, useMemo, useState } from "react";

import { useWorkspaceAgents } from "@/components/workspace/useWorkspaceAgents";
import {
  duplicateFleetNames,
  fleetEntryHref,
  fleetEntryOpenLabel,
  fleetSections,
} from "@/lib/hivra/fleet-sections";
import { attentionLabel } from "@/lib/hivra/resource-attention";
import styles from "./HomeWorkspace.module.css";
import { surfaceTab } from "@/lib/workspace/runtime-selection";
import { restoreWorkspaceSelection } from "@/lib/workspace/workspace-persistence";
import { unifiedStateLabel, type UnifiedAgent } from "@/lib/hivra/unified-agent";

/** Home resumes the last available working surface. The explicit list stays put. */
export function FleetControlPane({ requested = false, attentionRequested = false }: { requested?: boolean; attentionRequested?: boolean }) {
  const router = useRouter();
  const { agents, loading, hermesError, hivraError, retryHermes, retryHivra } =
    useWorkspaceAgents();
  const [query, setQuery] = useState("");
  // Navigation validates this optional browser preference against the loaded fleet.
  const [lastSelection] = useState(() =>
    typeof window === "undefined" ? null : restoreWorkspaceSelection(),
  );
  // Set by the "needs attention" button: narrows the list to the broken ones.
  const [attentionOnly, setAttentionOnly] = useState(attentionRequested);
  // Failed refreshes retain inventory for browsing, but cannot validate attention or resumption.
  const currentAgents = useMemo(
    () => agents.filter((agent) => !(agent.kind === "hermes" ? hermesError : hivraError)),
    [agents, hermesError, hivraError],
  );
  const attention = useMemo(
    () => currentAgents.filter((agent) => (agent.attention || agent.state === "error")),
    [currentAgents],
  );
  const visible = useMemo(
    () => (attentionOnly ? attention : agents),
    [agents, attention, attentionOnly],
  );
  const sections = useMemo(() => fleetSections(visible, query), [visible, query]);
  const duplicates = useMemo(() => duplicateFleetNames(agents), [agents]);
  const searching = query.trim().length > 0;
  const empty = !loading && agents.length === 0 && !hermesError && !hivraError;

  /**
   * Two things worth surfacing above the list, both derived from the fleet we
   * already hold — no second fetch, no separate page.
   *
   * The pane lists everything with its status, so neither of these is the only
   * way to see something. What they add is *priority*: a resource that needs
   * attention is easy to miss in a flat list, and the one you were last in is
   * the one you most likely want back.
   */
  const resume = useMemo(() => {
    if (!lastSelection) return null;
    const agent = currentAgents.find((candidate) => candidate.uid === lastSelection.uid);
    // Only offer it while it is actually usable — offering a stopped box as
    // "continue" would send the user into a dead end.
    if (!agent || agent.state !== "running") return null;
    // Resume the surface too, not just the runtime: coming back to a box you
    // left on its terminal should not silently reopen its chat. Naming a tab
    // the resource cannot show is safe — the canonical route reconciles it.
    return { agent, href: `${fleetEntryHref(agent).split("?")[0]}?tab=${surfaceTab(lastSelection.surface)}` };
  }, [currentAgents, lastSelection]);

  // Resume only after both inventory sources have settled. Explicit browsing
  // stays on the list even when a saved working surface is available.
  useLayoutEffect(() => {
    if (requested || attentionRequested || loading || !resume) return;
    router.replace(resume.href);
  }, [requested, attentionRequested, loading, resume, router]);


  // Home is a doorway to the working surface. Do not paint the chooser while
  // inventory is loading or while its validated resume navigation is pending.
  if (!requested && !attentionRequested && (loading || resume)) {
    return <div className={styles.opening} role="status">
      <span>{resume && !loading ? `Opening ${resume.agent.name}…` : "Loading your agents and computers…"}</span>
      <Link href="/dashboard?runtimes=1">Choose another agent or computer</Link>
    </div>;
  }


  return (
    <div className={styles.home}>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className={styles.eyebrow}>Your workspace</p>
          <h1 className={styles.title}>{attentionOnly ? "Needs your attention" : "Where will you work?"}</h1>
          <p className="mt-1 text-[13px] leading-[1.5] text-[var(--text-muted)]">
            {attentionOnly ? "Open an item to respond or check what went wrong." : empty ? "Choose an agent to work with, or a computer of your own." : "Open an agent to start working, or go straight to your desktop."}
          </p>
        </div>
        {!empty && <label className="flex min-h-[44px] min-w-[200px] flex-1 items-center gap-2 border border-[var(--etched-border)] px-2 focus-within:border-[var(--hivra-red-line)] sm:max-w-[280px]">
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
            className="mono w-full bg-transparent py-1 text-[12px] text-[var(--ink-black)] outline-none placeholder:text-[var(--text-muted)]"
          />
        </label>}
      </header>

      {empty && !attentionOnly ? (
        <section className={styles.start} aria-label="Create your first workspace">
          <Link href="/dashboard/launch?kind=agent&start=1" className={styles.startChoice}>
            <Bot size={24} aria-hidden /><h2>Start with an agent</h2><p>Choose the agent you want to work with.</p><span>Launch agent <span aria-hidden>→</span></span>
          </Link>
          <Link href="/dashboard/launch?kind=computer&start=1" className={styles.startChoice}>
            <Monitor size={24} aria-hidden /><h2>Start with a computer</h2><p>Open a desktop of your own.</p><span>Launch computer <span aria-hidden>→</span></span>
          </Link>
          <p className={styles.startAlt}>
            Already have a cloud account or a server? <Link href="/dashboard/infrastructure">Bring your own cloud or server <span aria-hidden>→</span></Link>
          </p>
        </section>
      ) : null}

      {/* One compact strip, not a dashboard: a resume link and a count of
          anything broken, each of which is a single click into the thing it
          names. It renders nothing at all when there is nothing to say. */}
      {!loading && !attentionOnly && (resume || attention.length > 0) ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {resume ? (
            <Link
              href={resume.href}
              className="flex min-h-[32px] pointer-coarse:min-h-[44px] min-w-0 items-center gap-2 border border-[var(--etched-border)] px-2.5 text-[12px] text-[var(--text-secondary)] outline-none transition-colors hover:border-[var(--hivra-red-line)] hover:text-[var(--ink-black)] focus-visible:ring-2 focus-visible:ring-[var(--hivra-red)] focus-visible:ring-offset-1"
            >
              <Clock aria-hidden="true" size={13} className="shrink-0 text-[var(--text-muted)]" />
              <span className="shrink-0 text-[var(--text-muted)]">Continue</span>
              <span className="truncate font-medium text-[var(--ink-black)]">
                {resume.agent.name}
              </span>
            </Link>
          ) : null}
          {attention.length > 0 ? (
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
          ) : null}
        </div>
      ) : null}

      {hermesError ? (
        <SourceFailure source="Hermes" onRetry={() => void retryHermes()} />
      ) : null}
      {hivraError ? (
        <SourceFailure source="Hivra" onRetry={() => void retryHivra()} />
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
              ? hermesError || hivraError ? "Attention could not be checked for every resource. Retry the unavailable source above." : "Nothing needs attention."
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
                    <FleetEntry agent={agent} duplicate={duplicates.has(agent.name)} stale={Boolean(agent.kind === "hermes" ? hermesError : hivraError)} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
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
}: {
  agent: UnifiedAgent;
  duplicate: boolean;
  stale: boolean;
}) {
  return (
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
          {agent.typeLabel} · {stale ? `Last known: ${unifiedStateLabel(agent.state)}` : agent.attention ? attentionLabel(agent.attention) : unifiedStateLabel(agent.state)}
        </span>
        <span className="mt-3 block text-[12px] font-medium text-[var(--text-secondary)] group-hover:text-[var(--ink-black)]">
          {stale ? "View details" : agent.attention === "approval" || agent.attention === "clarify" ? "Open to respond" : agent.state !== "running" ? "View details" : fleetEntryOpenLabel(agent)} <span aria-hidden="true">→</span>
        </span>
      </span>
    </Link>
  );
}

function SourceFailure({
  source,
  onRetry,
}: {
  source: "Hermes" | "Hivra";
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border border-[color:var(--yellow)]/40 bg-[var(--bg-elevated)] px-3 py-2">
      <p className="text-[12px] leading-[1.4] text-[var(--yellow)]">
        {source} runtimes are unavailable. Your others are still listed.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mono inline-flex min-h-[28px] pointer-coarse:min-h-[44px] items-center gap-1.5 pointer-coarse:px-2 text-[11px] font-semibold text-[var(--yellow)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--hivra-red)] focus-visible:ring-offset-1"
      >
        <RotateCcw aria-hidden="true" size={12} />
        Retry {source}
      </button>
    </div>
  );
}
