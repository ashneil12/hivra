"use client";

import Link from "next/link";
import { useState } from "react";
import { AlertTriangle, Bot, CalendarClock, CheckCircle2, ExternalLink, KeyRound, Loader2, Play, RefreshCw, Trash2 } from "lucide-react";

import { setDigitalOceanAccountTokenExpiry } from "@/lib/hivra/managed-session-client";
import {
  DIGITALOCEAN_HARNESS_LABELS,
  type ManagedSessionDto,
} from "@/lib/hivra/managed-session-contracts";
import type { CredentialExpiryDto, DigitalOceanConnectionDto, DigitalOceanDeploymentTargetDto } from "@/lib/infrastructure/contracts";
import { formatInfrastructureDate } from "@/lib/infrastructure/formatters";
import {
  formatExpiryDate,
  relativeDays,
  tokenExpiryInputFor,
  tokenExpiryState,
  type TokenExpiryChoice,
  type TokenExpiryState,
} from "@/lib/infrastructure/token-expiry";

import styles from "./Infrastructure.module.css";
import { TokenExpiryField } from "./TokenExpiryField";

const DIGITALOCEAN_CONSOLE_URL = "https://cloud.digitalocean.com/managed-agents/harness-runtime";

function persistedError(code: DigitalOceanConnectionDto["lastErrorCode"]): string {
  if (code === "invalid_credentials") return "DigitalOcean rejected this token. Replace it with a new token from the same team; your agents keep running.";
  if (code === "managed_agents_forbidden") return "This token cannot use Managed Agents. Check the team’s preview access and token scope.";
  if (code === "provider_response_invalid") return "DigitalOcean returned a response Hivra could not safely accept.";
  return "The latest DigitalOcean check did not complete.";
}

function sessionBadge(session: ManagedSessionDto): { label: string; tone: string } {
  switch (session.status) {
    case "ready": return { label: "Ready", tone: "status_connected" };
    case "paused": return { label: "Paused", tone: "status_pending" };
    case "provisioning": return { label: "Starting", tone: "status_checking" };
    case "deleting": return { label: "Deleting", tone: "status_checking" };
    default: return { label: "Needs attention", tone: "status_error" };
  }
}

function expiryValue(state: TokenExpiryState): string {
  switch (state.kind) {
    case "never": return "No expiry";
    case "later":
    case "soon": return formatExpiryDate(state.expiresOn);
    case "expired": return `Expired ${formatExpiryDate(state.expiresOn)}`;
    default: return "Not recorded";
  }
}

/** One truthful badge: rejected beats expired beats expiring beats ready. */
function cardBadge(ready: boolean, rejected: boolean, expiry: TokenExpiryState): { label: string; tone: string; ok: boolean } {
  if (rejected) return { label: "Token rejected", tone: "status_error", ok: false };
  if (expiry.kind === "expired") return { label: "Token past its expiry date", tone: "status_error", ok: false };
  if (!ready) return { label: "Needs attention", tone: "status_error", ok: false };
  if (expiry.kind === "soon") return { label: `Token expires ${relativeDays(expiry.days)}`, tone: "status_pending", ok: false };
  return { label: "Ready for agents", tone: "status_connected", ok: true };
}

