"use client";

// Manage › Updates: the agent's own software. For Claude Code and Codex, and
// for the Aeon dashboard, OpenClaw and Agent Zero, the installed version next
// to the version Hivra has tested, what an update is doing or did, and Update
// now; for the CLIs also automatic updates (shown only while Hivra runs them).
// Nothing here is guessed: every line comes from what the computer last
// reported (GET /api/hivra/agents/[id]/agent-software).

import { useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import type { HivraAgent } from "@/lib/hivra/agent-api";
import { agentSoftwareSubject, type AgentAppName, type AgentSoftwareUpdateReport, type AgentSoftwareView } from "@/lib/hivra/agent-cli-status";
import { agentSoftwareDisplayName, agentSoftwareVersionName } from "@/lib/hivra/agent-software-names";
import { setAgentSoftwareAutoUpdate, type AgentSoftwareAutoUpdate } from "@/lib/hivra/agent-software-api";
import { useAgentSoftware } from "./useAgentSoftware";
import { agentSoftwareCovered } from "./AgentSoftwareChip";
import {
  manageButtonDark, manageButtonGhost, manageCard, manageDisabled, manageError, manageLabel, manageMuted, manageSpin, manageValue,
} from "./manage/manage-styles";

/** What the update Manage ran came back with (the lifecycle route's answer). */
export type AgentSoftwareUpdateOutcome =
  | { ok: true; report: AgentSoftwareUpdateReport | null }
  | { ok: false; message: string; code: string | null };

const VENDOR: Record<string, string> = { "claude-code": "Anthropic", codex: "OpenAI" };

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

/** The sentence for this state, and the update button it offers (if any). */
function stateCopy(view: AgentSoftwareView, name: string, tested: string | null): { text: string; action: Action } {
  const tv = tested ?? "";
  switch (view.kind) {
    case "not_running": return { text: `Start this agent to check or update ${name}.`, action: null };
    case "checking": return { text: `Checking which ${name} version is installed…`, action: null };
    case "unreachable": return { text: `Couldn't reach this agent to check its ${name} version.`, action: null };
    case "older_connection_service":
      return {
        text: `This agent's connection service is older, so it doesn't report its ${name} version. Update the connection service below: it also moves ${name} to ${tv}, the version Hivra has tested.`,
        action: null,
      };
    case "not_reported": return { text: "", action: null };
    case "version_unreadable":
      return { text: `Hivra couldn't read which ${name} version is installed.`, action: { label: `Reinstall ${tv}`, primary: false } };
    case "current": return { text: `${name} is on the version Hivra has tested.`, action: null };
    case "behind":
      return { text: `An update is available. ${name} ${view.installed} is installed and Hivra has tested ${tv}.`, action: { label: `Update ${name}`, primary: true } };
    case "ahead_custom":
      return {
        text: `${name} ${view.installed} is installed, which is newer than the version Hivra has tested (${tv}). Hivra chat may not work as expected with it. Automatic updates leave it as it is.`,
        action: { label: `Switch to ${tv}`, primary: false },
      };
    case "ahead_hivra":
      return {
        text: `Hivra now tests ${name} ${tv}. This agent still has ${view.installed}, which Hivra installed before. Updating moves it to ${tv}.`,
        action: { label: `Update ${name}`, primary: true },
      };
    // CLI versions are always ordered; this reads like any other untested version.
    case "other_version":
      return { text: `${name} ${view.installed} is installed, which isn't a version Hivra has tested.`, action: { label: `Switch to ${tv}`, primary: false } };
    case "updating":
      switch (view.phase) {
        case "starting": return { text: "Starting the update…", action: null };
        case "downloading": return { text: `Downloading ${name} ${view.target}. The agent keeps working while it downloads.`, action: null };
        case "waiting": return { text: `Waiting for the current reply to finish. ${name} updates as soon as no reply is being written. Hivra waits up to 6 hours.`, action: null };
        case "installing": return { text: `Installing ${name} ${view.target}. Messages you send now wait a few seconds and then send by themselves.`, action: null };
        case "finishing": return { text: "Checking the new version…", action: null };
      }
      return { text: "", action: null };
    case "update_done":
      return { text: `${name} ${view.target} is installed. ${name} sessions already open in the ${name} session tab keep the previous version until you close them.`, action: null };
    case "update_deferred":
      return { text: `${name} wasn't updated because a reply was still being written after 6 hours. Nothing was changed.`, action: { label: "Try again", primary: true } };
    case "update_rolled_back":
      return {
        text: `The update to ${view.target} didn't install, so Hivra put ${name} ${view.installed ?? "back to its previous version"}${view.installed ? " back" : ""}. Your agent works as before.`,
        action: { label: "Try again", primary: false },
      };
    case "update_failed":
      if (view.reason === "download_failed") {
        return { text: `Hivra couldn't download ${name} ${view.target}. Nothing was changed.`, action: { label: "Try again", primary: false } };
      }
      if (view.reason === "could_not_start") {
        return { text: `The connection service was updated, but the ${name} update couldn't start. Try again.`, action: { label: "Try again", primary: false } };
      }
      return {
        text: `${name} ${view.target} didn't install, and Hivra couldn't put the previous version back. Chat may not work until this is fixed. Try again, or contact support.`,
        action: { label: "Try again", primary: true },
      };
  }
}

/**
 * The same for an app Hivra hosts. It restarts once to update, so Hivra waits
 * until nobody has used it for a while (and it has no work running) instead of
 * for a reply. `v` names a version the way owners see it.
 */
function appStateCopy(view: AgentSoftwareView, app: AgentAppName, name: string, tested: string): { text: string; action: Action } {
  const v = agentSoftwareVersionName;
  const tv = v(tested);
  switch (view.kind) {
    case "not_running": return { text: `Start this agent to check or update ${name}.`, action: null };
    case "checking": return { text: `Checking which ${name} version is installed…`, action: null };
    case "unreachable": return { text: `Couldn't reach this agent to check its ${name} version.`, action: null };
    case "older_connection_service":
    case "not_reported":
      return {
        text: `This agent's connection service is older, so it doesn't report its ${name} version. Update the connection service below: it also moves ${name} to ${tv}, the version Hivra has tested.`,
        action: null,
      };
    case "version_unreadable":
      return { text: `Hivra hasn't recorded which ${name} version this agent runs. Updating installs ${tv}, the version Hivra has tested.`, action: { label: `Update ${name}`, primary: true } };
    case "current": return { text: `${name} is on the version Hivra has tested.`, action: null };
    case "behind":
      return { text: `An update is available. ${name} ${v(view.installed)} is installed and Hivra has tested ${tv}.`, action: { label: `Update ${name}`, primary: true } };
    case "other_version":
      return { text: `${name} ${v(view.installed)} is installed, which isn't a version Hivra has tested. Updating moves it to ${tv}.`, action: { label: `Update ${name}`, primary: true } };
    case "ahead_custom":
      return {
        text: `${name} ${v(view.installed)} is installed, which is newer than the version Hivra has tested (${tv}). It may not work as expected inside Hivra.`,
        action: { label: `Switch to ${tv}`, primary: false },
      };
    case "ahead_hivra":
      return { text: `Hivra now tests ${name} ${tv}. This agent still has ${v(view.installed)}, which Hivra installed before. Updating moves it to ${tv}.`, action: { label: `Update ${name}`, primary: true } };
    case "updating":
      switch (view.phase) {
        case "starting": return { text: "Starting the update…", action: null };
        case "downloading":
          return app === "aeon"
            ? { text: `Building ${name} ${v(view.target)}. ${name} keeps working while it builds, which can take 15 minutes.`, action: null }
            : { text: `Downloading ${name} ${v(view.target)}. ${name} keeps working while it downloads.`, action: null };
        case "waiting":
          return {
            text: `Waiting until nobody is using ${name}. It updates once ${name} has been idle for 5 minutes${app === "agent-zero" ? " with no task running" : ""}, so close it in any other tab. Hivra waits up to 6 hours.`,
            action: null,
          };
        case "installing": return { text: `Installing ${name} ${v(view.target)}. ${name} restarts and is back in about a minute.`, action: null };
        case "finishing": return { text: "Checking the new version…", action: null };
      }
      return { text: "", action: null };
    case "update_done": return { text: `${name} ${v(view.target)} is installed.`, action: null };
    case "update_deferred":
      return { text: `${name} wasn't updated because it was still in use after 6 hours. Nothing was changed.`, action: { label: "Try again", primary: true } };
    case "update_rolled_back":
      return {
        text: `${name} ${v(view.target)} didn't start properly, so Hivra put ${view.installed ? `${name} ${v(view.installed)}` : "the previous version"} back. Your agent works as before.`,
        action: { label: "Try again", primary: false },
      };
    case "update_failed":
      if (view.reason === "download_failed") {
        return { text: `Hivra couldn't ${app === "aeon" ? "build" : "download"} ${name} ${v(view.target)}. Nothing was changed.`, action: { label: "Try again", primary: false } };
      }
      if (view.reason === "no_space") {
        return { text: `There isn't enough free disk space on this agent's computer to update ${name}. Nothing was changed.`, action: null };
      }
      if (view.reason === "could_not_start") {
        return { text: `The connection service was updated, but the ${name} update couldn't start. Try again.`, action: { label: "Try again", primary: false } };
      }
      return {
        text: `${name} ${v(view.target)} didn't start properly, and Hivra couldn't put the previous version back. ${name} may not open until this is fixed. Try again, or contact support.`,
        action: { label: "Try again", primary: true },
      };
  }
}

function AutoUpdateToggle({ agentId, auto, name, onSaved }: {
  agentId: string;
  auto: AgentSoftwareAutoUpdate;
  name: string;
  onSaved: (state: Awaited<ReturnType<typeof setAgentSoftwareAutoUpdate>>) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = async () => {
    setSaving(true);
    setError(null);
    try {
      onSaved(await setAgentSoftwareAutoUpdate(agentId, !auto.enabled));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Your choice couldn't be saved. Try again.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div id={`agent-software-auto-${agentId}`} style={{ fontSize: 13.5, color: "var(--ink-black)", fontWeight: 600 }}>Update automatically</div>
          <div style={{ ...manageMuted, marginTop: 3 }}>
            When Hivra has tested a new version of {name}, it installs it while this agent is idle, never while a reply is being written.
            {auto.source === "default" ? (auto.enabled ? " On by default for agents on Hivra Cloud." : " Off by default for agents on My server.") : ""}
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={auto.enabled}
          aria-labelledby={`agent-software-auto-${agentId}`}
          disabled={saving}
          onClick={() => void toggle()}
          style={{ minWidth: 56, minHeight: 44, border: 0, background: "transparent", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: saving ? "default" : "pointer", flexShrink: 0, padding: 0 }}
        >
          <span aria-hidden="true" style={{ width: 48, height: 27, borderRadius: 14, border: "1px solid var(--etched-border)", background: auto.enabled ? "var(--gold-leaf)" : "rgba(255,255,255,0.05)", position: "relative", display: "inline-block", boxSizing: "border-box" }}>
            {saving
              ? <Loader2 size={13} style={{ ...manageSpin, color: "var(--ink-black)", position: "absolute", top: 6, left: auto.enabled ? 24 : 6 }} />
              : <span style={{ position: "absolute", top: 3, left: auto.enabled ? 24 : 3, width: 19, height: 19, borderRadius: "50%", background: auto.enabled ? "var(--ink-black)" : "var(--text-muted)", transition: "left .15s ease" }} />}
          </span>
        </button>
      </div>
      {auto.pausedFor ? (
        <div style={manageMuted}>Paused after the update to {auto.pausedFor.target} didn&apos;t install. Update {name} to try again.</div>
      ) : null}
      {error ? <div role="alert" style={manageError}>{error}</div> : null}
    </div>
  );
}

/**
 * The agent's software in Manage › Updates. `onUpdate` runs the in-place
 * update through Manage (its busy lock, progress and surface sign-in).
 */
export function AgentSoftwarePanel({ agent, name, busy, updating, onUpdate }: {
  agent: HivraAgent;
  /** "Codex", "Claude Code", "Aeon"… */
  name: string;
  /** Another Manage action is running. */
  busy: boolean;
  /** This panel's update is running. */
  updating: boolean;
  onUpdate: () => Promise<AgentSoftwareUpdateOutcome>;
}) {
  // A stopped agent says how to check it; one being set up or in error says nothing yet.
  const enabled = agentSoftwareCovered(agent) && (agent.status === "running" || agent.status === "stopped");
  const software = useAgentSoftware(agent.id, enabled);
  const [actionError, setActionError] = useState<string | null>(null);
  const state = software.state;
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
  const copy = app && state.tested ? appStateCopy(view, app, shown, state.tested) : stateCopy(view, name, state.tested);
  const rawInstalled = "installed" in view && view.installed ? view.installed : view.kind === "update_done" ? view.target : null;
  const installed = rawInstalled && app ? agentSoftwareVersionName(rawInstalled) : rawInstalled;
  const tested = state.tested && app ? agentSoftwareVersionName(state.tested) : state.tested;
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
          <Fact label="Hivra's tested version">{tested ?? "—"}</Fact>
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
          {view.kind === "updating" ? <Loader2 size={14} aria-hidden="true" style={{ ...manageSpin, flexShrink: 0, marginTop: 3 }} /> : null}
          <span>{copy.text}</span>
        </div>
        {state.autoUpdate?.pausedFor && view.kind === "update_rolled_back" ? (
          <div style={manageMuted}>Automatic updates are paused for {state.autoUpdate.pausedFor.target}.</div>
        ) : null}
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
                ? `Updating also refreshes Hivra's connection service without restarting the computer. ${shown} itself restarts once, when nobody is using it.`
                : "Updating also refreshes Hivra's connection service without restarting the computer. Replies being written keep going, and terminals open on this page reconnect when it finishes."}
            </div>
          </div>
        ) : null}
        {actionError ? <div role="alert" style={manageError}>{actionError}</div> : null}

        {state.autoUpdate && state.autoUpdate.mode === "on" ? (
          <AutoUpdateToggle agentId={agent.id} auto={state.autoUpdate} name={name} onSaved={software.replace} />
        ) : null}

        <div style={{ ...manageMuted, fontSize: 11.5 }}>
          {app
            ? `Hivra installs only ${name} versions it has tested, so this can be older than the newest ${name} release.${app === "aeon" ? " Hivra updates the dashboard it hosts. Your Aeon skills and workflows live in your GitHub fork, which you keep up to date on GitHub." : ""}`
            : <>Hivra installs only versions it has tested with Hivra chat, so this can be older than {VENDOR[state.cli ?? ""] ?? "the vendor"}&apos;s newest {name} release.</>}
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
