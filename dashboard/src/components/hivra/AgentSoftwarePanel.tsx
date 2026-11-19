"use client";

// Manage › Updates: the agent's own software (Claude Code, Codex, the Aeon
// dashboard, OpenClaw, Agent Zero, Hermes, OpenBot, Nuphos). Hivra pins no
// version: a launch installs upstream's newest release, and after that the
// version only changes when the owner presses Update (which installs the
// newest release again) or uses the agent's own update command. The card shows
// the installed version, what an update is doing or did, and the button.
// Nothing here is guessed: every line comes from what the computer last
// reported (GET /api/hivra/agents/[id]/agent-software).

import { useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { ThinkingOrb } from "@/components/ui/ThinkingOrb";
import type { HivraAgent } from "@/lib/hivra/agent-api";
import { agentSoftwareSubject, type AgentAppName, type AgentSoftwareUpdateReport, type AgentSoftwareView } from "@/lib/hivra/agent-cli-status";
import { agentSoftwareDisplayName, agentSoftwareVersionName } from "@/lib/hivra/agent-software-names";
import { useAgentSoftware } from "./useAgentSoftware";
import { agentSoftwareCovered } from "./AgentSoftwareChip";
import { UNREACHABLE_CARD_LINE, useReportUnreachable } from "./manage/ManageReachability";
import {
  manageButtonDark, manageButtonGhost, manageCard, manageDisabled, manageError, manageLabel, manageMuted, manageSpin, manageValue,
} from "./manage/manage-styles";

/** What the update Manage ran came back with (the lifecycle route's answer). */
export type AgentSoftwareUpdateOutcome =
  | { ok: true; report: AgentSoftwareUpdateReport | null }
  | { ok: false; message: string; code: string | null };

/** When Hivra last read the computer, in the viewer's own date and time. */
function checkedAt(iso: string | null): string {
  const at = iso ? new Date(iso) : null;
  if (!at || !Number.isFinite(at.getTime())) return "Not yet";
  return `${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

/**
 * An update's refusal in the owner's words, by the route's code: for this
 * card's Update and for Manage's Update connection service, which runs the
 * same update. Any other code keeps the route's own message.
 */
export function agentSoftwareUpdateError(code: string | null, message: string, myServer: boolean, subject: "agent" | "computer" = "agent"): string {
  switch (code) {
    case "host_not_ready":
      return myServer
        ? "Prepare My server with Hivra's current setup, then try again. Nothing was changed."
        : "Hivra hasn't finished preparing this update yet. Nothing was changed. Try again later.";
    case "busy": return `Another action is running on this ${subject}. Try again when it finishes.`;
    case "not_running": return `Start this ${subject} first.`;
    case "unverified": return "Hivra couldn't confirm the update finished. Check again in a minute.";
    default: return message;
  }
}

type Action = { label: string; primary: boolean } | null;

/**
 * Where Manage already lets the person fix a computer whose update failed and
 * could not be undone: restore points (Recovery) or Force restart (Advanced).
 */
export type SoftwareRecovery = { kind: "restore" | "force-restart"; open: () => void };

/** The next steps after an update that failed and could not be undone. */
function brokenUpdateNextStep(recovery: SoftwareRecovery | null): string {
  if (!recovery) return "Try again, or contact support.";
  return recovery.kind === "restore"
    ? "Try again first. If that doesn't work, restore this agent from a restore point made before the update (button below). Contact support only if that doesn't help either."
    : "Try again first. If that doesn't work, use Force restart in Advanced (button below). Contact support only if that doesn't help either.";
}

const RECOVERY_BUTTON = { restore: "Open Recovery", "force-restart": "Open Advanced" } as const;

/** True when the update failed and the previous version couldn't be put back. */
function rollbackFailed(view: AgentSoftwareView): boolean {
  return view.kind === "update_failed" && !["download_failed", "could_not_start", "no_space"].includes(view.reason);
}

/** What the owner types in Terminal to do what the Update Hermes button does. */
export const HERMES_TERMINAL_UPDATE = "hermes update";

/** The agent's own update command, where it has one its owner can run in Terminal. */
const TERMINAL_UPDATE: Partial<Record<string, string>> = {
  hermes: HERMES_TERMINAL_UPDATE,
  openclaw: "openclaw update",
  codex: "npm install -g @openai/codex@latest",
};

/**
 * The sentence for this state, and the update button it offers (if any).
 * There is no tested version to compare with: the card says what is
 * installed, what an update is doing or did, and always offers the update
 * (the updater decides whether anything newer exists). `app` is null for the
 * CLIs, which wait for a reply to finish rather than for the app to be idle.
 */
function softwareStateCopy(view: AgentSoftwareView, name: string, app: AgentAppName | null, terminalUpdate: string | null, recovery: SoftwareRecovery | null): { text: string; action: Action } {
  const v = agentSoftwareVersionName;
  const update = (label = `Update ${name}`, primary = false): Action => ({ label, primary });
  switch (view.kind) {
    case "not_running": return { text: `Start this agent to check or update ${name}.`, action: null };
    case "checking": return { text: `Checking which ${name} version is installed…`, action: null };
    case "unreachable": return { text: UNREACHABLE_CARD_LINE, action: null };
    case "older_connection_service":
    case "not_reported":
      return {
        text: `This agent's connection service is older, so it doesn't report its ${name} version. Update the connection service below: it also updates ${name} to its newest release.`,
        action: null,
      };
    case "version_unreadable":
      return { text: `Hivra couldn't read which ${name} version is installed.`, action: update() };
    case "current": return { text: "", action: update() };
    case "updating":
      switch (view.phase) {
        case "starting": return { text: "Starting the update…", action: null };
        case "downloading":
          return app === "aeon"
            ? { text: `Building ${name}'s newest version. ${name} keeps working while it builds, which can take 15 minutes.`, action: null }
            : { text: `Downloading ${name}'s newest release. ${name} keeps working while it downloads.`, action: null };
        case "waiting":
          return app
            ? { text: `Waiting until nobody is using ${name}. It updates once ${name} has been idle for 5 minutes${app === "agent-zero" ? " with no task running" : ""}, so close it in any other tab. Hivra waits up to 6 hours.`, action: null }
            : { text: `Waiting for the current reply to finish. ${name} updates as soon as no reply is being written. Hivra waits up to 6 hours.`, action: null };
        case "installing":
          return app
            ? { text: `Installing ${name}'s newest release. ${name} restarts and is back in a few minutes.`, action: null }
            : { text: `Installing ${name}'s newest release. Messages you send now wait a few seconds and then send by themselves.`, action: null };
        case "finishing": return { text: "Checking the new version…", action: null };
      }
      return { text: "", action: null };
    case "update_done": return { text: `${name} ${v(view.installed)} is installed. It is the newest release.`, action: update() };
    case "update_deferred":
      return { text: `${name} wasn't updated because it was still in use after 6 hours. Nothing was changed.`, action: update("Try again", true) };
    case "update_rolled_back":
      return {
        text: `${name}'s newest release didn't start properly, so Hivra put ${view.installed ? `${name} ${v(view.installed)}` : "the previous version"} back. Your agent works as before.`,
        action: update("Try again"),
      };
    case "update_failed":
      if (view.reason === "local_changes") {
        return {
          text: `${name} didn't update because its install has changes of your own, and its updater leaves those alone. Nothing was changed.${terminalUpdate ? ` Run ${terminalUpdate} in Terminal to see what it needs.` : ""}`,
          action: update("Try again"),
        };
      }
      if (view.reason === "download_failed") {
        return { text: `Hivra couldn't ${app === "aeon" ? "build" : "download"} ${name}'s newest release. Nothing was changed.`, action: update("Try again") };
      }
      if (view.reason === "no_space") {
        return { text: `There isn't enough free disk space on this agent's computer to update ${name}. Nothing was changed.`, action: null };
      }
      if (view.reason === "could_not_start") {
        return { text: `The connection service was updated, but the ${name} update couldn't start. Try again.`, action: update("Try again") };
      }
      return {
        text: `${name}'s newest release didn't install, and Hivra couldn't put the previous version back. ${name} may not work until this is fixed. ${brokenUpdateNextStep(recovery)}`,
        action: update("Try again", true),
      };
  }
}

