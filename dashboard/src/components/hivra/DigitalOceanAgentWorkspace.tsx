"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CalendarClock, KeyRound, Loader2, Unlink } from "lucide-react";

import { ManagedSessionChat } from "@/components/hivra/ManagedSessionChat";
import { ManagedSessionFiles } from "@/components/hivra/ManagedSessionFiles";
import {
  forgetManagedSession,
  getManagedSessionWithExpiry,
  isManagedSessionCredentialProblem,
  type ManagedSessionApiError,
} from "@/lib/hivra/managed-session-client";
import type { ManagedSessionDto } from "@/lib/hivra/managed-session-contracts";
import type { CredentialExpiryDto } from "@/lib/infrastructure/contracts";
import { formatExpiryDate, relativeDays, tokenExpiryState } from "@/lib/infrastructure/token-expiry";

import chatStyles from "./ManagedSessionChat.module.css";
import styles from "./ManagedSessionWorkspace.module.css";

type View = "chat" | "files";

function replaceTokenHref(connectionId: string | null): string {
  return connectionId
    ? `/dashboard/infrastructure?${new URLSearchParams({ replaceToken: connectionId })}`
    : "/dashboard/infrastructure";
}

/**
 * Shown when Hivra's saved DigitalOcean token can no longer manage this agent.
 * Replacing the token keeps everything; forgetting releases the agent in Hivra
 * only and says plainly that the session may keep running at DigitalOcean.
 */
function CredentialRecovery({
  session,
  problem,
  onForgotten,
}: {
  session: ManagedSessionDto;
  problem: ManagedSessionApiError;
  onForgotten: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function forget() {
    setForgetting(true);
    setError(null);
    try {
      const next = await forgetManagedSession(session.agentId);
      if (next.status === "deleted") onForgotten();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `${session.name} was not removed.`);
    } finally {
      setForgetting(false);
    }
  }

  return (
    <div className={`${styles.banner} ${styles.bannerError}`} role="alert">
      <div className={styles.bannerTitle}>
        <AlertTriangle size={15} aria-hidden /> Hivra can&apos;t reach {session.name}&apos;s DigitalOcean session.
      </div>
      <span>{problem.message} Replace the token with a new one from the same DigitalOcean team; the agent and its conversation are kept.</span>
      {confirming ? (
        <span>
          <strong>Forget {session.name} in Hivra?</strong> This removes it from Hivra only. It won&apos;t delete the session at
          DigitalOcean{session.sessionId ? ` (${session.sessionId})` : ""}. If that session still exists, delete it in the
          DigitalOcean control panel so it stops billing.
        </span>
      ) : null}
      {error ? <span role="status">{error}</span> : null}
      <div className={styles.bannerActions}>
        <Link className={chatStyles.primaryButton} href={replaceTokenHref(session.connectionId)}>
          <KeyRound size={12} aria-hidden /> Replace token
        </Link>
        {confirming ? (
          <>
            <button type="button" className={chatStyles.dangerButton} onClick={() => void forget()} disabled={forgetting}>
              {forgetting ? <Loader2 size={12} className={chatStyles.spin} aria-hidden /> : <Unlink size={12} aria-hidden />} Forget in Hivra
            </button>
            <button type="button" className={chatStyles.ghostButton} onClick={() => setConfirming(false)} disabled={forgetting}>Keep</button>
          </>
        ) : (
          <button type="button" className={chatStyles.ghostButton} onClick={() => setConfirming(true)}>
            <Unlink size={12} aria-hidden /> Forget this agent in Hivra
          </button>
        )}
      </div>
    </div>
  );
}

