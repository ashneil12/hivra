"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CalendarClock, Info, KeyRound, Loader2, Pause, Play, Unlink } from "lucide-react";

import { ComputerContractPanel, type ComputerContractPanelAgent } from "@/components/hivra/ComputerContractPanel";
import { ManagedSessionChat } from "@/components/hivra/ManagedSessionChat";
import { ManagedSessionFiles } from "@/components/hivra/ManagedSessionFiles";
import { ManageLayout, ManageNotice, ManagePanel } from "@/components/hivra/ManageLayout";
import { useManageSection } from "@/components/hivra/useManageSection";
import { ManageHeader } from "@/components/hivra/manage/ManageHeader";
import { ManageDangerZone } from "@/components/hivra/manage/ManageDangerZone";
import { ManageDetails, ManageFixedSize, ManageHistory, ManageNotAvailable } from "@/components/hivra/manage/ManageAdvancedParts";
import { manageButtonGhost, manageCard, manageError, manageLabel, manageMuted, manageValue } from "@/components/hivra/manage/manage-styles";
import type { ComputerContractStatus } from "@/lib/agent-computers/computer-contract-status";
import type { ComputerContractAction } from "@/lib/hivra/computer-contract-client";
import { renameAgent } from "@/lib/hivra/agent-api";
import type { ManageCapabilities, ManageSectionId } from "@/lib/hivra/manage-sections";
import {
  changeManagedSession,
  forgetManagedSession,
  getManagedSessionWithExpiry,
  isManagedSessionCredentialProblem,
  type ManagedSessionApiError,
} from "@/lib/hivra/managed-session-client";
import {
  DIGITALOCEAN_HARNESS_LABELS,
  digitalOceanSandboxResources,
  type ManagedSessionDto,
} from "@/lib/hivra/managed-session-contracts";
import type { CredentialExpiryDto } from "@/lib/infrastructure/contracts";
import { formatExpiryDate, relativeDays, tokenExpiryState } from "@/lib/infrastructure/token-expiry";

import chatStyles from "./ManagedSessionChat.module.css";
import styles from "./ManagedSessionWorkspace.module.css";

type View = "chat" | "files" | "manage";

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

/** What the chat says about a setup note that hasn't gone out, or null. */
export function setupNoteReminder(status: ComputerContractStatus | null, name: string): { revision: number; title: string; body: string } | null {
  if (status?.kind === "not_started" && status.channel === "do-setup-message") {
    return { revision: 0, title: `Hivra hasn't sent ${name} its setup note.`, body: `It tells ${name} where it runs, its /workspace and how you see its work. Review it and send it from Manage.` };
  }
  if (status?.kind !== "tracked" || status.channel !== "do-setup-message" || status.state !== "pending") return null;
  if (status.lastError === "send_failed") {
    return { revision: status.revision, title: `Hivra's setup note didn't reach ${name}.`, body: "DigitalOcean didn't accept it. You can send it again from Manage." };
  }
  if (status.lastDelivered) {
    return { revision: status.revision, title: `What Hivra tells ${name} about its computer changed.`, body: "Send the update from Manage when you're ready. It adds one visible message to the chat." };
  }
  return { revision: status.revision, title: `Hivra hasn't sent ${name} its setup note.`, body: `It tells ${name} where it runs, its /workspace and how you see its work. Review it and send it from Manage.` };
}

const dismissKey = (agentId: string) => `hivra:do-setup-note-dismissed:${agentId}`;

function readDismissed(agentId: string): number | null {
  try {
    const value = window.localStorage.getItem(dismissKey(agentId));
    return value !== null && /^\d+$/.test(value) ? Number(value) : null;
  } catch {
    return null;
  }
}

