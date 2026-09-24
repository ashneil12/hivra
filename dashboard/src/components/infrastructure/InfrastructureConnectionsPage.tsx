"use client";

import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  ServerCog,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isHivraEnabled } from "@/lib/hivra/hivra-flag";

import {
  deleteInfrastructureConnection,
  discoverInfrastructureHost,
  forceForgetHetznerCloudConnection,
  getHetznerCloudCapacitySlot,
  getHetznerCloudInventory,
  InfrastructureApiError,
  listInfrastructureConnections,
  listInfrastructureTargets,
  listProviderComputerSetupEvidence,
  preflightInfrastructureConnection,
  refreshHetznerCloudInventory,
  type InfrastructurePreparation,
} from "@/lib/infrastructure/client";
import {
  listManagedSessions,
  refreshDigitalOceanAccount,
} from "@/lib/hivra/managed-session-client";
import type { ManagedSessionDto } from "@/lib/hivra/managed-session-contracts";
import type {
  DeploymentTargetDto,
  DigitalOceanConnectionDto,
  DigitalOceanDeploymentTargetDto,
  HetznerCloudConnectionDto,
  HetznerCloudConnectionErrorCode,
  HetznerCloudServerInventoryDto,
  InfrastructureConnectionDto,
  ProxmoxPreflightResult,
  SshInfrastructureConnectionDto,
} from "@/lib/infrastructure/contracts";
import {
  HETZNER_CLOUD_CONNECTION_ERROR_CODES,
  HETZNER_CLOUD_FORCE_FORGET_CONFIRMATION,
} from "@/lib/infrastructure/contracts";
import type { HostDiscoveryResult } from "@/lib/infrastructure/host-discovery-contracts";
import {
  hetznerCloudTokenReplacedNotice,
  type HetznerCloudCapacitySlotDto,
} from "@/lib/infrastructure/hetzner-cloud-token-contracts";
import type {
  HetznerCloudCreatedServer,
  ProviderComputerSetupView,
} from "@/lib/infrastructure/provider-computer-setup-contracts";
import {
  getHivraCloudCapacity,
  type HivraCloudCapacityDto,
} from "@/lib/infrastructure/hivra-cloud-client";
import { canPrepareFromPreflight } from "@/lib/infrastructure/preparation-eligibility";
import { targetSupportsLaunchResource } from "@/lib/infrastructure/launch-on-server";
import { getAgent } from "@/lib/hivra/agent-catalog";
import {
  buildLaunchSetupHref,
  parsePortableLaunchResourceId,
} from "@/lib/hivra/launch-navigation";
import { isLocalAuthMode } from "@/lib/self-host/config";

import { InfrastructureEntryChooser } from "./InfrastructureEntryChooser";
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
import { HetznerCloudConnectionCard, type HetznerSetupEvidenceStatus } from "./HetznerCloudConnectionCard";
import { HetznerCloudConnectionDialog } from "./HetznerCloudConnectionDialog";
import { DigitalOceanConnectionCard } from "./DigitalOceanConnectionCard";
import { DigitalOceanConnectionDialog } from "./DigitalOceanConnectionDialog";
import { DigitalOceanLaunchDialog } from "./DigitalOceanLaunchDialog";
import { LaunchOnServerProvider, usePendingLaunch } from "./LaunchOnServer";
import styles from "./Infrastructure.module.css";
import { useInfrastructureDialog } from "./useInfrastructureDialog";

const HETZNER_PROJECTS_URL = "https://console.hetzner.com/projects";


type CheckDialogState = {
  connection: SshInfrastructureConnectionDto;
  phase: "discovering" | "discovery" | "preflighting" | "preflight";
  discovery?: HostDiscoveryResult;
  preflight?: ProxmoxPreflightResult;
  error?: string;
};

/** Which host setup the shared review dialog is running, and on what. */
type PreparingState = {
  connection: SshInfrastructureConnectionDto;
  engine: "proxmox" | "gvisor";
  mode: "prepare" | "repair";
};

type HetznerInventoryState = {
  inventory: HetznerCloudServerInventoryDto[];
  loading: boolean;
  error: string | null;
};

/** The last loaded setup evidence for one connection and whether it's current. */
type HetznerSetupEvidenceState = {
  status: HetznerSetupEvidenceStatus;
  computers: ProviderComputerSetupView[];
  createdServers: HetznerCloudCreatedServer[];
};

