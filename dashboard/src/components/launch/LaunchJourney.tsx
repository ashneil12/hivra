"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import {
  AlertTriangle,
  AppWindow,
  ArrowLeft,
  ArrowRight,
  Bot,
  Boxes,
  Check,
  Cloud,
  Code2,
  Cpu,
  Loader2,
  Monitor,
  Orbit,
  Server,
  TerminalSquare,
  Triangle,
  type LucideIcon,
} from "lucide-react";

import {
  DeploymentDestinationControl,
  measuredTargetCapacity,
  useLaunchDestination,
  type LaunchDestinationChoice,
  type LaunchDestinationState,
} from "@/components/dashboard/welcome/DeploymentDestinationControl";
import { parseLaunchTargetHandoff } from "@/components/dashboard/welcome/launch-target-handoff";
import type { DeploymentTargetDto } from "@/lib/infrastructure/contracts";
import { getAgent } from "@/lib/hivra/agent-catalog";
import { providerComputerResourceFloor } from "@/lib/hivra/provider-computer-resource-floor";
import {
  fetchPlanStrict,
  HivraLaunchCorrectableError,
  HivraLaunchRejectedError,
  listAgentsResult,
  type PlanInfo,
} from "@/lib/hivra/agent-api";
import { buildInfrastructureSetupHref, buildLaunchSetupHref } from "@/lib/hivra/launch-navigation";
import { isLocalAuthMode } from "@/lib/self-host/config";
import {
  isLaunchProfileId,
  LAUNCH_NAME_MAX_LENGTH,
  PROFILE_DETAILS,
  type LaunchCapacityChoice,
  type LaunchDraft,
  type LaunchProfileId,
  type LaunchResourceKind,
  type LaunchStage,
} from "@/lib/launch/contracts";
import {
  clearLaunchDraft,
  createLaunchDraft,
  isUnfinishedLaunchDraft,
  readLaunchDraft,
  writeLaunchDraft,
} from "@/lib/launch/draft-store";
import { launchResultHref, submitLaunchDraft } from "@/lib/launch/launch-adapter";
import {
  capabilitySummary,
  catalogAgentFitSubject,
  cheapestPlanForSize,
  costSummary,
  defaultLaunchName,
  formatLaunchSize,
  isolationDetail,
  isPaidPlan,
  launchChangesSummary,
  launchFit,
  launchNameProblem,
  launchProfileFitSubject,
  launchReturnPath,
  launchSubstrate,
  matchingSizePreset,
  modelAccessSummary,
  ownCapacityLabel,
  parseLaunchDraftParam,
  sizeLabel,
  sizePresets,
  type LaunchFit,
  type LaunchFitEvidence,
  type LaunchFitSubject,
  type SizePreset,
} from "@/lib/launch/launch-plan";
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

/** Mirrors the legacy welcome default: Codex's browser starts on only when a
 * paid plan can hold its floor. Hivra Cloud refuses browser automation on Free. */
function planFitsCodexBrowser(plan: PlanInfo | null): boolean {
  const floor = CODEX_BROWSER_FLOOR;
  return isPaidPlan(plan)
    && planCanFit(plan, { ...floor, maximumCpu: floor.cpu, maximumRam: floor.ram, source: "recommended" });
}

function sameResources(a: LaunchDraft["resources"], b: LaunchDraft["resources"]): boolean {
  return a.source === b.source
    && a.cpu === b.cpu
    && a.ram === b.ram
    && (a.maximumCpu ?? a.cpu) === (b.maximumCpu ?? b.cpu)
    && (a.maximumRam ?? a.ram) === (b.maximumRam ?? b.ram);
}

function meetsCodexFloor(resources: LaunchDraft["resources"], browser: boolean): boolean {
  const floor = browser ? CODEX_BROWSER_FLOOR : CODEX_BASE_FLOOR;
  return resources.cpu >= floor.cpu && resources.ram >= floor.ram;
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
  const meetsFloor = meetsCodexFloor(resources, browser);
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

type CodexBrowserDefaultContext = {
  /** The draft whose saved destination has been restored, if any. */
  restoredFor: string | null;
  browserDefault: boolean | null;
  mode: LaunchDestinationState["mode"];
  selectedTarget: DeploymentTargetDto | null;
  plan: PlanInfo | null;
};

/** The draft with Codex's browser default applied. A pure function of the
 * draft and its destination: applying it twice changes nothing, and it
 * returns the same draft when nothing changes. Until the owner chooses, the
 * browser follows the destination's default, but only a size that holds the
 * browser floor holds it: a custom size below the floor keeps the browser off
 * and is never raised, while a recommended size follows the default. */
function withCodexBrowserDefault(current: LaunchDraft, context: CodexBrowserDefaultContext): LaunchDraft {
  if (current.profileId !== "codex" || current.submittedDeployment) return current;
  // Until a resumed draft's saved destination is restored, the hook still
  // reports its initial Hivra Cloud choice; a default derived from it would
  // be for a destination the owner did not pick.
  if (current.launchRequestId !== context.restoredFor) return current;
  const custom = current.resources.source === "custom";
  const browser = current.browserSource === "recommended" && context.browserDefault !== null
    ? context.browserDefault && (!custom || meetsCodexFloor(current.resources, true))
    : current.browser;
  const resources = custom ? current.resources : codexResourcesFor(
    current.resources,
    browser,
    context.plan,
    next => destinationHolds(context.mode, context.selectedTarget, context.plan, next),
  );
  if (
    browser === current.browser
    && resources.cpu === current.resources.cpu
    && resources.ram === current.resources.ram
  ) return current;
  return { ...current, browser, resources };
}

/** The capacity a fresh draft records. The owner's destination stays selected
 * when they pick another profile, and the draft must say so: a reload
 * restores the draft's capacity, so recording Hivra Cloud here would silently
 * move the launch, and Codex's browser default with it. It records the owner's
 * own choice, not a placement the previous runtime forced. */
function freshDraftCapacity(choice: LaunchDestinationChoice): LaunchCapacityChoice {
  return choice.mode === "self-managed"
    ? { mode: "self-managed", targetId: choice.targetId }
    : { mode: "hivra-managed", targetId: null };
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
      ? `${label} needs ${formatLaunchSize(resources.cpu, resources.ram)}. Your ${plan.name} plan includes ${formatLaunchSize(cpu, ram)}.`
      : `${label} needs ${formatLaunchSize(resources.cpu, resources.ram)}. Your ${plan.name} plan has ${formatLaunchSize(cpu, ram)} left.`;
  }
  return `${label} is set to use up to ${formatLaunchSize(resources.maximumCpu ?? resources.cpu, resources.maximumRam ?? resources.ram)}. Your ${plan.name} plan allows up to ${formatLaunchSize(plan.maxCpuPerAgent, plan.maxRamPerAgent)} for each ${resourceKind}.`;
}