/** The panel's view of this session, from what Hivra last observed of it. */
function contractAgentFor(session: ManagedSessionDto): ComputerContractPanelAgent {
  const resources = digitalOceanSandboxResources(session.size);
  return {
    id: session.agentId,
    name: session.name,
    status: session.status === "ready" ? "running" : session.status === "paused" ? "stopped" : session.status,
    deployment_mode: "self-managed",
    computer_substrate: "do-managed-session",
    cpu: resources?.cpu ?? null,
    ram: resources?.ram ?? null,
  };
}

const SESSION_STATUS_LABEL: Record<ManagedSessionDto["status"], string> = {
  ready: "Ready", paused: "Paused", provisioning: "Starting", deleting: "Deleting", deleted: "Deleted", error: "Needs attention",
};
const DO_FALLBACK_SECTIONS: ManageSectionId[] = ["overview", "resources", "advanced"];
type DoSlot = "header" | "power" | "danger";
const DO_SLOT_SECTION: Record<DoSlot, ManageSectionId | null> = { header: null, power: "overview", danger: "advanced" };

/**
 * Manage for a DigitalOcean session, on the same sections as every other
 * computer: Overview (status, Pause or Resume, and Hivra's setup note),
 * Resources (DigitalOcean fixes the size) and Advanced (details, history and
 * deleting it). The chat's own header keeps its Pause, Resume and Delete.
 */