function ExpiryReminder({ session, expiry }: { session: ManagedSessionDto; expiry: CredentialExpiryDto | null }) {
  const state = tokenExpiryState(expiry);
  if (state.kind !== "soon" && state.kind !== "expired") return null;
  return (
    <div className={styles.banner} role="status">
      <div className={styles.bannerTitle}>
        <CalendarClock size={15} aria-hidden />
        {state.kind === "soon"
          ? `The DigitalOcean token for ${session.name} expires ${relativeDays(state.days)} (${formatExpiryDate(state.expiresOn)}).`
          : `The DigitalOcean token for ${session.name} was due to expire on ${formatExpiryDate(state.expiresOn)}.`}
      </div>
      <span>That is the date you entered when connecting. Replace the token so this agent keeps working.</span>
      <div className={styles.bannerActions}>
        <Link className={chatStyles.ghostButton} href={replaceTokenHref(session.connectionId)}>
          <KeyRound size={12} aria-hidden /> Replace token
        </Link>
      </div>
    </div>
  );
}

/** Agent page body for a DigitalOcean Managed Agents session. */
export function DigitalOceanAgentWorkspace({ agentId, onDeleted }: { agentId: string; onDeleted: () => void }) {
  const [session, setSession] = useState<ManagedSessionDto | null>(null);
  const [expiry, setExpiry] = useState<CredentialExpiryDto | null>(null);
  const [problem, setProblem] = useState<ManagedSessionApiError | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("chat");
  const onDeletedRef = useRef(onDeleted);
  useEffect(() => { onDeletedRef.current = onDeleted; }, [onDeleted]);

  useEffect(() => {
    const controller = new AbortController();
    // Reconcile once on open so the page shows DigitalOcean's current state,
    // falling back to Hivra's last observation if DigitalOcean is unreachable.
    getManagedSessionWithExpiry(agentId, { reconcile: true, signal: controller.signal })
      .catch((cause: unknown) => {
        if (isManagedSessionCredentialProblem(cause)) setProblem(cause);
        return getManagedSessionWithExpiry(agentId, { signal: controller.signal });
      })
      .then((next) => {
        if (next.session.status === "deleted") onDeletedRef.current();
        else {
          setSession(next.session);
          setExpiry(next.credentialExpiry);
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "This agent could not be loaded.");
      });
    return () => controller.abort();
  }, [agentId]);

  const reportProblem = useCallback((cause: ManagedSessionApiError) => setProblem(cause), []);

  if (error) {
    return (
      <div role="alert" style={{ padding: 24, display: "flex", gap: 8, alignItems: "center", color: "var(--text-secondary)" }}>
        <AlertTriangle size={16} aria-hidden /> {error}
      </div>
    );
  }
  if (!session) {
    return (
      <div role="status" style={{ padding: 24, display: "flex", gap: 8, alignItems: "center", color: "var(--text-muted)" }}>
        <Loader2 size={16} aria-hidden /> Checking the DigitalOcean session…
      </div>
    );
  }
  return (
    <div style={{ height: "100%", minHeight: "calc(100dvh - 64px)", display: "flex", flexDirection: "column" }}>
      <div className={styles.tabs} role="tablist" aria-label={`${session.name} views`}>
        <button type="button" role="tab" aria-selected={view === "chat"} className={styles.tab} onClick={() => setView("chat")}>Chat</button>
        <button type="button" role="tab" aria-selected={view === "files"} className={styles.tab} onClick={() => setView("files")}>Files</button>
      </div>
      {problem ? (
        <CredentialRecovery session={session} problem={problem} onForgotten={() => onDeletedRef.current()} />
      ) : (
        <ExpiryReminder session={session} expiry={expiry} />
      )}
      <div style={{ flex: 1, minHeight: 0, display: view === "chat" ? "flex" : "none", flexDirection: "column" }}>
        <ManagedSessionChat initialSession={session} onDeleted={() => onDeletedRef.current()} onCredentialProblem={reportProblem} />
      </div>
      {view === "files" ? (
        <ManagedSessionFiles session={session} onSessionChange={setSession} onCredentialProblem={reportProblem} />
      ) : null}
    </div>
  );
}