function stepBack(stage: LaunchStage): LaunchStage {
  if (stage === "plan") return "choose";
  if (stage === "review") return "plan";
  return stage;
}

type HistoryStage = Exclude<LaunchStage, "launch">;
const HISTORY_STAGES: readonly HistoryStage[] = ["choose", "plan", "review"];
/** Stage names links and history entries used before Choose was merged. */
const LEGACY_HISTORY_STAGES: Readonly<Record<string, HistoryStage>> = {
  type: "choose",
  profile: "choose",
  capacity: "plan",
};
const HISTORY_STAGE_KEY = "hivraLaunchStage";
const HISTORY_PUSHED_KEY = "hivraLaunchPushed";

function parseHistoryStage(value: unknown): HistoryStage | null {
  const stage = HISTORY_STAGES.find(candidate => candidate === value);
  if (stage) return stage;
  return typeof value === "string" && Object.hasOwn(LEGACY_HISTORY_STAGES, value) ? LEGACY_HISTORY_STAGES[value] : null;
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
  if (stage === "choose" || !draft.profileId) return "choose";
  if (stage === "review" && launchNameProblem(draft.profileId, draft.name)) return "plan";
  return stage;
}

const JOURNEY_STEPS = ["Choose", "Plan", "Review"] as const;

function visibleStep(stage: LaunchStage): number {
  if (stage === "choose") return 0;
  return stage === "plan" ? 1 : 2;
}

// ── Choose ──────────────────────────────────────────────────────────────────

type LinkedAgentId = "claude-code" | "hermes" | "openclaw" | "agent-zero" | "aeon";

type ChooseTile =
  | { kind: "launch"; id: LaunchProfileId; name: string; description: string; icon: LucideIcon | null }
  | { kind: "link"; id: LinkedAgentId; name: string; description: string; icon: LucideIcon; href: string };

/** Agents that still launch from their own setup page keep a way back here. */
function fromLaunch(href: string): string {
  return `${href}${href.includes("?") ? "&" : "?"}from=launch`;
}

const AGENT_TILES: readonly ChooseTile[] = ([
  { kind: "link", id: "claude-code", name: "Claude Code", description: "Anthropic's coding agent. Use your own Claude login.", icon: Code2, href: fromLaunch(buildLaunchSetupHref("claude-code")) },
  { kind: "launch", id: "codex", name: "Codex", description: "OpenAI's coding agent. Sign in with ChatGPT after it opens.", icon: Boxes },
  { kind: "link", id: "hermes", name: "Hermes", description: "A general-purpose agent for research and automation.", icon: Bot, href: fromLaunch("/dashboard/welcome?step=deploy&agentType=general") },
  { kind: "link", id: "openclaw", name: "OpenClaw", description: "An always-on agent you reach from your messaging apps.", icon: Cpu, href: fromLaunch(buildLaunchSetupHref("openclaw")) },
  { kind: "link", id: "agent-zero", name: "Agent Zero", description: "An autonomous agent with its own dashboard and browser.", icon: Orbit, href: fromLaunch(buildLaunchSetupHref("agent-zero")) },
  { kind: "link", id: "aeon", name: "Aeon", description: "An agent framework that runs its work on your GitHub.", icon: Triangle, href: fromLaunch(buildLaunchSetupHref("aeon")) },
] satisfies ChooseTile[]).filter(tile => tile.kind === "launch" || getAgent(tile.id)?.available === true);

const COMPUTER_TILES: readonly ChooseTile[] = [
  { kind: "launch", id: "ubuntu-desktop", name: "Ubuntu Desktop", description: "A desktop, terminal and files you open in your browser.", icon: Monitor },
  { kind: "launch", id: "linux-terminal", name: "Linux Sandbox", description: "A lightweight terminal workspace on a Linux server you connected.", icon: TerminalSquare },
  { kind: "launch", id: "omarchy", name: "Omarchy (Preview)", description: "A prepared Omarchy desktop with a setup console.", icon: null },
  { kind: "launch", id: "windows", name: "Windows (your ISO)", description: "Install Windows from your own ISO on a server you connected.", icon: AppWindow },
];

function tileSubject(tile: ChooseTile): LaunchFitSubject {
  return tile.kind === "launch" ? launchProfileFitSubject(tile.id) : catalogAgentFitSubject(tile.id);
}

