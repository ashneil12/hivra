"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  ExternalLink,
  KeyRound,
  Loader2,
  RefreshCw,
  Server,
  Trash2,
  Unplug,
} from "lucide-react";

import type {
  HetznerCloudConnectionDto,
  HetznerCloudServerInventoryDto,
} from "@/lib/infrastructure/contracts";
import { formatInfrastructureDate } from "@/lib/infrastructure/formatters";

import styles from "./Infrastructure.module.css";

const HETZNER_PROJECTS_URL = "https://console.hetzner.com/projects";

type HetznerCloudConnectionCardProps = {
  connection: HetznerCloudConnectionDto;
  inventory: HetznerCloudServerInventoryDto[];
  loading: boolean;
  error?: string | null;
  onCreateCapacity: () => void;
  onCleanup?: () => void;
  onSetup?: () => void;
  onRefresh: () => void;
  onDelete: () => void;
};

function inventoryStatus(status: HetznerCloudServerInventoryDto["status"]): {
  label: string;
  tone: "connected" | "checking" | "error" | "pending";
} {
  switch (status) {
    case "running":
      return { label: "Running", tone: "connected" };
    case "off":
      return { label: "Off", tone: "pending" };
    case "initializing":
    case "starting":
    case "stopping":
    case "rebuilding":
    case "migrating":
      return { label: status[0].toUpperCase() + status.slice(1), tone: "checking" };
    case "deleting":
      return { label: "Deleting", tone: "error" };
    default:
      return { label: "Unknown", tone: "error" };
  }
}

function serverAddress(server: HetznerCloudServerInventoryDto): string {
  return server.publicNetwork.ipv4 ?? server.publicNetwork.ipv6 ?? "Private network only";
}

function persistedSyncError(
  code: HetznerCloudConnectionDto["lastErrorCode"],
): string {
  if (code === "invalid_credentials") {
    return "Hetzner rejected this project token. Replace or reconnect the credential before the next sync.";
  }
  if (code === "provider_response_invalid") {
    return "Hetzner returned an inventory response Hivra could not safely accept.";
  }
  return "The latest Hetzner inventory sync did not complete.";
}

