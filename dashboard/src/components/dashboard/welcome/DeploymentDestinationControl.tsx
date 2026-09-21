"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Check,
  Cloud,
  Loader2,
  RefreshCw,
  Server,
  ShieldCheck,
} from "lucide-react";

import { listInfrastructureTargets } from "@/lib/infrastructure/client";
import { isProxmoxDeploymentTarget, type DeploymentTargetDto } from "@/lib/infrastructure/contracts";
import {
  DEFAULT_AGENT_DEPLOYMENT_DESTINATION,
  targetSupportsCatalogRuntime,
  type AgentDeploymentDestination,
} from "@/lib/hivra/agent-placement";
import {
  formatInfrastructureBytes,
  formatInfrastructureDate,
} from "@/lib/infrastructure/formatters";

import styles from "./DeploymentDestinationControl.module.css";
import type { LaunchTargetHandoff } from "./launch-target-handoff";
import { isLocalAuthMode } from "@/lib/self-host/config";

type LaunchDestinationMode = AgentDeploymentDestination["mode"];

export type LaunchDestinationState = {
  mode: LaunchDestinationMode;
  setMode: (mode: LaunchDestinationMode) => void;
  readyTargets: DeploymentTargetDto[];
  incompatibleReadyTargetCount: number;
  selectedTarget: DeploymentTargetDto | null;
  selectedTargetId: string;
  setSelectedTargetId: (targetId: string) => void;
  deployment: AgentDeploymentDestination | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

export type MeasuredTargetCapacity = {
  cpu: number;
  ramGb: number;
};

export function measuredTargetCapacity(
  target: DeploymentTargetDto | null,
): MeasuredTargetCapacity {
  const availableMemoryBytes = target?.capacity.memoryBytes.available ?? null;
  return {
    cpu: target?.capacity.cpu.totalCores ?? 0,
    ramGb: availableMemoryBytes === null
      ? 0
      : Math.floor(availableMemoryBytes / 1024 ** 3),
  };
}

export function deploymentForTarget(
  target: DeploymentTargetDto | null,
): AgentDeploymentDestination | null {
  if (!target) return null;
  return {
    mode: "self-managed",
    connectionId: target.connectionId,
    targetId: target.id,
    expectedConnectionRevision: target.evidenceConnectionRevision,
  };
}

export function useLaunchDestination(
  catalogRuntimeId: string | null,
  {
    handoff = null,
    preferSelfManaged = false,
    targetKind = "any",
  }: {
    handoff?: LaunchTargetHandoff | null;
    preferSelfManaged?: boolean;
    targetKind?: "any" | "proxmox" | "gvisor";
  } = {},
): LaunchDestinationState {
  const selfHosted = isLocalAuthMode();
  const handoffKey = handoff?.key ?? null;
  const initialChoice = {
    handoffKey,
    mode: (handoff || selfHosted || preferSelfManaged ? "self-managed" : "hivra-managed") as LaunchDestinationMode,
    // null means no selection yet; an invalid handoff is an explicit blocked
    // selection, not permission to auto-pick a different computer.
    targetId: handoff ? handoff.targetId ?? "" : null as string | null,
  };
  const [choice, setChoice] = useState(initialChoice);
  if (choice.handoffKey !== handoffKey) setChoice(initialChoice);
  const currentChoice = choice.handoffKey === handoffKey ? choice : initialChoice;
  const { mode } = currentChoice;
  const [refreshToken, setRefreshToken] = useState(0);
  const scope = useMemo(
    () => ({ catalogRuntimeId, handoffKey, refreshToken, targetKind }),
    [catalogRuntimeId, handoffKey, refreshToken, targetKind],
  );
  const [evidence, setEvidence] = useState<{
    scope: typeof scope;
    targets: DeploymentTargetDto[];
    incompatibleReadyTargetCount: number;
    error: string | null;
  } | null>(null);
  // Invalidate synchronously on navigation/runtime changes. A previous host
  // must not remain launchable while the new lookup is pending.
  const loading = evidence?.scope !== scope;
  const targets = !loading && evidence ? evidence.targets : [];
  const incompatibleReadyTargetCount = !loading && evidence ? evidence.incompatibleReadyTargetCount : 0;
  const error = !loading && evidence ? evidence.error : null;

  useEffect(() => {
    const controller = new AbortController();
    listInfrastructureTargets(undefined, controller.signal)
      .then((nextTargets) => {
        if (controller.signal.aborted) return;
        const launchReadyTargets = nextTargets.filter((target) =>
          target.status === "ready"
          && target.capabilities.launchReady
          && (targetKind !== "proxmox" || isProxmoxDeploymentTarget(target))
          && (targetKind !== "gvisor" || (target.capabilities as unknown as { kind?: string }).kind === "gvisor"),
        );
        const nextReadyTargets = launchReadyTargets.filter((target) =>
          targetSupportsCatalogRuntime(target, catalogRuntimeId),
        );
        setEvidence({ scope, targets: nextReadyTargets,
          incompatibleReadyTargetCount: launchReadyTargets.length - nextReadyTargets.length, error: null });
        // Never clear an established selection on disappearance/error: doing
        // so would silently select the first other host on the next refresh.
        setChoice(current => current.handoffKey === handoffKey && current.targetId === null
          ? { ...current, targetId: nextReadyTargets[0]?.id ?? null } : current);
      })
      .catch((loadError) => {
        if (controller.signal.aborted) return;
        setEvidence({ scope, targets: [], incompatibleReadyTargetCount: 0,
          error: loadError instanceof Error
            ? loadError.message
            : "Hivra could not load your ready hosts." });
      });
    return () => controller.abort();
  }, [catalogRuntimeId, handoffKey, scope, targetKind]);

  const selectedTarget = targets.find((target) => target.id === currentChoice.targetId) ?? null;

  const setMode = useCallback((nextMode: LaunchDestinationMode) => {
    if (selfHosted && nextMode === "hivra-managed") return;
    if (nextMode === "self-managed" && targets.length === 0) return;
    setChoice(current => ({ ...current, mode: nextMode }));
  }, [selfHosted, targets.length]);

  const deployment = useMemo<AgentDeploymentDestination | null>(
    () => mode === "self-managed"
      ? (!loading && selectedTarget ? deploymentForTarget(selectedTarget) : null)
      : selfHosted ? null : DEFAULT_AGENT_DEPLOYMENT_DESTINATION,
    [loading, mode, selectedTarget, selfHosted],
  );

  return {
    mode,
    setMode,
    readyTargets: targets,
    incompatibleReadyTargetCount,
    selectedTarget,
    selectedTargetId: selectedTarget?.id ?? "",
    // Selecting or restoring a target is itself an explicit self-managed
    // choice. Preserve even a disappeared ID so a refresh blocks instead of
    // silently falling back to managed capacity.
    setSelectedTargetId: targetId => setChoice(current => ({ ...current, mode: "self-managed", targetId })),
    deployment,
    loading,
    error,
    refresh: () => {
      setRefreshToken((current) => current + 1);
    },
  };
}

export function DeploymentDestinationControl({
  state,
  disabled = false,
  managedAvailable = true,
  runtimeName = "this agent",
  resourceLabel = "agent",
  capacitySetupHref = "/dashboard/infrastructure",
}: {
  state: LaunchDestinationState;
  disabled?: boolean;
  managedAvailable?: boolean;
  runtimeName?: string;
  resourceLabel?: "agent" | "computer";
  capacitySetupHref?: string;
}) {
  const selfHosted = isLocalAuthMode();
  const selfManagedAvailable = state.readyTargets.length > 0;
  const selectedTarget = state.selectedTarget;

  return (
    <section
      className={styles.panel}
      aria-labelledby="launch-destination-heading"
      aria-busy={state.loading}
    >
      <div className={styles.header}>
        <div>
          <span id="launch-destination-heading" className={styles.label}>Where it runs</span>
          <span className={styles.hint}>{selfHosted
            ? "Choose a ready computer connected to this Hivra installation."
            : `Choose where this ${resourceLabel} runs. Your selected computer stays selected.`}</span>
        </div>
        <button
          type="button"
          className={styles.refreshButton}
          onClick={state.refresh}
          disabled={state.loading || disabled}
          aria-label="Refresh ready hosts"
          title="Refresh ready hosts"
        >
          {state.loading
            ? <Loader2 size={14} className={styles.spin} aria-hidden="true" />
            : <RefreshCw size={14} aria-hidden="true" />}
        </button>
      </div>

      <div className={styles.options} role="group" aria-label={`${resourceLabel} hosting destination`}>
        {!selfHosted ? <button
          type="button"
          className={`${styles.option} ${state.mode === "hivra-managed" ? styles.optionActive : ""}`}
          aria-pressed={state.mode === "hivra-managed"}
          onClick={() => state.setMode("hivra-managed")}
          disabled={disabled || !managedAvailable}
        >
          <Cloud size={16} aria-hidden="true" />
          <span>
            <strong>Hivra Cloud</strong>
            <small>{managedAvailable
              ? <>Hivra operates this {resourceLabel === "computer" ? "computer" : "agent computer"}. Uses your managed plan&apos;s compute pool.</>
              : "Unavailable for this application sandbox. Connect a compatible Linux host."}</small>
          </span>
          {state.mode === "hivra-managed" ? <Check size={14} className={styles.check} aria-hidden="true" /> : null}
        </button> : null}

        <button
          type="button"
          className={`${styles.option} ${state.mode === "self-managed" ? styles.optionActive : ""}`}
          aria-pressed={state.mode === "self-managed"}
          onClick={() => state.setMode("self-managed")}
          disabled={disabled || state.loading || !selfManagedAvailable}
        >
          <Server size={16} aria-hidden="true" />
          <span>
            <strong>{selfHosted ? "Connected host" : "My infrastructure"}</strong>
            <small>{selfHosted
              ? "A compatible computer prepared by this installation. Uses its measured capacity."
              : "A compatible host you connected. Uses its measured capacity, not Hivra plan compute."}</small>
          </span>
          {state.mode === "self-managed" ? <Check size={14} className={styles.check} aria-hidden="true" /> : null}
        </button>
      </div>

      {state.loading ? (
        <div className={styles.notice} role="status" aria-live="polite">
          <Loader2 size={14} className={styles.spin} aria-hidden="true" />
          <span>Checking your ready hosts...</span>
        </div>
      ) : state.error ? (
        <div className={styles.error} role="alert">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>
            Ready self-managed hosts could not be loaded. {selfHosted ? "Fix the connection before launching." : "Hivra Cloud is still available."} {state.error}{" "}
            <Link className={styles.manageLink} href={capacitySetupHref}>Open Infrastructure</Link>
          </span>
        </div>
      ) : !state.loading && !selfManagedAvailable ? (
        <div className={styles.notice}>
          <Server size={14} aria-hidden="true" />
          <span>
            {state.incompatibleReadyTargetCount > 0
              ? `None of your ready hosts has current compatibility evidence for ${runtimeName}. `
              : "No self-managed host is ready yet. "}
            <Link className={styles.manageLink} href={capacitySetupHref}>Open Infrastructure</Link>{" "}
            to connect, inspect, and prepare a host.
          </span>
        </div>
      ) : null}

      {state.mode === "self-managed" && selfManagedAvailable ? (
        <div className={styles.targetPanel}>
          <label className={styles.targetLabel}>
            Ready host
            <select
              className={styles.targetSelect}
              value={state.selectedTargetId}
              onChange={(event) => state.setSelectedTargetId(event.target.value)}
              disabled={disabled}
            >
              {!selectedTarget ? <option value="" disabled>Choose a host</option> : null}
              {state.readyTargets.map((target) => (
                <option key={target.id} value={target.id}>{target.displayName}</option>
              ))}
            </select>
          </label>
          {selectedTarget ? (
            <div className={styles.facts} aria-label="Measured host capacity">
              <div className={styles.fact}>
                <span>CPU measured</span>
                <strong>{selectedTarget.capacity.cpu.totalCores === null
                  ? "Unknown"
                  : `${selectedTarget.capacity.cpu.totalCores} cores`}</strong>
              </div>
              <div className={styles.fact}>
                <span>Memory available</span>
                <strong>{selectedTarget.capacity.memoryBytes.available === null
                  ? "Unknown"
                  : formatInfrastructureBytes(selectedTarget.capacity.memoryBytes.available)}</strong>
              </div>
              <div className={styles.fact}>
                <span>Last inspected</span>
                <strong>{formatInfrastructureDate(selectedTarget.lastPreflightAt)}</strong>
              </div>
            </div>
          ) : (
            <div className={styles.notice} role="alert">
              The previously selected host is no longer ready for this {resourceLabel}. Choose another host explicitly.
            </div>
          )}
          {selectedTarget && !isProxmoxDeploymentTarget(selectedTarget)
            && (selectedTarget.capabilities as unknown as { kind?: string }).kind === "provider-vm" ? <div className={styles.notice}>
            <Server size={14} aria-hidden="true" />
            <span>This {resourceLabel} uses the entire prepared cloud computer. Launching does not buy another server, resize this one, or divide it into smaller VMs. Configure your account or API key in its native interface after launch.</span>
          </div> : null}
          {selectedTarget && (selectedTarget.capabilities as unknown as { kind?: string }).kind === "gvisor" ? <div className={styles.notice}>
            <ShieldCheck size={14} aria-hidden="true" />
            <span>This Linux terminal workspace runs with gVisor&apos;s application-kernel boundary on your connected host. It has no desktop, Windows support, public ports, host mounts, devices, or privileged access.</span>
          </div> : null}
        </div>
      ) : null}
    </section>
  );
}
