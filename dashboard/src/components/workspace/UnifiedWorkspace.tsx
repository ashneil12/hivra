"use client";

import { LoadingState } from "@/components/ui/LoadingState";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { AgentComputer, AgentComputerSurface } from "@/lib/agent-computers/contracts";
import type { HivraAgent } from "@/lib/hivra/agent-api";
import { resolveResourceLanding } from "@/lib/hivra/resource-landing";
import type { UnifiedAgent } from "@/lib/hivra/unified-agent";
import type { ReleaseMetadata } from "@/lib/workspace/release-metadata";
import type {
  WorkspaceRouteState,
  WorkspaceSurface,
  WorkspaceSurfaceDescriptor,
} from "@/lib/workspace/workspace-contracts";
import {
  parseWorkspaceRoute,
  serializeWorkspaceRoute,
} from "@/lib/workspace/workspace-route-state";
import {
  clearWorkspaceSelection,
  persistWorkspaceSelection,
  restoreWorkspaceSelection,
  type WorkspaceSelection,
} from "@/lib/workspace/workspace-persistence";

import { AgentSwitcherMenu } from "./AgentSwitcherMenu";
import { CanaryTestGuide } from "./CanaryTestGuide";
import { SurfaceControls } from "./SurfaceControls";
import { SurfacePanel } from "./SurfacePanel";
import { useWorkspaceAgents } from "./useWorkspaceAgents";
import {
  resolveWorkspaceConversation,
  type WorkspaceConversationAdapter,
} from "./workspace-conversation-adapters";
import {
  resolveWorkspaceSurfaceAdapter,
  type WorkspaceSurfaceAdapter,
  type WorkspaceSurfaceSource,
} from "./workspace-surface-adapters";
import { WorkspaceConversation } from "./WorkspaceConversation";
import { WorkspaceHeader } from "./WorkspaceHeader";
import {
  WorkspaceStateNotice,
  type WorkspaceNoticeState,
} from "./WorkspaceStateNotice";

const PROVISIONING_REFRESH_INTERVAL_MS = 5_000;

export type WorkspaceDetailLoader = (
  agent: UnifiedAgent,
  signal: AbortSignal,
) => Promise<WorkspaceSurfaceSource>;

export interface UnifiedWorkspaceProps {
  initialSearch?: string;
  renderAgentContent?: (agent: UnifiedAgent) => ReactNode;
  resolveAgentContent?: (
    agent: UnifiedAgent,
    signal: AbortSignal,
  ) => Promise<ReactNode>;
  renderSurfaceContent?: (
    agent: UnifiedAgent,
    surface: Exclude<WorkspaceSurface, "conversation">,
  ) => ReactNode;
  loadAgentDetail?: WorkspaceDetailLoader;
  releaseMetadata?: ReleaseMetadata;
}

interface ResolvedAdapters {
  uid: string;
  conversation: WorkspaceConversationAdapter | null;
  surfaces: WorkspaceSurfaceAdapter | null;
  checkedAt: string;
}

interface AdapterResolutionState {
  uid: string | null;
  agent: UnifiedAgent | null;
  revision: number;
  loader: WorkspaceDetailLoader | null;
  status: "idle" | "loading" | "resolved" | "error";
  adapters: ResolvedAdapters | null;
}

function currentSearch(initialSearch?: string): string {
  if (initialSearch !== undefined) return initialSearch;
  return typeof window === "undefined" ? "" : window.location.search;
}

function pushWorkspaceRoute(route: WorkspaceRouteState): void {
  if (typeof window === "undefined") return;
  window.history.pushState({}, "", serializeWorkspaceRoute(route));
}

function replaceWorkspaceRoute(route: WorkspaceRouteState): void {
  if (typeof window === "undefined") return;
  window.history.replaceState({}, "", serializeWorkspaceRoute(route));
}

