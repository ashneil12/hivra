"use client";

// Hivra per-agent view — Chat (Chat, <Agent> session) · Computer (Terminal,
// Files, Browser, Git) · Manage. Server-backed: polls the agent until provisioning finishes, then the
// Chat tab connects to its runtime. Styled in the Command Center vocabulary
// (serif names, mono labels, theme-aware tokens). Flag-gated.

import styles from "./ResourceWorkspace.module.css";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { LoadingState } from "@/components/ui/LoadingState";
import { MessageSquareText, TerminalSquare, SquareTerminal, Settings2, Loader2, ExternalLink, FolderTree, Sparkles, Send, Monitor, LayoutDashboard, GitBranch, CalendarClock, Plus, X, Globe, Computer } from "lucide-react";

import { getAgent as catalogAgent } from "@/lib/hivra/agent-catalog";
import {
  AGENT_SURFACE_IDS,
  agentComputerPairLabel,
  agentSurfaceGroups,
  agentSurfaceLabel,
  agentSurfacesFor,
  type AgentSurfaceGroupId,
  type AgentSurfaceId,
} from "@/lib/agent-computers/agent-surfaces";
import { getAgent, browserStatus, fetchPlanStrict, type HivraAgent, type PlanInfo } from "@/lib/hivra/agent-api";
import { useChatReadiness } from "@/components/hivra/useChatReadiness";
import { providerReadinessMessage } from "@/lib/hivra/provider-readiness-contract";
import { providerPowerMessage } from "@/lib/hivra/provider-power-contract";
import { ResourceSurfaceNavigation } from "@/components/hivra/ResourceSurfaceNavigation";
import { useNativeWorkspace } from "@/components/layout/NativeWorkspaceBridge";
import { HivraChat } from "@/components/hivra/HivraChat";
import { HivraLogin } from "@/components/hivra/HivraLogin";
import { HivraGitHubConnect } from "@/components/hivra/HivraGitHubConnect";
import { HivraFiles } from "@/components/hivra/HivraFiles";
import { HivraProviderWorkspace } from "@/components/hivra/HivraProviderWorkspace";
import { HivraGit } from "@/components/hivra/HivraGit";
import { HivraSkills } from "@/components/hivra/HivraSkills";
import { HivraTelegram } from "@/components/hivra/HivraTelegram";
import { HivraManage } from "@/components/hivra/HivraManage";
import { ResourceSwitcher } from "@/components/hivra/ResourceSwitcher";
import { HivraRemoteDesktop } from "@/components/hivra/HivraRemoteDesktop";
import { HivraConsoleDesktop } from "@/components/hivra/HivraConsoleDesktop";
import { HivraOmarchyDesktop } from "@/components/hivra/HivraOmarchyDesktop";
import { resolveResourceLanding } from "@/lib/hivra/resource-landing";
import {
  SurfaceActionProvider,
  useSurfaceAction,
  useSurfaceActionStoreInstance,
} from "@/components/hivra/SurfaceActionContext";
import { hivraRuntimeUid } from "@/lib/workspace/runtime-selection";
import { lastTabFor } from "@/lib/workspace/recents";
import { resourceInventory } from "@/lib/workspace/resource-inventory";
import { useRecordVisit } from "@/components/workspace/useRecordVisit";
import { ChannelConnectNudge } from "@/components/hivra/ChannelConnectNudge";
import { TasksPanel } from "@/components/scheduled-tasks/TasksPanel";
import { UpgradePaywallModal } from "@/components/billing/UpgradePaywallModal";
import { isHivraEnabled } from "@/lib/hivra/hivra-flag";
import { clientLog } from "@/lib/client/logger";
import { agentActivityPresentation } from "@/lib/hivra/agent-activity";
import { GOALS } from "@/lib/hivra/agent-identity";
import { DigitalOceanAgentWorkspace } from "@/components/hivra/DigitalOceanAgentWorkspace";
import type { WelcomePersonalizationDraft } from "@/lib/welcome-personalization";
import {
  buildWelcomePersonalizationContext,
  parseWelcomePersonalizationContext,
} from "@/lib/welcome-personalization";

const ENV_FLAG = process.env.NEXT_PUBLIC_HIVRA_AGENTS === "1";

// Which tabs a resource has is one shared decision (agentSurfacesFor): the
// Computer Contract and the launch Review read it too, so what the agent is
// told and what its owner can open cannot drift apart.
type Tab = AgentSurfaceId;
const COMPUTER_WORKSPACE_TABS: Tab[] = ["files", "box"];

const labelStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono), monospace",
  fontSize: 10,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.16em",
  color: "var(--text-muted)",
};

const TAB_ICONS: Record<Tab, React.ReactNode> = {
  chat: <MessageSquareText size={14} />,
  aeon: <LayoutDashboard size={14} />,
  desktop: <Monitor size={14} />,
  terminal: <TerminalSquare size={14} />,
  browser: <Globe size={14} />,
  box: <SquareTerminal size={14} />,
  files: <FolderTree size={14} />,
  git: <GitBranch size={14} />,
  skills: <Sparkles size={14} />,
  telegram: <Send size={14} />,
  tasks: <CalendarClock size={14} />,
  manage: <Settings2 size={14} />,
};
const TABS: { id: Tab }[] = AGENT_SURFACE_IDS.map((id) => ({ id }));
const GROUP_ICONS: Record<AgentSurfaceGroupId, React.ReactNode> = {
  work: <MessageSquareText size={14} />,
  computer: <Computer size={14} />,
  manage: <Settings2 size={14} />,
};
const WORK_PANE_ID = "agent-work-pane";
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The sidebar, ⌘K and Home reuse a list of agents read moments ago. After a
 * change made here (a delete, a stop, a rename) that list is out of date, and
 * Home would offer to continue in an agent just deleted.
 */
function listChanged(): void {
  resourceInventory.invalidate("hivra");
}

/**
 * The surface a page opens on: a ?tab= deep link (e.g. the dashboard
 * checklist's "connect Telegram" item), then a fresh launch's conversation,
 * then the surface you last left THIS agent on. Never another agent's: a
 * remembered view used to be shared by every agent, so using one agent's
 * command line opened the next agent on its command line too, which on an
 * older computer can start a session nobody asked for. Anything else lands on
 * Chat, which `shownTab` turns into the resource's own landing view.
 */
function openingTab(id: string, requested: string | null | undefined, welcome: boolean): Tab {
  if (requested && TABS.some((t) => t.id === requested)) return requested as Tab;
  if (welcome) return "chat";
  return lastTabFor(hivraRuntimeUid(id)) ?? "chat";
}

/**
 * The surface actually shown for `tab`. A tab the resource does not have (a
 * stale link, a surface removed since) falls back to its landing view: a
 * computer's desktop (Manage for a terminal-only sandbox or one with no
 * desktop yet), a dashboard agent's dashboard, and everyone else's Chat.
 */