function ExpiryReminderEditor({
  connectionId,
  onSaved,
  onCancel,
}: {
  connectionId: string;
  onSaved: (expiry: CredentialExpiryDto) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState<{ choice: TokenExpiryChoice; date: string }>({ choice: "none", date: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    const input = tokenExpiryInputFor(value.choice, value.date);
    if (!input || (value.choice === "date" && !value.date)) {
      setError(value.choice === "date" ? "Choose the date DigitalOcean shows for this token." : "Choose No expiry or a date.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      onSaved(await setDigitalOceanAccountTokenExpiry(connectionId, input));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The reminder was not saved.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className={styles.connectionEvidence}>
      <span className={styles.connectionEvidenceIcon} aria-hidden="true"><CalendarClock size={15} /></span>
      <div style={{ flex: 1 }}>
        <TokenExpiryField choice={value.choice} date={value.date} disabled={saving} error={error} onChange={setValue} />
        <div className={styles.cardActions}>
          <button type="button" className={styles.primaryButton} onClick={() => void save()} disabled={saving}>
            {saving ? <Loader2 size={14} className={styles.spin} aria-hidden="true" /> : null} Save reminder
          </button>
          <button type="button" className={styles.secondaryButton} onClick={onCancel} disabled={saving}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

export function DigitalOceanConnectionCard({
  connection,
  target,
  sessions,
  refreshing,
  error,
  onLaunch,
  onRefresh,
  onReplaceToken,
  onDelete,
  onExpiryChanged,
}: {
  connection: DigitalOceanConnectionDto;
  target: DigitalOceanDeploymentTargetDto | null;
  sessions: ManagedSessionDto[];
  refreshing: boolean;
  error?: string | null;
  onLaunch: () => void;
  onRefresh: () => void;
  onReplaceToken: () => void;
  onDelete: () => void;
  onExpiryChanged?: (expiry: CredentialExpiryDto) => void;
}) {
  const [editingExpiry, setEditingExpiry] = useState(false);
  const ready = connection.status === "ready" && target?.status === "ready";
  const rejected = connection.lastErrorCode === "invalid_credentials";
  const expiry = tokenExpiryState(connection.credentialExpiry);
  const badge = cardBadge(ready, rejected, expiry);
  const visibleError = error ?? (connection.status === "error" ? persistedError(connection.lastErrorCode) : null);
  const replacePrimary = rejected || expiry.kind === "soon" || expiry.kind === "expired";

  return (
    <article className={`${styles.connectionCard} ${styles.providerConnectionCard}`}>
      <div className={styles.connectionCardHeader}>
        <span className={styles.providerMark} aria-hidden="true"><Bot size={19} /></span>
        <div className={styles.connectionIdentity}>
          <span className={styles.eyebrow}>DigitalOcean Managed Agents</span>
          <h2>{connection.name}</h2>
        </div>
        <span className={`${styles.statusBadge} ${styles[badge.tone]}`}>
          {badge.ok ? <CheckCircle2 size={12} aria-hidden="true" /> : <AlertTriangle size={12} aria-hidden="true" />}
          {badge.label}
        </span>
      </div>

      <div className={styles.connectionMeta}>
        <div><span>Agent sessions</span><strong>{sessions.length}</strong></div>
        <div><span>Sandbox sizes</span><strong>{target?.capabilities.sizes.length ?? 0}</strong></div>
        <div><span>Last checked</span><strong>{formatInfrastructureDate(connection.lastCheckedAt)}</strong></div>
        <div>
          <span>Token expires</span>
          <strong>
            {expiryValue(expiry)}
            {!editingExpiry && onExpiryChanged ? (
              <>
                {" "}
                <button type="button" className={styles.tertiaryButton} onClick={() => setEditingExpiry(true)}>
                  {expiry.kind === "unknown" ? "Set reminder" : "Change"}
                </button>
              </>
            ) : null}
          </strong>
        </div>
      </div>

      {editingExpiry && onExpiryChanged ? (
        <ExpiryReminderEditor
          connectionId={connection.id}
          onCancel={() => setEditingExpiry(false)}
          onSaved={(next) => { setEditingExpiry(false); onExpiryChanged(next); }}
        />
      ) : null}

      {!rejected && (expiry.kind === "soon" || expiry.kind === "expired") ? (
        <div className={styles.providerInventoryError} role="status">
          <CalendarClock size={15} aria-hidden="true" />
          <span>
            {expiry.kind === "soon"
              ? `This DigitalOcean token expires ${relativeDays(expiry.days)} (${formatExpiryDate(expiry.expiresOn)}, the date you entered). Replace it now so your agents keep working.`
              : `This token was due to expire on ${formatExpiryDate(expiry.expiresOn)} (the date you entered). If DigitalOcean now rejects it, replace it; your agents and conversations are kept.`}
          </span>
        </div>
      ) : null}

      <div className={styles.connectionEvidence}>
        <span className={styles.connectionEvidenceIcon} aria-hidden="true"><KeyRound size={15} /></span>
        <div>
          <strong>Provider-managed microVM per agent</strong>
          <span>
            DigitalOcean runs each agent in its own Firecracker microVM session and bills your team per active
            second. DigitalOcean attests that isolation; Hivra does not measure it. The token is encrypted and
            never returned to the browser.
          </span>
        </div>
      </div>

      {visibleError ? (
        <div className={styles.providerInventoryError} role="alert">
          <AlertTriangle size={15} aria-hidden="true" /><span>{visibleError}</span>
        </div>
      ) : null}

      {sessions.length > 0 ? (
        <div className={styles.providerInventory} aria-label={`${connection.name} agent sessions`}>
          {sessions.map((session) => {
            const badge = sessionBadge(session);
            return (
              <article key={session.agentId} className={styles.providerServerCard}>
                <div className={styles.providerServerHeader}>
                  <span className={styles.providerServerIcon} aria-hidden="true"><Bot size={15} /></span>
                  <div>
                    <strong><Link href={`/dashboard/agent/${session.agentId}`}>{session.name}</Link></strong>
                    <span>{DIGITALOCEAN_HARNESS_LABELS[session.harness].name} · {session.size.replace(/^mars-/, "")}</span>
                  </div>
                  <span className={`${styles.statusBadge} ${styles[badge.tone]}`}>{badge.label}</span>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className={styles.providerInventoryEmpty}>
          <Bot size={20} aria-hidden="true" />
          <div>
            <strong>No agents on DigitalOcean yet.</strong>
            <span>Launch Claude Code, Codex, or Hermes into its own DigitalOcean session and chat with it here.</span>
          </div>
        </div>
      )}

      <div className={styles.cardActions}>
        <button type="button" className={styles.primaryButton} onClick={onLaunch} disabled={!ready}>
          <Play size={14} aria-hidden="true" /> Launch agent
        </button>
        <button type="button" className={styles.secondaryButton} onClick={onRefresh} disabled={refreshing}>
          {refreshing ? <Loader2 size={14} className={styles.spin} aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
          {refreshing ? "Checking…" : "Re-check access"}
        </button>
        <button type="button" className={replacePrimary ? styles.primaryButton : styles.secondaryButton} onClick={onReplaceToken}>
          <KeyRound size={14} aria-hidden="true" /> Replace token
        </button>
        <a className={styles.tertiaryButton} href={DIGITALOCEAN_CONSOLE_URL} target="_blank" rel="noreferrer">
          Manage in DigitalOcean <ExternalLink size={13} aria-hidden="true" /><span className={styles.srOnly}> (opens in a new tab)</span>
        </a>
        <div className={styles.actionSpacer} />
        <button type="button" className={styles.iconButton} aria-label={`Disconnect ${connection.name}`} title={`Disconnect ${connection.name}`} onClick={onDelete}>
          <Trash2 size={15} aria-hidden="true" />
        </button>
      </div>
    </article>
  );
}
