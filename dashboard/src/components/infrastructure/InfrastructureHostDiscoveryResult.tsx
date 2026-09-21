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
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import type {
  HostDiscoveryEngine,
  HostDiscoveryResult,
  HostDiscoverySnapshot,
  HostIsolationEngineId,
} from "@/lib/infrastructure/host-discovery-contracts";
import { formatInfrastructureBytes } from "@/lib/infrastructure/formatters";

import styles from "./Infrastructure.module.css";

const ENGINE_LABELS: Record<HostIsolationEngineId, string> = {
  "proxmox-kvm": "Proxmox KVM",
  "qemu-kvm": "QEMU KVM",
  gvisor: "gVisor",
  docker: "Docker",
  containerd: "containerd",
  podman: "Podman",
  "oci-runc": "OCI runc",
  "oci-crun": "OCI crun",
  lxc: "LXC",
};

const ENGINE_PRIORITY: HostIsolationEngineId[] = [
  "proxmox-kvm",
  "qemu-kvm",
  "gvisor",
  "containerd",
  "podman",
  "docker",
  "lxc",
  "oci-crun",
  "oci-runc",
];

type EngineRecommendation = {
  engine: HostDiscoveryEngine | null;
  supported: boolean;
  title: string;
  detail: string;
};

function engineRecommendation(snapshot: HostDiscoverySnapshot): EngineRecommendation {
  const byId = new Map(snapshot.engines.map((engine) => [engine.id, engine]));
  const strictProxmox = byId.get("proxmox-kvm");
  if (
    strictProxmox?.availability === "installed"
    && strictProxmox.supported
  ) {
    return {
      engine: strictProxmox,
      supported: true,
      title: "Use Proxmox KVM",
      detail: "Proxmox is the installed management layer and KVM supplies the hardware-VM isolation boundary. Hardware VM does not mean dedicated physical hardware. Run strict readiness before preparation or launch.",
    };
  }

  const gvisor = byId.get("gvisor");
  if (gvisor?.supported && (gvisor.availability === "installed" || gvisor.availability === "installable")) {
    return {
      engine: gvisor,
      supported: true,
      title: gvisor.availability === "installed" ? "Check the gVisor sandbox runtime" : "Prepare gVisor for Linux Sandbox",
      detail: "This supported path runs non-root Linux terminal and Python application workspaces with an application-kernel boundary. It does not provide a hardware VM, graphical desktop, Windows, public ports, host mounts, devices, or privileged access.",
    };
  }

  const candidate = ENGINE_PRIORITY
    .map((id) => byId.get(id))
    .find((engine) => engine?.availability === "installed" || engine?.availability === "installable")
    ?? null;

  if (candidate?.id === "proxmox-kvm" && candidate.availability === "installable") {
    const nestedKvmMissing = snapshot.host.environment.virtualization === "virtual-machine"
      && !snapshot.host.kvm.devicePresent;
    return {
      engine: candidate,
      supported: false,
      title: "Proxmox KVM could be installed, but is not supported by this flow yet",
      detail: nestedKvmMissing
        ? "This Linux virtual machine does not expose nested KVM, so it cannot provide hardware VMs here. Hivra does not install Proxmox or change the host from this flow."
        : "Hivra detected a possible Proxmox KVM candidate, but automatic installation is not supported. Install and operate Proxmox separately, then reconnect for strict readiness.",
    };
  }

  if (candidate) {
    const detail = candidate.id === "gvisor"
      ? "gVisor is a Linux application sandbox, not a general desktop or Windows VM. It was detected, but Hivra cannot launch workloads with gVisor yet."
      : "This is detected host capability, not a Hivra recommendation. Hivra does not yet have a supported preparation and lifecycle path for this engine.";
    return {
      engine: candidate,
      supported: false,
      title: `${ENGINE_LABELS[candidate.id]} detected, but not supported yet`,
      detail,
    };
  }

  if (
    snapshot.host.environment.virtualization === "virtual-machine"
    && !snapshot.host.kvm.devicePresent
  ) {
    return {
      engine: null,
      supported: false,
      title: "Nested KVM is not available on this virtual machine",
      detail: "Hivra can inspect this Linux host, but it cannot run Proxmox KVM hardware VMs here. Use an existing Proxmox environment, bare metal with KVM, or a provider-VM path supported for the workload.",
    };
  }

  return {
    engine: null,
    supported: false,
    title: "No supported isolation engine is available",
    detail: "Hivra inspected this host successfully, but it cannot recommend a supported preparation path yet. Nothing on the host was changed.",
  };
}

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

