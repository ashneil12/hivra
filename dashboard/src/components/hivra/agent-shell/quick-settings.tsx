"use client";

// Quick settings for the agent page's floating pill. Every row runs a flow the
// app already has: the agent-software update and the computer restart (the ones
// Manage runs), a section of Manage, or another surface of this page. Which
// rows exist comes from command-panel/capabilities.ts. Nothing here is a new
// backend.

import { useCallback, useState, type ReactNode } from "react";
import { ChevronRight, MessageCircle, Power, RefreshCw, Ruler, Sparkles } from "lucide-react";
import { AgentActionError, restartAgent, updateAgentRuntime, type HivraAgent } from "@/lib/hivra/agent-api";
import { agentComputerPair, agentComputerPairDetail, type AgentSurfaceId } from "@/lib/agent-computers/agent-surfaces";
import type { AgentSoftwareView } from "@/lib/hivra/agent-cli-status";
import type { ManageSectionId } from "@/lib/hivra/manage-sections";
import { agentSoftwareUpdateError } from "../AgentSoftwarePanel";
import { HermesModelSettings } from "../HermesModelSettings";
import { useAgentSoftware } from "../useAgentSoftware";
import { commandPanelCapabilities, type PanelAction, type PanelActionId, type PanelSuggestion } from "../command-panel/capabilities";
import type { AgentPillSetting, AgentPillSettingContext, AgentPillSuggestion } from "./AgentPill";
import styles from "./AgentPill.module.css";

const ICONS: Partial<Record<PanelActionId, ReactNode>> = {
  update: <RefreshCw aria-hidden="true" />,
  restart: <Power aria-hidden="true" />,
  model: <Sparkles aria-hidden="true" />,
  size: <Ruler aria-hidden="true" />,
  channels: <MessageCircle aria-hidden="true" />,
};

/** The views are quick buttons in the pill, so they are not settings rows. */
const VIEW_ACTIONS: readonly PanelActionId[] = ["terminal", "browser", "files"];

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
    case "update_failed": return { text: `The ${name} update didn't finish. Open Settings to see what to do next.`, tone: "error" };
    default: return null;
  }
}

/**
 * What the Update row says beside its label. `unpinned` is an agent Hivra pins
 * no version for (Hermes, OpenBot): it shows the version it has, never "available".
 */
function updateNote(view: AgentSoftwareView | null | undefined, unpinned: boolean): string {
  if (unpinned) {
    switch (view?.kind) {
      case "updating": return "Updating…";
      case "current": return `Version ${view.installed}`;
      case "update_done": return "Up to date";
      case "update_failed": return view.reason === "local_changes" ? "Not updated: it has changes of your own" : "The last update didn't finish";
      default: return "";
    }
  }
  switch (view?.kind) {
    case "updating": return "Updating…";
    case "behind": case "ahead_hivra": case "other_version": case "version_unreadable": return "An update is available";
    case "current": case "update_done": return "Up to date";
    case "update_failed": return "The last update didn't finish";
    default: return "";
  }
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

const DISMISSED_PREFIX = "hivra:agent-suggestion-dismissed:";

function readDismissed(agentId: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(`${DISMISSED_PREFIX}${agentId}`) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return []; // A display preference cannot block the page.
  }
}

function writeDismissed(agentId: string, ids: string[]): void {
  try {
    window.localStorage.setItem(`${DISMISSED_PREFIX}${agentId}`, JSON.stringify(ids));
  } catch { /* It stays dismissed until the page closes. */ }
}

type Message = { text: string; tone?: "error" } | null;

export interface AgentQuickSettingsProps {
  agent: HivraAgent;
  /** The tab ids the agent page shows. */
  surfaces: readonly string[];
  /** False for a computer or an agent that is not running: no rows, no reads. */
  enabled: boolean;
  onOpenSurface: (surface: AgentSurfaceId) => void;
  onOpenManageSection: (section: ManageSectionId) => void;
  /** An action changed the computer (restart, update): the page reads it again. */
  onChanged: () => void;
  /** The update restarts the connection service, which drops the page's embedded sign-ins. */
  onConnectionServiceRestarted?: () => void;
  children: (state: { settings: AgentPillSetting[]; busy: string | null; suggestion: AgentPillSuggestion | null }) => ReactNode;
}

