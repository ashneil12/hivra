"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  HardDrive,
  MemoryStick,
  RefreshCw,
  Server,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { checkGvisorConnection, InfrastructureApiError } from "@/lib/infrastructure/client";
import type {
  HostDiscoveryResult,
  HostDiscoverySnapshot,
  HostEngineRequirement,
  HostIsolationEngineId,
} from "@/lib/infrastructure/host-discovery-contracts";
import {
  hostArchitectureLabel,
  hostDiscoveryOutcome,
  hostOsLabel,
  type HostDiscoveryOutcome,
} from "@/lib/infrastructure/host-discovery-outcome";
import { formatInfrastructureBytes } from "@/lib/infrastructure/formatters";
import type { LaunchOnServerAction } from "@/lib/infrastructure/launch-on-server";
import { tryAgainInMinutes } from "@/lib/retry-after-copy";

import styles from "./Infrastructure.module.css";
import { LaunchOnServerLink, useLaunchOnServer } from "./LaunchOnServer";

const ENGINE_LABELS: Record<HostIsolationEngineId, string> = {
  "proxmox-kvm": "Proxmox VE",
  "qemu-kvm": "QEMU KVM",
  gvisor: "gVisor",
  docker: "Docker",
  containerd: "containerd",
  podman: "Podman",
  "oci-runc": "runc",
  "oci-crun": "crun",
  lxc: "LXC",
};

const REQUIREMENT_LABELS: Partial<Record<HostEngineRequirement, string>> = {
  ROOT_REQUIRED: "a root login",
  LINUX_REQUIRED: "Linux",
  SUPPORTED_OS_REQUIRED: "Ubuntu 22.04 or 24.04",
  SUPPORTED_ARCH_REQUIRED: "an x86 (amd64) processor",
  PACKAGE_MANAGER_REQUIRED: "the apt package manager",
  ENGINE_VERSION_UNSUPPORTED: "Proxmox VE 8 or 9",
  CGROUP_V2_REQUIRED: "cgroup v2",
  KVM_REQUIRED: "KVM",
};

export function supportsStrictProxmoxDiscovery(result: HostDiscoveryResult): boolean {
  if (!result.ok) return false;
  const engine = result.snapshot.engines.find((candidate) => candidate.id === "proxmox-kvm");
  return engine?.availability === "installed" && engine.supported;
}

export function supportsGvisorDiscovery(result: HostDiscoveryResult): boolean {
  if (!result.ok) return false;
  const engine = result.snapshot.engines.find((candidate) => candidate.id === "gvisor");
  return engine?.supported === true && (engine.availability === "installed" || engine.availability === "installable");
}

function environmentLabel(value: HostDiscoverySnapshot["host"]["environment"]["virtualization"]): string {
  switch (value) {
    case "bare-metal": return "Bare metal";
    case "virtual-machine": return "Virtual machine";
    case "container": return "Container";
    default: return "Unknown";
  }
}

function capacityLabel(value: number | null, suffix: string): string {
  return value === null ? "Unknown" : `${value} ${suffix}`;
}

type GvisorCheckFailure = { message: string; next: "inspect" | "repair" | "retry" | "wait" };

/** One plain sentence for a failed read-only Linux Sandbox check. */
function gvisorCheckFailure(error: unknown, hostName: string | undefined): GvisorCheckFailure {
  const name = hostName?.trim() || "This server";
  const named = hostName?.trim() || "this server";
  if (error instanceof InfrastructureApiError) {
    if (error.status === 429) {
      return {
        message: `Hivra checked ${named} a moment ago. ${error.retryAfterSeconds !== null ? tryAgainInMinutes(error.retryAfterSeconds) : "Wait a minute, then try again."}`,
        next: "wait",
      };
    }
    if (error.code === "discovery_required") {
      return { message: `Hivra's last look at ${named} has expired. Inspect it again, then check readiness.`, next: "inspect" };
    }
    if (error.code === "unsupported") {
      return { message: `${name} no longer meets Linux Sandbox's requirements. Inspect it again to see what changed.`, next: "inspect" };
    }
    if (error.code === "remote_failed") {
      return { message: `Linux Sandbox setup on ${named} didn't pass its check. Reinstall the setup to repair it.`, next: "repair" };
    }
    return { message: error.message, next: "retry" };
  }
  return { message: error instanceof Error ? error.message : "The readiness check could not finish.", next: "retry" };
}