function hostOsLabel(snapshot: HostDiscoverySnapshot): string {
  const { os } = snapshot.host;
  if (os.family === "unknown") return "Unknown operating system";
  const id = os.id
    ? os.id.charAt(0).toUpperCase() + os.id.slice(1)
    : "Linux";
  return os.versionId ? `${id} ${os.versionId}` : id;
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

export function InfrastructureHostDiscoveryResult({
  result,
  onRetry,
  onDone,
  onStrictPreflightRequested,
  connectionId,
  retrying = false,
}: {
  result: HostDiscoveryResult;
  onRetry: () => void;
  onDone: () => void;
  onStrictPreflightRequested?: () => void;
  connectionId?: string;
  retrying?: boolean;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [gvisorOperation, setGvisorOperation] = useState<"preflight" | "prepare" | null>(null);
  const [gvisorResult, setGvisorResult] = useState<string | null>(null);
  const [gvisorError, setGvisorError] = useState<string | null>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, [result]);

  if (!result.ok) {
    return (
      <section className={`${styles.resultPanel} ${styles.resultError}`} aria-labelledby="host-discovery-title">
        <div className={styles.resultHero}>
          <span className={styles.resultIcon} aria-hidden="true"><AlertTriangle size={22} /></span>
          <div>
            <span className={styles.eyebrow}>Inspection needs attention</span>
            <h2 ref={headingRef} tabIndex={-1} id="host-discovery-title" className={styles.resultTitle}>
              Hivra could not inspect this host.
            </h2>
            <p className={styles.resultDescription}>{result.error.message}</p>
          </div>
        </div>
        {result.error.remediation ? (
          <div className={styles.remediation}>
            <strong>How to fix it</strong>
            <span>{result.error.remediation}</span>
          </div>
        ) : null}
        <DiscoveryActions onRetry={onRetry} onDone={onDone} retrying={retrying} />
      </section>
    );
  }

  const { snapshot } = result;
  const recommendation = engineRecommendation(snapshot);
  const strictProxmox = supportsStrictProxmoxDiscovery(result);
  const gvisorSupported = supportsGvisorDiscovery(result);
  const gvisorEngine = snapshot.engines.find(candidate => candidate.id === "gvisor");
  const gvisorInstalled = gvisorSupported
    && gvisorEngine?.availability === "installed"
    && Boolean(gvisorEngine.detectedVersion);
  const memory = snapshot.host.capacity.memoryBytes;
  const storage = snapshot.host.capacity.rootStorageBytes;

  return (
    <section
      className={`${styles.resultPanel} ${strictProxmox || gvisorSupported ? styles.resultReady : styles.resultIncomplete}`}
      aria-labelledby="host-discovery-title"
    >
      <div className={styles.resultHero}>
        <span className={styles.resultIcon} aria-hidden="true">
          {strictProxmox || gvisorSupported ? <CheckCircle2 size={22} /> : <AlertTriangle size={22} />}
        </span>
        <div>
          <span className={styles.eyebrow}>Read-only inspection complete</span>
          <h2 ref={headingRef} tabIndex={-1} id="host-discovery-title" className={styles.resultTitle}>
            {strictProxmox ? "A supported isolation engine is installed." : gvisorSupported ? "A supported Linux sandbox path is available." : "Host detected. Preparation is not supported yet."}
          </h2>
          <p className={styles.resultDescription}>
            {strictProxmox
              ? "Hivra can now run the separate strict readiness check. Discovery alone does not authorize launch."
              : gvisorSupported
                ? gvisorInstalled
                  ? "Check readiness validates the installed runtime, reviewed adapter, host identity, and current capacity without reinstalling them. Use Repair only when you explicitly need to restore the pinned installation."
                  : "Prepare installs Hivra's pinned gVisor release and reviewed adapter, then runs strict readiness. Nothing changes until you choose Prepare."
              : "The host was inspected successfully. Hivra will not install or change anything without a supported preparation path."}
          </p>
        </div>
      </div>

      <div className={styles.discoveryIdentity}>
        <span className={styles.providerMark} aria-hidden="true"><Server size={19} /></span>
        <div>
          <span className={styles.sectionLabel}>Detected host</span>
          <strong>{hostOsLabel(snapshot)}</strong>
          <span>{snapshot.host.kernel.architecture} kernel {snapshot.host.kernel.release ?? "unknown"}</span>
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
          detail={snapshot.host.environment.effectivePrivilege === "root" ? "Root access detected" : "Root access not detected"}
        />
      </div>

      <div className={styles.recommendationPanel}>
        <span className={styles.recommendationIcon} aria-hidden="true"><ShieldCheck size={18} /></span>
        <div>
          <span className={styles.sectionLabel}>
            {recommendation.supported ? "Recommended isolation" : "Isolation compatibility"}
          </span>
          <strong>{recommendation.title}</strong>
          <p>{recommendation.detail}</p>
          {recommendation.engine?.detectedVersion ? (
            <code>{recommendation.engine.detectedVersion}</code>
          ) : null}
        </div>
      </div>

      {gvisorError ? <div className={styles.formError} role="alert"><AlertTriangle size={15} />{gvisorError}</div> : null}
      {gvisorResult ? <div className={styles.remediation} role="status"><strong>gVisor is ready</strong><span>{gvisorResult}</span></div> : null}

      <DiscoveryActions
        onRetry={onRetry}
        onDone={onDone}
        retrying={retrying}
        onStrictPreflightRequested={strictProxmox ? onStrictPreflightRequested : undefined}
        onGvisorReadinessRequested={gvisorInstalled && connectionId && !gvisorResult ? async () => {
          setGvisorOperation("preflight"); setGvisorError(null); setGvisorResult(null);
          try {
            const response = await fetch(`/api/infrastructure/connections/${encodeURIComponent(connectionId)}/gvisor/preflight`, {
              method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
            });
            const payload = await response.json().catch(() => null) as { success?: boolean; error?: string } | null;
            if (!response.ok || payload?.success !== true) throw new Error(payload?.error || `gVisor readiness check failed (${response.status})`);
            setGvisorResult("The exact installed runtime, application adapter, host identity, and current capacity passed strict readiness.");
          } catch (error) { setGvisorError(error instanceof Error ? error.message : "gVisor readiness check failed."); }
          finally { setGvisorOperation(null); }
        } : undefined}
        onGvisorPrepareRequested={gvisorSupported && connectionId && !gvisorResult ? async () => {
          setGvisorOperation("prepare"); setGvisorError(null); setGvisorResult(null);
          try {
            const response = await fetch(`/api/infrastructure/connections/${encodeURIComponent(connectionId)}/gvisor/prepare`, {
              method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
            });
            const payload = await response.json().catch(() => null) as { success?: boolean; error?: string } | null;
            if (!response.ok || payload?.success !== true) throw new Error(payload?.error || `gVisor preparation failed (${response.status})`);
            setGvisorResult("The pinned runtime, application adapter, and exact host evidence passed. Linux Sandbox can now use this host.");
          } catch (error) { setGvisorError(error instanceof Error ? error.message : "gVisor preparation failed."); }
          finally { setGvisorOperation(null); }
        } : undefined}
        gvisorInstalled={gvisorInstalled}
        gvisorOperation={gvisorOperation}
      />
    </section>
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

function DiscoveryActions({
  onRetry,
  onDone,
  onStrictPreflightRequested,
  onGvisorReadinessRequested,
  onGvisorPrepareRequested,
  gvisorInstalled = false,
  gvisorOperation = null,
  retrying,
}: {
  onRetry: () => void;
  onDone: () => void;
  onStrictPreflightRequested?: () => void;
  onGvisorReadinessRequested?: () => void;
  onGvisorPrepareRequested?: () => void;
  gvisorInstalled?: boolean;
  gvisorOperation?: "preflight" | "prepare" | null;
  retrying: boolean;
}) {
  return (
    <div className={styles.resultActions}>
      <button type="button" className={styles.secondaryButton} onClick={onRetry} disabled={retrying}>
        <RefreshCw size={14} className={retrying ? styles.spin : undefined} aria-hidden="true" />
        {retrying ? "Inspecting..." : "Inspect again"}
      </button>
      {onStrictPreflightRequested ? (
        <button type="button" className={styles.primaryButton} onClick={onStrictPreflightRequested} disabled={retrying}>
          <ShieldCheck size={14} aria-hidden="true" /> Check Proxmox readiness
        </button>
      ) : onGvisorReadinessRequested ? (<>
        <button type="button" className={styles.primaryButton} onClick={onGvisorReadinessRequested} disabled={retrying || gvisorOperation !== null}>
          {gvisorOperation === "preflight" ? <RefreshCw size={14} className={styles.spin} aria-hidden="true" /> : <ShieldCheck size={14} aria-hidden="true" />}
          {gvisorOperation === "preflight" ? "Checking gVisor…" : "Check gVisor readiness"}
        </button>
        {onGvisorPrepareRequested && gvisorInstalled ? (
          <button type="button" className={styles.secondaryButton} onClick={onGvisorPrepareRequested} disabled={retrying || gvisorOperation !== null}>
            {gvisorOperation === "prepare" ? <RefreshCw size={14} className={styles.spin} aria-hidden="true" /> : <ShieldCheck size={14} aria-hidden="true" />}
            {gvisorOperation === "prepare" ? "Repairing gVisor…" : "Repair gVisor"}
          </button>
        ) : null}
      </>) : onGvisorPrepareRequested ? (
        <button type="button" className={styles.primaryButton} onClick={onGvisorPrepareRequested} disabled={retrying || gvisorOperation !== null}>
          {gvisorOperation === "prepare" ? <RefreshCw size={14} className={styles.spin} aria-hidden="true" /> : <ShieldCheck size={14} aria-hidden="true" />}
          {gvisorOperation === "prepare" ? "Preparing gVisor…" : "Prepare gVisor"}
        </button>
      ) : (
        <button type="button" className={styles.primaryButton} onClick={onDone}>Done</button>
      )}
    </div>
  );
}
