"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  ExternalLink,
  KeyRound,
  Loader2,
  PlugZap,
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
import { hetznerCapacitySlotReason, type HetznerCloudCapacitySlotDto } from "@/lib/infrastructure/hetzner-cloud-token-contracts";
import {
  hetznerCreatedServerFor,
  isProviderComputerSetupTerminal,
  type HetznerCloudCreatedServer,
  type ProviderComputerSetupView,
} from "@/lib/infrastructure/provider-computer-setup-contracts";
import type { PortableLaunchResourceId } from "@/lib/hivra/launch-navigation";
import { launchOnProviderServer } from "@/lib/infrastructure/launch-on-server";

import { hasSavedCapacityRequest } from "./HetznerCloudCapacityDialog";
import { LaunchOnServerLink, useLaunchOnServer } from "./LaunchOnServer";
import styles from "./Infrastructure.module.css";

const HETZNER_PROJECTS_URL = "https://console.hetzner.com/projects";

/** Whether Hivra's own records of what it created here have been read. */
export type HetznerSetupEvidenceStatus = "loading" | "loaded" | "failed";

type HetznerCloudConnectionCardProps = {
  connection: HetznerCloudConnectionDto;
  inventory: HetznerCloudServerInventoryDto[];
  /** Saved setup for servers Hivra created through this connection. */
  setups?: ProviderComputerSetupView[];
  /** Every server request Hivra sent through this connection. */
  createdServers?: HetznerCloudCreatedServer[];
  /** No server is called "Not created by Hivra" until this is "loaded". */
  setupEvidence?: HetznerSetupEvidenceStatus;
  onRetrySetupEvidence?: () => void;
  slot?: HetznerCloudCapacitySlotDto | null;
  loading: boolean;
  error?: string | null;
  launchResourceId?: PortableLaunchResourceId | null;
  unifiedLaunchReturn?: boolean;
  onCreateCapacity: () => void;
  onCleanup?: () => void;
  onSetup?: (orderId?: string) => void;
  onReplaceToken?: () => void;
  onConnectExistingServer?: (server: HetznerCloudServerInventoryDto) => void;
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
    return "Hetzner rejected this project token. Replace it with a new Read & Write token from the same project; your servers keep running.";
  }
  if (code === "provider_response_invalid") {
    return "Hetzner returned a server list Hivra couldn't safely accept.";
  }
  return "The latest Hetzner server sync didn't finish.";
}

type Readiness = {
  label: string | null;
  tone: "connected" | "checking" | "error" | "pending";
  hint: string;
};

/**
 * One truthful line about what Hivra can do with a server in this project,
 * from Hivra's own records only. "Not created by Hivra" is said only once
 * those records have loaded and none of them names this server; while they
 * load, or when they can't be read, the server gets no provenance line.
 */
function serverReadiness(
  setup: ProviderComputerSetupView | undefined,
  createdBy: HetznerCloudCreatedServer | null,
  evidence: HetznerSetupEvidenceStatus,
): Readiness | null {
  if (setup) return setupReadiness(setup);
  if (createdBy) {
    switch (createdBy.status) {
      case "creating":
      case "ambiguous":
        return { label: "Created by Hivra", tone: "checking", hint: "Hivra is still confirming how this server's creation ended." };
      case "cleaning":
        return { label: "Created by Hivra", tone: "checking", hint: "Hivra is removing this server." };
      case "cleanup_abandoned":
        return { label: "Created by Hivra", tone: "error", hint: "Hivra stopped removing this server. Check it in Hetzner Console; Hetzner bills it until it's deleted." };
      case "provider_rejected":
        return { label: "Created by Hivra", tone: "error", hint: "Hetzner reported this request as refused, but a server with its name exists. Check it in Hetzner Console." };
      default:
        return { label: "Created by Hivra", tone: "pending", hint: "Open Computer setup to see how far its setup got." };
    }
  }
  if (evidence === "loaded") {
    return { label: null, tone: "pending", hint: "Not created by Hivra — connect with the setup command." };
  }
  if (evidence === "loading") {
    return { label: null, tone: "pending", hint: "Checking whether Hivra created this server…" };
  }
  return null;
}

function setupReadiness(setup: ProviderComputerSetupView): Readiness {
  if (setup.stage === "environment_prepared" && setup.launchReady) {
    return { label: "Ready for agents", tone: "connected", hint: "Set up by Hivra. Launch checks it again before anything starts." };
  }
  switch (setup.stage) {
    case "not_requested":
      return { label: "No agent setup", tone: "pending", hint: "Created as a plain server. Hivra won't set it up for agents." };
    case "expired":
      return { label: "Setup window expired", tone: "error", hint: "Its one-time setup key expired. Remove it with Remove created server before creating another." };
    case "stopped":
      return { label: "Setup stopped", tone: "error", hint: "Setup was stopped. The server and its saved state are kept." };
    case "retired":
      return { label: "Removed", tone: "pending", hint: "Removed through Hivra. Reference only." };
    case "firewall_outcome_unknown":
    case "power_outcome_unknown":
      return { label: "Needs a check", tone: "error", hint: "Hetzner didn't confirm the last setup step. Check the server in Hetzner Console." };
    default:
      return { label: "Needs setup", tone: "checking", hint: "Created by Hivra. Finish setup so agents can run here." };
  }
}

