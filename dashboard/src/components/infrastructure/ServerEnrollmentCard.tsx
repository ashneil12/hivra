"use client";

import { AlertTriangle, CheckCircle2, Loader2, ServerCog, ShieldCheck, X } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { InfrastructureApiError } from "@/lib/infrastructure/client";
import type { InfrastructureConnectionDto } from "@/lib/infrastructure/contracts";
import { ProxmoxSshHostSchema } from "@/lib/infrastructure/contracts";
import {
  SERVER_ENROLLMENT_PROXMOX_INSTRUCTION,
  SERVER_ENROLLMENT_REBUILD_INSTRUCTION,
  serverEnrollmentFactsSummary,
  type ServerEnrollmentDto,
} from "@/lib/infrastructure/server-enrollment-contracts";
import {
  confirmServerEnrollment,
  declineServerEnrollment,
  replaceServerEnrollmentAccess,
} from "@/lib/infrastructure/server-enrollment-client";

import styles from "./Infrastructure.module.css";
import enrollment from "./ServerEnrollment.module.css";
import { CopyButton } from "./CopyButton";

/** "12 seconds ago", "3 minutes ago": how long since the report landed. */
export function secondsAgo(fromIso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(fromIso)) / 1_000));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"} ago`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
}

export function useNow(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

type Failure = { message: string; code: string | null; cause: string | null };

/** Why Replace didn't change anything, in the owner's words. */
export function replacementFailureCopy(cause: string | null, name: string, address: string | null): string {
  switch (cause) {
    case "authentication_failed":
      return `${name} didn't accept the new key, so Hivra changed nothing: ${name} keeps the access it had before. If you ran the command on ${name}, check that it finished, then try again. If you didn't, choose No.`;
    case "host_key_mismatch":
      return `The server at ${address ?? name} presented a different SSH identity than ${name}, so Hivra changed nothing. If you ran the command on a copy of ${name}, that server has ${name}'s SSH identity. Give it its own SSH host keys, then run a new command.`;
    case "connection_failed":
      return `Hivra couldn't reach ${name}${address ? ` at ${address}` : ""}, so it changed nothing. Check that ${name} is running and accepts SSH, then try again.`;
    case "sudo_unavailable":
      return `Hivra signed in to ${name} as hivra, but sudo didn't run without a password, so Hivra changed nothing. Check that the command finished on ${name}, then try again.`;
    case "not_root":
      return `Hivra signed in to ${name} as hivra, but its administrator check didn't pass, so Hivra changed nothing.`;
    case "proxmox_needs_root":
      return `${name} runs Proxmox VE, which needs a root login for now, so Hivra didn't switch it to the hivra user and changed nothing. To remove the hivra user this command added, run the uninstall command.`;
    default:
      return `Hivra couldn't check ${name}, so it changed nothing.`;
  }
}

function failureOf(error: unknown, fallback: string): Failure {
  if (error instanceof InfrastructureApiError) {
    return { message: error.message, code: error.code ?? null, cause: error.detail.cause ?? null };
  }
  return { message: error instanceof Error ? error.message : fallback, code: null, cause: null };
}

/**
 * "Is this your server?" A report from the setup command makes nothing
 * trusted: Yes (or Replace, for a server already connected) is the owner's
 * own action. The card keeps what Hivra saw ("Connected from") apart from
 * what the server claims ("Reported by the server"), and shows the three
 * words and the identity so the owner answers by matching their terminal.
 */
export function ServerEnrollmentCard({
  enrollment: item,
  uninstallCommand,
  onConfirmed,
  onReplaced,
  onDeclined,
  onNewCommand,
}: {
  enrollment: ServerEnrollmentDto;
  uninstallCommand: string | null;
  onConfirmed: (connection: InfrastructureConnectionDto) => void;
  onReplaced: (connection: InfrastructureConnectionDto) => void;
  onDeclined: () => void;
  /** "Get a new command", for the unsupported card. */
  onNewCommand?: () => void;
}) {
  const now = useNow();
  const headingId = useId();
  const addressId = useId();
  const [busy, setBusy] = useState<"yes" | "no" | "replace" | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [declined, setDeclined] = useState(false);
  const [editingAddress, setEditingAddress] = useState(false);
  const [address, setAddress] = useState("");
  const [addressError, setAddressError] = useState<string | null>(null);
  const report = item.report;
  if (!report) return null;
  const known = item.knownServer;
  const observed = report.observedAddress;
  const needsAddress = !observed || editingAddress;

  // "Cancelled." is what the owner sees after No, both right away and once a
  // refresh reads the command back as rejected: the uninstall command must
  // not vanish with the question.
  if (declined || item.phase === "rejected") {
    return (
      <section className={`${enrollment.card} ${enrollment.cardDone}`} aria-labelledby={headingId} role="status">
        <h3 id={headingId}>Cancelled.</h3>
        <p>Hivra deleted its key for that server, so it can&apos;t sign in.</p>
        {uninstallCommand ? (
          <>
            <p>To remove the hivra user from that server, run:</p>
            <div className={enrollment.commandRow}>
              <code className={enrollment.command}>{uninstallCommand}</code>
              <CopyButton value={uninstallCommand} label="Copy the uninstall command" />
            </div>
          </>
        ) : null}
      </section>
    );
  }

  if (report.kind === "unsupported") {
    const facts = report.facts;
    const found = facts.proxmoxVersion
      ? `Proxmox VE ${facts.proxmoxVersion}`
      : facts.osId ? `${facts.osId.charAt(0).toUpperCase()}${facts.osId.slice(1)}${facts.osVersionId ? ` ${facts.osVersionId}` : ""}` : "an operating system Hivra couldn't identify";
    const arch = facts.architecture === "x86_64" ? "x86" : facts.architecture ?? "an unknown processor";
    return (
      <section className={enrollment.card} aria-labelledby={headingId}>
        <span className={styles.eyebrow}>Setup command</span>
        <h3 id={headingId}>
          A server used your setup command{observed ? ` from ${observed}` : ""} and reported {found} on {arch}.
        </h3>
        <p>
          {facts.proxmoxVersion
            ? <>The setup command doesn&apos;t connect Proxmox VE yet. {SERVER_ENROLLMENT_PROXMOX_INSTRUCTION}</>
            : <>Hivra doesn&apos;t support that yet: {SERVER_ENROLLMENT_REBUILD_INSTRUCTION}</>}
        </p>
        <p>If you didn&apos;t run the command, someone else has it. That command no longer works, and nothing was connected.</p>
        {onNewCommand ? (
          <div className={enrollment.actions}>
            <button type="button" className={styles.secondaryButton} onClick={onNewCommand}>Get a new command</button>
          </div>
        ) : null}
      </section>
    );
  }

  const name = known?.connectionName ?? "the server";
  const replaceOffered = known?.offer === "replace_key" || known?.offer === "switch_user";
  // Where the check signs in: the connection's address, or, for a switch, the
  // one the owner typed.
  const signInAddress = known?.offer === "switch_user" && editingAddress && address.trim()
    ? address.trim() : known?.sshHost ?? null;

  async function answerYes() {
    let sshHost: string | null = null;
    if (needsAddress) {
      const parsed = ProxmoxSshHostSchema.safeParse(address);
      if (!parsed.success || parsed.data.includes(":")) {
        setAddressError("Enter the server's public IPv4 address or hostname, without a URL or port.");
        return;
      }
      sshHost = parsed.data;
    }
    setBusy("yes");
    setFailure(null);
    try {
      onConfirmed(await confirmServerEnrollment(item.id, sshHost));
    } catch (error) {
      setFailure(failureOf(error, "Hivra couldn't connect this server."));
    } finally {
      setBusy(null);
    }
  }

  async function replace() {
    if (!known) return;
    let sshHost: string | null = null;
    // A switch may sign in at an address the owner chose; a key-only
    // Replace keeps the connection's address (8.1 step 3).
    if (known.offer === "switch_user" && editingAddress) {
      const parsed = ProxmoxSshHostSchema.safeParse(address);
      if (!parsed.success || parsed.data.includes(":")) {
        setAddressError("Enter the server's public IPv4 address or hostname, without a URL or port.");
        return;
      }
      sshHost = parsed.data;
    }
    setBusy("replace");
    setFailure(null);
    try {
      onReplaced(await replaceServerEnrollmentAccess(item.id, {
        connectionId: known.connectionId, connectionRevision: known.connectionRevision, sshHost,
      }));
    } catch (error) {
      setFailure(failureOf(error, "Hivra couldn't check the server."));
    } finally {
      setBusy(null);
    }
  }

  async function answerNo() {
    setBusy("no");
    setFailure(null);
    try {
      await declineServerEnrollment(item.id);
      setDeclined(true);
      onDeclined();
    } catch (error) {
      setFailure(failureOf(error, "Hivra couldn't cancel this."));
    } finally {
      setBusy(null);
    }
  }

  const consent = report.consent === "terminal" ? "approved at its terminal" : "run without a terminal (--yes)";
  const noReplaceCopy = known && !replaceOffered ? (() => {
    switch (known.reason) {
      case "login_in_use":
        return `${name} is already connected as ${known.sshUser ?? "another user"}, and its agents use that connection. Hivra didn't change it. To remove the hivra user this command added, run the uninstall command.`;
      case "proxmox_needs_root":
        return `${name} runs Proxmox VE, which needs a root login for now. Hivra didn't change it. To remove the hivra user this command added, run the uninstall command.`;
      case "proxmox_connection":
        return `This SSH identity belongs to ${name}, a Proxmox server connected as ${known.sshUser ?? "root"}. Proxmox connections keep their root login, so Hivra didn't change it. To remove the hivra user this command added, run the uninstall command.`;
      case "hetzner":
        return `This SSH identity belongs to ${name}, a server Hivra created on Hetzner. Manage it from its card.`;
      default:
        return "More than one of your connections uses this SSH identity. Remove the extra ones first.";
    }
  })() : null;

  return (
    <section className={enrollment.card} aria-labelledby={headingId}>
      <span className={styles.eyebrow}>Setup command</span>
      <h3 id={headingId}>Is this your server?</h3>
      <p className={enrollment.lead}>
        A server used your setup command {secondsAgo(report.reportedAt, now)}.
        {known ? <> It reports the same SSH identity as <strong>{name}</strong>, which is already connected.</> : null}
      </p>
      <dl className={enrollment.facts}>
        <div>
          <dt>Connected from (seen by Hivra)</dt>
          <dd>{observed ?? "Hivra couldn't see this server's address"}</dd>
        </div>
        <div>
          <dt>Reported by the server</dt>
          <dd>{serverEnrollmentFactsSummary(report.facts)} · {consent}</dd>
        </div>
        <div>
          <dt>Your terminal shows</dt>
          <dd><strong className={enrollment.words}>{report.words?.split("-").join(" ")}</strong></dd>
        </div>
        <div>
          <dt>Server identity</dt>
          <dd className={enrollment.identity}>
            <code>{report.hostFingerprintSha256}</code>
            {report.hostFingerprintSha256 ? <CopyButton value={report.hostFingerprintSha256} label="Copy the server identity" /> : null}
          </dd>
        </div>
      </dl>

      {noReplaceCopy ? (
        <p className={enrollment.notice}>{noReplaceCopy}</p>
      ) : known ? (
        <p>
          Only continue if your terminal shows these three words and you ran the command on {name}. Hivra first signs
          in to {name} at {signInAddress ?? "its address"} with the new key. It changes {name} only if that works;
          otherwise Hivra leaves {name} as it is.
        </p>
      ) : (
        <p>
          Only choose Yes if your terminal shows these three words. If your terminal said the command was already used,
          someone else has your command: choose No. If your terminal said Hivra didn&apos;t answer, choose No and run a new
          command.
        </p>
      )}

      {busy === "replace" ? (
        <p className={enrollment.progress} role="status"><Loader2 size={14} className={styles.spin} aria-hidden="true" /> Signing in to {name} with the new key…</p>
      ) : null}
      {failure ? (
        <div className={styles.formError} role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{failure.code === "verification_failed" && known
            ? replacementFailureCopy(failure.cause, name, known.sshHost)
            : failure.message}</span>
        </div>
      ) : null}

      {(!known && needsAddress) || (known?.offer === "switch_user" && editingAddress) ? (
        <div className={enrollment.addressField}>
          <label htmlFor={addressId}>
            {known ? "Sign in at this address instead" : observed ? "Connect to this address instead" : "The server's public IPv4 address"}
          </label>
          <input
            id={addressId}
            value={address}
            onChange={(event) => { setAddress(event.target.value); setAddressError(null); }}
            placeholder="203.0.113.24"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={Boolean(addressError)}
          />
          {addressError ? <span className={styles.fieldError}>{addressError}</span> : null}
        </div>
      ) : null}

      <div className={enrollment.actions}>
        {known ? (
          replaceOffered ? (
            <button type="button" className={enrollment.answerButton} onClick={() => void replace()} disabled={busy !== null}>
              {busy === "replace" ? <Loader2 size={14} className={styles.spin} aria-hidden="true" /> : <ShieldCheck size={14} aria-hidden="true" />}
              {known.offer === "switch_user" ? `Switch ${name} to the hivra user` : `Replace ${name}'s access`}
            </button>
          ) : null
        ) : (
          <button type="button" className={enrollment.answerButton} onClick={() => void answerYes()} disabled={busy !== null}>
            {busy === "yes" ? <Loader2 size={14} className={styles.spin} aria-hidden="true" /> : <CheckCircle2 size={14} aria-hidden="true" />}
            Yes, this is my server
          </button>
        )}
        <button type="button" className={enrollment.answerButton} onClick={() => void answerNo()} disabled={busy !== null}>
          {busy === "no" ? <Loader2 size={14} className={styles.spin} aria-hidden="true" /> : <X size={14} aria-hidden="true" />}
          No, cancel
        </button>
      </div>
      {!known ? (
        <p className={enrollment.fine}>
          <ServerCog size={13} aria-hidden="true" />{" "}
          {observed && !editingAddress
            ? <>Hivra will connect to {observed} on port {report.sshPort ?? 22} as hivra.{" "}
                <button type="button" className={enrollment.linkButton} onClick={() => setEditingAddress(true)}>Use a different address</button></>
            : <>Hivra will connect to this address on port {report.sshPort ?? 22} as hivra.</>}
        </p>
      ) : known?.offer === "switch_user" && !editingAddress ? (
        <p className={enrollment.fine}>
          <ServerCog size={13} aria-hidden="true" />{" "}
          Hivra will sign in to {name} at {known.sshHost ?? "its address"} as hivra.{" "}
          <button type="button" className={enrollment.linkButton} onClick={() => setEditingAddress(true)}>Use a different address</button>
        </p>
      ) : null}
    </section>
  );
}
