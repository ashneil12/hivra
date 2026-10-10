"use client";

import {
  AlertTriangle,
  Box,
  CheckCircle2,
  Cpu,
  HardDrive,
  MemoryStick,
  Network,
  RefreshCw,
  Server,
  ServerCog,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import type { ProxmoxPreflightResult } from "@/lib/infrastructure/contracts";
import type { LaunchOnServerAction } from "@/lib/infrastructure/launch-on-server";
import {
  formatInfrastructureBytes,
  preflightHeadline,
} from "@/lib/infrastructure/formatters";

import styles from "./Infrastructure.module.css";
import { LaunchOnServerLink, useLaunchOnServer } from "./LaunchOnServer";

type InfrastructurePreflightResultProps = {
  result: ProxmoxPreflightResult;
  onRetry: () => void;
  onDone: () => void;
  onPrepareRequested?: () => void;
  retrying?: boolean;
};

export function InfrastructurePreflightResult({
  result,
  onRetry,
  onDone,
  onPrepareRequested,
  retrying = false,
}: InfrastructurePreflightResultProps) {
  const headline = preflightHeadline(result);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const launch = useLaunchOnServer();
  // Launch appears once the saved target evidence for this connection says
  // ready; the page reloads it right after every check.
  const launchAction = result.ok && result.target.launchReady
    ? launch.forProxmoxConnection(result.connectionId, result.target.externalId)
    : null;

  useEffect(() => {
    headingRef.current?.focus();
  }, [result]);

  if (!result.ok) {
    return (
      <section
        className={`${styles.resultPanel} ${styles.resultError}`}
        aria-labelledby="infrastructure-preflight-title"
      >
        <div className={styles.resultHero}>
          <span className={styles.resultIcon} aria-hidden="true">
            <AlertTriangle size={22} />
          </span>
          <div>
            <span className={styles.eyebrow}>Inspection complete</span>
            <h2 ref={headingRef} tabIndex={-1} id="infrastructure-preflight-title" className={styles.resultTitle}>
              {headline.title}
            </h2>
            <p className={styles.resultDescription}>{headline.detail}</p>
          </div>
        </div>

        {result.error.remediation ? (
          <div className={styles.remediation}>
            <strong>How to fix it</strong>
            <span>{result.error.remediation}</span>
          </div>
        ) : null}

        {result.unmetRequirements.length > 0 ? (
          <div className={styles.requirements}>
            <span className={styles.sectionLabel}>What Hivra found</span>
            <ul>
              {result.unmetRequirements.map((requirement, index) => (
                <li key={`${requirement.code}-${index}`}>
                  <AlertTriangle size={14} aria-hidden="true" />
                  <span>{requirement.message}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <ResultActions
          onRetry={onRetry}
          onDone={onDone}
          onPrepareRequested={onPrepareRequested}
          retrying={retrying}
        />
      </section>
    );
  }

  const { target } = result;
  const toneClass = target.launchReady ? styles.resultReady : styles.resultIncomplete;
  const memory = target.capacity.memoryBytes;
  const storage = target.capacity.storageBytes;
  const cpuUtilization = Math.round(target.capacity.cpu.utilizationRatio * 100);
  const policy = target.capacity.policy;

  return (
    <section
      className={`${styles.resultPanel} ${toneClass}`}
      aria-labelledby="infrastructure-preflight-title"
    >
      <div className={styles.resultHero}>
        <span className={styles.resultIcon} aria-hidden="true">
          {target.launchReady ? <CheckCircle2 size={23} /> : <AlertTriangle size={22} />}
        </span>
        <div>
          <span className={styles.eyebrow}>Read-only inspection complete</span>
          <h2 ref={headingRef} tabIndex={-1} id="infrastructure-preflight-title" className={styles.resultTitle}>
            {headline.title}
          </h2>
          <p className={styles.resultDescription}>{headline.detail}</p>
        </div>
      </div>

      {policy ? (
        <div className={styles.hostSetupBoundary}>
          <strong>{policy.mode === "enforce" ? "Capacity policy ready" : "Capacity policy is observing"}</strong>
          <span>
            {formatInfrastructureBytes(policy.floorMemoryHeadroomBytes)} active floor headroom after a {formatInfrastructureBytes(policy.hostMemoryReserveBytes)} host reserve. {policy.mode === "enforce"
              ? `Active maxima are bounded at ${policy.cpuCeilingDensity}× CPU and ${policy.memoryCeilingDensity}× memory.`
              : "Existing ceiling overcommit is reported without changing or evicting computers."}
          </span>
        </div>
      ) : null}

      <details className={styles.technicalDetails}>
        <summary>Technical details</summary>
        <div className={styles.technicalDetailsBody}>
          <div className={styles.targetIdentity}>
            <div>
              <span className={styles.sectionLabel}>Detected host</span>
              <strong>{target.displayName}</strong>
              <span>Detected platform: Proxmox VE {target.proxmoxVersion}</span>
            </div>
            <span className={styles.isolationBadge}>
              <ShieldCheck size={14} aria-hidden="true" />
              Recommended: Hardware-isolated VM
            </span>
          </div>

          <div className={styles.metricGrid}>
            <ResultMetric
              icon={<Cpu size={16} />}
              label="CPU"
              value={`${target.capacity.cpu.totalCores} cores`}
              detail={`${cpuUtilization}% currently in use`}
            />
            <ResultMetric
              icon={<MemoryStick size={16} />}
              label="Memory"
              value={`${formatInfrastructureBytes(memory.available)} available`}
              detail="After computer reservations and host headroom"
            />
            <ResultMetric
              icon={<HardDrive size={16} />}
              label="Storage"
              value={`${formatInfrastructureBytes(storage.available)} free`}
              detail={`${formatInfrastructureBytes(storage.total)} total`}
            />
            <ResultMetric
              icon={<Box size={16} />}
              label="VM slots"
              value={`${target.capabilities.vmidRange.freeCount} free`}
              detail={`${target.capabilities.vmidRange.start}-${target.capabilities.vmidRange.end}`}
            />
          </div>

          <div className={styles.capabilityGrid}>
            <CapabilityRow
              icon={<Network size={15} />}
              label="Network bridges"
              value={target.capabilities.bridges.join(", ") || "None detected"}
            />
            <CapabilityRow
              icon={<Server size={15} />}
              label="Agent storage"
              value={target.capabilities.storages.join(", ") || "None detected"}
            />
            <CapabilityRow
              icon={<Box size={15} />}
              label="Base image"
              value={
                target.capabilities.template
                  ? target.capabilities.template.ready
                    ? `VM ${target.capabilities.template.vmid} ready`
                    : `VM ${target.capabilities.template.vmid} needs attention`
                  : "Not configured"
              }
            />
            <CapabilityRow
              icon={<ShieldCheck size={15} />}
              label="Hivra host tools"
              value={
                target.capabilities.provisioner
                  ? target.capabilities.provisioner.ready
                    ? `Version ${target.capabilities.provisioner.version ?? "verified"}`
                    : "Needs attention"
                  : "Not configured"
              }
            />
          </div>
        </div>
      </details>

      {result.warnings.length > 0 ? (
        <div className={styles.warningList}>
          <span className={styles.sectionLabel}>
            {target.launchReady ? "Before you launch" : "Before preparation"}
          </span>
          <ul>
            {result.warnings.map((warning, index) => (
              <li key={`${warning}-${index}`}>
                <AlertTriangle size={14} aria-hidden="true" />
                <span>{warning}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <ResultActions
        onRetry={onRetry}
        onDone={onDone}
        onPrepareRequested={!target.launchReady ? onPrepareRequested : undefined}
        launchAction={launchAction}
        retrying={retrying}
      />
    </section>
  );
}

function ResultMetric({
  icon,
  label,
  value,
  detail,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className={styles.metricCard}>
      <span className={styles.metricIcon} aria-hidden="true">{icon}</span>
      <span className={styles.sectionLabel}>{label}</span>
      <strong>{value}</strong>
      <span>{detail}</span>
    </div>
  );
}

function CapabilityRow({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className={styles.capabilityRow}>
      <span aria-hidden="true">{icon}</span>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ResultActions({
  onRetry,
  onDone,
  onPrepareRequested,
  launchAction = null,
  retrying,
}: {
  onRetry: () => void;
  onDone: () => void;
  onPrepareRequested?: () => void;
  launchAction?: LaunchOnServerAction | null;
  retrying: boolean;
}) {
  return (
    <div className={styles.resultActions}>
      <button
        type="button"
        className={styles.secondaryButton}
        onClick={onRetry}
        disabled={retrying}
      >
        <RefreshCw size={14} className={retrying ? styles.spin : undefined} aria-hidden="true" />
        {retrying ? "Checking…" : "Check again"}
      </button>
      {onPrepareRequested ? (
        <>
          <button type="button" className={styles.tertiaryButton} onClick={onDone}>Not now</button>
          <button type="button" className={styles.primaryButton} onClick={onPrepareRequested}>
            <ServerCog size={14} aria-hidden="true" /> Review setup
          </button>
        </>
      ) : launchAction ? (
        <>
          <button type="button" className={styles.tertiaryButton} onClick={onDone}>Done</button>
          <LaunchOnServerLink action={launchAction} />
        </>
      ) : (
        <button type="button" className={styles.primaryButton} onClick={onDone}>
          Done
        </button>
      )}
    </div>
  );
}
