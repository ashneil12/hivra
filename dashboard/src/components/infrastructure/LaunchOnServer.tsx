"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";

import type { DeploymentTargetDto } from "@/lib/infrastructure/contracts";
import {
  isLaunchReadyTarget,
  launchOnDeploymentTarget,
  launchOnGvisorTarget,
  launchOnProviderServer,
  pendingLaunchFrom,
  type LaunchOnServerAction,
  type PendingLaunch,
} from "@/lib/infrastructure/launch-on-server";
import { LAUNCH_DRAFT_STORAGE_KEY, readLaunchDraft } from "@/lib/launch/draft-store";

import styles from "./Infrastructure.module.css";

type LaunchOnServerContextValue = {
  pending: PendingLaunch | null;
  /** The page's last loaded, owner-scoped target evidence. */
  targets: readonly DeploymentTargetDto[];
};

const LaunchOnServerContext = createContext<LaunchOnServerContextValue>({ pending: null, targets: [] });

function subscribeLaunchDraft(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

/** The saved draft's raw text: a stable snapshot that changes only when the
 * draft does. The server render has no draft. */
function readLaunchDraftSnapshot(): string | null {
  try {
    return window.sessionStorage.getItem(LAUNCH_DRAFT_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** The launch the owner came here from: ?launch=<resource>, or the unified
 * journey's saved draft in this tab. */
export function usePendingLaunch(): PendingLaunch | null {
  const searchParams = useSearchParams();
  const launchParam = searchParams?.get("launch") ?? null;
  const returnTo = searchParams?.get("returnTo") ?? null;
  const rawDraft = useSyncExternalStore(subscribeLaunchDraft, readLaunchDraftSnapshot, () => null);
  return useMemo(
    () => pendingLaunchFrom({ launchParam, returnTo, draft: rawDraft === null ? null : readLaunchDraft() }),
    [launchParam, rawDraft, returnTo],
  );
}

export function LaunchOnServerProvider({
  pending,
  targets,
  children,
}: LaunchOnServerContextValue & { children: ReactNode }) {
  const value = useMemo(() => ({ pending, targets }), [pending, targets]);
  return <LaunchOnServerContext.Provider value={value}>{children}</LaunchOnServerContext.Provider>;
}

export function useLaunchOnServer() {
  const { pending, targets } = useContext(LaunchOnServerContext);
  return useMemo(() => ({
    pending,
    /** A saved target's action, or null unless its evidence says ready. */
    forTarget: (target: DeploymentTargetDto | null | undefined) => launchOnDeploymentTarget(target, pending),
    /** The newest ready target this connection published, if any. */
    forConnection: (connectionId: string, kind: "any" | "proxmox" | "gvisor" = "any"): LaunchOnServerAction | null => {
      const target = targets.find((candidate) => candidate.connectionId === connectionId
        && isLaunchReadyTarget(candidate)
        && (kind === "any" || (kind === "gvisor") === ("kind" in candidate.capabilities && candidate.capabilities.kind === "gvisor")));
      return launchOnDeploymentTarget(target, pending);
    },
    /** A gVisor target this dialog just saw come back ready. */
    forGvisorTarget: (targetId: string) => launchOnGvisorTarget(targetId, pending),
    /** A ready Hivra-created cloud server. */
    forProviderServer: (targetId: string) => launchOnProviderServer(targetId, pending),
  }), [pending, targets]);
}

/** The one primary action of a ready state. */
export function LaunchOnServerLink({ action, className }: { action: LaunchOnServerAction; className?: string }) {
  return (
    <Link className={className ?? styles.primaryButton} href={action.href}>
      {action.label} <ArrowRight size={14} aria-hidden="true" />
    </Link>
  );
}
