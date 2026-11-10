"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Loader2, RefreshCw, Trash2 } from "lucide-react";
import { manageButtonDark, manageButtonGhost, manageCard, manageDisabled, manageError, manageMuted, manageSpin } from "./manage-styles";

// One place for "Hivra can't reach this computer". Several Manage cards read
// the computer or its host (usage, the agent's software, what the agent was
// told, the sign-in check). When one of them can't reach it, it reports here
// and says only a short muted line itself; Manage shows a single banner at
// the top instead of each card repeating its own error.

export const UNREACHABLE_CARD_LINE = "Unavailable while the computer can't be reached";

type Reachability = {
  unreachable: boolean;
  report: (source: string, unreachable: boolean) => void;
};

const ManageReachabilityContext = createContext<Reachability>({ unreachable: false, report: () => undefined });

export function ManageReachabilityProvider({ children }: { children: ReactNode }) {
  const [sources, setSources] = useState<ReadonlySet<string>>(() => new Set());
  const report = useCallback((source: string, unreachable: boolean) => {
    setSources((current) => {
      if (current.has(source) === unreachable) return current;
      const next = new Set(current);
      if (unreachable) next.add(source); else next.delete(source);
      return next;
    });
  }, []);
  const value = useMemo(() => ({ unreachable: sources.size > 0, report }), [sources, report]);
  return <ManageReachabilityContext.Provider value={value}>{children}</ManageReachabilityContext.Provider>;
}

/** True while any card has reported that the computer can't be reached. */
export function useManageUnreachable(): boolean {
  return useContext(ManageReachabilityContext).unreachable;
}

/** A card says whether it can currently reach the computer. Cleared when it goes away. */
export function useReportUnreachable(source: string, unreachable: boolean): void {
  const { report } = useContext(ManageReachabilityContext);
  useEffect(() => {
    report(source, unreachable);
    return () => report(source, false);
  }, [report, source, unreachable]);
}

/** Reports a signal Manage itself owns (the sign-in check), from inside the provider. */
export function ReportUnreachable({ source, when }: { source: string; when: boolean }) {
  useReportUnreachable(source, when);
  return null;
}

/** The banner, shown while a card has reported the computer unreachable or the host reports it gone. */
export function ManageReachabilityNotice(props: {
  missing: boolean;
  onRestart?: (() => void) | null;
  restarting?: boolean;
  restartDisabled?: boolean;
  onRemove?: (() => void) | null;
  removing?: boolean;
  removeError?: ReactNode;
}) {
  const unreachable = useManageUnreachable();
  const { missing, ...rest } = props;
  if (!missing && !unreachable) return null;
  return <ManageReachabilityBanner mode={missing ? "missing" : "unreachable"} {...rest} />;
}

/** The short line a card shows in place of its own "couldn't reach" error. */
export function UnreachableCardLine({ testId }: { testId?: string }) {
  return <div data-testid={testId} style={manageMuted}>{UNREACHABLE_CARD_LINE}</div>;
}

/**
 * The one banner at the top of Manage. "unreachable": the computer or its host
 * didn't answer, with Restart where it exists. "missing": the host says the
 * computer is gone, so the only way forward is removing its record.
 */
export function ManageReachabilityBanner({ mode, onRestart, restarting, restartDisabled, onRemove, removing, removeError }: {
  mode: "unreachable" | "missing";
  /** Present where this computer can be restarted right now. */
  onRestart?: (() => void) | null;
  restarting?: boolean;
  restartDisabled?: boolean;
  /** Present when the computer is gone from its host. */
  onRemove?: (() => void) | null;
  removing?: boolean;
  removeError?: ReactNode;
}) {
  const [confirming, setConfirming] = useState(false);
  const missing = mode === "missing";
  return (
    <section
      role={missing ? "alert" : "status"}
      aria-live={missing ? undefined : "polite"}
      data-testid="manage-reachability-banner"
      data-mode={mode}
      style={{ ...manageCard, gap: 10 }}
    >
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--hg-text)" }}>
          {missing ? "This computer no longer exists." : "Hivra can't reach this computer right now."}
        </div>
        <div style={{ ...manageMuted, marginTop: 3 }}>
          {missing
            ? "Its host no longer has it, so there is nothing left to start or stop. Remove it from Hivra to clear it from your list."
            : "It may be restarting, or its network may be down. Restarting usually brings it back."}
        </div>
      </div>
      {!missing && onRestart ? (
        <div>
          <button
            type="button"
            disabled={restartDisabled}
            onClick={onRestart}
            style={manageDisabled(manageButtonDark, Boolean(restartDisabled))}
          >
            {restarting ? <Loader2 size={14} style={manageSpin} aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />} Restart
          </button>
        </div>
      ) : null}
      {missing && onRemove ? (
        confirming ? (
          <div style={{ display: "grid", gap: 8 }}>
            <div style={manageMuted}>This removes the record from Hivra. It can&apos;t be undone.</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" disabled={removing} onClick={() => setConfirming(false)} style={manageDisabled(manageButtonGhost, Boolean(removing))}>Cancel</button>
              <button type="button" disabled={removing} onClick={onRemove} style={manageDisabled(manageButtonDark, Boolean(removing))}>
                {removing ? <Loader2 size={14} style={manageSpin} aria-hidden="true" /> : <Trash2 size={14} aria-hidden="true" />} Remove from Hivra
              </button>
            </div>
          </div>
        ) : (
          <div>
            <button type="button" onClick={() => setConfirming(true)} style={manageButtonDark}>
              <Trash2 size={14} aria-hidden="true" /> Remove from Hivra
            </button>
          </div>
        )
      ) : null}
      {removeError ? <div role="alert" style={manageError}>{removeError}</div> : null}
    </section>
  );
}
