"use client";

import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Cloud,
  Cpu,
  ExternalLink,
  KeyRound,
  Loader2,
  MemoryStick,
  Plus,
  RefreshCw,
  Server,
  ServerCog,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  deleteInfrastructureConnection,
  discoverInfrastructureHost,
  forceForgetHetznerCloudConnection,
  getHetznerCloudInventory,
  InfrastructureApiError,
  listInfrastructureConnections,
  listInfrastructureTargets,
  preflightInfrastructureConnection,
  refreshHetznerCloudInventory,
  type InfrastructurePreparation,
} from "@/lib/infrastructure/client";
import type {
  DeploymentTargetDto,
  HetznerCloudConnectionDto,
  HetznerCloudConnectionErrorCode,
  HetznerCloudServerInventoryDto,
  InfrastructureConnectionDto,
  ProxmoxPreflightResult,
} from "@/lib/infrastructure/contracts";
import {
  HETZNER_CLOUD_CONNECTION_ERROR_CODES,
  HETZNER_CLOUD_FORCE_FORGET_CONFIRMATION,
  isGvisorDeploymentTarget,
  isProxmoxDeploymentTarget,
} from "@/lib/infrastructure/contracts";
import type { HostDiscoveryResult } from "@/lib/infrastructure/host-discovery-contracts";
import {
  getHivraCloudCapacity,
  type HivraCloudCapacityDto,
} from "@/lib/infrastructure/hivra-cloud-client";
import { canPrepareFromPreflight } from "@/lib/infrastructure/preparation-eligibility";
import { targetSupportsCatalogRuntime } from "@/lib/hivra/agent-placement";
import { getAgent } from "@/lib/hivra/agent-catalog";
import {
  buildLaunchSetupHref,
  parsePortableLaunchResourceId,
} from "@/lib/hivra/launch-navigation";
import { isLocalAuthMode } from "@/lib/self-host/config";

import { HivraCloudCapacityCard } from "./HivraCloudCapacityCard";
import { HivraCloudPurchaseDialog } from "./HivraCloudPurchaseDialog";
import { InfrastructureConnectionCard } from "./InfrastructureConnectionCard";
import { InfrastructureConnectionWizard } from "./InfrastructureConnectionWizard";
import {
  InfrastructureHostDiscoveryResult,
  supportsStrictProxmoxDiscovery,
} from "./InfrastructureHostDiscoveryResult";
import { InfrastructurePreflightResult } from "./InfrastructurePreflightResult";
import { InfrastructurePrepareDialog } from "./InfrastructurePrepareDialog";
import { HetznerCloudCapacityDialog } from "./HetznerCloudCapacityDialog";
import { ProviderComputerSetupDialog } from "./ProviderComputerSetupDialog";
import { HetznerCloudCleanupDialog } from "./HetznerCloudCleanupDialog";
import { HetznerCloudConnectionCard } from "./HetznerCloudConnectionCard";
import { HetznerCloudConnectionDialog } from "./HetznerCloudConnectionDialog";
import styles from "./Infrastructure.module.css";
import { useInfrastructureDialog } from "./useInfrastructureDialog";

type SshInfrastructureConnectionDto = Exclude<
  InfrastructureConnectionDto,
  { provider: "hetzner-cloud" }
>;

type CheckDialogState = {
  connection: SshInfrastructureConnectionDto;
  phase: "discovering" | "discovery" | "preflighting" | "preflight";
  discovery?: HostDiscoveryResult;
  preflight?: ProxmoxPreflightResult;
  error?: string;
};

type HetznerInventoryState = {
  inventory: HetznerCloudServerInventoryDto[];
  loading: boolean;
  error: string | null;
};

function isSshConnection(
  connection: InfrastructureConnectionDto,
): connection is SshInfrastructureConnectionDto {
  return connection.provider !== "hetzner-cloud";
}

function hetznerErrorCode(error: unknown): HetznerCloudConnectionErrorCode | null {
  if (!(error instanceof InfrastructureApiError) || !error.code) return null;
  return HETZNER_CLOUD_CONNECTION_ERROR_CODES.includes(
    error.code as HetznerCloudConnectionErrorCode,
  )
    ? error.code as HetznerCloudConnectionErrorCode
    : null;
}

