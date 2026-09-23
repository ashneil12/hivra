"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  Cloud,
  Loader2,
  Monitor,
  Server,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";

import {
  DeploymentDestinationControl,
  measuredTargetCapacity,
  useLaunchDestination,
  type LaunchDestinationState,
} from "@/components/dashboard/welcome/DeploymentDestinationControl";
import { parseLaunchTargetHandoff } from "@/components/dashboard/welcome/launch-target-handoff";
import { isProxmoxDeploymentTarget, type DeploymentTargetDto } from "@/lib/infrastructure/contracts";
import { providerComputerResourceFloor } from "@/lib/hivra/provider-computer-resource-floor";
import {
  fetchPlanStrict,
  HivraLaunchCorrectableError,
  HivraLaunchRejectedError,
  type PlanInfo,
} from "@/lib/hivra/agent-api";
import { buildInfrastructureSetupHref } from "@/lib/hivra/launch-navigation";
import {
  PROFILE_DETAILS,
  type LaunchDraft,
  type LaunchProfileId,
  type LaunchResourceKind,
  type LaunchStage,
} from "@/lib/launch/contracts";
import {
  clearLaunchDraft,
  createLaunchDraft,
  readLaunchDraft,
  writeLaunchDraft,
} from "@/lib/launch/draft-store";
import { launchResultHref, submitLaunchDraft } from "@/lib/launch/launch-adapter";
import { launchResourcePolicy } from "@/lib/launch/resource-envelope";

import styles from "./LaunchJourney.module.css";

function planCanFit(plan: PlanInfo | null, resources: LaunchDraft["resources"]): boolean {
  if (!plan?.usage) return false;
  return plan.maxCpuPerAgent >= (resources.maximumCpu ?? resources.cpu)
    && plan.maxRamPerAgent >= (resources.maximumRam ?? resources.ram)
    && plan.poolCpu - plan.usage.usedCpu >= resources.cpu
    && plan.poolRam - plan.usage.usedRam >= resources.ram;
}

function recommendedForPlan(profileId: LaunchProfileId, plan: PlanInfo | null, browser: boolean) {
  const preferred = { ...launchResourcePolicy(profileId, { browser }).recommended, source: "recommended" as const };
  if (planCanFit(plan, preferred)) return preferred;
  const pinnedFloor = { cpu: preferred.cpu, ram: preferred.ram, maximumCpu: preferred.cpu, maximumRam: preferred.ram, source: "recommended" as const };
  if (planCanFit(plan, pinnedFloor)) {
    return pinnedFloor;
  }
  return preferred;
}

const CODEX_BROWSER_FLOOR = launchResourcePolicy("codex", { browser: true }).floor;
const CODEX_BASE_FLOOR = launchResourcePolicy("codex", { browser: false }).floor;

function paidPlan(plan: PlanInfo | null): boolean {
  return Boolean(plan?.subscribed && plan.key !== "free");
}

/** Mirrors the legacy welcome default: Codex's browser starts on only when a
 * paid plan can hold its floor. Hivra Cloud refuses browser automation on Free. */
function planFitsCodexBrowser(plan: PlanInfo | null): boolean {
  const floor = CODEX_BROWSER_FLOOR;
  return paidPlan(plan)
    && planCanFit(plan, { ...floor, maximumCpu: floor.cpu, maximumRam: floor.ram, source: "recommended" });
}

function isWholeProviderComputer(target: DeploymentTargetDto | null): boolean {
  return target !== null && (target.capabilities as unknown as { kind?: string }).kind === "provider-vm";
}

/** Codex's browser default for the chosen destination. Hivra Cloud follows the
 * plan; the owner's own capacity mirrors the welcome form's host check, so the
 * browser starts on whenever the selected host's measured capacity holds its
 * floor. Null while the plan or the selected host is not known yet. */
function recommendedCodexBrowser(
  mode: LaunchDestinationState["mode"],
  selectedTarget: DeploymentTargetDto | null,
  plan: PlanInfo | null,
): boolean | null {
  if (mode === "hivra-managed") return plan ? planFitsCodexBrowser(plan) : null;
  if (!selectedTarget) return null;
  const capacity = measuredTargetCapacity(selectedTarget);
  return capacity.cpu >= CODEX_BROWSER_FLOOR.cpu && capacity.ramGb >= CODEX_BROWSER_FLOOR.ram;
}

/** Whether the chosen destination can hold this size. Unknown capacity counts
 * as holding it, so missing evidence never forces a smaller size. */
function destinationHolds(
  mode: LaunchDestinationState["mode"],
  selectedTarget: DeploymentTargetDto | null,
  plan: PlanInfo | null,
  resources: LaunchDraft["resources"],
): boolean {
  if (mode === "hivra-managed") return !plan?.usage || planCanFit(plan, resources);
  // A provider computer is used whole; the requested size is not a slice of it.
  if (!selectedTarget || isWholeProviderComputer(selectedTarget)) return true;
  const capacity = measuredTargetCapacity(selectedTarget);
  return capacity.cpu >= resources.cpu && capacity.ramGb >= resources.ram;
}

/** Codex resources for a browser choice. Turning the browser off never shrinks
 * a size that meets the base floor and still fits, and turning it on raises
 * only what is below the browser floor. A recommended size the destination can
 * no longer hold falls back to the recommendation for that choice. */
function codexResourcesFor(
  resources: LaunchDraft["resources"],
  browser: boolean,
  plan: PlanInfo | null,
  holds: (resources: LaunchDraft["resources"]) => boolean,
): LaunchDraft["resources"] {
  const floor = browser ? CODEX_BROWSER_FLOOR : CODEX_BASE_FLOOR;
  const meetsFloor = resources.cpu >= floor.cpu && resources.ram >= floor.ram;
  if (resources.source === "custom") {
    if (meetsFloor) return resources;
    const cpu = Math.max(resources.cpu, floor.cpu);
    const ram = Math.max(resources.ram, floor.ram);
    return {
      ...resources,
      cpu,
      ram,
      maximumCpu: Math.max(resources.maximumCpu ?? cpu, cpu),
      maximumRam: Math.max(resources.maximumRam ?? ram, ram),
    };
  }
  if (meetsFloor && (browser || holds(resources))) return resources;
  return recommendedForPlan("codex", plan, browser);
}

function formatSize(cpu: number, ram: number): string {
  // Round down so a fractional remainder is never overstated.
  const tenth = (value: number) => Math.floor(value * 10 + 1e-9) / 10;
  return `${tenth(cpu)} CPU / ${tenth(ram)} GB`;
}

/** States what this launch needs next to what the plan can still hold for it. */
function managedCapacityShortfall(
  label: string,
  resourceKind: LaunchResourceKind,
  resources: LaunchDraft["resources"],
  plan: PlanInfo & { usage: NonNullable<PlanInfo["usage"]> },
): string {
  const { usedCpu, usedRam } = plan.usage;
  const cpu = Math.max(0, Math.min(plan.maxCpuPerAgent, plan.poolCpu - usedCpu));
  const ram = Math.max(0, Math.min(plan.maxRamPerAgent, plan.poolRam - usedRam));
  if (resources.cpu > cpu || resources.ram > ram) {
    return usedCpu === 0 && usedRam === 0
      ? `${label} needs ${formatSize(resources.cpu, resources.ram)}. Your ${plan.name} plan includes ${formatSize(cpu, ram)}.`
      : `${label} needs ${formatSize(resources.cpu, resources.ram)}. Your ${plan.name} plan has ${formatSize(cpu, ram)} left.`;
  }
  return `${label} is set to use up to ${formatSize(resources.maximumCpu ?? resources.cpu, resources.maximumRam ?? resources.ram)}. Your ${plan.name} plan allows up to ${formatSize(plan.maxCpuPerAgent, plan.maxRamPerAgent)} for each ${resourceKind}.`;
}

function displayIsolation(destination: ReturnType<typeof useLaunchDestination>): string {
  if (destination.mode === "hivra-managed" || !destination.selectedTarget) {
    return "Hardware-isolated Proxmox VM";
  }
  if (isProxmoxDeploymentTarget(destination.selectedTarget)) return "Hardware-isolated Proxmox VM";
  if ((destination.selectedTarget.capabilities as unknown as { kind?: string }).kind === "gvisor") {
    return "gVisor application-kernel sandbox on your connected Linux host";
  }
  return destination.selectedTarget.isolationClass === "provider-vm"
    ? "Dedicated provider VM"
    : "Isolation evidence unavailable";
}