/**
 * The agent's software in Manage › Updates. `onUpdate` runs the in-place
 * update through Manage (its busy lock, progress and surface sign-in).
 */
export function AgentSoftwarePanel({ agent, name, busy, updating, onUpdate, recovery = null }: {
  agent: HivraAgent;
  /** "Codex", "Claude Code", "Aeon"… */
  name: string;
  /** Another Manage action is running. */
  busy: boolean;
  /** This panel's update is running. */
  updating: boolean;
  onUpdate: () => Promise<AgentSoftwareUpdateOutcome>;
  /** Manage's own way back from a failed update, when this computer has one. */
  recovery?: SoftwareRecovery | null;
}) {
  // A stopped agent says how to check it; one being set up or in error says nothing yet.
  const enabled = agentSoftwareCovered(agent) && (agent.status === "running" || agent.status === "stopped");
  const software = useAgentSoftware(agent.id, enabled);
  const [actionError, setActionError] = useState<string | null>(null);
  const state = software.state;
  // Manage's one banner says the computer can't be reached; this card only
  // says it is unavailable instead of its own error.
  const unreachableNow = enabled && agent.status === "running" && state?.supported === true && state.view.kind === "unreachable";
  useReportUnreachable("software", unreachableNow);
  if (!enabled) return null;
  if (!state) {
    // The first read failed: say so where the card would be, with a way to try again.
    if (!software.error || agent.status !== "running") return null;
    const subject = agentSoftwareSubject(agent);
    const shown = agentSoftwareDisplayName(subject?.app ?? null, name);
    return (
      <div style={{ display: "grid", gap: 10 }}>
        {subject ? <div className="mono" style={manageLabel}>{shown}</div> : null}
        <div style={card}>
          <div role="status" aria-live="polite" data-testid="agent-software-unavailable" style={{ fontSize: 13, color: "var(--ink-black)", lineHeight: 1.55 }}>
            {subject ? `Couldn't check which ${shown} version is installed just now.` : "Couldn't check this agent's connection service just now."}
          </div>
          <div>
            <CheckAgain loading={software.loading} onClick={() => void software.refresh()} />
          </div>
        </div>
      </div>
    );
  }
  if (!state.supported) return null;
  const view = state.view;
  const myServer = agent.deployment_mode === "self-managed";

  // Agents that report no version of their own: only an older connection service is worth saying.
  if (!state.cli && !state.app) {
    if (view.kind !== "older_connection_service") return null;
    return (
      <div style={card}>
        <div style={manageMuted} data-testid="agent-software-state">
          This agent&apos;s connection service is older than Hivra&apos;s current one. Update the connection service below to bring it up to date.
        </div>
      </div>
    );
  }

  const app = state.app;
  const shown = agentSoftwareDisplayName(app, name);
  const terminalUpdate = TERMINAL_UPDATE[app ?? state.cli ?? ""] ?? null;
  const copy = softwareStateCopy(view, shown, app, terminalUpdate, recovery);
  const rawInstalled = "installed" in view && view.installed ? view.installed : null;
  const installed = rawInstalled && app ? agentSoftwareVersionName(rawInstalled) : rawInstalled;
  const update = async () => {
    setActionError(null);
    const outcome = await onUpdate();
    if (!outcome.ok) {
      setActionError(agentSoftwareUpdateError(outcome.code, outcome.message, myServer));
      return;
    }
    await software.follow();
  };
  const actionDisabled = busy || !agent.manage || agent.manage.connectionServiceUpdate?.state !== "available";

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div className="mono" style={manageLabel}>{shown}</div>
      <div style={card}>
        <div style={{ display: "grid", gap: 8 }}>
          <Fact label={`${shown} installed`}>{installed ?? (view.kind === "checking" || view.kind === "not_running" || view.kind === "unreachable" ? "—" : "Not reported")}</Fact>
          <Fact label="Last checked">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span>{checkedAt(state.observedAt)}</span>
              {agent.status === "running" ? <CheckAgain loading={software.loading} onClick={() => void software.refresh()} /> : null}
            </span>
          </Fact>
        </div>

        {/* One live region in every state, so a screen reader hears each
            change (an update starting, finishing, or not installing); only
            its words change. */}
        <div role="status" aria-live="polite" data-testid="agent-software-state" style={{ fontSize: 13, color: "var(--ink-black)", lineHeight: 1.55, display: copy.text ? "flex" : "none", gap: 8, alignItems: "flex-start" }}>
          {view.kind === "updating" ? <span aria-hidden="true" style={{ display: "inline-flex", flexShrink: 0 }}><ThinkingOrb state="working" size={20} /></span> : null}
          <span>{copy.text}</span>
        </div>
        {software.error ? <div style={manageMuted}>Couldn&apos;t check just now. {software.error}</div> : null}

        {copy.action ? (
          <div style={{ display: "grid", gap: 8 }}>
            <div>
              <button
                type="button"
                disabled={actionDisabled}
                onClick={() => void update()}
                style={manageDisabled(copy.action.primary ? manageButtonDark : manageButtonGhost, actionDisabled)}
              >
                {updating ? <Loader2 size={14} style={manageSpin} aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />} {copy.action.label}
              </button>
            </div>
            <div style={{ ...manageMuted, fontSize: 11.5 }}>
              {app
                ? `Updating installs ${shown}'s newest release and also refreshes Hivra's connection service without restarting the computer. ${shown} restarts once, when nobody is using it.`
                : `Updating installs ${shown}'s newest release and also refreshes Hivra's connection service without restarting the computer. Replies being written keep going, and terminals open on this page reconnect when it finishes.`}
            </div>
          </div>
        ) : null}
        {recovery && rollbackFailed(view) ? (
          <div>
            <button type="button" onClick={recovery.open} style={manageButtonGhost} data-testid="agent-software-recovery">
              {RECOVERY_BUTTON[recovery.kind]}
            </button>
          </div>
        ) : null}
        {actionError ? <div role="alert" style={manageError}>{actionError}</div> : null}

        <div style={{ ...manageMuted, fontSize: 11.5 }}>
          {`Hivra installed ${shown}'s newest release when this agent was launched and never changes it by itself. Update installs the newest release again${app === "aeon" ? " of the dashboard Hivra hosts; your Aeon skills and workflows live in your GitHub fork, which you keep up to date on GitHub" : ""}.`}
          {terminalUpdate ? <> You can also run <code>{terminalUpdate}</code> in Terminal.</> : null}
        </div>
      </div>
    </div>
  );
}

const card = manageCard;

function CheckAgain({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      className="mono"
      style={{ ...manageLabel, border: 0, background: "transparent", color: "var(--ink-black)", textDecoration: "underline", minHeight: 40, padding: 0, cursor: loading ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}
    >
      {loading ? <Loader2 size={11} style={manageSpin} aria-hidden="true" /> : <RefreshCw size={11} aria-hidden="true" />}
      Check again
    </button>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", minHeight: 22 }}>
      <span className="mono" style={{ ...manageLabel, flex: "0 0 180px" }}>{label}</span>
      <span style={{ ...manageValue, flex: "1 1 120px", minWidth: 0 }}>{children}</span>
    </div>
  );
}
