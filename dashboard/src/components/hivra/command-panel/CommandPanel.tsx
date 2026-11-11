"use client";

// The command panel: quick settings and quick things beside an agent's own web
// UI (OpenClaw, Agent Zero, Aeon, DeepSeek Harness, and any agent whose catalog
// entry says `surface: "dashboard"`). Every tile runs a flow the app already
// has: the agent-software update and the computer restart (the ones Manage
// runs), another surface of this page, or a section of Manage. Which tiles
// exist comes from capabilities.ts; what is shown comes from the owner's saved
// choices (usePanelPrefs). Nothing here is a new backend.

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  Globe, Folder, Loader2, MessageCircle, PanelRightClose, PanelRightOpen, Power, RefreshCw, Ruler, Sparkles, SquareTerminal,
} from "lucide-react";
import { AgentActionError, getAgentEvents, restartAgent, updateAgentRuntime, type HivraAgent } from "@/lib/hivra/agent-api";
import { agentSoftwareUpdateError } from "../AgentSoftwarePanel";
import { useAgentSoftware } from "../useAgentSoftware";
import type { AgentSoftwareView } from "@/lib/hivra/agent-cli-status";
import type { ComputerHistoryEvent } from "@/lib/hivra/computer-history";
import type { ManageSectionId } from "@/lib/hivra/manage-sections";
import type { AgentSurfaceId } from "@/lib/agent-computers/agent-surfaces";
import { commandPanelCapabilities, type PanelAction, type PanelActionId, type PanelCapabilities } from "./capabilities";
import { usePanelPrefs } from "./usePanelPrefs";
import styles from "./CommandPanel.module.css";

const ICONS: Record<PanelActionId, typeof Globe> = {
  update: RefreshCw,
  restart: Power,
  terminal: SquareTerminal,
  browser: Globe,
  files: Folder,
  model: Sparkles,
  size: Ruler,
  channels: MessageCircle,
};

const NARROW_QUERY = "(max-width: 899px)";
function subscribeNarrow(onChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const list = window.matchMedia(NARROW_QUERY);
  list.addEventListener?.("change", onChange);
  return () => list.removeEventListener?.("change", onChange);
}
function narrowNow(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(NARROW_QUERY).matches;
}

/** The sentence for an update that is running or has just ended; null when there is nothing to say. */
function updateLine(view: AgentSoftwareView | null | undefined, name: string): { text: string; tone?: "error" } | null {
  switch (view?.kind) {
    case "updating":
      switch (view.phase) {
        case "starting": return { text: `Starting the ${name} update…` };
        case "downloading": return { text: `Downloading the ${name} update…` };
        case "waiting": return { text: `Waiting until nobody is using ${name}, then updating…` };
        case "installing": return { text: `Installing the ${name} update. It restarts and is back in about a minute.` };
        case "finishing": return { text: "Checking the new version…" };
      }
      return null;
    case "update_done": return { text: `${name} is up to date.` };
    case "update_deferred": return { text: `${name} wasn't updated because it was still in use. Nothing was changed.`, tone: "error" };
    case "update_rolled_back": return { text: `The ${name} update didn't start properly, so it was put back as it was.`, tone: "error" };
    case "update_failed": return { text: `The ${name} update didn't finish. Open Manage to see what to do next.`, tone: "error" };
    default: return null;
  }
}

/** What the Update tile says under its label. */
function updateNote(view: AgentSoftwareView | null | undefined, fallback: string): string {
  switch (view?.kind) {
    case "updating": return "Updating…";
    case "behind": case "ahead_hivra": case "other_version": case "version_unreadable": return "An update is available";
    case "current": case "update_done": return "Up to date";
    case "update_failed": return "The last update didn't finish";
    default: return fallback;
  }
}