/**
 * Owns the quick settings' state so the page's early returns do not sit above
 * a hook. Key it by the agent id: another agent starts from its own state.
 */
export function AgentQuickSettings({
  agent, surfaces, enabled, onOpenSurface, onOpenManageSection, onChanged, onConnectionServiceRestarted, children,
}: AgentQuickSettingsProps) {
  const caps = enabled ? commandPanelCapabilities(agent, surfaces) : null;
  const name = caps?.name ?? agent.name;
  const hasUpdate = Boolean(caps?.actions.some((action) => action.id === "update"));
  const software = useAgentSoftware(agent.id, hasUpdate && enabled && agent.status === "running");
  const softwareView = software.state?.supported ? software.state.view : null;

  const [updating, setUpdating] = useState(false);
  const [followed, setFollowed] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<Message>(null);
  const [restarting, setRestarting] = useState(false);
  const [restartMessage, setRestartMessage] = useState<Message>(null);
  const [dismissed, setDismissed] = useState<string[]>(() => readDismissed(agent.id));

  const softwareBusy = updating || softwareView?.kind === "updating";

  const startUpdate = async () => {
    if (softwareBusy) return;
    setFollowed(false);
    setUpdating(true);
    setUpdateMessage({ text: `Updating ${name}…` });
    try {
      await updateAgentRuntime(agent.id);
      // The update restarts the connection service; the page signs its embedded screens in again.
      onConnectionServiceRestarted?.();
      void software.follow();
      setFollowed(true);
      onChanged();
    } catch (error) {
      if (error instanceof AgentActionError && error.status === 502) onConnectionServiceRestarted?.();
      const text = error instanceof AgentActionError
        ? agentSoftwareUpdateError(error.code, error.message, agent.deployment_mode === "self-managed")
        : errorText(error, "The update didn't start.");
      setUpdateMessage({ text, tone: "error" });
    } finally {
      setUpdating(false);
    }
  };

  const startRestart = async () => {
    if (restarting) return;
    setRestarting(true);
    setRestartMessage({ text: `Restarting ${name}'s computer…` });
    try {
      await restartAgent(agent.id);
      setRestartMessage({ text: `Restart started. ${name} is back in about a minute.` });
      onChanged();
    } catch (error) {
      setRestartMessage({ text: errorText(error, "The restart didn't start. Nothing was changed."), tone: "error" });
    } finally {
      setRestarting(false);
    }
  };

  const dismiss = useCallback((id: string) => {
    setDismissed((current) => {
      if (current.includes(id)) return current;
      const next = [...current, id];
      writeDismissed(agent.id, next);
      return next;
    });
  }, [agent.id]);

  const openManage = (ctx: AgentPillSettingContext, section: ManageSectionId) => {
    ctx.close();
    onOpenManageSection(section);
  };

  const manageLink = (ctx: AgentPillSettingContext, section: ManageSectionId, text: string) => (
    <button type="button" className={styles.link} onClick={() => openManage(ctx, section)}>
      <span>{text}</span><ChevronRight aria-hidden="true" />
    </button>
  );

  const settingFor = (action: PanelAction): AgentPillSetting | null => {
    const icon = ICONS[action.id];
    switch (action.id) {
      case "update": {
        const line = updateLine(softwareView, name);
        const status = (followed ? line : null) ?? updateMessage;
        return {
          id: "update",
          icon,
          label: action.label,
          value: softwareBusy ? "Updating…" : updateNote(softwareView, agent.type === "hermes" || agent.type === "openbot") || undefined,
          onLeave: () => { if (!updating) { setUpdateMessage(null); setFollowed(false); } },
          render: (ctx) => (
            <>
              <p className={styles.text}>{line?.text ?? action.description}</p>
              <div className={styles.buttons}>
                <button type="button" className={styles.primary} disabled={softwareBusy} aria-busy={softwareBusy || undefined} onClick={() => void startUpdate()}>
                  Update now
                </button>
              </div>
              <p role="status" aria-live="polite" className={styles.line} data-tone={status?.tone}>{status?.text ?? ""}</p>
              {manageLink(ctx, "updates", "Open Updates in Settings")}
            </>
          ),
        };
      }
      case "restart":
        return {
          id: "restart",
          icon,
          label: action.label,
          onLeave: () => { if (!restarting) setRestartMessage(null); },
          render: (ctx) => (
            <>
              <p className={styles.textStrong}>Restart {name}&apos;s computer?</p>
              <p className={styles.text}>{name} is unavailable for about a minute. Anything it is doing stops and starts again.</p>
              <div className={styles.buttons}>
                <button type="button" className={styles.primary} disabled={restarting} onClick={() => void startRestart()}>Restart</button>
                <button type="button" className={styles.secondary} onClick={ctx.back}>Cancel</button>
              </div>
              <p role="status" aria-live="polite" className={styles.line} data-tone={restartMessage?.tone}>{restartMessage?.text ?? ""}</p>
            </>
          ),
        };
      case "model": {
        const hermes = agent.type === "hermes" && Boolean(agent.chat_url);
        return {
          id: "model",
          icon,
          label: action.label,
          value: hermes ? undefined : action.description,
          render: (ctx) => hermes ? (
            <>
              <HermesModelSettings chatUrl={agent.chat_url as string} apiToken={agent.api_token} agentName={name} running={agent.status === "running"} disabled={false} />
              {manageLink(ctx, "model", "All models in Settings")}
            </>
          ) : (
            <>
              <p className={styles.text}>{action.description}</p>
              <div className={styles.buttons}>
                <button type="button" className={styles.secondary} onClick={() => openManage(ctx, "model")}>Change model in Settings</button>
              </div>
            </>
          ),
        };
      }
      case "size": {
        const detail = agentComputerPairDetail(agentComputerPair(agent));
        return {
          id: "size",
          icon,
          label: action.label,
          render: (ctx) => (
            <>
              <p className={styles.text}>{detail || action.description}</p>
              <div className={styles.buttons}>
                <button type="button" className={styles.secondary} onClick={() => openManage(ctx, "resources")}>Change size in Settings</button>
              </div>
            </>
          ),
        };
      }
      case "channels": {
        const suggestion = caps?.suggestions.find((item) => item.id === "channels");
        const target = action.target.kind === "surface" ? action.target.surface : null;
        return {
          id: "channels",
          icon,
          label: action.label,
          render: (ctx) => (
            <>
              <p className={styles.text}>{suggestion?.body ?? action.description}</p>
              {target ? (
                <div className={styles.buttons}>
                  <button type="button" className={styles.secondary} onClick={() => { ctx.close(); onOpenSurface(target); }}>Open {name}</button>
                </div>
              ) : null}
            </>
          ),
        };
      }
      default:
        return null;
    }
  };

  const settings = caps
    ? caps.actions
      .filter((action) => !VIEW_ACTIONS.includes(action.id))
      .map(settingFor)
      .filter((setting): setting is AgentPillSetting => setting !== null)
    : [];

  const next: PanelSuggestion | undefined = caps?.suggestions.find((item) => !dismissed.includes(item.id));
  const suggestion: AgentPillSuggestion | null = next
    ? {
      id: next.id,
      title: next.title,
      body: next.body,
      actionLabel: "Set up",
      onAction: () => { dismiss(next.id); onOpenSurface(next.target.surface); },
      onDismiss: () => dismiss(next.id),
    }
    : null;

  const busy = softwareBusy ? "Updating" : restarting ? "Restarting" : null;
  return <>{children({ settings, busy, suggestion })}</>;
}