export function InfrastructureConnectionsPage() {
  const searchParams = useSearchParams();
  const requestedLaunchResource = parsePortableLaunchResourceId(searchParams?.get("launch"));
  const unifiedLaunchReturn = searchParams?.get("returnTo") === "unified-launch";
  const selfHosted = isLocalAuthMode();
  const [connections, setConnections] = useState<InfrastructureConnectionDto[]>([]);
  const [targets, setTargets] = useState<DeploymentTargetDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [hivraCloudLoading, setHivraCloudLoading] = useState(!selfHosted);
  const [hivraCloud, setHivraCloud] = useState<HivraCloudCapacityDto | null>(null);
  const [hivraCloudError, setHivraCloudError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [targetLoadError, setTargetLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [entryChooserOpen, setEntryChooserOpen] = useState(false);
  const [hivraCloudDialogOpen, setHivraCloudDialogOpen] = useState(false);
  const [hetznerDialogOpen, setHetznerDialogOpen] = useState(false);
  const [capacityConnection, setCapacityConnection] = useState<HetznerCloudConnectionDto | null>(null);
  const [cleanupConnection, setCleanupConnection] = useState<HetznerCloudConnectionDto | null>(null);
  const [setupConnection, setSetupConnection] = useState<HetznerCloudConnectionDto | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editingConnection, setEditingConnection] = useState<SshInfrastructureConnectionDto | null>(null);
  const [deletingConnection, setDeletingConnection] = useState<InfrastructureConnectionDto | null>(null);
  const [forceForgetConnection, setForceForgetConnection] = useState<HetznerCloudConnectionDto | null>(null);
  const [preparingConnection, setPreparingConnection] = useState<SshInfrastructureConnectionDto | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [forceForgetting, setForceForgetting] = useState(false);
  const [forceForgetError, setForceForgetError] = useState<string | null>(null);
  const [checkingIds, setCheckingIds] = useState<Set<string>>(() => new Set());
  const [latestPreflight, setLatestPreflight] = useState<Record<string, ProxmoxPreflightResult>>({});
  const [checkDialog, setCheckDialog] = useState<CheckDialogState | null>(null);
  const [hetznerInventory, setHetznerInventory] = useState<Record<string, HetznerInventoryState>>({});
  const addCapacityButtonRef = useRef<HTMLButtonElement>(null);

  const loadHetznerInventory = useCallback(async (
    connectionId: string,
    options: { refresh?: boolean; signal?: AbortSignal } = {},
  ) => {
    setHetznerInventory((current) => ({
      ...current,
      [connectionId]: {
        inventory: current[connectionId]?.inventory ?? [],
        loading: true,
        error: null,
      },
    }));
    try {
      const inventory = options.refresh
        ? await refreshHetznerCloudInventory(connectionId)
        : await getHetznerCloudInventory(connectionId, options.signal);
      if (options.signal?.aborted) return;
      setHetznerInventory((current) => ({
        ...current,
        [connectionId]: { inventory, loading: false, error: null },
      }));
      if (options.refresh) {
        const checkedAt = inventory.reduce<string | null>((latest, server) => (
          !latest || Date.parse(server.discoveredAt) > Date.parse(latest)
            ? server.discoveredAt
            : latest
        ), null) ?? new Date().toISOString();
        setConnections((current) => current.map((connection) => (
          connection.id === connectionId && connection.provider === "hetzner-cloud"
            ? {
                ...connection,
                status: "ready",
                lastCheckedAt: checkedAt,
                lastErrorCode: null,
              }
            : connection
        )));
      }
    } catch (error) {
      if (options.signal?.aborted) return;
      const message = error instanceof Error
        ? error.message
        : "Hivra could not load this Hetzner project.";
      setHetznerInventory((current) => ({
        ...current,
        [connectionId]: {
          inventory: current[connectionId]?.inventory ?? [],
          loading: false,
          error: message,
        },
      }));
      if (options.refresh) {
        const observedErrorCode = hetznerErrorCode(error);
        setConnections((current) => current.map((connection) => (
          connection.id === connectionId && connection.provider === "hetzner-cloud"
            ? {
                ...connection,
                status: "error",
                lastCheckedAt: new Date().toISOString(),
                lastErrorCode: observedErrorCode ?? connection.lastErrorCode,
              }
            : connection
        )));
      }
    }
  }, []);

  const loadConnections = useCallback(async (signal?: AbortSignal) => {
    try {
      const [connectionResult, targetResult, hivraCloudResult] = await Promise.allSettled([
        listInfrastructureConnections(signal),
        listInfrastructureTargets(undefined, signal),
        selfHosted ? Promise.resolve(null) : getHivraCloudCapacity(signal),
      ]);
      if (signal?.aborted) return;
      if (hivraCloudResult.status === "fulfilled" && hivraCloudResult.value) {
        setHivraCloud(hivraCloudResult.value);
        setHivraCloudError(null);
      } else if (hivraCloudResult.status === "fulfilled") {
        setHivraCloud(null);
        setHivraCloudError(null);
      } else {
        setHivraCloud(null);
        setHivraCloudError(
          hivraCloudResult.reason instanceof Error
            ? hivraCloudResult.reason.message
            : "Hivra Cloud capacity could not be loaded.",
        );
      }
      if (connectionResult.status === "rejected") throw connectionResult.reason;
      setConnections(connectionResult.value);
      for (const connection of connectionResult.value) {
        if (connection.provider === "hetzner-cloud") {
          void loadHetznerInventory(connection.id, { signal });
        }
      }
      setLoadError(null);
      if (targetResult.status === "fulfilled") {
        setTargets(targetResult.value);
        setTargetLoadError(null);
      } else {
        setTargets([]);
        setTargetLoadError(
          targetResult.reason instanceof Error
            ? targetResult.reason.message
            : "Saved target evidence could not be loaded.",
        );
      }
    } catch (error) {
      if (signal?.aborted) return;
      setLoadError(
        error instanceof Error
          ? error.message
          : "Hivra could not load your infrastructure connections.",
      );
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
        setHivraCloudLoading(false);
      }
    }
  }, [loadHetznerInventory, selfHosted]);

  useEffect(() => {
    const controller = new AbortController();
    void loadConnections(controller.signal);
    return () => controller.abort();
  }, [loadConnections]);

  const counts = useMemo(() => {
    const hasManagedCapacity = Boolean(hivraCloud?.subscribed && hivraCloud.plan && hivraCloud.usage);
    return {
      total: connections.length + (hasManagedCapacity ? 1 : 0),
      connected: connections.filter((connection) => connection.status === "ready").length
        + (hasManagedCapacity ? 1 : 0),
      readyTargets: targets.filter((target) =>
        target.status === "ready"
        && target.capabilities.launchReady
        && connections.some(
          (connection) => connection.id === target.connectionId && connection.status === "ready",
        ),
      ).length,
    };
  }, [connections, hivraCloud, targets]);

  const targetsByConnection = useMemo(() => {
    const indexed = new Map<string, DeploymentTargetDto>();
    // The API returns newest evidence first. Keep the newest target when a
    // connection has historical evidence for more than one Proxmox node.
    for (const target of targets) {
      if (!indexed.has(target.connectionId)) indexed.set(target.connectionId, target);
    }
    return indexed;
  }, [targets]);

  const hasHivraCloudCapacity = Boolean(
    hivraCloud?.subscribed && hivraCloud.plan && hivraCloud.usage,
  );
  const readyLaunchTarget = requestedLaunchResource
    ? targets.find((target) => (
        target.status === "ready"
        && target.capabilities.launchReady
        && targetSupportsCatalogRuntime(target, requestedLaunchResource)
        && (requestedLaunchResource !== "linux-desktop" || isProxmoxDeploymentTarget(target))
        && (requestedLaunchResource !== "linux-terminal" || isGvisorDeploymentTarget(target))
      )) ?? null
    : null;
  const launchReturnHref = requestedLaunchResource
    && (readyLaunchTarget || (
      requestedLaunchResource !== "windows"
      && requestedLaunchResource !== "linux-terminal"
      && hasHivraCloudCapacity
    ))
    ? buildLaunchSetupHref(requestedLaunchResource, readyLaunchTarget?.id, { unified: unifiedLaunchReturn })
    : null;
  const requestedLaunchLabel = requestedLaunchResource === "linux-desktop"
    ? "Ubuntu Desktop"
    : requestedLaunchResource === "windows"
      ? "Windows"
    : requestedLaunchResource
      ? getAgent(requestedLaunchResource)?.name ?? requestedLaunchResource
      : null;
  const showingFirstConnection = !loading
    && !hivraCloudLoading
    && !loadError
    && !hivraCloudError
    && connections.length === 0
    && !hasHivraCloudCapacity;
  const showingEntryChooser = showingFirstConnection || entryChooserOpen;

  function openCreateWizard() {
    setEntryChooserOpen(false);
    setEditingConnection(null);
    setWizardOpen(true);
    setActionError(null);
    setActionNotice(null);
  }

  function openHivraCloudDialog() {
    setEntryChooserOpen(false);
    setHivraCloudDialogOpen(true);
    setActionError(null);
    setActionNotice(null);
  }

  function openHetznerDialog() {
    setEntryChooserOpen(false);
    setHetznerDialogOpen(true);
    setActionError(null);
    setActionNotice(null);
  }

  function openEditWizard(connection: SshInfrastructureConnectionDto) {
    setEditingConnection(connection);
    setWizardOpen(true);
    setActionError(null);
    setActionNotice(null);
  }

  function upsertConnection(saved: InfrastructureConnectionDto) {
    setConnections((current) => {
      const exists = current.some((connection) => connection.id === saved.id);
      if (!exists) return [saved, ...current];
      return current.map((connection) => (connection.id === saved.id ? saved : connection));
    });
  }

  function recordPreflight(connectionId: string, result: ProxmoxPreflightResult) {
    setLatestPreflight((current) => ({ ...current, [connectionId]: result }));
    void loadConnections();
  }

  async function recordPreparation(preparation: InfrastructurePreparation) {
    setLatestPreflight((current) => ({
      ...current,
      [preparation.connectionId]: preparation.preflight,
    }));
    await loadConnections();
  }

  const runDiscovery = useCallback(async (connection: SshInfrastructureConnectionDto) => {
    setCheckingIds((current) => new Set(current).add(connection.id));
    setCheckDialog({ connection, phase: "discovering" });
    setActionError(null);
    setActionNotice(null);
    try {
      const discovery = await discoverInfrastructureHost(connection.id);
      setCheckDialog({ connection, phase: "discovery", discovery });
    } catch (error) {
      setCheckDialog({
        connection,
        phase: "discovery",
        error: error instanceof Error ? error.message : "Hivra could not inspect this host.",
      });
    } finally {
      setCheckingIds((current) => {
        const next = new Set(current);
        next.delete(connection.id);
        return next;
      });
      void loadConnections();
    }
  }, [loadConnections]);

  const runStrictPreflight = useCallback(async (
    connection: SshInfrastructureConnectionDto,
    discovery: HostDiscoveryResult,
  ) => {
    if (!supportsStrictProxmoxDiscovery(discovery)) return;
    setCheckingIds((current) => new Set(current).add(connection.id));
    setCheckDialog({ connection, phase: "preflighting", discovery });
    setActionError(null);
    setActionNotice(null);
    try {
      const preflight = await preflightInfrastructureConnection(connection.id);
      setLatestPreflight((current) => ({ ...current, [connection.id]: preflight }));
      setCheckDialog({ connection, phase: "preflight", discovery, preflight });
    } catch (error) {
      setCheckDialog({
        connection,
        phase: "preflight",
        discovery,
        error: error instanceof Error ? error.message : "Hivra could not finish the strict readiness check.",
      });
    } finally {
      setCheckingIds((current) => {
        const next = new Set(current);
        next.delete(connection.id);
        return next;
      });
      void loadConnections();
    }
  }, [loadConnections]);

  async function confirmDelete() {
    if (!deletingConnection) return;
    const connection = deletingConnection;
    setDeleting(true);
    setActionError(null);
    setActionNotice(null);
    try {
      await deleteInfrastructureConnection(connection.id);
      setConnections((current) => current.filter((item) => item.id !== connection.id));
      setTargets((current) => current.filter((target) => target.connectionId !== connection.id));
      setLatestPreflight((current) => {
        const next = { ...current };
        delete next[connection.id];
        return next;
      });
      setHetznerInventory((current) => {
        const next = { ...current };
        delete next[connection.id];
        return next;
      });
      setDeletingConnection(null);
    } catch (error) {
      if (
        connection.provider === "hetzner-cloud"
        && error instanceof InfrastructureApiError
        && error.code === "capacity_force_forget_required"
      ) {
        setDeletingConnection(null);
        setForceForgetError(null);
        setForceForgetConnection(connection);
        return;
      }
      setActionError(
        error instanceof Error ? error.message : "Hivra could not remove this connection.",
      );
      setDeletingConnection(null);
    } finally {
      setDeleting(false);
    }
  }

  async function confirmForceForget() {
    if (!forceForgetConnection) return;
    const connection = forceForgetConnection;
    setForceForgetting(true);
    setForceForgetError(null);
    try {
      await forceForgetHetznerCloudConnection(connection.id, {
        confirmation: HETZNER_CLOUD_FORCE_FORGET_CONFIRMATION,
      });
      setConnections((current) => current.filter((item) => item.id !== connection.id));
      setTargets((current) => current.filter((target) => target.connectionId !== connection.id));
      setLatestPreflight((current) => {
        const next = { ...current };
        delete next[connection.id];
        return next;
      });
      setHetznerInventory((current) => {
        const next = { ...current };
        delete next[connection.id];
        return next;
      });
      setForceForgetConnection(null);
      setActionNotice(
        "Hivra access was forgotten. No provider cleanup was performed, Hetzner resources and billing may remain, and this account’s Canary capacity slot stays held.",
      );
    } catch (error) {
      setForceForgetError(
        error instanceof Error
          ? error.message
          : "Hivra could not safely forget this Hetzner connection.",
      );
    } finally {
      setForceForgetting(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.pageGlow} aria-hidden="true" />
      <main className={styles.pageInner}>
        <nav className={styles.breadcrumb} aria-label="Breadcrumb">
          <Link href="/dashboard">Command Center</Link>
          <ArrowRight size={12} aria-hidden="true" />
          <span aria-current="page">Infrastructure</span>
        </nav>

        <header className={styles.pageHeader}>
          <div className={styles.pageHeading}>
            <span className={styles.eyebrow}>Infrastructure</span>
            <h1>Your infrastructure.</h1>
            <p>
              {selfHosted
                ? "Connect a cloud project or bring a computer you control. Hivra Cloud remains a separate managed option when you want us to operate the capacity."
                : "Use Hivra Cloud, connect a cloud project, or bring a computer you control. Managed capacity appears here as soon as your plan is active."}
            </p>
          </div>
          {!showingFirstConnection ? (
            <button
              ref={addCapacityButtonRef}
              type="button"
              className={styles.primaryButton}
              onClick={() => setEntryChooserOpen((current) => !current)}
              aria-expanded={entryChooserOpen}
              aria-controls="infrastructure-entry-options"
            >
              {entryChooserOpen
                ? <X size={16} aria-hidden="true" />
                : <Plus size={16} aria-hidden="true" />}
              {entryChooserOpen ? "Close options" : "Add capacity"}
            </button>
          ) : null}
        </header>

        {!loading && !hivraCloudLoading && (connections.length > 0 || hasHivraCloudCapacity) ? (
          <>
            <section className={styles.summaryGrid} aria-label="Infrastructure summary">
              <SummaryCard
                icon={<ServerCog size={18} />}
                label="Capacity sources"
                value={String(counts.total)}
                detail={selfHosted
                  ? (counts.total === 1 ? "Provider project or host" : "Provider projects and hosts")
                  : (counts.total === 1 ? "Managed pool or connection" : "Managed pools and connections")}
              />
              <SummaryCard
                icon={<CheckCircle2 size={18} />}
                label="Available"
                value={String(counts.connected)}
                detail={selfHosted ? "Latest connection check passed" : "Managed or latest connection check passed"}
                tone="success"
              />
              <SummaryCard
                icon={<ShieldCheck size={18} />}
                label="Self-host targets ready"
                value={targetLoadError ? "-" : String(counts.readyTargets)}
                detail={targetLoadError ? "Readiness temporarily unavailable" : "Backed by a recent readiness check"}
                tone={counts.readyTargets > 0 ? "success" : "neutral"}
              />
            </section>

            <section className={styles.truthPanel}>
              <span className={styles.truthIcon} aria-hidden="true">
                <ShieldCheck size={18} />
              </span>
              <div>
                <strong>Inspection comes before setup or launch.</strong>
                <p>
                  {selfHosted
                    ? "Provider sync and host inspection make no changes. Setup and spending require separate approval, and Hivra will not fall back to managed infrastructure."
                    : "Hivra Cloud is already operated for you. Provider sync and host inspection make no changes; self-managed setup and spending still require separate approval."}
                </p>
              </div>
              <span className={styles.localBadge}><ShieldCheck size={12} aria-hidden="true" /> {selfHosted ? "Under your control" : "Managed or yours"}</span>
            </section>
          </>
        ) : null}

        {actionNotice ? (
          <div className={styles.pageNotice} role="status">
            <CheckCircle2 size={16} aria-hidden="true" />
            <span>{actionNotice}</span>
            <button type="button" onClick={() => setActionNotice(null)} aria-label="Dismiss notice">
              <X size={15} aria-hidden="true" />
            </button>
          </div>
        ) : null}

        {launchReturnHref && requestedLaunchLabel ? (
          <div className={styles.pageNotice} role="status">
            <CheckCircle2 size={16} aria-hidden="true" />
            <span>Capacity is ready for {requestedLaunchLabel}. Return to finish this launch.</span>
            <Link className={styles.primaryButton} href={launchReturnHref}>
              Continue launch <ArrowRight size={14} aria-hidden="true" />
            </Link>
          </div>
        ) : null}

        {actionError ? (
          <div className={styles.pageAlert} role="alert">
            <AlertTriangle size={16} aria-hidden="true" />
            <span>{actionError}</span>
            <button type="button" onClick={() => setActionError(null)} aria-label="Dismiss error">
              <X size={15} aria-hidden="true" />
            </button>
          </div>
        ) : null}

        {targetLoadError && !loadError ? (
          <div className={styles.pageAlert} role="alert">
            <AlertTriangle size={16} aria-hidden="true" />
            <span>
              Host readiness is unavailable, so self-managed launch is paused. {targetLoadError}
            </span>
            <button
              type="button"
              onClick={() => void loadConnections()}
              aria-label="Retry host readiness"
            >
              <RefreshCw size={15} aria-hidden="true" />
            </button>
          </div>
        ) : null}

        {hivraCloudError ? (
          <div className={styles.pageAlert} role="alert">
            <AlertTriangle size={16} aria-hidden="true" />
            <span>
              Managed capacity could not be loaded. Existing self-managed connections
              are still shown. {hivraCloudError}
            </span>
            <button
              type="button"
              onClick={() => {
                setHivraCloudLoading(true);
                void loadConnections();
              }}
              aria-label="Retry Hivra Cloud capacity"
            >
              <RefreshCw size={15} aria-hidden="true" />
            </button>
          </div>
        ) : null}

        {showingEntryChooser ? (
          <InfrastructureEntryChooser
            firstConnection={showingFirstConnection}
            hivraCloud={hivraCloud}
            selfHosted={selfHosted}
            onChooseHivraCloud={openHivraCloudDialog}
            onConnectHetzner={openHetznerDialog}
            onConnectExisting={openCreateWizard}
          />
        ) : null}

        {hasHivraCloudCapacity && hivraCloud ? (
          <section className={styles.connectionSection} aria-labelledby="hivra-cloud-heading">
            <div className={styles.sectionHeader}>
              <div>
                <span className={styles.eyebrow}>Managed by Hivra</span>
                <h2 id="hivra-cloud-heading">Hivra Cloud capacity</h2>
              </div>
            </div>
            <HivraCloudCapacityCard
              capacity={hivraCloud}
              onUpgrade={openHivraCloudDialog}
            />
          </section>
        ) : null}

        {loading || loadError || connections.length > 0 ? (
          <section className={styles.connectionSection} aria-labelledby="connections-heading">
            <div className={styles.sectionHeader}>
              <div>
                <span className={styles.eyebrow}>Connections and nodes</span>
                <h2 id="connections-heading">Available infrastructure</h2>
              </div>
              {!loading && connections.length > 0 ? (
                <button
                  type="button"
                  className={styles.tertiaryButton}
                  onClick={() => {
                    setLoading(true);
                    void loadConnections();
                  }}
                >
                  <RefreshCw size={14} aria-hidden="true" /> Refresh
                </button>
              ) : null}
            </div>

            {loading ? (
              <LoadingConnections />
            ) : loadError ? (
              <LoadError message={loadError} onRetry={() => {
                setLoading(true);
                void loadConnections();
              }} />
            ) : (
              <div className={styles.connectionGrid}>
                {connections.map((connection) => {
                  if (connection.provider === "hetzner-cloud") {
                    const state = hetznerInventory[connection.id] ?? {
                      inventory: [],
                      loading: true,
                      error: null,
                    };
                    return (
                      <HetznerCloudConnectionCard
                        key={connection.id}
                        connection={connection}
                        inventory={state.inventory}
                        loading={state.loading}
                        error={state.error}
                        onCreateCapacity={() => setCapacityConnection(connection)}
                        onCleanup={() => setCleanupConnection(connection)}
                        onSetup={() => setSetupConnection(connection)}
                        onRefresh={() => void loadHetznerInventory(connection.id, { refresh: true })}
                        onDelete={() => setDeletingConnection(connection)}
                      />
                    );
                  }
                  return (
                    <InfrastructureConnectionCard
                      key={connection.id}
                      connection={connection}
                      savedTarget={targetsByConnection.get(connection.id)}
                      latestPreflight={latestPreflight[connection.id]}
                      checking={checkingIds.has(connection.id)}
                      onPrepare={() => setPreparingConnection(connection)}
                      onCheck={() => void runDiscovery(connection)}
                      onEdit={() => openEditWizard(connection)}
                      onDelete={() => setDeletingConnection(connection)}
                    />
                  );
                })}
              </div>
            )}
          </section>
        ) : null}
      </main>

      {/* WKWebView scrolls the dashboard's inner main element. Present setup as
          a full in-app workflow before the inert infrastructure content instead
          of opening a body portal outside the visible scroll position. */}
      <div className={styles.modalAnchor} data-infrastructure-modal-anchor>
        <div className={styles.modalTheme}>
          {hetznerDialogOpen ? (
            <HetznerCloudConnectionDialog
              onClose={() => setHetznerDialogOpen(false)}
              returnFocusRef={addCapacityButtonRef}
              onConnected={(connection, inventory) => {
                upsertConnection(connection);
                setHetznerInventory((current) => ({
                  ...current,
                  [connection.id]: { inventory, loading: false, error: null },
                }));
                setHetznerDialogOpen(false);
                setCapacityConnection(connection);
              }}
            />
          ) : null}

          {!selfHosted && hivraCloudDialogOpen ? (
            <HivraCloudPurchaseDialog
              onClose={() => setHivraCloudDialogOpen(false)}
              onActivated={() => {
                setHivraCloudDialogOpen(false);
                setHivraCloudLoading(true);
                void loadConnections();
              }}
              returnFocusRef={addCapacityButtonRef}
            />
          ) : null}

          {cleanupConnection && <HetznerCloudCleanupDialog connection={cleanupConnection}
            onClose={()=>setCleanupConnection(null)}
            onForgot={()=>{setActionNotice("Hivra access was erased. Provider cleanup was not completed; resources may still incur charges in Hetzner.");void loadConnections();}}
            onComplete={()=>void loadHetznerInventory(cleanupConnection.id,{refresh:true})}/>}

          {setupConnection && <ProviderComputerSetupDialog connection={setupConnection}
            launchResourceId={requestedLaunchResource}
            unifiedLaunchReturn={unifiedLaunchReturn}
            onClose={() => setSetupConnection(null)} onChanged={() => { void loadConnections(); void loadHetznerInventory(setupConnection.id, { refresh: true }); }} />}

          {capacityConnection ? (
            <HetznerCloudCapacityDialog
              connection={capacityConnection}
              returnFocusRef={addCapacityButtonRef}
              onClose={() => setCapacityConnection(null)}
              onSetup={() => { setSetupConnection(capacityConnection); setCapacityConnection(null); }}
              onInventoryChanged={(inventory) => {
                setHetznerInventory((current) => ({
                  ...current,
                  [capacityConnection.id]: {
                    inventory,
                    loading: false,
                    error: null,
                  },
                }));
              }}
            />
          ) : null}

          {wizardOpen ? (
            <InfrastructureConnectionWizard
              connection={editingConnection}
              returnFocusRef={addCapacityButtonRef}
              onClose={() => {
                setWizardOpen(false);
                setEditingConnection(null);
                void loadConnections();
              }}
              onConnectionSaved={upsertConnection}
              onPreflightComplete={recordPreflight}
              onPrepareRequested={(saved) => {
                setWizardOpen(false);
                setEditingConnection(null);
                if (isSshConnection(saved)) setPreparingConnection(saved);
              }}
            />
          ) : null}

          {deletingConnection ? (
            <DeleteConnectionDialog
              connection={deletingConnection}
              deleting={deleting}
              onCancel={() => setDeletingConnection(null)}
              onConfirm={() => void confirmDelete()}
            />
          ) : null}

          {forceForgetConnection ? (
            <ForceForgetHetznerDialog
              connection={forceForgetConnection}
              forgetting={forceForgetting}
              error={forceForgetError}
              onCancel={() => {
                setForceForgetConnection(null);
                setForceForgetError(null);
              }}
              onConfirm={() => void confirmForceForget()}
            />
          ) : null}

          {preparingConnection ? (
            <InfrastructurePrepareDialog
              connection={preparingConnection}
              onClose={() => {
                setPreparingConnection(null);
                void loadConnections();
              }}
              onPrepared={recordPreparation}
            />
          ) : null}

          {checkDialog ? (
            <ConnectionCheckDialog
              state={checkDialog}
              checking={checkingIds.has(checkDialog.connection.id)}
              onClose={() => {
                setCheckDialog(null);
                void loadConnections();
              }}
              onRetryDiscovery={() => void runDiscovery(checkDialog.connection)}
              onStrictPreflight={(discovery) => void runStrictPreflight(checkDialog.connection, discovery)}
              onRetryPreflight={() => {
                if (checkDialog.discovery) {
                  void runStrictPreflight(checkDialog.connection, checkDialog.discovery);
                }
              }}
              onPrepareRequested={() => {
                setCheckDialog(null);
                setPreparingConnection(checkDialog.connection);
              }}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SummaryCard({
  icon,
  label,
  value,
  detail,
  tone = "neutral",
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
  tone?: "neutral" | "success" | "warning";
}) {
  return (
    <article className={`${styles.summaryCard} ${styles[`summary_${tone}`]}`}>
      <span className={styles.summaryIcon} aria-hidden="true">{icon}</span>
      <span className={styles.sectionLabel}>{label}</span>
      <strong>{value}</strong>
      <span>{detail}</span>
    </article>
  );
}

function LoadingConnections() {
  return (
    <div className={styles.loadingPanel} role="status" aria-live="polite">
      <Loader2 size={20} className={styles.spin} aria-hidden="true" />
      <div>
        <strong>Loading your infrastructure…</strong>
        <span>Reading your connected hosts.</span>
      </div>
    </div>
  );
}

const HETZNER_PROJECTS_URL = "https://console.hetzner.com/projects";
const HETZNER_API_TOKEN_GUIDE_URL = "https://docs.hetzner.com/cloud/api/getting-started/generating-api-token/";
const HETZNER_SERVER_GUIDE_URL = "https://docs.hetzner.com/cloud/servers/getting-started/creating-a-server/";

function InfrastructureEntryChooser({
  firstConnection,
  hivraCloud,
  selfHosted,
  onChooseHivraCloud,
  onConnectHetzner,
  onConnectExisting,
}: {
  firstConnection: boolean;
  hivraCloud: HivraCloudCapacityDto | null;
  selfHosted: boolean;
  onChooseHivraCloud: () => void;
  onConnectHetzner: () => void;
  onConnectExisting: () => void;
}) {
  const hivraCloudPaid = hivraCloud?.paid === true;
  const activeManagedCapacity = hivraCloudPaid && hivraCloud?.usage
    ? {
        cpu: hivraCloud.usage.totalCpu,
        ram: hivraCloud.usage.totalRam,
      }
    : null;
  const formatCapacityNumber = (value: number) => Number.isInteger(value)
    ? String(value)
    : value.toFixed(1);

  return (
    <section
      id="infrastructure-entry-options"
      className={styles.entryChooser}
      aria-labelledby="infrastructure-entry-heading"
    >
      <div className={styles.entryHeading}>
        <div>
          <span className={styles.eyebrow}>{firstConnection ? "First setup" : "Add capacity"}</span>
          <h2 id="infrastructure-entry-heading">Choose how to add a computer.</h2>
        </div>
        <p>
          Hivra Cloud is the quickest managed path. You can also create capacity in
          your own Hetzner project or connect a server you already control.
        </p>
      </div>

      <div className={styles.entryGrid}>
        <article className={`${styles.entryCard} ${styles.entryCardRecommended} ${styles.managedEntryCard}`}>
          <div>
            <div className={styles.entryCardTopline}>
              <span className={styles.entryIcon} aria-hidden="true"><Cloud size={21} /></span>
              <span className={styles.recommendedBadge}>Fastest setup</span>
            </div>
            <span className={styles.sectionLabel}>Managed mode</span>
            <h3>{hivraCloudPaid ? "Hivra Cloud is connected." : "Start with Hivra Cloud."}</h3>
            <p>
              {hivraCloudPaid
                ? "Your managed compute pool is active. Hivra operates, updates, and recovers the underlying hosts for you."
                : selfHosted
                  ? "Open the hosted Hivra control plane to buy or manage a fully operated compute pool. Your local installation and provider connections stay independent."
                : "Choose a compute pool and check out securely. Hivra provisions, operates, updates, and recovers the underlying hosts for you."}
            </p>
          </div>
          <div className={styles.managedEntryAction}>
            <div className={styles.managedEntryFacts} aria-label="Hivra Cloud options">
              <span>
                <Cpu size={14} aria-hidden="true" />
                {activeManagedCapacity
                  ? `${formatCapacityNumber(activeManagedCapacity.cpu)} vCPU in your active pool`
                  : "CPU follows the plan you choose"}
              </span>
              <span>
                <MemoryStick size={14} aria-hidden="true" />
                {activeManagedCapacity
                  ? `${formatCapacityNumber(activeManagedCapacity.ram / 1024)} GB RAM in your active pool`
                  : "RAM follows the plan you choose"}
              </span>
              <span><SlidersHorizontal size={14} aria-hidden="true" /> Allocate per agent</span>
            </div>
            {selfHosted ? (
              <a
                className={styles.primaryButton}
                href="https://hivra.cloud/dashboard/infrastructure"
                target="_blank"
                rel="noreferrer"
              >
                Open Hivra Cloud <ExternalLink size={14} aria-hidden="true" />
                <span className={styles.srOnly}> (opens in a new tab)</span>
              </a>
            ) : hivraCloudPaid ? (
              <Link className={styles.primaryButton} href="/dashboard/billing">
                Manage Hivra Cloud <ArrowRight size={14} aria-hidden="true" />
              </Link>
            ) : (
              <button type="button" className={styles.primaryButton} onClick={onChooseHivraCloud}>
                Choose Hivra Cloud <ArrowRight size={14} aria-hidden="true" />
              </button>
            )}
            <p>
              {hivraCloudPaid
                ? "Your active pool and computers are shown below. Plan changes use Billing."
                : selfHosted
                  ? "Managed capacity is purchased and operated on hivra.cloud; no hosted billing code runs inside this installation."
                : "No charge occurs until you confirm the final amount in Stripe Checkout."}
            </p>
          </div>
        </article>

        <article className={styles.entryCard}>
          <div className={styles.entryCardTopline}>
            <span className={styles.entryIcon} aria-hidden="true"><Cloud size={21} /></span>
          </div>
          <span className={styles.sectionLabel}>Self-managed cloud</span>
          <h3>Create a Hetzner cloud computer.</h3>
          <p>
            Connect a project token, choose a live server size, location, and system
            image, then review freshly observed provider rates before anything is created.
          </p>
          <div className={styles.currentStateNote}>
            <ShieldCheck size={15} aria-hidden="true" />
            <span>
              Connecting makes no purchase. Hivra asks for a token with Read &amp; Write
              project authority; server billing starts only after final confirmation.
            </span>
          </div>
          <div className={styles.entryActions}>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={onConnectHetzner}
            >
              Start with Hetzner <ArrowRight size={14} aria-hidden="true" />
            </button>
            <a
              className={styles.secondaryButton}
              href={HETZNER_PROJECTS_URL}
              target="_blank"
              rel="noreferrer"
            >
              Open Hetzner Cloud <ExternalLink size={14} aria-hidden="true" />
              <span className={styles.srOnly}> (opens in a new tab)</span>
            </a>
          </div>
          <nav className={styles.guideLinks} aria-label="Official Hetzner setup guides">
            <a href={HETZNER_SERVER_GUIDE_URL} target="_blank" rel="noreferrer">
              <BookOpen size={13} aria-hidden="true" /> Server creation guide
              <ExternalLink size={11} aria-hidden="true" />
              <span className={styles.srOnly}> (opens in a new tab)</span>
            </a>
            <a href={HETZNER_API_TOKEN_GUIDE_URL} target="_blank" rel="noreferrer">
              <KeyRound size={13} aria-hidden="true" /> API token guide
              <ExternalLink size={11} aria-hidden="true" />
              <span className={styles.srOnly}> (opens in a new tab)</span>
            </a>
          </nav>
        </article>

        <article className={styles.entryCard}>
          <div className={styles.entryCardTopline}>
            <span className={styles.entryIcon} aria-hidden="true"><Server size={21} /></span>
          </div>
          <span className={styles.sectionLabel}>Your server</span>
          <h3>Bring an existing host.</h3>
          <p>
            Connect Linux, bare metal, or an existing Proxmox environment with pinned
            root SSH. Hivra detects compatible candidates without changing the host.
          </p>
          <div className={styles.requirementList} aria-label="What you will need">
            <span><CheckCircle2 size={14} aria-hidden="true" /> Existing Proxmox KVM can continue to strict readiness</span>
            <span><CheckCircle2 size={14} aria-hidden="true" /> Compatible Ubuntu hosts can prepare the Linux Sandbox runtime</span>
            <span><CheckCircle2 size={14} aria-hidden="true" /> A virtual-machine host needs nested KVM for hardware VMs</span>
          </div>
          <details className={styles.hostSupportDisclosure}>
            <summary>Proxmox, KVM, and gVisor explained</summary>
            <p>
              Proxmox manages capacity; KVM is the hardware-VM isolation boundary.
              A hardware VM can still share one physical server. gVisor is a supported
              application-kernel sandbox for Linux terminal and Python workspaces on a
              compatible prepared host; it is not a general desktop or Windows VM.
            </p>
          </details>
          <button type="button" className={styles.primaryButton} onClick={onConnectExisting}>
            Connect existing host <ArrowRight size={14} aria-hidden="true" />
          </button>
        </article>
      </div>

      <aside className={styles.whatHappens} aria-labelledby="what-happens-heading">
        <div>
          <span className={styles.sectionLabel}>What happens</span>
          <h3 id="what-happens-heading">Connect first. Change nothing until you approve it.</h3>
        </div>
        <ol>
          <li><span>1</span> Choose managed capacity or connect your own</li>
          <li><span>2</span> Sync entitlements or inspect capacity</li>
          <li><span>3</span> Show available power and isolation truthfully</li>
          <li><span>4</span> Ask before payment, preparation, or launch</li>
        </ol>
      </aside>

      <details className={styles.manualDisclosure}>
        <summary>
          <SlidersHorizontal size={15} aria-hidden="true" />
          Manual SSH setup
          <span>Custom user, port, key, and pinned fingerprint</span>
        </summary>
        <div>
          <p>
            Use this when the guided defaults do not match your server. You will enter
            the same connection contract directly; Hivra still inspects before setup.
          </p>
          <button type="button" className={styles.tertiaryButton} onClick={onConnectExisting}>
            Open manual connection form <ArrowRight size={13} aria-hidden="true" />
          </button>
        </div>
      </details>
    </section>
  );
}

function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className={styles.emptyState} role="alert">
      <span className={styles.emptyIcon} aria-hidden="true"><AlertTriangle size={24} /></span>
      <h3>Connections could not be loaded.</h3>
      <p>{message}</p>
      <button type="button" className={styles.secondaryButton} onClick={onRetry}>
        <RefreshCw size={14} aria-hidden="true" /> Try again
      </button>
    </div>
  );
}

function DeleteConnectionDialog({
  connection,
  deleting,
  onCancel,
  onConfirm,
}: {
  connection: InfrastructureConnectionDto;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useInfrastructureDialog({
    onClose: onCancel,
    closeOnEscape: !deleting,
    initialFocusRef: cancelRef,
  });

  return (
    <div className={styles.modalBackdrop}>
      <section
        ref={dialogRef}
        className={styles.confirmDialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-connection-title"
        aria-describedby="delete-connection-description"
        tabIndex={-1}
      >
        <span className={styles.dangerIcon} aria-hidden="true"><Trash2 size={20} /></span>
        <span className={styles.eyebrow}>Remove connection</span>
        <h2 id="delete-connection-title">Disconnect {connection.name}?</h2>
        <p id="delete-connection-description">
          {connection.provider === "hetzner-cloud" ? (
            <>
              This permanently removes Hivra’s stored project token and its only saved
              generated SSH private key for any retained created or ambiguous server.
              After disconnecting, Hivra cannot reconcile an ambiguous request or clean
              up its provider resources.
              It does not delete the provider server, Primary IPs, or Hivra-created public
              key in Hetzner, so billing continues until you remove those resources there.
              Regaining server access may require Hetzner rescue mode or a rebuild, and
              provider resources may still need manual cleanup.
            </>
          ) : (
            <>
              This removes Hivra’s saved connection and encrypted credential. It does not
              delete the server or change anything already running on it.
            </>
          )}
        </p>
        <div className={styles.resultActions}>
          <button
            ref={cancelRef}
            type="button"
            className={styles.secondaryButton}
            onClick={onCancel}
            disabled={deleting}
          >
            Keep connection
          </button>
          <button
            type="button"
            className={styles.dangerButton}
            onClick={onConfirm}
            disabled={deleting}
          >
            {deleting ? <Loader2 size={14} className={styles.spin} aria-hidden="true" /> : <Trash2 size={14} aria-hidden="true" />}
            {deleting ? "Removing…" : "Remove connection"}
          </button>
        </div>
      </section>
    </div>
  );
}

function ForceForgetHetznerDialog({
  connection,
  forgetting,
  error,
  onCancel,
  onConfirm,
}: {
  connection: HetznerCloudConnectionDto;
  forgetting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [confirmation, setConfirmation] = useState("");
  const confirmationRef = useRef<HTMLInputElement>(null);
  const dialogRef = useInfrastructureDialog({
    onClose: onCancel,
    closeOnEscape: !forgetting,
    initialFocusRef: confirmationRef,
  });
  const confirmed = confirmation === HETZNER_CLOUD_FORCE_FORGET_CONFIRMATION;

  return (
    <div className={styles.modalBackdrop}>
      <section
        ref={dialogRef}
        className={styles.confirmDialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="force-forget-connection-title"
        aria-describedby="force-forget-connection-description"
        tabIndex={-1}
      >
        <span className={styles.dangerIcon} aria-hidden="true"><AlertTriangle size={20} /></span>
        <span className={styles.eyebrow}>Canary escape hatch</span>
        <h2 id="force-forget-connection-title">Forget Hivra access to {connection.name}?</h2>
        <p id="force-forget-connection-description">
          Hivra cannot safely finish a normal disconnect because this project has an
          unresolved provider request. This separate action forgets local access only.
          It does not cancel or delete anything at Hetzner.
        </p>

        <div className={`${styles.capacityBoundary} ${styles.capacityCritical}`}>
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>Provider resources and billing may remain.</strong>
            <span>
              First inspect Hetzner Console for the server, Primary IPv4/IPv6, and
              Hivra-created SSH key. Continuing permanently wipes Hivra’s stored project
              token and sole private key, ends Hivra reconciliation and cleanup, and does
              not free this account’s one Canary capacity slot.
            </span>
            <a
              className={`${styles.secondaryButton} ${styles.capacityCriticalAction}`}
              href={HETZNER_PROJECTS_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              Inspect Hetzner Console <ExternalLink size={13} aria-hidden="true" />
            </a>
          </div>
        </div>

        <label className={`${styles.field} ${styles.forceForgetField}`}>
          <span className={styles.fieldLabel}>Type the exact confirmation</span>
          <input
            ref={confirmationRef}
            aria-label="Type the exact confirmation"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={forgetting}
            aria-describedby="force-forget-confirmation-hint"
          />
          <span id="force-forget-confirmation-hint" className={styles.fieldHint}>
            {HETZNER_CLOUD_FORCE_FORGET_CONFIRMATION}
          </span>
        </label>

        {error ? (
          <div className={styles.formError} role="alert">
            <AlertTriangle size={16} aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : null}

        <div className={styles.resultActions}>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={onCancel}
            disabled={forgetting}
          >
            Keep Hivra access
          </button>
          <button
            type="button"
            className={styles.dangerButton}
            onClick={onConfirm}
            disabled={!confirmed || forgetting}
          >
            {forgetting ? <Loader2 size={14} className={styles.spin} aria-hidden="true" /> : <Trash2 size={14} aria-hidden="true" />}
            {forgetting ? "Forgetting…" : "Forget Hivra access only"}
          </button>
        </div>
      </section>
    </div>
  );
}

function ConnectionCheckDialog({
  state,
  checking,
  onClose,
  onRetryDiscovery,
  onStrictPreflight,
  onRetryPreflight,
  onPrepareRequested,
}: {
  state: CheckDialogState;
  checking: boolean;
  onClose: () => void;
  onRetryDiscovery: () => void;
  onStrictPreflight: (discovery: HostDiscoveryResult) => void;
  onRetryPreflight: () => void;
  onPrepareRequested: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const dialogRef = useInfrastructureDialog({
    onClose,
    closeOnEscape: !checking,
    initialFocusRef: closeRef,
  });

  useEffect(() => {
    if (state.phase === "discovering" || state.phase === "preflighting") {
      headingRef.current?.focus();
    }
  }, [state.phase]);

  const strictStage = state.phase === "preflighting" || state.phase === "preflight";

  return (
    <div className={styles.modalBackdrop}>
      <section
        ref={dialogRef}
        className={`${styles.wizard} ${styles.resultDialog}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="connection-check-dialog-title"
        tabIndex={-1}
      >
        <header className={styles.wizardHeader}>
          <div>
            <span className={styles.eyebrow}>{strictStage ? "Strict readiness" : "Host inspection"}</span>
            <h1 ref={headingRef} tabIndex={-1} id="connection-check-dialog-title">
              {strictStage ? `Check ${state.connection.name}` : `Inspect ${state.connection.name}`}
            </h1>
          </div>
          <button
            ref={closeRef}
            type="button"
            className={styles.closeButton}
            onClick={onClose}
            disabled={checking}
            aria-label="Close host inspection"
          >
            <X size={19} aria-hidden="true" />
          </button>
        </header>
        <div className={styles.wizardBody}>
          {state.phase === "discovering" ? (
            <div className={styles.checkingState} role="status" aria-live="polite">
              <span className={styles.checkingVisual} aria-hidden="true">
                <ServerCog size={28} />
                <span />
                <Loader2 size={18} className={styles.spin} />
              </span>
              <span className={styles.eyebrow}>Read-only inspection</span>
              <h2>Inspecting this host...</h2>
              <p>
                Hivra is detecting identity, operating system, capacity, environment,
                KVM access, and installed isolation engines. Nothing is being changed.
              </p>
            </div>
          ) : state.phase === "discovery" && state.discovery ? (
            <InfrastructureHostDiscoveryResult
              result={state.discovery}
              connectionId={state.connection.id}
              onRetry={onRetryDiscovery}
              onDone={onClose}
              onStrictPreflightRequested={supportsStrictProxmoxDiscovery(state.discovery)
                ? () => onStrictPreflight(state.discovery as HostDiscoveryResult)
                : undefined}
              retrying={checking}
            />
          ) : state.phase === "preflighting" ? (
            <div className={styles.checkingState} role="status" aria-live="polite">
              <span className={styles.checkingVisual} aria-hidden="true">
                <ShieldCheck size={28} />
                <span />
                <Loader2 size={18} className={styles.spin} />
              </span>
              <span className={styles.eyebrow}>Strict readiness check</span>
              <h2>Verifying exact launch requirements...</h2>
              <p>
                Hivra is checking Proxmox isolation, network, storage, image, host tools,
                and current capacity. This does not prepare or launch an agent.
              </p>
            </div>
          ) : state.phase === "preflight" && state.preflight ? (
            <InfrastructurePreflightResult
              result={state.preflight}
              onRetry={onRetryPreflight}
              onDone={onClose}
              onPrepareRequested={state.discovery
                && supportsStrictProxmoxDiscovery(state.discovery)
                && canPrepareFromPreflight(state.connection, state.preflight)
                ? onPrepareRequested
                : undefined}
              retrying={checking}
            />
          ) : (
            <div className={`${styles.resultPanel} ${styles.resultError}`} role="alert">
              <div className={styles.resultHero}>
                <span className={styles.resultIcon} aria-hidden="true"><AlertTriangle size={22} /></span>
                <div>
                  <span className={styles.eyebrow}>{strictStage ? "Readiness interrupted" : "Inspection interrupted"}</span>
                  <h2 className={styles.resultTitle}>
                    {strictStage ? "The strict readiness check could not finish." : "The host inspection could not finish."}
                  </h2>
                  <p className={styles.resultDescription}>{state.error}</p>
                </div>
              </div>
              <div className={styles.resultActions}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={strictStage ? onRetryPreflight : onRetryDiscovery}
                >
                  <RefreshCw size={14} aria-hidden="true" /> Try again
                </button>
                <button ref={closeRef} type="button" className={styles.primaryButton} onClick={onClose}>Done</button>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