function persistedSurfaceLabel(surface: WorkspaceSurface): string {
  if (surface === "conversation") return "Conversation";
  return surface.charAt(0).toUpperCase() + surface.slice(1);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function readDetailResponse(
  response: Response,
): Promise<Record<string, unknown>> {
  const body = asRecord(await response.json().catch(() => null));
  const data = asRecord(body?.data);
  if (!response.ok || body?.success !== true || !data) {
    throw new Error("Selected agent detail is unavailable");
  }
  return data;
}

const loadWorkspaceAgentDetail: WorkspaceDetailLoader = async (
  agent,
  signal,
) => {
  if (agent.kind === "hermes") {
    const response = await fetch(
      `/api/instances/${encodeURIComponent(agent.id)}?no_sync=true`,
      { cache: "no-store", signal },
    );
    const instance = await readDetailResponse(response);
    const id = requiredString(instance.id);
    const name = requiredString(instance.name);
    const status = requiredString(instance.status);
    const backend = requiredString(instance.backend);
    if (!id || !name || !status || !backend || `h-${id}` !== agent.uid) {
      throw new Error("Selected Hermes detail did not match the requested agent");
    }

    return {
      kind: "hermes",
      uid: agent.uid,
      instance: { id, name, status, backend },
    };
  }

  const response = await fetch(`/api/hivra/agents/${encodeURIComponent(agent.id)}`, {
    cache: "no-store",
    signal,
  });
  const data = await readDetailResponse(response);
  const rawAgent = asRecord(data.agent);
  const id = requiredString(rawAgent?.id);
  if (!rawAgent || !id || `x-${id}` !== agent.uid) {
    throw new Error("Selected Hivra detail did not match the requested agent");
  }

  return {
    kind: "hivra",
    uid: agent.uid,
    agent: rawAgent as unknown as HivraAgent,
    browserEnabled:
      rawAgent.browserEnabled === true || rawAgent.browser_enabled === true,
  };
};

function resolveAdapters(source: WorkspaceSurfaceSource): ResolvedAdapters {
  return {
    uid: source.uid,
    conversation: resolveWorkspaceConversation(source),
    surfaces: resolveWorkspaceSurfaceAdapter(source),
    checkedAt: new Date().toISOString(),
  };
}

function useSelectedAdapters(
  agent: UnifiedAgent | null,
  loader: WorkspaceDetailLoader,
  enabled: boolean,
) {
  const generationRef = useRef(0);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<AdapterResolutionState>({
    uid: null,
    agent: null,
    revision: -1,
    loader: null,
    status: "idle",
    adapters: null,
  });

  useEffect(() => {
    if (!enabled || !agent) {
      generationRef.current += 1;
      return;
    }

    const controller = new AbortController();
    const generation = ++generationRef.current;
    const uid = agent.uid;

    void loader(agent, controller.signal).then(
      (source) => {
        if (
          controller.signal.aborted ||
          generation !== generationRef.current ||
          source.uid !== uid
        ) {
          return;
        }
        setState({
          uid,
          agent,
          revision,
          loader,
          status: "resolved",
          adapters: resolveAdapters(source),
        });
      },
      () => {
        if (controller.signal.aborted || generation !== generationRef.current) return;
        setState({ uid, agent, revision, loader, status: "error", adapters: null });
      },
    );

    return () => {
      controller.abort();
      generationRef.current += 1;
    };
  }, [agent, enabled, loader, revision]);

  const retry = useCallback(() => setRevision((value) => value + 1), []);
  const current =
    enabled &&
    agent &&
    state.uid === agent.uid &&
    state.agent === agent &&
    state.revision === revision &&
    state.loader === loader
      ? state
      : {
          uid: agent?.uid ?? null,
          agent,
          revision,
          loader,
          status: agent && enabled ? ("loading" as const) : ("idle" as const),
          adapters: null,
        };

  return { state: current, retry };
}

function legacyDestination(agent: UnifiedAgent): string {
  return agent.kind === "hermes"
    ? `/dashboard/instances/${encodeURIComponent(agent.id)}`
    : `/dashboard/agent/${encodeURIComponent(agent.id)}?tab=${
        agent.agentType === "aeon" ? "aeon" : "chat"
      }`;
}

function openRecovery(agent: UnifiedAgent): void {
  if (typeof window === "undefined") return;
  window.open(legacyDestination(agent), "_blank", "noopener,noreferrer");
}

function noticeForComputer(computer: AgentComputer): WorkspaceNoticeState | null {
  const { observed, operation } = computer.state;
  if (observed === "error" || operation?.state === "failed") return "recovery";
  if (observed === "provisioning") return "provisioning";
  if (
    observed === "stopped" ||
    observed === "suspended" ||
    observed === "deleting" ||
    observed === "missing"
  ) {
    return "unavailable";
  }
  if (observed === "unknown") return "unknown";
  if (computer.state.health === "incompatible") return "compatibility";
  return null;
}

/**
 * What this resource opens on. One derivation, used by every selection path, so
 * the workspace cannot disagree with the per-agent page about whether a computer
 * shows its desktop or a conversation.
 */
function landingFor(agent: UnifiedAgent) {
  return resolveResourceLanding({
    source: agent.kind,
    type: agent.agentType ?? null,
    computerProfile: agent.computerProfile ?? null,
    status: agent.state,
    surfaceKind: agent.surfaceKind,
    resourceKind: agent.resourceKind,
  });
}

function conversationDescriptor(
  conversation: WorkspaceConversationAdapter | null,
): WorkspaceSurfaceDescriptor[] {
  return conversation
    ? [{ surface: "conversation", label: "Conversation", availability: "available" }]
    : [];
}

export function UnifiedWorkspace({
  initialSearch,
  renderAgentContent,
  resolveAgentContent,
  renderSurfaceContent,
  loadAgentDetail = loadWorkspaceAgentDetail,
  releaseMetadata = {
    canaryUrl: "Unknown",
    revision: "Unknown",
    shortRevision: "Unknown",
    deploymentId: "Unknown",
    targetEnvironment: "Unknown",
    buildGeneratedAt: "Unknown",
    buildGeneratedAtLabel: "Build generated at",
  },
}: UnifiedWorkspaceProps = {}) {
  const workspaceAgents = useWorkspaceAgents();
  const [initialRoute] = useState<WorkspaceRouteState>(() =>
    parseWorkspaceRoute(currentSearch(initialSearch)),
  );
  const [route, setRoute] = useState<WorkspaceRouteState>(initialRoute);
  const restorationAttemptedRef = useRef(initialRoute.agent !== null);
  const [pendingRestoration, setPendingRestoration] =
    useState<WorkspaceSelection | null>(null);
  const [restorationNotice, setRestorationNotice] = useState<string | null>(null);
  // The rail is gone. The agent list is a menu off the header switcher at every
  // width, so there is no pane width to remember and no sidebar to collapse.
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [testGuideOpen, setTestGuideOpen] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const conversationRef = useRef<HTMLElement>(null);
  const agentPickerTriggerRef = useRef<HTMLButtonElement>(null);
  const focusHeadingRef = useRef(false);
  const surfaceTriggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (initialSearch !== undefined || typeof window === "undefined") return;
    const handlePopState = () => {
      const nextRoute = parseWorkspaceRoute(window.location.search);
      setRoute(nextRoute);
      setAgentPickerOpen(false);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [initialSearch]);

  const selectedAgent = route.agent
    ? workspaceAgents.agents.find((candidate) => candidate.uid === route.agent) ?? null
    : null;
  const customContent = Boolean(
    renderAgentContent || resolveAgentContent || renderSurfaceContent,
  );
  const selectedAdapters = useSelectedAdapters(
    selectedAgent,
    loadAgentDetail,
    !customContent,
  );
  const adapters = selectedAdapters.state.adapters;
  const surfaceDescriptors = adapters?.surfaces?.descriptors ?? [];
  const descriptors = [
    ...conversationDescriptor(adapters?.conversation ?? null),
    ...surfaceDescriptors,
  ];

  /**
   * Chat is a destination, not a picker. Opening it with nothing selected used to
   * leave an empty pane that asked the user to choose again, so "Chat" looked
   * broken next to the Agents page it was meant to replace. Land on the most
   * recently active agent instead — a running one first, since a stopped agent's
   * conversation is the less useful first impression.
   */
  const openDefaultAgent = useCallback(() => {
    const candidates = workspaceAgents.agents;
    if (candidates.length === 0) return;
    const preferred =
      candidates.find((candidate) => candidate.state === "running") ??
      candidates[0];
    const landing = landingFor(preferred).landing;
    setRoute({ agent: preferred.uid, surface: landing });
    persistWorkspaceSelection({ uid: preferred.uid, surface: landing });
  }, [workspaceAgents.agents]);

  useEffect(() => {
    if (restorationAttemptedRef.current || workspaceAgents.loading) return;
    restorationAttemptedRef.current = true;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const saved = restoreWorkspaceSelection();
      if (!saved) {
        openDefaultAgent();
        return;
      }
      const savedAgent = workspaceAgents.agents.find(
        (candidate) => candidate.uid === saved.uid,
      );
      if (!savedAgent) {
        clearWorkspaceSelection();
        setRestorationNotice(
          "Your saved agent is no longer available. Choose an agent to continue.",
        );
        return;
      }

      setPendingRestoration(saved);
      setRoute({ agent: savedAgent.uid, surface: landingFor(savedAgent).landing });
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceAgents.agents, workspaceAgents.loading, openDefaultAgent]);

  useEffect(() => {
    if (
      !pendingRestoration ||
      selectedAdapters.state.uid !== pendingRestoration.uid ||
      selectedAdapters.state.status === "idle" ||
      selectedAdapters.state.status === "loading"
    ) {
      return;
    }
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const restoredAgent = workspaceAgents.agents.find(
        (candidate) => candidate.uid === pendingRestoration.uid,
      );
      const fallbackRoute: WorkspaceRouteState = {
        agent: pendingRestoration.uid,
        surface: restoredAgent ? landingFor(restoredAgent).landing : "conversation",
      };
      const finish = (
        nextRoute: WorkspaceRouteState,
        notice: string | null,
        retain: boolean,
      ) => {
        setRoute(nextRoute);
        setRestorationNotice(notice);
        setPendingRestoration(null);
        if (retain) {
          persistWorkspaceSelection({
            uid: nextRoute.agent!,
            surface: nextRoute.surface,
          });
        } else {
          clearWorkspaceSelection();
        }
        if (initialSearch === undefined) replaceWorkspaceRoute(nextRoute);
      };

      if (
        selectedAdapters.state.status === "error" ||
        !selectedAdapters.state.adapters
      ) {
        finish(
          fallbackRoute,
          "Your saved workspace could not be verified. Conversation opened instead when available.",
          false,
        );
        return;
      }

      const resolved = selectedAdapters.state.adapters;
      if (pendingRestoration.surface === "conversation") {
        const conversationAvailable = Boolean(resolved.conversation);
        finish(
          fallbackRoute,
          conversationAvailable
            ? null
            : "Your saved conversation could not be verified. Choose an available surface or refresh status.",
          conversationAvailable,
        );
        return;
      }

      const restoredDescriptor = resolved.surfaces?.descriptors.find(
        ({ surface }) => surface === pendingRestoration.surface,
      );
      if (restoredDescriptor?.availability === "available") {
        finish(
          {
            agent: pendingRestoration.uid,
            surface: pendingRestoration.surface,
          },
          null,
          true,
        );
        return;
      }

      const label =
        restoredDescriptor?.label ??
        persistedSurfaceLabel(pendingRestoration.surface);
      finish(
        fallbackRoute,
        `Your saved ${label} surface is no longer available. Conversation opened instead.`,
        Boolean(resolved.conversation),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [
    initialSearch,
    pendingRestoration,
    selectedAdapters.state,
    // Read to resolve the restored resource's landing surface. The agent list is
    // rebuilt on every refresh, so this re-runs the single restoration pass —
    // `pendingRestoration` is cleared by `finish`, so it does not loop.
    workspaceAgents.agents,
  ]);

  useEffect(() => {
    if (!selectedAgent || !focusHeadingRef.current) return;
    focusHeadingRef.current = false;
    headingRef.current?.focus();
  }, [selectedAgent]);

  const selectAgent = useCallback(
    (agent: UnifiedAgent, keyboardOrigin: boolean) => {
      const nextRoute: WorkspaceRouteState = {
        agent: agent.uid,
        surface: landingFor(agent).landing,
      };
      const wideViewport =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(min-width: 1200px)").matches;
      focusHeadingRef.current = keyboardOrigin && wideViewport;
      surfaceTriggerRef.current = null;
      setAgentPickerOpen(false);
      setPendingRestoration(null);
      setRestorationNotice(null);
      setRoute(nextRoute);
      persistWorkspaceSelection({ uid: agent.uid, surface: nextRoute.surface });
      if (initialSearch === undefined) pushWorkspaceRoute(nextRoute);
      if (keyboardOrigin && !wideViewport) {
        window.setTimeout(() => agentPickerTriggerRef.current?.focus(), 0);
      }
    },
    [initialSearch],
  );

  const selectSurface = useCallback(
    (surface: WorkspaceSurface, trigger: HTMLButtonElement) => {
      if (!selectedAgent) return;
      const nextRoute = { agent: selectedAgent.uid, surface };
      surfaceTriggerRef.current = trigger;
      setPendingRestoration(null);
      setRestorationNotice(null);
      setRoute(nextRoute);
      persistWorkspaceSelection({ uid: selectedAgent.uid, surface });
      if (initialSearch === undefined) pushWorkspaceRoute(nextRoute);
    },
    [initialSearch, selectedAgent],
  );

  const returnToConversation = useCallback(() => {
    if (!selectedAgent) return;
    const trigger = surfaceTriggerRef.current;
    const nextRoute: WorkspaceRouteState = {
      agent: selectedAgent.uid,
      surface: landingFor(selectedAgent).landing,
    };
    setPendingRestoration(null);
    setRestorationNotice(null);
    setRoute(nextRoute);
    persistWorkspaceSelection({
      uid: selectedAgent.uid,
      surface: nextRoute.surface,
    });
    if (initialSearch === undefined) pushWorkspaceRoute(nextRoute);
    window.setTimeout(() => trigger?.focus(), 0);
  }, [initialSearch, selectedAgent]);

  const bothFailed = Boolean(
    workspaceAgents.hermesError && workspaceAgents.hivraError,
  );
  const empty = !workspaceAgents.loading && workspaceAgents.agents.length === 0;
  // What this resource opens on, independent of what the URL asked for.
  const effectiveLanding = selectedAgent ? landingFor(selectedAgent) : null;

  /**
   * The surface actually shown, which is not always the one in the URL.
   *
   * A computer's landing is its desktop and it has no conversation at all. A
   * route that says `surface=conversation` for one is stale — an old saved
   * selection, a shared link, or the bookmark the browser restored — and this
   * is where the workspace used to render it anyway: the tab strip drew with NO
   * tab selected, and the content area fell through to the conversation
   * boundary, which saw no conversation and showed the compatibility notice.
   * The owner saw exactly that on an Ubuntu computer.
   *
   * Reconciling here rather than in an effect matters: an effect would paint the
   * wrong frame first and correct after, and the wrong frame is the one the user
   * would see. Deriving during render means the desktop is the first paint.
   */
  const effectiveSurface: WorkspaceSurface =
    selectedAgent &&
    effectiveLanding?.landing === "desktop" &&
    route.surface === "conversation"
      ? "desktop"
      : route.surface;

  // The tab strip is the surface picker now; the header only needs to know
  // whether a surface is selected so it can offer the way back.
  const surfaceSelected = effectiveSurface !== "conversation";
  const customHasSurface = Boolean(
    customContent && selectedAgent && surfaceSelected && renderSurfaceContent,
  );
  const selectedSurfaceDescriptor = surfaceDescriptors.find(
    ({ surface }) => surface === effectiveSurface,
  );
  const productionHasSurface = Boolean(
    !customContent && selectedAgent && surfaceSelected && adapters?.surfaces,
  );
  const hasSurface = customHasSurface || productionHasSurface;

  const closeTestGuide = useCallback(() => {
    setTestGuideOpen(false);
    window.setTimeout(() => agentPickerTriggerRef.current?.focus(), 0);
  }, []);

  const openAgentPicker = useCallback(() => setAgentPickerOpen(true), []);
  const closeAgentPicker = useCallback(() => {
    setAgentPickerOpen(false);
    window.setTimeout(() => agentPickerTriggerRef.current?.focus(), 0);
  }, []);

  // ⌘/Ctrl+B opens the agent list, matching the panel-toggle chord editors use.
  // It no longer needs the dialog guard the rail required: this opens a menu
  // rather than toggling a pane, so there is no state to desynchronise.
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== "b"
      ) {
        return;
      }
      event.preventDefault();
      setAgentPickerOpen(true);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  const activeSurfaceLabel = selectedSurfaceDescriptor?.label ??
    persistedSurfaceLabel(effectiveSurface);

  /**
   * Repair the URL and the saved selection when they name a surface the
   * resource cannot have — a shared link or bookmark that says
   * `surface=conversation` for a computer should stop saying it.
   *
   * Deliberately no `setRoute` here: every render already reads
   * `effectiveSurface`, so the visible state is correct before this runs. This
   * only fixes what other people and later sessions will read. The ref keeps it
   * to one repair per resource, so a list refresh cannot rewrite history
   * repeatedly.
   */
  const reconciledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedAgent || effectiveSurface === route.surface) return;
    if (reconciledRef.current === selectedAgent.uid) return;
    reconciledRef.current = selectedAgent.uid;
    persistWorkspaceSelection({
      uid: selectedAgent.uid,
      surface: effectiveSurface,
    });
    if (initialSearch === undefined) {
      replaceWorkspaceRoute({
        agent: selectedAgent.uid,
        surface: effectiveSurface,
      });
    }
  }, [effectiveSurface, initialSearch, route.surface, selectedAgent]);

  return (
    <div
      data-testid="unified-workspace"
      data-surface={effectiveSurface}
      className="relative flex h-full min-h-0 max-w-full flex-1 flex-col overflow-hidden bg-[var(--vellum-bg)] text-[var(--ink-black)]"
    >
      <main ref={mainRef} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <section
          ref={conversationRef}
          data-testid="workspace-conversation"
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        >
          {selectedAgent ? (
            <WorkspaceHeader
              agent={selectedAgent}
              headingRef={headingRef}
              agentPickerTriggerRef={agentPickerTriggerRef}
              agentPickerOpen={agentPickerOpen}
              surfaceSelected={surfaceSelected}
              onToggleAgentPane={() => setAgentPickerOpen(true)}
              onOpenAgentPicker={openAgentPicker}
              onCloseSurface={returnToConversation}
            />
          ) : null}

          <AgentSwitcherMenu
            open={agentPickerOpen}
            agents={workspaceAgents.agents}
            selectedUid={selectedAgent?.uid ?? null}
            loading={workspaceAgents.loading}
            hermesError={workspaceAgents.hermesError}
            hivraError={workspaceAgents.hivraError}
            anchorRef={agentPickerTriggerRef}
            onSelect={selectAgent}
            onClose={closeAgentPicker}
            onRetryHermes={() => void workspaceAgents.retryHermes()}
            onRetryHivra={() => void workspaceAgents.retryHivra()}
            onOpenTestGuide={() => {
              setAgentPickerOpen(false);
              setTestGuideOpen(true);
            }}
          />

          {selectedAgent && !customContent && descriptors.length > 0 ? (
            <SurfaceControls
              descriptors={descriptors}
              selectedSurface={effectiveSurface}
              onSelect={selectSurface}
            />
          ) : null}

          {restorationNotice ? (
            <div
              role="status"
              className="border-b border-[var(--etched-border)] bg-[var(--bg-surface)] px-4 py-2 text-[12px] leading-[1.3] text-[var(--yellow)] sm:px-6"
            >
              {restorationNotice}
            </div>
          ) : null}

          {/* A selected surface IS the content area — it is not a second column.
              Rendering it beside the conversation is what produced the duplicate
              chrome the owner kept hitting: two panes, two titles, and a 440px
              conversation squeezed next to the thing that had been asked for. */}
          <div className="relative min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain">
            {surfaceSelected && selectedAgent && hasSurface ? (
              <SurfacePanel
                agentUid={selectedAgent.uid}
                agentName={selectedAgent.name}
                surface={effectiveSurface as Exclude<WorkspaceSurface, "conversation">}
                surfaceLabel={activeSurfaceLabel}
                onClose={returnToConversation}
              >
                {customContent
                  ? renderSurfaceContent?.(
                      selectedAgent,
                      effectiveSurface as Exclude<WorkspaceSurface, "conversation">,
                    )
                  : selectedSurfaceDescriptor?.availability === "available" &&
                      adapters?.surfaces ? (
                      <ResolvedSurfaceContent
                        adapter={adapters.surfaces}
                        surface={effectiveSurface as AgentComputerSurface}
                        onBack={returnToConversation}
                      />
                    ) : (
                      <WorkspaceStateNotice
                        state="unavailable"
                        agentName={selectedAgent.name}
                        surfaceLabel={selectedSurfaceDescriptor?.label ?? "Surface"}
                        observedReason={selectedSurfaceDescriptor?.reason}
                        updatedAt={adapters?.checkedAt ?? new Date().toISOString()}
                        onPrimaryAction={selectedAdapters.retry}
                      />
                    )}
              </SurfacePanel>
            ) : workspaceAgents.loading ? (
              <LoadingState label="Loading your agents…" />
            ) : bothFailed && empty ? (
              <WorkspaceState
                title="We couldn't load your agents"
                body="Check your connection, then try again."
                actions={
                  <>
                    <button
                      type="button"
                      onClick={() => void workspaceAgents.retryAll()}
                      className="action-button min-h-[44px] px-4 text-[12px] font-semibold normal-case tracking-normal"
                    >
                      Retry agent list
                    </button>
                    <a
                      href="/dashboard"
                      className="inline-flex min-h-[44px] items-center px-4 text-[12px] font-semibold text-[var(--text-muted)] outline-none hover:text-[var(--ink-black)] focus-visible:ring-2 focus-visible:ring-[var(--hivra-red)] focus-visible:ring-offset-2"
                    >
                      Back to dashboard
                    </a>
                  </>
                }
              />
            ) : empty ? (
              <WorkspaceState
                title="No agents yet"
                body="Create an agent to start chatting. Its workspace will appear here when it is ready."
                actions={
                  <a
                    href="/dashboard"
                    className="action-button inline-flex min-h-[44px] items-center px-4 text-[12px] font-semibold normal-case tracking-normal"
                  >
                    Create agent
                  </a>
                }
              />
            ) : !selectedAgent ? (
              <WorkspaceState
                title="Choose an agent"
                body="Select an agent to open its conversation and available computer surfaces."
              />
            ) : customContent ? (
              <SelectedAgentBoundary
                key={selectedAgent.uid}
                agent={selectedAgent}
                renderAgentContent={renderAgentContent}
                resolveAgentContent={resolveAgentContent}
              />
            ) : (
              <ResolvedAgentBoundary
                key={selectedAgent.uid}
                agent={selectedAgent}
                state={selectedAdapters.state}
                onRetry={selectedAdapters.retry}
              />
            )}
          </div>
        </section>
      </main>

      <CanaryTestGuide
        open={testGuideOpen}
        onClose={closeTestGuide}
        releaseMetadata={releaseMetadata}
        agents={workspaceAgents.agents}
        loadAgentDetail={loadAgentDetail}
      />
    </div>
  );
}