export function reviewMutation(draft: LaunchDraft, destination: ReturnType<typeof useLaunchDestination>): string {
  if (draft.profileId === "omarchy") {
    return `Claims and opens the prepared private Canary ${PROFILE_DETAILS[draft.profileId].name} computer. No new server is purchased.`;
  }
  if (draft.profileId === "windows") {
    return "Creates one UEFI/TPM Windows setup VM, attaches the selected host-side ISO, and starts the installer. It does not buy a server, upload the ISO, or use Hivra Cloud.";
  }
  if (draft.profileId === "linux-terminal") {
    return "Creates one non-root Linux terminal workspace with enforced CPU and memory limits in gVisor on the selected connected host. It does not create a VM, desktop, public port, or host mount.";
  }
  if (destination.mode === "self-managed" && destination.selectedTarget && !isProxmoxDeploymentTarget(destination.selectedTarget)) {
    return `Configures the existing ${destination.selectedTarget.displayName} computer. It does not buy or create another server.`;
  }
  return draft.resourceKind === "computer"
    ? "Creates one isolated VM and installs the Ubuntu Desktop profile."
    : "Creates one isolated VM and installs the Codex runtime.";
}

function stepBack(stage: LaunchStage): LaunchStage {
  if (stage === "profile") return "type";
  if (stage === "capacity") return "profile";
  if (stage === "review") return "capacity";
  return stage;
}

type HistoryStage = Exclude<LaunchStage, "launch">;
const HISTORY_STAGES: readonly HistoryStage[] = ["type", "profile", "capacity", "review"];
const HISTORY_STAGE_KEY = "hivraLaunchStage";
const HISTORY_PUSHED_KEY = "hivraLaunchPushed";

function parseHistoryStage(value: unknown): HistoryStage | null {
  return HISTORY_STAGES.find(stage => stage === value) ?? null;
}

function currentHistoryEntry(): { stage: HistoryStage | null; pushed: boolean } {
  const state = window.history.state as Record<string, unknown> | null;
  return {
    stage: parseHistoryStage(state?.[HISTORY_STAGE_KEY] ?? new URLSearchParams(window.location.search).get("stage")),
    pushed: state?.[HISTORY_PUSHED_KEY] === true,
  };
}

// Each forward step gets its own history entry so the Android back gesture
// and iOS edge swipe step back through the journey instead of leaving it.
// Next's patched pushState/replaceState keep its router state in sync.
function writeStageHistory(stage: LaunchStage, mode: "push" | "replace") {
  if (typeof window === "undefined" || stage === "launch") return;
  const entry = currentHistoryEntry();
  if (mode === "replace" && entry.stage === stage) return;
  const url = new URL(window.location.href);
  url.searchParams.set("stage", stage);
  const href = `${url.pathname}${url.search}${url.hash}`;
  const data = { [HISTORY_STAGE_KEY]: stage, [HISTORY_PUSHED_KEY]: mode === "push" || entry.pushed };
  if (mode === "push") window.history.pushState(data, "", href);
  else window.history.replaceState(data, "", href);
}

// A stage restored from history must still have the choices it depends on.
function reachableStage(stage: HistoryStage, draft: LaunchDraft): HistoryStage {
  if (stage === "type" || !draft.resourceKind) return "type";
  if (stage === "profile" || !draft.profileId || PROFILE_DETAILS[draft.profileId].resourceKind !== draft.resourceKind) return "profile";
  if (stage === "review" && !draft.name.trim()) return "capacity";
  return stage;
}

// Phones, plus touch tablets up to the compact rail width.
const NARROW_LAUNCH_QUERY = "(max-width: 640px), (max-width: 1023px) and (pointer: coarse)";

