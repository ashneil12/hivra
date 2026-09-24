"use client";

import {
  AlertTriangle,
  Check,
  KeyRound,
  Loader2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Server,
  ServerCog,
  ShieldCheck,
  Trash2,
  Unplug,
} from "lucide-react";

import {
  isGvisorDeploymentTarget,
  isProxmoxDeploymentTarget,
  type DeploymentTargetDto,
  type GvisorDeploymentTargetDto,
  type ProxmoxDeploymentTargetDto,
  type SshInfrastructureConnectionDto,
  type ProxmoxPreflightResult,
} from "@/lib/infrastructure/contracts";
import {
  connectionPresentation,
  formatInfrastructureBytes,
  formatInfrastructureDate,
  preflightHeadline,
} from "@/lib/infrastructure/formatters";
import { hasReadyEvidence } from "@/lib/infrastructure/launch-on-server";
import { canPrepareFromSavedTarget } from "@/lib/infrastructure/preparation-eligibility";

import styles from "./Infrastructure.module.css";
import { LaunchOnServerLink, useTargetLaunchAction } from "./LaunchOnServer";


type InfrastructureConnectionCardProps = {
  connection: SshInfrastructureConnectionDto;
  savedTarget?: DeploymentTargetDto;
  latestPreflight?: ProxmoxPreflightResult;
  checking?: boolean;
  onCheck: () => void;
  /** Inspects the server, then runs the strict Linux Sandbox check. */
  onCheckReadiness?: () => void;
  onPrepare: () => void;
  onEdit: () => void;
  onDelete: () => void;
};