export function HetznerCloudConnectionCard({
  connection,
  inventory,
  setups = [],
  createdServers = [],
  setupEvidence = "loading",
  onRetrySetupEvidence,
  slot = null,
  loading,
  error,
  launchResourceId = null,
  unifiedLaunchReturn = false,
  onCreateCapacity,
  onCleanup,
  onSetup,
  onReplaceToken,
  onConnectExistingServer,
  onRefresh,
  onDelete,
}: HetznerCloudConnectionCardProps) {
  const launch = useLaunchOnServer();
  const lastCheckedAt = inventory.reduce<string | null>((latest, server) => {
    if (!latest || Date.parse(server.discoveredAt) > Date.parse(latest)) {
      return server.discoveredAt;
    }
    return latest;
  }, connection.lastCheckedAt);
  const syncIssue = connection.status === "error" || Boolean(error);
  const tokenRejected = connection.status === "error" && connection.lastErrorCode === "invalid_credentials";
  const visibleError = error ?? (
    connection.status === "error"
      ? persistedSyncError(connection.lastErrorCode)
      : null
  );
  const setupByServer = new Map(setups
    .filter((setup) => setup.providerServerId)
    .map((setup) => [setup.providerServerId as string, setup]));
  const slotUsed = Boolean(slot?.held);
  // A request this browser sent but never resolved stays checkable even while
  // it holds the slot; checking it can't buy a second server.
  const savedRequest = hasSavedCapacityRequest(connection.id);

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
          {tokenRejected ? "Token rejected" : syncIssue ? "Sync issue" : "Connected"}
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
            Hivra uses a Read &amp; Write token, which can change this Hetzner project.
            It is never returned to the browser. Replace it here any time, or revoke it
            in Hetzner.
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

      {setupEvidence === "failed" && inventory.length > 0 ? (
        <div className={styles.providerInventoryError} role="alert">
          <AlertTriangle size={15} aria-hidden="true" />
          <span>Hivra couldn&apos;t load which of these servers it created or how far their setup got.</span>
          {onRetrySetupEvidence ? (
            <button type="button" onClick={onRetrySetupEvidence}>
              <RefreshCw size={13} aria-hidden="true" /> Try again
            </button>
          ) : null}
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
            const setup = setupByServer.get(server.providerResourceId);
            const createdBy = hetznerCreatedServerFor(createdServers, server);
            const readiness = serverReadiness(setup, createdBy, setupEvidence);
            const readyTargetId = setup?.stage === "environment_prepared" && setup.launchReady ? setup.targetId : null;
            // Setup steps need a working project token; replace it first.
            const canContinueSetup = Boolean(setup && !isProviderComputerSetupTerminal(setup) && onSetup
              && connection.status === "ready");
            // Only a server Hivra's loaded records don't name is someone else's.
            const canConnect = setupEvidence === "loaded" && !setup && !createdBy && onConnectExistingServer
              && (server.publicNetwork.ipv4 || server.publicNetwork.ipv6);
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
                {/* A setup or a loaded record always yields a line; a failed read yields none. */}
                {readiness ? (
                  <div className={styles.providerServerReadiness}>
                    {readiness.label ? (
                      <span className={`${styles.statusBadge} ${styles[`status_${readiness.tone}`]}`}>{readiness.label}</span>
                    ) : null}
                    <span>{readiness.hint}</span>
                    {readyTargetId ? (
                      <LaunchOnServerLink
                        action={launchResourceId
                          ? launchOnProviderServer(readyTargetId, { source: "handoff", resourceId: launchResourceId, unified: unifiedLaunchReturn })
                          : launch.forProviderServer(readyTargetId)}
                      />
                    ) : canContinueSetup && setup ? (
                      <button type="button" className={styles.primaryButton} onClick={() => onSetup?.(setup.orderId)}>
                        {setup.stage === "awaiting_setup" ? "Start setup" : "Continue setup"}
                      </button>
                    ) : canConnect ? (
                      <button type="button" className={styles.secondaryButton} onClick={() => onConnectExistingServer?.(server)}>
                        <PlugZap size={14} aria-hidden="true" /> Connect this server
                      </button>
                    ) : null}
                  </div>
                ) : null}
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
              Choose a size and location in Hivra and review Hetzner&apos;s price. Hivra
              creates the server and sets it up for agents.
            </span>
          </div>
        </div>
      )}

      {slotUsed && !savedRequest ? (
        <p className={styles.providerCreateReason} role="note">{hetznerCapacitySlotReason(slot)}</p>
      ) : null}

      <div className={styles.cardActions}>
        {tokenRejected && onReplaceToken ? (
          <button type="button" className={styles.primaryButton} onClick={onReplaceToken}>
            <KeyRound size={14} aria-hidden="true" /> Replace token
          </button>
        ) : null}
        <button
          type="button"
          className={tokenRejected ? styles.secondaryButton : styles.primaryButton}
          onClick={onCreateCapacity}
          disabled={slotUsed && !savedRequest}
        >
          <Cloud size={14} aria-hidden="true" /> {savedRequest ? "Check saved request" : "Create cloud server"}
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
        {/* Computer setup reads its own list, so it stays reachable when the card's read failed. */}
        {onSetup && (setups.length > 0 || setupEvidence === "failed") && <button type="button" className={styles.secondaryButton} onClick={() => onSetup()}>
          <Server size={14} aria-hidden="true" /> Computer setup
        </button>}
        {!tokenRejected && onReplaceToken ? (
          <button type="button" className={styles.secondaryButton} onClick={onReplaceToken}>
            <KeyRound size={14} aria-hidden="true" /> Replace token
          </button>
        ) : null}
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