function whenText(iso: string): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "";
  return `${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

const ACTIVITY_SHOWN = 5;

export interface AgentCommandPanelProps {
  agent: HivraAgent;
  caps: PanelCapabilities;
  onOpenSurface: (surface: AgentSurfaceId) => void;
  onOpenManageSection: (section: ManageSectionId) => void;
  /** An action changed the computer (restart, update): the page reads it again. */
  onChanged: () => void;
  /** The update restarts the connection service, which drops the page's embedded sign-ins. */
  onConnectionServiceRestarted?: () => void;
}

/** Key it by the agent id: another agent starts from its own saved choices. */
export function AgentCommandPanel({ agent, caps, onOpenSurface, onOpenManageSection, onChanged, onConnectionServiceRestarted }: AgentCommandPanelProps) {
  const { name } = caps;
  const prefsApi = usePanelPrefs(agent.id);
  const { prefs } = prefsApi;
  const narrow = useSyncExternalStore(subscribeNarrow, narrowNow, () => false);
  const open = prefs.open ?? !narrow;
  const panelId = useId();
  const railRef = useRef<HTMLButtonElement>(null);
  const hideRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const focusAfterToggle = useRef(false);

  const [customizing, setCustomizing] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone?: "error" }>({ text: "Tip: Customize picks what this panel shows." });
  const [followed, setFollowed] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [events, setEvents] = useState<ComputerHistoryEvent[]>([]);
  const [eventsKey, setEventsKey] = useState(0);

  const hasUpdate = caps.actions.some((a) => a.id === "update");
  const software = useAgentSoftware(agent.id, hasUpdate && agent.status === "running");
  const softwareView = software.state?.supported ? software.state.view : null;
  const softwareBusy = updating || softwareView?.kind === "updating";

  // The computer's own history, from the same feed as Manage › Advanced. A
  // failed or empty read leaves the section out rather than showing a blank one.
  useEffect(() => {
    const controller = new AbortController();
    getAgentEvents(agent.id, controller.signal)
      .then((rows) => { if (!controller.signal.aborted) setEvents(rows); })
      .catch(() => { if (!controller.signal.aborted) setEvents([]); });
    return () => controller.abort();
  }, [agent.id, eventsKey]);

  useEffect(() => {
    if (!focusAfterToggle.current) return;
    focusAfterToggle.current = false;
    (open ? hideRef.current : railRef.current)?.focus();
  }, [open]);
  useEffect(() => { if (confirmRestart) cancelRef.current?.focus(); }, [confirmRestart]);

  const say = useCallback((text: string, tone?: "error") => {
    setFollowed(false);
    setMessage({ text, tone });
  }, []);

  const setOpen = (next: boolean) => {
    focusAfterToggle.current = true;
    prefsApi.setOpen(next);
  };

  const startUpdate = async () => {
    if (softwareBusy) { say(`${name} is already updating.`); return; }
    setConfirmRestart(false);
    setUpdating(true);
    say(`Updating ${name}…`);
    try {
      await updateAgentRuntime(agent.id);
      // The update restarts the connection service; the page signs its embedded screens in again.
      onConnectionServiceRestarted?.();
      void software.follow();
      setFollowed(true);
      onChanged();
      setEventsKey((k) => k + 1);
    } catch (error) {
      if (error instanceof AgentActionError && error.status === 502) onConnectionServiceRestarted?.();
      const text = error instanceof AgentActionError
        ? agentSoftwareUpdateError(error.code, error.message, agent.deployment_mode === "self-managed")
        : errorText(error, "The update didn't start.");
      say(text, "error");
    } finally {
      setUpdating(false);
    }
  };

  const confirmedRestart = async () => {
    setConfirmRestart(false);
    setRestarting(true);
    say(`Restarting ${name}'s computer…`);
    try {
      await restartAgent(agent.id);
      say(`Restart started. ${name} is back in about a minute.`);
      onChanged();
      setEventsKey((k) => k + 1);
    } catch (error) {
      say(errorText(error, "The restart didn't start. Nothing was changed."), "error");
    } finally {
      setRestarting(false);
    }
  };

  const press = (action: PanelAction) => {
    const target = action.target;
    switch (target.kind) {
      case "update": void startUpdate(); return;
      case "restart":
        if (restarting) return;
        setConfirmRestart(true);
        say(`Restart ${name}'s computer? It is unavailable for about a minute.`);
        return;
      case "surface":
        setConfirmRestart(false);
        say(target.opening);
        onOpenSurface(target.surface);
        return;
      case "manage":
        setConfirmRestart(false);
        say(target.opening);
        onOpenManageSection(target.section);
        return;
    }
  };

  const visibleActions = caps.actions.filter((a) => prefsApi.isActionShown(a.id, a.defaultShown));
  const visibleSuggestions = caps.suggestions.filter((s) => prefsApi.isSuggestionShown(s.id));
  const activityAvailable = events.length > 0;
  const showActivity = activityAvailable && prefs.activity;

  const toggleCustomize = () => {
    if (customizing) say("Saved.");
    else say("Turn things on or off. Nothing is deleted.");
    setCustomizing(!customizing);
  };

  if (!open) {
    return (
      <button
        ref={railRef}
        type="button"
        className={styles.rail}
        aria-label="Show command panel"
        aria-expanded={false}
        aria-controls={panelId}
        onClick={() => setOpen(true)}
      >
        <PanelRightOpen size={16} aria-hidden="true" />
        <span className={styles.railLabel} aria-hidden="true">Command panel</span>
      </button>
    );
  }

  const tile = (action: PanelAction): ReactNode => {
    const Icon = action.id === "update" && softwareBusy ? Loader2 : ICONS[action.id];
    const busy = (action.id === "update" && softwareBusy) || (action.id === "restart" && restarting);
    const note = action.id === "update" ? updateNote(softwareView, action.description) : action.description;
    return (
      <button key={action.id} type="button" className={styles.tile} aria-busy={busy || undefined} onClick={() => press(action)} data-action={action.id}>
        <span className={styles.tileHead}>
          <Icon size={16} aria-hidden="true" className={busy ? styles.spin : undefined} />
          <span className={styles.tileLabel}>{action.label}</span>
        </span>
        <span className={styles.tileNote}>{busy && action.id === "update" ? "Updating…" : note}</span>
      </button>
    );
  };

  const followedLine = followed ? updateLine(softwareView, name) : null;
  const status = followedLine ?? message;

  return (
    <aside id={panelId} className={styles.panel} aria-label="Command panel">
      <div className={styles.header}>
        <h2 className={styles.title}>Command panel</h2>
        <button type="button" className={styles.textButton} aria-pressed={customizing} onClick={toggleCustomize}>
          {customizing ? "Done" : "Customize"}
        </button>
        <button ref={hideRef} type="button" className={styles.iconButton} aria-label="Hide command panel" aria-expanded onClick={() => setOpen(false)}>
          <PanelRightClose size={16} aria-hidden="true" />
        </button>
      </div>

      <div className={styles.body}>
        {customizing ? (
          <section aria-label="Customize the command panel" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <p className={styles.hint}>Pick what this panel shows. Your choice is saved for this agent in this browser.</p>
            <fieldset className={styles.fieldset}>
              <legend className={styles.legend}>Quick actions</legend>
              {caps.actions.map((action) => (
                <label key={action.id} className={styles.check}>
                  <input
                    type="checkbox"
                    checked={prefsApi.isActionShown(action.id, action.defaultShown)}
                    onChange={(event) => prefsApi.setActionShown(action.id, event.target.checked)}
                  />
                  <span>{action.label}</span>
                </label>
              ))}
            </fieldset>
            {caps.suggestions.length > 0 || activityAvailable ? (
              <fieldset className={styles.fieldset}>
                <legend className={styles.legend}>Sections</legend>
                {caps.suggestions.map((suggestion) => (
                  <label key={suggestion.id} className={styles.check}>
                    <input
                      type="checkbox"
                      checked={prefsApi.isSuggestionShown(suggestion.id)}
                      onChange={(event) => prefsApi.setSuggestionShown(suggestion.id, event.target.checked)}
                    />
                    <span>{suggestion.title} suggestion</span>
                  </label>
                ))}
                {activityAvailable ? (
                  <label className={styles.check}>
                    <input type="checkbox" checked={prefs.activity} onChange={(event) => prefsApi.setActivityShown(event.target.checked)} />
                    <span>Recent activity</span>
                  </label>
                ) : null}
              </fieldset>
            ) : null}
          </section>
        ) : (
          <>
            <section aria-label="Quick actions">
              <p className={styles.sectionLabel}>Quick actions</p>
              {visibleActions.length > 0 ? (
                <div className={styles.grid}>{visibleActions.map(tile)}</div>
              ) : (
                <p className={styles.empty}>No quick actions are showing. Customize turns some back on.</p>
              )}
            </section>

            {confirmRestart ? (
              <div className={styles.card} role="group" aria-labelledby={`${panelId}-restart`}>
                <p id={`${panelId}-restart`} className={styles.cardTitle}>Restart {name}&apos;s computer?</p>
                <p className={styles.cardBody}>{name} is unavailable for about a minute. Anything it is doing stops and starts again.</p>
                <div className={styles.row}>
                  <button type="button" className={styles.primary} onClick={() => void confirmedRestart()}>Restart</button>
                  <button ref={cancelRef} type="button" className={styles.secondary} onClick={() => { setConfirmRestart(false); say("Restart cancelled."); }}>Cancel</button>
                </div>
              </div>
            ) : null}

            {visibleSuggestions.map((suggestion) => (
              <section key={suggestion.id} className={styles.card} aria-label={`Suggestion: ${suggestion.title}`}>
                <p className={styles.cardTitle}>{suggestion.title}</p>
                <p className={styles.cardBody}>{suggestion.body}</p>
                <div className={styles.row}>
                  <button
                    type="button"
                    className={styles.primary}
                    onClick={() => {
                      prefsApi.setSuggestionShown(suggestion.id, false);
                      say(`${suggestion.opened} This suggestion won't show again. Customize brings it back.`);
                      onOpenSurface(suggestion.target.surface);
                    }}
                  >
                    Set up
                  </button>
                  <button
                    type="button"
                    className={styles.secondary}
                    onClick={() => {
                      prefsApi.setSuggestionShown(suggestion.id, false);
                      say("Got it. That suggestion won't show again. Customize brings it back.");
                    }}
                  >
                    Not interested
                  </button>
                </div>
              </section>
            ))}

            {showActivity ? (
              <section aria-label="Recent activity">
                <button
                  type="button"
                  className={styles.activityToggle}
                  aria-expanded={prefs.activityOpen}
                  onClick={() => prefsApi.setActivityOpen(!prefs.activityOpen)}
                >
                  <span>Recent activity</span>
                  <span>{prefs.activityOpen ? "Hide" : "Show"}</span>
                </button>
                {prefs.activityOpen ? (
                  <ul className={styles.activityList}>
                    {events.slice(0, ACTIVITY_SHOWN).map((event, index) => (
                      <li key={`${event.createdAt}-${index}`} className={styles.activityItem}>
                        <span className={styles.activityWhen}>{whenText(event.createdAt)}</span>
                        <span>{event.label}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            ) : null}
          </>
        )}
      </div>

      <p role="status" aria-live="polite" className={styles.status} data-tone={status.tone}>{status.text}</p>
    </aside>
  );
}

/** What the page hands the dock: the agent, the tabs it shows, and how to move around. */
export interface CommandPanelDockProps {
  agent: HivraAgent;
  /** The tab ids the agent page shows. */
  surfaces: readonly string[];
  /** The tab on screen: Manage has its own controls, so the panel steps aside there. */
  activeSurface: string;
  onOpenSurface: (surface: AgentSurfaceId) => void;
  onOpenManageSection: (section: ManageSectionId) => void;
  onChanged: () => void;
  onConnectionServiceRestarted?: () => void;
  /** The page's work pane. It stays first and mounted whether or not the panel shows. */
  children: ReactNode;
}

/**
 * The agent page's work pane with the command panel docked beside it, for an
 * agent whose catalog entry says its main screen is its own web UI. For every
 * other agent it is the work pane alone.
 */
export function CommandPanelDock({ agent, surfaces, activeSurface, onOpenSurface, onOpenManageSection, onChanged, onConnectionServiceRestarted, children }: CommandPanelDockProps) {
  const caps = commandPanelCapabilities(agent, surfaces);
  const shown = caps !== null && agent.status === "running" && activeSurface !== "manage";
  return (
    <div className={styles.dock}>
      {children}
      {shown ? (
        <AgentCommandPanel
          key={agent.id}
          agent={agent}
          caps={caps}
          onOpenSurface={onOpenSurface}
          onOpenManageSection={onOpenManageSection}
          onChanged={onChanged}
          onConnectionServiceRestarted={onConnectionServiceRestarted}
        />
      ) : null}
    </div>
  );
}