export function InfrastructureHostDiscoveryResult({
  result,
  hostName,
  sshUser,
  connectionId,
  onRetry,
  onDone,
  onStrictPreflightRequested,
  onGvisorSetupRequested,
  onConnectAsRootRequested,
  onGvisorReady,
  retrying = false,
}: {
  result: HostDiscoveryResult;
  /** The connection's name, so the outcome can say which server it means. */
  hostName?: string;
  /** The SSH user Hivra signed in as. */
  sshUser?: string;
  connectionId?: string;
  onRetry: () => void;
  onDone: () => void;
  onStrictPreflightRequested?: () => void;
  /** Opens the shared review dialog for Linux Sandbox setup. */
  onGvisorSetupRequested?: (mode: "prepare" | "repair") => void;
  /** Opens the connection's settings to change its SSH user. */
  onConnectAsRootRequested?: () => void;
  /** Called when this dialog's own readiness check came back ready. */
  onGvisorReady?: (targetId: string) => void;
  retrying?: boolean;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [checking, setChecking] = useState(false);
  const [readyTargetId, setReadyTargetId] = useState<string | null>(null);
  const [checkFailure, setCheckFailure] = useState<GvisorCheckFailure | null>(null);
  const launch = useLaunchOnServer();
  const name = hostName?.trim() || "This server";

  useEffect(() => {
    headingRef.current?.focus();
  }, [result, readyTargetId]);

  if (!result.ok) {
    return (
      <section className={`${styles.resultPanel} ${styles.resultError}`} aria-labelledby="host-discovery-title">
        <div className={styles.resultHero}>
          <span className={styles.resultIcon} aria-hidden="true"><AlertTriangle size={22} /></span>
          <div>
            <span className={styles.eyebrow}>Inspection needs attention</span>
            <h2 ref={headingRef} tabIndex={-1} id="host-discovery-title" className={styles.resultTitle}>
              {result.error.message}
            </h2>
            {result.error.remediation ? (
              <p className={styles.resultDescription}>{result.error.remediation}</p>
            ) : null}
          </div>
        </div>
        <div className={styles.resultActions}>
          <button type="button" className={styles.tertiaryButton} onClick={onDone}>Close</button>
          <button type="button" className={styles.primaryButton} onClick={onRetry} disabled={retrying}>
            <RefreshCw size={14} className={retrying ? styles.spin : undefined} aria-hidden="true" />
            {retrying ? "Inspecting…" : "Inspect again"}
          </button>
        </div>
      </section>
    );
  }

  const { snapshot } = result;
  const outcome = hostDiscoveryOutcome(snapshot, { hostName, sshUser });
  const launchAction = readyTargetId ? launch.forGvisorTarget(readyTargetId) : null;
  const gvisorInstalled = outcome.action === "check-gvisor";
  const gvisorSetupAvailable = Boolean(onGvisorSetupRequested && connectionId);

  async function checkReadiness() {
    if (!connectionId) return;
    setChecking(true);
    setCheckFailure(null);
    try {
      const target = await checkGvisorConnection(connectionId);
      if (!target.ready) throw new InfrastructureApiError("The readiness check did not pass.", 502, "remote_failed");
      setReadyTargetId(target.targetId);
      onGvisorReady?.(target.targetId);
    } catch (error) {
      setCheckFailure(gvisorCheckFailure(error, hostName));
    } finally {
      setChecking(false);
    }
  }

  const ready = Boolean(readyTargetId);
  const title = ready ? `${name} is ready for Linux Sandbox.` : outcome.title;
  const detail = ready ? "Launch checks the server again before anything starts." : outcome.detail;
  const toneClass = ready || outcome.ready ? styles.resultReady : styles.resultIncomplete;

  const primary = primaryAction({
    outcome,
    ready,
    launchAction,
    checking,
    retrying,
    connectionId,
    gvisorSetupAvailable,
    onRetry,
    onStrictPreflightRequested,
    onGvisorSetupRequested,
    onConnectAsRootRequested,
    checkReadiness: () => void checkReadiness(),
    checkFailure,
  });

  return (
    <section className={`${styles.resultPanel} ${toneClass}`} aria-labelledby="host-discovery-title">
      <div className={styles.resultHero}>
        <span className={styles.resultIcon} aria-hidden="true">
          {ready || outcome.ready ? <CheckCircle2 size={22} /> : <AlertTriangle size={22} />}
        </span>
        <div>
          <span className={styles.eyebrow}>{ready ? "Ready" : "Inspection complete"}</span>
          <h2 ref={headingRef} tabIndex={-1} id="host-discovery-title" className={styles.resultTitle}>
            {title}
          </h2>
          <p className={styles.resultDescription}>{detail}</p>
        </div>
      </div>

      {checkFailure ? (
        <div className={styles.formError} role="alert">
          <AlertTriangle size={15} aria-hidden="true" />
          <span>{checkFailure.message}</span>
        </div>
      ) : null}

      <TechnicalDetails
        snapshot={snapshot}
        outcome={outcome}
        sshUser={sshUser}
        actions={(
          <>
            <button type="button" className={styles.secondaryButton} onClick={onRetry} disabled={retrying || checking}>
              <RefreshCw size={14} className={retrying ? styles.spin : undefined} aria-hidden="true" />
              {retrying ? "Inspecting…" : "Inspect again"}
            </button>
            {gvisorInstalled && gvisorSetupAvailable && checkFailure?.next !== "repair" ? (
              <button type="button" className={styles.tertiaryButton} onClick={() => onGvisorSetupRequested?.("repair")} disabled={checking}>
                Reinstall Linux Sandbox setup
              </button>
            ) : null}
          </>
        )}
      />

      <div className={styles.resultActions}>
        <button type="button" className={styles.tertiaryButton} onClick={onDone} disabled={checking}>
          {ready ? "Done" : "Not now"}
        </button>
        {primary}
      </div>
    </section>
  );
}

function primaryAction({
  outcome,
  ready,
  launchAction,
  checking,
  retrying,
  connectionId,
  gvisorSetupAvailable,
  onRetry,
  onStrictPreflightRequested,
  onGvisorSetupRequested,
  onConnectAsRootRequested,
  checkReadiness,
  checkFailure,
}: {
  outcome: HostDiscoveryOutcome;
  ready: boolean;
  launchAction: LaunchOnServerAction | null;
  checking: boolean;
  retrying: boolean;
  connectionId?: string;
  gvisorSetupAvailable: boolean;
  onRetry: () => void;
  onStrictPreflightRequested?: () => void;
  onGvisorSetupRequested?: (mode: "prepare" | "repair") => void;
  onConnectAsRootRequested?: () => void;
  checkReadiness: () => void;
  checkFailure: GvisorCheckFailure | null;
}): ReactNode {
  const checkAgain = (
    <button type="button" className={styles.primaryButton} onClick={onRetry} disabled={retrying}>
      <RefreshCw size={14} className={retrying ? styles.spin : undefined} aria-hidden="true" />
      {retrying ? "Inspecting…" : "Check again"}
    </button>
  );
  if (ready && launchAction) return <LaunchOnServerLink action={launchAction} />;
  if (checkFailure?.next === "inspect") return checkAgain;
  if (checkFailure?.next === "repair" && gvisorSetupAvailable) {
    return (
      <button type="button" className={styles.primaryButton} onClick={() => onGvisorSetupRequested?.("repair")}>
        <ShieldCheck size={14} aria-hidden="true" /> Review setup
      </button>
    );
  }
  switch (outcome.action) {
    case "check-proxmox":
      return onStrictPreflightRequested ? (
        <button type="button" className={styles.primaryButton} onClick={onStrictPreflightRequested} disabled={retrying}>
          <ShieldCheck size={14} aria-hidden="true" /> Check Proxmox readiness
        </button>
      ) : checkAgain;
    case "review-gvisor-setup":
      return gvisorSetupAvailable ? (
        <button type="button" className={styles.primaryButton} onClick={() => onGvisorSetupRequested?.("prepare")} disabled={retrying}>
          <ShieldCheck size={14} aria-hidden="true" /> Review setup
        </button>
      ) : checkAgain;
    case "check-gvisor":
      return connectionId ? (
        <button type="button" className={styles.primaryButton} onClick={checkReadiness} disabled={retrying || checking || checkFailure?.next === "wait"}>
          {checking ? <RefreshCw size={14} className={styles.spin} aria-hidden="true" /> : <ShieldCheck size={14} aria-hidden="true" />}
          {checking ? "Checking…" : "Check readiness"}
        </button>
      ) : checkAgain;
    case "connect-as-root":
      return onConnectAsRootRequested ? (
        <button type="button" className={styles.primaryButton} onClick={onConnectAsRootRequested}>
          <UserRound size={14} aria-hidden="true" /> Connect as root
        </button>
      ) : checkAgain;
    default:
      return checkAgain;
  }
}

function TechnicalDetails({
  snapshot,
  outcome,
  sshUser,
  actions,
}: {
  snapshot: HostDiscoverySnapshot;
  outcome: HostDiscoveryOutcome;
  sshUser?: string;
  actions: ReactNode;
}) {
  const memory = snapshot.host.capacity.memoryBytes;
  const storage = snapshot.host.capacity.rootStorageBytes;
  const pathEngine = snapshot.engines.find((engine) => engine.id === (outcome.path === "proxmox" ? "proxmox-kvm" : "gvisor"));
  const missing = (pathEngine?.unmetRequirements ?? [])
    .map((requirement) => REQUIREMENT_LABELS[requirement])
    .filter((label): label is string => Boolean(label));
  const installed = snapshot.engines.filter((engine) => engine.availability === "installed");
  const privilege = snapshot.host.environment.effectivePrivilege;

  return (
    <details className={styles.technicalDetails}>
      <summary>Technical details</summary>
      <div className={styles.technicalDetailsBody}>
        <div className={styles.discoveryIdentity}>
          <span className={styles.providerMark} aria-hidden="true"><Server size={19} /></span>
          <div>
            <span className={styles.sectionLabel}>Detected server</span>
            <strong>{hostOsLabel(snapshot)}</strong>
            <span>{hostArchitectureLabel(snapshot)} · kernel {snapshot.host.kernel.release ?? "unknown"}</span>
          </div>
          <span className={styles.statusBadge}>
            {environmentLabel(snapshot.host.environment.virtualization)}
          </span>
        </div>

        <div className={styles.metricGrid}>
          <DiscoveryMetric
            icon={<Cpu size={16} />}
            label="CPU"
            value={capacityLabel(snapshot.host.capacity.cpu.logicalCores, "logical cores")}
            detail={snapshot.host.kvm.cpuVirtualization ? "CPU virtualization available" : "CPU virtualization unavailable"}
          />
          <DiscoveryMetric
            icon={<MemoryStick size={16} />}
            label="Memory"
            value={memory.available === null ? "Unknown" : `${formatInfrastructureBytes(memory.available)} free`}
            detail={memory.total === null ? "Total unknown" : `${formatInfrastructureBytes(memory.total)} total`}
          />
          <DiscoveryMetric
            icon={<HardDrive size={16} />}
            label="Root storage"
            value={storage.available === null ? "Unknown" : `${formatInfrastructureBytes(storage.available)} free`}
            detail={storage.total === null ? "Total unknown" : `${formatInfrastructureBytes(storage.total)} total`}
          />
          <DiscoveryMetric
            icon={<ShieldCheck size={16} />}
            label="KVM"
            value={snapshot.host.kvm.devicePresent ? "Device available" : "Not available"}
            detail={privilege === "root" ? "Signed in as root" : privilege === "non-root" ? `Signed in as ${sshUser?.trim() || "a user"}, not root` : "Root access unknown"}
          />
        </div>

        <ul className={styles.technicalFacts}>
          <li>
            <strong>{outcome.path === "proxmox" ? "Missing for Proxmox:" : "Missing for Linux Sandbox:"}</strong>{" "}
            {missing.length > 0 ? missing.join(", ") : "nothing"}
          </li>
          <li>
            <strong>Installed:</strong>{" "}
            {installed.length > 0
              ? installed.map((engine) => engine.detectedVersion
                ? `${ENGINE_LABELS[engine.id]} (${engine.detectedVersion})`
                : ENGINE_LABELS[engine.id]).join(", ")
              : "no isolation software Hivra recognizes"}
          </li>
          <li>
            <strong>cgroup:</strong> {snapshot.host.environment.cgroupVersion ? `v${snapshot.host.environment.cgroupVersion}` : "unknown"}
            {" · "}
            <strong>Package managers:</strong> {snapshot.host.environment.packageManagers.join(", ") || "none found"}
          </li>
        </ul>

        <div className={styles.technicalActions}>{actions}</div>
      </div>
    </details>
  );
}

function DiscoveryMetric({
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
