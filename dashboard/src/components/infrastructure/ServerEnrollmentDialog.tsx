"use client";

import { AlertTriangle, ArrowRight, CheckCircle2, ExternalLink, KeyRound, Loader2, RefreshCw, SquareTerminal, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { InfrastructureApiError } from "@/lib/infrastructure/client";
import type { InfrastructureConnectionDto } from "@/lib/infrastructure/contracts";
import type {
  ServerEnrollmentDto,
  ServerEnrollmentIssueResult,
} from "@/lib/infrastructure/server-enrollment-contracts";
import {
  getServerEnrollment,
  issueServerEnrollment,
} from "@/lib/infrastructure/server-enrollment-client";

import styles from "./Infrastructure.module.css";
import enrollmentStyles from "./ServerEnrollment.module.css";
import { CopyButton } from "./CopyButton";
import { ServerEnrollmentCard, useNow } from "./ServerEnrollmentCard";
import { useInfrastructureDialog } from "./useInfrastructureDialog";

const POLL_MS = 2_000;

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function timeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

const REFUSAL_COPY: Record<NonNullable<ServerEnrollmentDto["lastRefusal"]>, string> = {
  ipv4_required: "it arrived over IPv6 only. Hosted Hivra reaches servers over IPv4 for now",
  private_address: "it came from a private network, which hosted Hivra can't reach",
  invalid_report: "it didn't match what this command expects",
};

/** What Hivra itself observed about an open command, without the clock.
 * Only this part sits in the live region, so a screen reader hears a change
 * of state, not a clock ticking every second. `since` starts the clock. */
export function waitingState(item: ServerEnrollmentDto): { text: string; since: string | null } {
  if (item.scriptFetches >= 20) return { text: "Your command reached its download limit. Get a new command.", since: null };
  if (item.lastRefusal && item.lastRefusedAt) {
    return {
      text: `Hivra refused a report for your command at ${timeOfDay(item.lastRefusedAt)}: ${REFUSAL_COPY[item.lastRefusal]}.`,
      since: null,
    };
  }
  if (item.lastFetchedAt) {
    return {
      text: `The setup script was downloaded with your command at ${timeOfDay(item.lastFetchedAt)}. Waiting for its report`,
      since: item.lastFetchedAt,
    };
  }
  return { text: "Waiting for your server… no contact yet", since: item.issuedAt };
}

/** The waiting line as it reads on screen: the state, then the clock. */
export function waitingLine(item: ServerEnrollmentDto, now: number): string {
  const { text, since } = waitingState(item);
  return since ? `${text} · ${clock(now - Date.parse(since))}` : text;
}

/** A command that can no longer be run, in its own words: cancelled, used
 * (Yes, from this panel or anywhere else) or expired. Never "expired" for a
 * command that ended another way. */
export function closedCommandLine(item: ServerEnrollmentDto): string {
  switch (item.phase) {
    case "cancelled":
      return `This command was cancelled${item.refusedReports >= 10 ? " after 10 refused reports" : ""}. Get a new command.`;
    case "confirmed":
      return item.outcome === "replaced_access"
        ? "This command was used, and your server's access was replaced. Close this panel to see it under Capacity."
        : "This command was used, and your server is connected. Close this panel to see it under Capacity.";
    case "rejected":
      return "This command was cancelled after No was chosen. Get a new command.";
    default:
      return "This command expired. Get a new command.";
  }
}

type State =
  | { kind: "issuing" }
  | { kind: "unavailable"; message: string }
  | { kind: "ready"; issued: ServerEnrollmentIssueResult; enrollment: ServerEnrollmentDto };

/**
 * My server, command first (redesign C7, slice 13). One command with Copy;
 * running it on the server creates a hivra user with Hivra's key and sudo,
 * after a question at the server's terminal, and reports the server's SSH
 * identity. Nothing is trusted until the owner answers "Is this your
 * server?" here. The one-time code lives only in this component's memory:
 * never in a link, the page URL or storage.
 */
export function ServerEnrollmentDialog({
  onClose,
  onUseSshDetails,
  onConnected,
  onAccessReplaced,
  onChanged,
  onDeclined,
  onConnectionsChanged,
  returnFocusRef,
}: {
  onClose: () => void;
  /** "Connect with SSH details instead (advanced)". */
  onUseSshDetails: () => void;
  /** Yes: a new connection; the page runs the normal inspection next. */
  onConnected: (connection: InfrastructureConnectionDto) => void;
  /** Replace: an existing connection's access changed; inspect it again. */
  onAccessReplaced: (connection: InfrastructureConnectionDto) => void;
  /** Something the page lists changed (a report, a cancellation). */
  onChanged: () => void;
  /** No was chosen here: the page keeps the answer (and its uninstall
   * command) listed until the owner dismisses it. */
  onDeclined?: (enrollment: ServerEnrollmentDto) => void;
  /** The command was used to connect a server (Yes here or anywhere else):
   * the page's list of connections is out of date. */
  onConnectionsChanged?: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const [state, setState] = useState<State>({ kind: "issuing" });
  const [scriptOpen, setScriptOpen] = useState(false);
  const [renewing, setRenewing] = useState(false);
  const [renewError, setRenewError] = useState<string | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const issuedOnce = useRef(false);
  const now = useNow();

  // Closing never cancels: the owner may have copied the command and be about
  // to paste it on the server. The Capacity page lists every open command,
  // with Cancel, until it is used or expires.
  const close = onClose;
  const dialogRef = useInfrastructureDialog({ onClose: close, initialFocusRef: closeButtonRef, returnFocusRef });

  const issue = useCallback(async (replaceEnrollmentId: string | null) => {
    try {
      const issued = await issueServerEnrollment(replaceEnrollmentId);
      setState({ kind: "ready", issued, enrollment: issued.enrollment });
      setRenewError(null);
      onChanged();
    } catch (error) {
      const message = error instanceof InfrastructureApiError || error instanceof Error
        ? error.message : "Hivra couldn't make a setup command.";
      if (replaceEnrollmentId) setRenewError(message);
      else setState({ kind: "unavailable", message });
    }
  }, [onChanged]);

  useEffect(() => {
    if (issuedOnce.current) return;
    issuedOnce.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- issue() is async; its setState calls fire after an await. The ref keeps a Strict Mode re-run from issuing a second command.
    void issue(null);
  }, [issue]);

  const enrollmentId = state.kind === "ready" ? state.enrollment.id : null;
  const phase = state.kind === "ready" ? state.enrollment.phase : null;
  useEffect(() => {
    if (!enrollmentId || (phase !== "issued" && phase !== "reported")) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      void getServerEnrollment(enrollmentId, controller.signal).then((next) => {
        setState((current) => (current.kind === "ready" && current.enrollment.id === next.id
          ? { ...current, enrollment: next } : current));
        if (next.phase !== "issued") onChanged();
        if (next.phase === "confirmed") onConnectionsChanged?.();
      }).catch(() => undefined);
    }, POLL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [enrollmentId, phase, onChanged, onConnectionsChanged]);

  async function renew() {
    if (state.kind !== "ready") return;
    setRenewing(true);
    setScriptOpen(false);
    await issue(state.enrollment.phase === "issued" ? state.enrollment.id : null);
    setRenewing(false);
  }

  const ready = state.kind === "ready" ? state : null;
  const item = ready?.enrollment ?? null;
  const expiresIn = item ? Date.parse(item.expiresAt) - now : 0;
  const answering = item?.phase === "reported" || item?.phase === "unsupported";
  // After No the card stays, as "Cancelled." with the uninstall command, even
  // once the poll reads the command back as rejected.
  const declined = item?.phase === "rejected";
  const open = item?.phase === "issued" && expiresIn > 0;
  const waiting = item && open ? waitingState(item) : null;

  return (
    <div className={styles.modalBackdrop}>
      <section
        ref={dialogRef}
        className={`${styles.wizard} ${styles.providerConnectionDialog}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="server-enrollment-title"
        tabIndex={-1}
      >
        <header className={styles.wizardHeader}>
          <div>
            <span className={styles.eyebrow}>My server</span>
            <h1 id="server-enrollment-title">{answering ? "Is this your server?" : "Connect a server you already have"}</h1>
          </div>
          <button ref={closeButtonRef} type="button" className={styles.closeButton} onClick={close} aria-label="Close server setup">
            <X size={19} aria-hidden="true" />
          </button>
        </header>

        <div className={styles.wizardBody}>
          {state.kind === "issuing" ? (
            <p className={enrollmentStyles.progress} role="status">
              <Loader2 size={15} className={styles.spin} aria-hidden="true" /> Making your setup command…
            </p>
          ) : state.kind === "unavailable" ? (
            <div className={styles.formError} role="alert">
              <AlertTriangle size={16} aria-hidden="true" />
              <span>{state.message}</span>
            </div>
          ) : item && (answering || declined) ? (
            <>
              <ServerEnrollmentCard
                enrollment={item}
                uninstallCommand={ready?.issued.uninstallCommand ?? null}
                onConfirmed={(connection) => { onChanged(); onConnected(connection); }}
                onReplaced={(connection) => { onChanged(); onAccessReplaced(connection); }}
                onDeclined={() => { onDeclined?.({ ...item, phase: "rejected" }); onChanged(); }}
                onNewCommand={() => void renew()}
              />
              {declined ? (
                <p className={enrollmentStyles.meta}>
                  <button type="button" className={enrollmentStyles.linkButton} onClick={() => void renew()} disabled={renewing}>
                    {renewing ? "Getting a new command…" : "Get a new command"}
                  </button>
                </p>
              ) : null}
            </>
          ) : item && item.phase === "confirmed" ? (
            <p className={enrollmentStyles.lead} role="status" data-testid="server-enrollment-waiting">
              <CheckCircle2 size={15} aria-hidden="true" /> {closedCommandLine(item)}
            </p>
          ) : item && ready ? (
            <>
              <p className={enrollmentStyles.lead}>Run this on the server, as a user who can use sudo:</p>
              {open ? (
                <div className={enrollmentStyles.commandRow}>
                  <code className={enrollmentStyles.command} data-testid="server-enrollment-command">{ready.issued.command}</code>
                  <CopyButton value={ready.issued.command} label="Copy the setup command" />
                </div>
              ) : null}
              <p className={enrollmentStyles.meta}>
                {open ? <>Single use · expires in {clock(expiresIn)} · </> : null}
                <button type="button" className={enrollmentStyles.linkButton} onClick={() => setScriptOpen((open) => !open)} aria-expanded={scriptOpen}>
                  View the script first
                </button>
                {" · "}
                <button type="button" className={enrollmentStyles.linkButton} onClick={() => void renew()} disabled={renewing}>
                  {renewing ? "Getting a new command…" : "Get a new command"}
                </button>
              </p>
              {renewError ? (
                <div className={styles.formError} role="alert"><AlertTriangle size={16} aria-hidden="true" /><span>{renewError}</span></div>
              ) : null}
              <p className={enrollmentStyles.accountCode}>
                <KeyRound size={14} aria-hidden="true" /> Your terminal will ask you to check your account code:{" "}
                <strong>{ready.issued.accountCode}</strong>
              </p>

              {scriptOpen ? <ViewScriptFirst issued={ready.issued} /> : null}

              <ul className={enrollmentStyles.notes}>
                <li>Signed in as root? Leave out <code>sudo</code>.</li>
                <li>
                  Works with Ubuntu 22.04 or 24.04 on x86. The server needs a public IPv4 address and must accept SSH from
                  the internet. Home or office machine? Hosted Hivra can&apos;t reach private networks yet.
                </li>
                <li>
                  Proxmox VE connects with a root login for now: use <strong>Connect with SSH details instead</strong>.
                </li>
                <li>
                  It creates a user named hivra that signs in only with Hivra&apos;s key and can use sudo, so Hivra gets
                  administrator (sudo) access to this server. Nothing else is installed.
                </li>
              </ul>

              <div className={enrollmentStyles.waiting} data-testid="server-enrollment-waiting">
                {waiting ? <Loader2 size={14} className={styles.spin} aria-hidden="true" /> : null}
                <span>
                  {/* One live region for the command's whole life, so the line
                      that says it ended is announced like every other change.
                      The clock beside it ticks outside the region. */}
                  <span role="status" aria-live="polite">{waiting ? waiting.text : closedCommandLine(item)}</span>
                  {waiting?.since ? <> · {clock(now - Date.parse(waiting.since))}</> : null}
                  {waiting && item.scriptFetches === 0 && !item.lastRefusal ? " — check your terminal if nothing happens." : ""}
                </span>
              </div>
              {open ? (
                <p className={enrollmentStyles.fine}>
                  Closing this panel doesn&apos;t cancel the command. Until it&apos;s used or expires, Capacity lists it
                  under Setup commands, where you can cancel it.
                </p>
              ) : null}
            </>
          ) : null}

          <div className={styles.wizardActions}>
            <button type="button" className={styles.tertiaryButton} onClick={() => { close(); onUseSshDetails(); }}>
              Connect with SSH details instead (advanced) <ArrowRight size={14} aria-hidden="true" />
            </button>
            {state.kind === "unavailable" ? (
              <button type="button" className={styles.secondaryButton} onClick={() => { setState({ kind: "issuing" }); void issue(null); }}>
                <RefreshCw size={14} aria-hidden="true" /> Try again
              </button>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}

/** Verifiable in a few commands: the body is the same for everyone and
 * pinned in the repository; only the final line differs. */
function ViewScriptFirst({ issued }: { issued: ServerEnrollmentIssueResult }) {
  const recipe = [
    "d=$(mktemp -d) && cd \"$d\"",
    issued.downloadCommand,
    "sha256sum hivra-enroll.sh                 # matches \"your download\" below",
    "head -n -1 hivra-enroll.sh | sha256sum    # matches the published script",
    "less hivra-enroll.sh",
    "sudo bash hivra-enroll.sh",
    "cd / && rm -rf \"$d\"                       # the file holds your one-time code",
  ].join("\n");
  return (
    <div className={enrollmentStyles.scriptFirst}>
      <dl className={enrollmentStyles.digests}>
        <div><dt>Script version</dt><dd><code>{issued.scriptVersion}</code></dd></div>
        <div><dt>Published script sha256</dt><dd><code>{issued.scriptSha256}</code></dd></div>
        <div><dt>Your download sha256</dt><dd><code>{issued.downloadSha256}</code></dd></div>
        <div><dt>Its last line, for this command</dt><dd><code>{issued.finalLine}</code></dd></div>
      </dl>
      <p>
        <a href="/enroll/script" target="_blank" rel="noreferrer">
          Read the script <ExternalLink size={12} aria-hidden="true" /><span className={styles.srOnly}> (opens in a new tab)</span>
        </a>{" "}
        · the same file is in Hivra&apos;s public repository at <code>dashboard/bootstrap/server-enroll.sh</code>.
      </p>
      <p><strong>Try it without changing anything</strong> (no sudo needed):</p>
      <div className={enrollmentStyles.commandRow}>
        <code className={enrollmentStyles.command}>{issued.dryRunCommand}</code>
        <CopyButton value={issued.dryRunCommand} label="Copy the dry-run command" />
      </div>
      <p><strong>Or download it, check it, then run it:</strong></p>
      <p className={enrollmentStyles.warning}>
        <SquareTerminal size={14} aria-hidden="true" /> The downloaded file contains your one-time code. Delete it when
        you&apos;re done. The code stops working once it&apos;s used, and after 15 minutes. Downloading doesn&apos;t use it up.
      </p>
      <div className={enrollmentStyles.commandRow}>
        <pre className={enrollmentStyles.recipe}>{recipe}</pre>
        <CopyButton value={recipe} label="Copy the download-and-check commands" />
      </div>
      <p className={enrollmentStyles.fine}>To undo it later: <code>{issued.uninstallCommand}</code></p>
    </div>
  );
}
