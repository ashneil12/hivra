"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";

import { isProxmoxDeploymentTarget, type DeploymentTargetDto } from "@/lib/infrastructure/contracts";
import {
  gvisorCheckReadyUntil,
  hasReadyEvidence,
  launchActionForGvisorCheck,
  launchActionForReadyTarget,
  launchOnProviderServer,
  launchReadyTargetKey,
  launchReadyUntil,
  nextLaunchReadinessChange,
  pendingLaunchFrom,
  type GvisorReadinessCheck,
  type LaunchOnServerAction,
  type PendingLaunch,
} from "@/lib/infrastructure/launch-on-server";
import { LAUNCH_DRAFT_STORAGE_KEY, launchDraftStorageKey, parseStoredLaunchDraft } from "@/lib/launch/draft-store";

import styles from "./Infrastructure.module.css";

type LaunchOnServerContextValue = {
  pending: PendingLaunch | null;
  /** The page's last loaded, owner-scoped target evidence. */
  targets: readonly DeploymentTargetDto[];
};

const LaunchOnServerContext = createContext<LaunchOnServerContextValue>({ pending: null, targets: [] });

/** setTimeout's longest delay; a later deadline is waited for in steps. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function subscribeLaunchDraft(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

function storedText(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

/** Calls onChange once the clock reaches `at`, re-arming when a timer fires
 * early. Returns the cancel function. */
function wakeAt(at: number, onChange: () => void): () => void {
  let timer: number | undefined;
  const arm = () => {
    const delay = at - Date.now();
    if (delay <= 0) {
      onChange();
      return;
    }
    // A few milliseconds past the deadline, so the snapshot has changed.
    timer = window.setTimeout(arm, Math.min(delay + 25, MAX_TIMER_DELAY_MS));
  };
  arm();
  return () => window.clearTimeout(timer);
}

/**
 * Whether the clock has reached `deadline` (epoch ms; Infinity never passes,
 * -Infinity always has). The component re-renders the moment it passes, so a
 * ready state that lapses while the page is open goes away on its own.
 */
export function useDeadlinePassed(deadline: number): boolean {
  const subscribe = useCallback((onChange: () => void) => (
    Number.isFinite(deadline) ? wakeAt(deadline, onChange) : () => undefined
  ), [deadline]);
  const passed = useCallback(() => Date.now() >= deadline, [deadline]);
  // The server render has no clock to trust; nothing time-bound is ready.
  return useSyncExternalStore(subscribe, passed, () => deadline !== Infinity);
}

/** The ids of these targets that can launch right now, updated the moment
 * any of them lapses. */
export function useLaunchReadyTargetIds(targets: readonly DeploymentTargetDto[]): ReadonlySet<string> {
  const subscribe = useCallback((onChange: () => void) => {
    const next = nextLaunchReadinessChange(targets, Date.now());
    return next === null ? () => undefined : wakeAt(next, onChange);
  }, [targets]);
  const key = useSyncExternalStore(
    subscribe,
    useCallback(() => launchReadyTargetKey(targets, Date.now()), [targets]),
    () => launchReadyTargetKey(targets.filter((target) => launchReadyUntil(target) === Infinity), 0),
  );
  return useMemo(() => new Set(key ? key.split(",") : []), [key]);
}

/** The launch the owner came here from: ?launch=<resource>, or the launch
 * journey's unsent draft that this owner saved in this browser. */
export function usePendingLaunch(
  /** Capacity opened inside Launch passes its launch here instead of in the URL. */
  override: { launchParam: string | null; returnTo: string | null } | null = null,
): PendingLaunch | null {
  const searchParams = useSearchParams();
  const launchParam = override ? override.launchParam : searchParams?.get("launch") ?? null;
  const returnTo = override ? override.returnTo : searchParams?.get("returnTo") ?? null;
  // Drafts are saved per owner; until auth says who, there is none to read.
  const { isLoaded, userId } = useAuth();
  const ownerId = isLoaded ? userId ?? null : null;
  // The saved draft's raw text, and a draft from before drafts moved to
  // localStorage: a stable snapshot that changes only when a draft does. The
  // server render has no draft. Only the launch journey moves an old draft
  // over; reading here never changes storage.
  const readSnapshot = useCallback(() => (ownerId
    ? `${storedText(() => window.localStorage, launchDraftStorageKey(ownerId)) ?? ""}\u0000${storedText(() => window.sessionStorage, LAUNCH_DRAFT_STORAGE_KEY) ?? ""}`
    : null), [ownerId]);
  const snapshot = useSyncExternalStore(subscribeLaunchDraft, readSnapshot, () => null);
  return useMemo(() => {
    if (snapshot === null) return pendingLaunchFrom({ launchParam, returnTo, draft: null });
    const [saved, legacy] = snapshot.split("\u0000");
    const draft = parseStoredLaunchDraft(saved || null) ?? parseStoredLaunchDraft(legacy || null);
    return pendingLaunchFrom({ launchParam, returnTo, draft });
  }, [launchParam, returnTo, snapshot]);
}

export function LaunchOnServerProvider({
  pending,
  targets,
  children,
}: LaunchOnServerContextValue & { children: ReactNode }) {
  const value = useMemo(() => ({ pending, targets }), [pending, targets]);
  return <LaunchOnServerContext.Provider value={value}>{children}</LaunchOnServerContext.Provider>;
}

/** The launch action for one saved target while it can launch, or null. A
 * gVisor host's action ends when its readiness check lapses. */
export function useTargetLaunchAction(target: DeploymentTargetDto | null | undefined): LaunchOnServerAction | null {
  const { pending } = useContext(LaunchOnServerContext);
  const lapsed = useDeadlinePassed(target ? launchReadyUntil(target) : -Infinity);
  return useMemo(
    () => (target && !lapsed ? launchActionForReadyTarget(target, pending) : null),
    [lapsed, pending, target],
  );
}

/** The launch action for a gVisor check or setup that just passed in this
 * browser, while that check still authorizes a launch. */
export function useGvisorCheckLaunchAction(check: GvisorReadinessCheck | null): LaunchOnServerAction | null {
  const { pending } = useContext(LaunchOnServerContext);
  const lapsed = useDeadlinePassed(check ? gvisorCheckReadyUntil(check.checkedAt) : -Infinity);
  return useMemo(
    () => (check && !lapsed ? launchActionForGvisorCheck(check.targetId, pending) : null),
    [check, lapsed, pending],
  );
}

export function useLaunchOnServer() {
  const { pending, targets } = useContext(LaunchOnServerContext);
  return useMemo(() => ({
    pending,
    /** The ready Proxmox target for the node a check just named. A
     * connection can hold evidence for more than one node, so the check's own
     * node is matched, never the first ready one. Proxmox readiness doesn't
     * lapse with time; a gVisor host's does, so it goes through
     * useTargetLaunchAction or useGvisorCheckLaunchAction. */
    forProxmoxConnection: (connectionId: string, externalId: string): LaunchOnServerAction | null => {
      const target = targets.find((candidate) => candidate.connectionId === connectionId
        && candidate.externalId === externalId
        && isProxmoxDeploymentTarget(candidate)
        && hasReadyEvidence(candidate));
      return target ? launchActionForReadyTarget(target, pending) : null;
    },
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