function isSshConnection(
  connection: InfrastructureConnectionDto,
): connection is SshInfrastructureConnectionDto {
  return connection.provider === "proxmox" || connection.provider === "host";
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
  // DigitalOcean sessions are Hivra agents; offer them only where those are on.
  const [hivraAgentsEnabled, setHivraAgentsEnabled] = useState(false);
  useEffect(() => {
    setHivraAgentsEnabled(isHivraEnabled());
  }, []);
  const searchParams = useSearchParams();
  const requestedLaunchResource = parsePortableLaunchResourceId(searchParams?.get("launch"));
  // Deep link from a DigitalOcean agent whose token stopped working.
  const requestedTokenReplacement = searchParams?.get("replaceToken") ?? null;
  const unifiedLaunchReturn = searchParams?.get("returnTo") === "unified-launch";
  const selfHosted = isLocalAuthMode();
  const pendingLaunch = usePendingLaunch();
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
  const [digitalOceanDialogOpen, setDigitalOceanDialogOpen] = useState(false);
  const [replacingDigitalOcean, setReplacingDigitalOcean] = useState<DigitalOceanConnectionDto | null>(null);
  const [digitalOceanLaunch, setDigitalOceanLaunch] = useState<{ connection: DigitalOceanConnectionDto; target: DigitalOceanDeploymentTargetDto } | null>(null);
  const [digitalOceanTargets, setDigitalOceanTargets] = useState<DigitalOceanDeploymentTargetDto[]>([]);
  const [managedSessions, setManagedSessions] = useState<ManagedSessionDto[]>([]);
  const [digitalOceanRefreshing, setDigitalOceanRefreshing] = useState<Set<string>>(() => new Set());
  const [digitalOceanErrors, setDigitalOceanErrors] = useState<Record<string, string>>({});
  const [capacityConnection, setCapacityConnection] = useState<HetznerCloudConnectionDto | null>(null);
  const [cleanupConnection, setCleanupConnection] = useState<HetznerCloudConnectionDto | null>(null);
  const [setupTarget, setSetupTarget] = useState<{ connection: HetznerCloudConnectionDto; orderId: string | null } | null>(null);
  const setupConnection = setupTarget?.connection ?? null;
  const [replacingHetzner, setReplacingHetzner] = useState<HetznerCloudConnectionDto | null>(null);
  const [hetznerSetups, setHetznerSetups] = useState<Record<string, HetznerSetupEvidenceState>>({});
  const hetznerSetupRequests = useRef<Record<string, number>>({});
  const [hetznerSlot, setHetznerSlot] = useState<HetznerCloudCapacitySlotDto | null>(null);
  const [wizardPrefill, setWizardPrefill] = useState<{ name: string; sshHost: string } | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editingConnection, setEditingConnection] = useState<SshInfrastructureConnectionDto | null>(null);
  const [deletingConnection, setDeletingConnection] = useState<InfrastructureConnectionDto | null>(null);
  const [forceForgetConnection, setForceForgetConnection] = useState<HetznerCloudConnectionDto | null>(null);
  const [preparing, setPreparing] = useState<PreparingState | null>(null);
  const preparingConnection = preparing?.connection ?? null;
  const [deleting, setDeleting] = useState(false);
  const [forceForgetting, setForceForgetting] = useState(false);
  const [forceForgetError, setForceForgetError] = useState<string | null>(null);
  const [checkingIds, setCheckingIds] = useState<Set<string>>(() => new Set());
  const [latestPreflight, setLatestPreflight] = useState<Record<string, ProxmoxPreflightResult>>({});
  const [checkDialog, setCheckDialog] = useState<CheckDialogState | null>(null);
  const [hetznerInventory, setHetznerInventory] = useState<Record<string, HetznerInventoryState>>({});
  const addCapacityButtonRef = useRef<HTMLButtonElement>(null);
  const modalAnchorRef = useRef<HTMLDivElement>(null);
  const openDialogKey = [
    hetznerDialogOpen ? "hetzner" : "",
    replacingHetzner ? `hetzner-token:${replacingHetzner.id}` : "",
    !selfHosted && hivraCloudDialogOpen ? "hivra-cloud" : "",
    cleanupConnection ? `cleanup:${cleanupConnection.id}` : "",
    setupConnection ? `setup:${setupConnection.id}` : "",
    capacityConnection ? `capacity:${capacityConnection.id}` : "",
    wizardOpen ? `wizard:${editingConnection?.id ?? "new"}` : "",
    deletingConnection ? `delete:${deletingConnection.id}` : "",
    forceForgetConnection ? `forget:${forceForgetConnection.id}` : "",
    preparingConnection ? `prepare:${preparingConnection.id}` : "",
    checkDialog ? `check:${checkDialog.connection.id}` : "",
  ].filter(Boolean).join("|");

  // A layout effect so the scroll lands before useInfrastructureDialog's
  // passive effect moves focus into the dialog; that focus then only scrolls
  // when its target is out of view.
  useLayoutEffect(() => {
    if (!openDialogKey) return;
    const anchor = modalAnchorRef.current;
    const dialog = anchor?.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]');
    // Phones render an open dialog as the page itself, scrolled by the
    // dashboard main. Start it at its top rather than at the scroll offset of
    // the control that opened it; focusing its sticky header does not scroll.
    if (anchor && dialog && window.getComputedStyle(dialog).overflowY === "visible") {
      anchor.scrollIntoView?.({ block: "start" });
    }
  }, [openDialogKey]);

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

  // Hivra's records say which inventory servers it created and how far their
  // setup got. Read-only; it never advances setup. Until a read succeeds, the
  // card calls no server "Not created by Hivra"; the last loaded records still
  // label the servers they name. Only the newest read may land.
  const loadHetznerSetups = useCallback(async (connectionId: string, signal?: AbortSignal) => {
    const request = (hetznerSetupRequests.current[connectionId] ?? 0) + 1;
    hetznerSetupRequests.current[connectionId] = request;
    const settle = (next: (previous: HetznerSetupEvidenceState) => HetznerSetupEvidenceState) => {
      setHetznerSetups((current) => ({
        ...current,
        [connectionId]: next(current[connectionId] ?? { status: "loading", computers: [], createdServers: [] }),
      }));
    };
    settle((previous) => ({ ...previous, status: "loading" }));
    try {
      const evidence = await listProviderComputerSetupEvidence(connectionId);
      if (signal?.aborted || hetznerSetupRequests.current[connectionId] !== request) return;
      settle(() => ({ status: "loaded", ...evidence }));
    } catch {
      if (signal?.aborted || hetznerSetupRequests.current[connectionId] !== request) return;
      settle((previous) => ({ ...previous, status: "failed" }));
    }
  }, []);

  const loadHetznerSlot = useCallback(async (signal?: AbortSignal) => {
    try {
      const slot = await getHetznerCloudCapacitySlot(signal);
      if (!signal?.aborted) setHetznerSlot(slot);
    } catch {
      // The purchase-time claim stays authoritative; Create stays available.
      if (!signal?.aborted) setHetznerSlot(null);
    }
  }, []);

  const loadConnections = useCallback(async (signal?: AbortSignal) => {
    try {
      const [connectionResult, targetResult, hivraCloudResult, managedResult] = await Promise.allSettled([
        listInfrastructureConnections(signal),
        listInfrastructureTargets(undefined, signal),
        selfHosted ? Promise.resolve(null) : getHivraCloudCapacity(signal),
        listManagedSessions(signal),
      ]);
      if (signal?.aborted) return;
      if (managedResult.status === "fulfilled") {
        setDigitalOceanTargets(managedResult.value.targets);
        setManagedSessions(managedResult.value.sessions);
      }
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
      let hasHetzner = false;
      for (const connection of connectionResult.value) {
        if (connection.provider === "hetzner-cloud") {
          hasHetzner = true;
          void loadHetznerInventory(connection.id, { signal });
          void loadHetznerSetups(connection.id, signal);
        }
      }
      if (hasHetzner) void loadHetznerSlot(signal);
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
  }, [loadHetznerInventory, loadHetznerSetups, loadHetznerSlot, selfHosted]);

  useEffect(() => {
    const controller = new AbortController();
    void loadConnections(controller.signal);
    return () => controller.abort();
  }, [loadConnections]);

  // Open "Replace token" once for the connection a deep link names.
  const handledTokenReplacement = useRef<string | null>(null);
  useEffect(() => {
    if (!requestedTokenReplacement || handledTokenReplacement.current === requestedTokenReplacement) return;
    const connection = connections.find((candidate) => candidate.id === requestedTokenReplacement);
    if (!connection || connection.provider !== "digitalocean") return;
    handledTokenReplacement.current = requestedTokenReplacement;
    setReplacingDigitalOcean(connection);
  }, [connections, requestedTokenReplacement]);

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
        && targetSupportsLaunchResource(target, requestedLaunchResource)
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
    && connections.length === 0
    && !hasHivraCloudCapacity;
  const showingEntryChooser = showingFirstConnection || entryChooserOpen;

  function openCreateWizard() {
    setEntryChooserOpen(true);
    setEditingConnection(null);
    setWizardPrefill(null);
    setWizardOpen(true);
    setActionError(null);
    setActionNotice(null);
  }

  function openHivraCloudDialog() {
    setEntryChooserOpen(true);
    setHivraCloudDialogOpen(true);
    setActionError(null);
    setActionNotice(null);
  }

  function openDigitalOceanDialog() {
    setEntryChooserOpen(true);
    setDigitalOceanDialogOpen(true);
    setActionError(null);
    setActionNotice(null);
  }

  async function refreshDigitalOcean(connectionId: string) {
    setDigitalOceanRefreshing((current) => new Set(current).add(connectionId));
    try {
      const result = await refreshDigitalOceanAccount(connectionId);
      upsertConnection(result.connection);
      setDigitalOceanTargets((current) => [result.target, ...current.filter((target) => target.id !== result.target.id)]);
      setDigitalOceanErrors((current) => {
        const next = { ...current };
        delete next[connectionId];
        return next;
      });
    } catch (error) {
      setDigitalOceanErrors((current) => ({
        ...current,
        [connectionId]: error instanceof Error ? error.message : "DigitalOcean could not be checked.",
      }));
    } finally {
      setDigitalOceanRefreshing((current) => {
        const next = new Set(current);
        next.delete(connectionId);
        return next;
      });
    }
  }

  /** A server Hivra didn't create connects the way any other server does,
   * with its public address filled in. */
  function connectExistingServer(server: HetznerCloudServerInventoryDto) {
    const sshHost = server.publicNetwork.ipv4 ?? server.publicNetwork.ipv6?.split("/")[0] ?? "";
    if (!sshHost) return;
    setWizardPrefill({ name: server.name, sshHost });
    setEditingConnection(null);
    setWizardOpen(true);
    setActionError(null);
    setActionNotice(null);
  }

  function openHetznerDialog() {
    setEntryChooserOpen(true);
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

  // The page reloads target evidence rather than trusting the dialog's copy.
  async function recordGvisorPreparation() {
    await loadConnections();
  }

  /** Close whichever inspection is open and hand over to the review dialog. */
  function requestGvisorSetup(connection: InfrastructureConnectionDto, mode: "prepare" | "repair") {
    if (!isSshConnection(connection)) return;
    setWizardOpen(false);
    setEditingConnection(null);
    setWizardPrefill(null);
    setCheckDialog(null);
    setPreparing({ connection, engine: "gvisor", mode });
  }

  /** Close the inspection and open the connection's settings. */
  function requestConnectionEdit(connection: InfrastructureConnectionDto) {
    if (!isSshConnection(connection)) return;
    setCheckDialog(null);
    setWizardPrefill(null);
    openEditWizard(connection);
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
    <LaunchOnServerProvider pending={pendingLaunch} targets={targets}>
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
                ? "Connect a cloud project or bring a computer you control."
                : "Manage your plan and the machines that power your agents and computers."}
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
              {entryChooserOpen ? "Close options" : "Add infrastructure"}
            </button>
          ) : null}
        </header>

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
            onConnectDigitalOcean={hivraAgentsEnabled ? openDigitalOceanDialog : undefined}
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
                        setups={hetznerSetups[connection.id]?.computers ?? []}
                        createdServers={hetznerSetups[connection.id]?.createdServers ?? []}
                        setupEvidence={hetznerSetups[connection.id]?.status ?? "loading"}
                        onRetrySetupEvidence={() => void loadHetznerSetups(connection.id)}
                        slot={hetznerSlot}
                        loading={state.loading}
                        error={state.error}
                        launchResourceId={requestedLaunchResource}
                        unifiedLaunchReturn={unifiedLaunchReturn}
                        onCreateCapacity={() => setCapacityConnection(connection)}
                        onCleanup={() => setCleanupConnection(connection)}
                        onSetup={(orderId) => setSetupTarget({ connection, orderId: orderId ?? null })}
                        onReplaceToken={() => setReplacingHetzner(connection)}
                        onConnectExistingServer={(server) => connectExistingServer(server)}
                        onRefresh={() => {
                          void loadHetznerInventory(connection.id, { refresh: true });
                          void loadHetznerSetups(connection.id);
                          void loadHetznerSlot();
                        }}
                        onDelete={() => setDeletingConnection(connection)}
                      />
                    );
                  }
                  if (connection.provider === "digitalocean") {
                    const target = digitalOceanTargets.find((candidate) => candidate.connectionId === connection.id) ?? null;
                    return (
                      <DigitalOceanConnectionCard
                        key={connection.id}
                        connection={connection}
                        target={target}
                        sessions={managedSessions.filter((session) => session.connectionId === connection.id)}
                        refreshing={digitalOceanRefreshing.has(connection.id)}
                        error={digitalOceanErrors[connection.id] ?? null}
                        onLaunch={() => { if (target) setDigitalOceanLaunch({ connection, target }); }}
                        onRefresh={() => void refreshDigitalOcean(connection.id)}
                        onReplaceToken={() => setReplacingDigitalOcean(connection)}
                        onDelete={() => setDeletingConnection(connection)}
                        onExpiryChanged={(credentialExpiry) => setConnections((current) => current.map((candidate) => (
                          candidate.id === connection.id && candidate.provider === "digitalocean"
                            ? { ...candidate, credentialExpiry }
                            : candidate
                        )))}
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
                      onPrepare={() => setPreparing({ connection, engine: "proxmox", mode: "prepare" })}
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
      <div ref={modalAnchorRef} className={styles.modalAnchor} data-infrastructure-modal-anchor>
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

          {replacingHetzner ? (
            <HetznerCloudConnectionDialog
              replacing={replacingHetzner}
              onClose={() => setReplacingHetzner(null)}
              returnFocusRef={addCapacityButtonRef}
              onReplaced={({ connection, inventory, projectCheck }) => {
                upsertConnection(connection);
                if (inventory) {
                  setHetznerInventory((current) => ({
                    ...current,
                    [connection.id]: { inventory, loading: false, error: null },
                  }));
                } else {
                  // Saved, but the server list wasn't: read it with the new token.
                  void loadHetznerInventory(connection.id, { refresh: true });
                }
                void loadHetznerSetups(connection.id);
                setReplacingHetzner(null);
                setActionNotice(hetznerCloudTokenReplacedNotice(connection.name, projectCheck));
              }}
              onReplaceUnconfirmed={() => {
                // The token was swapped; show what the connection holds now.
                void loadConnections();
              }}
            />
          ) : null}

          {digitalOceanDialogOpen ? (
            <DigitalOceanConnectionDialog
              onClose={() => setDigitalOceanDialogOpen(false)}
              returnFocusRef={addCapacityButtonRef}
              onConnected={(connection, target) => {
                upsertConnection(connection);
                setDigitalOceanTargets((current) => [target, ...current.filter((candidate) => candidate.id !== target.id)]);
                setDigitalOceanDialogOpen(false);
                setDigitalOceanLaunch({ connection, target });
              }}
            />
          ) : null}

          {replacingDigitalOcean ? (
            <DigitalOceanConnectionDialog
              replacing={replacingDigitalOcean}
              onClose={() => setReplacingDigitalOcean(null)}
              returnFocusRef={addCapacityButtonRef}
              onConnected={(connection, target) => {
                upsertConnection(connection);
                setDigitalOceanTargets((current) => [target, ...current.filter((candidate) => candidate.id !== target.id)]);
                setDigitalOceanErrors((current) => {
                  const next = { ...current };
                  delete next[connection.id];
                  return next;
                });
                setReplacingDigitalOcean(null);
              }}
            />
          ) : null}

          {digitalOceanLaunch ? (
            <DigitalOceanLaunchDialog
              connection={digitalOceanLaunch.connection}
              target={digitalOceanLaunch.target}
              onClose={() => setDigitalOceanLaunch(null)}
              returnFocusRef={addCapacityButtonRef}
              onLaunched={(session) => {
                setManagedSessions((current) => [session, ...current.filter((candidate) => candidate.agentId !== session.agentId)]);
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

          {setupTarget && <ProviderComputerSetupDialog connection={setupTarget.connection}
            orderId={setupTarget.orderId}
            launchResourceId={requestedLaunchResource}
            unifiedLaunchReturn={unifiedLaunchReturn}
            onClose={() => setSetupTarget(null)}
            onChanged={() => {
              void loadConnections();
              void loadHetznerInventory(setupTarget.connection.id, { refresh: true });
              void loadHetznerSetups(setupTarget.connection.id);
            }} />}

          {capacityConnection ? (
            <HetznerCloudCapacityDialog
              connection={capacityConnection}
              returnFocusRef={addCapacityButtonRef}
              onClose={() => setCapacityConnection(null)}
              slot={hetznerSlot}
              launchResourceId={requestedLaunchResource}
              launchLabel={requestedLaunchLabel}
              unifiedLaunchReturn={unifiedLaunchReturn}
              onChanged={() => {
                void loadHetznerSetups(capacityConnection.id);
                void loadHetznerSlot();
                void loadConnections();
              }}
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
              // A new key when the wizard switches to editing a saved host,
              // so the edit form starts from that host rather than the draft.
              key={editingConnection?.id ?? "new"}
              connection={editingConnection}
              prefill={editingConnection ? null : wizardPrefill}
              returnFocusRef={addCapacityButtonRef}
              onClose={() => {
                setWizardOpen(false);
                setEditingConnection(null);
                setWizardPrefill(null);
                void loadConnections();
              }}
              onConnectionSaved={upsertConnection}
              onPreflightComplete={recordPreflight}
              onPrepareRequested={(saved) => {
                setWizardOpen(false);
                setEditingConnection(null);
                setWizardPrefill(null);
                if (isSshConnection(saved)) setPreparing({ connection: saved, engine: "proxmox", mode: "prepare" });
              }}
              onGvisorSetupRequested={requestGvisorSetup}
              onEditRequested={requestConnectionEdit}
              onGvisorReady={() => void loadConnections()}
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

          {preparing ? (
            <InfrastructurePrepareDialog
              key={`${preparing.connection.id}:${preparing.engine}:${preparing.mode}`}
              connection={preparing.connection}
              engine={preparing.engine}
              mode={preparing.mode}
              onClose={() => {
                setPreparing(null);
                void loadConnections();
              }}
              onPrepared={recordPreparation}
              onGvisorPrepared={recordGvisorPreparation}
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
                setPreparing({ connection: checkDialog.connection, engine: "proxmox", mode: "prepare" });
              }}
              onGvisorSetupRequested={(mode) => requestGvisorSetup(checkDialog.connection, mode)}
              onEditRequested={() => requestConnectionEdit(checkDialog.connection)}
              onGvisorReady={() => void loadConnections()}
            />
          ) : null}
        </div>
      </div>
    </div>
    </LaunchOnServerProvider>
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
          {connection.provider === "digitalocean" ? (
            <>
              This removes Hivra’s stored DigitalOcean token. Delete every agent on this connection first;
              Hivra will not disconnect while it still owns a DigitalOcean session, so nothing keeps billing
              without a way to stop it here.
            </>
          ) : connection.provider === "hetzner-cloud" ? (
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
  const mismatch = confirmation.length > 0 && !confirmed;

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
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            disabled={forgetting}
            aria-describedby={mismatch
              ? "force-forget-confirmation-hint force-forget-confirmation-mismatch"
              : "force-forget-confirmation-hint"}
          />
          <span id="force-forget-confirmation-hint" className={styles.fieldHint}>
            {HETZNER_CLOUD_FORCE_FORGET_CONFIRMATION}
          </span>
          {mismatch ? (
            <span id="force-forget-confirmation-mismatch" className={styles.fieldHint}>
              Doesn&apos;t match yet
            </span>
          ) : null}
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
  onGvisorSetupRequested,
  onEditRequested,
  onGvisorReady,
}: {
  state: CheckDialogState;
  checking: boolean;
  onClose: () => void;
  onRetryDiscovery: () => void;
  onStrictPreflight: (discovery: HostDiscoveryResult) => void;
  onRetryPreflight: () => void;
  onPrepareRequested: () => void;
  onGvisorSetupRequested: (mode: "prepare" | "repair") => void;
  onEditRequested: () => void;
  onGvisorReady: () => void;
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
              hostName={state.connection.name}
              sshUser={state.connection.endpoint.sshUser}
              connectionId={state.connection.id}
              onRetry={onRetryDiscovery}
              onDone={onClose}
              onStrictPreflightRequested={supportsStrictProxmoxDiscovery(state.discovery)
                ? () => onStrictPreflight(state.discovery as HostDiscoveryResult)
                : undefined}
              onGvisorSetupRequested={onGvisorSetupRequested}
              onConnectAsRootRequested={onEditRequested}
              onGvisorReady={onGvisorReady}
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