function ResolvedSurfaceContent({
  adapter,
  surface,
  onBack,
}: {
  adapter: WorkspaceSurfaceAdapter;
  surface: AgentComputerSurface;
  onBack: () => void;
}) {
  return adapter.renderSurface(surface, onBack);
}

function ResolvedAgentBoundary({
  agent,
  state,
  onRetry,
}: {
  agent: UnifiedAgent;
  state: AdapterResolutionState;
  onRetry: () => void;
}) {
  const computer =
    state.adapters?.surfaces?.computer ?? state.adapters?.conversation?.computer;
  const provisioning =
    state.status === "resolved" && computer?.state.observed === "provisioning";

  useEffect(() => {
    if (!provisioning) return;
    const timer = window.setInterval(onRetry, PROVISIONING_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [onRetry, provisioning]);

  if (state.status === "loading" || state.uid !== agent.uid) {
    return (
      <WorkspaceStateNotice
        state="loading"
        agentName={agent.name}
        surfaceLabel={agent.name}
        updatedAt={new Date().toISOString()}
      />
    );
  }

  if (state.status === "error" || !state.adapters) {
    return (
      <WorkspaceStateNotice
        state="error"
        agentName={agent.name}
        surfaceLabel="Conversation"
        updatedAt={new Date().toISOString()}
        onPrimaryAction={onRetry}
        blocking
      />
    );
  }

  if (!computer) {
    return (
      <WorkspaceStateNotice
        state="unknown"
        agentName={agent.name}
        surfaceLabel="Workspace"
        updatedAt={state.adapters.checkedAt}
        onPrimaryAction={onRetry}
      />
    );
  }

  const notice = noticeForComputer(computer);
  if (notice) {
    return (
      <WorkspaceStateNotice
        state={notice}
        agentName={agent.name}
        surfaceLabel="Workspace"
        observedReason={`Observed state: ${computer.state.observed}.`}
        observedDetail={`Observed state: ${computer.state.observed}; operation: ${
          computer.state.operation?.state ?? "none observed"
        }.`}
        observedState={computer.state.observed}
        updatedAt={state.adapters.checkedAt}
        recoveryActionLabel={agent.kind === "hermes" ? "Open Console" : "Open Manage"}
        computer={computer}
        onPrimaryAction={
          notice === "recovery" ? () => openRecovery(agent) : onRetry
        }
      />
    );
  }

  if (!state.adapters.conversation) {
    // A computer has no conversation by design — its desktop is a surface. That
    // is not a compatibility failure, and this branch is only reachable for one
    // if the surface pane failed to take over (e.g. the adapter declared no
    // surfaces), so it points at the surface rather than claiming the session
    // is legacy. The notice text was the wrong story for the wrong resource.
    const landing = resolveResourceLanding({
      source: agent.kind,
      type: agent.agentType ?? null,
      computerProfile: agent.computerProfile ?? null,
      status: agent.state,
      surfaceKind: agent.surfaceKind,
      resourceKind: agent.resourceKind,
    });
    if (landing.desktop) {
      return (
        <WorkspaceStateNotice
          state="unavailable"
          agentName={agent.name}
          surfaceLabel="Desktop"
          observedReason="This computer opens on its desktop, which could not be prepared here."
          updatedAt={state.adapters.checkedAt}
          computer={computer}
          onPrimaryAction={onRetry}
        />
      );
    }
    return (
      <WorkspaceStateNotice
        state="compatibility"
        agentName={agent.name}
        surfaceLabel="Conversation"
        updatedAt={state.adapters.checkedAt}
        computer={computer}
      />
    );
  }

  return (
    <div
      data-agent-boundary={agent.uid}
      className="flex h-full min-w-0 flex-1 flex-col overflow-hidden"
    >
      <WorkspaceConversation adapter={state.adapters.conversation} />
    </div>
  );
}

function SelectedAgentBoundary({
  agent,
  renderAgentContent,
  resolveAgentContent,
}: {
  agent: UnifiedAgent;
  renderAgentContent?: (agent: UnifiedAgent) => ReactNode;
  resolveAgentContent?: (
    agent: UnifiedAgent,
    signal: AbortSignal,
  ) => Promise<ReactNode>;
}) {
  const generationRef = useRef(0);
  const [resolvedContent, setResolvedContent] = useState<ReactNode>(null);
  const [opening, setOpening] = useState(Boolean(resolveAgentContent));

  useEffect(() => {
    if (!resolveAgentContent) return;
    const controller = new AbortController();
    const generation = ++generationRef.current;

    void resolveAgentContent(agent, controller.signal).then(
      (content) => {
        if (controller.signal.aborted || generation !== generationRef.current) return;
        setResolvedContent(content);
        setOpening(false);
      },
      () => {
        if (controller.signal.aborted || generation !== generationRef.current) return;
        setResolvedContent(
          <p className="text-[14px] text-[var(--red)]">
            Couldn&apos;t open {agent.name}. Check the connection and try again.
          </p>,
        );
        setOpening(false);
      },
    );

    return () => {
      controller.abort();
      generationRef.current += 1;
    };
  }, [agent, resolveAgentContent]);

  return (
    <div
      data-agent-boundary={agent.uid}
      className="mx-auto flex min-h-full w-full max-w-[760px] flex-col gap-4 p-4 motion-reduce:transition-none sm:p-6"
    >
      {renderAgentContent ? (
        renderAgentContent(agent)
      ) : (
        <div className="flex flex-1 items-center justify-center text-center text-[14px] text-[var(--text-muted)]">
          <p>Conversation for {agent.name}</p>
        </div>
      )}
      {opening ? (
        <p aria-live="polite" className="text-[14px] text-[var(--text-muted)]">
          Opening {agent.name}…
        </p>
      ) : null}
      {resolvedContent}
    </div>
  );
}

function WorkspaceState({
  title,
  body,
  actions,
}: {
  title: string;
  body: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex min-h-full items-center justify-center p-6 text-center">
      <div className="max-w-[480px]">
        <h1 className="serif text-[28px] font-normal leading-[1.2]">{title}</h1>
        <p className="mt-4 text-[14px] leading-[1.5] text-[var(--text-muted)]">{body}</p>
        {actions ? <div className="mt-6 flex flex-wrap justify-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}
