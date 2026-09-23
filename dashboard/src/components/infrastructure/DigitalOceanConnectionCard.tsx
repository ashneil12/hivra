"use client";

import Link from "next/link";
import { AlertTriangle, Bot, CheckCircle2, ExternalLink, KeyRound, Loader2, Play, RefreshCw, Trash2 } from "lucide-react";

import {
  DIGITALOCEAN_HARNESS_LABELS,
  type ManagedSessionDto,
} from "@/lib/hivra/managed-session-contracts";
import type { DigitalOceanConnectionDto, DigitalOceanDeploymentTargetDto } from "@/lib/infrastructure/contracts";
import { formatInfrastructureDate } from "@/lib/infrastructure/formatters";

import styles from "./Infrastructure.module.css";

const DIGITALOCEAN_CONSOLE_URL = "https://cloud.digitalocean.com/managed-agents/harness-runtime";

function persistedError(code: DigitalOceanConnectionDto["lastErrorCode"]): string {
  if (code === "invalid_credentials") return "DigitalOcean rejected this token. Reconnect with a new token.";
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

export function DigitalOceanConnectionCard({
  connection,
  target,
  sessions,
  refreshing,
  error,
  onLaunch,
  onRefresh,
  onDelete,
}: {
  connection: DigitalOceanConnectionDto;
  target: DigitalOceanDeploymentTargetDto | null;
  sessions: ManagedSessionDto[];
  refreshing: boolean;
  error?: string | null;
  onLaunch: () => void;
  onRefresh: () => void;
  onDelete: () => void;
}) {
  const ready = connection.status === "ready" && target?.status === "ready";
  const visibleError = error ?? (connection.status === "error" ? persistedError(connection.lastErrorCode) : null);

  return (
    <article className={`${styles.connectionCard} ${styles.providerConnectionCard}`}>
      <div className={styles.connectionCardHeader}>
        <span className={styles.providerMark} aria-hidden="true"><Bot size={19} /></span>
        <div className={styles.connectionIdentity}>
          <span className={styles.eyebrow}>DigitalOcean Managed Agents</span>
          <h2>{connection.name}</h2>
        </div>
        <span className={`${styles.statusBadge} ${styles[ready ? "status_connected" : "status_error"]}`}>
          {ready ? <CheckCircle2 size={12} aria-hidden="true" /> : <AlertTriangle size={12} aria-hidden="true" />}
          {ready ? "Ready for agents" : "Needs attention"}
        </span>
      </div>

      <div className={styles.connectionMeta}>
        <div><span>Agent sessions</span><strong>{sessions.length}</strong></div>
        <div><span>Sandbox sizes</span><strong>{target?.capabilities.sizes.length ?? 0}</strong></div>
        <div><span>Last checked</span><strong>{formatInfrastructureDate(connection.lastCheckedAt)}</strong></div>
      </div>

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