function FitBadge({ fit }: { fit: LaunchFit | null }) {
  if (!fit) return <em className={styles.fitBadge} data-tone="checking">Checking fit…</em>;
  return <em className={styles.fitBadge} data-tone={fit.tone}>{fit.label}</em>;
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

function Stepper({ current }: { current: number }) {
  return (
    <ol className={styles.progress} aria-label="Launch steps">
      {JOURNEY_STEPS.map((label, index) => (
        <li key={label} aria-current={index === current ? "step" : undefined} data-complete={index < current}>
          <span className={styles.stepNumber} aria-hidden>{index < current ? <Check size={12} /> : index + 1}</span>
          <span>{label}</span>
        </li>
      ))}
    </ol>
  );
}

type ResumeChoice = { stored: LaunchDraft; fresh: LaunchDraft };

export function LaunchJourney() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isLoaded: authLoaded, userId } = useAuth();
  // Drafts are saved per owner in this browser; undefined until auth says who.
  const ownerId: string | null | undefined = authLoaded ? userId ?? null : undefined;
  const storageOwner = ownerId ?? null;
  const selfHosted = isLocalAuthMode();
  const [draft, setDraft] = useState<LaunchDraft | null>(null);
  // A new launch link found an unfinished draft; the owner picks which to keep.
  const [resumeChoice, setResumeChoice] = useState<ResumeChoice | null>(null);
  const [plan, setPlan] = useState<PlanInfo | null>(null);
  const [planChecked, setPlanChecked] = useState(false);
  const [planCheckRevision, setPlanCheckRevision] = useState(0);
  const [existingNames, setExistingNames] = useState<string[] | null>(null);
  const [whereExpanded, setWhereExpanded] = useState(false);
  const [customizeOpen, setCustomizeOpen] = useState(false);
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
  // The draft whose saved destination has been restored into the destination
  // hook. State, not a ref: the Codex browser default waits on it and must
  // re-run once it lands.
  const [restoredDestinationFor, setRestoredDestinationFor] = useState<string | null>(null);
  // The name Hivra picked for a draft before the owner's existing names had
  // loaded, so it can be renumbered once they do if the owner kept it.
  const autoNameRef = useRef<{ launchRequestId: string; name: string } | null>(null);
  // Set while a history pop the journey's own Back started is in flight.
  const ownBackPendingRef = useRef(false);
  const journeyRef = useRef<HTMLElement | null>(null);
  const activeStage = resumeChoice ? "resume" : draft?.stage;
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
  const returningDraftId = parseLaunchDraftParam(searchParams?.get("draft"));
  const upgradedParam = searchParams?.get("upgraded") === "1";
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
  // URL for back/forward must not re-run this and replace the draft. Waits
  // for the signed-in owner, whose drafts are the only ones it may read.
  useEffect(() => {
    if (ownerId === undefined) return;
    const stored = readLaunchDraft(ownerId);
    const requestedProfile = isLaunchProfileId(requestedProfileParam) ? requestedProfileParam : null;
    const freshFromIntent = (): LaunchDraft => {
      const next = createLaunchDraft();
      if (!requestedProfile) return next;
      const details = PROFILE_DETAILS[requestedProfile];
      const name = defaultLaunchName(requestedProfile, []);
      autoNameRef.current = { launchRequestId: next.launchRequestId, name };
      return {
        ...next,
        stage: "plan",
        resourceKind: details.resourceKind,
        profileId: requestedProfile,
        name,
        resources: { ...details.recommended },
      };
    };
    let initial: LaunchDraft;
    if (stored && (stored.launchState === "uncertain" || stored.launchState === "submitting")) {
      // A launch whose outcome is unknown is never set aside for a new one.
      initial = stored;
    } else if (stored && returningDraftId === stored.launchRequestId) {
      // Back from an upgrade this draft started.
      initial = stored;
    } else if (startParam === "1" || requestedProfile) {
      if (isUnfinishedLaunchDraft(stored) && startParam !== "1" && stored.profileId === requestedProfile) {
        initial = stored;
      } else if (isUnfinishedLaunchDraft(stored)) {
        setDraft(null);
        setResumeChoice({ stored, fresh: freshFromIntent() });
        return;
      } else {
        initial = freshFromIntent();
      }
    } else {
      initial = stored ?? createLaunchDraft();
    }
    setResumeChoice(null);
    writeLaunchDraft(initial, ownerId);
    setDraft(initial);
    // One task later so that on a hard load Next has patched history first;
    // an unpatched replaceState would drop the router's own entry state.
    const timer = window.setTimeout(() => writeStageHistory(initial.stage, "replace"), 0);
    return () => window.clearTimeout(timer);
  }, [ownerId, requestedProfileParam, returningDraftId, startParam, targetValuesKey]);

  useEffect(() => {
    let active = true;
    void listAgentsResult().then(({ agents }) => {
      if (active) setExistingNames(agents.map(agent => agent.name).filter((name): name is string => typeof name === "string"));
    });
    return () => { active = false; };
  }, []);

  // A default name chosen before the owner's names loaded is renumbered once
  // they do ("Codex 2" when "Codex 1" exists), unless the owner changed it.
  useEffect(() => {
    const auto = autoNameRef.current;
    if (!existingNames || !auto || !draft?.profileId) return;
    if (draft.launchRequestId !== auto.launchRequestId || draft.name !== auto.name) return;
    if (draft.stage !== "choose" && draft.stage !== "plan") return;
    const name = defaultLaunchName(draft.profileId, existingNames);
    autoNameRef.current = null;
    if (name === draft.name) return;
    setDraft(current => current?.launchRequestId === auto.launchRequestId && current.name === auto.name
      ? { ...current, name }
      : current);
  }, [draft, existingNames]);

  useEffect(() => {
    const onPopState = () => {
      // The journey's own Back already moved the draft; its history pop only
      // catches the URL up. Applying it again could undo a step the owner
      // took before the pop landed (Back, then a tile, in quick succession).
      if (ownBackPendingRef.current) {
        ownBackPendingRef.current = false;
        return;
      }
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
  // and the selected host's measured capacity on their own infrastructure.
  // It is re-evaluated on every draft change as well as destination changes,
  // so a size the owner raises past the browser floor turns the default on at
  // once, in view, and no later unrelated re-run (a reload, a host refresh, a
  // retried review) can flip a choice the owner was never shown. A submitted
  // launch never changes. Applied before paint so a stale default is never
  // shown or submitted.
  const destinationMode = destination.mode;
  const selectedTarget = destination.selectedTarget;
  const codexBrowserDefault = recommendedCodexBrowser(destinationMode, selectedTarget, plan);
  useLayoutEffect(() => {
    const context: CodexBrowserDefaultContext = {
      restoredFor: restoredDestinationFor,
      browserDefault: codexBrowserDefault,
      mode: destinationMode,
      selectedTarget,
      plan,
    };
    // Most draft edits (a name, a stage) leave the default as it is; skip the
    // state update for those.
    if (!draft || withCodexBrowserDefault(draft, context) === draft) return;
    setDraft(current => current ? withCodexBrowserDefault(current, context) : current);
  }, [codexBrowserDefault, destinationMode, draft, plan, restoredDestinationFor, selectedTarget]);

  useEffect(() => {
    if (draft) writeLaunchDraft(draft, storageOwner);
  }, [draft, storageOwner]);

  // A layout effect, like the browser default that waits on it: the saved
  // destination and its browser default both land before paint, so a host
  // that finishes loading never paints a frame without its default applied.
  useLayoutEffect(() => {
    if (!draft || destination.loading || restoredDestinationFor === draft.launchRequestId) return;
    setRestoredDestinationFor(draft.launchRequestId);
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
  }, [destination, draft, handoff, restoredDestinationFor]);

  useEffect(() => {
    if (draft?.launchState !== "accepted" || !draft.result) return;
    const href = launchResultHref(draft, draft.result.id);
    clearLaunchDraft(storageOwner);
    router.push(href);
  }, [draft, router, storageOwner]);

  const recheckPlan = () => {
    setPlanChecked(false);
    setPlanCheckRevision(value => value + 1);
  };

  // Back from an upgrade: say what the plan is now, from the plan itself,
  // never from the URL that brought the owner here.
  const activePlanMessage = (): string => {
    const active = `${plan?.name ?? "Your plan"} is active.`;
    if (!draft || draft.stage === "choose") return `${active} Choose what to launch.`;
    return draft.profileId && draft.launchRequestId === returningDraftId
      ? `${active} Continue your ${PROFILE_DETAILS[draft.profileId].name} launch.`
      : active;
  };
  const upgradeNotice = upgradedParam && planChecked && !selfHosted ? (
    isPaidPlan(plan) ? (
      <div className={styles.notice} role="status">
        <Check size={16} aria-hidden />
        <span>{activePlanMessage()}</span>
      </div>
    ) : (
      <div className={styles.blocker} role="status">
        <AlertTriangle size={16} aria-hidden />
        <span><strong>Your new plan isn&apos;t showing yet. It can take a moment after checkout.</strong>
          <span className={styles.blockerActions}><button type="button" onClick={recheckPlan}>Check again</button></span>
        </span>
      </div>
    )
  ) : null;

  if (resumeChoice) {
    const saved = resumeChoice.stored;
    const savedProfile = PROFILE_DETAILS[saved.profileId!];
    const freshProfile = resumeChoice.fresh.profileId ? PROFILE_DETAILS[resumeChoice.fresh.profileId] : null;
    const keep = (next: LaunchDraft) => {
      setResumeChoice(null);
      writeLaunchDraft(next, storageOwner);
      setRestoredDestinationFor(null);
      setDraft(next);
      writeStageHistory(next.stage, "replace");
    };
    return (
      <main ref={journeyRef} className={styles.page} data-stage="resume" data-testid="launch-journey">
        <header className={styles.header}>
          <span className={styles.brand}>Launch</span>
          <Stepper current={0} />
        </header>
        <section className={styles.stage} aria-labelledby="launch-resume-heading">
          <div className={styles.stageIntro}>
            <span className={styles.eyebrow}>Unfinished launch</span>
            <h1 id="launch-resume-heading">Continue your {savedProfile.name} launch, or start a new one?</h1>
            <p>You set up {saved.name.trim() || savedProfile.name} but haven&apos;t launched it. Nothing has started for it yet.</p>
          </div>
          <div className={styles.resumeActions}>
            <button type="button" className={styles.primaryAction} data-testid="launch-primary-action" onClick={() => keep(saved)}>
              Continue {savedProfile.name} launch <ArrowRight size={15} aria-hidden />
            </button>
            <button type="button" className={styles.secondaryAction} onClick={() => keep(resumeChoice.fresh)}>
              {freshProfile ? `Start a new ${freshProfile.name} launch` : "Start a new launch"}
            </button>
          </div>
        </section>
      </main>
    );
  }

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
  const managedPlanAllowed = !managedPaidRequired || isPaidPlan(plan);
  // Codex resources after a browser change, sized against the chosen destination.
  const holdsHere = (resources: LaunchDraft["resources"]) => destinationHolds(destination.mode, destination.selectedTarget, plan, resources);
  const resourcesWithBrowser = (browser: boolean): LaunchDraft["resources"] => {
    const raisedFrom = draft.browserRaisedFrom;
    // Turning off a browser the owner turned on undoes the raise it made, as
    // long as the owner has not changed the size since.
    if (!browser && raisedFrom && sameResources(draft.resources, codexResourcesFor(raisedFrom, true, plan, holdsHere))) {
      return raisedFrom;
    }
    return codexResourcesFor(draft.resources, browser, plan, holdsHere);
  };
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
  const substrate = launchSubstrate(destination.mode, destination.selectedTarget);
  const presetOptions = draft.profileId ? sizePresets(draft.profileId, { browser: codexBrowser }) : [];
  const currentPreset = matchingSizePreset(draft.resources, presetOptions);
  const currentSizeLabel = sizeLabel(draft.resources, presetOptions);
  const nameProblem = draft.profileId ? launchNameProblem(draft.profileId, draft.name) : null;
  // The plan that would hold this exact size, for an upgrade blocker.
  const upgrade = currentProfile && plan?.usage ? cheapestPlanForSize({
    reserved: { cpu: draft.resources.cpu, ram: draft.resources.ram },
    maximum: { cpu: draft.resources.maximumCpu ?? draft.resources.cpu, ram: draft.resources.maximumRam ?? draft.resources.ram },
    // Browser automation is never part of a Free plan on Hivra Cloud.
    minPlan: codexBrowser ? "pro" : launchProfileFitSubject(draft.profileId!).minPlan,
    poolExempt: false,
  }, plan) : null;
  const upgradeHref = `/dashboard/billing?from=launch&returnTo=${encodeURIComponent(launchReturnPath(draft.launchRequestId))}`;

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
  else if (preparedCanaryProfile && destination.mode !== "hivra-managed") capacityBlocker = "This preview computer runs on Hivra Cloud only.";
  else if (destination.mode === "self-managed" && !destination.deployment) capacityBlocker = "No compatible capacity is ready for this profile.";
  else if (destination.mode === "self-managed" && !selectedTargetFits) {
    // A size the owner chose is never lowered for them, so say how to get out
    // when a smaller size would fit this host.
    const smallerSizeFits = !wholeProviderComputer && resourceFloor !== null
      && targetCapacity.cpu >= resourceFloor.cpu
      && targetCapacity.ramGb >= resourceFloor.ram;
    capacityBlocker = smallerSizeFits
      ? "The selected host does not have enough measured capacity for this size. Choose a smaller size, or choose another host."
      : "The selected host does not have enough measured capacity for this size.";
    offerBrowserOff = codexBrowser && targetFitsWithoutBrowser;
  }
  else if (destination.mode === "hivra-managed" && managedEntitlementRequired) capacityBlocker = "Hivra Cloud isn't available for Windows. Choose a server you connected.";
  else if (draft.profileId === "windows" && windowsImagesLoading) capacityBlocker = "Checking the Windows ISOs on this server…";
  else if (draft.profileId === "windows" && windowsImagesError) capacityBlocker = windowsImagesError;
  else if (draft.profileId === "windows" && windowsImages.length === 0) capacityBlocker = "Choose an ISO already on this host, or download one directly from Microsoft to this host.";
  else if (draft.profileId === "windows" && !draft.windowsIsoVolume) capacityBlocker = "Choose the Windows ISO to attach.";
  else if (draft.profileId === "windows" && (!draft.windowsIsoEvidence || !selectedWindowsImage)) capacityBlocker = "Refresh and choose the exact host-observed Windows ISO again.";
  else if (draft.profileId === "windows" && !draft.windowsRightsAttested) capacityBlocker = "Confirm your Windows installation and use rights before review.";
  else if (destination.mode === "hivra-managed" && !preparedCanaryProfile && !planChecked) capacityBlocker = "Checking your managed plan…";
  else if (destination.mode === "hivra-managed" && !preparedCanaryProfile && !plan?.usage) {
    capacityBlocker = "Managed capacity could not be verified.";
    blockerRemedy = "check-plan";
  } else if (destination.mode === "hivra-managed" && !managedPlanAllowed) {
    capacityBlocker = "Ubuntu Desktop needs a paid plan on Hivra Cloud, or a server you connected.";
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
  } else if (destination.mode === "hivra-managed" && codexBrowser && !isPaidPlan(plan)) {
    capacityBlocker = "Codex with a browser needs a paid plan on Hivra Cloud.";
    blockerRemedy = "managed-plan";
    offerBrowserOff = true;
  }

  const updateDraft = (change: Partial<LaunchDraft>) => setDraft(current => current ? { ...current, ...change } : current);
  const chooseCodexBrowser = (browser: boolean) => {
    const resources = resourcesWithBrowser(browser);
    const raised = browser && draft.resources.source === "custom" && !sameResources(resources, draft.resources);
    updateDraft({
      browser,
      browserSource: "custom",
      resources,
      browserRaisedFrom: raised ? draft.resources : null,
    });
  };
  const chooseProfile = (profileId: LaunchProfileId) => {
    writeStageHistory("plan", "push");
    // The same choice again keeps its draft: name, size, place and request.
    if (draft.profileId === profileId) {
      updateDraft({ stage: "plan" });
      return;
    }
    const details = PROFILE_DETAILS[profileId];
    const fresh = createLaunchDraft();
    const browser = profileId === "codex"
      && (recommendedCodexBrowser(destination.mode, destination.selectedTarget, plan) ?? false);
    const name = defaultLaunchName(profileId, existingNames ?? []);
    autoNameRef.current = existingNames ? null : { launchRequestId: fresh.launchRequestId, name };
    setWhereExpanded(false);
    setCustomizeOpen(false);
    setDraft({
      ...fresh,
      capacity: freshDraftCapacity(destination.choice),
      stage: "plan",
      resourceKind: details.resourceKind,
      profileId,
      name,
      browser,
      browserSource: "recommended",
      resources: recommendedForPlan(profileId, plan, browser),
      windowsIsoVolume: null,
      windowsIsoEvidence: null,
      windowsIsoSource: "unknown",
      windowsIsoDownload: null,
      windowsRightsAttested: false,
    });
    setRestoredDestinationFor(null);
  };
  const choosePreset = (preset: SizePreset) => {
    updateDraft({ resources: { ...preset.resources, source: "custom" } });
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
    if (entry.pushed && entry.stage === draft.stage) {
      ownBackPendingRef.current = true;
      window.history.back();
    } else writeStageHistory(previous, "replace");
  };
  const startNew = () => {
    const next = createLaunchDraft();
    clearLaunchDraft(storageOwner);
    writeLaunchDraft(next, storageOwner);
    setRestoredDestinationFor(null);
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
    writeLaunchDraft(submitting, storageOwner);
    setDraft(submitting);
    try {
      const created = await submitLaunchDraft(submitting, submissionDeployment);
      const accepted = {
        ...submitting,
        launchState: "accepted" as const,
        result: { id: created.id, name: created.name, status: created.status },
        error: null,
      };
      writeLaunchDraft(accepted, storageOwner);
      setDraft(accepted);
    } catch (error) {
      if (error instanceof HivraLaunchRejectedError) {
        const failed = { ...submitting, launchState: "failed" as const, error: error.message };
        writeLaunchDraft(failed, storageOwner);
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
        writeLaunchDraft(correctable, storageOwner);
        setDraft(correctable);
      } else {
        const uncertain = {
          ...submitting,
          launchState: "uncertain" as const,
          error: error instanceof Error ? error.message : "The launch acknowledgement was lost.",
        };
        writeLaunchDraft(uncertain, storageOwner);
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
          <Link href={upgradeHref}>{upgrade ? `Upgrade to ${upgrade.name}` : "Review plans"}</Link>
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

  const footer = (action: React.ReactNode, back = draft.stage !== "choose") => (
    <footer className={styles.footer}>
      {back ? (
        <button type="button" className={styles.backAction} onClick={goBack}>
          <ArrowLeft size={14} aria-hidden /> Back
        </button>
      ) : <Link className={styles.backAction} href="/dashboard">Cancel</Link>}
      {action}
    </footer>
  );

  const fitEvidence: LaunchFitEvidence = {
    plan,
    planChecked,
    targets: destination.launchReadyTargets,
    targetsLoading: destination.loading,
    selfHosted,
  };
  const renderTile = (tile: ChooseTile) => {
    const fit = launchFit(tileSubject(tile), fitEvidence);
    const Icon = tile.icon;
    const body = <>
      {Icon ? <Icon size={22} aria-hidden /> : <span className={styles.letterIcon} aria-hidden>O.</span>}
      <span className={styles.tileText}>
        <strong>{tile.name}</strong>
        <small>{tile.description}</small>
        {tile.kind === "link" ? <small className={styles.tileHint}>Sets up on its own page</small> : null}
      </span>
      <FitBadge fit={fit} />
    </>;
    return tile.kind === "launch" ? (
      <button
        key={tile.id}
        type="button"
        className={styles.tile}
        data-selected={draft.profileId === tile.id}
        onClick={() => chooseProfile(tile.id)}
      >
        {body}
      </button>
    ) : (
      <Link key={tile.id} className={styles.tile} href={tile.href}>{body}</Link>
    );
  };
  const agentSection = (
    <section key="agents" className={styles.chooseSection} aria-labelledby="launch-agents-heading">
      <div className={styles.chooseHeading}>
        <h2 id="launch-agents-heading">An agent</h2>
        <p>An AI that works on its own computer.</p>
      </div>
      <div className={styles.tileGrid}>{AGENT_TILES.map(renderTile)}</div>
    </section>
  );
  const computerSection = (
    <section key="computers" className={styles.chooseSection} aria-labelledby="launch-computers-heading">
      <div className={styles.chooseHeading}>
        <h2 id="launch-computers-heading">A computer</h2>
        <p>A machine you use yourself. It runs on its own, without an agent.</p>
      </div>
      <div className={styles.tileGrid}>{COMPUTER_TILES.map(renderTile)}</div>
    </section>
  );

  const selfHostedTargetLabel = "Connected host";
  const whereForcedOpen = draft.profileId === "windows"
    || (destination.mode === "self-managed" && !destination.loading && !destination.selectedTarget)
    || (destination.mode === "self-managed" && Boolean(destination.error));
  const whereOpen = whereForcedOpen || whereExpanded;
  const whereTitle = destination.mode === "hivra-managed" && !selfHosted
    ? "Hivra Cloud"
    : destination.selectedTarget?.displayName
      ?? (destination.loading ? "Checking your servers…" : "No server selected");
  const whereDetail = destination.mode === "hivra-managed" && !selfHosted
    ? plan ? `${plan.name} plan` : null
    : destination.selectedTarget ? (selfHosted ? selfHostedTargetLabel : ownCapacityLabel(substrate)) : null;
  const sizeSummary = draft.profileId === "omarchy" || draft.profileId === "windows"
    ? `${draft.resources.cpu} CPU / ${draft.resources.ram} GB · fixed size`
    : gvisorComputer
      ? `${currentSizeLabel} · ${draft.resources.cpu} CPU / ${draft.resources.ram} GB enforced limit`
      : `${currentSizeLabel} · ${draft.resources.cpu} CPU / ${draft.resources.ram} GB reserved · up to ${draft.resources.maximumCpu ?? draft.resources.cpu} CPU / ${draft.resources.maximumRam ?? draft.resources.ram} GB`;
  const presetFits = (preset: SizePreset) => preset.resources.cpu <= reservedCpuLimit
    && preset.resources.ram <= reservedRamLimit
    && preset.resources.maximumCpu <= maximumCpuLimit
    && preset.resources.maximumRam <= maximumRamLimit;
  const modelAccess = draft.profileId ? modelAccessSummary(draft.profileId) : null;
  const cost = draft.profileId ? costSummary({ profileId: draft.profileId, substrate, planName: plan?.name ?? null }) : "";
  const whatItCanUse = draft.profileId ? capabilitySummary(draft.profileId, { browser: codexBrowser }) : "";
  const launchLabel = draft.profileId === "windows" ? "Start Windows setup" : `Launch ${currentProfile?.name ?? ""}`.trim();

  const windowsCapacity = draft.profileId === "windows" ? (
    <section className={styles.windowsCapacity} aria-labelledby="windows-capacity-heading">
      <span id="windows-capacity-heading" className={styles.windowsCapacityLabel}>Where it runs</span>
      <div className={styles.windowsCapacityOptions} role="group" aria-label="Windows hosting destination">
        <button type="button" aria-pressed="false" disabled>
          <Cloud size={16} aria-hidden />
          <span><strong>Hivra Cloud</strong><small>Not available for Windows.</small></span>
        </button>
        <button type="button" aria-pressed={destination.mode === "self-managed"}
          disabled={destination.loading || destination.readyTargets.length === 0}
          onClick={() => chooseDestinationMode("self-managed")}
        >
          <Server size={16} aria-hidden />
          <span><strong>My server</strong><small>A server you connected that can run Windows.</small></span>
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
                aria-label="Your Windows ISO"
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
  ) : null;

  return (
    <main ref={journeyRef} className={styles.page} data-stage={draft.stage} data-testid="launch-journey">
      <header className={styles.header}>
        <span className={styles.brand}>Launch</span>
        <Stepper current={visibleStep(draft.stage)} />
      </header>

      {draft.stage === "choose" ? (
        <section className={styles.stage} aria-labelledby="launch-choose-heading">
          <div className={styles.stageIntro}>
            <span className={styles.eyebrow}>Start something new</span>
            <h1 id="launch-choose-heading">What do you want to launch?</h1>
            <p>Pick an agent or a computer. Hivra suggests where it runs and how big it is, and you review everything before anything starts.</p>
          </div>
          {upgradeNotice}
          {planChecked && !plan?.usage && !selfHosted ? (
            <div className={styles.blocker} role="alert">
              <AlertTriangle size={16} aria-hidden />
              <span><strong>We couldn&apos;t check your plan, so we can&apos;t show what fits it yet.</strong>
                <span className={styles.blockerActions}><button type="button" onClick={recheckPlan}>Check again</button></span>
              </span>
            </div>
          ) : null}
          {requestedKindParam === "computer" ? [computerSection, agentSection] : [agentSection, computerSection]}
          {footer(null, false)}
        </section>
      ) : null}

      {draft.stage === "plan" && currentProfile ? (
        <section className={styles.stage} aria-labelledby="launch-plan-heading">
          <div className={styles.stageIntro}>
            <span className={styles.eyebrow}>{draft.resourceKind === "computer" ? "Your computer" : "Your agent"}</span>
            <h1 id="launch-plan-heading">{currentProfile.name} — here&apos;s the plan</h1>
            <p>{draft.profileId === "windows"
              ? "Choose the server and the ISO. Hivra Cloud isn't available for Windows."
              : selfManagedOnly
                ? `${currentProfile.name} runs on a Linux server you connected. Change anything, then review before anything starts.`
                : "Hivra picked where it runs and how big it is. Change anything, then review before anything starts."}</p>
          </div>
          {upgradeNotice}
          <div className={styles.planCard} role="group" aria-label="Launch plan">
            <label className={`${styles.planRow} ${styles.nameField}`}>
              <span className={styles.planLabel}>{draft.resourceKind === "computer" ? "Computer name" : "Agent name"}</span>
              <span className={styles.planValue}>
                <input
                  aria-label={draft.resourceKind === "computer" ? "Computer name" : "Agent name"}
                  aria-invalid={nameProblem ? true : undefined}
                  aria-describedby="launch-name-hint"
                  value={draft.name}
                  maxLength={LAUNCH_NAME_MAX_LENGTH}
                  autoCapitalize="none"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="done"
                  onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }}
                  onChange={event => {
                    autoNameRef.current = null;
                    updateDraft({ name: event.target.value });
                  }}
                />
                <small id="launch-name-hint" data-problem={nameProblem ? true : undefined}>{nameProblem ?? "This is how it will appear in Hivra."}</small>
              </span>
            </label>

            {draft.profileId !== "windows" ? (
              <div className={styles.planRow}>
                <span className={styles.planLabel}>Where it runs</span>
                <span className={styles.planValue}>
                  <span className={styles.planSummary}>
                    <strong>{whereTitle}</strong>
                    {whereDetail ? <small>{whereDetail}</small> : null}
                  </span>
                  {!whereForcedOpen ? (
                    <button
                      type="button"
                      className={styles.inlineAction}
                      aria-expanded={whereOpen}
                      aria-controls="launch-where-it-runs"
                      onClick={() => setWhereExpanded(open => !open)}
                    >
                      {whereOpen ? "Done" : "Change"}
                    </button>
                  ) : null}
                </span>
              </div>
            ) : null}
            {draft.profileId === "windows" ? windowsCapacity : whereOpen ? (
              <div id="launch-where-it-runs" className={styles.planPanel}>
                <DeploymentDestinationControl
                  state={{ ...destination, setMode: chooseDestinationMode, setSelectedTargetId: chooseTarget }}
                  managedAvailable={!selfManagedOnly}
                  runtimeName={currentProfile.name}
                  resourceLabel={draft.resourceKind ?? "agent"}
                  capacitySetupHref={capacitySetupHref}
                />
              </div>
            ) : null}

            <div className={styles.planRow}>
              <span className={styles.planLabel}>Size</span>
              <span className={styles.planValue}>
                {wholeProviderComputer ? (
                  <span className={styles.planSummary}>
                    <strong>The whole server</strong>
                    <small>Launch uses this server&apos;s CPU and memory as they are. It doesn&apos;t resize the server or reserve a smaller slice.</small>
                  </span>
                ) : presetOptions.length === 0 ? (
                  <span className={styles.planSummary}><strong>{sizeSummary}</strong></span>
                ) : (
                  <span className={styles.sizeChooser}>
                    <span className={styles.presets} role="group" aria-label="Size">
                      {presetOptions.map(preset => {
                        const fits = presetFits(preset);
                        const selected = currentPreset?.id === preset.id;
                        return (
                          <button
                            key={preset.id}
                            type="button"
                            aria-pressed={selected}
                            // The chosen size is never shown pressed but
                            // disabled; the blocker below says what to change.
                            disabled={!fits && !selected}
                            onClick={() => choosePreset(preset)}
                          >
                            <strong>{preset.label}</strong>
                            <small>{formatLaunchSize(preset.resources.cpu, preset.resources.ram)}</small>
                            {!fits ? <small>{destination.mode === "hivra-managed" ? "Over your plan" : "Too big for this server"}</small> : null}
                          </button>
                        );
                      })}
                    </span>
                    <strong className={styles.sizeSummary}>{sizeSummary}</strong>
                    <small>{gvisorComputer
                      ? "The sandbox always keeps its full CPU and memory, and never uses more."
                      : "Reserved memory is always kept for this computer. It can use more, up to the maximum, only while the host has spare room."}</small>
                    <button
                      type="button"
                      className={styles.inlineAction}
                      aria-expanded={customizeOpen}
                      aria-controls="launch-customize-size"
                      onClick={() => setCustomizeOpen(open => !open)}
                    >
                      {customizeOpen ? "Hide custom size" : "Customize"}
                    </button>
                  </span>
                )}
              </span>
            </div>
            {customizeOpen && !wholeProviderComputer && presetOptions.length > 0 ? (
              <div id="launch-customize-size" className={`${styles.planPanel} ${styles.advanced}`}>
                <p className={styles.customizeNote}>{destination.mode === "hivra-managed"
                  ? "Reserved CPU and memory count against your plan's pool. Cores are shared, so speed isn't guaranteed."
                  : "Reserved CPU and memory count against this server's capacity. Cores are shared, so speed isn't guaranteed."}</p>
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
              </div>
            ) : null}

            {draft.profileId === "codex" ? (
              <label className={`${styles.planRow} ${styles.browserToggle}`}>
                <span className={styles.planLabel}>Browser</span>
                <span className={styles.planValue}>
                  <span className={styles.browserChoice}>
                    <input type="checkbox" checked={draft.browser} onChange={event => chooseCodexBrowser(event.target.checked)} />
                    <span>
                      <strong>Browser for Codex</strong>
                      <small>
                        Lets Codex open and use a web browser on its computer. Needs at least {formatLaunchSize(CODEX_BROWSER_FLOOR.cpu, CODEX_BROWSER_FLOOR.ram)} with
                        the browser, or {formatLaunchSize(CODEX_BASE_FLOOR.cpu, CODEX_BASE_FLOOR.ram)} without it.
                        {destination.mode === "hivra-managed" && plan && !isPaidPlan(plan) ? " On Hivra Cloud, the browser needs a paid plan." : null}
                      </small>
                    </span>
                  </span>
                </span>
              </label>
            ) : null}

            {modelAccess ? (
              <div className={styles.planRow}>
                <span className={styles.planLabel}>Model access</span>
                <span className={styles.planValue}><span className={styles.planSummary}><strong>{modelAccess}</strong></span></span>
              </div>
            ) : null}
            <div className={styles.planRow}>
              <span className={styles.planLabel}>Cost</span>
              <span className={styles.planValue}><span className={styles.planSummary}><strong>{cost}</strong></span></span>
            </div>
            <div className={styles.planRow}>
              <span className={styles.planLabel}>What it can use</span>
              <span className={styles.planValue}><span className={styles.planSummary}><strong>{whatItCanUse}</strong></span></span>
            </div>
          </div>
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
          }), Boolean(capacityBlocker || nameProblem)))}
        </section>
      ) : null}

      {draft.stage === "review" && currentProfile && draft.profileId ? (
        <section className={styles.stage} aria-labelledby="launch-review-heading">
          <div className={styles.stageIntro}>
            <span className={styles.eyebrow}>Review</span>
            <h1 id="launch-review-heading">Review and launch {draft.name.trim()}</h1>
            <p>Check where it runs, what it can use and exactly what changes. Nothing starts until you launch.</p>
          </div>
          {upgradeNotice}
          <dl className={styles.review} aria-label="Launch review">
            <div><dt>Runs on</dt><dd>
              {destination.mode === "hivra-managed" && !selfHosted
                ? <>Hivra Cloud<small>Private virtual machine</small></>
                : <>{destination.selectedTarget?.displayName ?? "Unavailable server"}{destination.selectedTarget
                  ? <small>{selfHosted ? selfHostedTargetLabel : ownCapacityLabel(substrate)}</small> : null}</>}
            </dd></div>
            <div><dt>Size</dt><dd>{wholeProviderComputer
              ? "The whole server · its CPU and memory stay as they are"
              : gvisorComputer
                ? `${currentSizeLabel} · ${draft.resources.cpu} CPU / ${draft.resources.ram} GB reserved and enforced maximum`
                : sizeSummary}</dd></div>
            <div><dt>{draft.resourceKind === "agent" ? "Your agent can use" : "You can use"}</dt><dd>{whatItCanUse}</dd></div>
            {modelAccess ? <div><dt>Model</dt><dd>{modelAccess}</dd></div> : null}
            <div><dt>Cost</dt><dd>{cost}</dd></div>
            <div><dt>Changes</dt><dd>{launchChangesSummary({
              profileId: draft.profileId,
              substrate,
              targetName: destination.selectedTarget?.displayName ?? null,
            })}</dd></div>
            {draft.profileId === "windows" ? <>
              <div><dt>Installation media</dt><dd>{draft.windowsIsoVolume ?? "No ISO selected"}<small>{draft.windowsIsoSource === "windows-server-evaluation" ? "Windows Server Evaluation — evaluation only. " : ""}Already stored on your Proxmox host; Hivra does not upload or redistribute it.</small></dd></div>
              <div><dt>Rights</dt><dd>{draft.windowsRightsAttested ? "Attestation will be stamped to your account at launch." : "Not confirmed"}</dd></div>
            </> : null}
          </dl>
          <details className={styles.technical}>
            <summary>Technical details</summary>
            <dl aria-label="Technical details">
              <div><dt>Isolation</dt><dd>{isolationDetail(substrate)}</dd></div>
              <div><dt>Runtime</dt><dd>{currentProfile.runtimeId}{draft.profileId === "codex" ? ` · browser ${draft.browser ? "on" : "off"}` : ""}</dd></div>
              {destination.mode === "self-managed" && destination.selectedTarget ? <div><dt>Server id</dt><dd>{destination.selectedTarget.id}</dd></div> : null}
              <div><dt>Launch request</dt><dd>{draft.launchRequestId}</dd></div>
            </dl>
          </details>
          {capacityBlocker ? <div className={styles.blocker} role="alert"><AlertTriangle size={16} aria-hidden /><span><strong>{capacityBlocker}</strong>{blockerActions}</span></div> : null}
          {draft.error ? <div className={styles.blocker} role="alert"><AlertTriangle size={16} aria-hidden /><strong>{draft.error}</strong></div> : null}
          {draft.result?.status === "error" ? <div className={styles.blocker}>
            <AlertTriangle size={16} aria-hidden />
            <span><strong>Part of this launch was created and can be removed.</strong>
              <Link href={`/dashboard/agent/${encodeURIComponent(draft.result.id)}?tab=manage`}>Open it to delete</Link>
            </span>
          </div> : null}
          {footer(primary(launchLabel, () => void submit(), Boolean(capacityBlocker || !destination.deployment || nameProblem)))}
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
          <Link className={styles.primaryAction} data-testid="launch-primary-action" href={launchResultHref(draft, draft.result.id)} onClick={() => clearLaunchDraft(storageOwner)}>
            {draft.profileId === "windows" ? "Continue Windows setup" : `Open ${currentProfile.name}`} <ArrowRight size={15} aria-hidden />
          </Link>
        </section>
      ) : null}

      {draft.stage === "launch" && currentProfile && draft.launchState === "uncertain" ? (
        <section className={`${styles.stage} ${styles.outcome}`} aria-labelledby="launch-uncertain-heading">
          <span className={styles.warningIcon}><AlertTriangle size={24} aria-hidden /></span>
          <span className={styles.eyebrow}>Not confirmed yet</span>
          <h1 id="launch-uncertain-heading">Launch could not be confirmed.</h1>
          <p>The request may already have reached Hivra. Checking again uses the same request, so it won&apos;t start a second one.</p>
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