export function InfrastructureConnectionCard({
  connection,
  savedTarget,
  latestPreflight,
  checking = false,
  onCheck,
  onCheckReadiness,
  onPrepare,
  onEdit,
  onDelete,
}: InfrastructureConnectionCardProps) {
  const base = connectionPresentation(connection);
  const latest = latestPreflight ? preflightHeadline(latestPreflight) : null;
  // A local connection edit or in-flight check can invalidate a previously
  // ready target before the registry refresh completes. Never reuse that
  // cached readiness while the connection itself is no longer ready.
  const connectionTrusted = connection.status === "ready" || connection.status === "error";
  const trustedSavedTarget: ProxmoxDeploymentTargetDto | undefined = connectionTrusted
    && savedTarget && isProxmoxDeploymentTarget(savedTarget)
    && savedTarget.connectionId === connection.id
    ? savedTarget
    : undefined;
  // A Linux host prepared for gVisor publishes its own target kind. It runs
  // Linux Sandbox only, so it gets its own badge instead of "Ready for agents".
  const gvisorTarget: GvisorDeploymentTargetDto | undefined = connectionTrusted
    && savedTarget && isGvisorDeploymentTarget(savedTarget)
    && savedTarget.connectionId === connection.id
    ? savedTarget
    : undefined;
  const savedTargetReady = Boolean(
    connection.status === "ready" &&
    trustedSavedTarget?.status === "ready" &&
    trustedSavedTarget.capabilities.launchReady,
  );
  // Linux Sandbox was set up and passed a check. The server accepts a launch
  // only within 15 minutes of that check, so readiness also needs it fresh.
  const gvisorSetUp = Boolean(
    connection.status === "ready" && gvisorTarget && hasReadyEvidence(gvisorTarget),
  );
  // Only saved, ready evidence earns the launch action, never a local check
  // result that the registry hasn't published yet. It lapses on its own.
  const targetLaunch = useTargetLaunchAction(
    savedTargetReady ? trustedSavedTarget : gvisorSetUp ? gvisorTarget : null,
  );
  const gvisorReady = gvisorSetUp && targetLaunch !== null;
  const gvisorCheckLapsed = gvisorSetUp && targetLaunch === null;
  const savedTargetIncomplete = Boolean(
    (trustedSavedTarget && !savedTargetReady) || (gvisorTarget && !gvisorSetUp),
  );
  const discoveryOnly = Boolean(
    connection.status === "pending" && connection.lastCheckedAt && !latest && !savedTarget,
  );
  const canPrepareRecommendedSetup = canPrepareFromSavedTarget(connection, trustedSavedTarget);
  const launchAction = !checking && connection.status === "ready" ? targetLaunch : null;
  const tone = checking
    ? "checking"
    : latest?.tone === "ready"
      ? "connected"
      : latest?.tone === "error"
        ? "error"
        : latest?.tone === "incomplete"
          ? "checking"
          : savedTargetReady || gvisorReady
            ? "connected"
            : savedTargetIncomplete || gvisorCheckLapsed
              ? "checking"
              : discoveryOnly
                ? "checking"
                : base.tone;
  const statusLabel = checking
    ? "Inspecting"
    : latest?.tone === "ready"
      ? "Ready for agents"
      : latest?.tone === "incomplete"
        ? "Setup incomplete"
        : latest?.tone === "error"
          ? "Needs attention"
          : savedTargetReady
            ? "Ready for agents"
            : gvisorReady
              ? "Ready for Linux Sandbox"
              : gvisorCheckLapsed
                ? "Needs a check"
                : savedTargetIncomplete
                ? "Setup incomplete"
                : discoveryOnly
                  ? "Needs setup"
                  : base.label;
  const host = connection.endpoint.sshHost.includes(":")
    ? `[${connection.endpoint.sshHost}]:${connection.endpoint.sshPort}`
    : `${connection.endpoint.sshHost}:${connection.endpoint.sshPort}`;

  return (
    <article className={styles.connectionCard}>
      <div className={styles.connectionCardHeader}>
        <span className={styles.providerMark} aria-hidden="true">
          <Server size={19} />
        </span>
        <div className={styles.connectionIdentity}>
          <span className={styles.eyebrow}>My server</span>
          <h2>{connection.name}</h2>
        </div>
        <span className={`${styles.statusBadge} ${styles[`status_${tone}`]}`}>
          {checking ? <Loader2 size={12} className={styles.spin} aria-hidden="true" /> : null}
          {statusLabel}
        </span>
      </div>

      <div className={styles.connectionMeta}>
        <div>
          <span>SSH endpoint</span>
          <strong>{connection.endpoint.sshUser}@{host}</strong>
        </div>
        <div>
          <span>Setup</span>
          <strong>{connection.setupMode === "simple" ? "Recommended" : "Custom"}</strong>
        </div>
        <div>
          <span>Last host check</span>
          <strong>{formatInfrastructureDate(connection.lastCheckedAt)}</strong>
        </div>
      </div>

      <div className={styles.connectionEvidence}>
        <span className={styles.connectionEvidenceIcon} aria-hidden="true">
          {tone === "error" ? <AlertTriangle size={15} /> : <KeyRound size={15} />}
        </span>
        <div>
          <strong>
            {connection.credentialsConfigured ? "Credential stored securely" : "Credential required"}
          </strong>
          <span>
            {latest?.detail
              ?? (savedTargetReady
                ? "Agents and computers can run here. Launch checks the server again before anything starts."
                : gvisorReady
                  ? "Linux Sandbox can run here. A check is good for 15 minutes; after that, check again before you launch."
                  : gvisorCheckLapsed
                    ? "Linux Sandbox is set up here. Its last check is more than 15 minutes old, so check again before you launch."
                    : gvisorTarget
                    ? "The last Linux Sandbox check didn't pass. Inspect the server again to see what it needs."
                    : savedTargetIncomplete
                      ? trustedSavedTarget?.capabilities.issues[0]?.message
                        ?? "Hivra inspected this server, but it isn't ready to launch yet."
                      : discoveryOnly
                        ? "Hivra reached this server. Inspect it again to see its next step."
                        : base.detail)}
          </span>
        </div>
      </div>

      {trustedSavedTarget ? (
        <div className={styles.savedTargetEvidence}>
          <div className={styles.savedTargetHeading}>
            <div>
              <span className={styles.sectionLabel}>Latest readiness</span>
              <strong>{trustedSavedTarget.displayName}</strong>
            </div>
            <span>{formatInfrastructureDate(trustedSavedTarget.lastPreflightAt)}</span>
          </div>
          <div className={styles.savedTargetFacts}>
            <span>
              <small>CPU</small>
              <strong>{trustedSavedTarget.capacity.cpu.totalCores === null
                ? "Unknown"
                : `${trustedSavedTarget.capacity.cpu.totalCores} cores`}</strong>
            </span>
            <span>
              <small>Memory free</small>
              <strong>{trustedSavedTarget.capacity.memoryBytes.available === null
                ? "Unknown"
                : formatInfrastructureBytes(trustedSavedTarget.capacity.memoryBytes.available)}</strong>
            </span>
            <span>
              <small>Network</small>
              <strong>{trustedSavedTarget.capabilities.selectedBridge ?? "Not selected"}</strong>
            </span>
            {trustedSavedTarget.capacity.policy ? (
              <>
                <span>
                  <small>Active floor headroom</small>
                  <strong>{formatInfrastructureBytes(trustedSavedTarget.capacity.policy.floorMemoryHeadroomBytes)}</strong>
                </span>
                <span>
                  <small>Ceiling policy</small>
                  <strong>{trustedSavedTarget.capacity.policy.mode === "enforce"
                    ? `${trustedSavedTarget.capacity.policy.cpuCeilingDensity}× CPU / ${trustedSavedTarget.capacity.policy.memoryCeilingDensity}× memory`
                    : "Observation only"}</strong>
                </span>
              </>
            ) : null}
          </div>
          {trustedSavedTarget.capacity.policy ? (
            <span className={styles.connectionCapacityNote}>
              {formatInfrastructureBytes(trustedSavedTarget.capacity.policy.activeFloorMemoryBytes)} active memory floors · {formatInfrastructureBytes(trustedSavedTarget.capacity.policy.hostMemoryReserveBytes)} reserved for Proxmox
            </span>
          ) : null}
        </div>
      ) : gvisorTarget ? (
        <div className={styles.savedTargetEvidence}>
          <div className={styles.savedTargetHeading}>
            <div>
              <span className={styles.sectionLabel}>Latest Linux Sandbox check</span>
              <strong>{gvisorTarget.displayName}</strong>
            </div>
            <span>{formatInfrastructureDate(gvisorTarget.lastPreflightAt)}</span>
          </div>
          <div className={styles.savedTargetFacts}>
            <span>
              <small>CPU</small>
              <strong>{gvisorTarget.capacity.cpu.totalCores === null
                ? "Unknown"
                : `${gvisorTarget.capacity.cpu.totalCores} cores`}</strong>
            </span>
            <span>
              <small>Memory free</small>
              <strong>{gvisorTarget.capacity.memoryBytes.available === null
                ? "Unknown"
                : formatInfrastructureBytes(gvisorTarget.capacity.memoryBytes.available)}</strong>
            </span>
            <span>
              <small>Runs</small>
              <strong>Linux Sandbox</strong>
            </span>
          </div>
        </div>
      ) : null}

      <div className={styles.cardActions}>
        {launchAction ? (
          <LaunchOnServerLink action={launchAction} />
        ) : gvisorCheckLapsed && onCheckReadiness ? (
          <button type="button" className={styles.primaryButton} onClick={onCheckReadiness} disabled={checking}>
            <ShieldCheck size={14} aria-hidden="true" /> Check readiness
          </button>
        ) : canPrepareRecommendedSetup ? (
          <button type="button" className={styles.primaryButton} onClick={onPrepare} disabled={checking}>
            <ServerCog size={14} aria-hidden="true" /> Review setup
          </button>
        ) : null}
        <button type="button" className={styles.secondaryButton} onClick={onCheck} disabled={checking}>
          {checking ? (
            <Loader2 size={14} className={styles.spin} aria-hidden="true" />
          ) : (
            <RefreshCw size={14} aria-hidden="true" />
          )}
          {checking ? "Inspecting..." : "Inspect again"}
        </button>
        <button type="button" className={styles.tertiaryButton} onClick={onEdit}>
          <Pencil size={14} aria-hidden="true" /> Edit
        </button>
        <div className={styles.actionSpacer} />
        <button
          type="button"
          className={`${styles.iconButton} ${styles.disconnectIcon}`}
          aria-label={`Delete ${connection.name}`}
          title={`Delete ${connection.name}`}
          onClick={onDelete}
        >
          <Trash2 size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`${styles.tertiaryButton} ${styles.disconnectLabelled}`}
          aria-label={`Disconnect host ${connection.name}`}
          onClick={onDelete}
        >
          <Unplug size={14} aria-hidden="true" /> Disconnect host
        </button>
      </div>

      <span className={styles.decorativeDots} aria-hidden="true">
        <MoreHorizontal size={18} />
        {tone === "connected" ? <Check size={13} /> : null}
      </span>
    </article>
  );
}
