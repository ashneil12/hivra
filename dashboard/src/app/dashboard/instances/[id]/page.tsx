'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, CalendarClock, ExternalLink, Loader2, PanelRightOpen, Radio, RotateCcw, Send, ServerCog, Sparkles, Terminal as TerminalIcon, X } from "lucide-react";
import posthog from "posthog-js";
import { captureClient } from "@/lib/telemetry/posthog-client";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ShellTerminalWorkspace } from "@/components/ShellTerminalWorkspace";
import { TerminalPanel } from "@/components/TerminalPanel";
import { CodexOAuthModal } from "@/components/console/CodexOAuthModal";
import { FileExplorer } from "@/components/explorer/FileExplorer";
import { AgentSwitcher } from "@/components/instances/AgentSwitcher";
import { SafePortal } from "@/components/ui/SafePortal";
import { ReportProblemLink } from "@/components/support/ReportProblemLink";
import { WebuiIframe } from "@/components/webui/WebuiIframe";
import { InstanceTelegramConnect } from "@/components/instances/InstanceTelegramConnect";
import { InstanceChannelsPanel } from "@/components/instances/InstanceChannelsPanel";
import { CommandPanel } from "@/components/instances/CommandPanel";
import { StorageUsageBanner } from "@/components/storage/StorageUsageBanner";
import { clientLog } from "@/lib/client/logger";
import {
  describeAgentStartFailure,
  getAgentStartFailureTelemetryKey,
  shouldCaptureAgentStartFailure,
} from "@/lib/agent-start-failure";
import { resolveExplorerHome, resolveExplorerRoot } from "@/lib/explorer-home";
import { getRuntimeAgentSettings } from "@/lib/instance-settings";
import { shouldAutoOpenCodexOAuth } from "@/lib/instance-codex-auth";
import {
  getDefaultInstanceSurfacePreference,
  getInstanceSurfaceHref,
  getStoredInstanceSurfacePreference,
} from "@/lib/instance-surface-preference";
import { normalizeSshWarmupMessage } from "@/lib/ssh-warmup";
import type { InstanceFailureAlert } from "@/lib/failure-ownership";
import {
  buildHermesFadeSlideVariants,
  buildHermesOverlayVariants,
  buildHermesSurfaceSpring,
} from "@/components/ui/motion";
import {
  dismissStandingTasksNudge,
  readStandingTasksNudgeDismissed,
} from "@/lib/nudges/standing-tasks-dismissal";
import { fetchPlanStrict, isFreePlanInfo, type PlanInfo } from "@/lib/hivra/agent-api";
import { isSleepUpgradePromptEnabled, isArchiveUpgradeWallEnabled } from "@/lib/flags/upgrade-prompts";
import { SleepWakeUpgradePrompt } from "@/components/billing/SleepWakeUpgradePrompt";
import { ArchiveUpgradeWall } from "@/components/billing/ArchiveUpgradeWall";
import { getArchiveCountdownDays, shouldShowArchiveUpgradeWall } from "@/lib/hivra/archive-countdown";
import { MemoryPauseBanner } from "@/components/instances/MemoryPauseBanner";
import { useRecordVisit } from "@/components/workspace/useRecordVisit";
import { hermesRuntimeUid } from "@/lib/workspace/runtime-selection";

interface Instance {
  id: string;
  name: string;
  status: string;
  lifecycle_state?: string | null;
  // 'inactivity' (paused by the inactivity-sweep cron after 4d/7d idle)
  // or 'ram_cap_hit' (paused by the resource-watchdog cron after a free
  // tier pinned its RAM cap). Drives the wake-on-open and upgrade-prompt
  // UX; see PausedStateBanner below.
  paused_reason?: string | null;
  // Timestamp of the last lifecycle transition (set by the inactivity-sweep when
  // it pauses). For an inactivity-paused free agent this drives the archive
  // countdown (deadline = this + dormant-reclaim window); see archive-countdown.
  last_lifecycle_transition_at?: string | null;
  backend?: "gateway" | "webui" | null;
  provider: string;
  gateway_url: string | null;
  public_ipv4?: string | null;
  infrastructure_provider?: string | null;
  host_id?: string | null;
  hetzner_server_id?: number | null;
  proxmox_node?: string | null;
  proxmox_vmid?: number | null;
  api_key_preview: string | null;
  has_honcho_api_key?: boolean;
  config: Record<string, unknown>;
  created_at: string;
  updated_at?: string;
  resource_tier?: string | null;
  ram_limit?: number | null;
  tier_change_pending?: boolean;
  updateAlert?: {
    title: string;
    message: string;
    lastSeenAt: string;
    reason?: string;
    runType: "manual" | "scheduled";
  } | null;
  failureAlert?: InstanceFailureAlert | null;
}

function hasRecoverableActionStatus(
  value: unknown
): value is "redeploying" | "provisioning" {
  return value === "redeploying" || value === "provisioning";
}

function isColdStorageRestorableInstance(instance: Instance): boolean {
  return (
    instance.lifecycle_state === "cold_archived" ||
    instance.lifecycle_state === "pending_deletion" ||
    instance.paused_reason === "cold_archived"
  );
}

function isColdStorageRestoringInstance(instance: Instance): boolean {
  return instance.lifecycle_state === "restoring";
}

type PowerAction =
  | "start"
  | "stop"
  | "reboot"
  | "update"
  | "restart"
  | "restart_gateway"
  | "redeploy"
  | "repair_runtime"
  | "rebuild_runtime";

function describePowerAction(action: PowerAction): string {
  switch (action) {
    case "restart_gateway":
      return "restart gateway";
    case "repair_runtime":
      return "repair agent";
    case "rebuild_runtime":
      return "rebuild agent";
    default:
      return action;
  }
}

function buildFailureAlertDismissKey(instanceId: string, alert: InstanceFailureAlert | null | undefined): string | null {
  if (!alert) return null;
  return [
    "hermes-failure-alert-dismissed",
    instanceId,
    alert.lastSeenAt,
    alert.owner,
    alert.phase,
    alert.recoveryAction,
    alert.title,
    alert.message,
  ].join(":");
}

function shouldReuseInstanceSnapshot(current: Instance, next: Instance): boolean {
  const currentAlert = current.updateAlert;
  const nextAlert = next.updateAlert;

  return (
    current.id === next.id &&
    current.status === next.status &&
    current.lifecycle_state === next.lifecycle_state &&
    current.paused_reason === next.paused_reason &&
    current.ram_limit === next.ram_limit &&
    current.last_lifecycle_transition_at === next.last_lifecycle_transition_at &&
    current.gateway_url === next.gateway_url &&
    current.public_ipv4 === next.public_ipv4 &&
    current.infrastructure_provider === next.infrastructure_provider &&
    current.host_id === next.host_id &&
    current.hetzner_server_id === next.hetzner_server_id &&
    current.proxmox_node === next.proxmox_node &&
    current.proxmox_vmid === next.proxmox_vmid &&
    current.api_key_preview === next.api_key_preview &&
    current.has_honcho_api_key === next.has_honcho_api_key &&
    current.updated_at === next.updated_at &&
    current.name === next.name &&
    current.provider === next.provider &&
    current.backend === next.backend &&
    currentAlert?.lastSeenAt === nextAlert?.lastSeenAt &&
    currentAlert?.runType === nextAlert?.runType &&
    currentAlert?.reason === nextAlert?.reason &&
    buildFailureAlertDismissKey(current.id, current.failureAlert) === buildFailureAlertDismissKey(next.id, next.failureAlert)
  );
}

function isMissingInstanceError(error: unknown): boolean {
  return typeof error === "string" && error.toLowerCase().includes("instance not found");
}

function clearRememberedChatInstance() {
  if (typeof document === "undefined") return;
  document.cookie = "hermes_last_chat=; path=/; max-age=0";
}

// Command-panel toggle persistence. Default ON: the panel shows unless the user
// has explicitly collapsed it. We persist a single string flag to localStorage
// so the choice sticks across reloads; SSR / blocked storage falls back to ON.
const COMMAND_PANEL_OPEN_KEY = "hivra_command_panel_open";

function readCommandPanelOpen(): boolean {
  try {
    return window.localStorage.getItem(COMMAND_PANEL_OPEN_KEY) !== "0";
  } catch {
    return true; // SSR / private mode — default to showing the panel.
  }
}

function persistCommandPanelOpen(open: boolean): void {
  try {
    window.localStorage.setItem(COMMAND_PANEL_OPEN_KEY, open ? "1" : "0");
  } catch {
    // Best-effort: blocked storage just means the choice isn't remembered.
  }
}

// At or below this width the docked panel would squeeze the chat, so the panel
// becomes a bottom sheet opened from the narrow toolbar instead.
const COMMAND_PANEL_SHEET_QUERY = "(max-width: 1100px)";

function subscribeCommandPanelSheet(notify: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(COMMAND_PANEL_SHEET_QUERY);
  query.addEventListener?.("change", notify);
  return () => query.removeEventListener?.("change", notify);
}

function readCommandPanelSheet(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(COMMAND_PANEL_SHEET_QUERY).matches;
}

function useCommandPanelSheet(): boolean {
  return useSyncExternalStore(subscribeCommandPanelSheet, readCommandPanelSheet, () => false);
}

const SHEET_FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** True while another modal dialog is open over `dialog`. Checked against the
 *  DOM rather than focus: a dialog that never takes focus still owns the keys. */
function isCoveredByAnotherModal(dialog: HTMLElement): boolean {
  return Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).some((other) => other !== dialog);
}

/** Bottom sheet for the command panel on narrow viewports. Escape, the backdrop
 *  and the panel's own close button dismiss it; Tab stays inside. Both yield to
 *  a dialog opened from the sheet (channels, app picker) while it is open. */
function CommandPanelSheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const sheetRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const sheet = sheetRef.current;
      if (!sheet || isCoveredByAnotherModal(sheet)) return;
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(sheet.querySelectorAll<HTMLElement>(SHEET_FOCUSABLE));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!document.activeElement || !sheet.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <SafePortal>
      <div
        aria-hidden="true"
        data-testid="instance-command-panel-sheet-backdrop"
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 1000,
          background: "color-mix(in srgb, var(--overlay-bg) 70%, rgba(0,0,0,0.3))",
        }}
      />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command panel"
        data-testid="instance-command-panel-sheet"
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 1001,
          height: "min(85dvh, calc(var(--workspace-viewport-height, 100dvh) - 24px))",
          display: "flex",
          flexDirection: "column",
          boxSizing: "border-box",
          background: "var(--bg-surface)",
          borderTop: "1px solid var(--etched-border)",
          boxShadow: "0 -18px 50px rgba(0,0,0,0.22)",
          paddingBottom: "env(safe-area-inset-bottom, 0px)",
          paddingLeft: "env(safe-area-inset-left, 0px)",
          paddingRight: "env(safe-area-inset-right, 0px)",
        }}
      >
        {children}
      </div>
    </SafePortal>
  );
}

// Shared chrome for the Telegram and Channels connect modals. The panel caps
// to the visible viewport (keyboard included) and keeps its close button in a
// pinned header; under 640px the <style> in the page turns it into a sheet.
const CONNECT_MODAL_OVERLAY_STYLE: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  height: 'var(--workspace-viewport-height, 100dvh)',
  background: 'color-mix(in srgb, var(--overlay-bg) 78%, rgba(0,0,0,0.22))',
  backdropFilter: 'blur(10px)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 9999,
  boxSizing: 'border-box',
  paddingTop: 'max(clamp(16px, 2.4vw, 30px), env(safe-area-inset-top, 0px))',
  paddingRight: 'max(clamp(16px, 2.4vw, 30px), env(safe-area-inset-right, 0px))',
  paddingBottom: 'max(clamp(16px, 2.4vw, 30px), env(safe-area-inset-bottom, 0px))',
  paddingLeft: 'max(clamp(16px, 2.4vw, 30px), env(safe-area-inset-left, 0px))',
};

const CONNECT_MODAL_PANEL_STYLE: React.CSSProperties = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  maxHeight: 'calc(var(--workspace-viewport-height, 100dvh) - 32px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px))',
  overflow: 'hidden',
  boxSizing: 'border-box',
  background: 'color-mix(in srgb, var(--bg-surface) 96%, transparent)',
  border: '1px solid var(--etched-border)',
  boxShadow: '0 24px 80px rgba(0, 0, 0, 0.22)',
};

function ConnectModalHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        flexShrink: 0,
        padding: '0 0 0 16px',
        background: 'var(--bg-surface)',
        borderBottom: '1px solid var(--etched-border)',
      }}
    >
      <span className="mono" style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--text-muted)' }}>
        {title}
      </span>
      <button
        type="button"
        autoFocus
        onClick={onClose}
        aria-label="Close"
        style={{ width: 44, height: 44, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: 'none', borderLeft: '1px solid var(--etched-border)', background: 'transparent', cursor: 'pointer', color: 'var(--text-muted)' }}
      >
        <X size={16} />
      </button>
    </div>
  );
}