function subscribeNarrowLaunch(onChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const query = window.matchMedia(NARROW_LAUNCH_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function readNarrowLaunch() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(NARROW_LAUNCH_QUERY).matches;
}

const JOURNEY_STEPS = ["Choose", "Configure", "Review"] as const;

function visibleStep(stage: LaunchStage): number {
  if (stage === "type" || stage === "profile") return 0;
  return stage === "capacity" ? 1 : 2;
}

function LoadingDraft() {
  return (
    <main className={styles.page}>
      <div className={styles.loading} role="status">
        <Loader2 size={18} aria-hidden /> Restoring your launch
      </div>
    </main>
  );
}

export function LaunchJourney() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [draft, setDraft] = useState<LaunchDraft | null>(null);
  const [plan, setPlan] = useState<PlanInfo | null>(null);
  const [planChecked, setPlanChecked] = useState(false);
  const [planCheckRevision, setPlanCheckRevision] = useState(0);
  const [windowsImages, setWindowsImages] = useState<Array<{ volume: string; name: string; sizeBytes: number; modifiedAtSeconds: number; fileIdentitySha256: string; source: "unknown" | "windows-11" | "windows-server-evaluation" }>>([]);
  const [windowsIsoStorages, setWindowsIsoStorages] = useState<Array<{ id: string; label: string }>>([]);
  const [windowsImagesLoading, setWindowsImagesLoading] = useState(false);
  const [windowsImagesError, setWindowsImagesError] = useState<string | null>(null);
  const [windowsInventoryRevision, setWindowsInventoryRevision] = useState(0);
  const [windowsDownloadSource, setWindowsDownloadSource] = useState<"windows-11" | "windows-server-evaluation">("windows-11");
  const [windowsDownloadUrl, setWindowsDownloadUrl] = useState("");
  const [windowsDownloadStorage, setWindowsDownloadStorage] = useState("");
  const [windowsDownloadTask, setWindowsDownloadTask] = useState<{ taskId: string; state: "queued" | "running" | "succeeded" | "failed"; bytesDownloaded: number; message: string | null } | null>(null);
  const [windowsDownloadStarting, setWindowsDownloadStarting] = useState(false);
  const restoredDestinationRef = useRef<string | null>(null);
  const journeyRef = useRef<HTMLElement | null>(null);
  // Phones and touch tablets start with Resources collapsed: the recommended
  // size is already selected, and four open pickers pushed "Review launch"
  // two screens down.
  const narrowLayout = useSyncExternalStore(subscribeNarrowLaunch, readNarrowLaunch, () => false);
  const activeStage = draft?.stage;
  const activeOutcome = activeStage === "launch" ? draft?.launchState : null;

  useEffect(() => {
    if (!activeStage) return;
    const heading = journeyRef.current?.querySelector("h1");
    if (!heading) return;
    // Announce client-side step changes and bring an offscreen heading into
    // view. Ordinary draft edits and capacity refreshes must not steal focus.
    heading.tabIndex = -1;
    heading.focus();
  }, [activeStage, activeOutcome]);
  const targetValues = searchParams?.getAll("targetId") ?? [];
  const targetValuesKey = targetValues.join("\u0000");
  const requestedKindParam = searchParams?.get("kind") ?? null;
  const requestedProfileParam = searchParams?.get("profile") ?? null;
  const startParam = searchParams?.get("start") ?? null;
  const handoff = useMemo(
    () => parseLaunchTargetHandoff(targetValues),
    // The key represents the complete ordered query input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [targetValuesKey],
  );
  const profile = draft?.profileId ? PROFILE_DETAILS[draft.profileId] : null;
  const destination = useLaunchDestination(profile?.placementRuntimeId ?? null, {
    handoff,
    // A self-managed-only profile opens on the owner's infrastructure even
    // before a compatible host exists; Hivra Cloud is never its selection.
    managedAvailable: profile?.managedCapacity !== "self-managed-only",
    targetKind: profile?.placementRuntimeId === "linux-terminal" ? "gvisor" : "any",
  });

  useEffect(() => {
    const selected = destination.deployment;
    if (draft?.profileId !== "windows" || selected?.mode !== "self-managed") {
      setWindowsImages([]);
      setWindowsIsoStorages([]);
      setWindowsImagesError(null);
      setWindowsImagesLoading(false);
      return;
    }
    const controller = new AbortController();
    const query = new URLSearchParams({
      connectionId: selected.connectionId,
      targetId: selected.targetId,
      expectedConnectionRevision: String(selected.expectedConnectionRevision),
    });
    setWindowsImagesLoading(true);
    setWindowsImagesError(null);
    fetch(`/api/hivra/windows/iso-images?${query}`, { cache: "no-store", signal: controller.signal })
      .then(async response => {
        const payload = await response.json().catch(() => null) as {
          success?: boolean;
          error?: string;
          data?: {
            images?: Array<{ volume: string; name: string; sizeBytes: number; modifiedAtSeconds: number; fileIdentitySha256: string; source: "unknown" | "windows-11" | "windows-server-evaluation" }>;
            storages?: Array<{ id: string; label: string }>;
          };
        } | null;
        if (!response.ok || payload?.success !== true) {
          throw new Error(payload?.error || "Windows ISO inventory could not be loaded.");
        }
        return { images: payload.data?.images ?? [], storages: payload.data?.storages ?? [] };
      })
      .then(({ images, storages }) => {
        if (!controller.signal.aborted) {
          setWindowsImages(images);
          setWindowsIsoStorages(storages);
          setWindowsDownloadStorage(current => storages.some(storage => storage.id === current) ? current : (storages[0]?.id ?? ""));
          setWindowsImagesLoading(false);
        }
      })
      .catch(error => {
        if (!controller.signal.aborted) {
          setWindowsImages([]);
          setWindowsIsoStorages([]);
          setWindowsImagesError(error instanceof Error ? error.message : "Windows ISO inventory could not be loaded.");
          setWindowsImagesLoading(false);
        }
      });
    return () => controller.abort();
  }, [destination.deployment, draft?.profileId, windowsInventoryRevision]);

  useEffect(() => {
    const saved = draft?.windowsIsoDownload;
    if (!saved || (windowsDownloadTask && windowsDownloadTask.taskId === saved.taskId)) return;
    setWindowsDownloadSource(saved.source);
    setWindowsDownloadStorage(saved.storage);
    setWindowsDownloadTask({ taskId: saved.taskId, state: saved.state, bytesDownloaded: 0, message: null });
  }, [draft?.windowsIsoDownload, windowsDownloadTask]);

  useEffect(() => {
    const deployment = destination.deployment;
    if (!windowsDownloadTask || !["queued", "running"].includes(windowsDownloadTask.state)) return;
    const savedBinding = draft?.windowsIsoDownload?.taskId === windowsDownloadTask.taskId ? draft.windowsIsoDownload : null;
    const binding = savedBinding ?? (deployment?.mode === "self-managed" ? deployment : null);
    if (!binding) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const query = new URLSearchParams({
        connectionId: binding.connectionId,
        targetId: binding.targetId,
        expectedConnectionRevision: String(binding.expectedConnectionRevision),
        taskId: windowsDownloadTask.taskId,
      });
      fetch(`/api/hivra/windows/iso-downloads?${query}`, { cache: "no-store", signal: controller.signal })
        .then(async response => {
          const payload = await response.json().catch(() => null) as { success?: boolean; error?: string; data?: typeof windowsDownloadTask } | null;
          if (!response.ok || payload?.success !== true || !payload.data) throw new Error(payload?.error || "Download progress could not be loaded.");
          return payload.data;
        })
        .then(status => {
          if (controller.signal.aborted) return;
          setWindowsDownloadTask(status);
          if (status.state === "succeeded" || status.state === "failed") {
            setDraft(current => current ? { ...current, windowsIsoDownload: null } : current);
            if (status.state === "succeeded") setWindowsInventoryRevision(value => value + 1);
          } else {
            const activeState: "queued" | "running" = status.state === "queued" ? "queued" : "running";
            setDraft(current => current?.windowsIsoDownload?.taskId === status.taskId
              ? { ...current, windowsIsoDownload: { ...current.windowsIsoDownload, state: activeState } }
              : current);
          }
        })
        .catch(error => {
          if (!controller.signal.aborted) setWindowsImagesError(error instanceof Error ? error.message : "Download progress could not be loaded.");
        });
    }, 2_000);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [destination.deployment, draft?.windowsIsoDownload, windowsDownloadTask]);

  // Keyed on the launch-intent params only: the stage param written into the
  // URL for back/forward must not re-run this and replace the draft.
  useEffect(() => {
    const stored = readLaunchDraft();
    const startFresh = startParam === "1"
      && stored?.launchState !== "uncertain"
      && stored?.launchState !== "submitting";
    let initial: LaunchDraft;
    if (stored && !startFresh) {
      initial = stored;
    } else {
      const next = createLaunchDraft();
      if (requestedKindParam === "agent" || requestedKindParam === "computer") {
        next.resourceKind = requestedKindParam;
        next.stage = "profile";
      }
      const requestedProfile = requestedProfileParam;
      if (requestedKindParam === "computer" && (requestedProfile === "ubuntu-desktop" || requestedProfile === "linux-terminal" || requestedProfile === "omarchy" || requestedProfile === "windows")) {
        next.profileId = requestedProfile;
        next.name = PROFILE_DETAILS[requestedProfile].defaultName;
        next.resources = { ...PROFILE_DETAILS[requestedProfile].recommended };
        next.stage = "capacity";
      }
      writeLaunchDraft(next);
      initial = next;
    }
    setDraft(initial);
    // One task later so that on a hard load Next has patched history first;
    // an unpatched replaceState would drop the router's own entry state.
    const timer = window.setTimeout(() => writeStageHistory(initial.stage, "replace"), 0);
    return () => window.clearTimeout(timer);
  }, [requestedKindParam, requestedProfileParam, startParam, targetValuesKey]);

  useEffect(() => {
    const onPopState = () => {
      const requested = currentHistoryEntry().stage;
      if (!requested) return;
      setDraft(current => {
        if (!current || current.stage === "launch") return current;
        const next = reachableStage(requested, current);
        if (next === current.stage) return current;
        return { ...current, stage: next, launchState: "idle", result: null, error: null };
      });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    let active = true;
    fetchPlanStrict()
      .then(nextPlan => {
        if (!active) return;
        setPlan(nextPlan);
        setPlanChecked(true);
        setDraft(current => {
          if (
            !current?.profileId
            // Codex also depends on the destination; the effect below owns it.
            || current.profileId === "codex"
            || current.resources.source !== "recommended"
            || current.submittedDeployment
          ) return current;
          const resources = recommendedForPlan(current.profileId, nextPlan, current.browser);
          if (resources.cpu === current.resources.cpu && resources.ram === current.resources.ram) return current;
          return { ...current, resources };
        });
      })
      .catch(() => {
        if (!active) return;
        setPlan(null);
        setPlanChecked(true);
      });
    return () => { active = false; };
  }, [planCheckRevision]);

  // Until the owner chooses, Codex's browser follows the plan on Hivra Cloud
  // and the selected host's measured capacity on their own infrastructure,
  // re-evaluated whenever either changes. A submitted launch never changes.
  // Applied before paint so a stale default is never shown or submitted.
  const destinationMode = destination.mode;
  const selectedTarget = destination.selectedTarget;
  const codexBrowserDefault = recommendedCodexBrowser(destinationMode, selectedTarget, plan);
  const draftProfileId = draft?.profileId ?? null;
  const draftSubmitted = Boolean(draft?.submittedDeployment);
  useLayoutEffect(() => {
    setDraft(current => {
      if (current?.profileId !== "codex" || current.submittedDeployment) return current;
      const browser = current.browserSource === "recommended" && codexBrowserDefault !== null
        ? codexBrowserDefault
        : current.browser;
      const resources = codexResourcesFor(
        current.resources,
        browser,
        plan,
        next => destinationHolds(destinationMode, selectedTarget, plan, next),
      );
      if (
        browser === current.browser
        && resources.cpu === current.resources.cpu
        && resources.ram === current.resources.ram
      ) return current;
      return { ...current, browser, resources };
    });
  }, [codexBrowserDefault, destinationMode, draftProfileId, draftSubmitted, plan, selectedTarget]);

  useEffect(() => {
    if (draft) writeLaunchDraft(draft);
  }, [draft]);

  useEffect(() => {
    if (!draft || destination.loading || restoredDestinationRef.current === draft.launchRequestId) return;
    restoredDestinationRef.current = draft.launchRequestId;
    if (handoff) return;
    if (draft.capacity.mode === "self-managed" && draft.capacity.targetId) {
      // Restore the selected authority even if the target disappeared. The
      // destination hook retains the stale ID and returns no deployment so the
      // launch blocks instead of falling back to Hivra Cloud.
      destination.setSelectedTargetId(draft.capacity.targetId);
      const savedTarget = destination.readyTargets.find(target => target.id === draft.capacity.targetId);
      if (savedTarget) {
        destination.setSelectedTargetId(savedTarget.id);
      }
    }
  }, [destination, draft, handoff]);

  useEffect(() => {
    if (draft?.launchState !== "accepted" || !draft.result) return;
    const href = launchResultHref(draft, draft.result.id);
    clearLaunchDraft();
    router.push(href);
  }, [draft, router]);

  if (!draft) return <LoadingDraft />;

  const currentProfile = draft.profileId ? PROFILE_DETAILS[draft.profileId] : null;
  const preparedCanaryProfile = draft.profileId === "omarchy";
  const managedEntitlementRequired = currentProfile?.managedCapacity === "entitlement-required";
  const selfManagedOnly = currentProfile?.managedCapacity === "self-managed-only";
  const gvisorComputer = draft.profileId === "linux-terminal";
  const codexBrowser = draft.profileId === "codex" && draft.browser;
  const resourceFloor = draft.profileId ? launchResourcePolicy(draft.profileId, { browser: draft.browser }).floor : null;
  const targetCapacity = measuredTargetCapacity(destination.selectedTarget);
  const wholeProviderComputer = destination.mode === "self-managed" && isWholeProviderComputer(destination.selectedTarget);
  // A provider VM is exclusive, not a requested slice of its free memory.
  // Match the runtime headroom check; the server still re-inspects at launch.
  const requiredCapacity = wholeProviderComputer && currentProfile
    ? providerComputerResourceFloor(currentProfile.runtimeId, codexBrowser)
    : draft.resources;
  const selectedTargetFits = Boolean(
    destination.deployment?.mode === "self-managed"
      && targetCapacity.cpu >= requiredCapacity.cpu
      && targetCapacity.ramGb >= requiredCapacity.ram,
  );
  const managedPaidRequired = draft.profileId === "ubuntu-desktop";
  const atSlotLimit = Boolean(plan?.usage && plan.usage.agentCount >= plan.maxAgents);
  const managedFits = planCanFit(plan, draft.resources);
  const managedPlanAllowed = !managedPaidRequired || paidPlan(plan);
  // Codex resources after a browser change, sized against the chosen destination.
  const resourcesWithBrowser = (browser: boolean): LaunchDraft["resources"] => codexResourcesFor(
    draft.resources,
    browser,
    plan,
    resources => destinationHolds(destination.mode, destination.selectedTarget, plan, resources),
  );
  const sizeWithoutBrowser = wholeProviderComputer && currentProfile
    ? providerComputerResourceFloor(currentProfile.runtimeId, false)
    : resourcesWithBrowser(false);
  const targetFitsWithoutBrowser = destination.deployment?.mode === "self-managed"
    && targetCapacity.cpu >= sizeWithoutBrowser.cpu
    && targetCapacity.ramGb >= sizeWithoutBrowser.ram;
  const capacitySetupHref = currentProfile
    ? buildInfrastructureSetupHref(currentProfile.placementRuntimeId === "windows-installer" ? "windows" : currentProfile.placementRuntimeId, { unified: true })
    : "/dashboard/infrastructure";
  const reservedCpuLimit = destination.mode === "hivra-managed"
    ? plan?.usage ? Math.min(plan.maxCpuPerAgent, Math.max(0, plan.poolCpu - plan.usage.usedCpu)) : Infinity
    : targetCapacity.cpu;
  const reservedRamLimit = destination.mode === "hivra-managed"
    ? plan?.usage ? Math.min(plan.maxRamPerAgent, Math.max(0, plan.poolRam - plan.usage.usedRam)) : Infinity
    : targetCapacity.ramGb;
  const selectedTargetMaximumCpu = destination.selectedTarget?.capacity.cpu.totalCores ?? targetCapacity.cpu;
  const selectedTargetMaximumRam = destination.selectedTarget?.capacity.memoryBytes.total === null
    || destination.selectedTarget?.capacity.memoryBytes.total === undefined
    ? targetCapacity.ramGb
    : destination.selectedTarget.capacity.memoryBytes.total / 1024 ** 3;
  const maximumCpuLimit = destination.mode === "hivra-managed" ? plan?.maxCpuPerAgent ?? Infinity : selectedTargetMaximumCpu;
  const maximumRamLimit = destination.mode === "hivra-managed" ? plan?.maxRamPerAgent ?? Infinity : selectedTargetMaximumRam;

  let capacityBlocker: string | null = null;
  // The real next steps a managed blocker can offer.
  let blockerRemedy: "check-plan" | "managed-plan" | null = null;
  let offerBrowserOff = false;
  const selectedWindowsImage = windowsImages.find(image => image.volume === draft.windowsIsoVolume
    && image.sizeBytes === draft.windowsIsoEvidence?.sizeBytes
    && image.modifiedAtSeconds === draft.windowsIsoEvidence?.modifiedAtSeconds
    && image.fileIdentitySha256 === draft.windowsIsoEvidence?.fileIdentitySha256
    && image.source === draft.windowsIsoSource);
  if (destination.loading) capacityBlocker = "Checking compatible capacity…";
  else if (gvisorComputer && (destination.mode !== "self-managed" || !destination.deployment)) capacityBlocker = "Linux Sandbox requires a compatible gVisor host you connected.";
  else if (preparedCanaryProfile && destination.mode !== "hivra-managed") capacityBlocker = "This prepared Canary computer currently runs on Hivra Cloud.";
  else if (destination.mode === "self-managed" && !destination.deployment) capacityBlocker = "No compatible capacity is ready for this profile.";
  else if (destination.mode === "self-managed" && !selectedTargetFits) {
    capacityBlocker = "The selected host does not have enough measured capacity for this size.";
    offerBrowserOff = codexBrowser && targetFitsWithoutBrowser;
  }
  else if (destination.mode === "hivra-managed" && managedEntitlementRequired) capacityBlocker = "Hivra Cloud is unavailable for Windows. Choose compatible customer-owned or self-hosted capacity.";
  else if (draft.profileId === "windows" && windowsImagesLoading) capacityBlocker = "Checking customer-owned ISO images on this host…";
  else if (draft.profileId === "windows" && windowsImagesError) capacityBlocker = windowsImagesError;
  else if (draft.profileId === "windows" && windowsImages.length === 0) capacityBlocker = "Choose an ISO already on this host, or download one directly from Microsoft to this host.";
  else if (draft.profileId === "windows" && !draft.windowsIsoVolume) capacityBlocker = "Choose the customer-owned Windows ISO to attach.";
  else if (draft.profileId === "windows" && (!draft.windowsIsoEvidence || !selectedWindowsImage)) capacityBlocker = "Refresh and choose the exact host-observed Windows ISO again.";
  else if (draft.profileId === "windows" && !draft.windowsRightsAttested) capacityBlocker = "Confirm your Windows installation and use rights before review.";
  else if (destination.mode === "hivra-managed" && !preparedCanaryProfile && !planChecked) capacityBlocker = "Checking your managed plan…";
  else if (destination.mode === "hivra-managed" && !preparedCanaryProfile && !plan?.usage) {
    capacityBlocker = "Managed capacity could not be verified.";
    blockerRemedy = "check-plan";
  } else if (destination.mode === "hivra-managed" && !managedPlanAllowed) {
    capacityBlocker = "Ubuntu Desktop needs a paid managed plan or compatible self-managed capacity.";
    blockerRemedy = "managed-plan";
  } else if (destination.mode === "hivra-managed" && !preparedCanaryProfile && atSlotLimit) {
    capacityBlocker = "Your current plan has no open agent slots.";
    blockerRemedy = "managed-plan";
  } else if (destination.mode === "hivra-managed" && !preparedCanaryProfile && !managedFits && plan?.usage) {
    capacityBlocker = managedCapacityShortfall(
      codexBrowser ? "Codex with a browser" : currentProfile?.name ?? "This launch",
      draft.resourceKind ?? "agent",
      draft.resources,
      { ...plan, usage: plan.usage },
    );
    blockerRemedy = "managed-plan";
    offerBrowserOff = codexBrowser && planCanFit(plan, resourcesWithBrowser(false));
  } else if (destination.mode === "hivra-managed" && codexBrowser && !paidPlan(plan)) {
    capacityBlocker = "Codex with a browser needs a paid plan on Hivra Cloud.";
    blockerRemedy = "managed-plan";
    offerBrowserOff = true;
  }

  const updateDraft = (change: Partial<LaunchDraft>) => setDraft(current => current ? { ...current, ...change } : current);
  const chooseCodexBrowser = (browser: boolean) => updateDraft({
    browser,
    browserSource: "custom",
    resources: resourcesWithBrowser(browser),
  });
  const recheckPlan = () => {
    setPlanChecked(false);
    setPlanCheckRevision(value => value + 1);
  };
  const chooseKind = (kind: LaunchResourceKind) => {
    if (draft.resourceKind === kind) return;
    const fresh = createLaunchDraft();
    setDraft({ ...fresh, resourceKind: kind, stage: "type" });
    restoredDestinationRef.current = null;
  };
  const chooseProfile = (profileId: LaunchProfileId) => {
    if (draft.profileId === profileId) return;
    const details = PROFILE_DETAILS[profileId];
    const fresh = createLaunchDraft();
    const browser = profileId === "codex"
      && (recommendedCodexBrowser(destination.mode, destination.selectedTarget, plan) ?? false);
    setDraft({
      ...fresh,
      stage: "profile",
      resourceKind: details.resourceKind,
      profileId,
      name: details.defaultName,
      browser,
      browserSource: "recommended",
      resources: recommendedForPlan(profileId, plan, browser),
      windowsIsoVolume: null,
      windowsIsoEvidence: null,
      windowsIsoSource: "unknown",
      windowsIsoDownload: null,
      windowsRightsAttested: false,
    });
    restoredDestinationRef.current = null;
  };
  const chooseDestinationMode = (mode: "hivra-managed" | "self-managed") => {
    destination.setMode(mode);
    setWindowsDownloadTask(null);
    updateDraft({
      capacity: mode === "hivra-managed"
        ? { mode, targetId: null }
        : { mode, targetId: destination.selectedTarget?.id ?? destination.readyTargets[0]?.id ?? null },
      windowsIsoDownload: null,
    });
  };
  const chooseTarget = (targetId: string) => {
    destination.setSelectedTargetId(targetId);
    setWindowsDownloadTask(null);
    updateDraft({
      capacity: { mode: "self-managed", targetId },
      windowsIsoVolume: null,
      windowsIsoEvidence: null,
      windowsIsoSource: "unknown",
      windowsIsoDownload: null,
      windowsRightsAttested: false,
    });
  };
  const startWindowsDownload = async () => {
    const deployment = destination.deployment;
    if (deployment?.mode !== "self-managed" || !draft.windowsRightsAttested || !windowsDownloadStorage || !windowsDownloadUrl.trim()) return;
    setWindowsDownloadStarting(true);
    setWindowsImagesError(null);
    try {
      const response = await fetch("/api/hivra/windows/iso-downloads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...deployment,
          source: windowsDownloadSource,
          storage: windowsDownloadStorage,
          directUrl: windowsDownloadUrl.trim(),
          rightsAttested: true,
          termsVersion: "windows-byo-iso-v1",
        }),
      });
      const payload = await response.json().catch(() => null) as {
        success?: boolean;
        error?: string;
        data?: { taskId: string; state: "queued"; filename: string; storage: string };
      } | null;
      if (!response.ok || payload?.success !== true || !payload.data) throw new Error(payload?.error || "The host could not start the ISO download.");
      setWindowsDownloadTask({ taskId: payload.data.taskId, state: payload.data.state, bytesDownloaded: 0, message: null });
      updateDraft({ windowsIsoDownload: {
        taskId: payload.data.taskId,
        connectionId: deployment.connectionId,
        targetId: deployment.targetId,
        expectedConnectionRevision: deployment.expectedConnectionRevision,
        source: windowsDownloadSource,
        storage: payload.data.storage,
        filename: payload.data.filename,
        state: payload.data.state,
      } });
      setWindowsDownloadUrl("");
    } catch (error) {
      setWindowsImagesError(error instanceof Error ? error.message : "The host could not start the ISO download.");
    } finally {
      setWindowsDownloadStarting(false);
    }
  };
  const advanceTo = (stage: HistoryStage, change: Partial<LaunchDraft> = {}) => {
    writeStageHistory(stage, "push");
    updateDraft({ ...change, stage });
  };
  const goBack = () => {
    const previous = stepBack(draft.stage);
    updateDraft({ stage: previous, launchState: "idle", result: null, error: null });
    // Pop the entry this step pushed so the next system back keeps stepping
    // back; entries the journey did not push are rewritten in place.
    const entry = currentHistoryEntry();
    if (entry.pushed && entry.stage === draft.stage) window.history.back();
    else writeStageHistory(previous, "replace");
  };
  const startNew = () => {
    const next = createLaunchDraft();
    clearLaunchDraft();
    writeLaunchDraft(next);
    restoredDestinationRef.current = null;
    destination.setMode("hivra-managed");
    setDraft(next);
    writeStageHistory(next.stage, "replace");
  };
  const reviewFailedLaunch = () => {
    const nextIdentity = createLaunchDraft();
    setDraft({
      ...draft,
      launchRequestId: nextIdentity.launchRequestId,
      stage: "review",
      launchState: "idle",
      submittedDeployment: null,
      result: null,
      error: null,
    });
  };

  const submit = async () => {
    const resumingUncertain = draft.launchState === "uncertain";
    const submissionDeployment = resumingUncertain
      ? draft.submittedDeployment
      : destination.deployment;
    if (
      !submissionDeployment
      || !draft.profileId
      || (!resumingUncertain && capacityBlocker)
      || draft.launchState === "submitting"
    ) return;
    const submitting = {
      ...draft,
      stage: "launch" as const,
      launchState: "submitting" as const,
      submittedDeployment: submissionDeployment,
      result: null,
      error: null,
    };
    writeLaunchDraft(submitting);
    setDraft(submitting);
    try {
      const created = await submitLaunchDraft(submitting, submissionDeployment);
      const accepted = {
        ...submitting,
        launchState: "accepted" as const,
        result: { id: created.id, name: created.name, status: created.status },
        error: null,
      };
      writeLaunchDraft(accepted);
      setDraft(accepted);
    } catch (error) {
      if (error instanceof HivraLaunchRejectedError) {
        const failed = { ...submitting, launchState: "failed" as const, error: error.message };
        writeLaunchDraft(failed);
        setDraft(failed);
      } else if (error instanceof HivraLaunchCorrectableError) {
        const correctable = {
          ...submitting,
          stage: "review" as const,
          launchState: "idle" as const,
          submittedDeployment: null,
          result: error.computerId ? { id: error.computerId, name: submitting.name, status: "error" } : null,
          error: error.message,
        };
        writeLaunchDraft(correctable);
        setDraft(correctable);
      } else {
        const uncertain = {
          ...submitting,
          launchState: "uncertain" as const,
          error: error instanceof Error ? error.message : "The launch acknowledgement was lost.",
        };
        writeLaunchDraft(uncertain);
        setDraft(uncertain);
      }
    }
  };

  const blockerActions = offerBrowserOff || destination.mode === "self-managed" || blockerRemedy ? (
    <span className={styles.blockerActions}>
      {offerBrowserOff ? <button type="button" onClick={() => chooseCodexBrowser(false)}>Turn off the browser</button> : null}
      {destination.mode === "self-managed" ? <Link href={capacitySetupHref}>Set up capacity</Link>
        : blockerRemedy === "check-plan" ? <button type="button" onClick={recheckPlan}>Check again</button>
        : blockerRemedy === "managed-plan" ? <>
          <Link href="/dashboard/billing?from=launch">Review plans</Link>
          <Link href={capacitySetupHref}>Set up your own capacity</Link>
        </> : null}
    </span>
  ) : null;

  const primary = (label: string, onClick: () => void, disabled = false) => (
    <button
      type="button"
      className={styles.primaryAction}
      data-testid="launch-primary-action"
      onClick={onClick}
      disabled={disabled}
    >
      {label} <ArrowRight size={15} aria-hidden />
    </button>
  );

  const footer = (action: React.ReactNode, back = draft.stage !== "type") => (
    <footer className={styles.footer}>
      {back ? (
        <button type="button" className={styles.backAction} onClick={goBack}>
          <ArrowLeft size={14} aria-hidden /> Back
        </button>
      ) : <Link className={styles.backAction} href="/dashboard">Cancel</Link>}
      {action}
    </footer>
  );

  return (
    <main ref={journeyRef} className={styles.page} data-stage={draft.stage} data-testid="launch-journey">
      <header className={styles.header}>
        <span className={styles.brand}>New resource</span>
        <ol className={styles.progress} aria-label="Launch steps">
          {JOURNEY_STEPS.map((label, index) => (
            <li key={label} aria-current={index === visibleStep(draft.stage) ? "step" : undefined} data-complete={index < visibleStep(draft.stage)}>
              <span className={styles.stepNumber} aria-hidden>{index < visibleStep(draft.stage) ? <Check size={12} /> : index + 1}</span>
              <span>{label}</span>
            </li>
          ))}
        </ol>
      </header>

      {draft.stage === "type" ? (
        <section className={styles.stage} aria-labelledby="launch-type-heading">
          <div className={styles.stageIntro}>
            <span className={styles.eyebrow}>Start something new</span>
            <h1 id="launch-type-heading">What do you want to launch?</h1>
            <p>An agent gets its own computer. A computer runs on its own, without an agent.</p>
          </div>
          <div className={styles.choiceGrid} role="group" aria-label="Resource type">
            <button type="button" className={styles.choice} data-selected={draft.resourceKind === "agent"} aria-pressed={draft.resourceKind === "agent"} onClick={() => chooseKind("agent")}>
              <Bot size={24} aria-hidden />
              <span><strong>Agent</strong><small>Launch a focused AI runtime on its own computer.</small></span>
              {draft.resourceKind === "agent" ? <Check size={16} aria-hidden /> : null}
            </button>
            <button type="button" className={styles.choice} data-selected={draft.resourceKind === "computer"} aria-pressed={draft.resourceKind === "computer"} onClick={() => chooseKind("computer")}>
              <Monitor size={24} aria-hidden />
              <span><strong>Computer</strong><small>Launch a desktop, terminal, and files. It runs without an agent.</small></span>
              {draft.resourceKind === "computer" ? <Check size={16} aria-hidden /> : null}
            </button>
          </div>
          {footer(primary("Continue", () => advanceTo("profile"), !draft.resourceKind), false)}
        </section>
      ) : null}

      {draft.stage === "profile" && draft.resourceKind === "agent" ? (
        <section className={styles.stage} aria-labelledby="launch-profile-heading">
          <div className={styles.stageIntro}>
            <span className={styles.eyebrow}>Agent profile</span>
            <h1 id="launch-profile-heading">Choose an agent</h1>
            <p>Choose Codex here, or browse the full agent catalogue.</p>
          </div>
          <button type="button" className={styles.profileChoice} data-selected={draft.profileId === "codex"} aria-pressed={draft.profileId === "codex"} onClick={() => chooseProfile("codex")}>
            <TerminalSquare size={22} aria-hidden />
            <span><strong>Codex</strong><small>OpenAI coding agent · native ChatGPT sign-in after launch</small></span>
            <em>Recommended</em>
          </button>
          <Link className={styles.catalogLink} href="/dashboard/welcome?step=agent-type&from=launch">
            Browse every agent <ArrowRight size={14} aria-hidden />
          </Link>
          {footer(primary("Continue", () => advanceTo("capacity"), draft.profileId !== "codex"))}
        </section>
      ) : null}

      {draft.stage === "profile" && draft.resourceKind === "computer" ? (
        <section className={styles.stage} aria-labelledby="launch-profile-heading">
          <div className={styles.stageIntro}>
            <span className={styles.eyebrow}>Computer profile</span>
            <h1 id="launch-profile-heading">Choose an operating system</h1>
            <p>The operating system defines this computer. A computer runs without an agent. To use an agent, launch an Agent — it gets its own computer.</p>
          </div>
          <div className={styles.profileList}>
            <button type="button" className={styles.profileChoice} data-selected={draft.profileId === "ubuntu-desktop"} aria-pressed={draft.profileId === "ubuntu-desktop"} onClick={() => chooseProfile("ubuntu-desktop")}>
              <Monitor size={22} aria-hidden />
              <span><strong>Ubuntu Desktop</strong><small>Contained browser desktop, terminal, files, and lifecycle controls</small></span>
              <em>Available alpha</em>
            </button>
            <button type="button" className={styles.profileChoice} data-selected={draft.profileId === "linux-terminal"} aria-pressed={draft.profileId === "linux-terminal"} onClick={() => chooseProfile("linux-terminal")}>
              <TerminalSquare size={22} aria-hidden />
              <span><strong>Linux Sandbox</strong><small>Lightweight non-root terminal workspace with gVisor isolation on a compatible host you connected</small></span>
              <em>Linux only</em>
            </button>
            <button type="button" className={styles.profileChoice} data-selected={draft.profileId === "omarchy"} aria-pressed={draft.profileId === "omarchy"} onClick={() => chooseProfile("omarchy")}>
              <span className={styles.letterIcon}>O.</span>
              <span><strong>Omarchy</strong><small>Prepared Omarchy 4.0.2 desktop with interactive browser setup console</small></span>
              <em>Canary ready</em>
            </button>
            <button type="button" className={styles.profileChoice} data-selected={draft.profileId === "windows"} aria-pressed={draft.profileId === "windows"} onClick={() => chooseProfile("windows")}>
              <TerminalSquare size={22} aria-hidden />
              <span><strong>Windows</strong><small>Start Windows installation from your ISO on compatible capacity you own</small></span>
            </button>
          </div>
          {footer(primary("Continue", () => advanceTo("capacity"), !draft.profileId || PROFILE_DETAILS[draft.profileId].resourceKind !== "computer"))}
        </section>
      ) : null}

      {draft.stage === "capacity" && currentProfile ? (
        <section className={styles.stage} aria-labelledby="launch-capacity-heading">
          <div className={styles.stageIntro}>
            <span className={styles.eyebrow}>Configure {draft.resourceKind === "computer" ? "computer" : "agent"}</span>
            <h1 id="launch-capacity-heading">Where should {currentProfile.name} run?</h1>
            <p>{draft.profileId === "windows"
              ? "Choose compatible customer-owned or self-hosted capacity. Hivra Cloud is not available for Windows."
              : "Use Hivra Cloud, or choose a compatible host you have connected."}</p>
          </div>
          <label className={styles.nameField}>
            <span>{draft.resourceKind === "computer" ? "Computer name" : "Agent name"}</span>
            <input
              aria-label={draft.resourceKind === "computer" ? "Computer name" : "Agent name"}
              value={draft.name}
              maxLength={64}
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="done"
              onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }}
              onChange={event => updateDraft({ name: event.target.value })}
            />
            <small>This is how it will appear in Hivra.</small>
          </label>
          {draft.profileId === "windows" ? (
            <section className={styles.windowsCapacity} aria-labelledby="windows-capacity-heading">
              <span id="windows-capacity-heading" className={styles.windowsCapacityLabel}>Where it runs</span>
              <div className={styles.windowsCapacityOptions} role="group" aria-label="Windows hosting destination">
                <button type="button" aria-pressed="false" disabled>
                  <Cloud size={16} aria-hidden />
                  <span><strong>Hivra Cloud</strong><small>Unavailable for Windows without managed entitlement.</small></span>
                </button>
                <button type="button" aria-pressed={destination.mode === "self-managed"}
                  disabled={destination.loading || destination.readyTargets.length === 0}
                  onClick={() => chooseDestinationMode("self-managed")}
                >
                  <Server size={16} aria-hidden />
                  <span><strong>Customer-owned capacity</strong><small>A compatible Windows-capable host you connected.</small></span>
                </button>
              </div>
              {destination.mode === "self-managed" && destination.readyTargets.length > 0 ? (
                <label className={styles.windowsTarget}>
                  Ready Windows host
                  <select value={destination.selectedTargetId} onChange={event => chooseTarget(event.target.value)}>
                    {!destination.selectedTarget ? <option value="" disabled>Choose a host</option> : null}
                    {destination.readyTargets.map(target => <option key={target.id} value={target.id}>{target.displayName}</option>)}
                  </select>
                </label>
              ) : null}
              {destination.deployment?.mode === "self-managed" ? <>
                <section className={styles.windowsMedia} aria-labelledby="windows-media-library-heading">
                  <div className={styles.windowsMediaHeading}>
                    <span id="windows-media-library-heading">Choose an ISO already on this host</span>
                    <button type="button" disabled={windowsImagesLoading} onClick={() => setWindowsInventoryRevision(value => value + 1)}>Refresh</button>
                  </div>
                  {windowsImages.length > 0 ? (
                    <label className={styles.windowsTarget}>
                      Host ISO library
                      <select
                        aria-label="Customer-owned Windows ISO"
                        value={draft.windowsIsoVolume ?? ""}
                        onChange={event => {
                          const image = windowsImages.find(candidate => candidate.volume === event.target.value);
                          updateDraft({
                            windowsIsoVolume: event.target.value,
                            windowsIsoEvidence: image ? {
                              sizeBytes: image.sizeBytes,
                              modifiedAtSeconds: image.modifiedAtSeconds,
                              fileIdentitySha256: image.fileIdentitySha256,
                            } : null,
                            windowsIsoSource: image?.source ?? "unknown",
                            windowsRightsAttested: false,
                          });
                        }}
                      >
                        <option value="" disabled>Choose a reusable host ISO</option>
                        {windowsImages.map(image => (
                          <option key={image.volume} value={image.volume}>{image.name}{image.source === "windows-server-evaluation" ? " — Windows Server Evaluation (evaluation only)" : ""}</option>
                        ))}
                      </select>
                    </label>
                  ) : <small>No Windows ISO is stored on this host yet.</small>}
                  <small>One host copy can be reused for multiple VMs; the ISO is not sent through your browser or Hivra storage.</small>
                </section>
                <details className={styles.windowsMedia}>
                  <summary>Download directly from Microsoft</summary>
                  <div className={styles.windowsDownloadGuide}>
                    <p>1. Open Microsoft, choose the edition and language, then copy the final direct ISO link.</p>
                    <div className={styles.windowsOfficialLinks}>
                      <a href="https://www.microsoft.com/software-download/windows11" target="_blank" rel="noreferrer">Windows 11 download</a>
                      <a href="https://www.microsoft.com/evalcenter/download-windows-server-2025" target="_blank" rel="noreferrer">Windows Server Evaluation</a>
                    </div>
                    <label className={styles.windowsTarget}>
                      Media type
                      <select aria-label="Microsoft Windows media type" value={windowsDownloadSource} onChange={event => {
                        setWindowsDownloadSource(event.target.value as typeof windowsDownloadSource);
                        updateDraft({ windowsRightsAttested: false });
                      }}>
                        <option value="windows-11">Windows 11</option>
                        <option value="windows-server-evaluation">Windows Server Evaluation — evaluation only</option>
                      </select>
                    </label>
                    <label className={styles.windowsDownloadUrl}>
                      Final Microsoft ISO link
                      <input aria-label="Final Microsoft ISO link" type="url" inputMode="url" autoCapitalize="none" autoCorrect="off"
                        spellCheck={false} enterKeyHint="done" value={windowsDownloadUrl} onChange={event => {
                        setWindowsDownloadUrl(event.target.value);
                        updateDraft({ windowsRightsAttested: false });
                      }} placeholder="https://software.download.prss.microsoft.com/…iso?…" />
                    </label>
                    {windowsIsoStorages.length > 0 ? <label className={styles.windowsTarget}>
                      ISO storage on this host
                      <select aria-label="ISO storage on this host" value={windowsDownloadStorage} onChange={event => setWindowsDownloadStorage(event.target.value)}>
                        {windowsIsoStorages.map(storage => <option key={storage.id} value={storage.id}>{storage.label}</option>)}
                      </select>
                    </label> : <small>No active ISO-compatible Proxmox storage is available.</small>}
                    <button className={styles.windowsDownloadAction} type="button" disabled={windowsDownloadStarting || Boolean(windowsDownloadTask && ["queued", "running"].includes(windowsDownloadTask.state)) || !windowsDownloadUrl.trim() || !windowsDownloadStorage || !draft.windowsRightsAttested} onClick={startWindowsDownload}>
                      {windowsDownloadStarting ? "Starting…" : "Download to this host"}
                    </button>
                    {windowsDownloadTask ? <div className={styles.windowsDownloadStatus} role="status">
                      {windowsDownloadTask.state === "succeeded"
                        ? "Download complete. Refreshing the reusable host ISO library…"
                        : windowsDownloadTask.state === "failed"
                          ? windowsDownloadTask.message || "Download failed. Generate a fresh Microsoft link and retry."
                          : `Downloading on the host${windowsDownloadTask.bytesDownloaded > 0 ? ` · ${(windowsDownloadTask.bytesDownloaded / 1024 ** 3).toFixed(2)} GB` : ""}…`}
                    </div> : null}
                    <small>Microsoft download links can expire. Hivra accepts only approved Microsoft HTTPS CDN links and does not follow redirects.</small>
                  </div>
                </details>
                <label className={styles.windowsAttestation}>
                  <input
                    type="checkbox"
                    checked={draft.windowsRightsAttested}
                    onChange={event => updateDraft({ windowsRightsAttested: event.target.checked })}
                  />
                  <span>I accept Microsoft&apos;s applicable terms and confirm I have the rights to download, install, and use this image. Hivra does not provide the media, licence, product key, activation, or a compliance determination. Windows Server Evaluation is evaluation-only.</span>
                </label>
              </> : null}
              {!destination.loading && destination.readyTargets.length === 0 ? (
                <small className={styles.windowsCapacityNotice}>
                  {destination.incompatibleReadyTargetCount > 0
                    ? "Your ready hosts do not have current Windows compatibility evidence. "
                    : "No compatible Windows host is ready. "}
                  <Link href={buildInfrastructureSetupHref("windows", { unified: true })}>Open Infrastructure</Link>
                </small>
              ) : null}
            </section>
          ) : (
            <DeploymentDestinationControl
              state={{ ...destination, setMode: chooseDestinationMode, setSelectedTargetId: chooseTarget }}
              managedAvailable={!selfManagedOnly}
              runtimeName={currentProfile.name}
              resourceLabel={draft.resourceKind ?? "agent"}
              capacitySetupHref={capacitySetupHref}
            />
          )}
          {draft.profileId === "codex" ? (
            <label className={styles.browserToggle}>
              <input type="checkbox" checked={draft.browser} onChange={event => chooseCodexBrowser(event.target.checked)} />
              <span>
                <strong>Browser for Codex</strong>
                <small>
                  Lets Codex open and use a web browser on its computer. Needs at least {formatSize(CODEX_BROWSER_FLOOR.cpu, CODEX_BROWSER_FLOOR.ram)} with
                  the browser, or {formatSize(CODEX_BASE_FLOOR.cpu, CODEX_BASE_FLOOR.ram)} without it.
                  {destination.mode === "hivra-managed" && plan && !paidPlan(plan) ? " On Hivra Cloud, the browser needs a paid plan." : null}
                </small>
              </span>
            </label>
          ) : null}
          {wholeProviderComputer ? <div className={styles.recommendation}>
            <ShieldCheck size={17} aria-hidden />
            <span><strong>Entire prepared provider computer</strong>
              <small>Launch uses this server&apos;s existing CPU and RAM. It does not resize it or reserve a smaller slice.</small></span>
          </div> : <><div className={styles.recommendation}>
            <ShieldCheck size={17} aria-hidden />
            <span>
              <strong>{draft.resources.source === "recommended" ? "Recommended" : "Selected"} · {draft.resources.cpu} CPU / {draft.resources.ram} GB {gvisorComputer ? "enforced limit" : `reserved · up to ${draft.resources.maximumCpu ?? draft.resources.cpu} CPU / ${draft.resources.maximumRam ?? draft.resources.ram} GB`}</strong>
              <small>{gvisorComputer
                ? "This sandbox reserves its full enforced CPU and memory limits. Admission checks serialized host reservations and live memory headroom."
                : draft.resources.source === "recommended"
                ? "Reserved CPU counts against your pool, but cores are shared, so speed is not guaranteed. Reserved memory is always kept for this computer. It can use more, up to the maximum, only while the host has spare room."
                : "Reserved CPU and memory count against capacity. It can use more, up to the maximum, only while the host has spare room; that extra is not reserved."}</small>
            </span>
          </div>
          <details className={styles.advanced} open={!narrowLayout}>
            <summary>Resources</summary>
            <div className={styles.advancedBody}>
              <fieldset aria-label="Reserved CPU">
                <legend>Reserved CPU</legend>
                <div>{currentProfile.cpuOptions.filter(cpu => cpu >= (resourceFloor?.cpu ?? 0)).map(cpu => (
                  <button key={cpu} type="button" disabled={cpu > reservedCpuLimit} aria-pressed={draft.resources.cpu === cpu} onClick={() => updateDraft({ resources: { ...draft.resources, cpu, maximumCpu: gvisorComputer ? cpu : Math.max(cpu, draft.resources.maximumCpu ?? draft.resources.cpu), source: "custom" } })}>{cpu} CPU</button>
                ))}</div>
              </fieldset>
              {!gvisorComputer ? <fieldset aria-label="Maximum CPU">
                <legend>Maximum CPU</legend>
                <div>{currentProfile.cpuOptions.filter(cpu => cpu >= draft.resources.cpu).map(cpu => (
                  <button key={cpu} type="button" disabled={cpu > maximumCpuLimit} aria-pressed={(draft.resources.maximumCpu ?? draft.resources.cpu) === cpu} onClick={() => updateDraft({ resources: { ...draft.resources, maximumCpu: cpu, source: "custom" } })}>{cpu} CPU</button>
                ))}</div>
              </fieldset> : null}
              <fieldset aria-label="Reserved memory">
                <legend>Reserved memory</legend>
                <div>{currentProfile.ramOptions.filter(ram => ram >= (resourceFloor?.ram ?? 0)).map(ram => (
                  <button key={ram} type="button" disabled={ram > reservedRamLimit} aria-pressed={draft.resources.ram === ram} onClick={() => updateDraft({ resources: { ...draft.resources, ram, maximumRam: gvisorComputer ? ram : Math.max(ram, draft.resources.maximumRam ?? draft.resources.ram), source: "custom" } })}>{ram} GB</button>
                ))}</div>
              </fieldset>
              {!gvisorComputer ? <fieldset aria-label="Maximum memory">
                <legend>Maximum memory</legend>
                <div>{currentProfile.ramOptions.filter(ram => ram >= draft.resources.ram).map(ram => (
                  <button key={ram} type="button" disabled={ram > maximumRamLimit} aria-pressed={(draft.resources.maximumRam ?? draft.resources.ram) === ram} onClick={() => updateDraft({ resources: { ...draft.resources, maximumRam: ram, source: "custom" } })}>{ram} GB</button>
                ))}</div>
              </fieldset> : null}
            </div>
          </details></>}
          {capacityBlocker ? (
            <div className={styles.blocker} role={destination.loading || !planChecked ? "status" : "alert"}>
              <AlertTriangle size={16} aria-hidden />
              <span><strong>{capacityBlocker}</strong>{blockerActions}</span>
            </div>
          ) : null}
          {footer(primary("Review launch", () => advanceTo("review", {
            capacity: destination.mode === "hivra-managed"
              ? { mode: "hivra-managed", targetId: null }
              : { mode: "self-managed", targetId: destination.selectedTarget?.id ?? null },
          }), Boolean(capacityBlocker || !draft.name.trim())))}
        </section>
      ) : null}

      {draft.stage === "review" && currentProfile ? (
        <section className={styles.stage} aria-labelledby="launch-review-heading">
          <div className={styles.stageIntro}>
            <span className={styles.eyebrow}>Review</span>
            <h1 id="launch-review-heading">Review this launch</h1>
            <p>Check the resource, location, and exact changes before you launch.</p>
          </div>
          <dl className={styles.review} aria-label="Launch review">
            <div><dt>Resource</dt><dd>{currentProfile.name}<small>{draft.resourceKind === "agent" ? "Agent runtime" : "Computer operating system"}</small></dd></div>
            <div><dt>Name</dt><dd>{draft.name}</dd></div>
            <div><dt>Runs on</dt><dd>{destination.mode === "hivra-managed" ? "Hivra Cloud" : destination.selectedTarget?.displayName ?? "Unavailable target"}</dd></div>
            {draft.profileId === "codex" ? <div><dt>Browser</dt><dd>{draft.browser ? "On · Codex can use a web browser on its computer" : "Off · Codex runs without a browser"}</dd></div> : null}
            <div><dt>Resources</dt><dd>{wholeProviderComputer ? "Entire prepared provider computer · existing CPU and RAM unchanged" : gvisorComputer ? `${draft.resources.cpu} CPU / ${draft.resources.ram} GB reserved and enforced maximum` : `${draft.resources.cpu} CPU / ${draft.resources.ram} GB reserved · up to ${draft.resources.maximumCpu ?? draft.resources.cpu} CPU / ${draft.resources.maximumRam ?? draft.resources.ram} GB`}</dd></div>
            <div><dt>Isolation</dt><dd>{displayIsolation(destination)}</dd></div>
            <div><dt>Cost</dt><dd>{destination.mode === "hivra-managed" ? `Uses the included ${plan?.name ?? "managed"} plan allowance.` : "Uses capacity you already connected. No server purchase."}</dd></div>
            <div><dt>Changes</dt><dd>{reviewMutation(draft, destination)}</dd></div>
            {draft.profileId === "windows" ? <>
              <div><dt>Installation media</dt><dd>{draft.windowsIsoVolume ?? "No ISO selected"}<small>{draft.windowsIsoSource === "windows-server-evaluation" ? "Windows Server Evaluation — evaluation only. " : ""}Already stored on your Proxmox host; Hivra does not upload or redistribute it.</small></dd></div>
              <div><dt>Rights</dt><dd>{draft.windowsRightsAttested ? "Attestation will be stamped to your account at launch." : "Not confirmed"}</dd></div>
            </> : null}
            <div><dt>Sign-in</dt><dd>{draft.profileId === "codex" ? "ChatGPT sign-in happens inside Codex after it opens." : "No agent or model credential is collected for this computer."}</dd></div>
          </dl>
          {capacityBlocker ? <div className={styles.blocker} role="alert"><AlertTriangle size={16} aria-hidden /><span><strong>{capacityBlocker}</strong>{blockerActions}</span></div> : null}
          {draft.error ? <div className={styles.blocker} role="alert"><AlertTriangle size={16} aria-hidden /><strong>{draft.error}</strong></div> : null}
          {draft.result?.status === "error" ? <div className={styles.blocker}>
            <AlertTriangle size={16} aria-hidden />
            <span><strong>The failed sandbox reservation is recoverable.</strong>
              <Link href={`/dashboard/agent/${encodeURIComponent(draft.result.id)}?tab=manage`}>Open it to delete</Link>
            </span>
          </div> : null}
          {footer(primary("Launch", () => void submit(), Boolean(capacityBlocker || !destination.deployment)))}
        </section>
      ) : null}

      {draft.stage === "launch" && currentProfile && draft.launchState === "submitting" ? (
        <section className={`${styles.stage} ${styles.outcome}`} aria-labelledby="launch-progress-heading" role="status" aria-live="polite">
          <Loader2 size={30} className={styles.spin} aria-hidden />
          <span className={styles.eyebrow}>Launch in progress</span>
          <h1 id="launch-progress-heading">Confirming your launch…</h1>
          <p>Hivra is checking the request for {draft.name.trim()}. We’ll open it as soon as the launch is confirmed.</p>
        </section>
      ) : null}

      {draft.stage === "launch" && currentProfile && draft.launchState === "accepted" && draft.result ? (
        <section className={`${styles.stage} ${styles.outcome}`} aria-labelledby="launch-accepted-heading">
          <span className={styles.successIcon}><Check size={24} aria-hidden /></span>
          <span className={styles.eyebrow}>Launch accepted</span>
          <h1 id="launch-accepted-heading">{draft.profileId === "windows" ? "Windows setup has started." : `${currentProfile.name} is being created.`}</h1>
          <p>{draft.profileId === "windows"
            ? "Open the setup record to follow provisioning. Finish installation from the Proxmox console before Hivra can expose a desktop connection."
            : "Open it now to follow observed provisioning and continue into its native surface."}</p>
          <Link className={styles.primaryAction} data-testid="launch-primary-action" href={launchResultHref(draft, draft.result.id)} onClick={clearLaunchDraft}>
            {draft.profileId === "windows" ? "Continue Windows setup" : `Open ${currentProfile.name}`} <ArrowRight size={15} aria-hidden />
          </Link>
        </section>
      ) : null}

      {draft.stage === "launch" && currentProfile && draft.launchState === "uncertain" ? (
        <section className={`${styles.stage} ${styles.outcome}`} aria-labelledby="launch-uncertain-heading">
          <span className={styles.warningIcon}><AlertTriangle size={24} aria-hidden /></span>
          <span className={styles.eyebrow}>Uncertain delivery</span>
          <h1 id="launch-uncertain-heading">Launch could not be confirmed.</h1>
          <p>The request may already have reached the provisioner. Resume checks the same receipt-protected request; it does not create a new launch identity.</p>
          {draft.error ? <div className={styles.blocker} role="status"><AlertTriangle size={16} aria-hidden /><strong>{draft.error}</strong></div> : null}
          <button
            type="button"
            className={styles.primaryAction}
            data-testid="launch-primary-action"
            onClick={() => void submit()}
            disabled={!draft.submittedDeployment}
          >
            Resume same launch <ArrowRight size={15} aria-hidden />
          </button>
          {!draft.submittedDeployment ? (
            <button type="button" className={styles.outcomeLink} onClick={startNew}>Start a new launch</button>
          ) : null}
          <Link className={styles.outcomeLink} href="/dashboard">Check Home</Link>
        </section>
      ) : null}

      {draft.stage === "launch" && currentProfile && draft.launchState === "failed" ? (
        <section className={`${styles.stage} ${styles.outcome}`} aria-labelledby="launch-failed-heading">
          <span className={styles.warningIcon}><AlertTriangle size={24} aria-hidden /></span>
          <span className={styles.eyebrow}>Launch stopped</span>
          <h1 id="launch-failed-heading">Nothing new will be started from this receipt.</h1>
          <p>{draft.error || "The launch was rejected before it could be accepted."}</p>
          <button type="button" className={styles.primaryAction} onClick={reviewFailedLaunch}>
            Review launch <ArrowRight size={15} aria-hidden />
          </button>
          <button type="button" className={styles.outcomeLink} onClick={startNew}>Start a new launch</button>
        </section>
      ) : null}
    </main>
  );
}