function DigitalOceanManage({
  session,
  manage,
  onSessionChange,
  onDeleted,
  onContractStatus,
  onCredentialProblem,
}: {
  session: ManagedSessionDto;
  manage?: ManageCapabilities;
  onSessionChange: (session: ManagedSessionDto) => void;
  onDeleted: () => void;
  onContractStatus: (status: ComputerContractStatus, cause: "load" | ComputerContractAction) => void;
  onCredentialProblem: (error: ManagedSessionApiError) => void;
}) {
  const sections = manage?.sections ?? DO_FALLBACK_SECTIONS;
  const { selected, select } = useManageSection(sections, Boolean(manage));
  const [busy, setBusy] = useState<"pause" | "resume" | "delete" | "rename" | null>(null);
  const [error, setError] = useState<{ slot: DoSlot; message: string } | null>(null);
  const harness = DIGITALOCEAN_HARNESS_LABELS[session.harness];
  const resources = digitalOceanSandboxResources(session.size);
  const size = resources ? `${resources.cpu} CPU / ${resources.ram} GB` : session.size;
  const placement = manage?.placement.label ?? "My cloud · DigitalOcean";

  const lifecycle = async (action: "pause" | "resume" | "delete") => {
    setBusy(action);
    setError(null);
    try {
      const next = await changeManagedSession(session.agentId, action);
      onSessionChange(next);
      if (next.status === "deleted") onDeleted();
    } catch (cause) {
      if (isManagedSessionCredentialProblem(cause)) onCredentialProblem(cause);
      setError({ slot: action === "delete" ? "danger" : "power", message: cause instanceof Error ? cause.message : `The ${action} was not confirmed.` });
    } finally {
      setBusy(null);
    }
  };
  const rename = async (name: string) => {
    setBusy("rename");
    setError(null);
    try {
      await renameAgent(session.agentId, name);
      onSessionChange({ ...session, name });
    } catch (cause) {
      setError({ slot: "header", message: cause instanceof Error ? cause.message : "The name could not be changed." });
    } finally {
      setBusy(null);
    }
  };
  const errorFor = (slot: DoSlot) => error?.slot === slot ? <div role="alert" style={manageError}>{error.message}</div> : null;
  const errorSection = error ? DO_SLOT_SECTION[error.slot] : null;
  const details = manage?.details ?? [{ id: "hivra-id", label: "Hivra ID", value: session.agentId, copy: true }];

  return (
    <ManageLayout
      label="Agent settings"
      sections={sections.map((id) => ({ id }))}
      selected={selected}
      onSelect={select}
      notice={error && errorSection && errorSection !== selected
        ? <ManageNotice kind="alert" message={error.message} section={errorSection} onOpen={select} /> : null}
      header={
        <ManageHeader
          eyebrow="Agent settings"
          name={session.name}
          status={session.status}
          statusLabel={SESSION_STATUS_LABEL[session.status]}
          subtitle={`${harness.name} · ${placement}`}
          renaming={busy === "rename"}
          disabled={busy !== null}
          onRename={(name) => void rename(name)}
          error={errorFor("header")}
        />
      }
    >
      <ManagePanel id="overview" selected={selected}>
        <div style={{ display: "grid", gap: 20 }}>
          <div style={manageCard}>
            <div style={{ display: "grid", gap: 9 }}>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}><span className="mono" style={{ ...manageLabel, width: 104 }}>Agent</span><span style={manageValue}>{harness.name}</span></div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}><span className="mono" style={{ ...manageLabel, width: 104 }}>Size</span><span style={manageValue}>{size}</span></div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}><span className="mono" style={{ ...manageLabel, width: 104 }}>Where it runs</span><span style={manageValue}>{placement}</span></div>
            </div>
            {session.status === "ready" || session.status === "paused" ? (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {session.status === "paused" ? (
                  <button type="button" disabled={busy !== null} onClick={() => void lifecycle("resume")} style={manageButtonGhost}>
                    {busy === "resume" ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> : <Play size={13} />} Resume
                  </button>
                ) : (
                  <button type="button" disabled={busy !== null} onClick={() => void lifecycle("pause")} style={manageButtonGhost}>
                    {busy === "pause" ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> : <Pause size={13} />} Pause
                  </button>
                )}
              </div>
            ) : null}
            {errorFor("power")}
            <div style={{ ...manageMuted, fontSize: 11.5 }}>Pausing stops DigitalOcean running the session until you resume it or send a message. Your conversation and /workspace are kept.</div>
          </div>
          <ComputerContractPanel agent={contractAgentFor(session)} runtimeName={harness.name} onStatus={onContractStatus} />
        </div>
      </ManagePanel>
      <ManagePanel id="resources" selected={selected}>
        <ManageFixedSize size={size} reason={manage?.resize.cap.state === "unavailable" ? manage.resize.cap.reason : "DigitalOcean set this session's size when it was created, and it can't be changed."} />
      </ManagePanel>
      <ManagePanel id="advanced" selected={selected}>
        <div style={{ display: "grid", gap: 20 }}>
          <div style={manageCard}>
            <ManageDetails details={details} />
            {session.sessionId ? (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}><span className="mono" style={{ ...manageLabel, flex: "0 0 160px" }}>DigitalOcean session</span><span style={{ ...manageValue, overflowWrap: "anywhere" }}>{session.sessionId}</span></div>
            ) : null}
            {session.error ? <div style={{ ...manageMuted, overflowWrap: "anywhere" }}>Last error: {session.error}</div> : null}
          </div>
          <ManageHistory agentId={session.agentId} />
          <ManageNotAvailable items={manage?.notAvailable ?? []} />
          {session.status !== "deleted" ? (
            <ManageDangerZone
              name={session.name}
              title="Delete this agent"
              description="Deletes its DigitalOcean session and /workspace, and removes the agent from Hivra. This cannot be undone."
              busy={busy !== null || session.status === "deleting"}
              deleting={busy === "delete" || session.status === "deleting"}
              progress={session.status === "deleting" ? "Deleting in DigitalOcean…" : null}
              onConfirm={() => void lifecycle("delete")}
              error={errorFor("danger")}
            />
          ) : null}
        </div>
      </ManagePanel>
    </ManageLayout>
  );
}