export default function InstanceDetailPage() {
  const { id } = useParams() as { id: string };
  const router = useRouter();
  const searchParams = useSearchParams();
  const [instance, setInstance] = useState<Instance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [terminalMode] = useState<"shell" | "tui">("shell");
  const [explorerVisible, setExplorerVisible] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);
  const [dismissedFailureAlertKey, setDismissedFailureAlertKey] = useState<string | null>(null);
  const [codexOAuthDismissed, setCodexOAuthDismissed] = useState(false);
  // Telegram connect — the post-deploy activation surface (this lane has no
  // other Telegram UI). The modal auto-opens when the celebration routes here
  // with ?connect=telegram; the banner is the second-chance nudge on a fresh
  // ?welcome=1 landing.
  const [telegramOpen, setTelegramOpen] = useState(false);
  const [telegramBannerDismissed, setTelegramBannerDismissed] = useState(false);
  // Channels surface — the multi-platform sibling of the Telegram modal. Opens
  // a tile grid (Discord/Slack/WhatsApp/Signal/… all already wired in the
  // integrations route) over the same modal chrome. Additive: Telegram keeps its
  // own bespoke entry points; this just makes the other channels reachable.
  // `false` = closed; `true` = open at the channels grid; a channel id = open
  // straight into that channel's connect flow (deep-link from a quick-connect tile).
  const [channelsOpen, setChannelsOpen] = useState<string | boolean>(false);
  // The full-width "Reach {name} anywhere" channels promo used to render above
  // the chat on every landing, stacking with the other banners and pushing the
  // chat below the fold. The chat is the hero, so this starts DISMISSED — the
  // Connect surface stays fully reachable from the command panel's Connect
  // section ("View all channels" → the same modal). It only auto-shows when the
  // user explicitly lands from a ?connect=channels onboarding link (mirrors the
  // Telegram nudge), so the promo is opt-in rather than an always-on band.
  const [channelsBannerDismissed, setChannelsBannerDismissed] = useState(true);
  // Right-docked command panel (paioclaw-style). Toggleable; persisted to
  // localStorage (DEFAULT ON). When collapsed, the chat/iframe takes full width.
  // Lazy-init from storage is SSR-safe: the instance block only renders past the
  // `loading` gate (well after hydration), same as the other persisted nudges.
  const [commandPanelOpen, setCommandPanelOpen] = useState(readCommandPanelOpen);
  const toggleCommandPanel = useCallback(() => {
    setCommandPanelOpen((prev) => {
      const next = !prev;
      persistCommandPanelOpen(next);
      captureClient("command_panel_toggled", { surface: "instance_overview", open: next });
      return next;
    });
  }, []);
  // Narrow viewports get the panel as a bottom sheet. Its open state is separate
  // from the persisted desktop toggle and always starts closed.
  const commandPanelSheet = useCommandPanelSheet();
  const [switcherHandleHost, setSwitcherHandleHost] = useState<HTMLDivElement | null>(null);
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);
  const mobilePanelTriggerRef = useRef<HTMLButtonElement>(null);
  const openMobilePanel = useCallback(() => {
    setMobilePanelOpen(true);
    captureClient("command_panel_toggled", { surface: "instance_overview_sheet", open: true });
  }, []);
  const closeMobilePanel = useCallback(() => {
    setMobilePanelOpen(false);
    mobilePanelTriggerRef.current?.focus();
  }, []);
  useEffect(() => {
    setMobilePanelOpen(false);
  }, [id]);
  // Standing-tasks nudge: the "works while you're away" loop was invisible on
  // this lane, so it never converted. Dismissible; routes to the console Tasks
  // tab where a Free user can set up their one standing task. The dismissal is
  // persisted to localStorage (lazy-init below) so it stays gone across reloads
  // — the instance block only renders after `loading` clears, well past
  // hydration, so reading storage during init is safe (no SSR mismatch).
  const [tasksBannerDismissed, setTasksBannerDismissed] = useState(readStandingTasksNudgeDismissed);
  // Starter-prompt strip: the welcome surface drops a brand-new free user into a
  // blank cross-origin chat iframe with no prompt, and ~95% bounce before ever
  // sending a message. This strip offers one-click first tasks; clicking one
  // posts it into the iframe (via WebuiIframe's registered sender → the box
  // apps/desktop handler) which submits it as the first message, creating the
  // session and stamping first_usage. The sender is null until the iframe
  // handoff is ready; the strip only renders on the ?welcome=1 landing and hides
  // once a prompt is sent or the user dismisses it.
  const [starterStripDismissed, setStarterStripDismissed] = useState(false);
  const starterSenderRef = useRef<((text: string) => boolean) | null>(null);
  const [starterSenderReady, setStarterSenderReady] = useState(false);
  const handleStarterSenderReady = useCallback(
    (send: ((text: string) => boolean) | null) => {
      starterSenderRef.current = send;
      setStarterSenderReady(Boolean(send));
    },
    [],
  );
  const sendStarterPrompt = useCallback((prompt: string) => {
    const sent = starterSenderRef.current?.(prompt) ?? false;
    if (sent) {
      captureClient("starter_prompt_sent", { surface: "welcome_chat" });
      setStarterStripDismissed(true);
    }
  }, []);
  // Workflows-of-the-week shelf reuses the SAME iframe sender (#308) to inject a
  // ready-to-run template prompt into the chat composer. Kept separate from
  // sendStarterPrompt so it doesn't dismiss the welcome strip or fire its event.
  const runWorkflowPrompt = useCallback(
    (prompt: string) => {
      const sent = starterSenderRef.current?.(prompt) ?? false;
      if (sent) captureClient("workflow_template_run", { surface: "instance_overview" });
      return sent;
    },
    [],
  );
  // Known Telegram-connection state for THIS instance: null until the live
  // integrations status is read. Both nudge surfaces (the post-deploy banner and
  // the auto-opening modal) are activation prompts — they must NOT fire once the
  // bot is already connected, otherwise refreshing the ?welcome=1 / ?connect=
  // telegram landing keeps re-nagging an already-connected user.
  const [telegramConnected, setTelegramConnected] = useState<boolean | null>(null);
  const telegramAutoOpenedRef = useRef(false);
  const reduceMotion = useReducedMotion();
  const wantsTelegramNudge =
    searchParams?.get("welcome") === "1" || searchParams?.get("connect") === "telegram";
  const failureAlertKey = buildFailureAlertDismissKey(instance?.id ?? id, instance?.failureAlert);
  const showFailureAlert = Boolean(instance?.failureAlert && failureAlertKey !== dismissedFailureAlertKey);
  // Power-gate the auto-firing Codex connect modal: it drives an SSH device
  // flow on the box, so auto-starting it against an OFF/archived instance can
  // only fail (observed as a 100%-failure provider_oauth_failed cluster in
  // PostHog). When the box isn't running the page's existing surfaces already
  // show the right CTA — the cold-storage banner's "Start restore" for
  // archived agents and the WebuiIframe stopped panel's Start button — and
  // the modal auto-fires on its own once status flips to 'running'.
  const showCodexOAuthModal =
    instance?.status === "running" &&
    shouldAutoOpenCodexOAuth(instance) &&
    !codexOAuthDismissed;

  useEffect(() => {
    setCodexOAuthDismissed(false);
  }, [id]);

  // Read the live Telegram-connection status once when we land on a nudge URL, so
  // the banner/modal can suppress themselves for already-connected agents. Scoped
  // to the nudge case so we don't add an SSH env-read to every instance page view.
  useEffect(() => {
    if (!wantsTelegramNudge) return;
    if (instance?.status !== "running") return;
    if (telegramConnected !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`/api/instances/${id}/integrations`, { cache: "no-store" });
        const j = (await r.json().catch(() => null)) as {
          data?: { statuses?: Record<string, { configured?: boolean }>; configuredPlatforms?: string[] };
        } | null;
        const data = j?.data ?? null;
        const configured = Boolean(
          data?.statuses?.Telegram?.configured ||
            (Array.isArray(data?.configuredPlatforms) && data.configuredPlatforms.includes("Telegram")),
        );
        if (!cancelled) setTelegramConnected(configured);
      } catch {
        // Couldn't read status — fall toward showing the nudge (the activation
        // path for genuinely-new agents); an already-connected agent only hits
        // this on a transient read error.
        if (!cancelled) setTelegramConnected(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wantsTelegramNudge, instance?.status, id, telegramConnected]);

  // Open the Telegram connect modal when arriving from the deploy celebration's
  // "Connect Telegram" CTA — but only once we've confirmed the bot ISN'T already
  // connected, so a refresh of ?connect=telegram never re-opens it over a running
  // bot. Ref-guarded so closing the modal doesn't re-open it.
  useEffect(() => {
    if (searchParams?.get("connect") !== "telegram") return;
    if (telegramConnected !== false) return;
    if (telegramAutoOpenedRef.current) return;
    telegramAutoOpenedRef.current = true;
    setTelegramOpen(true);
  }, [searchParams, telegramConnected]);

  // Surface the channels promo only when the user explicitly arrives from a
  // ?connect=channels onboarding link. Off by default (the banner starts
  // dismissed) so a normal landing keeps the chat front-and-center; this is the
  // intentional opt-in entry point for the broader channel grid.
  useEffect(() => {
    if (searchParams?.get("connect") === "channels") {
      setChannelsBannerDismissed(false);
    }
  }, [searchParams]);

  // Escape closes the Telegram connect modal (mouse-dismiss via backdrop/X also
  // works; this adds keyboard parity).
  useEffect(() => {
    if (!telegramOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTelegramOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [telegramOpen]);

  useEffect(() => {
    if (!failureAlertKey || typeof window === "undefined") return;
    try {
      if (window.sessionStorage.getItem(failureAlertKey) === "1") {
        setDismissedFailureAlertKey(failureAlertKey);
      }
    } catch {
      // Storage can be unavailable in private contexts. In-memory dismiss still works.
    }
  }, [failureAlertKey]);

  const dismissFailureAlert = useCallback(() => {
    if (!failureAlertKey) return;
    setDismissedFailureAlertKey(failureAlertKey);
    if (typeof window === "undefined") return;
    try {
      window.sessionStorage.setItem(failureAlertKey, "1");
    } catch {
      // Non-fatal; the current page can still dismiss the alert in memory.
    }
  }, [failureAlertKey]);

  const fetchInstance = useCallback(async (noSync = false) => {
    try {
      const qs = noSync ? "?no_sync=true" : "";
      const res = await fetch(`/api/instances/${id}${qs}`);
      const data = await res.json();
      if (data.success) {
        setError(null);
        setInstance((prev) => {
          // Ignore polling responses when the core instance snapshot hasn't actually changed.
          if (prev && shouldReuseInstanceSnapshot(prev, data.data)) return prev;
          return data.data;
        });
      } else {
        if (isMissingInstanceError(data.error)) {
          clearRememberedChatInstance();
          router.replace("/dashboard/chat");
          return;
        }
        setError(data.error);
      }
    } catch {
      setError("Failed to load this agent");
    } finally {
      setLoading(false);
    }
  }, [id, router]);

  // Held in a ref so the redeploy event listener (registered before
  // powerAction is declared) can call the latest version without TDZ
  // issues or stale closures. Updated whenever powerAction changes.
  const powerActionRef = useRef<((action: PowerAction) => Promise<void>) | null>(null);
  const agentStartFailureTelemetryRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const handler = () => setRestartRequired(true);
    // hermes-redeploy-trigger fires when AgentProfileSettingsPanel saves a
    // change that returned redeployRequired=true (e.g. Browser Sidecar
    // toggled on, browser provider switched, etc.). Previously this just
    // flipped the UI to "redeploying" and refetched — without ever firing
    // a real redeploy action. The compose file on the user's VM was
    // never regenerated, so the new sidecar block never landed. Fix:
    // actually call powerAction("redeploy") via a ref, which POSTs
    // action=redeploy and runs applyLiveUpdate end-to-end. The optimistic
    // UI flip stays for snappier feedback; powerAction handles its own
    // status polling.
    const redeployHandler = () => {
      setInstance(prev => prev ? { ...prev, status: 'redeploying' } : null);
      const trigger = powerActionRef.current;
      if (trigger) void trigger("redeploy");
    };
    window.addEventListener('agent-restart-required', handler);
    window.addEventListener('hermes-redeploy-trigger', redeployHandler);
    return () => {
      window.removeEventListener('agent-restart-required', handler);
      window.removeEventListener('hermes-redeploy-trigger', redeployHandler);
    };
  }, [fetchInstance]);

  useEffect(() => {
    fetchInstance(true);

    // Poll instance status if provisioning or redeploying
    const iv = setInterval(() => {
      // When polling, allow sync from Hetzner
      if (
        instance?.status === "provisioning" ||
        instance?.status === "redeploying" ||
        instance?.status === "error"
      ) fetchInstance(false);
    }, 8000);
    return () => clearInterval(iv);
  }, [fetchInstance, instance?.status, id]);

  useEffect(() => {
    if (!instance?.id || instance.id !== id) return;
    document.cookie = `hermes_last_chat=${id}; path=/; max-age=31536000`;
  }, [id, instance?.id]);

  // Remember this agent for Home's "Pick up where you left off" and the
  // switchers' Recent group, once it has loaded here. A Hermes agent has one
  // surface, its chat, which is also what this page opens on.
  const visited = Boolean(id && instance?.id === id);
  useRecordVisit(visited ? hermesRuntimeUid(id) : null, visited ? "chat" : null);

  useEffect(() => {
    if (!id) return;
    if (!instance?.id || instance.id !== id) return;
    if (searchParams?.get("surface") === "chat") return;
    const defaultSurface = getDefaultInstanceSurfacePreference(instance?.backend);
    const storedSurface = getStoredInstanceSurfacePreference(id, undefined, defaultSurface);
    if (storedSurface !== "tui") return;

    const currentPath = typeof window !== "undefined" ? window.location.pathname : "";
    const tuiPath = getInstanceSurfaceHref(id, "tui");
    if (currentPath === tuiPath) return;

    clientLog.info("routing to dedicated TUI from saved surface preference", {
      source: "instance.surface.preference",
      instanceId: id,
      backend: instance?.backend ?? null,
      defaultSurface,
      storedSurface,
      requestedSurface: searchParams?.get("surface") ?? null,
    });
    router.replace(tuiPath);
  }, [id, instance?.backend, instance?.id, router, searchParams]);

  useEffect(() => {
    if (instance?.status === "error") {
      void fetchInstance(false);
    }
  }, [fetchInstance, instance?.status]);

  // Auto-wake instances that the inactivity-sweep cron paused. The cron
  // sets status='stopped' + paused_reason='inactivity' on agents idle
  // beyond the per-tier cutoff (4d free / 7d paid). When the user comes
  // back and opens the page, fire the existing start action transparently
  // so the experience is "warming up..." instead of "stopped, click here
  // to manually restart." Tracked per instance id so a re-render or a
  // refetch doesn't re-fire while the start is already in flight. Uses
  // powerActionRef rather than powerAction directly because powerAction
  // is declared further down in the file (TDZ-avoidance).
  const inactivityWakeFiredRef = useRef<string | null>(null);
  useEffect(() => {
    if (!instance) return;
    if (instance.paused_reason !== "inactivity") return;
    if (instance.status !== "stopped") return;
    if (inactivityWakeFiredRef.current === instance.id) return;
    if (actionLoading) return;
    const fire = powerActionRef.current;
    if (!fire) return;
    inactivityWakeFiredRef.current = instance.id;
    void fire("start");
  }, [
    instance?.id,
    instance?.status,
    instance?.paused_reason,
    actionLoading,
    instance,
  ]);

  // The user's real plan — only needed to gate the free→paid sleep-wake pitch
  // (Moment #1), so we fetch it lazily, and ONLY when this instance is in the
  // inactivity-paused state that surfaces the pitch. Keeps the hot instance page
  // from doing an extra /api/billing/usage call on every open. Starts null
  // (unknown) so a paying customer never flashes the pitch before their plan
  // resolves; paid tiers are also structurally exempt from the inactivity sweep.
  const [plan, setPlan] = useState<PlanInfo | null>(null);
  const planFetchedRef = useRef(false);
  useEffect(() => {
    // Both consumers (sleep banner + archive wall) are dark unless a flag is
    // on — skip the fetch entirely so the dark features add zero API calls.
    if (!isSleepUpgradePromptEnabled() && !isArchiveUpgradeWallEnabled()) return;
    if (instance?.paused_reason !== "inactivity") return;
    if (planFetchedRef.current) return;
    planFetchedRef.current = true;
    let alive = true;
    void fetchPlanStrict()
      .then((p) => {
        if (alive) setPlan(p);
      })
      .catch(() => {
        // Unknown plan stays null (≠ free) → no pitch for an unresolved payer.
      });
    return () => {
      alive = false;
    };
  }, [instance?.paused_reason]);

  // Fire free_limit_hit once per RAM-capped instance — the in-product paywall
  // view event. Deduped per instance like inactivityWakeFiredRef above.
  const ramCapBannerViewedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!instance) return;
    if (instance.paused_reason !== "ram_cap_hit") return;
    if (instance.status !== "stopped") return;
    if (ramCapBannerViewedRef.current === instance.id) return;
    ramCapBannerViewedRef.current = instance.id;
    // User-level event (default distinct_id = the identified user) so the
    // limit-hit ties into the per-user signup→upgrade funnel; ref-deduped per
    // instance to avoid double-firing within a session.
    captureClient("free_limit_hit", {
      limit_type: "ram",
      surface: "instance_banner",
      instance_id: instance.id,
    });
  }, [instance?.id, instance?.status, instance?.paused_reason, instance]);

  // Fire free_limit_hit once per inactivity-paused instance — the 4-day idle
  // sleep is the most-hit free limit (paid tiers are EXEMPT from the inactivity
  // sweep; "always-on" is a Pro differentiator), yet it auto-wakes silently with
  // no upgrade ask. This is the paywall VIEW event for the always-on upsell we
  // now surface in the inactivity banner. Deduped per instance, like ram_cap.
  const inactivityUpsellViewedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!instance) return;
    if (instance.paused_reason !== "inactivity") return;
    if (instance.status !== "stopped" && instance.status !== "provisioning") return;
    if (inactivityUpsellViewedRef.current === instance.id) return;
    inactivityUpsellViewedRef.current = instance.id;
    captureClient("free_limit_hit", {
      limit_type: "inactivity",
      surface: "instance_banner",
      instance_id: instance.id,
    });
  }, [instance?.id, instance?.status, instance?.paused_reason, instance]);

  const powerAction = useCallback(async (action: PowerAction) => {
    setActionLoading(true);
    try {
      const res = await fetch(`/api/instances/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: "Unknown error" }));
        const startFailure = action === "start"
          ? describeAgentStartFailure({
              status: res.status,
              error: errData,
              code: errData?.code,
              failureType: errData?.failureType,
            })
          : null;
        clientLog.error("Power action returned non-ok status", new Error(`HTTP ${res.status}`), {
          source: "instance-detail",
          instanceId: id,
          action,
          status: res.status,
          failureType: "power_action_non_ok",
          serverError: typeof errData.error === "string" ? errData.error : "Unknown error",
          ...(startFailure
            ? {
                agentStartFailureCode: startFailure.code,
                recoveryAction: startFailure.recoveryAction,
                retryable: startFailure.retryable,
              }
            : {}),
        });
        if (startFailure) {
          try {
            const telemetryKey = getAgentStartFailureTelemetryKey(id, startFailure);
            if (shouldCaptureAgentStartFailure(agentStartFailureTelemetryRef.current, telemetryKey)) {
              posthog.capture("agent_start_failed", {
                instance_id: id,
                error_code: startFailure.code,
                error_message: startFailure.rawMessage.slice(0, 200) || "Unknown error",
                recovery_action: startFailure.recoveryAction,
                retryable: startFailure.retryable,
              });
            }
          } catch {
            // ignore
          }
        }
        alert(
          `Action "${describePowerAction(action)}" failed: ${startFailure?.userMessage ?? normalizeSshWarmupMessage(
            errData.error,
            "A server error occurred. Please try again."
          )}`
        );
      } else {
        if (action === "restart") setRestartRequired(false);
        // Immediate status sync for better UX
        setTimeout(() => fetchInstance(true), 500);
      }
      // Follow-up fetch after 2s for status transitions
      setTimeout(fetchInstance, 2200);
    } catch (err) {
      const startFailure = action === "start"
        ? describeAgentStartFailure({ error: err, code: "network_error" })
        : null;
      clientLog.error("Power action failed", err, {
        source: "instance-detail",
        instanceId: id,
        action,
        failureType: "power_action_failed",
        ...(startFailure
          ? {
              agentStartFailureCode: startFailure.code,
              recoveryAction: startFailure.recoveryAction,
              retryable: startFailure.retryable,
            }
          : {}),
      });

      if (startFailure) {
        try {
          const telemetryKey = getAgentStartFailureTelemetryKey(id, startFailure);
          if (shouldCaptureAgentStartFailure(agentStartFailureTelemetryRef.current, telemetryKey)) {
            posthog.capture("agent_start_failed", {
              instance_id: id,
              error_code: startFailure.code,
              error_message: startFailure.rawMessage.slice(0, 200) || "Network Error",
              recovery_action: startFailure.recoveryAction,
              retryable: startFailure.retryable,
            });
          }
        } catch {
          // ignore
        }
      }

      if (action === "redeploy" || action === "update" || action === "repair_runtime" || action === "rebuild_runtime") {
        try {
          const snapshotRes = await fetch(`/api/instances/${id}?no_sync=true`);
          const snapshot = await snapshotRes.json();
          if (
            snapshotRes.ok &&
            snapshot.success &&
            snapshot.data &&
            hasRecoverableActionStatus(snapshot.data.status)
          ) {
            setInstance((prev) => {
              if (prev && shouldReuseInstanceSnapshot(prev, snapshot.data)) return prev;
              return snapshot.data;
            });
            return;
          }
        } catch {
          // If the follow-up snapshot also fails, fall through to the visible alert below.
        }
      }

      alert(
        `Action "${describePowerAction(action)}" failed to execute: ${
          startFailure?.userMessage ?? "Network Error. Please check connection and try again."
        }`
      );
    } finally {
      setActionLoading(false);
    }
  }, [id, fetchInstance]);

  useEffect(() => {
    powerActionRef.current = powerAction;
  }, [powerAction]);

  const terminalOverlayPadding = '12px';
  const overlayVariants = buildHermesOverlayVariants(Boolean(reduceMotion));
  const terminalWindowVariants = buildHermesFadeSlideVariants(Boolean(reduceMotion), {
    offset: 18,
  });
  const explorerWindowVariants = buildHermesFadeSlideVariants(Boolean(reduceMotion), {
    offset: 16,
  });
  const dockSpring = buildHermesSurfaceSpring(Boolean(reduceMotion), "dock");

  if (loading) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flex: 1, height: "100%" }}>
      <Loader2 size={20} style={{ opacity: 0.3, animation: "spin 1s linear infinite" }} />
    </div>
  );

  if (error || !instance) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flex: 1, height: "100%", padding: 16, boxSizing: "border-box" }}>
      <div data-testid="instance-load-error" style={{ display: "grid", gap: 14, border: "1px solid #fca5a5", background: "#fef2f2", padding: 20, width: "min(480px, 100%)", boxSizing: "border-box" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <AlertTriangle size={16} style={{ color: "#ef4444", flexShrink: 0 }} />
          <span style={{ fontSize: 13, color: "#dc2626", fontWeight: 500, overflowWrap: "anywhere" }}>{error || "Agent not found"}</span>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              void fetchInstance(false);
            }}
            className="mono"
            style={{ minHeight: 44, padding: "0 16px", border: "1px solid var(--hivra-red)", background: "var(--hivra-red)", color: "#fff", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.12em", cursor: "pointer" }}
          >
            Retry
          </button>
          <button
            type="button"
            onClick={() => router.push("/dashboard/agents")}
            className="mono"
            style={{ minHeight: 44, padding: "0 16px", border: "1px solid var(--hivra-red)", background: "transparent", color: "#dc2626", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.12em", cursor: "pointer" }}
          >
            Back to agents
          </button>
        </div>
      </div>
    </div>
  );

  // ACTIVATION-BANNER PRIORITY (F072): on a fresh ?welcome=1 landing several
  // activation nudges (starter prompts, Telegram, standing tasks, channels) can
  // be independently eligible at once and stack on top of the chat hero. Show
  // only the single highest-priority eligible one so the chat isn't pushed down.
  // Priority order: starter prompts > Telegram > standing tasks > channels.
  const isRunning = instance.status === "running";
  const wantsWelcome = searchParams?.get("welcome") === "1";
  const starterStripEligible =
    isRunning && wantsWelcome && starterSenderReady && !starterStripDismissed;
  const telegramBannerEligible =
    isRunning &&
    telegramConnected === false &&
    !telegramOpen &&
    !telegramBannerDismissed &&
    (wantsWelcome || searchParams?.get("connect") === "telegram");
  const standingTasksBannerEligible = isRunning && !tasksBannerDismissed;
  const channelsBannerEligible = isRunning && !channelsBannerDismissed;
  const activeActivationBanner: "starter" | "telegram" | "tasks" | "channels" | null =
    starterStripEligible
      ? "starter"
      : telegramBannerEligible
        ? "telegram"
        : standingTasksBannerEligible
          ? "tasks"
          : channelsBannerEligible
            ? "channels"
            : null;

  return (
    <div className="instance-chat-root" style={{ position: "relative", display: "flex", height: "100%", overflow: "hidden" }}>
      {/* Seamless Chat — takes full space */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>

        {/* Narrow toolbar (≤1100px, where the dock is unavailable): Console,
            the agent switcher and the command-panel sheet live in their own
            band so nothing covers the embedded chat's corner controls. */}
        {commandPanelSheet ? (
          <div
            data-testid="instance-chat-toolbar"
            className="instance-chat-toolbar"
            style={{
              position: "relative",
              zIndex: 60,
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              minHeight: 52,
              boxSizing: "border-box",
              paddingTop: "calc(var(--dashboard-page-safe-top, env(safe-area-inset-top, 0px)) + 4px)",
              paddingBottom: 4,
              paddingLeft: "max(4px, env(safe-area-inset-left, 0px))",
              paddingRight: "max(4px, env(safe-area-inset-right, 0px))",
              borderBottom: "1px solid var(--etched-border)",
              background: "var(--bg-surface)",
            }}
          >
            <Link
              href={`/dashboard/instances/${instance.id}/console`}
              aria-label="Open console"
              className="mono"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 7,
                minWidth: 44,
                minHeight: 44,
                padding: "0 10px",
                boxSizing: "border-box",
                border: "1px solid var(--etched-border)",
                background: "var(--bg-surface)",
                color: "var(--ink-black)",
                fontSize: 11,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                textDecoration: "none",
              }}
            >
              <ServerCog size={16} aria-hidden="true" />
              Console
            </Link>
            {/* The switcher's collapsed handle is portaled here; it expands in
                the chat column below, so it never covers the banners. */}
            <div
              ref={setSwitcherHandleHost}
              data-testid="instance-chat-toolbar-switcher"
              style={{ flex: "1 1 auto", minWidth: 0, display: "flex", justifyContent: "center" }}
            />
            <button
              ref={mobilePanelTriggerRef}
              type="button"
              onClick={openMobilePanel}
              aria-haspopup="dialog"
              aria-expanded={mobilePanelOpen}
              aria-label="Open command panel"
              data-testid="command-panel-sheet-open"
              className="mono"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 7,
                minWidth: 44,
                minHeight: 44,
                padding: "0 10px",
                boxSizing: "border-box",
                border: "1px solid var(--etched-border)",
                borderRadius: 0,
                background: "var(--bg-surface)",
                color: "var(--ink-black)",
                fontSize: 11,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                cursor: "pointer",
              }}
            >
              <PanelRightOpen size={16} aria-hidden="true" />
              Panel
            </button>
          </div>
        ) : null}

        {/* System banners. Under 640px the stack is capped (see the <style>
            below) so it can never push the chat off a short phone screen, and
            the activation nudge moves below any system alert. */}
        <div className="instance-chat-banner-stack" style={{ display: "flex", flexDirection: "column", flexShrink: 0 }}>

        {/* STORAGE USAGE BANNER — read-only disk warning (>=80% amber, >=95% red).
            Keyed on the real hermes_instances id, which IS sampled into
            instance_metering_events by the metering cron. Best-effort + dismissible;
            self-hides below 80% or on any fetch error. */}
        <StorageUsageBanner instanceId={id} />

        {/* RESTART BANNER */}
        {restartRequired && (
           <div className="instance-chat-banner" style={{ background: 'var(--amber)', color: '#000', padding: '12px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', zIndex: 50 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', minWidth: 0 }}>
                 <AlertTriangle size={18} strokeWidth={2.5} />
                 <span style={{ fontSize: 13, fontWeight: 600, fontFamily: 'var(--font-mono)' }}>RESTART REQUIRED</span>
                 <span style={{ fontSize: 13 }}>Pending setting changes require a container restart to take effect.</span>
              </div>
              <div className="instance-chat-banner-actions" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                   onClick={() => powerAction('restart')}
                   disabled={actionLoading}
                   style={{
                      background: '#000', color: 'var(--amber)', border: 'none',
                      padding: '8px 16px', fontSize: 12, fontWeight: 700,
                      cursor: actionLoading ? 'not-allowed' : 'pointer',
                      fontFamily: 'var(--font-mono)', textTransform: 'uppercase',
                      opacity: actionLoading ? 0.7 : 1
                   }}
                >
                   {actionLoading ? 'Restarting...' : 'Restart Now'}
                </button>
              </div>
           </div>
        )}
        {/* STARTER-PROMPT STRIP — the first-action nudge on a fresh post-deploy
            landing. Leads the welcome surface (above the Telegram banner) so a
            brand-new user has an obvious first move instead of a blank chat.
            Each chip posts a full prompt into the iframe → the box sends it as
            the first message (creating the session / stamping first_usage). */}
        {activeActivationBanner === "starter" ? (
          <div
            data-testid="instance-starter-prompts"
            className="instance-chat-banner instance-chat-banner-nudge"
            style={{
              background: 'rgba(212, 175, 55, 0.12)',
              borderBottom: '1px solid var(--gold-leaf)',
              padding: '12px 24px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 16,
              flexWrap: 'wrap',
              zIndex: 49,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: '1 1 300px' }}>
              <Sparkles size={18} strokeWidth={2.25} style={{ color: 'var(--gold-leaf)', flexShrink: 0 }} />
              <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink-black)', textTransform: 'uppercase', letterSpacing: '0.12em' }}>
                  Not sure where to start?
                </span>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                  Tap one and {instance.name} gets going — no typing needed.
                </span>
              </div>
            </div>
            <div className="instance-chat-banner-actions" style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto', flexWrap: 'wrap' }}>
              {[
                { label: 'What can you do?', prompt: 'What can you help me with? Give me 3 concrete ideas based on what you can do right now.' },
                { label: 'Draft an email', prompt: 'Help me draft a professional email.' },
                { label: 'Research a topic', prompt: 'Research a topic for me and summarize the key points.' },
              ].map((item, i) => (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => sendStarterPrompt(item.prompt)}
                  className="mono"
                  style={{ border: '1px solid var(--ink-black)', background: i === 0 ? 'var(--ink-black)' : 'transparent', color: i === 0 ? 'var(--bg-surface)' : 'var(--ink-black)', fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', padding: '9px 13px', cursor: 'pointer' }}
                >
                  {item.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setStarterStripDismissed(true)}
                aria-label="Dismiss"
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-muted)', padding: 4, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 40, minHeight: 40 }}
              >
                <X size={15} />
              </button>
            </div>
          </div>
        ) : null}
        {/* TELEGRAM CONNECT BANNER — second on the welcome surface (below the
            starter-prompt strip); the post-deploy "put it in your pocket" nudge.
            Dismissible; opens the unified connect modal. */}
        {activeActivationBanner === "telegram" ? (
          <div
            data-testid="instance-telegram-banner"
            className="instance-chat-banner instance-chat-banner-nudge"
            style={{
              background: 'rgba(212, 175, 55, 0.12)',
              borderBottom: '1px solid var(--gold-leaf)',
              padding: '12px 24px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 16,
              flexWrap: 'wrap',
              zIndex: 49,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: '1 1 420px' }}>
              <Send size={18} strokeWidth={2.25} style={{ color: 'var(--gold-leaf)', flexShrink: 0 }} />
              <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink-black)', textTransform: 'uppercase', letterSpacing: '0.12em' }}>
                  Put {instance.name} in your pocket
                </span>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                  Connect Telegram and chat with your agent from your phone — and get pinged the moment work is done. Takes a minute.
                </span>
              </div>
            </div>
            <div className="instance-chat-banner-actions" style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
              <button
                type="button"
                onClick={() => setTelegramOpen(true)}
                className="mono"
                style={{ border: '1px solid var(--ink-black)', background: 'var(--ink-black)', color: 'var(--bg-surface)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 800, padding: '9px 14px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7 }}
              >
                <Send size={13} /> Connect Telegram
              </button>
              <button
                type="button"
                onClick={() => setChannelsOpen(true)}
                className="mono"
                style={{ border: '1px solid var(--etched-border)', background: 'transparent', color: 'var(--ink-black)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 800, padding: '9px 14px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7 }}
              >
                <Radio size={13} /> More channels
              </button>
              <button
                type="button"
                onClick={() => setTelegramBannerDismissed(true)}
                aria-label="Dismiss"
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-muted)', padding: 4, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 40, minHeight: 40 }}
              >
                <X size={15} />
              </button>
            </div>
          </div>
        ) : null}
        {/* STANDING TASKS ENTRY — surfaces the "works while you're away" loop on
            the standard instance lane (it was previously invisible + fully
            locked). Routes to the console Tasks tab; a Free user gets their one
            standing task there. Shown for a running instance until dismissed. */}
        {activeActivationBanner === "tasks" ? (
          <div
            data-testid="instance-standing-tasks-banner"
            className="instance-chat-banner instance-chat-banner-nudge"
            style={{
              background: 'rgba(212, 175, 55, 0.08)',
              borderBottom: '1px solid var(--etched-border)',
              padding: '12px 24px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 16,
              flexWrap: 'wrap',
              zIndex: 47,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: '1 1 420px' }}>
              <CalendarClock size={18} strokeWidth={2.25} style={{ color: 'var(--gold-leaf)', flexShrink: 0 }} />
              <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink-black)', textTransform: 'uppercase', letterSpacing: '0.12em' }}>
                  Standing tasks
                </span>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                  Let your agent run jobs on a schedule, even while you are away.
                </span>
              </div>
            </div>
            <div className="instance-chat-banner-actions" style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
              <button
                type="button"
                onClick={() => router.push(`/dashboard/instances/${instance.id}/console?tab=tasks`)}
                className="mono"
                style={{ border: '1px solid var(--ink-black)', background: 'var(--ink-black)', color: 'var(--bg-surface)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 800, padding: '9px 14px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7 }}
              >
                <CalendarClock size={13} /> Set up a task
              </button>
              <button
                type="button"
                onClick={() => {
                  dismissStandingTasksNudge();
                  setTasksBannerDismissed(true);
                }}
                aria-label="Dismiss"
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-muted)', padding: 4, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 40, minHeight: 40 }}
              >
                <X size={15} />
              </button>
            </div>
          </div>
        ) : null}
        {/* CHANNELS ENTRY — surfaces the multi-platform channel grid (Discord,
            Slack, WhatsApp, Signal + the other env-token channels), all already
            wired in the integrations route but previously UI-less. Dismissible;
            opens the <InstanceChannelsPanel> modal. Telegram keeps its own
            banner/modal above; this is the broader surface. */}
        {activeActivationBanner === "channels" ? (
          <div
            data-testid="instance-channels-banner"
            className="instance-chat-banner instance-chat-banner-nudge"
            style={{
              background: 'rgba(212, 175, 55, 0.08)',
              borderBottom: '1px solid var(--etched-border)',
              padding: '12px 24px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 16,
              flexWrap: 'wrap',
              zIndex: 46,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: '1 1 420px' }}>
              <Radio size={18} strokeWidth={2.25} style={{ color: 'var(--gold-leaf)', flexShrink: 0 }} />
              <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink-black)', textTransform: 'uppercase', letterSpacing: '0.12em' }}>
                  Reach {instance.name} anywhere
                </span>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                  Connect Discord, Slack, WhatsApp, Signal and more — chat with your agent on the channels you already use.
                </span>
              </div>
            </div>
            <div className="instance-chat-banner-actions" style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
              <button
                type="button"
                onClick={() => setChannelsOpen(true)}
                className="mono"
                style={{ border: '1px solid var(--ink-black)', background: 'var(--ink-black)', color: 'var(--bg-surface)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 800, padding: '9px 14px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7 }}
              >
                <Radio size={13} /> Connect channels
              </button>
              <button
                type="button"
                onClick={() => setChannelsBannerDismissed(true)}
                aria-label="Dismiss"
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-muted)', padding: 4, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 40, minHeight: 40 }}
              >
                <X size={15} />
              </button>
            </div>
          </div>
        ) : null}
        {/*
          Inactivity wake banner: shows from the moment the user opens a
          paused-by-inactivity instance until the auto-fired start action
          completes (~30s for a cold qm start). status flips
          'stopped' → 'provisioning' → 'running' as start progresses; we
          show the same warming-up message across both stopped + provisioning
          to make the boot feel like one continuous step.
        */}
        {(instance.paused_reason === "inactivity" &&
          (instance.status === "stopped" || instance.status === "provisioning")) ? (
          // Moment #3 (the HARD wall) takes precedence when the free agent is
          // actually counting down to the dormant-reclaim archive: same slot,
          // loss-aversion copy + real countdown. shouldShowArchiveUpgradeWall
          // fails closed on paid plans and any non-inactivity state, and the flag
          // is default-OFF.
          shouldShowArchiveUpgradeWall({
            enabled: isArchiveUpgradeWallEnabled(),
            plan,
            instance,
          }) ? (
            <ArchiveUpgradeWall
              instanceId={id}
              instanceName={instance.name}
              daysUntilArchive={getArchiveCountdownDays(instance) ?? 0}
            />
          ) :
          // Moment #1: when the flag is ON and the user is confirmed FREE, swap
          // the plain wake banner for the sharpened always-on pitch (paid users
          // never reach this — inactivity-sweep exempts them — and the flag is
          // default-OFF). Otherwise keep the existing live banner unchanged so
          // there is no regression while the copy is under review.
          isSleepUpgradePromptEnabled() && isFreePlanInfo(plan) ? (
            <SleepWakeUpgradePrompt instanceId={id} instanceName={instance.name} />
          ) : (
          <div
            data-testid="instance-inactivity-wake-banner"
            className="instance-chat-banner"
            style={{
              background: 'rgba(59, 130, 246, 0.10)',
              borderBottom: '1px solid rgba(59, 130, 246, 0.24)',
              padding: '12px 24px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 16,
              flexWrap: 'wrap',
              zIndex: 49,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: '1 1 460px' }}>
              <Loader2 size={18} strokeWidth={2.25} style={{ color: '#1d4ed8' }} className="animate-spin" />
              <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                <span
                  className="mono"
                  style={{ fontSize: 11, fontWeight: 700, color: '#1d4ed8', textTransform: 'uppercase', letterSpacing: '0.12em' }}
                >
                  Warming up your agent
                </span>
                <span style={{ fontSize: 13, color: 'rgba(17, 24, 39, 0.78)', lineHeight: 1.45 }}>
                  Free agents sleep after a few idle days — booting {instance.name} back up now (~30s). Upgrade to Pro to keep it always-on.
                </span>
              </div>
            </div>
            <div className="instance-chat-banner-actions" style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
              <button
                type="button"
                onClick={() => {
                  // Inactivity pause only affects FREE agents (paid tiers are
                  // exempt from the sweep — always-on is a Pro differentiator),
                  // so the upgrade is always free → operator (Pro).
                  captureClient('upgrade_clicked', {
                    surface: 'inactivity_banner',
                    limit_type: 'inactivity',
                    instance_id: id,
                    from_plan: 'free',
                    to_plan: 'operator',
                  });
                  router.push('/dashboard/billing');
                }}
                style={{
                  background: '#1a1a1a',
                  color: '#ffffff',
                  border: 'none',
                  padding: '8px 14px',
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: 'pointer',
                  fontFamily: 'var(--font-mono)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  whiteSpace: 'nowrap',
                }}
              >
                Stay always-on
              </button>
            </div>
          </div>
          )
        ) : null}
        {/*
          RAM-cap banner: rendered when the resource-watchdog cron paused
          a free-tier agent for pinning RAM at the cap. We deliberately
          don't auto-restart (it would pin again immediately). Two paths:
          review allocated resources, or restart after reviewing the workload.
        */}
        <MemoryPauseBanner
          status={instance.status}
          pausedReason={instance.paused_reason}
          ramLimitMb={instance.ram_limit}
          actionLoading={actionLoading}
          onReviewResources={() => router.push(`/dashboard/instances/${id}/console?tab=resources`)}
          onRestart={() => powerAction('start')}
        />
        {(isColdStorageRestorableInstance(instance) || isColdStorageRestoringInstance(instance)) ? (
          <div
            data-testid="instance-cold-storage-restore-banner"
            className="instance-chat-banner"
            style={{
              background: 'rgba(59, 130, 246, 0.10)',
              borderBottom: '1px solid rgba(59, 130, 246, 0.24)',
              padding: '14px 24px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 16,
              flexWrap: 'wrap',
              zIndex: 48,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: '1 1 460px' }}>
              {isColdStorageRestoringInstance(instance) ? (
                <Loader2 size={18} strokeWidth={2.25} style={{ color: '#1d4ed8' }} className="animate-spin" />
              ) : (
                <RotateCcw size={18} strokeWidth={2.25} style={{ color: '#1d4ed8' }} />
              )}
              <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                <span
                  className="mono"
                  style={{ fontSize: 11, fontWeight: 700, color: '#1d4ed8', textTransform: 'uppercase', letterSpacing: '0.12em' }}
                >
                  {isColdStorageRestoringInstance(instance) ? 'Restoring from cold storage' : 'Paused in cold storage'}
                </span>
                <span style={{ fontSize: 13, color: 'rgba(17, 24, 39, 0.82)', lineHeight: 1.45 }}>
                  {isColdStorageRestoringInstance(instance)
                    ? 'Restore is already running. Chat history and settings will come back when the agent is online.'
                    : 'Your data is safe. Start restore to bring chat history and settings back online; the first restore usually takes about 5 minutes.'}
                </span>
              </div>
            </div>
            {isColdStorageRestorableInstance(instance) ? (
              <div className="instance-chat-banner-actions" style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
              <button
                type="button"
                onClick={() => {
                  captureClient('cold_storage_restore_clicked', {
                    surface: 'cold_storage_banner',
                    instance_id: id,
                    lifecycle_state: instance.lifecycle_state ?? null,
                  });
                  powerAction('start');
                }}
                disabled={actionLoading}
                style={{
                  background: actionLoading ? 'rgba(255, 255, 255, 0.6)' : '#1d4ed8',
                  color: actionLoading ? '#1d4ed8' : '#ffffff',
                  border: '1px solid rgba(29, 78, 216, 0.26)',
                  padding: '8px 14px',
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: actionLoading ? 'not-allowed' : 'pointer',
                  fontFamily: 'var(--font-mono)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  opacity: actionLoading ? 0.78 : 1,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                {actionLoading ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
                {actionLoading ? 'Starting restore' : 'Start restore'}
              </button>
              </div>
            ) : null}
          </div>
        ) : null}
        {showFailureAlert && instance.failureAlert ? (
          <div
            data-testid="instance-failure-alert"
            className="instance-chat-banner"
            style={{
              background: "rgba(255, 255, 255, 0.76)",
              borderBottom: "1px solid rgba(185, 28, 28, 0.14)",
              padding: "8px 18px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
              zIndex: 46,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: "1 1 420px" }}>
              <AlertTriangle size={16} strokeWidth={2.25} style={{ color: "#b91c1c", flexShrink: 0 }} />
              <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
                <span
                  className="mono"
                  style={{ fontSize: 10, fontWeight: 700, color: "#b91c1c", textTransform: "uppercase", letterSpacing: 0 }}
                >
                  {instance.failureAlert.ownerLabel} · {instance.failureAlert.phaseLabel}
                </span>
                <span
                  style={{
                    fontSize: 12,
                    color: "rgba(17, 24, 39, 0.82)",
                    lineHeight: 1.4,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  <strong>{instance.failureAlert.title}</strong>: {instance.failureAlert.message}
                </span>
                <span className="mono" style={{ fontSize: 10, color: "rgba(17, 24, 39, 0.48)", letterSpacing: 0 }}>
                  Recovery: {instance.failureAlert.recoveryLabel}
                  {instance.failureAlert.requestId ? ` · Request: ${instance.failureAlert.requestId}` : ""}
                </span>
                <ReportProblemLink
                  surface="instance-failure-alert"
                  summary={instance.failureAlert.title}
                  instanceId={instance.id}
                  errorContext={`${instance.failureAlert.title}: ${instance.failureAlert.message}${instance.failureAlert.requestId ? ` (request ${instance.failureAlert.requestId})` : ""}`}
                  style={{ marginTop: 4, color: "rgba(17, 24, 39, 0.62)" }}
                />
              </div>
            </div>
            <div className="instance-chat-banner-actions" style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
              <button
                type="button"
                onClick={() => router.push(`/dashboard/instances/${instance.id}/console`)}
                style={{
                  border: "1px solid rgba(185, 28, 28, 0.18)",
                  background: "rgba(255,255,255,0.68)",
                  color: "#9f1239",
                  padding: "6px 10px",
                  fontSize: 10,
                  fontWeight: 700,
                  cursor: "pointer",
                  fontFamily: "var(--font-mono)",
                  textTransform: "uppercase",
                  letterSpacing: 0,
                }}
              >
                Open Console
              </button>
              <button
                type="button"
                aria-label={`Dismiss ${instance.failureAlert.ownerLabel} alert`}
                onClick={dismissFailureAlert}
                style={{
                  width: 28,
                  height: 28,
                  minWidth: 40,
                  minHeight: 40,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  border: "1px solid rgba(17, 24, 39, 0.12)",
                  background: "rgba(255,255,255,0.58)",
                  color: "rgba(17, 24, 39, 0.58)",
                  cursor: "pointer",
                }}
              >
                <X size={14} strokeWidth={2.2} />
              </button>
            </div>
          </div>
        ) : null}
        {instance.updateAlert ? (
          <div
            data-testid="instance-update-alert"
            className="instance-chat-banner"
            style={{
              background: "rgba(245, 158, 11, 0.12)",
              borderBottom: "1px solid rgba(180, 83, 9, 0.24)",
              padding: "12px 24px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 16,
              flexWrap: "wrap",
              zIndex: 45,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <AlertTriangle size={18} strokeWidth={2.5} style={{ color: "#92400e" }} />
              <div style={{ display: "grid", gap: 4 }}>
                <span
                  className="mono"
                  style={{ fontSize: 12, fontWeight: 700, color: "#92400e", textTransform: "uppercase", letterSpacing: "0.12em" }}
                >
                  Update attention needed
                </span>
                <span style={{ fontSize: 13, color: "var(--ink-black)" }}>
                  {instance.updateAlert.runType === "scheduled"
                    ? "The last auto-update failed. Hermes kept your Docker volumes in place, but this agent needs attention."
                    : "The last manual update failed. Hermes kept your Docker volumes in place, but this agent needs attention."}
                </span>
              </div>
            </div>
            <div className="instance-chat-banner-actions" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                type="button"
                disabled={actionLoading}
                onClick={() => powerAction("repair_runtime")}
                style={{
                  border: "1px solid rgba(180, 83, 9, 0.4)",
                  background: "#b45309",
                  color: "#ffffff",
                  padding: "8px 14px",
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: actionLoading ? "not-allowed" : "pointer",
                  fontFamily: "var(--font-mono)",
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  opacity: actionLoading ? 0.7 : 1,
                }}
              >
                {actionLoading ? "Repairing..." : "Repair agent"}
              </button>
              <button
                type="button"
                onClick={() => router.push(`/dashboard/instances/${instance.id}/console`)}
                style={{
                  border: "1px solid rgba(180, 83, 9, 0.24)",
                  background: "rgba(255,255,255,0.6)",
                  color: "#92400e",
                  padding: "8px 14px",
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: "pointer",
                  fontFamily: "var(--font-mono)",
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                }}
              >
                Open Console
              </button>
            </div>
          </div>
        ) : null}
        </div>
        {/* Agent switcher floats over the top-center as a small collapsible
            handle that expands on click (see AgentSwitcher). At rest it's a
            tiny overlay tab, so it reserves no band and doesn't cover the
            embedded chat's own corner controls. On narrow viewports the
            handle sits in the toolbar band above and the console link is the
            toolbar's own; the expanded switcher still opens here. */}
        <div data-testid="instance-chat-column" style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <AgentSwitcher
            activeKind="hermes"
            activeId={instance.id}
            showConsole={!commandPanelSheet}
            handleHost={commandPanelSheet ? switcherHandleHost : undefined}
          />
          {/* Workflows now live solely in the command panel's managed Workflows
              list — no over-the-chat banner. The panel owns runWorkflowPrompt. */}
          <WebuiIframe
            instanceId={instance.id}
            instanceStatus={instance.status}
            onRequestStart={() => void powerAction("start")}
            onStarterSenderReady={handleStarterSenderReady}
          />
        </div>
      </div>

      {/* ── Command panel (right-docked, toggleable, DEFAULT ON) ──
          A sibling of the chat column inside the root flex row. When open it
          claims a fixed ~360px lane and the chat flexes to fill the rest; when
          collapsed it renders nothing and the chat takes the full width. The
          iframe itself is untouched either way. On narrow viewports (≤1100px)
          the dock is replaced by a bottom sheet opened from the toolbar band,
          so the chat is never squeezed below a usable width. */}
      {commandPanelSheet ? (
        mobilePanelOpen ? (
          <CommandPanelSheet onClose={closeMobilePanel}>
            <CommandPanel
              variant="sheet"
              instanceId={instance.id}
              instanceName={instance.name}
              instanceStatus={instance.status}
              consoleHref={`/dashboard/instances/${instance.id}/console`}
              onRunWorkflow={instance.status === "running" && starterSenderReady ? (prompt) => {
                // The sheet covers the chat, so close it once a workflow lands there.
                const sent = runWorkflowPrompt(prompt);
                if (sent) closeMobilePanel();
                return sent;
              } : undefined}
              onOpenChannels={(channel) => setChannelsOpen(channel ?? true)}
              onCollapse={closeMobilePanel}
            />
          </CommandPanelSheet>
        ) : null
      ) : commandPanelOpen ? (
        <aside
          className="instance-command-panel-dock"
          data-testid="instance-command-panel-dock"
          style={{
            width: 360,
            flexShrink: 0,
            minHeight: 0,
            height: "100%",
            overflow: "hidden",
          }}
        >
          <CommandPanel
            instanceId={instance.id}
            instanceName={instance.name}
            instanceStatus={instance.status}
            onRunWorkflow={instance.status === "running" && starterSenderReady ? runWorkflowPrompt : undefined}
            onOpenChannels={(channel) => setChannelsOpen(channel ?? true)}
            onCollapse={toggleCommandPanel}
          />
        </aside>
      ) : (
        // Collapsed → a slim tab flush to the mid-right edge to bring the panel
        // back. The iframe's own controls live in its TOP-right and BOTTOM-right
        // corners; the vertical mid-point is clear, so the tab never overlaps
        // them (the old top:12/right:12 handle sat on top of the iframe's corner
        // controls). Hidden below 1100px, where the dock itself is gone.
        <button
          type="button"
          onClick={toggleCommandPanel}
          aria-label="Show command panel"
          data-testid="command-panel-reopen"
          className="mono command-panel-reopen"
          style={{
            position: "absolute",
            top: "50%",
            right: 0,
            transform: "translateY(-50%)",
            zIndex: 47,
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            border: "1px solid var(--etched-border)",
            borderRight: "none",
            borderTopLeftRadius: 8,
            borderBottomLeftRadius: 8,
            background: "var(--bg-surface)",
            color: "var(--ink-black)",
            fontSize: 10,
            fontWeight: 800,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            padding: "9px 10px",
            cursor: "pointer",
            boxShadow: "-6px 6px 18px rgba(0,0,0,0.12)",
          }}
        >
          <PanelRightOpen size={13} /> Panel
        </button>
      )}

      {/* Narrow-viewport guard: below 1100px the docked panel would squeeze the
          chat, so the dock and its reopen tab never show there (the sheet takes
          over). Under 640px the banner stack is capped and the connect modals
          anchor to the bottom as sheets. Scoped to this surface. */}
      <style>{`
        @media (max-width: 1100px) {
          .instance-command-panel-dock { display: none !important; }
          .command-panel-reopen { display: none !important; }
        }
        /* The collapsed sidebar's toggle hangs 16px past the rail; keep the
           toolbar's Console link clear of it. */
        @media (min-width: 768px) and (max-width: 1100px) {
          .instance-chat-toolbar { padding-left: 24px !important; }
        }
        @media (max-width: 640px) {
          .instance-chat-banner-stack {
            max-height: 40%;
            overflow-y: auto;
            border-bottom: 1px solid var(--etched-border);
          }
          /* Inside the capped stack, system alerts and their recovery actions
             come before the activation nudge. */
          .instance-chat-banner-nudge { order: 1; }
          .instance-connect-modal-overlay {
            align-items: flex-end !important;
            padding: 0 !important;
          }
          .instance-connect-modal {
            width: 100% !important;
            max-height: calc(var(--workspace-viewport-height, 100dvh) - env(safe-area-inset-top, 0px) - 16px) !important;
            border-left: none !important;
            border-right: none !important;
            border-bottom: none !important;
            padding-bottom: env(safe-area-inset-bottom, 0px);
          }
        }
      `}</style>

      {showCodexOAuthModal ? (
        <CodexOAuthModal
          instanceId={instance.id}
          autoStart
          onClose={() => setCodexOAuthDismissed(true)}
          onSuccess={() => {
            setCodexOAuthDismissed(true);
            void fetchInstance(true);
          }}
        />
      ) : null}

      {/* ── Terminal popout window ── */}
      <AnimatePresence>
        {terminalVisible ? (
          <SafePortal>
            <motion.div
              style={{
                position: 'fixed',
                top: 0, left: 0, right: 0, bottom: 0,
                backgroundColor: 'rgba(0, 0, 0, 0.65)',
                backdropFilter: 'blur(4px)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 9999,
                padding: terminalOverlayPadding,
                boxSizing: 'border-box',
              }}
              data-testid="terminal-popout-overlay"
              initial="hidden"
              animate="visible"
              exit="exit"
              variants={overlayVariants}
            >
            <motion.div
              drag
              dragMomentum={false}
              dragElastic={0.1}
              initial="hidden"
              animate="visible"
              exit="exit"
              variants={terminalWindowVariants}
              transition={dockSpring}
              style={{
              width: 'calc(100vw - 24px)',
              height: 'calc(100dvh - 24px)',
              minWidth: 0,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              background: '#050711',
              overflow: 'hidden',
              borderRadius: 8,
              border: '1px solid rgba(150, 166, 190, 0.16)',
              boxShadow: '0 28px 80px rgba(0, 0, 0, 0.55)',
            }} data-testid="terminal-popout-window">
            {/* Header */}
            <div style={{
              padding: '10px 14px',
              borderBottom: '1px solid rgba(150, 166, 190, 0.12)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              background: 'rgba(9, 12, 22, 0.96)',
              flexShrink: 0,
              gap: 12,
            }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
              <span style={{
                width: 32,
                height: 32,
                borderRadius: 6,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: `1px solid ${terminalMode === 'tui' ? 'rgba(255, 44, 45, 0.24)' : 'rgba(45, 212, 191, 0.22)'}`,
                background: terminalMode === 'tui' ? 'rgba(255, 44, 45, 0.08)' : 'rgba(45, 212, 191, 0.08)',
                color: terminalMode === 'tui' ? '#f2de9a' : '#99f6e4',
                flexShrink: 0,
              }}>
                <TerminalIcon size={16} />
              </span>
              <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{
                    fontFamily: '"JetBrains Mono", monospace',
                    fontSize: 12,
                    color: '#f8fafc',
                    fontWeight: 700,
                  }}>{terminalMode === 'tui' ? 'Hermes TUI' : 'SSH Terminal'}</span>
                  <span style={{
                    fontFamily: '"JetBrains Mono", monospace',
                    fontSize: 10,
                    color: 'rgba(148, 163, 184, 0.72)',
                    letterSpacing: '0.04em',
                  }}>{instance.id.slice(0, 8)}</span>
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {terminalMode === 'tui' ? (
                <button
                  onClick={() => {
                    setTerminalVisible(false);
                    router.push(`/dashboard/instances/${instance.id}/tui`);
                  }}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    border: '1px solid rgba(255, 44, 45, 0.22)',
                    borderRadius: 6,
                    background: 'rgba(255, 44, 45, 0.08)',
                    color: '#f5ebc8',
                    padding: '8px 10px',
                    cursor: 'pointer',
                    fontFamily: '"JetBrains Mono", monospace',
                    fontSize: 10,
                    fontWeight: 700,
                  }}
                >
                  <ExternalLink size={13} />
                  Open full workspace
                </button>
              ) : null}
              <motion.button
                onClick={() => setTerminalVisible(false)}
                style={{
                  background: 'rgba(148, 163, 184, 0.06)',
                  border: '1px solid rgba(148, 163, 184, 0.12)',
                  cursor: 'pointer',
                  color: 'rgba(203, 213, 225, 0.78)',
                  width: 32,
                  height: 32,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 6,
                  transition: 'all 0.2s',
                }}
                aria-label="Close terminal"
                whileTap={reduceMotion ? undefined : { scale: 0.94 }}
                transition={dockSpring}
                onMouseEnter={(e) => { e.currentTarget.style.color = '#f87171'; e.currentTarget.style.background = 'rgba(248,113,113,0.1)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(203, 213, 225, 0.78)'; e.currentTarget.style.background = 'rgba(148, 163, 184, 0.06)'; }}
              >
                <X size={15} />
              </motion.button>
            </div>
          </div>

          {/* Terminal content */}
          <div style={{ flex: 1, position: 'relative', overflow: 'hidden', minHeight: 0, minWidth: 0 }}>
            {terminalMode === "shell" ? (
              <ShellTerminalWorkspace
                key={`${instance.id}:shell-workspace`}
                instanceId={instance.id}
                isActive={terminalVisible}
              />
            ) : (
              <TerminalPanel
                key={`${instance.id}:${terminalMode}:terminal-panel`}
                instanceId={instance.id}
                isActive={terminalVisible}
                sessionMode={terminalMode}
                surfaceKey="tui-modal"
              />
            )}
          </div>
            </motion.div>
            </motion.div>
          </SafePortal>
        ) : null}
      </AnimatePresence>

      {/* ── File Explorer popout window ── */}
      <AnimatePresence>
        {explorerVisible ? (
          <SafePortal>
            <motion.div
              style={{
                position: 'fixed',
                top: 0, left: 0, right: 0, bottom: 0,
                background: 'color-mix(in srgb, var(--overlay-bg) 78%, rgba(0,0,0,0.22))',
                backdropFilter: 'blur(10px)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 9999,
                padding: 'clamp(16px, 2.4vw, 30px)',
              }}
              initial="hidden"
              animate="visible"
              exit="exit"
              variants={overlayVariants}
            >
            <motion.div
              drag
              dragMomentum={false}
              dragElastic={0.1}
              initial="hidden"
              animate="visible"
              exit="exit"
              variants={explorerWindowVariants}
              transition={dockSpring}
              style={{
              width: 'min(1460px, calc(100vw - 40px))',
              height: 'min(920px, calc(100vh - 40px))',
              display: 'flex',
              flexDirection: 'column',
              background: 'color-mix(in srgb, var(--bg-surface) 92%, transparent)',
              overflow: 'hidden',
              borderRadius: 0,
              border: '1px solid var(--etched-border)',
              boxShadow: '0 24px 80px rgba(0, 0, 0, 0.22)',
            }}>
            {/* Header */}
            <div style={{
              padding: '14px 18px',
              borderBottom: '1px solid var(--etched-border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              background: 'color-mix(in srgb, var(--vellum-bg) 88%, transparent)',
              flexShrink: 0,
            }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {/* Folder Icon */}
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--gold-leaf)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
              </svg>
              <span style={{
                fontFamily: 'var(--font-mono), monospace',
                fontSize: 11,
                color: 'var(--ink-black)',
                letterSpacing: '0.12em',
                fontWeight: 700,
                textTransform: 'uppercase',
              }}>File Explorer</span>
              <span style={{
                fontFamily: 'var(--font-mono), monospace',
                fontSize: 10,
                color: 'var(--text-muted)',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
              }}>{instance.id.slice(0, 8)}</span>
            </div>
            <motion.button
              onClick={() => setExplorerVisible(false)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--text-muted)', padding: '4px', display: 'flex',
                borderRadius: 0, transition: 'all 0.2s',
              }}
              aria-label="Close file explorer"
              whileTap={reduceMotion ? undefined : { scale: 0.94 }}
              transition={dockSpring}
              onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--red)'; e.currentTarget.style.background = 'rgba(239,68,68,0.08)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'none'; }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </motion.button>
          </div>

            {/* Explorer content */}
          <div style={{ flex: 1, position: 'relative', overflow: 'hidden', minHeight: 0, background: 'var(--bg-primary)', padding: '12px' }}>
            <FileExplorer
              instanceId={instance.id}
              defaultPath={resolveExplorerHome(instance.id)}
              rootPath={resolveExplorerRoot(getRuntimeAgentSettings(instance.config).enableRootAccess)}
            />
          </div>
            </motion.div>
            </motion.div>
          </SafePortal>
        ) : null}
      </AnimatePresence>

      {/* ── Telegram connect modal (the unified <TelegramConnect> flow) ── */}
      {telegramOpen ? (
        <SafePortal>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Connect Telegram"
            onClick={() => setTelegramOpen(false)}
            className="instance-connect-modal-overlay"
            style={CONNECT_MODAL_OVERLAY_STYLE}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="instance-connect-modal"
              style={{ ...CONNECT_MODAL_PANEL_STYLE, width: 'min(600px, calc(100vw - 32px))' }}
            >
              <ConnectModalHeader title="Connect Telegram" onClose={() => setTelegramOpen(false)} />
              <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
                <InstanceTelegramConnect
                  instanceId={instance.id}
                  agentName={instance.name}
                  onStatusChange={(s) => setTelegramConnected(s.connected)}
                />
              </div>
            </div>
          </div>
        </SafePortal>
      ) : null}

      {/* ── Channels modal (multi-platform grid) ── */}
      {channelsOpen ? (
        <SafePortal>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Connect channels"
            onClick={() => setChannelsOpen(false)}
            className="instance-connect-modal-overlay"
            style={{ ...CONNECT_MODAL_OVERLAY_STYLE, zIndex: 9998 }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="instance-connect-modal"
              style={{ ...CONNECT_MODAL_PANEL_STYLE, width: 'min(820px, calc(100vw - 32px))' }}
            >
              <ConnectModalHeader title="Channels" onClose={() => setChannelsOpen(false)} />
              <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', '--channels-scroll-pad-top': '20px', padding: 'var(--channels-scroll-pad-top) clamp(16px, 4vw, 24px) 28px' } as React.CSSProperties}>
                <h2 className="serif" style={{ fontSize: '1.6rem', fontWeight: 400, color: 'var(--ink-black)', margin: '0 0 6px' }}>
                  Channels
                </h2>
                <p style={{ fontSize: 13.5, color: 'var(--text-secondary)', lineHeight: 1.6, margin: '0 0 22px', maxWidth: 560 }}>
                  Connect {instance.name} to the messaging channels and tools you already use. Each connection runs in your
                  isolated agent — credentials never leave the box.
                </p>
                <InstanceChannelsPanel
                  instanceId={instance.id}
                  agentName={instance.name}
                  initialChannel={typeof channelsOpen === 'string' ? channelsOpen : null}
                />
              </div>
            </div>
          </div>
        </SafePortal>
      ) : null}
    </div>
  );
}
