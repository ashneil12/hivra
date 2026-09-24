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
  Droplet,
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
  DestinationOption,
  measuredTargetCapacity,
  useLaunchDestination,
  type LaunchDestinationChoice,
  type LaunchDestinationState,
} from "@/components/dashboard/welcome/DeploymentDestinationControl";
import { parseLaunchTargetHandoff } from "@/components/dashboard/welcome/launch-target-handoff";
import { useHermesWorkspaceReadiness } from "@/components/dashboard/welcome/useHermesWorkspaceReady";
import { FreeTierCardVerification } from "@/components/billing/FreeTierCardVerification";
import { useTokenGeoAccess } from "@/hooks/useTokenGeoAccess";
import { ManagedVeniceDepositModal } from "@/components/billing/ManagedVeniceDepositModal";
import type { DeploymentTargetDto, DigitalOceanDeploymentTargetDto } from "@/lib/infrastructure/contracts";
import { formatDigitalOceanBalance, listManagedSessions } from "@/lib/hivra/managed-session-client";
import { useDigitalOceanBalance } from "@/components/infrastructure/useDigitalOceanBalance";
import {
  digitalOceanHarnessFor,
  digitalOceanModelProblem,
  digitalOceanSizeFor,
  digitalOceanSizeLabel,
  digitalOceanTargetRuns,
  digitalOceanVendorKey,
  effectiveDigitalOceanModelMode,
} from "@/lib/launch/digitalocean-launch";
import { DigitalOceanLaunchPlan, digitalOceanBalanceProblem } from "./DigitalOceanLaunchPlan";
import { LaunchCapacitySheet } from "./LaunchCapacitySheet";
import { getAgent } from "@/lib/hivra/agent-catalog";
import { agentLaunchWatchRow } from "@/lib/agent-computers/agent-surfaces";
import { targetSupportsLaunchModelSettings } from "@/lib/hivra/agent-placement";
import { providerComputerResourceFloor } from "@/lib/hivra/provider-computer-resource-floor";
import {
  fetchPlanStrict,
  HivraLaunchCorrectableError,
  HivraLaunchRejectedError,
  listAgentsResult,
  type PlanInfo,
} from "@/lib/hivra/agent-api";
import { requestManagedVeniceSummary } from "@/lib/billing/managed-venice-client";
import { requestSubscriptionCheckout } from "@/lib/billing/client";
import { BILLING_SUBSCRIBE_REASON } from "@/lib/billing/subscribe-errors";
import { buildInfrastructureSetupHref, isPortableAgentLaunchId, parsePortableLaunchResourceId } from "@/lib/hivra/launch-navigation";
import { isLocalAuthMode } from "@/lib/self-host/config";
import {
  HERMES_NAME_MAX_LENGTH,
  isLaunchProfileId,
  LAUNCH_NAME_MAX_LENGTH,
  PROFILE_DETAILS,
  profileHasBrowser,
  type LaunchCapacityChoice,
  type LaunchDraft,
  type LaunchModelAccess,
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
import {
  LaunchCorrectableError,
  launchResultHref,
  launchResumeModeFor,
  opensOnAcceptanceFor,
  reconcileLaunchDraft,
  savedMemoryKey,
  submitLaunchDraft,
  type LaunchObservation,
} from "@/lib/launch/launch-adapter";
import {
  apiKeyProviders,
  freshModelAccess,
  hasModelAccess,
  modelAccessOptions,
  modelAccessProblem,
  modelAccessSummary,
  modelCostNote,
  recommendedModelAccessMode,
  savedKeyHint,
  withModelAccessDefault,
  type CreditsBalance,
  type SavedModelKey,
} from "@/lib/launch/model-access";
import {
  capabilitySummary,
  cheapestPlanForSize,
  costSummary,
  defaultLaunchName,
  destinationSizeLimits,
  fitSizePresets,
  fittingPresetFor,
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
  ownCapacityLabel,
  parseLaunchArrival,
  planHoldAction,
  planHoldMessage,
  recommendedLaunchSize,
  sameLaunchSize,
  sizeLabel,
  sizePresets,
  sizeWithinLimits,
  unfinishedLaunchNotes,
  upgradeObserved,
  upgradeRequestSize,
  type LaunchArrival,
  type LaunchFit,
  type LaunchFitEvidence,
  type PlanHold,
  type SizeLimits,
  type SizePreset,
} from "@/lib/launch/launch-plan";
import { launchResourcePolicy } from "@/lib/launch/resource-envelope";
import {
  captureLaunchEvent,
  captureLaunchEventOnce,
  launchErrorMessage,
  launchEventContext,
  launchFailureStage,
  type LaunchFunnelEvent,
} from "@/lib/launch/launch-telemetry";
import {
  loadLaunchTemplate,
  safeTemplateRef,
  type LaunchTemplate,
  type LaunchTemplateLookup,
} from "@/lib/launch/launch-template";
import { PLANS } from "@/lib/subscription/plans";

import styles from "./LaunchJourney.module.css";
import { ModelAccessControl } from "./ModelAccessControl";

function planCanFit(plan: PlanInfo | null, resources: LaunchDraft["resources"], poolExempt = false): boolean {
  if (!plan?.usage) return false;
  return plan.maxCpuPerAgent >= (resources.maximumCpu ?? resources.cpu)
    && plan.maxRamPerAgent >= (resources.maximumRam ?? resources.ram)
    // A pool-exempt agent (Aeon) uses an agent slot, not the CPU and memory pool.
    && (poolExempt || (plan.poolCpu - plan.usage.usedCpu >= resources.cpu
      && plan.poolRam - plan.usage.usedRam >= resources.ram));
}

function isPoolExempt(profileId: LaunchProfileId | null): boolean {
  return profileId !== null && launchProfileFitSubject(profileId).poolExempt;
}

/** What the plan lets one launch use, or null until its usage is known. */
function planSizeLimits(plan: PlanInfo | null): SizeLimits | null {
  return plan?.usage ? destinationSizeLimits("hivra-managed", null, plan) : null;
}

/** Hivra's size for a profile on Hivra Cloud: the recommendation, with its
 * maximum brought down to the plan's per-agent cap when it is over it. */
function recommendedForPlan(profileId: LaunchProfileId, plan: PlanInfo | null, browser: boolean) {
  return recommendedLaunchSize(profileId, planSizeLimits(plan), { browser });
}

/** Hivra's size for a profile at the chosen destination. Profiles with a
 * browser also follow their browser choice; withBrowserDefault owns that. */
function recommendedHere(
  profileId: LaunchProfileId,
  mode: LaunchDestinationState["mode"],
  selectedTarget: DeploymentTargetDto | null,
  plan: PlanInfo | null,
) {
  if (mode === "hivra-managed") return recommendedForPlan(profileId, plan, false);
  return recommendedLaunchSize(profileId, destinationSizeLimits(mode, selectedTarget, plan), { browser: false });
}

/** The draft with Hivra's own size fitted to where it runs. A pure function
 * of the draft and its destination, like the browser default: a size Hivra
 * picked follows the plan and the host (so a draft restored after an upgrade
 * gets the new plan's size), and a size the owner chose never moves. */
function withRecommendedSize(
  current: LaunchDraft,
  context: Omit<BrowserDefaultContext, "browserDefault"> & { loading: boolean },
): LaunchDraft {
  if (!current.profileId || profileHasBrowser(current.profileId)) return current;
  if (current.resources.source !== "recommended" || current.submittedDeployment || current.stage === "launch") return current;
  // A host list that is still loading reports no host; keep the size until
  // the evidence is back instead of flickering through the recommendation.
  if (current.launchRequestId !== context.restoredFor || context.loading) return current;
  const resources = recommendedHere(current.profileId, context.mode, context.selectedTarget, context.plan);
  return sameLaunchSize(resources, current.resources) ? current : { ...current, resources };
}

function browserFloorFor(profileId: LaunchProfileId) {
  return launchResourcePolicy(profileId, { browser: true }).floor;
}

function baseFloorFor(profileId: LaunchProfileId) {
  return launchResourcePolicy(profileId, { browser: false }).floor;
}

/** Mirrors the welcome forms' default: a browser starts on only when a paid
 * plan can hold its floor. Hivra Cloud refuses browser automation on Free. */
function planFitsBrowser(profileId: LaunchProfileId, plan: PlanInfo | null): boolean {
  const floor = browserFloorFor(profileId);
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

function meetsFloor(profileId: LaunchProfileId, resources: LaunchDraft["resources"], browser: boolean): boolean {
  const floor = browser ? browserFloorFor(profileId) : baseFloorFor(profileId);
  return resources.cpu >= floor.cpu && resources.ram >= floor.ram;
}

function isWholeProviderComputer(target: DeploymentTargetDto | null): boolean {
  return target !== null && (target.capabilities as unknown as { kind?: string }).kind === "provider-vm";
}

/** A profile's browser default for the chosen destination. A browser that
 * follows the destination starts on for Hivra Cloud when the plan holds it,
 * and on the owner's own capacity when the selected host's measured capacity
 * holds its floor, as the welcome forms did. OpenClaw's starts off. Null while
 * the plan or the selected host is not known yet. */
function recommendedBrowser(
  profileId: LaunchProfileId,
  mode: LaunchDestinationState["mode"],
  selectedTarget: DeploymentTargetDto | null,
  plan: PlanInfo | null,
): boolean | null {
  const browser = PROFILE_DETAILS[profileId].browser;
  if (browser === "none" || browser === "opt-in") return false;
  if (mode === "hivra-managed") return plan ? planFitsBrowser(profileId, plan) : null;
  if (!selectedTarget) return null;
  const capacity = measuredTargetCapacity(selectedTarget);
  const floor = browserFloorFor(profileId);
  return capacity.cpu >= floor.cpu && capacity.ramGb >= floor.ram;
}

/** Whether the chosen destination can hold this size. Unknown capacity counts
 * as holding it, so missing evidence never forces a smaller size. */
function destinationHolds(
  mode: LaunchDestinationState["mode"],
  selectedTarget: DeploymentTargetDto | null,
  plan: PlanInfo | null,
  resources: LaunchDraft["resources"],
  poolExempt = false,
): boolean {
  if (mode === "hivra-managed") return !plan?.usage || planCanFit(plan, resources, poolExempt);
  // A provider computer is used whole; the requested size is not a slice of it.
  if (!selectedTarget || isWholeProviderComputer(selectedTarget)) return true;
  const capacity = measuredTargetCapacity(selectedTarget);
  return capacity.cpu >= resources.cpu && capacity.ramGb >= resources.ram;
}

/** Resources for a browser choice. Turning the browser off never shrinks a
 * size that meets the base floor and still fits, and turning it on raises
 * only what is below the browser floor. A recommended size the destination can
 * no longer hold falls back to the recommendation for that choice. */
function resourcesForBrowser(
  profileId: LaunchProfileId,
  resources: LaunchDraft["resources"],
  browser: boolean,
  plan: PlanInfo | null,
  holds: (resources: LaunchDraft["resources"]) => boolean,
): LaunchDraft["resources"] {
  const floor = browser ? browserFloorFor(profileId) : baseFloorFor(profileId);
  const fits = meetsFloor(profileId, resources, browser);
  const pinned = PROFILE_DETAILS[profileId].sizing === "pinned";
  if (resources.source === "custom") {
    if (fits) return resources;
    const cpu = Math.max(resources.cpu, floor.cpu);
    const ram = Math.max(resources.ram, floor.ram);
    return {
      ...resources,
      cpu,
      ram,
      maximumCpu: pinned ? cpu : Math.max(resources.maximumCpu ?? cpu, cpu),
      maximumRam: pinned ? ram : Math.max(resources.maximumRam ?? ram, ram),
    };
  }
  if (fits && (browser || holds(resources))) return resources;
  return recommendedForPlan(profileId, plan, browser);
}

type BrowserDefaultContext = {
  /** The draft whose saved destination has been restored, if any. */
  restoredFor: string | null;
  browserDefault: boolean | null;
  mode: LaunchDestinationState["mode"];
  selectedTarget: DeploymentTargetDto | null;
  plan: PlanInfo | null;
};

/** The draft with its browser default applied. A pure function of the draft
 * and its destination: applying it twice changes nothing, and it returns the
 * same draft when nothing changes. Until the owner chooses, the browser
 * follows the destination's default, but only a size that holds the browser
 * floor holds it: a custom size below the floor keeps the browser off and is
 * never raised, while a recommended size follows the default. */
function withBrowserDefault(current: LaunchDraft, context: BrowserDefaultContext): LaunchDraft {
  if (!current.profileId || !profileHasBrowser(current.profileId) || current.submittedDeployment) return current;
  const profileId = current.profileId;
  // Until a resumed draft's saved destination is restored, the hook still
  // reports its initial Hivra Cloud choice; a default derived from it would
  // be for a destination the owner did not pick.
  if (current.launchRequestId !== context.restoredFor) return current;
  const custom = current.resources.source === "custom";
  const browser = current.browserSource === "recommended" && context.browserDefault !== null
    ? context.browserDefault && (!custom || meetsFloor(profileId, current.resources, true))
    : current.browser;
  const resources = custom ? current.resources : resourcesForBrowser(
    profileId,
    current.resources,
    browser,
    context.plan,
    next => destinationHolds(context.mode, context.selectedTarget, context.plan, next),
  );
  if (browser === current.browser && sameLaunchSize(resources, current.resources)) return current;
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

/** States what this launch needs next to what the plan can still hold for it:
 * the per-computer limit when that is what it exceeds, otherwise how much of
 * the plan's shared CPU or memory is still free. The two are never mixed into
 * one "left" figure (a per-computer cap is not what is left). */
function managedCapacityShortfall(
  label: string,
  resourceKind: LaunchResourceKind,
  resources: LaunchDraft["resources"],
  plan: PlanInfo & { usage: NonNullable<PlanInfo["usage"]> },
): string {
  const { usedCpu, usedRam } = plan.usage;
  const amount = (value: number) => Math.floor(value * 10 + 1e-9) / 10;
  const freeCpu = Math.max(0, plan.poolCpu - usedCpu);
  const freeRam = Math.max(0, plan.poolRam - usedRam);
  const needs = `${label} needs ${formatLaunchSize(resources.cpu, resources.ram)}.`;
  const overCap = resources.cpu > plan.maxCpuPerAgent || resources.ram > plan.maxRamPerAgent;
  const overPool = resources.cpu > freeCpu || resources.ram > freeRam;
  // On plans whose per-computer limit is the whole allowance (Free), "includes" says both.
  const capIsPool = plan.maxCpuPerAgent >= plan.poolCpu && plan.maxRamPerAgent >= plan.poolRam;
  if (overCap && !capIsPool) {
    return `${needs} Your ${plan.name} plan allows up to ${formatLaunchSize(plan.maxCpuPerAgent, plan.maxRamPerAgent)} for each ${resourceKind}.`;
  }
  if (overCap || overPool) {
    if (usedCpu === 0 && usedRam === 0) return `${needs} Your ${plan.name} plan includes ${formatLaunchSize(plan.poolCpu, plan.poolRam)}.`;
    const free = [
      resources.cpu > freeCpu ? `${amount(freeCpu)} of its ${amount(plan.poolCpu)} CPU free` : null,
      resources.ram > freeRam ? `${amount(freeRam)} of its ${amount(plan.poolRam)} GB free` : null,
    ].filter((part): part is string => part !== null);
    return `${needs} Your ${plan.name} plan has ${free.join(" and ")}.`;
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

/** Query params that only mean something on arrival from a detour (the
 * draft an upgrade started from, and the plan it moved to). The journey's own
 * history entries drop them, so a reload doesn't announce the upgrade again. */
const ARRIVAL_PARAMS = ["draft", "upgraded"] as const;

// Each forward step gets its own history entry so the Android back gesture
// and iOS edge swipe step back through the journey instead of leaving it.
// Next's patched pushState/replaceState keep its router state in sync.
function writeStageHistory(stage: LaunchStage, mode: "push" | "replace") {
  if (typeof window === "undefined" || stage === "launch") return;
  const entry = currentHistoryEntry();
  const url = new URL(window.location.href);
  const arrived = ARRIVAL_PARAMS.some(key => url.searchParams.has(key));
  if (mode === "replace" && entry.stage === stage && !arrived) return;
  for (const key of ARRIVAL_PARAMS) url.searchParams.delete(key);
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

const STAGE_ORDER: Readonly<Record<HistoryStage, number>> = { choose: 0, plan: 1, review: 2 };

/** Brings the current history entry in line with the step on screen after
 * one of the journey's own Back pops lands. The owner may have pressed Back
 * again (or taken another step) before it did: pop again past an entry the
 * journey pushed for a step they left, push for a step they moved on to, and
 * otherwise rewrite the entry in place. Returns true when it popped again. */
function catchUpHistory(shown: LaunchStage | null): boolean {
  if (!shown || shown === "launch") return false;
  const entry = currentHistoryEntry();
  if (entry.stage === shown) return false;
  if (entry.stage && entry.pushed && STAGE_ORDER[entry.stage] > STAGE_ORDER[shown]) {
    window.history.back();
    return true;
  }
  writeStageHistory(shown, entry.stage && STAGE_ORDER[entry.stage] < STAGE_ORDER[shown] ? "push" : "replace");
  return false;
}

/** A partly created launch stays on the draft through Back and history:
 * it is the owner's way to open and delete what was created. */
function keptResult(draft: LaunchDraft): LaunchDraft["result"] {
  return draft.result?.status === "error" ? draft.result : null;
}

const JOURNEY_STEPS = ["Choose", "Plan", "Review"] as const;

function visibleStep(stage: LaunchStage): number {
  if (stage === "choose") return 0;
  return stage === "plan" ? 1 : 2;
}

// ── Choose ──────────────────────────────────────────────────────────────────

type ChooseTile = { id: LaunchProfileId; name: string; description: string; icon: LucideIcon | null };

const AGENT_TILES: readonly ChooseTile[] = ([
  { id: "claude-code", name: "Claude Code", description: "Anthropic's coding agent. Sign in with your Claude account after it opens.", icon: Code2 },
  { id: "codex", name: "Codex", description: "OpenAI's coding agent. Sign in with ChatGPT after it opens.", icon: Boxes },
  { id: "hermes", name: "Hermes", description: "A general-purpose agent for research and automation.", icon: Bot },
  { id: "openclaw", name: "OpenClaw", description: "An always-on agent you reach from your messaging apps.", icon: Cpu },
  { id: "agent-zero", name: "Agent Zero", description: "An autonomous agent with its own dashboard and browser.", icon: Orbit },
  { id: "aeon", name: "Aeon", description: "An agent framework that runs its work on your GitHub.", icon: Triangle },
] satisfies ChooseTile[]).filter(tile => getAgent(PROFILE_DETAILS[tile.id].runtimeId)?.available === true);

const COMPUTER_TILES: readonly ChooseTile[] = [
  { id: "ubuntu-desktop", name: "Ubuntu Desktop", description: "A desktop, terminal and files you open in your browser.", icon: Monitor },
  { id: "linux-terminal", name: "Linux Sandbox", description: "A lightweight terminal workspace on a Linux server you connected.", icon: TerminalSquare },
  { id: "omarchy", name: "Omarchy (Preview)", description: "A prepared Omarchy desktop with a setup console.", icon: null },
  { id: "windows", name: "Windows (your ISO)", description: "Install Windows from your own ISO on a server you connected.", icon: AppWindow },
];

/** The owner's Capacity page, opened for this runtime when it can use a
 * server they connect. */
function capacitySetupHrefFor(profileId: LaunchProfileId | null): string {
  if (!profileId) return "/dashboard/infrastructure";
  const runtime = PROFILE_DETAILS[profileId].placementRuntimeId;
  if (runtime === "windows-installer") return buildInfrastructureSetupHref("windows", { unified: true });
  if (runtime === "linux-desktop" || runtime === "linux-terminal" || isPortableAgentLaunchId(runtime)) {
    return buildInfrastructureSetupHref(runtime, { unified: true });
  }
  return "/dashboard/infrastructure";
}

/** What the capacity sheet sets up for: the launch's own runtime, when a server can run it. */
function capacityResourceFor(profileId: LaunchProfileId | null) {
  if (!profileId) return null;
  const runtime = PROFILE_DETAILS[profileId].placementRuntimeId;
  return parsePortableLaunchResourceId(runtime === "windows-installer" ? "windows" : runtime);
}

/** Copy for a profile's optional browser. */
function browserCopy(profileId: LaunchProfileId): string {
  const name = PROFILE_DETAILS[profileId].name;
  return profileId === "openclaw"
    ? "A real Chrome with a live view you can watch and sign in to. OpenClaw acts in that signed-in session."
    : `Lets ${name} open and use a web browser on its computer.`;
}

/** Plain words for the receipt phase a launch in flight last reported. */
function observedLaunchText(observation: LaunchObservation | null, resend: boolean): string {
  if (observation?.kind === "checking-host") return "Checking your Linux host is still ready before Hivra starts the sandbox.";
  if (observation?.kind === "receipt") {
    if (observation.phase === "reserved") return "Hivra has recorded the request and is creating the computer.";
    if (observation.phase === "bound") return "The computer exists. Hivra is finishing the launch record.";
    return "Hivra is checking the computer's state with its server.";
  }
  return resend
    ? "Sent to Hivra. Waiting for Hivra to record the request."
    : "Sent to Hivra. It answers once the computer is created, which can take a few minutes.";
}

function elapsedSince(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Records a funnel moment once it is on screen, once per key: later
 * renders with the same key describe the same moment. */
function FunnelMoment({ momentKey, event, properties }: {
  momentKey: string;
  event: LaunchFunnelEvent;
  properties: Record<string, unknown>;
}) {
  useEffect(() => {
    captureLaunchEventOnce(momentKey, event, properties);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the moment, not on each render's copy of its properties
  }, [momentKey]);
  return null;
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

/** A Hermes agent the launch created. Its computer exists; the screen says
 * so, and offers Start chatting once its workspace actually answers. */
function HermesLaunched({
  name,
  instanceId,
  href,
  onLeave,
  onStartNew,
}: {
  name: string;
  instanceId: string;
  href: string;
  onLeave: () => void;
  onStartNew: () => void;
}) {
  const { ready, checking, recheck } = useHermesWorkspaceReadiness(instanceId);
  const telegramHref = `${href}${href.includes("?") ? "&" : "?"}connect=telegram`;
  return (
    <section className={`${styles.stage} ${styles.outcome}`} aria-labelledby="launch-accepted-heading" aria-live="polite">
      <span className={styles.successIcon}><Check size={24} aria-hidden /></span>
      <span className={styles.eyebrow}>{ready ? "Ready to chat" : "Launch accepted"}</span>
      <h1 id="launch-accepted-heading">{ready ? `${name} is ready.` : `${name} has its own computer and is starting.`}</h1>
      <p>{ready
        ? "Its workspace answered. Start your first chat."
        : "Hivra is waiting for its workspace to answer. This usually takes a few minutes; you can open it now and watch it start."}</p>
      {ready ? (
        <>
          <Link className={styles.primaryAction} data-testid="launch-primary-action" href={href} onClick={onLeave}>
            Start chatting <ArrowRight size={15} aria-hidden />
          </Link>
          <Link className={styles.outcomeLink} href={telegramHref} onClick={onLeave}>Also chat from Telegram</Link>
        </>
      ) : (
        <>
          {checking ? (
            <p className={styles.observed} role="status"><Loader2 size={13} className={styles.spin} aria-hidden /> Waiting for the workspace to answer</p>
          ) : (
            <p className={styles.observed} role="status">
              The workspace hasn&apos;t answered yet, and Hivra has stopped checking.{" "}
              <button type="button" className={styles.outcomeLink} onClick={recheck}>Check again</button>
            </p>
          )}
          <Link className={styles.secondaryAction} data-testid="launch-primary-action" href={href} onClick={onLeave}>
            Open {name} now
          </Link>
        </>
      )}
      <button type="button" className={styles.outcomeLink} onClick={onStartNew}>Launch something else</button>
    </section>
  );
}

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
  // Turning the Free plan on from the launch: its own button, never implied.
  // "paid-plan-found": billing refused Free because a paid plan holds the
  // account; the plan is read again to show which, and how to settle it.
  const [freeActivation, setFreeActivation] = useState<
    { state: "idle" | "activating" | "activated" | "paid-plan-found" } | { state: "failed"; message: string }
  >({ state: "idle" });
  // The first-run funnel's "activation page" is Launch for an account with
  // no plan; recorded once per visit.
  const activationViewRecordedRef = useRef(false);
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
  // hook. State, not a ref: the browser default waits on it and must re-run
  // once it lands.
  const [restoredDestinationFor, setRestoredDestinationFor] = useState<string | null>(null);
  // Model access evidence: the owner's Hivra credit balance and the keys saved
  // in their Vault (listed without the keys themselves).
  const [observedCredits, setCreditsBalance] = useState<CreditsBalance>({ state: "loading" });
  // Token geo-policy: a viewer it blocks (or while it is still checking) sees
  // and bills card credits only, as the welcome deploy form does. "allowed"
  // at once while the policy is dormant.
  const tokenPaymentsShown = useTokenGeoAccess().status === "allowed";
  const creditsBalance = useMemo<CreditsBalance>(
    () => tokenPaymentsShown || observedCredits.state !== "known"
      ? observedCredits
      : { ...observedCredits, hermesosMicroUsd: 0 },
    [observedCredits, tokenPaymentsShown],
  );
  const [creditsRevision, setCreditsRevision] = useState(0);
  const [savedKeys, setSavedKeys] = useState<SavedModelKey[]>([]);
  // A key pasted for one launch, held only in this page's memory. It is never
  // written to the draft, and it belongs to the launch it was typed for.
  const [pastedKey, setPastedKey] = useState<{ launchRequestId: string; value: string } | null>(null);
  const [depositOpen, setDepositOpen] = useState(false);
  const [cardCheckOpen, setCardCheckOpen] = useState(false);
  const [observation, setObservation] = useState<LaunchObservation | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [reconciling, setReconciling] = useState(false);
  const [reconcileNote, setReconcileNote] = useState<string | null>(null);
  // The name Hivra picked for a draft before the owner's existing names had
  // loaded, so it can be renumbered once they do if the owner kept it.
  const autoNameRef = useRef<{ launchRequestId: string; name: string } | null>(null);
  // Set while a history pop the journey's own Back started is in flight.
  const ownBackPendingRef = useRef(false);
  // The step on screen, for catching the history up when that pop lands.
  const shownStageRef = useRef<LaunchStage | null>(null);
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
  const draftParam = searchParams?.get("draft") ?? null;
  const upgradedParam = searchParams?.get("upgraded") ?? null;
  // "Start from a template": the template's own agent, under its name.
  const templateParam = safeTemplateRef(searchParams?.get("template"));
  const templateTokenParam = safeTemplateRef(searchParams?.get("templateToken"));
  const [templateLookup, setTemplateLookup] = useState<{ ref: string; result: LaunchTemplateLookup | null } | null>(null);
  const [templateLookupRevision, setTemplateLookupRevision] = useState(0);
  useEffect(() => {
    if (!templateParam) {
      setTemplateLookup(null);
      return;
    }
    let active = true;
    setTemplateLookup({ ref: templateParam, result: null });
    void loadLaunchTemplate(templateParam, templateTokenParam).then(result => {
      if (active) setTemplateLookup({ ref: templateParam, result });
    });
    return () => { active = false; };
  }, [templateParam, templateTokenParam, templateLookupRevision]);
  // Settled for the template this link names; null while it loads.
  const templateResult = templateParam && templateLookup?.ref === templateParam ? templateLookup.result : null;
  const linkedTemplate: LaunchTemplate | null = templateResult?.status === "found" ? templateResult.template : null;
  const templateProblem = templateResult && templateResult.status !== "found" ? templateResult : null;
  // Read on arrival and kept: the journey's own history writes drop these
  // params, and the draft and notice they describe must not change with them.
  const [arrival, setArrival] = useState<LaunchArrival | null>(() => parseLaunchArrival(draftParam, upgradedParam));
  useEffect(() => {
    const next = parseLaunchArrival(draftParam, upgradedParam);
    if (!next) return;
    setArrival(current => current
      && current.draftId === next.draftId
      && Boolean(current.upgrade) === Boolean(next.upgrade)
      && current.upgrade?.target === next.upgrade?.target ? current : next);
  }, [draftParam, upgradedParam]);
  const returningDraftId = arrival?.draftId ?? null;
  const upgradeReturn = arrival?.upgrade ?? null;
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
    // Hermes runs on Hivra Cloud only, whatever was chosen for another agent.
    selfManagedAvailable: profile?.lane !== "hermes-instance",
    targetKind: profile?.placementRuntimeId === "linux-terminal" ? "gvisor" : "any",
  });

  // DigitalOcean Managed Agents teams the owner connected. They run a
  // DigitalOcean sandbox, not a host, so they are read on their own and never
  // enter the host destination list.
  const [digitalOceanTeams, setDigitalOceanTeams] = useState<{ state: "loading" | "ready" | "failed"; targets: DigitalOceanDeploymentTargetDto[] }>(
    () => ({ state: selfHosted ? "ready" : "loading", targets: [] }),
  );
  useEffect(() => {
    if (selfHosted) return;
    const controller = new AbortController();
    listManagedSessions(controller.signal)
      .then(result => { if (!controller.signal.aborted) setDigitalOceanTeams({ state: "ready", targets: result.targets }); })
      .catch(() => { if (!controller.signal.aborted) setDigitalOceanTeams({ state: "failed", targets: [] }); });
    return () => controller.abort();
  }, [selfHosted]);
  // Capacity set up without leaving the launch (slice 10).
  const [capacitySheetOpen, setCapacitySheetOpen] = useState(false);
  const digitalOceanHarness = digitalOceanHarnessFor(draft?.profileId ?? null);
  const digitalOceanChoices = digitalOceanHarness
    ? digitalOceanTeams.targets.filter(target => digitalOceanTargetRuns(target, digitalOceanHarness))
    : [];
  const digitalOceanLane = draft?.capacity.mode === "digitalocean";
  const digitalOceanTarget = digitalOceanLane
    ? digitalOceanChoices.find(target => target.id === draft?.capacity.targetId) ?? null
    : null;
  const digitalOceanBalance = useDigitalOceanBalance(digitalOceanTarget?.connectionId ?? "",
    Boolean(digitalOceanTarget) && draft?.stage !== "launch");
  /** The DigitalOcean team a profile can run on, from an earlier choice or the card that handed it over. */
  const digitalOceanTeamFor = (profileId: LaunchProfileId, targetId: string | null | undefined) => {
    const harness = digitalOceanHarnessFor(profileId);
    return harness && targetId
      ? digitalOceanTeams.targets.find(target => target.id === targetId && digitalOceanTargetRuns(target, harness)) ?? null
      : null;
  };

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
    // A template link decides once the template has been read.
    if (templateParam && !templateResult) return;
    const stored = readLaunchDraft(ownerId);
    const requestedProfile = linkedTemplate?.profileId
      ?? (isLaunchProfileId(requestedProfileParam) ? requestedProfileParam : null);
    const freshFromIntent = (): LaunchDraft => {
      const next = createLaunchDraft();
      if (!requestedProfile) return next;
      const details = PROFILE_DETAILS[requestedProfile];
      const name = linkedTemplate?.name ?? defaultLaunchName(requestedProfile, []);
      if (!linkedTemplate?.name) autoNameRef.current = { launchRequestId: next.launchRequestId, name };
      return {
        ...next,
        stage: "plan",
        resourceKind: details.resourceKind,
        profileId: requestedProfile,
        name,
        resources: { ...details.recommended },
        template: linkedTemplate ? { id: linkedTemplate.id, name: linkedTemplate.name } : null,
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
      if (isUnfinishedLaunchDraft(stored) && startParam !== "1" && stored.profileId === requestedProfile
        && (stored.template?.id ?? null) === (linkedTemplate?.id ?? null)) {
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
  }, [linkedTemplate, ownerId, requestedProfileParam, returningDraftId, startParam, targetValuesKey, templateParam, templateResult]);

  useEffect(() => {
    let active = true;
    // Hermes agents live in their own list; their names count too, so a new
    // "Hermes 1" is never a second one.
    const hermesNames = fetch("/api/instances?summary=true", { cache: "no-store", credentials: "same-origin" })
      .then(response => response.json())
      .then((body: { data?: unknown }) => Array.isArray(body?.data)
        ? body.data.map(row => (row as { name?: unknown })?.name).filter((name): name is string => typeof name === "string")
        : [])
      .catch(() => [] as string[]);
    void Promise.all([listAgentsResult(), hermesNames]).then(([{ agents }, hermes]) => {
      if (active) setExistingNames([...agents.map(agent => agent.name).filter((name): name is string => typeof name === "string"), ...hermes]);
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
        ownBackPendingRef.current = catchUpHistory(shownStageRef.current);
        return;
      }
      const requested = currentHistoryEntry().stage;
      if (!requested) return;
      setDraft(current => {
        if (!current || current.stage === "launch") return current;
        const next = reachableStage(requested, current);
        if (next === current.stage) return current;
        return { ...current, stage: next, launchState: "idle", result: keptResult(current), error: null };
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
      })
      .catch(() => {
        if (!active) return;
        setPlan(null);
        setPlanChecked(true);
      });
    return () => { active = false; };
  }, [planCheckRevision]);

  useEffect(() => {
    if (selfHosted || !planChecked || !plan?.needsActivation || activationViewRecordedRef.current) return;
    activationViewRecordedRef.current = true;
    captureLaunchEvent("activation_page_viewed", { plan: "free", authState: "signed_in" });
  }, [plan, planChecked, selfHosted]);

  // Hivra credits pay for models; the balance decides whether Hermes starts on
  // them and whether the credits choice can be picked at all.
  useEffect(() => {
    if (selfHosted) {
      setCreditsBalance({ state: "unknown" });
      return;
    }
    let active = true;
    setCreditsBalance({ state: "loading" });
    void requestManagedVeniceSummary().then(result => {
      if (!active) return;
      setCreditsBalance(result.ok
        ? { state: "known", cardMicroUsd: result.summary.wallets.card.availableMicroUsd, hermesosMicroUsd: result.summary.wallets.hermesos.availableMicroUsd }
        : { state: "unknown" });
    }).catch(() => {
      if (active) setCreditsBalance({ state: "unknown" });
    });
    return () => { active = false; };
  }, [creditsRevision, selfHosted]);

  // Saved Vault keys, listed without the keys themselves. A launch sends one
  // only after the owner confirms it for that launch.
  useEffect(() => {
    let active = true;
    fetch("/api/vault", { cache: "no-store", credentials: "same-origin" })
      .then(response => response.json())
      .then((body: { success?: boolean; data?: unknown }) => {
        if (!active || body?.success !== true || !Array.isArray(body.data)) return;
        setSavedKeys(body.data.filter((key): key is SavedModelKey =>
          Boolean(key) && typeof key === "object"
          && typeof (key as SavedModelKey).id === "string"
          && typeof (key as SavedModelKey).provider === "string"));
      })
      .catch(() => { /* No saved keys to offer; pasting still works. */ });
    return () => { active = false; };
  }, []);

  // Until the owner chooses, Hermes runs on Hivra credits when they have
  // some, and every other agent signs in inside itself after it opens.
  useLayoutEffect(() => {
    const context = { balance: creditsBalance, selfHosted };
    if (!draft || withModelAccessDefault(draft, context) === draft) return;
    setDraft(current => current ? withModelAccessDefault(current, context) : current);
  }, [creditsBalance, draft, selfHosted]);

  // The launching screen counts time from when the request was sent: an
  // observed fact, never a guess at progress.
  const launchInFlight = draft?.stage === "launch" && draft.launchState === "submitting";
  useEffect(() => {
    if (!launchInFlight) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [launchInFlight]);

  // Until the owner chooses, a browser follows the plan on Hivra Cloud
  // and the selected host's measured capacity on their own infrastructure.
  // It is re-evaluated on every draft change as well as destination changes,
  // so a size the owner raises past the browser floor turns the default on at
  // once, in view, and no later unrelated re-run (a reload, a host refresh, a
  // retried review) can flip a choice the owner was never shown. A submitted
  // launch never changes. Applied before paint so a stale default is never
  // shown or submitted.
  const destinationMode = destination.mode;
  const destinationLoading = destination.loading;
  const selectedTarget = destination.selectedTarget;
  const draftProfileId = draft?.profileId ?? null;
  const browserDefault = draftProfileId && profileHasBrowser(draftProfileId)
    ? recommendedBrowser(draftProfileId, destinationMode, selectedTarget, plan)
    : null;
  useLayoutEffect(() => {
    const context: BrowserDefaultContext = {
      restoredFor: restoredDestinationFor,
      browserDefault,
      mode: destinationMode,
      selectedTarget,
      plan,
    };
    // Most draft edits (a name, a stage) leave the default as it is; skip the
    // state update for those.
    if (!draft || withBrowserDefault(draft, context) === draft) return;
    setDraft(current => current ? withBrowserDefault(current, context) : current);
  }, [browserDefault, destinationMode, draft, plan, restoredDestinationFor, selectedTarget]);

  // The same for every other profile's size: Hivra's own pick follows the
  // plan and the selected host whenever either changes, including a plan
  // that resolves after a draft is restored (back from an upgrade) or before.
  useLayoutEffect(() => {
    const context = { restoredFor: restoredDestinationFor, mode: destinationMode, selectedTarget, plan, loading: destinationLoading };
    if (!draft || withRecommendedSize(draft, context) === draft) return;
    setDraft(current => current ? withRecommendedSize(current, context) : current);
  }, [destinationLoading, destinationMode, draft, plan, restoredDestinationFor, selectedTarget]);

  useLayoutEffect(() => {
    shownStageRef.current = draft?.stage ?? null;
  }, [draft?.stage]);

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
    // Hermes stays here to show when its workspace answers (Start chatting).
    if (!opensOnAcceptanceFor(draft)) return;
    const href = launchResultHref(draft, draft.result.id);
    clearLaunchDraft(storageOwner);
    router.push(href);
  }, [draft, router, storageOwner]);

  // A pasted key belongs to the launch it was typed for.
  const draftRequestId = draft?.launchRequestId ?? null;
  const currentPastedKey = pastedKey && pastedKey.launchRequestId === draftRequestId ? pastedKey.value : "";
  const setCurrentPastedKey = (value: string) => {
    if (!draftRequestId) return;
    setPastedKey(value ? { launchRequestId: draftRequestId, value } : null);
  };

  const recheckPlan = () => {
    setPlanChecked(false);
    setPlanCheckRevision(value => value + 1);
  };

  // A new account turns the Free plan on here, with its own button. Nothing
  // is bought; the plan is read again afterwards and only then counts.
  const activateFree = async () => {
    if (freeActivation.state === "activating") return;
    setFreeActivation({ state: "activating" });
    captureLaunchEvent("activation_started", { plan: "free", authState: "signed_in" });
    const result = await requestSubscriptionCheckout("free");
    if (result.ok) {
      captureLaunchEvent("activation_dashboard_reached", { plan: "free", destination: "/dashboard/launch", outcome: "free_plan_activated" });
      setFreeActivation({ state: "activated" });
      recheckPlan();
      return;
    }
    if (result.reason === BILLING_SUBSCRIBE_REASON.ACTIVE_SUBSCRIPTION) {
      // A paid plan holds the account, so Free isn't turned on over it. Read
      // the plan again: it shows as active, or as on hold with the way to
      // settle it. Nothing here says Free is on.
      captureLaunchEvent("activation_dashboard_reached", { plan: "free", destination: "/dashboard/launch", outcome: "active_subscription" });
      setFreeActivation({ state: "paid-plan-found" });
      recheckPlan();
      return;
    }
    captureLaunchEvent("activation_failed", {
      plan: "free",
      stage: "free_plan_activation",
      failureType: result.reason ?? "subscribe_request_failed",
      errorCategory: result.status >= 500 || result.status === 0 ? "server" : "request",
      status: result.status,
      recoverable: true,
    });
    // Launch's own words: this step takes no payment, whatever the billing
    // client calls a request it couldn't complete.
    setFreeActivation({ state: "failed", message: "Couldn't turn on the Free plan. Nothing was charged. Try again in a moment." });
  };
  // Said once the plan read back shows it, never from the click alone.
  const planActiveAfterActivation = (freeActivation.state === "activated" || freeActivation.state === "paid-plan-found")
    && planChecked && plan && !plan.needsActivation && !plan.onHold;
  const freeActiveNotice = planActiveAfterActivation ? (
    <div className={styles.notice} role="status">
      <Check size={16} aria-hidden />
      <span>{`${plan.name} is active.`}</span>
    </div>
  ) : null;
  // A paid plan holds the account without granting anything: billing said
  // so, or turning Free on found one billing didn't describe. Hivra Cloud
  // waits until it is settled in Billing; the owner's servers don't.
  const planHold: PlanHold | null = selfHosted || !planChecked || !plan ? null
    : plan.onHold ? { reason: plan.onHold.reason, planName: plan.onHold.name }
      : plan.needsActivation && freeActivation.state === "paid-plan-found" ? { reason: "unconfirmed" }
        : null;
  const billingSettleHref = (launchRequestId: string) =>
    `/dashboard/billing?tab=overview&returnTo=${encodeURIComponent(launchReturnPath(launchRequestId))}`;

  // Back from an upgrade: say what the plan is now, from the plan itself,
  // never from the URL that brought the owner here. The URL only names the
  // plan the owner moved to, so a plan that hasn't caught up says so.
  const activePlanMessage = (): string => {
    const active = `${plan?.name ?? "Your plan"} is active.`;
    if (!draft || draft.stage === "choose") return `${active} Choose what to launch.`;
    return draft.profileId && draft.launchRequestId === returningDraftId
      ? `${active} Continue your ${PROFILE_DETAILS[draft.profileId].name} launch.`
      : active;
  };
  const upgradeTarget = upgradeReturn?.target ?? null;
  // A plan check that failed is reported where it matters (the Choose banner
  // and the Hivra Cloud blocker); it says nothing about the upgrade.
  const upgradeNotice = upgradeReturn && planChecked && plan && !selfHosted ? (
    upgradeObserved(plan, upgradeTarget) ? (
      <div className={styles.notice} role="status">
        <Check size={16} aria-hidden />
        <span>{activePlanMessage()}</span>
      </div>
    ) : (
      <div className={styles.blocker} role="status">
        <AlertTriangle size={16} aria-hidden />
        <span><strong>{upgradeTarget
          ? `Your ${PLANS[upgradeTarget].name} plan isn't showing yet. It can take a moment after checkout. You're still on ${plan.name}.`
          : "Your new plan isn't showing yet. It can take a moment after checkout."}</strong>
          <span className={styles.blockerActions}><button type="button" onClick={recheckPlan}>Check again</button></span>
        </span>
      </div>
    )
  ) : null;

  if (resumeChoice) {
    const saved = resumeChoice.stored;
    const savedProfile = PROFILE_DETAILS[saved.profileId!];
    const freshProfile = resumeChoice.fresh.profileId ? PROFILE_DETAILS[resumeChoice.fresh.profileId] : null;
    const notes = unfinishedLaunchNotes(saved);
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
            <p>{notes.summary}</p>
            {notes.download ? <p>{notes.download}</p> : null}
          </div>
          {notes.partialId ? (
            <div className={styles.blocker}>
              <AlertTriangle size={16} aria-hidden />
              <span><strong>Starting a new launch doesn&apos;t delete what was created.</strong>
                <span className={styles.blockerActions}>
                  <Link href={`/dashboard/agent/${encodeURIComponent(notes.partialId)}?tab=manage`}>Open it to delete</Link>
                </span>
              </span>
            </div>
          ) : null}
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
  // The profile always keeps its size and never uses more (its launch sends
  // no maxima): gVisor sandboxes, and the agents whose setup never did.
  const pinnedSize = currentProfile?.sizing === "pinned";
  const hasBrowser = profileHasBrowser(draft.profileId);
  const browserOn = hasBrowser && draft.browser;
  const poolExempt = isPoolExempt(draft.profileId);
  const fitSubject = draft.profileId ? launchProfileFitSubject(draft.profileId) : null;
  const hermes = draft.profileId === "hermes";
  const resourceFloor = draft.profileId ? launchResourcePolicy(draft.profileId, { browser: draft.browser }).floor : null;
  const targetCapacity = measuredTargetCapacity(destination.selectedTarget);
  const wholeProviderComputer = destination.mode === "self-managed" && isWholeProviderComputer(destination.selectedTarget);
  // A provider VM is exclusive, not a requested slice of its free memory.
  // Match the runtime headroom check; the server still re-inspects at launch.
  const requiredCapacity = wholeProviderComputer && currentProfile
    ? providerComputerResourceFloor(currentProfile.runtimeId, browserOn)
    : draft.resources;
  const selectedTargetFits = Boolean(
    destination.deployment?.mode === "self-managed"
      && targetCapacity.cpu >= requiredCapacity.cpu
      && targetCapacity.ramGb >= requiredCapacity.ram,
  );
  // Ubuntu Desktop, OpenClaw and Agent Zero need a paid plan on Hivra Cloud.
  const managedPaidRequired = fitSubject !== null && fitSubject.hivraCloud === "plan" && fitSubject.minPlan !== "free";
  const atSlotLimit = Boolean(plan?.usage && plan.usage.agentCount >= plan.maxAgents);
  const managedFits = planCanFit(plan, draft.resources, poolExempt);
  const managedPlanAllowed = !managedPaidRequired || isPaidPlan(plan);
  // Resources after a browser change, sized against the chosen destination.
  const holdsHere = (resources: LaunchDraft["resources"]) => destinationHolds(destination.mode, destination.selectedTarget, plan, resources, poolExempt);
  const resourcesWithBrowser = (browser: boolean): LaunchDraft["resources"] => {
    if (!draft.profileId || !hasBrowser) return draft.resources;
    const profileId = draft.profileId;
    const raisedFrom = draft.browserRaisedFrom;
    // Turning off a browser the owner turned on undoes the raise it made, as
    // long as the owner has not changed the size since.
    if (!browser && raisedFrom && sameResources(draft.resources, resourcesForBrowser(profileId, raisedFrom, true, plan, holdsHere))) {
      return raisedFrom;
    }
    return resourcesForBrowser(profileId, draft.resources, browser, plan, holdsHere);
  };
  const sizeWithoutBrowser = wholeProviderComputer && currentProfile
    ? providerComputerResourceFloor(currentProfile.runtimeId, false)
    : resourcesWithBrowser(false);
  const targetFitsWithoutBrowser = destination.deployment?.mode === "self-managed"
    && targetCapacity.cpu >= sizeWithoutBrowser.cpu
    && targetCapacity.ramGb >= sizeWithoutBrowser.ram;
  const capacitySetupHref = capacitySetupHrefFor(draft.profileId);
  // What one launch may use here: the plan on Hivra Cloud, the selected
  // host's measured capacity on the owner's own.
  const sizeLimits = destinationSizeLimits(destination.mode, destination.selectedTarget, plan);
  const reservedCpuLimit = sizeLimits.reservedCpu;
  const reservedRamLimit = sizeLimits.reservedRam;
  const maximumCpuLimit = sizeLimits.maximumCpu;
  const maximumRamLimit = sizeLimits.maximumRam;
  const substrate = launchSubstrate(destination.mode, destination.selectedTarget);
  // Small / Medium / Large as they run here: a preset whose reservation fits
  // stays available with its maximum brought down to what each one may reach.
  const presetOptions = draft.profileId && currentProfile
    ? fitSizePresets(sizePresets(draft.profileId, { browser: browserOn }), sizeLimits, currentProfile)
    : [];
  const currentPreset = matchingSizePreset(draft.resources, presetOptions);
  const currentSizeLabel = sizeLabel(draft.resources, presetOptions);
  const currentFittedPreset = presetOptions.find(preset => preset.id === currentPreset?.id) ?? null;
  const sizeFitsHere = sizeWithinLimits(draft.resources, sizeLimits);
  // Offered in a size blocker: one click to a preset that runs here.
  const fittingPreset = !sizeFitsHere && !wholeProviderComputer ? fittingPresetFor(presetOptions, draft.resources) : null;
  const nameProblem = draft.profileId ? launchNameProblem(draft.profileId, draft.name) : null;
  // The plan an upgrade blocker offers: the cheapest one this launch can go
  // ahead on afterwards. Hivra's own size is fitted again to the new plan, so
  // it offers the plan the Choose badge named; the owner's size is kept.
  const upgradeSize = upgradeRequestSize(draft.resources);
  const upgrade = currentProfile && plan?.usage ? cheapestPlanForSize({
    ...upgradeSize,
    // Browser automation is never part of a Free plan on Hivra Cloud.
    minPlan: browserOn ? "pro" : fitSubject?.minPlan ?? "free",
    poolExempt,
  }, plan) : null;
  const upgradeHref = `/dashboard/billing?from=launch&returnTo=${encodeURIComponent(launchReturnPath(draft.launchRequestId))}`;

  let capacityBlocker: string | null = null;
  // The real next steps a managed blocker can offer.
  let blockerRemedy: "check-plan" | "managed-plan" | "activate-free" | "settle-plan" | null = null;
  // Which paywall a managed-plan blocker is, for the upgrade funnel.
  let paywall: "paid_profile" | "agent_limit" | "capacity" | "browser" | null = null;
  let offerBrowserOff = false;
  // A size blocker can offer the preset that runs here instead.
  let offerFittingPreset = false;
  const selectedWindowsImage = windowsImages.find(image => image.volume === draft.windowsIsoVolume
    && image.sizeBytes === draft.windowsIsoEvidence?.sizeBytes
    && image.modifiedAtSeconds === draft.windowsIsoEvidence?.modifiedAtSeconds
    && image.fileIdentitySha256 === draft.windowsIsoEvidence?.fileIdentitySha256
    && image.source === draft.windowsIsoSource);
  if (digitalOceanLane) {
    // A DigitalOcean sandbox needs neither a Hivra plan nor a host: only a
    // ready team that runs this agent, and DigitalOcean not blocking it.
    capacityBlocker = !digitalOceanHarness
      ? `${currentProfile?.name ?? "This launch"} can't run on DigitalOcean. Choose where it runs again.`
      : digitalOceanTeams.state === "loading"
        ? "Checking your DigitalOcean team…"
        : !digitalOceanTarget
          ? `That DigitalOcean team isn't ready for ${currentProfile?.name ?? "this agent"}. Choose where it runs again.`
          : digitalOceanBalanceProblem(digitalOceanBalance.balance);
  }
  else if (destination.loading) capacityBlocker = "Checking compatible capacity…";
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
    offerBrowserOff = browserOn && targetFitsWithoutBrowser;
    offerFittingPreset = true;
  }
  else if (destination.mode === "hivra-managed" && managedEntitlementRequired) capacityBlocker = "Hivra Cloud isn't available for Windows. Choose a server you connected.";
  else if (draft.profileId === "windows" && windowsImagesLoading) capacityBlocker = "Checking the Windows ISOs on this server…";
  else if (draft.profileId === "windows" && windowsImagesError) capacityBlocker = windowsImagesError;
  else if (draft.profileId === "windows" && windowsImages.length === 0) capacityBlocker = "Choose an ISO already on this host, or download one directly from Microsoft to this host.";
  else if (draft.profileId === "windows" && !draft.windowsIsoVolume) capacityBlocker = "Choose the Windows ISO to attach.";
  else if (draft.profileId === "windows" && (!draft.windowsIsoEvidence || !selectedWindowsImage)) capacityBlocker = "Refresh and choose the exact host-observed Windows ISO again.";
  else if (draft.profileId === "windows" && !draft.windowsRightsAttested) capacityBlocker = "Confirm your Windows installation and use rights before review.";
  else if (destination.mode === "hivra-managed" && !preparedCanaryProfile && !planChecked) capacityBlocker = "Checking your managed plan…";
  else if (destination.mode === "hivra-managed" && !preparedCanaryProfile && planHold) {
    // Nothing else can open Hivra Cloud until the plan is settled: not Free,
    // not a smaller size, not turning the browser off.
    capacityBlocker = planHoldMessage(planHold, currentProfile?.name ?? null);
    blockerRemedy = "settle-plan";
  }
  else if (destination.mode === "hivra-managed" && !preparedCanaryProfile && !plan?.usage) {
    capacityBlocker = "Managed capacity could not be verified.";
    blockerRemedy = "check-plan";
  } else if (destination.mode === "hivra-managed" && !managedPlanAllowed) {
    capacityBlocker = `${currentProfile?.name ?? "This launch"} needs a paid plan on Hivra Cloud, or a server you connected.`;
    blockerRemedy = "managed-plan";
    paywall = "paid_profile";
  } else if (destination.mode === "hivra-managed" && !preparedCanaryProfile && atSlotLimit) {
    // An account without a plan yet is told what Free would hold, from what
    // it already runs there, instead of about a plan it doesn't have.
    capacityBlocker = plan?.needsActivation && plan.usage
      ? `The Free plan runs ${plan.maxAgents === 1 ? "one agent or computer" : `${plan.maxAgents} agents or computers`} on Hivra Cloud, and your account already has ${plan.usage.agentCount} there.`
      : "Your current plan has no open agent slots.";
    blockerRemedy = "managed-plan";
    paywall = "agent_limit";
  } else if (destination.mode === "hivra-managed" && !preparedCanaryProfile && !managedFits && plan?.usage) {
    capacityBlocker = managedCapacityShortfall(
      browserOn ? `${currentProfile?.name ?? "This launch"} with a browser` : currentProfile?.name ?? "This launch",
      draft.resourceKind ?? "agent",
      draft.resources,
      { ...plan, usage: plan.usage },
    );
    blockerRemedy = "managed-plan";
    paywall = "capacity";
    offerBrowserOff = browserOn && planCanFit(plan, resourcesWithBrowser(false), poolExempt);
    offerFittingPreset = true;
  } else if (destination.mode === "hivra-managed" && browserOn && !isPaidPlan(plan)) {
    capacityBlocker = `${currentProfile?.name ?? "This agent"} with a browser needs a paid plan on Hivra Cloud.`;
    blockerRemedy = "managed-plan";
    paywall = "browser";
    offerBrowserOff = true;
  } else if (destination.mode === "hivra-managed" && !preparedCanaryProfile && plan?.needsActivation) {
    // It fits Free. Free is turned on by the owner, with its own button.
    capacityBlocker = `Turn on the Free plan to run ${currentProfile?.name ?? "it"} on Hivra Cloud. Free includes ${formatLaunchSize(plan.maxCpuPerAgent, plan.maxRamPerAgent)} for one ${draft.resourceKind ?? "agent"} and costs nothing.`;
    blockerRemedy = "activate-free";
  }
  const recordUpgradeClick = (via: "plan_blocker" | "free_activation") => {
    captureLaunchEvent("upgrade_clicked", {
      ...launchEventContext(draft),
      via,
      paywall,
      from_plan: plan?.needsActivation ? null : plan?.key ?? null,
      to_plan: upgrade?.key ?? null,
    });
  };
  // The upgrade funnel's paywall moments, recorded once per launch when the
  // blocker is first on screen. A Free account out of agent slots is also
  // the free-limit moment the welcome flow reported.
  const paywallMoments = paywall && draft.stage === "plan" && !destination.loading ? (
    <>
      <FunnelMoment
        momentKey={`paywall:${draft.launchRequestId}:${paywall}`}
        event="paywall_viewed"
        properties={{ ...launchEventContext(draft), paywall, from_plan: plan?.needsActivation ? null : plan?.key ?? null, to_plan: upgrade?.key ?? null }}
      />
      {paywall === "agent_limit" && !isPaidPlan(plan) ? (
        <FunnelMoment
          momentKey={`free_limit:${draft.launchRequestId}`}
          event="free_limit_hit"
          properties={{ ...launchEventContext(draft), limit_type: "agents", from_plan: "free", to_plan: upgrade?.key ?? null }}
        />
      ) : null}
    </>
  ) : null;

  // ── Model access ──
  // Codex on the owner's server takes a model key only when that server said
  // it can hold one safely.
  const modelSettingsSupported = destination.mode !== "self-managed"
    || targetSupportsLaunchModelSettings(destination.selectedTarget, currentProfile?.runtimeId);
  const modelAccessShown = hasModelAccess(draft.profileId);
  const modelOptions = draft.profileId && modelAccessShown ? modelAccessOptions(draft.profileId, {
    selfHosted,
    providerComputer: wholeProviderComputer,
    selfManaged: destination.mode === "self-managed",
    modelSettingsSupported,
    balance: creditsBalance,
  }) : [];
  // Hermes' default waits for the balance: it starts on credits only when
  // there are some.
  const modelDefaultPending = Boolean(draft.profileId && modelAccessShown
    && draft.modelAccess.source === "recommended"
    && recommendedModelAccessMode(draft.profileId, creditsBalance, selfHosted) === null);
  const modelProblem = digitalOceanLane
    ? digitalOceanHarness ? digitalOceanModelProblem(digitalOceanHarness, draft.digitalOcean, currentPastedKey) : null
    : !draft.profileId || !modelAccessShown
    ? null
    : modelDefaultPending || (draft.modelAccess.mode === "credits" && creditsBalance.state === "loading")
      ? "Checking your Hivra credits…"
      : modelAccessProblem(draft.profileId, draft.modelAccess, {
        name: draft.name,
        pastedKey: currentPastedKey,
        savedKeys,
        options: modelOptions,
      });
  const keyProviders = draft.profileId ? apiKeyProviders(draft.profileId, savedKeys) : [];
  const modelSummary = digitalOceanLane && digitalOceanHarness
    ? effectiveDigitalOceanModelMode(digitalOceanHarness, draft.digitalOcean) === "vendor"
      ? `Your ${digitalOceanVendorKey(digitalOceanHarness)}, sent to DigitalOcean for this sandbox`
      : `DigitalOcean Inference · ${draft.digitalOcean.model || "no model chosen"}, billed to your team`
    : draft.profileId
    ? modelAccessSummary(draft.profileId, draft.modelAccess, { name: draft.name, balance: creditsBalance, savedKeys })
    : null;
  // Hermes' memory can use the owner's saved Honcho key. Like a model key, it
  // is sent to the agent's computer only when the owner ticks it for this
  // launch; Review says so.
  const hermesMemoryKey = hermes ? savedMemoryKey(savedKeys) : null;
  const resumeMode = launchResumeModeFor(draft);
  // A resend that needs the pasted key again (it isn't kept across a reload).
  const resendNeedsKey = draft.launchState === "uncertain" && resumeMode === "resend"
    && draft.modelAccess.mode === "api-key" && draft.modelAccess.keySource === "paste" && !currentPastedKey.trim();

  const updateDraft = (change: Partial<LaunchDraft>) => setDraft(current => current ? { ...current, ...change } : current);
  const updateModelAccess = (change: Partial<LaunchModelAccess>) => setDraft(current => current
    ? { ...current, modelAccess: { ...current.modelAccess, ...change, source: "custom" } }
    : current);
  const chooseBrowser = (browser: boolean) => {
    const resources = resourcesWithBrowser(browser);
    const raised = browser && draft.resources.source === "custom" && !sameResources(resources, draft.resources);
    updateDraft({
      browser,
      browserSource: "custom",
      resources,
      browserRaisedFrom: raised ? draft.resources : null,
    });
  };
  // A forward step's own history entry. While a Back pop is in flight, that
  // pop pushes it when it lands instead: pushing mid-traversal would race it.
  const pushStage = (stage: HistoryStage) => {
    shownStageRef.current = stage;
    if (!ownBackPendingRef.current) writeStageHistory(stage, "push");
  };
  const chooseProfile = (profileId: LaunchProfileId) => {
    pushStage("plan");
    // The same choice again keeps its draft: name, size, place and request.
    if (draft.profileId === profileId) {
      updateDraft({ stage: "plan" });
      return;
    }
    const details = PROFILE_DETAILS[profileId];
    const fresh = createLaunchDraft();
    // Hermes runs on Hivra Cloud only, whatever the last profile used.
    const mode = details.lane === "hermes-instance" ? "hivra-managed" as const : destination.mode;
    const browser = profileHasBrowser(profileId)
      && (recommendedBrowser(profileId, mode, destination.selectedTarget, plan) ?? false);
    const name = defaultLaunchName(profileId, existingNames ?? []);
    autoNameRef.current = existingNames ? null : { launchRequestId: fresh.launchRequestId, name };
    setWhereExpanded(false);
    setCustomizeOpen(false);
    // A DigitalOcean team stays chosen across agents it runs, and the team a
    // DigitalOcean card handed over is chosen for the first one.
    const keptTeam = digitalOceanTeamFor(profileId, draft.capacity.mode === "digitalocean"
      ? draft.capacity.targetId : handoff?.targetId ?? null);
    setDraft({
      ...fresh,
      capacity: keptTeam ? { mode: "digitalocean", targetId: keptTeam.id }
        : details.lane === "hermes-instance" ? { mode: "hivra-managed", targetId: null } : freshDraftCapacity(destination.choice),
      digitalOcean: keptTeam ? draft.digitalOcean : fresh.digitalOcean,
      stage: "plan",
      resourceKind: details.resourceKind,
      profileId,
      name,
      browser,
      browserSource: "recommended",
      resources: profileHasBrowser(profileId)
        ? recommendedForPlan(profileId, plan, browser)
        : recommendedHere(profileId, mode, destination.selectedTarget, plan),
      modelAccess: {
        ...freshModelAccess(),
        mode: recommendedModelAccessMode(profileId, creditsBalance, selfHosted) ?? "native",
      },
      windowsIsoVolume: null,
      windowsIsoEvidence: null,
      windowsIsoSource: "unknown",
      windowsIsoDownload: null,
      windowsRightsAttested: false,
    });
    setRestoredDestinationFor(null);
  };
  const chooseDigitalOcean = (targetId: string) => {
    setWindowsDownloadTask(null);
    updateDraft({ capacity: { mode: "digitalocean", targetId } });
  };
  const updateDigitalOcean = (change: Partial<LaunchDraft["digitalOcean"]>) => {
    updateDraft({ digitalOcean: { ...draft.digitalOcean, ...change } });
  };
  const refreshPlaces = () => {
    destination.refresh();
    listManagedSessions()
      .then(result => setDigitalOceanTeams({ state: "ready", targets: result.targets }))
      .catch(() => undefined);
  };
  // A place the owner made ready in the capacity sheet is chosen for this
  // launch: a DigitalOcean team as itself, anything else as a server.
  const chooseCapacityTarget = async (targetId: string) => {
    setCapacitySheetOpen(false);
    setWhereExpanded(true);
    let teams = digitalOceanTeams.targets;
    try {
      teams = (await listManagedSessions()).targets;
      setDigitalOceanTeams({ state: "ready", targets: teams });
    } catch { /* keep the teams already read */ }
    if (teams.some(team => team.id === targetId)) chooseDigitalOcean(targetId);
    else chooseTarget(targetId);
    destination.refresh();
  };
  const closeCapacitySheet = () => {
    setCapacitySheetOpen(false);
    refreshPlaces();
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
    pushStage(stage);
    updateDraft({ ...change, stage });
  };
  const goBack = () => {
    const previous = stepBack(draft.stage);
    updateDraft({ stage: previous, launchState: "idle", result: keptResult(draft), error: null });
    shownStageRef.current = previous;
    // A Back pop still in flight catches the history up when it lands.
    if (ownBackPendingRef.current) return;
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
      submittedAt: null,
      result: null,
      error: null,
      errorAction: null,
    });
  };

  const accept = (
    submitted: LaunchDraft,
    created: { id: string; name: string; status: string },
    outcome: "accepted" | "found_on_check",
  ) => {
    const context = {
      ...launchEventContext(submitted),
      deploymentMode: submitted.submittedDeployment?.mode ?? null,
    };
    captureLaunchEvent("launch_request_accepted", { ...context, agentId: created.id, acceptedStatus: created.status, outcome });
    // Hivra agents and computers report readiness from the server once they
    // answer. Hermes' instance lane has no such report, so its funnel step is
    // recorded here, when Hivra accepts the launch, as the welcome flow did.
    if (submitted.profileId === "hermes") {
      captureLaunchEvent("activation_instance_ready", {
        ...context,
        hasInstanceId: true,
        outcome: outcome === "accepted" ? "created_instance" : "recovered_existing_instance",
      });
    }
    const accepted = {
      ...submitted,
      stage: "launch" as const,
      launchState: "accepted" as const,
      result: { id: created.id, name: created.name, status: created.status },
      error: null,
      errorAction: null,
    };
    writeLaunchDraft(accepted, storageOwner);
    setDraft(accepted);
    // The launch has the key now; the page lets go of it.
    setPastedKey(null);
  };

  // What a launch that didn't go ahead tells the first-run funnel, in the
  // fields the welcome flow sent (stage, failureType, errorCategory,
  // errorMessage, recoverable). A lost answer is not a failure: nothing is
  // known yet, so it is reported as uncertain.
  const recordLaunchFailure = (submitting: LaunchDraft, context: Record<string, unknown>, error: unknown) => {
    const stage = launchFailureStage(submitting);
    if (error instanceof LaunchCorrectableError && error.action?.kind === "verify-card") {
      captureLaunchEvent("activation_card_required", context);
      captureLaunchEvent("paywall_viewed", { ...context, paywall: "card_required" });
      return;
    }
    if (error instanceof HivraLaunchCorrectableError) {
      if (error.code === "FREE_INSTANCE_LIMIT_REACHED") {
        const existing = error instanceof LaunchCorrectableError && error.action?.kind === "open" ? error.action.href : null;
        captureLaunchEvent("free_limit_hit", {
          ...context,
          limit_type: "agents",
          from_plan: "free",
          to_plan: "operator",
          has_existing_instance: Boolean(existing),
        });
      }
      captureLaunchEvent("activation_failed", {
        ...context,
        stage,
        failureType: error.code ?? "launch_needs_change",
        errorCategory: "needs_change",
        errorMessage: launchErrorMessage(error, [submitting.name]),
        status: error.status,
        recoverable: true,
      });
      return;
    }
    if (error instanceof HivraLaunchRejectedError) {
      captureLaunchEvent("activation_failed", {
        ...context,
        stage,
        failureType: "launch_rejected",
        errorCategory: "rejected",
        errorMessage: launchErrorMessage(error, [submitting.name]),
        status: error.status,
        serverFailureType: error.code ?? null,
        recoverable: true,
      });
      return;
    }
    captureLaunchEvent("launch_outcome_uncertain", {
      ...context,
      stage,
      errorMessage: launchErrorMessage(error, [submitting.name]),
      resumeMode: submitting.profileId ? launchResumeModeFor(submitting) : null,
    });
  };

  const submit = async () => {
    const resumingUncertain = draft.launchState === "uncertain";
    const submissionDeployment = resumingUncertain
      ? draft.submittedDeployment
      : digitalOceanLane
        ? digitalOceanTarget ? { mode: "digitalocean" as const, connectionId: digitalOceanTarget.connectionId, targetId: digitalOceanTarget.id } : null
        : destination.deployment;
    if (
      !submissionDeployment
      || !draft.profileId
      || (!resumingUncertain && (capacityBlocker || modelProblem))
      || draft.launchState === "submitting"
    ) return;
    const submitting = {
      ...draft,
      stage: "launch" as const,
      launchState: "submitting" as const,
      submittedDeployment: submissionDeployment,
      // A resumed launch keeps the moment its first request was sent.
      submittedAt: resumingUncertain && draft.submittedAt ? draft.submittedAt : new Date().toISOString(),
      result: null,
      error: null,
      errorAction: null,
    };
    writeLaunchDraft(submitting, storageOwner);
    setDraft(submitting);
    setObservation(null);
    setReconcileNote(null);
    const eventContext = { ...launchEventContext(submitting), deploymentMode: submissionDeployment.mode };
    captureLaunchEvent("activation_instance_requested", { ...eventContext, resumed: resumingUncertain });
    // A pasted key the owner saved is referred to from then on, so a resumed
    // or corrected launch never needs it typed again.
    let savedKeyId: string | null = null;
    const withSavedKey = <T extends LaunchDraft>(next: T): T => savedKeyId
      ? { ...next, modelAccess: { ...next.modelAccess, keySource: "saved", vaultKeyId: savedKeyId, sendSavedKey: true } }
      : next;
    try {
      const created = await submitLaunchDraft(submitting, submissionDeployment, {
        apiKey: currentPastedKey,
        savedKeys,
        balance: creditsBalance,
        onObserved: setObservation,
        digitalOceanTarget,
        selfManagedTarget: destination.selectedTarget,
        onKeySaved: (vaultKeyId, saved) => {
          savedKeyId = vaultKeyId;
          setSavedKeys(keys => [...keys.filter(key => key.provider !== saved.provider), saved]);
        },
      });
      accept(withSavedKey(submitting), created, "accepted");
    } catch (error) {
      recordLaunchFailure(submitting, eventContext, error);
      if (error instanceof HivraLaunchRejectedError) {
        const failed = withSavedKey({ ...submitting, launchState: "failed" as const, error: error.message });
        writeLaunchDraft(failed, storageOwner);
        setDraft(failed);
      } else if (error instanceof HivraLaunchCorrectableError) {
        const correctable = withSavedKey({
          ...submitting,
          stage: "review" as const,
          launchState: "idle" as const,
          submittedDeployment: null,
          submittedAt: null,
          result: error.computerId ? { id: error.computerId, name: submitting.name, status: "error" } : null,
          error: error.message,
          errorAction: error instanceof LaunchCorrectableError ? error.action : null,
        });
        writeLaunchDraft(correctable, storageOwner);
        setDraft(correctable);
        if (correctable.errorAction?.kind === "verify-card") setCardCheckOpen(true);
      } else {
        const uncertain = withSavedKey({
          ...submitting,
          launchState: "uncertain" as const,
          error: error instanceof Error ? error.message : "The launch acknowledgement was lost.",
        });
        writeLaunchDraft(uncertain, storageOwner);
        setDraft(uncertain);
      }
    }
  };

  // A launch whose lane takes no receipt is only ever looked for again,
  // never resent: that can't start a second computer.
  const checkAgain = async () => {
    if (reconciling || draft.launchState !== "uncertain") return;
    setReconciling(true);
    setReconcileNote(null);
    try {
      const found = await reconcileLaunchDraft(draft);
      if (found) accept(draft, found, "found_on_check");
      else setReconcileNote(`Hivra can't see ${draft.name.trim()} yet. If you launched it a while ago and it still isn't here, start a new launch.`);
    } catch (error) {
      if (error instanceof HivraLaunchCorrectableError) {
        const correctable = {
          ...draft,
          stage: "review" as const,
          launchState: "idle" as const,
          submittedDeployment: null,
          submittedAt: null,
          result: error.computerId ? { id: error.computerId, name: draft.name, status: "error" } : null,
          error: error.message,
          errorAction: null,
        };
        writeLaunchDraft(correctable, storageOwner);
        setDraft(correctable);
      } else {
        setReconcileNote("Hivra couldn't check right now. Nothing new was started; try again in a moment.");
      }
    } finally {
      setReconciling(false);
    }
  };

  const presetOffer = offerFittingPreset ? fittingPreset : null;
  const blockerActions = offerBrowserOff || presetOffer || destination.mode === "self-managed" || blockerRemedy ? (
    <span className={styles.blockerActions}>
      {presetOffer ? (
        <button type="button" onClick={() => choosePreset(presetOffer)}>
          Use {presetOffer.label} ({formatLaunchSize(presetOffer.resources.cpu, presetOffer.resources.ram)})
        </button>
      ) : null}
      {offerBrowserOff ? <button type="button" onClick={() => chooseBrowser(false)}>Turn off the browser</button> : null}
      {destination.mode === "self-managed" ? <button type="button" onClick={() => setCapacitySheetOpen(true)}>Set up capacity</button>
        : blockerRemedy === "check-plan" ? <button type="button" onClick={recheckPlan}>Check again</button>
        : blockerRemedy === "managed-plan" ? <>
          <Link href={upgradeHref} onClick={() => recordUpgradeClick("plan_blocker")}>{upgrade ? `Upgrade to ${upgrade.name}` : "Review plans"}</Link>
          <button type="button" onClick={() => setCapacitySheetOpen(true)}>Set up your own capacity</button>
        </> : blockerRemedy === "activate-free" ? <>
          <button type="button" onClick={() => void activateFree()} disabled={freeActivation.state === "activating"}>
            {freeActivation.state === "activating" ? "Turning on Free…" : "Turn on Free"}
          </button>
          <Link href={upgradeHref} onClick={() => recordUpgradeClick("free_activation")}>See paid plans</Link>
          <button type="button" onClick={() => setCapacitySheetOpen(true)}>Set up your own capacity</button>
        </> : blockerRemedy === "settle-plan" && planHold ? <>
          <Link href={billingSettleHref(draft.launchRequestId)}>{planHoldAction(planHold)}</Link>
          <button type="button" onClick={() => setCapacitySheetOpen(true)}>Set up your own capacity</button>
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
    targetsError: Boolean(destination.error),
    selfHosted,
  };
  const renderTile = (tile: ChooseTile) => {
    const fit = launchFit(launchProfileFitSubject(tile.id), fitEvidence);
    const Icon = tile.icon;
    return (
      <button
        key={tile.id}
        type="button"
        className={styles.tile}
        data-selected={draft.profileId === tile.id}
        onClick={() => chooseProfile(tile.id)}
      >
        {Icon ? <Icon size={22} aria-hidden /> : <span className={styles.letterIcon} aria-hidden>O.</span>}
        <span className={styles.tileText}>
          <strong>{tile.name}</strong>
          <small>{tile.description}</small>
        </span>
        <FitBadge fit={fit} />
      </button>
    );
  };
  // A self-hosted installation has no Hivra Cloud, so an agent that runs only
  // there isn't offered.
  const agentTiles = AGENT_TILES.filter(tile => !selfHosted || PROFILE_DETAILS[tile.id].ownServer);
  const agentSection = (
    <section key="agents" className={styles.chooseSection} aria-labelledby="launch-agents-heading">
      <div className={styles.chooseHeading}>
        <h2 id="launch-agents-heading">An agent</h2>
        <p>An AI that works on its own computer.</p>
      </div>
      <div className={styles.tileGrid}>{agentTiles.map(renderTile)}</div>
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
    || (digitalOceanLane && !digitalOceanTarget && digitalOceanTeams.state !== "loading")
    || (destination.mode === "self-managed" && !destination.loading && !destination.selectedTarget)
    || (destination.mode === "self-managed" && Boolean(destination.error));
  const whereOpen = whereForcedOpen || whereExpanded;
  const whereTitle = digitalOceanLane
    ? digitalOceanTarget ? `DigitalOcean · ${digitalOceanTarget.displayName}` : "DigitalOcean team unavailable"
    : destination.mode === "hivra-managed" && !selfHosted
    ? "Hivra Cloud"
    : destination.selectedTarget?.displayName
      ?? (destination.loading ? "Checking your servers…" : "No server selected");
  const whereDetail = digitalOceanLane
    ? "A sandbox on your own DigitalOcean team. DigitalOcean bills it."
    : destination.mode === "hivra-managed" && !selfHosted
    ? planHold?.reason === "unconfirmed" ? "Paid plan · not active"
      : plan?.onHold ? `${plan.onHold.name} plan · on hold`
        : plan ? plan.needsActivation ? `${plan.name} plan · not turned on yet` : `${plan.name} plan` : null
    : destination.selectedTarget ? (selfHosted ? selfHostedTargetLabel : ownCapacityLabel(substrate)) : null;
  const sizeSummary = currentProfile?.sizing === "fixed"
    ? `${draft.resources.cpu} CPU / ${draft.resources.ram} GB · fixed size`
    : gvisorComputer
      ? `${currentSizeLabel} · ${draft.resources.cpu} CPU / ${draft.resources.ram} GB enforced limit`
      : pinnedSize
        ? `${currentSizeLabel} · ${draft.resources.cpu} CPU / ${draft.resources.ram} GB`
        : `${currentSizeLabel} · ${draft.resources.cpu} CPU / ${draft.resources.ram} GB reserved · up to ${draft.resources.maximumCpu ?? draft.resources.cpu} CPU / ${draft.resources.maximumRam ?? draft.resources.ram} GB`;
  // Why the chosen preset's maximum is lower here than elsewhere.
  const cappedNote = currentFittedPreset?.capped
    ? destination.mode === "hivra-managed" && plan
      ? `Your ${plan.name} plan lets each ${draft.resourceKind ?? "agent"} use up to ${formatLaunchSize(plan.maxCpuPerAgent, plan.maxRamPerAgent)}, so ${currentFittedPreset.label}'s maximum stops there.`
      : `This server has ${formatLaunchSize(maximumCpuLimit, maximumRamLimit)} in total, so ${currentFittedPreset.label}'s maximum stops there.`
    : null;
  const cost = draft.profileId ? costSummary({
    profileId: draft.profileId,
    substrate,
    planName: plan?.name ?? null,
    modelNote: modelCostNote(draft.profileId, draft.modelAccess),
    planPending: Boolean(plan?.needsActivation) && !planHold,
    planOnHold: planHold ? planHold.reason === "unconfirmed" ? "paid" : planHold.planName : null,
  }) : "";
  const whatItCanUse = draft.profileId ? capabilitySummary(draft.profileId, { browser: browserOn }) : "";
  const launchLabel = draft.profileId === "windows" ? "Start Windows setup"
    : digitalOceanLane ? "Launch and start billing"
    : `Launch ${currentProfile?.name ?? ""}`.trim();

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
          <button type="button" className={styles.inlineAction} onClick={() => setCapacitySheetOpen(true)}>Add capacity</button>
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
          {freeActiveNotice}
          {templateProblem ? (
            <div className={styles.blocker} role="alert">
              <AlertTriangle size={16} aria-hidden />
              <span><strong>{templateProblem.message}</strong>
                {templateProblem.status === "failed" ? (
                  <span className={styles.blockerActions}>
                    <button type="button" onClick={() => setTemplateLookupRevision(value => value + 1)}>Try again</button>
                  </span>
                ) : null}
              </span>
            </div>
          ) : null}
          {planHold ? (
            <div className={styles.blocker} role="alert">
              <AlertTriangle size={16} aria-hidden />
              <span><strong>{planHoldMessage(planHold)}</strong>
                <span className={styles.blockerActions}>
                  <Link href={billingSettleHref(draft.launchRequestId)}>{planHoldAction(planHold)}</Link>
                </span>
              </span>
            </div>
          ) : planChecked && plan?.needsActivation && !selfHosted ? (
            <div className={styles.notice} role="status">
              <Cloud size={16} aria-hidden />
              <span>{`The Free plan runs one agent or computer with ${formatLaunchSize(plan.maxCpuPerAgent, plan.maxRamPerAgent)} on Hivra Cloud at no cost. You turn it on before you launch.`}</span>
            </div>
          ) : null}
          {planChecked && !plan?.usage && !selfHosted ? (
            <div className={styles.blocker} role="alert">
              <AlertTriangle size={16} aria-hidden />
              <span><strong>We couldn&apos;t check your plan, so we can&apos;t show what fits it yet.</strong>
                <span className={styles.blockerActions}><button type="button" onClick={recheckPlan}>Check again</button></span>
              </span>
            </div>
          ) : null}
          {requestedKindParam === "computer" ? [computerSection, agentSection] : [agentSection, computerSection]}
          <p className={styles.chooseAside}>
            Saved an agent as a template? <Link href="/dashboard/templates">Start from a template</Link>
          </p>
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
          {freeActiveNotice}
          {draft.template ? (
            <div className={styles.notice} role="status">
              <Check size={16} aria-hidden />
              <span>{`Starting from the template “${draft.template.name ?? currentProfile.name}”. Its focus, personality and skills come with it.`}</span>
            </div>
          ) : null}
          <div className={styles.planCard} role="group" aria-label="Launch plan">
            <label className={`${styles.planRow} ${styles.nameField}`}>
              <span className={styles.planLabel}>{draft.resourceKind === "computer" ? "Computer name" : "Agent name"}</span>
              <span className={styles.planValue}>
                <input
                  aria-label={draft.resourceKind === "computer" ? "Computer name" : "Agent name"}
                  aria-invalid={nameProblem ? true : undefined}
                  aria-describedby="launch-name-hint"
                  value={draft.name}
                  maxLength={hermes ? HERMES_NAME_MAX_LENGTH : LAUNCH_NAME_MAX_LENGTH}
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
                  ownServerSupported={currentProfile.lane !== "hermes-instance"}
                  runtimeName={currentProfile.name}
                  resourceLabel={draft.resourceKind ?? "agent"}
                  capacitySetupHref={capacitySetupHref}
                  onSetUpCapacity={() => setCapacitySheetOpen(true)}
                  otherSelected={digitalOceanLane}
                  otherOptions={digitalOceanChoices.map(team => (
                    <DestinationOption
                      key={team.id}
                      selected={digitalOceanLane && digitalOceanTarget?.id === team.id}
                      onClick={() => chooseDigitalOcean(team.id)}
                      icon={<Droplet size={16} aria-hidden="true" />}
                      title={`DigitalOcean · ${team.displayName}`}
                      detail="A sandbox on your own DigitalOcean team. DigitalOcean bills it per second."
                    />
                  ))}
                />
              </div>
            ) : null}

            {digitalOceanLane ? (digitalOceanTarget && digitalOceanHarness ? (
              <DigitalOceanLaunchPlan
                target={digitalOceanTarget}
                harness={digitalOceanHarness}
                agentName={draft.name}
                choice={draft.digitalOcean}
                onChange={updateDigitalOcean}
                pastedKey={currentPastedKey}
                onPastedKeyChange={setCurrentPastedKey}
                problem={modelProblem}
                balance={digitalOceanBalance}
              />
            ) : null) : (<>
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
                        const fits = preset.fits;
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
                    {cappedNote ? <small>{cappedNote}</small> : null}
                    <small>{gvisorComputer
                      ? "The sandbox always keeps its full CPU and memory, and never uses more."
                      : pinnedSize
                        ? `${currentProfile.name} always keeps this CPU and memory, and never uses more.`
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
                      <button key={cpu} type="button" disabled={cpu > reservedCpuLimit} aria-pressed={draft.resources.cpu === cpu} onClick={() => updateDraft({ resources: { ...draft.resources, cpu, maximumCpu: pinnedSize ? cpu : Math.max(cpu, draft.resources.maximumCpu ?? draft.resources.cpu), source: "custom" } })}>{cpu} CPU</button>
                    ))}</div>
                  </fieldset>
                  {!pinnedSize ? <fieldset aria-label="Maximum CPU">
                    <legend>Maximum CPU</legend>
                    <div>{currentProfile.cpuOptions.filter(cpu => cpu >= draft.resources.cpu).map(cpu => (
                      <button key={cpu} type="button" disabled={cpu > maximumCpuLimit} aria-pressed={(draft.resources.maximumCpu ?? draft.resources.cpu) === cpu} onClick={() => updateDraft({ resources: { ...draft.resources, maximumCpu: cpu, source: "custom" } })}>{cpu} CPU</button>
                    ))}</div>
                  </fieldset> : null}
                  <fieldset aria-label="Reserved memory">
                    <legend>Reserved memory</legend>
                    <div>{currentProfile.ramOptions.filter(ram => ram >= (resourceFloor?.ram ?? 0)).map(ram => (
                      <button key={ram} type="button" disabled={ram > reservedRamLimit} aria-pressed={draft.resources.ram === ram} onClick={() => updateDraft({ resources: { ...draft.resources, ram, maximumRam: pinnedSize ? ram : Math.max(ram, draft.resources.maximumRam ?? draft.resources.ram), source: "custom" } })}>{ram} GB</button>
                    ))}</div>
                  </fieldset>
                  {!pinnedSize ? <fieldset aria-label="Maximum memory">
                    <legend>Maximum memory</legend>
                    <div>{currentProfile.ramOptions.filter(ram => ram >= draft.resources.ram).map(ram => (
                      <button key={ram} type="button" disabled={ram > maximumRamLimit} aria-pressed={(draft.resources.maximumRam ?? draft.resources.ram) === ram} onClick={() => updateDraft({ resources: { ...draft.resources, maximumRam: ram, source: "custom" } })}>{ram} GB</button>
                    ))}</div>
                  </fieldset> : null}
                </div>
              </div>
            ) : null}

            {hasBrowser && draft.profileId ? (
              <label className={`${styles.planRow} ${styles.browserToggle}`}>
                <span className={styles.planLabel}>Browser</span>
                <span className={styles.planValue}>
                  <span className={styles.browserChoice}>
                    <input type="checkbox" checked={draft.browser} onChange={event => chooseBrowser(event.target.checked)} />
                    <span>
                      <strong>Browser for {currentProfile.name}</strong>
                      <small>
                        {browserCopy(draft.profileId)} Needs at least {formatLaunchSize(browserFloorFor(draft.profileId).cpu, browserFloorFor(draft.profileId).ram)} with
                        the browser, or {formatLaunchSize(baseFloorFor(draft.profileId).cpu, baseFloorFor(draft.profileId).ram)} without it.
                        {destination.mode === "hivra-managed" && plan && !isPaidPlan(plan) ? " On Hivra Cloud, the browser needs a paid plan." : null}
                      </small>
                    </span>
                  </span>
                </span>
              </label>
            ) : null}

            {modelAccessShown && draft.profileId ? (
              <div className={styles.planRow}>
                <span className={styles.planLabel} aria-hidden>Model access</span>
                <span className={styles.planValue}>
                  <ModelAccessControl
                    profileId={draft.profileId}
                    agentName={draft.name}
                    access={draft.modelAccess}
                    options={modelOptions}
                    onChange={updateModelAccess}
                    pastedKey={currentPastedKey}
                    onPastedKeyChange={setCurrentPastedKey}
                    savedKeys={savedKeys}
                    providers={keyProviders}
                    balance={creditsBalance}
                    onAddCredit={() => setDepositOpen(true)}
                    problem={modelProblem}
                  />
                </span>
              </div>
            ) : null}
            {hermesMemoryKey ? (
              <label className={`${styles.planRow} ${styles.browserToggle}`}>
                <span className={styles.planLabel}>Memory</span>
                <span className={styles.planValue}>
                  <span className={styles.browserChoice}>
                    <input
                      type="checkbox"
                      checked={draft.sendMemoryKey}
                      onChange={event => updateDraft({ sendMemoryKey: event.target.checked })}
                    />
                    <span>
                      <strong>Send my saved Honcho key {savedKeyHint(hermesMemoryKey)} to {draft.name.trim() || "Hermes"}&apos;s computer</strong>
                      <small>It gives Hermes long-term memory in your Honcho account, for this launch only. Leave it off to launch without it.</small>
                    </span>
                  </span>
                </span>
              </label>
            ) : null}
            <div className={styles.planRow}>
              <span className={styles.planLabel}>Cost</span>
              <span className={styles.planValue}><span className={styles.planSummary}><strong>{cost}</strong></span></span>
            </div>
            <div className={styles.planRow}>
              <span className={styles.planLabel}>What it can use</span>
              <span className={styles.planValue}><span className={styles.planSummary}><strong>{whatItCanUse}</strong></span></span>
            </div>
            </>)}
          </div>
          {capacityBlocker ? (
            <div className={styles.blocker} role={destination.loading || !planChecked ? "status" : "alert"}>
              <AlertTriangle size={16} aria-hidden />
              <span><strong>{capacityBlocker}</strong>{blockerActions}</span>
              {paywallMoments}
            </div>
          ) : null}
          {freeActivation.state === "failed" && plan?.needsActivation ? (
            <div className={styles.blocker} role="alert">
              <AlertTriangle size={16} aria-hidden />
              <span><strong>{freeActivation.message}</strong></span>
            </div>
          ) : null}
          {footer(primary("Review launch", () => advanceTo("review", {
            // A DigitalOcean team is its own choice; the host destination only
            // speaks for Hivra Cloud and the owner's servers.
            capacity: digitalOceanLane ? draft.capacity
              : destination.mode === "hivra-managed"
                ? { mode: "hivra-managed", targetId: null }
                : { mode: "self-managed", targetId: destination.selectedTarget?.id ?? null },
          }), Boolean(capacityBlocker || nameProblem || modelProblem)))}
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
              {digitalOceanLane
                ? <>DigitalOcean · {digitalOceanTarget?.displayName ?? "team unavailable"}<small>A sandbox on your own DigitalOcean team</small></>
                : destination.mode === "hivra-managed" && !selfHosted
                ? <>Hivra Cloud<small>Private virtual machine</small></>
                : <>{destination.selectedTarget?.displayName ?? "Unavailable server"}{destination.selectedTarget
                  ? <small>{selfHosted ? selfHostedTargetLabel : ownCapacityLabel(substrate)}</small> : null}</>}
            </dd></div>
            <div><dt>Size</dt><dd>{digitalOceanLane
              ? (() => { const size = digitalOceanTarget ? digitalOceanSizeFor(digitalOceanTarget, draft.digitalOcean) : null;
                return size ? `${digitalOceanSizeLabel(size)} DigitalOcean sandbox` : "No size available"; })()
              : wholeProviderComputer
              ? "The whole server · its CPU and memory stay as they are"
              : gvisorComputer
                ? `${currentSizeLabel} · ${draft.resources.cpu} CPU / ${draft.resources.ram} GB reserved and enforced maximum`
                : sizeSummary}</dd></div>
            <div><dt>{draft.resourceKind === "agent" ? "Your agent can use" : "You can use"}</dt><dd>{digitalOceanLane
              ? "Its own DigitalOcean sandbox and /workspace. Chat and files through Hivra. No browser, desktop or terminal."
              : whatItCanUse}</dd></div>
            {draft.resourceKind === "agent" && draft.profileId ? <div><dt>You can see its work in</dt><dd>{
              // The same decision that draws the agent page's tabs and the note
              // Hivra gives the agent about its computer (ATT-15).
              agentLaunchWatchRow(digitalOceanLane
                ? { type: draft.profileId, computer_substrate: "do-managed-session", deployment_mode: "self-managed" }
                : { type: draft.profileId, computer_substrate: substrate === "provider-vm" ? "provider-vm" : "proxmox-kvm",
                  deployment_mode: destination.mode }, { browser: digitalOceanLane ? false : browserOn })}</dd></div> : null}
            {modelSummary ? <div><dt>Model</dt><dd>{modelSummary}</dd></div> : null}
            {hermesMemoryKey && draft.sendMemoryKey && !digitalOceanLane
              ? <div><dt>Memory</dt><dd>Honcho, with your saved key {savedKeyHint(hermesMemoryKey)}, sent to {draft.name.trim()}&apos;s computer</dd></div>
              : null}
            {draft.template ? <div><dt>Template</dt><dd>{draft.template.name ?? "Saved template"}<small>{digitalOceanLane
              ? "Not applied on DigitalOcean: its sandbox starts from DigitalOcean's own setup."
              : "Its focus, personality and skills are applied when it launches."}</small></dd></div> : null}
            <div><dt>Cost</dt><dd>{digitalOceanLane
              ? <>DigitalOcean bills this sandbox per second while it runs, to your team.{digitalOceanBalance.balance && digitalOceanBalance.balance.state !== "unreadable"
                ? <small>Prepaid balance {formatDigitalOceanBalance(digitalOceanBalance.balance.balance)}</small> : null}</>
              : cost}</dd></div>
            {digitalOceanLane && draft.digitalOcean.firstTask.trim()
              ? <div><dt>First task</dt><dd>{draft.digitalOcean.firstTask.trim()}<small>Sent right after Hivra&apos;s setup note.</small></dd></div>
              : null}
            <div><dt>Changes</dt><dd>{digitalOceanLane
              ? `Creates one DigitalOcean sandbox on ${digitalOceanTarget?.displayName ?? "your team"} and starts it. DigitalOcean bills from now. Hivra sends it a short setup note as the first chat message. Nothing is bought from Hivra.`
              : launchChangesSummary({
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
              {digitalOceanLane ? <>
                <div><dt>Isolation</dt><dd>DigitalOcean sandbox microVM</dd></div>
                <div><dt>Agent</dt><dd>{digitalOceanHarness ?? currentProfile.runtimeId} on DigitalOcean Managed Agents</dd></div>
                {digitalOceanTarget ? <div><dt>Team id</dt><dd>{digitalOceanTarget.id}</dd></div> : null}
              </> : <>
                <div><dt>Isolation</dt><dd>{isolationDetail(substrate)}</dd></div>
                <div><dt>Runtime</dt><dd>{currentProfile.runtimeId}{hasBrowser ? ` · browser ${draft.browser ? "on" : "off"}` : ""}</dd></div>
                {destination.mode === "self-managed" && destination.selectedTarget ? <div><dt>Server id</dt><dd>{destination.selectedTarget.id}</dd></div> : null}
              </>}
              <div><dt>Launch request</dt><dd>{draft.launchRequestId}</dd></div>
            </dl>
          </details>
          {capacityBlocker ? <div className={styles.blocker} role="alert"><AlertTriangle size={16} aria-hidden /><span><strong>{capacityBlocker}</strong>{blockerActions}</span></div> : null}
          {modelProblem && !capacityBlocker ? <div className={styles.blocker} role="status"><AlertTriangle size={16} aria-hidden /><span><strong>{modelProblem}</strong>
            <span className={styles.blockerActions}><button type="button" onClick={goBack}>Change model access</button></span>
          </span></div> : null}
          {draft.error ? <div className={styles.blocker} role="alert"><AlertTriangle size={16} aria-hidden /><span><strong>{draft.error}</strong>
            {draft.errorAction ? <span className={styles.blockerActions}>
              {draft.errorAction.kind === "verify-card"
                ? <button type="button" onClick={() => setCardCheckOpen(true)}>Add a card to continue</button>
                : <Link href={draft.errorAction.href}>{draft.errorAction.label}</Link>}
            </span> : null}
          </span></div> : null}
          {draft.result?.status === "error" ? <div className={styles.blocker}>
            <AlertTriangle size={16} aria-hidden />
            <span><strong>Part of this launch was created and can be removed.</strong>
              <Link href={`/dashboard/agent/${encodeURIComponent(draft.result.id)}?tab=manage`}>Open it to delete</Link>
            </span>
          </div> : null}
          {footer(primary(launchLabel, () => void submit(), Boolean(capacityBlocker
            || (digitalOceanLane ? !digitalOceanTarget : !destination.deployment) || nameProblem || modelProblem)))}
        </section>
      ) : null}

      {draft.stage === "launch" && currentProfile && draft.launchState === "submitting" ? (
        <section className={`${styles.stage} ${styles.outcome}`} aria-labelledby="launch-progress-heading" role="status" aria-live="polite">
          <Loader2 size={30} className={styles.spin} aria-hidden />
          <span className={styles.eyebrow}>Launch in progress</span>
          <h1 id="launch-progress-heading">Confirming your launch…</h1>
          <p>Hivra is checking the request for {draft.name.trim()}. We’ll open it as soon as the launch is confirmed.</p>
          <p className={styles.observed}>
            {observedLaunchText(observation, resumeMode === "resend")}
            {draft.submittedAt ? <> · Sent {elapsedSince(Date.parse(draft.submittedAt), now)} ago</> : null}
          </p>
        </section>
      ) : null}

      {draft.stage === "launch" && currentProfile && draft.launchState === "accepted" && draft.result && hermes && !digitalOceanLane ? (
        <HermesLaunched
          name={draft.result.name || draft.name.trim()}
          instanceId={draft.result.id}
          href={launchResultHref(draft, draft.result.id)}
          onLeave={() => clearLaunchDraft(storageOwner)}
          onStartNew={startNew}
        />
      ) : null}

      {draft.stage === "launch" && currentProfile && draft.launchState === "accepted" && draft.result && (!hermes || digitalOceanLane) ? (
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
          <h1 id="launch-uncertain-heading">{resumeMode === "observe" ? "We couldn't confirm the launch yet." : "Launch could not be confirmed."}</h1>
          <p>{resumeMode === "observe"
            ? `The request may already have reached Hivra. Check again looks for ${draft.name.trim()}; it won't start a second one.`
            : "The request may already have reached Hivra. Checking again uses the same request, so it won't start a second one."}</p>
          {draft.error ? <div className={styles.blocker} role="status"><AlertTriangle size={16} aria-hidden /><strong>{draft.error}</strong></div> : null}
          {reconcileNote ? <div className={styles.blocker} role="status"><AlertTriangle size={16} aria-hidden /><strong>{reconcileNote}</strong></div> : null}
          {resendNeedsKey ? (
            <label className={styles.resendKey}>
              <span>Paste your API key again to check this same launch. It isn&apos;t kept in this browser.</span>
              <input
                type="password"
                value={currentPastedKey}
                onChange={event => setCurrentPastedKey(event.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="done"
                data-ph-no-capture="true"
                className="ph-no-capture"
                aria-label="API key"
              />
            </label>
          ) : null}
          {resumeMode === "observe" ? (
            <button
              type="button"
              className={styles.primaryAction}
              data-testid="launch-primary-action"
              onClick={() => void checkAgain()}
              disabled={reconciling}
            >
              {reconciling ? "Checking…" : "Check again"} <ArrowRight size={15} aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              className={styles.primaryAction}
              data-testid="launch-primary-action"
              onClick={() => void submit()}
              disabled={!draft.submittedDeployment || resendNeedsKey}
            >
              Resume same launch <ArrowRight size={15} aria-hidden />
            </button>
          )}
          {!draft.submittedDeployment || (resumeMode === "observe" && reconcileNote) ? (
            <button type="button" className={styles.outcomeLink} onClick={startNew}>Start a new launch</button>
          ) : null}
          <Link className={styles.outcomeLink} href="/dashboard">Check Home</Link>
        </section>
      ) : null}

      {draft.stage === "launch" && currentProfile && draft.launchState === "failed" ? (
        <section className={`${styles.stage} ${styles.outcome}`} aria-labelledby="launch-failed-heading">
          <span className={styles.warningIcon}><AlertTriangle size={24} aria-hidden /></span>
          <span className={styles.eyebrow}>Launch stopped</span>
          <h1 id="launch-failed-heading">{resumeMode === "observe" ? "This launch didn't go through." : "Nothing new will be started from this receipt."}</h1>
          <p>{draft.error || "The launch was rejected before it could be accepted."}</p>
          <button type="button" className={styles.primaryAction} onClick={reviewFailedLaunch}>
            Review launch <ArrowRight size={15} aria-hidden />
          </button>
          <button type="button" className={styles.outcomeLink} onClick={startNew}>Start a new launch</button>
        </section>
      ) : null}

      {depositOpen ? (
        <ManagedVeniceDepositModal
          isOpen
          initialWalletType="card"
          onClose={() => setDepositOpen(false)}
          onRefreshSummary={() => setCreditsRevision(value => value + 1)}
        />
      ) : null}
      <FreeTierCardVerification
        open={cardCheckOpen}
        message={draft.errorAction?.kind === "verify-card" ? draft.error : null}
        onClose={() => setCardCheckOpen(false)}
        onVerified={async () => {
          setCardCheckOpen(false);
          await submit();
        }}
      />
      {capacitySheetOpen ? (
        <LaunchCapacitySheet
          launchResourceId={capacityResourceFor(draft.profileId)}
          onLaunchTarget={targetId => void chooseCapacityTarget(targetId)}
          onClose={closeCapacitySheet}
        />
      ) : null}
    </main>
  );
}