function shownTab(agent: HivraAgent, tab: Tab): Tab {
  const def = catalogAgent(agent.type);
  const surfaces = agentSurfacesFor(agent);
  if (def?.surface === "computer") {
    // gVisor sandboxes are terminal-only: they have no desktop to land on, so
    // they open on Manage. Every other computer defers to the shared landing
    // decision rather than hardcoding "desktop" a second time.
    if (agent.computer_substrate === "gvisor") return "manage";
    if (surfaces.includes(tab)) return tab;
    const landing = resolveResourceLanding({
      source: "hivra",
      type: agent.type,
      computerProfile: agent.computer_profile,
      status: agent.status,
      chatUrl: agent.chat_url,
      surfaceKind: def.surface,
      resourceKind: def.resourceKind,
    });
    return landing.landing === "desktop" ? "desktop" : "manage";
  }
  if (surfaces.includes(tab)) return tab;
  // Dashboard agents have no "chat" tab, so the default falls back to the
  // dashboard surface. A stale or shared link can name a surface a CLI agent
  // lacks (Desktop, Dashboard); land on Chat rather than an empty pane.
  return def?.surface === "dashboard" ? "aeon" : "chat";
}

function Stub({ title, body }: { title: string; body: string }) {
  return (
    <div className={styles.statusPanel}>
      <div className="serif" style={{ fontSize: 22, fontWeight: 400, color: "var(--ink-black)", marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 13, maxWidth: 440, margin: "0 auto", lineHeight: 1.6 }}>{body}</div>
    </div>
  );
}

function CanonicalizeUnavailableTab({
  unavailableTab,
  canonicalTab,
}: {
  unavailableTab: Tab | null;
  canonicalTab: Tab;
}) {
  useEffect(() => {
    if (!unavailableTab) return;
    const nextURL = new URL(window.location.href);
    // Do not overwrite a newer selection if navigation changed after render.
    if (nextURL.searchParams.get("tab") !== unavailableTab) return;
    nextURL.searchParams.set("tab", canonicalTab);
    window.history.replaceState(null, "", `${nextURL.pathname}${nextURL.search}${nextURL.hash}`);
  }, [canonicalTab, unavailableTab]);
  return null;
}

type SurfacePermission = "clipboard-read" | "clipboard-write" | "fullscreen";