export function HetznerCloudConnectionCard({
  connection,
  inventory,
  loading,
  error,
  onCreateCapacity,
  onCleanup,
  onSetup,
  onRefresh,
  onDelete,
}: HetznerCloudConnectionCardProps) {
  const lastCheckedAt = inventory.reduce<string | null>((latest, server) => {
    if (!latest || Date.parse(server.discoveredAt) > Date.parse(latest)) {
      return server.discoveredAt;
    }
    return latest;
  }, connection.lastCheckedAt);
  const syncIssue = connection.status === "error" || Boolean(error);
  const visibleError = error ?? (
    connection.status === "error"
      ? persistedSyncError(connection.lastErrorCode)
      : null
  );

  return (
    <article className={`${styles.connectionCard} ${styles.providerConnectionCard}`}>
      <div className={styles.connectionCardHeader}>
        <span className={styles.providerMark} aria-hidden="true">
          <Cloud size={19} />
        </span>
        <div className={styles.connectionIdentity}>
          <span className={styles.eyebrow}>Hetzner Cloud project</span>
          <h2>{connection.name}</h2>
        </div>
        <span className={`${styles.statusBadge} ${styles[syncIssue ? "status_error" : "status_connected"]}`}>
          {syncIssue
            ? <AlertTriangle size={12} aria-hidden="true" />
            : <CheckCircle2 size={12} aria-hidden="true" />}
          {syncIssue ? "Sync issue" : "Connected"}
        </span>
      </div>

      <div className={styles.connectionMeta}>
        <div>
          <span>Cloud servers</span>
          <strong>{inventory.length}</strong>
        </div>
        <div>
          <span>Credential</span>
          <strong>Project token</strong>
        </div>
        <div>
          <span>Last checked</span>
          <strong>{formatInfrastructureDate(lastCheckedAt)}</strong>
        </div>
      </div>

      <div className={styles.connectionEvidence}>
        <span className={styles.connectionEvidenceIcon} aria-hidden="true">
          <KeyRound size={15} />
        </span>
        <div>
          <strong>Encrypted project access</strong>
          <span>
            Hivra asks for a Read &amp; Write token, which can mutate this Hetzner project.
            Write scope is confirmed only by an approved mutation. The token is never
            returned to the browser and can be revoked in Hetzner.
          </span>
        </div>
      </div>

      {visibleError ? (
        <div className={styles.providerInventoryError} role="alert">
          <AlertTriangle size={15} aria-hidden="true" />
          <span>
            {visibleError}
            {inventory.length > 0 ? " Showing the last successful server snapshot." : ""}
          </span>
        </div>
      ) : null}

      {loading && inventory.length === 0 ? (
        <div className={styles.providerInventoryLoading} role="status">
          <Loader2 size={17} className={styles.spin} aria-hidden="true" />
          <span>Loading Hetzner servers…</span>
        </div>
      ) : inventory.length > 0 ? (
        <div className={styles.providerInventory} aria-label={`${connection.name} servers`}>
          {inventory.map((server) => {
            const state = inventoryStatus(server.status);
            return (
              <article key={server.id} className={styles.providerServerCard}>
                <div className={styles.providerServerHeader}>
                  <span className={styles.providerServerIcon} aria-hidden="true">
                    <Server size={15} />
                  </span>
                  <div>
                    <strong>{server.name}</strong>
                    <span>{serverAddress(server)}</span>
                  </div>
                  <span className={`${styles.statusBadge} ${styles[`status_${state.tone}`]}`}>
                    {state.label}
                  </span>
                </div>
                <dl className={styles.providerServerFacts}>
                  <div>
                    <dt>Size</dt>
                    <dd>{server.serverType.name}</dd>
                  </div>
                  <div>
                    <dt>CPU / RAM</dt>
                    <dd>{server.serverType.cores} vCPU · {server.serverType.memoryGb} GB</dd>
                  </div>
                  <div>
                    <dt>Disk</dt>
                    <dd>{server.serverType.diskGb} GB</dd>
                  </div>
                  <div>
                    <dt>Region</dt>
                    <dd>{server.location.city ?? server.location.name}</dd>
                  </div>
                </dl>
                <div className={styles.providerLaunchBoundary}>
                  Provider inventory · Open Computer setup to check agent readiness
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className={styles.providerInventoryEmpty}>
          <Cloud size={20} aria-hidden="true" />
          <div>
            <strong>No servers in this project yet.</strong>
            <span>
              Choose a live Hetzner size, location, and Ubuntu image in Hivra, then
              review the provider price before creating a powered-off server.
            </span>
          </div>
        </div>
      )}

      <div className={styles.cardActions}>
        <button
          type="button"
          className={styles.primaryButton}
          onClick={onCreateCapacity}
        >
          <Cloud size={14} aria-hidden="true" /> Create cloud server
        </button>
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={onRefresh}
          disabled={loading}
        >
          {loading ? (
            <Loader2 size={14} className={styles.spin} aria-hidden="true" />
          ) : (
            <RefreshCw size={14} aria-hidden="true" />
          )}
          {loading ? "Syncing…" : "Sync servers"}
        </button>
        {onCleanup && <button type="button" className={styles.secondaryButton} onClick={onCleanup}>
          <Trash2 size={14} aria-hidden="true" /> Remove created server
        </button>}
        {onSetup && <button type="button" className={styles.secondaryButton} onClick={onSetup}>
          <Server size={14} aria-hidden="true" /> Computer setup
        </button>}
        <a
          className={styles.tertiaryButton}
          href={HETZNER_PROJECTS_URL}
          target="_blank"
          rel="noreferrer"
        >
          Manage in Hetzner <ExternalLink size={13} aria-hidden="true" />
          <span className={styles.srOnly}> (opens in a new tab)</span>
        </a>
        <div className={styles.actionSpacer} />
        <button
          type="button"
          className={`${styles.iconButton} ${styles.disconnectIcon}`}
          aria-label={`Disconnect ${connection.name}`}
          title={`Disconnect ${connection.name}`}
          onClick={onDelete}
        >
          <Trash2 size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`${styles.tertiaryButton} ${styles.disconnectLabelled}`}
          aria-label={`Disconnect project ${connection.name}`}
          onClick={onDelete}
        >
          <Unplug size={14} aria-hidden="true" /> Disconnect project
        </button>
      </div>
    </article>
  );
}