/** Agent page body for a DigitalOcean Managed Agents session. */
export function DigitalOceanAgentWorkspace({
  agentId,
  onDeleted,
  firstTask,
  manage,
}: {
  agentId: string;
  onDeleted: () => void;
  /** The server's capability map for this session (sections, details, reasons). */
  manage?: ManageCapabilities;
  /** The task chosen at launch, offered back in the composer if it was never sent. */
  firstTask?: string | null;
}) {
  const [session, setSession] = useState<ManagedSessionDto | null>(null);
  const [expiry, setExpiry] = useState<CredentialExpiryDto | null>(null);
  const [problem, setProblem] = useState<ManagedSessionApiError | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("chat");
  const [contract, setContract] = useState<ComputerContractStatus | null>(null);
  // Per-viewer convenience only: "Not now" hides this revision's reminder.
  const [dismissed, setDismissed] = useState(() => ({ agentId, revision: readDismissed(agentId) }));
  if (dismissed.agentId !== agentId) setDismissed({ agentId, revision: readDismissed(agentId) });
  const [historyVersion, setHistoryVersion] = useState(0);
  const onDeletedRef = useRef(onDeleted);
  useEffect(() => { onDeletedRef.current = onDeleted; }, [onDeleted]);

  // A setup note sent from Manage is a new run: reload the conversation so it
  // shows as Hivra's card, not as a reply to nothing.
  const onContractStatus = useCallback((status: ComputerContractStatus, cause: "load" | ComputerContractAction) => {
    setContract(status);
    if (cause === "send" && status.kind === "tracked" && status.state === "sent") setHistoryVersion((value) => value + 1);
  }, []);
  const dismissReminder = useCallback((revision: number) => {
    setDismissed({ agentId, revision });
    try {
      window.localStorage.setItem(dismissKey(agentId), String(revision));
    } catch {
      // Hidden for this visit only.
    }
  }, [agentId]);

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
  const reminder = setupNoteReminder(contract, session.name);
  const showReminder = view === "chat" && !problem && reminder !== null && dismissed.revision !== reminder.revision
    && (session.status === "ready" || session.status === "paused");
  return (
    <div style={{ height: "100%", minHeight: "calc(100dvh - 64px)", display: "flex", flexDirection: "column" }}>
      <div className={styles.tabs} role="tablist" aria-label={`${session.name} views`}>
        <button type="button" role="tab" aria-selected={view === "chat"} className={styles.tab} onClick={() => setView("chat")}>Chat</button>
        <button type="button" role="tab" aria-selected={view === "files"} className={styles.tab} onClick={() => setView("files")}>Files</button>
        <button type="button" role="tab" aria-selected={view === "manage"} className={styles.tab} onClick={() => setView("manage")}>Manage</button>
      </div>
      {problem ? (
        <CredentialRecovery session={session} problem={problem} onForgotten={() => onDeletedRef.current()} />
      ) : (
        <ExpiryReminder session={session} expiry={expiry} />
      )}
      {showReminder && reminder ? (
        <div className={styles.banner} role="status">
          <div className={styles.bannerTitle}><Info size={15} aria-hidden /> {reminder.title}</div>
          <span>{reminder.body}</span>
          <div className={styles.bannerActions}>
            <button type="button" className={chatStyles.primaryButton} onClick={() => setView("manage")}>Review in Manage</button>
            <button type="button" className={chatStyles.ghostButton} onClick={() => dismissReminder(reminder.revision)}>Not now</button>
          </div>
        </div>
      ) : null}
      <div style={{ flex: 1, minHeight: 0, display: view === "chat" ? "flex" : "none", flexDirection: "column" }}>
        <ManagedSessionChat initialSession={session} session={session} onSessionChange={setSession}
          onDeleted={() => onDeletedRef.current()} onCredentialProblem={reportProblem}
          firstTask={firstTask} historyVersion={historyVersion} />
      </div>
      {view === "files" ? (
        <ManagedSessionFiles session={session} onSessionChange={setSession} onCredentialProblem={reportProblem} />
      ) : null}
      {/* Kept mounted so the chat's reminder and Manage share one status. */}
      <div className={styles.manage} hidden={view !== "manage"}>
        <DigitalOceanManage session={session} manage={manage} onSessionChange={setSession}
          onDeleted={() => onDeletedRef.current()} onContractStatus={onContractStatus} onCredentialProblem={reportProblem} />
      </div>
    </div>
  );
}