function AuthenticatedSurface({
  url,
  token,
  label,
  description,
  background,
  permissions,
  onManage,
  surfaceId,
  active = true,
}: {
  url: string;
  token: string;
  label: string;
  description?: string;
  background: string;
  permissions?: readonly SurfacePermission[];
  onManage: () => void;
  /** Slot this surface publishes under, and whether it is the visible one. */
  surfaceId?: string;
  active?: boolean;
}) {
  const frameName = `hivra-surface-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const formRef = useRef<HTMLFormElement>(null);
  const newTabFormRef = useRef<HTMLFormElement>(null);
  const [probeVersion, setProbeVersion] = useState(0);
  const [access, setAccess] = useState<{
    key: string;
    token: string;
    status: "ready" | "upgrade-required" | "unavailable";
  } | null>(null);
  let bootstrapUrl = "";
  let metadataUrl = "";
  let destination = "";
  let surfaceOrigin = "";
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.searchParams.has("token") ||
      /[\s;*'"]/.test(parsed.origin)
    ) {
      throw new Error("A clean HTTPS surface endpoint is required.");
    }
    surfaceOrigin = parsed.origin;
    bootstrapUrl = `${parsed.origin}/auth/bootstrap`;
    metadataUrl = `${parsed.origin}/api/meta`;
    destination = `${parsed.pathname}${parsed.search}`;
  } catch {
    // A malformed stored surface URL must fail closed instead of navigating.
  }
  // With no src attribute, bare feature names target the initial document's
  // origin, not the guest reached by POST. Scope each permission to the same
  // validated guest origin used for bootstrap, never a wildcard or legacy
  // allowfullscreen grant that could follow navigation to another origin.
  const permissionsPolicy = surfaceOrigin && permissions?.length
    ? permissions.map((feature) => `${feature} ${surfaceOrigin}`).join("; ")
    : undefined;
  const probeKey = `${metadataUrl}:${probeVersion}`;
  const missingToken = !token;
  const accessStatus = !metadataUrl || missingToken
    ? "unavailable"
    : access?.key === probeKey && access.token === token ? access.status : "checking";

  useEffect(() => {
    if (!metadataUrl || !token) return;
    const controller = new AbortController();
    let cancelled = false;
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    // Provider ownership says nothing about the installed gateway protocol.
    // Probe nonsecret runtime metadata before sending any bearer. An old or
    // unreachable runtime must never fall back to putting it in a URL.
    void fetch(metadataUrl, { cache: "no-store", credentials: "omit", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Runtime metadata is unavailable.");
        const metadata: unknown = await response.json();
        if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
          throw new Error("Runtime metadata is invalid.");
        }
        const record = metadata as Record<string, unknown>;
        const status = record.surfaceAuth === "post-cookie-v1"
          ? "ready"
          : typeof record.agentKind === "string" ? "upgrade-required" : "unavailable";
        if (!cancelled) setAccess({ key: probeKey, token, status });
      })
      .catch(() => {
        if (!cancelled) setAccess({ key: probeKey, token, status: "unavailable" });
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [metadataUrl, probeKey, token]);

  useEffect(() => {
    if (accessStatus !== "ready" || !bootstrapUrl || !destination || !token) return;
    formRef.current?.requestSubmit();
  }, [accessStatus, bootstrapUrl, destination, token]);

  const openInNewTab = useCallback(() => {
    const form = newTabFormRef.current;
    if (accessStatus !== "ready" || !form || !bootstrapUrl || !destination || !token) return;
    form.requestSubmit();
  }, [accessStatus, bootstrapUrl, destination, token]);

  // "Open in new tab" is the everyday action of this surface, so it belongs in
  // the bar with the rest of the chrome rather than in a strip of its own. The
  // button below still drives the same hidden form — the behaviour does not
  // move, only which row draws it. It renders inline when nothing received the
  // publish (a standalone render, or this surface not being the active one).
  const openInNewTabActions = useMemo(
    () => [
      {
        id: "open-in-new-tab",
        label: "Open in new tab",
        icon: "external-link" as const,
        onSelect: openInNewTab,
        disabled: accessStatus !== "ready",
      },
    ],
    [openInNewTab, accessStatus],
  );
  const { published: actionsLifted } = useSurfaceAction(
    surfaceId,
    active,
    openInNewTabActions,
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {accessStatus === "ready" ? (
        <>
          <form ref={formRef} action={bootstrapUrl} method="POST" target={frameName} style={{ display: "none" }}>
            <input type="hidden" name="token" value={token} />
            <input type="hidden" name="destination" value={destination} />
          </form>
          <form ref={newTabFormRef} action={bootstrapUrl} method="POST" target="_blank" rel="noopener noreferrer" style={{ display: "none" }}>
            <input type="hidden" name="token" value={token} />
            <input type="hidden" name="destination" value={destination} />
          </form>
        </>
      ) : null}
      {/* No strip when there is nothing of its own to say.
          `{description || label}` restated the agent name (already in the bar's
          identity cluster) and the surface name (already the active tab), so on
          the terminal and dashboard tabs this row was pure echo. It still
          renders when the host passes a real `description` — the live browser's
          read-only note is information, not decoration — and whenever the action
          was not lifted, because then the button needs somewhere to live. */}
      {description || !actionsLifted ? (
        <div className={styles.surfaceToolbar}>
          {description ? <span className={`mono ${styles.surfaceDescription}`}>{description}</span> : null}
          <div style={{ flex: 1 }} />
          {actionsLifted ? null : (
            <button type="button" onClick={openInNewTab} disabled={accessStatus !== "ready"} aria-label="Open in new tab" className={`mono ${styles.newTabButton}`}>
              <span>Open in new tab</span><ExternalLink size={13} aria-hidden="true" />
            </button>
          )}
        </div>
      ) : null}
      {accessStatus === "ready" ? (
        <iframe name={frameName} title={label} allow={permissionsPolicy} style={{ flex: 1, minHeight: 0, width: "100%", border: 0, background }} />
      ) : (
        <div className={styles.statusPanel} role="status">
          {accessStatus === "checking" ? <Loader2 size={20} style={{ animation: "spin 1s linear infinite", marginBottom: 12 }} /> : null}
          <div className="serif" style={{ fontSize: 22, color: "var(--ink-black)", marginBottom: 8 }}>
            {accessStatus === "checking" ? "Connecting securely…" : accessStatus === "upgrade-required" ? "Connection update needed" : "Couldn’t verify secure access"}
          </div>
          <p style={{ fontSize: 13, maxWidth: 460, margin: "0 auto", lineHeight: 1.6 }}>
            {accessStatus === "checking"
              ? "Checking this computer’s connection service."
              : accessStatus === "upgrade-required"
                ? "This computer uses an older connection service. It needs a runtime update before this surface can be opened securely. Your computer and its data are unchanged."
                : missingToken
                  ? "Secure access credentials for this computer aren’t available in the dashboard yet. Open Manage and choose Update & restart, then try Terminal or Files again. Your computer and its files are unchanged."
                  : "The computer’s connection service isn’t reachable yet. Check its status in Manage, then try again."}
          </p>
          {accessStatus === "upgrade-required" ? (
            <p style={{ fontSize: 13, maxWidth: 460, margin: "12px auto 0", lineHeight: 1.6 }}>
              Open Manage and choose <strong>Update &amp; restart</strong>. Hivra refreshes the connection service without deleting your computer, files, or agent login.
            </p>
          ) : null}
          {accessStatus !== "checking" ? (
            <div style={{ display: "flex", justifyContent: "center", gap: 10, flexWrap: "wrap", marginTop: 18 }}>
              <button type="button" onClick={onManage} className="mono" style={{ border: "1px solid var(--etched-border)", background: "var(--bg-surface)", color: "var(--ink-black)", padding: "9px 14px", cursor: "pointer" }}>
                Open Manage
              </button>
              <button type="button" onClick={() => setProbeVersion((version) => version + 1)} className="mono" style={{ border: "1px solid var(--etched-border)", background: "var(--bg-surface)", color: "var(--ink-black)", padding: "9px 14px", cursor: "pointer" }}>
                {accessStatus === "upgrade-required" ? "Check again" : "Try again"}
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function TerminalView({ url, token, label, onManage, surfaceId, active = true }: { url: string; token: string; label: string; onManage: () => void; surfaceId?: string; active?: boolean }) {
  return <AuthenticatedSurface url={url} token={token} label={label} background="#000" onManage={onManage} surfaceId={surfaceId} active={active} />;
}

// Each ttyd websocket spawns its own process on the box, so every extra frame
// is an independent shell (or agent CLI) running alongside the others. The cap
// bounds how many CLIs one page can start on a small box.
const MAX_TERMINAL_SESSIONS = 8;

function RetainedTerminal({ active, surfaceId, label, ...surface }: { active: boolean; surfaceId?: string; url: string; token: string; label: string; onManage: () => void }) {
  const [opened, setOpened] = useState(active);
  const [sessions, setSessions] = useState<number[]>([1]);
  const [current, setCurrent] = useState(1);
  const nextSessionRef = useRef(2);
  // Lazily open once, then preserve this browsing context between tab changes.
  // Navigating an active ttyd frame can be cancelled by its beforeunload guard;
  // reusing it would show one shell under the other terminal's heading.
  if (active && !opened) setOpened(true);
  if (!opened && !active) return null;
  const addSession = () => {
    if (sessions.length >= MAX_TERMINAL_SESSIONS) return;
    const n = nextSessionRef.current++;
    setSessions((prev) => [...prev, n]);
    setCurrent(n);
  };
  // Removing a frame closes its websocket, which ends that session's process.
  const closeSession = (n: number) => {
    const index = sessions.indexOf(n);
    const next = sessions.filter((s) => s !== n);
    if (!next.length) return;
    setSessions(next);
    if (n === current) setCurrent(next[Math.max(0, index - 1)]);
  };
  return (
    <div hidden={!active} inert={!active} className={styles.terminalStack}>
      <div role="tablist" aria-label={`${label} sessions`} className={styles.sessionStrip}>
        {sessions.map((n) => (
          <div key={n} className={styles.sessionTab} data-active={n === current ? "true" : undefined}>
            <button type="button" role="tab" aria-selected={n === current} aria-controls={`${surfaceId || "terminal"}-session-${n}`} onClick={() => setCurrent(n)} className="mono">
              Session {n}
            </button>
            {sessions.length > 1 ? (
              <button type="button" aria-label={`Close session ${n}`} title="Close — ends this session's process" onClick={() => closeSession(n)} className={styles.sessionClose}>
                <X size={12} aria-hidden="true" />
              </button>
            ) : null}
          </div>
        ))}
        <button type="button" aria-label="New terminal session" title={sessions.length >= MAX_TERMINAL_SESSIONS ? `Up to ${MAX_TERMINAL_SESSIONS} sessions` : "New session"} disabled={sessions.length >= MAX_TERMINAL_SESSIONS} onClick={addSession} className={styles.sessionAdd}>
          <Plus size={13} aria-hidden="true" />
        </button>
      </div>
      {sessions.map((n) => (
        <div key={n} id={`${surfaceId || "terminal"}-session-${n}`} role="tabpanel" hidden={n !== current} className={styles.sessionPanel}>
          <TerminalView {...surface} label={n === 1 ? label : `${label} · ${n}`} surfaceId={surfaceId} active={active && n === current} />
        </div>
      ))}
    </div>
  );
}

// Embedded web dashboard (Aeon) — the box hosts a Next.js app on a loopback
// port; the box's token-gated proxy fronts it under /aeon. Rendered in an iframe
// just like the terminal/browser surfaces.
function DashboardView({ url, token, label, onManage, surfaceId, active = true }: { url: string; token: string; label: string; onManage: () => void; surfaceId?: string; active?: boolean }) {
  return <AuthenticatedSurface url={url} token={token} label={label} background="var(--bg-surface)" permissions={["clipboard-read", "clipboard-write"]} onManage={onManage} surfaceId={surfaceId} active={active} />;
}

// Live browser — the agent's real Chrome (headful on the box's Xvfb), streamed
// over noVNC through the box tunnel. This legacy surface has no shared session
// input fence, so default its viewer to read-only instead of implying that the
// agent has paused or that conflict-free takeover is available.
function BrowserView({ url, token, onManage, surfaceId, active = true }: { url: string; token: string; onManage: () => void; surfaceId?: string; active?: boolean }) {
  return <AuthenticatedSurface url={url} token={token} label="Live browser" description="Live browser · read-only view of the agent's Chrome. Conflict-free human takeover isn't available on this legacy surface." background="#000" permissions={["fullscreen"]} onManage={onManage} surfaceId={surfaceId} active={active} />;
}

function BrowserDisabledView({
  isFreePlan,
  onManage,
  onUpgrade,
}: {
  isFreePlan: boolean;
  onManage: () => void;
  onUpgrade: () => void;
}) {
  const body = isFreePlan
    ? "Upgrade to Pro or above to enable the live browser."
    : "Turn it on in Manage to open the live browser.";
  const button = isFreePlan ? (
    <button
      type="button"
      onClick={onUpgrade}
      className="mono"
      style={{ border: "1px solid var(--ink-black)", background: "var(--ink-black)", color: "var(--bg-surface)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 800, padding: "9px 14px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 7 }}
    >
      <Settings2 size={14} /> Upgrade to Pro
    </button>
  ) : (
    <button
      type="button"
      onClick={onManage}
      className="mono"
      style={{ border: "1px solid var(--ink-black)", background: "var(--ink-black)", color: "var(--bg-surface)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 800, padding: "9px 14px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 7 }}
    >
      <Settings2 size={14} /> Open Manage
    </button>
  );

  return (
    <div className={styles.statusPanel}>
      <div className="serif" style={{ fontSize: 22, fontWeight: 400, color: "var(--ink-black)", marginBottom: 6 }}>
        Browser automation is off
      </div>
      <div style={{ fontSize: 13, maxWidth: 440, margin: "0 auto 16px", lineHeight: 1.6 }}>
        {body}
      </div>
      {button}
    </div>
  );
}

function ProvisioningPersonalizationPanel({ agent }: { agent: HivraAgent }) {
  const storedDraft = parseWelcomePersonalizationContext(agent.context);
  const [draft, setDraft] = useState<WelcomePersonalizationDraft>({
    goal: agent.goal || (agent.type === "claude-code" ? "build" : "assist"),
    context: storedDraft.context,
    firstTask: agent.first_task || storedDraft.firstTask,
    who: storedDraft.who,
    business: storedDraft.business,
    goals: storedDraft.goals,
  });
  const saveTimerRef = useRef<number | null>(null);
  const dirtyRef = useRef(false);

  const updateDraft = (update: (current: WelcomePersonalizationDraft) => WelcomePersonalizationDraft) => {
    dirtyRef.current = true;
    setDraft(update);
  };

  useEffect(() => {
    if (!dirtyRef.current) return;
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      void fetch(`/api/hivra/agents/${agent.id}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "onboarding",
          goal: draft.goal,
          context: buildWelcomePersonalizationContext(draft),
          firstTask: draft.firstTask,
        }),
      }).catch((error) => {
        clientLog.warn("Hivra provisioning personalization save failed", {
          source: "hivra-agent-page",
          route: "/api/hivra/agents/[id]/action",
          failureType: "hivra_provisioning_personalization_save_failed",
          agentId: agent.id,
          agentType: agent.type,
        }, error);
      });
    }, 500);
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    };
  }, [agent.id, agent.type, draft]);

  return (
    <div style={{ maxWidth: 560, margin: "22px auto 0", border: "1px solid var(--etched-border)", background: "var(--bg-surface)", padding: 16, display: "grid", gap: 12, textAlign: "left" }}>
      <div>
        <span className="mono" style={{ ...labelStyle, color: "var(--text-secondary)" }}>While you wait</span>
        <p style={{ margin: "4px 0 0", fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.45 }}>
          Shape the first conversation so {agent.name} can get useful faster.
        </p>
      </div>
      <label style={{ display: "grid", gap: 6 }}>
        <span className="mono" style={labelStyle}>Focus</span>
        <select
          value={draft.goal || "assist"}
          onChange={(event) => updateDraft((current) => ({ ...current, goal: event.target.value }))}
          className={styles.personalizationField}
        >
          {GOALS.map((goal) => (
            <option key={goal.id} value={goal.id}>{goal.label}</option>
          ))}
        </select>
      </label>
      <label style={{ display: "grid", gap: 6 }}>
        <span className="mono" style={labelStyle}>Context</span>
        <textarea
          value={draft.context || ""}
          onChange={(event) => updateDraft((current) => ({ ...current, context: event.target.value }))}
          placeholder="What should it know about you, your work, or this project?"
          rows={3}
          className={styles.personalizationField}
        />
      </label>
      <label style={{ display: "grid", gap: 6 }}>
        <span className="mono" style={labelStyle}>First task</span>
        <input
          value={draft.firstTask || ""}
          onChange={(event) => updateDraft((current) => ({ ...current, firstTask: event.target.value }))}
          placeholder="What should it help you do first?"
          enterKeyHint="done"
          className={styles.personalizationField}
        />
      </label>
    </div>
  );
}

export default function AgentPage() {
  const { enabled: nativeWorkspace } = useNativeWorkspace();
  const router = useRouter();
  const searchParams = useSearchParams();
  const params = useParams();
  // One registry per agent page. Never a module singleton: a route change or a
  // reused module in a test must not carry another page's actions over.
  const actionStore = useSurfaceActionStoreInstance();
  const id = (params?.id as string) || "";
  const launchWelcome = searchParams?.get("welcome") === "1";
  const [flagOn, setFlagOn] = useState<boolean | null>(ENV_FLAG ? true : null);
  const [agent, setAgent] = useState<HivraAgent | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [statusObservation, setStatusObservation] = useState<{
    agentId: string;
    receivedAt: number;
    unavailable: boolean;
  } | null>(null);
  // Lazy initializer keeps it SSR-safe: the server has no recents and the tab
  // value doesn't affect the loading render, so there's no hydration flash.
  const [tab, setTab] = useState<Tab>(() => openingTab(id, searchParams?.get("tab"), launchWelcome));
  const requestedTab = searchParams?.get("tab");
  // Another agent in the same page instance starts from its own opening tab,
  // not from the surface the previous agent was left on.
  const [tabAgentId, setTabAgentId] = useState(id);
  if (tabAgentId !== id) {
    setTabAgentId(id);
    setTab(openingTab(id, requestedTab, launchWelcome));
  }
  const [lastRequestedTab, setLastRequestedTab] = useState(requestedTab);
  // Reconcile a changed deep link before committing a stale surface.
  if (requestedTab !== lastRequestedTab) {
    setLastRequestedTab(requestedTab);
    if (requestedTab && TABS.some((candidate) => candidate.id === requestedTab)) {
      setTab(requestedTab as Tab);
    }
  }
  // Chat turns are tied to the open request, so unmounting the chat would stop
  // every running conversation. Once opened, keep it mounted (hidden) while the
  // owner works in other surfaces so parallel chats keep doing their work.
  const [chatOpened, setChatOpened] = useState(false);
  const [browserOn, setBrowserOn] = useState<boolean | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const chatReadiness = useChatReadiness(id, agent?.id === id ? agent.status : undefined, agent?.chat_url, agent?.type, agent?.api_token, reloadKey);
  const loggedIn = chatReadiness === null ? null : chatReadiness === "native_connected" || chatReadiness === "provider_configured";
  const [planResult, setPlanResult] = useState<{ value: PlanInfo | null; agentId: string; version: number } | null>(null);
  const plan = planResult?.agentId === id && planResult.version === reloadKey ? planResult.value : null;
  // Free-plan browser lock → the shared upgrade paywall (instead of a dead-end button).
  const [paywallOpen, setPaywallOpen] = useState(false);
  const timerRef = useRef<number | null>(null);
  const loggedFailureRef = useRef<string | null>(null);
  // Latest agent for the poll loop, so a transient fetch failure can tell
  // "never loaded" apart from "loaded fine before this blip".
  const agentRef = useRef<HivraAgent | null>(null);
  const capabilityPrefetchRef = useRef<string | null>(null);
  useEffect(() => {
    agentRef.current = agent;
  }, [agent]);
  useEffect(() => {
    capabilityPrefetchRef.current = null;
  }, [id]);

  // Read the window-based Hivra flag only after hydration. A build-time true is
  // already authoritative; otherwise server and client both start unresolved
  // and render neutral feedback until the live hostname / ?hivra=1 check runs.
  // Reading the hostname in a lazy initializer would make preview deployments
  // render differently on the server and client and cause a hydration mismatch.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Deliberate post-hydration flip of a render-gating flag; see comment above.
    setFlagOn(isHivraEnabled());
  }, []);

  useEffect(() => {
    let alive = true;
    void fetchPlanStrict().then((value) => {
      if (alive) setPlanResult({ value, agentId: id, version: reloadKey });
    });
    return () => { alive = false; };
  }, [id, reloadKey]);

  // For browser-capable agents, learn the box's live browser-automation state
  // (drives the Browser tab visibility + the Manage toggle + the resize floor).
  useEffect(() => {
    if (agent?.status === "running" && agent.chat_url && catalogAgent(agent.type)?.browser && browserOn === null) {
      void browserStatus(agent.chat_url, agent.api_token).then((s) => {
        if (s.error) {
          clientLog.warn("Browser status probe failed", {
            source: "hivra-agent-page",
            route: "/dashboard/agent/[id]",
            instanceId: agent.id,
            agentType: agent.type,
            status: agent.status,
            error: s.error,
          });
        }
        setBrowserOn(s.enabled);
      });
    }
  }, [agent, browserOn]);

  useEffect(() => {
    if (agent?.status !== "error") return;
    const logKey = `${agent.id}:${agent.error || ""}`;
    if (loggedFailureRef.current === logKey) return;
    loggedFailureRef.current = logKey;
    clientLog.warn("Hivra agent provisioning failed", {
      source: "hivra-agent-page",
      route: "/dashboard/agent/[id]",
      instanceId: agent.id,
      agentType: agent.type,
      status: agent.status,
      vmid: agent.vmid ?? null,
      proxmoxHost: agent.proxmox_host ?? null,
      hasChatUrl: Boolean(agent.chat_url),
      error: agent.error || null,
    });
  }, [agent]);

  // Load + poll while provisioning. getAgent returns null for BOTH "not found"
  // and transient failures (network blip, cold start, auth hiccup) — a single
  // null used to wipe the agent to "Agent not found" AND stop the poll loop,
  // stranding the row in "provisioning" with the box already converged. Keep
  // the last known agent on a blip and keep polling; only show "not found"
  // after the initial load fails repeatedly.
  useEffect(() => {
    let alive = true;
    let initialFailures = 0;
    const tick = async () => {
      const a = await getAgent(id);
      if (!alive) return;
      if (a) {
        initialFailures = 0;
        setAgent(a);
        setStatusObservation({ agentId: id, receivedAt: Date.now(), unavailable: false });
        setLoaded(true);
        if (a.status === "provisioning") {
          timerRef.current = window.setTimeout(tick, 5000);
        }
        return;
      }
      const last = agentRef.current;
      if (last?.id === id) {
        setStatusObservation((previous) => previous?.agentId === id
          ? { ...previous, unavailable: true }
          : null);
        // Transient blip: keep the stale agent rendered; keep polling if the
        // flip is what we're waiting on.
        if (last.status === "provisioning") {
          timerRef.current = window.setTimeout(tick, 5000);
        }
        return;
      }
      initialFailures += 1;
      if (initialFailures < 3) {
        timerRef.current = window.setTimeout(tick, 2000);
        return;
      }
      setAgent(null);
      setLoaded(true);
    };
    void tick();
    return () => {
      alive = false;
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [id, reloadKey]);

  const go = useCallback(
    (path: string) => router.push(`${path}${ENV_FLAG ? "" : "?hivra=1"}`),
    [router],
  );

  // Keep the current surface in the shareable URL without reloading its
  // retained sessions or adding a Back entry for every local tab click.
  const selectTab = useCallback((t: Tab) => {
    setTab(t);
    const nextURL = new URL(window.location.href);
    nextURL.searchParams.set("tab", t);
    window.history.replaceState(null, "", `${nextURL.pathname}${nextURL.search}${nextURL.hash}`);
  }, []);

  // Remember this agent and the surface actually on screen, so Home can offer
  // it back ("Pick up where you left off") and the switchers can list it under
  // Recent and reopen it where you were. Only once the agent has loaded here:
  // an unknown or unavailable page is not somewhere to return to. A
  // DigitalOcean session keeps its own views and opens on its chat. Recording
  // cannot navigate: Home follows it only when the app itself opens at Home.
  const visitTab: Tab | null = flagOn && agent && agent.id === id
    ? agent.computer_substrate === "do-managed-session" ? "chat" : shownTab(agent, tab)
    : null;
  useRecordVisit(id ? hivraRuntimeUid(id) : null, visitTab);

  // Read-only capability refresh once per computer id/session.
  // Do not stack page + Desktop double-fire (shared refresh quota ~8/15m).
  // Never prepare — Omarchy autoPrepare stays prepare=1 only.
  useEffect(() => {
    if (!agent || agent.status !== "running" || agent.id !== id) return;
    if (catalogAgent(agent.type)?.surface !== "computer") return;
    if (agent.computer_substrate === "gvisor") return;
    if (capabilityPrefetchRef.current === agent.id) return;
    capabilityPrefetchRef.current = agent.id;
    const controller = new AbortController();
    void fetch(`/api/hivra/agents/${encodeURIComponent(agent.id)}/remote-desktop`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "refresh" }),
      signal: controller.signal,
      keepalive: true,
    }).catch(() => {});
    return () => controller.abort();
  }, [agent, id]);

  if (flagOn === null) {
    return <LoadingState label="Checking availability…" />;
  }
  if (!flagOn) {
    return <div className={styles.statusPanel}>This preview isn&apos;t enabled here.</div>;
  }
  if (loaded && !agent) {
    return (
      <div className={styles.statusPanel}>
        <div className="serif" style={{ fontSize: 22, color: "var(--ink-black)", marginBottom: 14 }}>Agent not found.</div>
        <button type="button" onClick={() => go("/dashboard")} className="mono" style={{ border: "1px solid var(--ink-black)", background: "var(--ink-black)", color: "var(--bg-surface)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 800, padding: "9px 16px", cursor: "pointer" }}>
          Back to Home
        </button>
      </div>
    );
  }
  if (!agent || agent.id !== id) {
    return <LoadingState label="Opening your workspace…" />;
  }
  if (agent.computer_substrate === "do-managed-session") {
    // DigitalOcean runs this agent's sandbox; Hivra is its chat and control
    // surface, with its own Chat, Files and Manage views. The computer tabs
    // (Terminal, Browser, Git) and Skills do not apply.
    return <DigitalOceanAgentWorkspace agentId={agent.id} firstTask={agent.first_task} onDeleted={() => { listChanged(); go("/dashboard"); }} />;
  }

  const def = catalogAgent(agent.type);
  const accent = def?.accent || "var(--gold-leaf)";
  const cliKind = def?.cliKind ?? "claude";
  const isDashboard = def?.surface === "dashboard";
  const isComputer = def?.surface === "computer";
  const providerWorkspace = agent.computer_substrate === "provider-vm" && agent.type === "linux-desktop"
    && agent.computer_profile === "ubuntu-desktop";
  // For a computer, a running lifecycle record plus its provisioned chat_url
  // is the durable workspace capability signal (agentSurfacesFor). The
  // surfaces handle transient gateway outages themselves so navigation does
  // not appear and disappear with live probes.
  const computerTabs: Tab[] = isComputer ? agentSurfacesFor(agent) : [];
  const tabs = agentSurfacesFor(agent).map((id) => ({
    id,
    // A computer's own shell is just "Terminal"; an agent's CLI is its session.
    label: agentSurfaceLabel(id, def),
    icon: TAB_ICONS[id],
  }));
  // Agent pages group their surfaces: Chat · Computer (Terminal, Files,
  // Browser, Git) · Manage. Computers keep their short flat list.
  const surfaceGroups = isComputer ? undefined : agentSurfaceGroups(tabs.map((t) => t.id), def).map((group) => ({
    id: group.id,
    label: group.label,
    icon: group.id === "work" && isDashboard ? TAB_ICONS.aeon : GROUP_ICONS[group.id],
    surfaces: group.surfaces,
  }));
  // One shared decision with the workspace: resource-landing owns "what does
  // this resource open on", so the two routes cannot drift apart again.
  const landing = resolveResourceLanding({
    source: "hivra",
    type: agent.type,
    computerProfile: agent.computer_profile,
    status: agent.status,
    chatUrl: agent.chat_url,
    surfaceKind: def?.surface,
    resourceKind: def?.resourceKind,
  });
  const effectiveTab: Tab = shownTab(agent, tab);
  const requestedKnownTab = requestedTab && TABS.some((t) => t.id === requestedTab) ? requestedTab as Tab : null;
  const unavailableTab = isComputer
    ? COMPUTER_WORKSPACE_TABS.includes(requestedTab as Tab)
      && !computerTabs.includes(requestedTab as Tab)
        ? requestedTab as Tab
        : null
    : requestedKnownTab && !tabs.some((t) => t.id === requestedKnownTab) ? requestedKnownTab : null;
  const provisioning = agent.status === "provisioning";
  const chatSurfaceReady = !isDashboard && !isComputer && agent.status === "running" && Boolean(agent.chat_url)
    && chatReadiness !== "upgrade_required" && chatReadiness !== "unavailable" && loggedIn === true;
  if (effectiveTab === "chat" && chatSurfaceReady && !chatOpened) setChatOpened(true);
  const activity = agentActivityPresentation(agent, def?.name || "the agent");
  // Every surface verifies the running gateway's auth capability, then POSTs
  // its bearer in the body for an opaque HttpOnly cookie and clean URL.
  // Provider ownership is not a proxy for the installed runtime protocol.
  const tok = agent.api_token || "";
  const isFreePlan = agent.deployment_mode !== "self-managed" && Boolean(plan && (!plan.subscribed || plan.key === "free"));
  const managePanel = (
    <HivraManage
      agent={agent}
      def={def}
      plan={plan}
      onChanged={() => { listChanged(); setReloadKey((k) => k + 1); }}
      onDestroyed={() => { listChanged(); go(isComputer ? "/dashboard/computers" : "/dashboard"); }}
      browserOn={browserOn}
      onBrowserChange={(e) => setBrowserOn(e)}
    />
  );

  return (
    <SurfaceActionProvider store={actionStore}>
    <div className={styles.workspace} style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, position: "relative", zIndex: 1, maxWidth: "100%" }}>
      <CanonicalizeUnavailableTab
        unavailableTab={unavailableTab}
        canonicalTab={effectiveTab}
      />
      {/* Keep identity, switching and work surfaces together. Native chrome owns
          identity on native clients; the existing session components stay below. */}
      <ResourceSurfaceNavigation
        surfaces={tabs}
        groups={surfaceGroups}
        panelId={WORK_PANE_ID}
        // The linked pair, where the owner is looking at the computer.
        groupNotes={isComputer ? undefined : { computer: `${capitalize(agentComputerPairLabel(agent))}` }}
        active={effectiveTab}
        onSelect={selectTab}
        exportHref={agent.status === "running" && !isComputer ? `/api/hivra/agents/${agent.id}/export` : undefined}
        identity={
          nativeWorkspace ? undefined : (
            <div className={styles.identity}>
              <ResourceSwitcher currentUid={agent.id} name={`${agent.emoji ? `${agent.emoji} ` : ""}${agent.name}`} kind={isComputer ? "computer" : "agent"} status={provisioning ? activity.label : agent.status} />
            </div>
          )
        }
      />

      {/* Post-deploy channel nudge: fresh welcome landings with no Telegram
          connected get a one-line pointer to the Telegram tab (the component
          gates itself on ?welcome=1 + probe + per-box dismiss). Hidden while
          already on the Telegram tab and for dashboard-surface agents (no
          Telegram tab to point at). */}
      {agent.status === "running" && agent.chat_url && !isDashboard && !isComputer && effectiveTab !== "telegram" ? (
        <ChannelConnectNudge
          boxUrl={agent.chat_url}
          token={agent.api_token}
          boxId={agent.id}
          onConnect={() => selectTab("telegram")}
        />
      ) : null}

      <div id={WORK_PANE_ID} className={styles.workPane} style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {/* A desktop session is expensive to establish and is revoked when this
            page closes, so keep it mounted (hidden) while the owner switches
            among local surfaces. Only computers have a desktop. */}
        {isComputer && agent.status === "running" ? (
          agent.computer_profile === "omarchy" ? (
            <HivraOmarchyDesktop computerId={agent.id} name={agent.name}
              active={effectiveTab === "desktop"}
              autoPrepare={isComputer && searchParams?.get("prepare") === "1"}
              handoffWarmOrigin={(() => { try { return agent.chat_url ? new URL(agent.chat_url).origin : null; } catch { return null; } })()} />
          ) : agent.computer_profile === "windows" ? (
            <HivraConsoleDesktop computerId={agent.id} name={agent.name}
              profile={agent.computer_profile} active={effectiveTab === "desktop"}
              autoOpenFast={landing.desktopAutoOpen || searchParams?.get("open") === "fast"} />
          ) : (
            <HivraRemoteDesktop
              computerId={agent.id}
              name={agent.name}
              active={effectiveTab === "desktop"}
              // When the box tunnel is already up, auto-prepare can leave Desktop
              // stuck on "Repairing…" and disrupt Terminal/Files attach needed for
              // cross-path proof. Only auto-prepare computers that cannot attach yet.
              autoPrepare={isComputer && !agent.chat_url}
              handoffWarmOrigin={(() => { try { return agent.chat_url ? new URL(agent.chat_url).origin : null; } catch { return null; } })()}
            />
          )
        ) : null}
        {chatOpened && chatSurfaceReady && agent.chat_url ? (
          <div hidden={effectiveTab !== "chat"} inert={effectiveTab !== "chat"} style={{ height: "100%", minHeight: 0 }}>
            <HivraChat key={`${agent.id}:${agent.chat_url}:chat`} boxUrl={agent.chat_url} agentName={agent.name} accent={accent} agentKind={cliKind} storageKey={agent.id} token={agent.api_token} goal={agent.goal} context={agent.context} firstTask={agent.first_task} emoji={agent.emoji} instanceId={agent.id} modelLabel={agent.llm_config?.model} />
          </div>
        ) : null}
        {agent.status === "running" && agent.chat_url && agent.computer_profile !== "windows" ? (
          <>
            {!isDashboard && !isComputer ? (
              <RetainedTerminal
                key={`${agent.id}:${agent.chat_url}:terminal`}
                active={effectiveTab === "terminal"}
                surfaceId="terminal"
                url={`${agent.chat_url.replace(/\/$/, "")}/terminal/`}
                token={tok}
                label={`${def?.name || "Agent"} session`}
                onManage={() => selectTab("manage")}
              />
            ) : null}
            {providerWorkspace ? <>
              <HivraProviderWorkspace key={`${agent.id}:${agent.chat_url}:workspace-box`} computerId={agent.id}
                boxOrigin={agent.chat_url} surface="box-terminal" active={effectiveTab === "box"} />
              <HivraProviderWorkspace key={`${agent.id}:${agent.chat_url}:workspace-files`} computerId={agent.id}
                boxOrigin={agent.chat_url} surface="files" active={effectiveTab === "files"} />
            </> : <RetainedTerminal
              key={`${agent.id}:${agent.chat_url}:box`}
              active={effectiveTab === "box"}
              surfaceId="box"
              url={`${agent.chat_url.replace(/\/$/, "")}/box-terminal/`}
              token={tok}
              label="Terminal"
              onManage={() => selectTab("manage")}
            />}
          </>
        ) : null}
        {provisioning && agent.computer_profile === "windows" && agent.deployment_mode === "self-managed" ? (
          <div style={{ padding: "clamp(32px, 6vw, 56px) clamp(16px, 4vw, 40px)", maxHeight: "100%", overflowY: "auto", textAlign: "center", color: "var(--text-muted)" }}>
            <div role="status" aria-live="polite">
              <div className="serif" style={{ fontSize: 24, color: "var(--ink-black)", marginBottom: 10 }}>Finish Windows setup on your Proxmox host</div>
              <p style={{ fontSize: 13, maxWidth: 560, margin: "0 auto", lineHeight: 1.65 }}>
                Hivra created and started {agent.vmid ? `VM ${agent.vmid}` : "the Windows setup VM"} with your selected ISO. Open that VM&apos;s Proxmox console to complete Windows installation. Hivra will not collect a product key or bypass activation.
              </p>
              <p style={{ fontSize: 13, maxWidth: 560, margin: "16px auto 0", padding: "14px 16px", border: "1px solid var(--etched-border)", lineHeight: 1.65 }}>
                Automatic guest readiness and customer-host RDP enrolment are not implemented yet. The fast Guacamole/RDP button remains unavailable until that exact guest is separately prepared and verified.
              </p>
            </div>
          </div>
        ) : provisioning && agent.computer_substrate === "provider-vm" && effectiveTab === "manage" ? managePanel : provisioning ? (
          <div style={{ padding: "clamp(32px, 6vw, 56px) clamp(16px, 4vw, 40px)", maxHeight: "100%", overflowY: "auto", textAlign: "center", color: "var(--text-muted)" }}>
            <div role="status" aria-live="polite">
              <Loader2 aria-hidden="true" size={20} style={{ display: "block", margin: "0 auto", animation: "spin 1s linear infinite", color: "var(--gold-leaf)" }} />
              <div className="serif" style={{ fontSize: 24, fontWeight: 400, color: "var(--ink-black)", margin: "14px 0 6px", overflowWrap: "anywhere" }}>{activity.verb} {agent.emoji ? `${agent.emoji} ` : ""}{agent.name}…</div>
              <div style={{ fontSize: 13, maxWidth: 460, margin: "0 auto", lineHeight: 1.6 }}>{activity.body}</div>
              {statusObservation?.agentId === id ? <div
                aria-live="off"
                style={{ fontSize: 12, maxWidth: 460, margin: "16px auto 0", lineHeight: 1.6 }}
              >
                Last status response: <time dateTime={new Date(statusObservation.receivedAt).toISOString()}>
                  {new Date(statusObservation.receivedAt).toLocaleTimeString()}
                </time>. This is a status check, not installation progress.
              </div> : null}
              {statusObservation?.agentId === id && statusObservation.unavailable ? <p
                role="alert"
                style={{ fontSize: 13, maxWidth: 460, margin: "12px auto 0", color: "var(--ink-black)", lineHeight: 1.6 }}
              >Couldn’t get the latest status. Showing the last response and checking again automatically. This does not mean setup failed.</p> : null}
              {agent.computer_substrate === "provider-vm" && providerReadinessMessage(agent.readiness_stage) ? <p
                role={agent.readiness_stage === "verification_unavailable" ? "alert" : undefined}
                style={{ fontSize: 13, maxWidth: 480, margin: "18px auto 0", padding: "14px 16px", border: "1px solid var(--etched-border)", lineHeight: 1.6 }}
              >{providerReadinessMessage(agent.readiness_stage)}</p> : null}
              {agent.computer_substrate === "provider-vm" && providerPowerMessage(agent.power_stage) ? <p
                role={["verification_unavailable", "request_uncertain", "failed"].includes(String(agent.power_stage)) ? "alert" : undefined}
                style={{ fontSize: 13, maxWidth: 480, margin: "18px auto 0", padding: "14px 16px", border: "1px solid var(--etched-border)", lineHeight: 1.6 }}
              >{providerPowerMessage(agent.power_stage)}</p> : null}
            </div>
            {agent.computer_substrate === "provider-vm" ? <button
              type="button"
              onClick={() => selectTab("manage")}
              style={{ display: "inline-flex", alignItems: "center", gap: 8, marginTop: 18, padding: "10px 16px", border: "1px solid var(--etched-border)", background: "var(--bg-surface)", color: "var(--ink-black)", fontSize: 13, cursor: "pointer" }}
            ><Settings2 size={14} /> Open Manage</button> : null}
            {activity.freshLaunch && launchWelcome && !isDashboard && !isComputer ? <ProvisioningPersonalizationPanel agent={agent} /> : null}
          </div>
        ) : effectiveTab === "manage" ? (
          managePanel
        ) : agent.status === "error" ? (
          <Stub title="Provisioning failed" body={agent.error || "Something went wrong bringing up the computer. Destroy it and try again."} />
        ) : effectiveTab === "aeon" ? (
          !agent.chat_url ? (
            <Stub title="Dashboard not reachable" body="The computer is up but its dashboard isn't connected yet. Give it a moment." />
          ) : loggedIn === null && def?.connect === "github" ? (
            <LoadingState compact label="Checking access…" />
          ) : loggedIn || def?.connect !== "github" ? (
            // No GitHub connect step (OpenClaw, Agent Zero — they run ON the box, not
            // on the user's GitHub) → go straight to the embedded dashboard; the box's
            // own gate + auto-login handle access. ONLY Aeon (connect:"github") ever
            // sees HivraGitHubConnect, whose "your Aeon fork" copy is Aeon-specific.
            <DashboardView url={def?.id === "deepseek-harness"
              ? `${agent.chat_url.replace(/\/$/, "")}/`
              : `${agent.chat_url.replace(/\/$/, "")}/${def?.id === "openclaw" ? "openclaw" : def?.id === "agent-zero" ? "agent-zero" : "aeon"}/`}
              token={tok} label={`${def?.name || "Agent"} · dashboard`} surfaceId="aeon" active={effectiveTab === "aeon"} onManage={() => selectTab("manage")} />
          ) : (
            <HivraGitHubConnect boxUrl={agent.chat_url} boxId={agent.id} onDone={() => setReloadKey(k => k + 1)} productName={def?.name} displayName={agent.name} emoji={agent.emoji} token={agent.api_token} defaultManagedCredits={Boolean(agent.managed_venice)} />
          )
        ) : effectiveTab === "chat" ? (
          !agent.chat_url ? (
            <Stub title="Runtime not reachable" body="The computer is up but its chat isn't connected yet. Give it a moment." />
          ) : chatReadiness === "upgrade_required" ? (
            <div className={styles.statusPanel} role="status">
              <h3>This computer needs a Chat update</h3>
              <p style={{ lineHeight: 1.6, color: "var(--text-muted)" }}>Its saved model connection needs a newer Hivra Chat runtime. Your key and files are unchanged. Open Manage and choose Update &amp; restart; you can still use native sign-in in the Codex terminal.</p>
              <button type="button" onClick={() => setReloadKey(k => k + 1)}>Check connection</button>
            </div>
          ) : chatReadiness === "unavailable" ? (
            <div className={styles.statusPanel} role="status">
              <h3>Couldn’t check the model connection</h3>
              <p style={{ lineHeight: 1.6, color: "var(--text-muted)" }}>The computer hasn’t confirmed its connection yet. Check Inference in Manage, or check again. Your saved settings haven’t changed.</p>
              <button type="button" onClick={() => setReloadKey(k => k + 1)}>Check connection</button>
            </div>
          ) : loggedIn === null ? (
            <LoadingState compact label="Checking access…" />
          ) : loggedIn ? null : (
            <HivraLogin boxUrl={agent.chat_url} onDone={() => setReloadKey(k => k + 1)} agentKind={cliKind} productName={def?.name} displayName={agent.name} emoji={agent.emoji} token={agent.api_token} />
          )
        ) : effectiveTab === "desktop" ? (
          agent.status === "running" ? null : <Stub title="Not ready" body="The computer must be running before its desktop can open." />
        ) : effectiveTab === "git" ? (
          agent.chat_url ? <HivraGit boxUrl={agent.chat_url} token={agent.api_token} /> : <Stub title="Not ready" body="The computer isn't reachable yet." />
        ) : effectiveTab === "files" ? (
          providerWorkspace && agent.status === "running" && agent.chat_url ? null
            : agent.chat_url && !providerWorkspace ? <HivraFiles boxUrl={agent.chat_url} token={agent.api_token} workspaceRoot={isComputer} /> : <Stub title="Not ready" body="The computer isn't reachable yet." />
        ) : effectiveTab === "skills" ? (
          agent.chat_url ? <HivraSkills boxUrl={agent.chat_url} token={agent.api_token} /> : <Stub title="Not ready" body="The computer isn't reachable yet." />
        ) : effectiveTab === "telegram" ? (
          agent.chat_url ? <HivraTelegram boxUrl={agent.chat_url} boxId={agent.id} token={agent.api_token} agentName={agent.name} /> : <Stub title="Not ready" body="The computer isn't reachable yet." />
        ) : effectiveTab === "tasks" ? (
          agent.status === "running" ? (
            <TasksPanel
              instanceId={agent.id}
              agentName={agent.name}
              agentStatus={agent.status}
              isFreePlan={isFreePlan}
              currentPlan={plan?.key ?? null}
            />
          ) : (
            <Stub title="Not ready" body="The computer isn't running yet. Scheduled tasks become available once it's online." />
          )
        ) : effectiveTab === "terminal" || effectiveTab === "box" ? (
          agent.status === "running" && agent.chat_url ? null : <Stub title="Not ready" body="The computer isn't reachable yet." />
        ) : effectiveTab === "browser" ? (
          browserOn === false ? (
            <BrowserDisabledView
              isFreePlan={isFreePlan}
              onManage={() => selectTab("manage")}
              onUpgrade={() => setPaywallOpen(true)}
            />
          ) : agent.chat_url ? (
            <BrowserView url={`${agent.chat_url.replace(/\/$/, "")}/vnc/vnc.html?path=vnc/websockify&autoconnect=true&resize=scale&reconnect=true&view_only=true`} token={tok} surfaceId="browser" active={effectiveTab === "browser"} onManage={() => selectTab("manage")} />
          ) : (
            <Stub title="Not ready" body="The computer isn't reachable yet." />
          )
        ) : managePanel}
      </div>

      {paywallOpen ? (
        <UpgradePaywallModal
          feature="browser"
          currentPlan={plan?.key ?? null}
          onClose={() => setPaywallOpen(false)}
        />
      ) : null}
    </div>
    </SurfaceActionProvider>
  );
}
