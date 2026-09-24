"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { LoadingState } from "@/components/ui/LoadingState";
import { Loader2, Maximize2, Minimize2, Monitor, RefreshCw, Settings2, ShieldCheck } from "lucide-react";

import styles from "./HivraRemoteDesktop.module.css";
import { useWorkspaceModalLayer } from "@/components/workspace/WorkspaceModalLayerContext";
import { clientLog } from "@/lib/client/logger";

import { HivraDesktopViewport } from "./HivraDesktopViewport";
import {
  DESKTOP_STREAMING_MODE_DETAILS,
  DESKTOP_STREAMING_MODES,
  readStreamModePreference,
  writeStreamModePreference,
  type DesktopStreamingMode,
} from "@/lib/remote-computers/streaming-mode-preference";

type ConnectionState =
  | "connecting"
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "unavailable"
  | "blocked"
  | "preparing"
  | "prepare-failed"
  | "prepare-paused"
  | "prepare-pending"
  | "upgrade-required"
  | "desktop-upgrade-required"
  | "failed";

type IssuedSession = {
  id: string;
  exchangeCode: string;
  handoff: "message";
  transport: "selkies-websocket";
  inputRole: "controller";
  streamingMode: StreamMode;
  brokerOrigin: string;
  expiresAt: string;
};

type PendingHandoff = {
  sessionId: string;
  exchangeCode: string;
  verifier: string;
  streamingMode: StreamMode;
  sent: boolean;
};

type SessionResponsePayload = {
  success?: boolean;
  code?: string;
  error?: string;
  data?: IssuedSession;
};

/** One short word for the strip; the full sentence stays as its tooltip. */
const STATE_LABELS: Record<ConnectionState, string> = {
  connecting: "Opening",
  connected: "Connected",
  disconnected: "Disconnected",
  reconnecting: "Reconnecting",
  unavailable: "Unavailable",
  blocked: "Blocked",
  preparing: "Opening",
  "prepare-failed": "Couldn\u2019t open",
  "prepare-paused": "Paused",
  "prepare-pending": "Still opening",
  "upgrade-required": "Update needed",
  "desktop-upgrade-required": "Update needed",
  failed: "Couldn\u2019t open",
};

const CAPABILITY_REFRESH_INTERVAL_MS = 2 * 60_000;
const RATE_LIMIT_CONNECT_BACKOFF_MS = 2_500;
const RATE_LIMIT_PREPARE_BACKOFF_MS = 5_000;
const RATE_LIMIT_PREPARE_BACKOFF_CAP_MS = 8_000;
const RATE_LIMIT_PREPARE_MAX_WAITS = 1;

/** Fail/retry/rate_limit copy: Opening / Retry / Wait — never Prepare/preparing. */
function scrubDesktopUserMessage(message: string): string {
  return message
    .replace(/Wait before preparing this desktop again\.?/gi, "Wait before opening this desktop again.")
    .replace(/\bPreparing\b/g, "Opening")
    .replace(/\bpreparing\b/g, "opening")
    .replace(/\bPrepare\b/g, "Open")
    .replace(/\bprepare\b/g, "open")
    .replace(/\bPreparation\b/g, "Setup")
    .replace(/\bpreparation\b/g, "setup");
}

function isLifecycleBlocked(code: string | undefined): boolean {
  return code === "computer_lifecycle_blocked" || code === "computer_operation_blocked";
}

// The guest broker keeps a disconnected controller for 10 seconds. A generic
// conflict therefore gets one grace-period wait, but remains bounded so a
// genuinely active controller is never displaced. Once the server proves the
// old controller is release-pending, allow the guest's authenticated release
// receipt more time while staying below the session-issue rate limit.
const CONTROLLER_CONFLICT_GRACE_MS = 10_000;
const CONTROLLER_CONFLICT_RETRY_INTERVAL_MS = 2_000;
const ACTIVE_CONTROLLER_RETRY_WINDOW_MS = 20_000;
const RELEASING_CONTROLLER_RETRY_WINDOW_MS = 40_000;
// Losing the stream does not stop the desktop or the apps open on it. While
// this page is visible and online, reconnect on our own a few times, spaced out
// so a restarting desktop gateway or a network change can settle; after that,
// Reconnect is the user's. Every attempt proves the runtime first and never
// installs anything. A stream that then stays up for a minute earns a fresh
// budget, so a flapping link cannot keep requesting sessions.
const STREAM_RECONNECT_DELAYS_MS = [2_000, 5_000, 15_000] as const;
const STREAM_RECONNECT_STABLE_MS = 60_000;
/** Broker reasons that mean only this page's stream ended, not the desktop. */
const STREAM_DROP_REASONS: ReadonlySet<string> = new Set([
  "transport-closed",
  "transport-error",
  "document-reloaded",
  "document-closed",
]);
const STREAM_DROPPED_MESSAGE = "Stream disconnected. Your desktop and its apps are still running.";
const VIEWPORT_UPDATE_DEBOUNCE_MS = 100;
const MAX_BROWSER_TIMING_SAMPLES = 200;
type BrowserTimingSample = { durationMs: number; outcome: "changed" | "timeout" };
type StreamMode = DesktopStreamingMode;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The session expiry as a clock time — the value the old badge never showed. */
function formatExpiry(value: string): string {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return "Unknown";
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(new Date(at));
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1000 ? `${Math.round(milliseconds)} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
}

function percentileSample(values: readonly BrowserTimingSample[], quantile: number): BrowserTimingSample | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left.durationMs - right.durationMs);
  const index = Math.max(0, Math.ceil(quantile * sorted.length) - 1);
  return sorted[index] ?? null;
}

function formatTimingSample(sample: BrowserTimingSample): string {
  return sample.outcome === "timeout" ? "≥2.0 s" : formatDuration(sample.durationMs);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function newPkce(): Promise<{ verifier: string; challenge: string }> {
  if (!window.crypto?.getRandomValues || !window.crypto.subtle) throw new Error("secure_browser_required");
  const verifier = base64Url(window.crypto.getRandomValues(new Uint8Array(32)));
  const digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

async function revokeSession(sessionId: string): Promise<void> {
  try {
    await fetch(`/api/remote-desktop/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      credentials: "same-origin",
      keepalive: true,
    });
  } catch {
    // The guest broker also terminates and releases input when its media lane
    // closes. Owner revocation is an eager second fence, not the only cleanup.
  }
}

/** Speculative TLS/document warm for the handoff origin. Never mounts the iframe. */
function warmHandoffOrigin(origin: string | null | undefined): void {
  if (!origin) return;
  try {
    const url = new URL("/desktop/handoff", origin);
    if (url.protocol !== "https:" || url.origin !== origin) return;
    void fetch(url.toString(), {
      method: "GET",
      mode: "no-cors",
      credentials: "omit",
      cache: "no-store",
      keepalive: true,
      referrerPolicy: "no-referrer",
    }).catch(() => {});
  } catch {
    // Warm is best-effort only.
  }
}

/**
 * While an in-page immersive layer covers the page, everything outside it is
 * made inert, so the controls it hides leave the tab order and the
 * accessibility tree. Elements that were already inert are left as they were.
 */
export function useInertOutside(layerRef: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    const layer = layerRef.current;
    if (!active || !layer) return;
    const made: Element[] = [];
    let branch: Element = layer;
    while (branch.parentElement) {
      const parent: HTMLElement = branch.parentElement;
      for (const element of Array.from(parent.children)) {
        if (element === branch || element.hasAttribute("inert")) continue;
        element.setAttribute("inert", "");
        made.push(element);
      }
      if (parent === document.body) break;
      branch = parent;
    }
    return () => {
      for (const element of made) element.removeAttribute("inert");
    };
  }, [active, layerRef]);
}

export function HivraRemoteDesktop({
  computerId,
  name,
  active = true,
  autoPrepare = false,
  handoffWarmOrigin = null,
}: {
  computerId: string;
  name: string;
  active?: boolean;
  autoPrepare?: boolean;
  /** Optional https origin to warm in parallel with session issue (chat/broker). */
  handoffWarmOrigin?: string | null;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const fullscreenRef = useRef<HTMLElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // In-page stand-in for element fullscreen where the browser has none.
  const [immersive, setImmersive] = useState(false);
  if (immersive && !active) setImmersive(false);
  useWorkspaceModalLayer("surface", immersive);
  useInertOutside(fullscreenRef, immersive);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDetailsElement>(null);
  const menuPanelRef = useRef<HTMLDivElement>(null);
  const [fitDesktop, setFitDesktop] = useState(true);
  const [streamMode, setStreamMode] = useState<StreamMode>(() => readStreamModePreference(computerId));
  const streamModeRef = useRef(streamMode);
  useEffect(() => {
    const preferred = readStreamModePreference(computerId);
    streamModeRef.current = preferred;
    setStreamMode(preferred);
  }, [computerId]);
  useEffect(() => {
    const changed = () => setIsFullscreen(document.fullscreenElement === fullscreenRef.current);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  // Escape only reaches this window while focus is outside the desktop frame;
  // the strip's Exit full screen button is the dependable way out.
  useEffect(() => {
    if (!immersive) return;
    const exit = (event: KeyboardEvent) => { if (event.key === "Escape") setImmersive(false); };
    window.addEventListener("keydown", exit);
    return () => window.removeEventListener("keydown", exit);
  }, [immersive]);
  // Taps on the desktop land in its cross-origin frame and never reach this
  // document, so the settings panel also closes when the window loses focus.
  useEffect(() => {
    if (!menuOpen) return;
    const outside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const blurred = () => setMenuOpen(false);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("blur", blurred);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("blur", blurred);
    };
  }, [menuOpen]);
  // The panel hangs below the strip, whose height and offset vary (landscape,
  // banner, immersive), so it is bounded by the room actually left above the
  // bottom bar or the visual viewport.
  useLayoutEffect(() => {
    const panel = menuPanelRef.current;
    if (!menuOpen || !panel) return;
    const viewport = window.visualViewport;
    const place = () => {
      let bottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
      const bar = document.querySelector('[data-testid="pwa-bottom-navigation"]')?.getBoundingClientRect();
      if (bar && bar.height > 0) bottom = Math.min(bottom, bar.top);
      panel.style.maxHeight = `${Math.max(120, Math.floor(bottom - panel.getBoundingClientRect().top - 8))}px`;
    };
    place();
    window.addEventListener("resize", place);
    viewport?.addEventListener("resize", place);
    viewport?.addEventListener("scroll", place);
    return () => {
      window.removeEventListener("resize", place);
      viewport?.removeEventListener("resize", place);
      viewport?.removeEventListener("scroll", place);
      panel.style.maxHeight = "";
    };
  }, [menuOpen]);
  const sessionIdRef = useRef<string | null>(null);
  const handoffRef = useRef<PendingHandoff | null>(null);
  const attemptRef = useRef(0);
  const initialConnectionStartedRef = useRef(false);
  const setupStartedAtRef = useRef<number | null>(null);
  const refreshAttemptedRef = useRef(false);
  const autoPrepareAttemptedRef = useRef(false);
  const repairableUnavailableRef = useRef(false);
  const lastTelemetrySequenceRef = useRef(0);
  const conflictWaitRef = useRef<{ timeout: number; finish: () => void } | null>(null);
  const [state, setState] = useState<ConnectionState>("connecting");
  const [controllerConflict, setControllerConflict] = useState(false);
  const [brokerOrigin, setBrokerOrigin] = useState<string | null>(null);
  const [handoffListenerReady, setHandoffListenerReady] = useState(false);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [secureSetupMs, setSecureSetupMs] = useState<number | null>(null);
  const [browserInputSamples, setBrowserInputSamples] = useState<BrowserTimingSample[]>([]);
  const [browserInputTotals, setBrowserInputTotals] = useState({ total: 0, stalls: 0 });
  const [message, setMessage] = useState("Proving this computer’s secure desktop capability…");
  const stateRef = useRef(state);
  stateRef.current = state;
  const hiddenEpisodeRef = useRef<{ startedAt: number; ended: boolean; consumed: boolean; returned?: boolean; refreshed?: boolean } | null>(null);
  const allowAutomaticPrepareRef = useRef(true);
  // Automatic reconnection after the stream dropped. `armed` lasts until a
  // stream connects again, the budget runs out, or the user acts; `attempts`
  // survives a reconnect that drops again before it proved stable.
  const recoveryRef = useRef<{ armed: boolean; immediate: boolean; attempts: number; connectedAt: number | null }>({
    armed: false, immediate: false, attempts: 0, connectedAt: null,
  });
  const [recoveryTick, setRecoveryTick] = useState(0);
  /** The user's own action (or a repair) replaces any pending automatic reconnect. */
  const cancelStreamRecovery = useCallback(() => {
    const recovery = recoveryRef.current;
    recovery.armed = false;
    recovery.immediate = false;
    recovery.attempts = 0;
  }, []);

  const connect = useCallback(async (options: { allowPrepare?: boolean; ownerHandoff?: boolean } = {}) => {
    allowAutomaticPrepareRef.current = options.allowPrepare !== false;
    if (options.allowPrepare !== false) hiddenEpisodeRef.current = null;
    const attempt = ++attemptRef.current;
    conflictWaitRef.current?.finish();
    const previous = sessionIdRef.current;
    sessionIdRef.current = null;
    handoffRef.current = null;
    setBrokerOrigin(null);
    setHandoffListenerReady(false);
    setExpiresAt(null);
    setSecureSetupMs(null);
    setBrowserInputSamples([]);
    setBrowserInputTotals({ total: 0, stalls: 0 });
    lastTelemetrySequenceRef.current = 0;
    setupStartedAtRef.current = window.performance.now();
    setState("connecting");
    setControllerConflict(false);
    repairableUnavailableRef.current = false;
    setMessage("Proving this computer’s secure desktop capability…");
    // Do not block session issue on previous-session revoke.
    if (previous) void revokeSession(previous);
    // Speculative warm of a known chat/broker origin in parallel with issue.
    // The iframe still mounts only after the message listener is ready.
    warmHandoffOrigin(handoffWarmOrigin);

    try {
      if (!("VideoDecoder" in window)) throw new Error("webcodecs_unavailable");
      if (options.allowPrepare === false) {
        // A foreground recovery proves current owner/runtime readiness BEFORE
        // requesting any new authority. It never installs or resumes a repair.
        const response = await fetch(`/api/hivra/agents/${encodeURIComponent(computerId)}/remote-desktop`, {
          method: "POST", credentials: "same-origin",
          headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "refresh" }),
        });
        const proof = await response.json().catch(() => null) as { success?: boolean; code?: string; error?: string; data?: { prepared?: boolean } } | null;
        if (attempt !== attemptRef.current) return;
        if (!response.ok || !proof?.success || proof.data?.prepared !== true) {
          setState(isLifecycleBlocked(proof?.code) ? "blocked" : "unavailable");
          setMessage(scrubDesktopUserMessage(proof?.error || "The desktop's current runtime proof could not be verified."));
          return;
        }
      }
      // Replacing an active controller requires an explicit action here. Normal
      // opening, retries and foreground recovery must never revoke another tab.
      let ownerHandoff = options.ownerHandoff === true;
      const issue = async () => {
        const requestOwnerHandoff = ownerHandoff;
        ownerHandoff = false;
        const { verifier, challenge } = await newPkce();
        const response = await fetch("/api/remote-desktop/sessions", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            computerKind: "hivra-agent",
            ownerHandoff: requestOwnerHandoff,
            computerId,
            purpose: "daily-driver",
            inputRole: "controller",
            streamingMode: streamModeRef.current,
            requestedTransport: "selkies-websocket",
            client: { kind: "browser", moonlight: false, webCodecs: true, udp: "blocked" },
            pkceChallenge: challenge,
            ttlSeconds: 240,
          }),
        });
        const payload = await response.json().catch(() => null) as SessionResponsePayload | null;
        return { response, payload, verifier };
      };

      let issued = await issue();
      if (attempt !== attemptRef.current) {
        if (issued.payload?.data?.id) void revokeSession(issued.payload.data.id);
        return;
      }
      if (isLifecycleBlocked(issued.payload?.code)) {
        setState("blocked");
        setMessage(issued.payload?.error || "Check this computer's status in Manage before opening Desktop.");
        return;
      }
      const conflictStartedAt = Date.now();
      let releasingDeadline: number | null = null;
      let conflictDelay = issued.payload?.code === "controller_releasing"
        ? CONTROLLER_CONFLICT_RETRY_INTERVAL_MS
        : CONTROLLER_CONFLICT_GRACE_MS;
      while (
        issued.response.status === 409
        && (issued.payload?.code === "controller_conflict" || issued.payload?.code === "controller_releasing")
      ) {
        const releasing = issued.payload.code === "controller_releasing";
        if (releasing && releasingDeadline === null) {
          releasingDeadline = Date.now() + RELEASING_CONTROLLER_RETRY_WINDOW_MS;
        }
        const conflictDeadline = releasing
          ? releasingDeadline!
          : conflictStartedAt + ACTIVE_CONTROLLER_RETRY_WINDOW_MS;
        if (Date.now() >= conflictDeadline) break;
        setMessage(releasing
          ? "The previous desktop is releasing control. Reconnecting automatically…"
          : "Waiting briefly for the existing controller. An active desktop elsewhere will not be interrupted.");
        const remaining = conflictDeadline - Date.now();
        await new Promise<void>(resolve => {
          let timeout = 0;
          const finish = () => {
            window.clearTimeout(timeout);
            if (conflictWaitRef.current?.timeout === timeout) conflictWaitRef.current = null;
            resolve();
          };
          timeout = window.setTimeout(finish, Math.min(conflictDelay, remaining));
          conflictWaitRef.current = { timeout, finish };
        });
        if (attempt !== attemptRef.current) return;
        issued = await issue();
        if (attempt !== attemptRef.current) {
          if (issued.payload?.data?.id) await revokeSession(issued.payload.data.id);
          return;
        }
        conflictDelay = CONTROLLER_CONFLICT_RETRY_INTERVAL_MS;
      }
      let unavailableMessage = "This computer has not proved a current remote-desktop runtime yet. Its agent, chat, terminal, and files are unchanged.";
      if (
        issued.response.status === 409
        && issued.payload?.code === "capability_unavailable"
        && !refreshAttemptedRef.current
      ) {
        refreshAttemptedRef.current = true;
        setMessage("Rechecking this computer’s installed desktop runtime…");
        const refreshResponse = await fetch(`/api/hivra/agents/${encodeURIComponent(computerId)}/remote-desktop`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "refresh" }),
        });
        const refreshPayload = await refreshResponse.json().catch(() => null) as {
          success?: boolean;
          code?: string;
          error?: string;
          data?: { prepared?: boolean };
        } | null;
        if (attempt !== attemptRef.current) return;
        if (refreshResponse.ok && refreshPayload?.success && refreshPayload.data?.prepared === true) {
          issued = await issue();
        } else if (isLifecycleBlocked(refreshPayload?.code)) {
          setState("blocked");
          setMessage(refreshPayload?.error || "Check this computer's status in Manage before opening Desktop.");
          return;
        } else if (refreshPayload?.code === "desktop_upgrade_required") {
          setState("desktop-upgrade-required");
          setMessage(scrubDesktopUserMessage(refreshPayload.error || "This desktop needs an update to establish its shared-folder identity. This check did not install or change anything."));
          return;
        } else if (refreshPayload?.code === "legacy_identity_unbound" || refreshPayload?.code === "unsupported_computer") {
          setState("upgrade-required");
          setMessage(scrubDesktopUserMessage(refreshPayload.error || "This computer needs a current launch before Desktop can open."));
          return;
        } else if (
          refreshPayload?.code === "provider_desktop_refresh_required"
          || refreshPayload?.code === "provider_desktop_unverified"
        ) {
          // Provider Ubuntu desktops cannot be reinstalled via prepare. Stay on
          // refresh/issue path so Terminal/Files attach is not blocked by a
          // stuck "Repairing desktop runtime…" loop.
          setState("unavailable");
          setMessage(scrubDesktopUserMessage(
            refreshPayload.error || "Could not verify this provider desktop. Terminal and Files stay available when the box connection is up; inspect Desktop launch status in Manage.",
          ));
          return;
        } else if (refreshPayload?.code === "rate_limited") {
          // Shared refresh quota with page prefetch — backoff then retry connect.
          // Never teach Prepare; auto-prepare only when capability is truly missing.
          setMessage("Wait — desktop is catching up. Reconnecting…");
          await new Promise<void>((resolve) => {
            let timeout = 0;
            const finish = () => {
              window.clearTimeout(timeout);
              if (conflictWaitRef.current?.timeout === timeout) conflictWaitRef.current = null;
              resolve();
            };
            timeout = window.setTimeout(finish, RATE_LIMIT_CONNECT_BACKOFF_MS);
            conflictWaitRef.current = { timeout, finish };
          });
          if (attempt !== attemptRef.current) return;
          issued = await issue();
        } else if (options.allowPrepare !== false && !autoPrepareAttemptedRef.current) {
          // Runtime missing/unverified — repair in the background, then retry connect.
          autoPrepareAttemptedRef.current = true;
          setState("preparing");
          setMessage("Repairing desktop runtime…");
          try {
            let preparePayload: {
              success?: boolean;
              code?: string;
              error?: string;
              data?: { prepared?: boolean };
            } | null = null;
            let prepareOk = false;
            for (let wait = 0; wait <= RATE_LIMIT_PREPARE_MAX_WAITS; wait += 1) {
              const prepareResponse = await fetch(`/api/hivra/agents/${encodeURIComponent(computerId)}/remote-desktop`, {
                method: "POST",
                credentials: "same-origin",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ action: "prepare" }),
              });
              preparePayload = await prepareResponse.json().catch(() => null) as {
                success?: boolean;
                code?: string;
                error?: string;
                data?: { prepared?: boolean };
              } | null;
              if (attempt !== attemptRef.current) return;
              if (prepareResponse.ok && preparePayload?.success && preparePayload.data?.prepared === true) {
                prepareOk = true;
                break;
              }
              if (preparePayload?.code !== "rate_limited" || wait === RATE_LIMIT_PREPARE_MAX_WAITS) {
                break;
              }
              // Prepare quota (3/15m) — stay on Opening progress, backoff, then retry.
              setState("preparing");
              setMessage("Wait before opening this desktop again. Retrying…");
              const backoffMs = Math.min(
                RATE_LIMIT_PREPARE_BACKOFF_MS * (2 ** wait),
                RATE_LIMIT_PREPARE_BACKOFF_CAP_MS,
              );
              await new Promise<void>((resolve) => {
                let timeout = 0;
                const finish = () => {
                  window.clearTimeout(timeout);
                  if (conflictWaitRef.current?.timeout === timeout) conflictWaitRef.current = null;
                  resolve();
                };
                timeout = window.setTimeout(finish, backoffMs);
                conflictWaitRef.current = { timeout, finish };
              });
              if (attempt !== attemptRef.current) return;
              // Prefer a cheap refresh before burning another prepare slot.
              const bridgeRefresh = await fetch(`/api/hivra/agents/${encodeURIComponent(computerId)}/remote-desktop`, {
                method: "POST",
                credentials: "same-origin",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ action: "refresh" }),
              });
              const bridgePayload = await bridgeRefresh.json().catch(() => null) as {
                success?: boolean;
                data?: { prepared?: boolean };
              } | null;
              if (attempt !== attemptRef.current) return;
              if (bridgeRefresh.ok && bridgePayload?.success && bridgePayload.data?.prepared === true) {
                prepareOk = true;
                preparePayload = { success: true, data: { prepared: true } };
                break;
              }
              setMessage("Repairing desktop runtime…");
            }
            if (!prepareOk) {
              if (isLifecycleBlocked(preparePayload?.code)) {
                setState("blocked");
              } else if (preparePayload?.code === "legacy_identity_unbound" || preparePayload?.code === "unsupported_computer") {
                setState("upgrade-required");
              } else if (
                preparePayload?.code === "provider_desktop_refresh_required"
                || preparePayload?.code === "provider_desktop_unverified"
              ) {
                setState("unavailable");
              } else {
                setState(preparePayload?.code === "canary_desktop_prepare_paused" ? "prepare-paused"
                  : preparePayload?.code === "desktop_prepare_pending" ? "prepare-pending" : "prepare-failed");
              }
              setMessage(scrubDesktopUserMessage(
                preparePayload?.error || "Desktop couldn’t open. Retry to repair the runtime and try again.",
              ));
              return;
            }
            setMessage("Opening desktop…");
            issued = await issue();
          } catch {
            if (attempt !== attemptRef.current) return;
            setState("prepare-failed");
            setMessage("Desktop couldn’t open. Retry to repair the runtime and try again.");
            return;
          }
        } else if (refreshPayload?.error) {
          unavailableMessage = scrubDesktopUserMessage(refreshPayload.error);
        }
      }
      const { response, payload, verifier } = issued;
      if (attempt !== attemptRef.current) {
        if (payload?.data?.id) void revokeSession(payload.data.id);
        return;
      }
      if (!response.ok || !payload?.success || !payload.data) {
        if (isLifecycleBlocked(payload?.code)) {
          setState("blocked");
          setMessage(payload?.error || "Check this computer's status in Manage before opening Desktop.");
          return;
        }
        if (payload?.code === "desktop_upgrade_required") {
          setState("desktop-upgrade-required");
          setMessage(scrubDesktopUserMessage(payload.error || "This desktop needs an update before a new secure session can be opened. Nothing was installed or changed."));
          return;
        }
        const unavailable = payload?.code === "capability_unavailable" || payload?.code === "computer_not_ready";
        setControllerConflict(payload?.code === "controller_conflict");
        if (unavailable) repairableUnavailableRef.current = true;
        setState(unavailable ? "unavailable" : "failed");
        setMessage(scrubDesktopUserMessage(unavailable
          ? unavailableMessage
          : payload?.error || "The secure desktop session could not be opened."));
        return;
      }
      const session = payload.data;
      let parsedOrigin: URL | null = null;
      try { parsedOrigin = new URL(session.brokerOrigin); } catch { parsedOrigin = null; }
      const validHandoff = CANONICAL_UUID.test(session.id)
        && session.handoff === "message" && session.inputRole === "controller"
        && session.transport === "selkies-websocket" && parsedOrigin?.protocol === "https:"
        && parsedOrigin.origin === session.brokerOrigin
        && session.streamingMode === streamModeRef.current;
      if (!validHandoff) {
        if (CANONICAL_UUID.test(session.id)) void revokeSession(session.id);
        throw new Error("invalid_handoff");
      }
      sessionIdRef.current = session.id;
      handoffRef.current = {
        sessionId: session.id,
        exchangeCode: session.exchangeCode,
        verifier,
        streamingMode: session.streamingMode,
        sent: false,
      };
      // Warm the authorized broker handoff while the ready-listener mounts.
      // Race safety: iframe still waits for handoffListenerReady.
      warmHandoffOrigin(session.brokerOrigin);
      setExpiresAt(session.expiresAt);
      setBrokerOrigin(session.brokerOrigin);
      setMessage("Opening the low-latency desktop stream…");
    } catch (error) {
      if (attempt !== attemptRef.current) return;
      setState("failed");
      setMessage(error instanceof Error && error.message === "webcodecs_unavailable"
        ? "This browser does not expose the video decoding surface required by the desktop preview."
        : "The secure desktop session could not be opened.");
    }
  }, [computerId, handoffWarmOrigin]);

  useEffect(() => {
    const closeCurrentSession = () => {
      attemptRef.current += 1;
      conflictWaitRef.current?.finish();
      const sessionId = sessionIdRef.current;
      sessionIdRef.current = null;
      handoffRef.current = null;
      if (sessionId) void revokeSession(sessionId);
      setHandoffListenerReady(false);
    };
    const closePersistedPage = (event: PageTransitionEvent) => {
      const wasStreaming = stateRef.current === "connected";
      if (event.persisted && wasStreaming) {
        hiddenEpisodeRef.current ??= { startedAt: Date.now(), ended: false, consumed: false };
        hiddenEpisodeRef.current.ended = true;
      } else if (!event.persisted) {
        hiddenEpisodeRef.current = null;
        cancelStreamRecovery();
      }
      closeCurrentSession();
      setBrokerOrigin(null);
      setHandoffListenerReady(false);
      setExpiresAt(null);
      setState("disconnected");
      // Only this page's stream closed; nothing on the computer was stopped.
      setMessage(wasStreaming
        ? `${STREAM_DROPPED_MESSAGE} Reconnect when you are ready.`
        : "The desktop stream closed with this page. Reconnect when you are ready.");
    };
    window.addEventListener("pagehide", closePersistedPage);
    return () => {
      window.removeEventListener("pagehide", closePersistedPage);
      hiddenEpisodeRef.current = null;
      cancelStreamRecovery();
      initialConnectionStartedRef.current = false;
      closeCurrentSession();
    };
  }, [cancelStreamRecovery, connect]);

  useEffect(() => {
    // Start can remount this retained surface while Manage is visible. Do not
    // open an invisible handoff or start its timeout until Desktop is selected.
    if (!active || initialConnectionStartedRef.current) return;
    initialConnectionStartedRef.current = true;
    void connect();
  }, [active, connect]);

  useEffect(() => {
    const returnToDesktop = () => {
      if (document.hidden || !active) return;
      const episode = hiddenEpisodeRef.current;
      if (!episode || episode.consumed) return;
      episode.returned = true;
      if (episode.ended && stateRef.current === "disconnected") {
        episode.consumed = true;
        // The stream ended while nobody was looking. Its first reconnect runs
        // at once, even after a spent budget, and a failure then follows the
        // bounded backoff below.
        const recovery = recoveryRef.current;
        recovery.armed = true;
        recovery.immediate = true;
        recovery.attempts = Math.min(recovery.attempts, STREAM_RECONNECT_DELAYS_MS.length - 1);
        setRecoveryTick(tick => tick + 1);
      } else if (stateRef.current === "connected" && !episode.refreshed && Date.now() - episode.startedAt >= CAPABILITY_REFRESH_INTERVAL_MS) {
        episode.refreshed = true;
        // Still-live authority needs only a fresh proof, not another session.
        void fetch(`/api/hivra/agents/${encodeURIComponent(computerId)}/remote-desktop`, {
          method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "refresh" }),
        }).catch(() => undefined);
      }
    };
    const visibility = () => {
      if (document.hidden) {
        if (stateRef.current === "connected") hiddenEpisodeRef.current = { startedAt: Date.now(), ended: false, consumed: false };
      } else returnToDesktop();
    };
    const pageshow = (event: PageTransitionEvent) => { if (event.persisted) returnToDesktop(); };
    if (!active && stateRef.current === "connected") {
      if (!hiddenEpisodeRef.current || hiddenEpisodeRef.current.consumed || hiddenEpisodeRef.current.returned) {
        hiddenEpisodeRef.current = { startedAt: Date.now(), ended: false, consumed: false };
      }
    } else if (active) returnToDesktop();
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pageshow", pageshow);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pageshow", pageshow);
    };
  }, [active, computerId, state]);

  // Reconnect is gated on the page being seen and the device being online, so
  // re-evaluate a pending recovery whenever either changes.
  useEffect(() => {
    const nudge = () => { if (recoveryRef.current.armed) setRecoveryTick(tick => tick + 1); };
    document.addEventListener("visibilitychange", nudge);
    window.addEventListener("online", nudge);
    window.addEventListener("offline", nudge);
    window.addEventListener("pageshow", nudge);
    return () => {
      document.removeEventListener("visibilitychange", nudge);
      window.removeEventListener("online", nudge);
      window.removeEventListener("offline", nudge);
      window.removeEventListener("pageshow", nudge);
    };
  }, []);

  useEffect(() => {
    const recovery = recoveryRef.current;
    if (!recovery.armed) return;
    const offline = navigator.onLine === false;
    const pageLive = active && !document.hidden && !offline;
    if (state === "reconnecting") {
      if (!pageLive) {
        // Never open a stream for a page nobody can see, or with no network.
        // The nudges above resume the same attempt when that changes.
        setState("disconnected");
        if (offline) setMessage(`${STREAM_DROPPED_MESSAGE} Reconnecting when this device is back online.`);
        return;
      }
      const delay = recovery.immediate ? 0 : STREAM_RECONNECT_DELAYS_MS[recovery.attempts] ?? 0;
      const timer = window.setTimeout(() => {
        if (!recovery.armed) return;
        recovery.immediate = false;
        recovery.attempts += 1;
        // The same read-only foreground proof as a return from a hidden tab:
        // it never installs or repairs, and never displaces another controller.
        void connect({ allowPrepare: false });
      }, delay);
      return () => window.clearTimeout(timer);
    }
    // An attempt is in flight until it settles into one of the states below.
    if (state === "connecting" || state === "preparing" || state === "connected") return;
    const retryable = state === "disconnected" || (state === "failed" && !controllerConflict);
    if (!retryable || recovery.attempts >= STREAM_RECONNECT_DELAYS_MS.length) {
      recovery.armed = false;
      recovery.immediate = false;
      if (state === "disconnected") setMessage(`${STREAM_DROPPED_MESSAGE} Reconnect when you are ready.`);
      if (retryable) {
        clientLog.warn("remote desktop stream did not reconnect automatically", {
          source: "hivra-remote-desktop",
          failureType: "hivra_remote_desktop_reconnect_exhausted",
          computerId,
          attempts: recovery.attempts,
          finalState: state,
        });
      }
      return;
    }
    if (!pageLive) {
      if (offline && state === "disconnected") setMessage(`${STREAM_DROPPED_MESSAGE} Reconnecting when this device is back online.`);
      return;
    }
    setState("reconnecting");
    setMessage(`${STREAM_DROPPED_MESSAGE} Reconnecting…`);
  }, [active, computerId, connect, controllerConflict, recoveryTick, state]);

  useEffect(() => {
    if (!brokerOrigin) return;
    let timeout = 0;
    const liveHandoff = () => {
      const sessionId = sessionIdRef.current;
      const handoff = handoffRef.current;
      return sessionId && handoff?.sessionId === sessionId ? { sessionId, handoff } : null;
    };
    const endSession = (nextState: "unavailable" | "failed" | "disconnected", nextMessage: string) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;
      if (nextState === "disconnected" && hiddenEpisodeRef.current && !hiddenEpisodeRef.current.consumed) hiddenEpisodeRef.current.ended = true;
      window.clearTimeout(timeout);
      attemptRef.current += 1;
      sessionIdRef.current = null;
      handoffRef.current = null;
      setupStartedAtRef.current = null;
      setBrokerOrigin(null);
      setExpiresAt(null);
      setSecureSetupMs(null);
      setBrowserInputSamples([]);
      setBrowserInputTotals({ total: 0, stalls: 0 });
      lastTelemetrySequenceRef.current = 0;
      setState(nextState);
      setMessage(nextMessage);
      void revokeSession(sessionId);
    };
    timeout = window.setTimeout(() => {
      if (liveHandoff()) endSession("failed", "The computer answered, but its desktop stream did not finish opening.");
    }, 30_000);
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== brokerOrigin || event.source !== frameRef.current?.contentWindow) return;
      const type = event.data && typeof event.data === "object" ? (event.data as { type?: unknown }).type : null;
      if (type !== "hivra.remote-desktop.ready.v1"
        && (!sessionIdRef.current || event.data?.sessionId !== sessionIdRef.current)) return;
      if (type === "hivra.remote-desktop.ready.v1") {
        if (Object.keys(event.data).length !== 1) return;
        const current = liveHandoff();
        if (!current || current.handoff.sent) return;
        const target = frameRef.current?.contentWindow;
        if (!target) return;
        target.postMessage({
          type: "hivra.remote-desktop.handoff.v2",
          sessionId: current.sessionId,
          exchangeCode: current.handoff.exchangeCode,
          verifier: current.handoff.verifier,
          streamingMode: current.handoff.streamingMode,
        }, brokerOrigin);
        current.handoff.sent = true;
      } else if (type === "hivra.remote-desktop.connected.v1") {
        const current = liveHandoff();
        if (!current?.handoff.sent || Object.keys(event.data).length !== 2) return;
        handoffRef.current = null;
        window.clearTimeout(timeout);
        const startedAt = setupStartedAtRef.current;
        setupStartedAtRef.current = null;
        if (startedAt != null) setSecureSetupMs(Math.max(0, window.performance.now() - startedAt));
        const recovery = recoveryRef.current;
        recovery.armed = false;
        recovery.immediate = false;
        recovery.connectedAt = Date.now();
        setState("connected");
        setMessage("Human input is isolated from the agent while this desktop is open.");
      } else if (type === "hivra.remote-desktop.disconnected.v1") {
        const failure = event.data as { reason?: unknown };
        if (handoffRef.current?.sent === false || Object.keys(event.data).length !== 3
          || !["transport-closed", "transport-error", "stream-unavailable", "document-reloaded", "document-closed"].includes(String(failure.reason))) return;
        const reason = String(failure.reason);
        const recovery = recoveryRef.current;
        // Only a stream that was showing the desktop proves the desktop was up.
        // A stream that never opened says nothing about it, and on a first
        // open the user's Reconnect stays the next step.
        const streamDropped = stateRef.current === "connected" && STREAM_DROP_REASONS.has(reason);
        if (streamDropped) {
          if (recovery.connectedAt !== null && Date.now() - recovery.connectedAt >= STREAM_RECONNECT_STABLE_MS) {
            recovery.attempts = 0;
          }
          recovery.armed = true;
        }
        recovery.connectedAt = null;
        clientLog.info("remote desktop stream ended", {
          source: "hivra-remote-desktop",
          reason,
          wasStreaming: streamDropped,
          reconnecting: recovery.armed,
        });
        endSession("disconnected", streamDropped || recovery.armed
          ? STREAM_DROPPED_MESSAGE
          : "The desktop stream stopped before it finished opening. Reconnect when you are ready.");
      } else if (type === "hivra.remote-desktop.failed.v1") {
        const failure = event.data as { type?: unknown; reason?: unknown };
        const keys = Object.keys(failure);
        if (
          !liveHandoff()?.handoff.sent
          || keys.length !== 3
          || !keys.includes("type")
          || !keys.includes("reason")
          || !keys.includes("sessionId")
          || (failure.reason !== "control-unreachable" && failure.reason !== "handoff-rejected")
        ) return;
        if (failure.reason === "control-unreachable") {
          endSession(
            "unavailable",
            "The desktop broker could not reach this Hivra control plane. Its agent, chat, terminal, and files are unchanged.",
          );
        } else {
          endSession("failed", "The secure desktop handoff was rejected.");
        }
      } else if (type === "hivra.remote-desktop.telemetry.v1") {
        const telemetry = event.data as {
          metric?: unknown;
          outcome?: unknown;
          sequence?: unknown;
          durationMs?: unknown;
          decodedFrames?: unknown;
        };
        if (
          telemetry.metric !== "browser-input-to-changed-frame"
          || (telemetry.outcome !== "changed" && telemetry.outcome !== "timeout")
          || typeof telemetry.sequence !== "number"
          || !Number.isSafeInteger(telemetry.sequence)
          || telemetry.sequence <= lastTelemetrySequenceRef.current
          || typeof telemetry.durationMs !== "number"
          || !Number.isFinite(telemetry.durationMs)
          || telemetry.durationMs < 0
          || telemetry.durationMs > 2_000
          || typeof telemetry.decodedFrames !== "number"
          || !Number.isSafeInteger(telemetry.decodedFrames)
          || telemetry.decodedFrames < 0
          || telemetry.decodedFrames > 180
          || (telemetry.outcome === "changed" && telemetry.decodedFrames < 1)
          || (telemetry.outcome === "timeout" && telemetry.durationMs !== 2_000)
        ) return;
        const sequence = telemetry.sequence;
        const durationMs = telemetry.durationMs;
        const outcome = telemetry.outcome;
        lastTelemetrySequenceRef.current = sequence;
        setBrowserInputSamples(current => [
          ...current.slice(-(MAX_BROWSER_TIMING_SAMPLES - 1)),
          { durationMs, outcome },
        ]);
        setBrowserInputTotals(current => ({
          total: current.total + 1,
          stalls: current.stalls + (outcome === "timeout" ? 1 : 0),
        }));
      }
    };
    // The broker emits its ready message as soon as the handoff document
    // starts. Mount the iframe only after this listener exists so a fast or
    // cached document cannot race the parent and fall into a false timeout.
    window.addEventListener("message", onMessage);
    setHandoffListenerReady(true);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
    };
  }, [brokerOrigin]);

  useEffect(() => {
    if (state !== "connected" || !brokerOrigin) return;
    let timeout: number | null = null;
    let dprQuery: MediaQueryList | null = null;
    const frame = frameRef.current;
    const sendViewportUpdate = () => {
      timeout = null;
      frameRef.current?.contentWindow?.postMessage(
        { type: "hivra.remote-desktop.viewport.v1" },
        brokerOrigin,
      );
    };
    const scheduleViewportUpdate = () => {
      if (timeout !== null) window.clearTimeout(timeout);
      timeout = window.setTimeout(sendViewportUpdate, VIEWPORT_UPDATE_DEBOUNCE_MS);
    };
    const watchDevicePixelRatio = () => {
      dprQuery?.removeEventListener("change", watchDevicePixelRatio);
      if (typeof window.matchMedia !== "function") {
        dprQuery = null;
        return;
      }
      dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      dprQuery.addEventListener("change", watchDevicePixelRatio, { once: true });
      scheduleViewportUpdate();
    };
    const visualViewport = window.visualViewport;
    const resizeObserver = frame && typeof ResizeObserver === "function"
      ? new ResizeObserver(scheduleViewportUpdate)
      : null;

    window.addEventListener("resize", scheduleViewportUpdate);
    visualViewport?.addEventListener("resize", scheduleViewportUpdate);
    document.addEventListener("fullscreenchange", scheduleViewportUpdate);
    if (frame) resizeObserver?.observe(frame);
    watchDevicePixelRatio();
    scheduleViewportUpdate();
    return () => {
      window.removeEventListener("resize", scheduleViewportUpdate);
      visualViewport?.removeEventListener("resize", scheduleViewportUpdate);
      document.removeEventListener("fullscreenchange", scheduleViewportUpdate);
      dprQuery?.removeEventListener("change", watchDevicePixelRatio);
      resizeObserver?.disconnect();
      if (timeout !== null) window.clearTimeout(timeout);
    };
  }, [brokerOrigin, state]);

  useEffect(() => {
    if (state !== "connected") return;
    let stopped = false;
    const refreshCapability = async () => {
      try {
        const response = await fetch(`/api/hivra/agents/${encodeURIComponent(computerId)}/remote-desktop`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "refresh" }),
        });
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        if (!stopped && !response.ok) {
          setMessage(scrubDesktopUserMessage(payload?.error || "Desktop is connected, but its runtime proof could not be refreshed."));
        }
      } catch {
        if (!stopped) setMessage("Desktop is connected, but its runtime proof could not be refreshed.");
      }
    };
    const interval = window.setInterval(() => { void refreshCapability(); }, CAPABILITY_REFRESH_INTERVAL_MS);
    return () => {
      stopped = true;
      window.clearInterval(interval);
    };
  }, [computerId, state]);

  const chooseStreamMode = (mode: StreamMode) => {
    streamModeRef.current = mode;
    setStreamMode(mode);
    writeStreamModePreference(computerId, mode);
  };

  useEffect(() => {
    if (state !== "connected" || !brokerOrigin) return;
    frameRef.current?.contentWindow?.postMessage(
      { type: "hivra.remote-desktop.streaming-mode.v1", mode: streamMode },
      brokerOrigin,
    );
  }, [brokerOrigin, state, streamMode]);

  const prepareDesktop = useCallback(async () => {
    hiddenEpisodeRef.current = null;
    cancelStreamRecovery();
    const attempt = ++attemptRef.current;
    conflictWaitRef.current?.finish();
    const previous = sessionIdRef.current;
    sessionIdRef.current = null;
    handoffRef.current = null;
    setBrokerOrigin(null);
    setExpiresAt(null);
    setState("preparing");
    setMessage("Repairing desktop runtime…");
    if (previous) void revokeSession(previous);

    try {
      let payload: {
        success?: boolean;
        code?: string;
        error?: string;
        data?: { prepared?: boolean };
      } | null = null;
      let preparedOk = false;
      for (let wait = 0; wait <= RATE_LIMIT_PREPARE_MAX_WAITS; wait += 1) {
        const response = await fetch(`/api/hivra/agents/${encodeURIComponent(computerId)}/remote-desktop`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "prepare" }),
        });
        payload = await response.json().catch(() => null) as {
          success?: boolean;
          code?: string;
          error?: string;
          data?: { prepared?: boolean };
        } | null;
        if (attempt !== attemptRef.current) return;
        if (response.ok && payload?.success && payload.data?.prepared === true) {
          preparedOk = true;
          break;
        }
        if (payload?.code !== "rate_limited" || wait === RATE_LIMIT_PREPARE_MAX_WAITS) {
          break;
        }
        // Stay on Opening/Repairing progress — never sticky prepare-failed on rate_limit.
        setState("preparing");
        setMessage("Wait before opening this desktop again. Retrying…");
        const backoffMs = Math.min(
          RATE_LIMIT_PREPARE_BACKOFF_MS * (2 ** wait),
          RATE_LIMIT_PREPARE_BACKOFF_CAP_MS,
        );
        await new Promise<void>((resolve) => {
          let timeout = 0;
          const finish = () => {
            window.clearTimeout(timeout);
            if (conflictWaitRef.current?.timeout === timeout) conflictWaitRef.current = null;
            resolve();
          };
          timeout = window.setTimeout(finish, backoffMs);
          conflictWaitRef.current = { timeout, finish };
        });
        if (attempt !== attemptRef.current) return;
        const bridgeRefresh = await fetch(`/api/hivra/agents/${encodeURIComponent(computerId)}/remote-desktop`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "refresh" }),
        });
        const bridgePayload = await bridgeRefresh.json().catch(() => null) as {
          success?: boolean;
          data?: { prepared?: boolean };
        } | null;
        if (attempt !== attemptRef.current) return;
        if (bridgeRefresh.ok && bridgePayload?.success && bridgePayload.data?.prepared === true) {
          preparedOk = true;
          payload = { success: true, data: { prepared: true } };
          break;
        }
        setMessage("Repairing desktop runtime…");
      }
      if (!preparedOk) {
        if (isLifecycleBlocked(payload?.code)) {
          setState("blocked");
        } else if (payload?.code === "legacy_identity_unbound" || payload?.code === "unsupported_computer") {
          setState("upgrade-required");
        } else {
          setState(payload?.code === "canary_desktop_prepare_paused" ? "prepare-paused"
            : payload?.code === "desktop_prepare_pending" ? "prepare-pending" : "prepare-failed");
        }
        setMessage(scrubDesktopUserMessage(
          payload?.error || "Desktop couldn’t open. Retry to repair the runtime and try again.",
        ));
        return;
      }
      refreshAttemptedRef.current = false;
      await connect();
    } catch {
      if (attempt !== attemptRef.current) return;
      setState("prepare-failed");
      setMessage("Desktop couldn’t open. Retry to repair the runtime and try again.");
    }
  }, [cancelStreamRecovery, computerId, connect]);

  /** Every connect the user asks for supersedes an automatic one. */
  const connectByUser = (options?: { allowPrepare?: boolean; ownerHandoff?: boolean }) => {
    cancelStreamRecovery();
    void connect(options);
  };

  const retryDesktop = useCallback(() => {
    refreshAttemptedRef.current = false;
    autoPrepareAttemptedRef.current = false;
    repairableUnavailableRef.current = false;
    void prepareDesktop();
  }, [prepareDesktop]);

  useEffect(() => {
    autoPrepareAttemptedRef.current = false;
    repairableUnavailableRef.current = false;
  }, [computerId]);

  useEffect(() => {
    if (!active || !allowAutomaticPrepareRef.current || state !== "unavailable" || autoPrepareAttemptedRef.current) return;
    // Default: missing-capability unavailable auto-repairs when the Desktop tab is active.
    // autoPrepare still covers other unavailable paths (e.g. control-unreachable).
    if (!autoPrepare && !repairableUnavailableRef.current) return;
    autoPrepareAttemptedRef.current = true;
    void prepareDesktop();
  }, [active, autoPrepare, prepareDesktop, state]);

  const enterFullscreen = async () => {
    const frame = frameRef.current;
    const surface = fullscreenRef.current;
    if (immersive) {
      setImmersive(false);
      return;
    }
    if (document.fullscreenElement === surface && surface) {
      try {
        await document.exitFullscreen();
      } catch {
        setMessage("Fullscreen could not close. Try the browser’s exit fullscreen control.");
      }
      return;
    }
    if (!frame || state !== "connected") return;
    if (!document.fullscreenEnabled || !surface || typeof surface.requestFullscreen !== "function") {
      // The same iframe and decoder stay mounted; only the layout changes.
      setImmersive(true);
      frame.focus();
      return;
    }
    try {
      // Keep the already-authenticated iframe and its live decoder/input lane.
      // Opening the broker as a new top-level window would lose the partitioned
      // handoff cookie and needlessly reconnect the media stream.
      // Include the header so an exit control remains reachable when the guest
      // consumes Escape. The same iframe/decoder remains mounted throughout.
      await surface.requestFullscreen();
      frame.focus();
    } catch {
      setMessage("Fullscreen could not open. The secure desktop remains connected here.");
    }
  };

  const browserP50 = percentileSample(browserInputSamples, 0.5);
  const browserP95 = percentileSample(browserInputSamples, 0.95);
  const browserEvidenceSuffix = browserInputTotals.total > browserInputSamples.length
    ? `window=${browserInputSamples.length} · total=${browserInputTotals.total} · stalls=${browserInputTotals.stalls}`
    : `n=${browserInputTotals.total} · stalls=${browserInputTotals.stalls}`;
  const browserTimingLabel = browserInputSamples.length === 0
    ? `Waiting for input… · ${browserEvidenceSuffix}`
    : browserInputSamples.length < 5
      ? `${formatTimingSample(browserInputSamples.at(-1)!)} · ${browserEvidenceSuffix}`
      : `p50 ${formatTimingSample(browserP50!)} · p95 ${formatTimingSample(browserP95!)} · ${browserEvidenceSuffix}`;

  const expanded = isFullscreen || immersive;
  if (state !== "connected" && menuOpen) setMenuOpen(false);

  return (
    <section
      ref={fullscreenRef}
      aria-label={`${name} remote desktop`}
      aria-hidden={!active}
      data-immersive={immersive ? "true" : undefined}
      className={immersive ? styles.immersive : undefined}
      style={{ height: immersive ? "var(--workspace-viewport-height, 100dvh)" : "100%", minHeight: 0, display: active ? "flex" : "none", flexDirection: "column", background: "#090909" }}
    >
      {/* ONE strip. This used to be two and a half: a 48px header, a 45px
          evidence grid, and the surface bar above them. Everything that is not
          an everyday action now lives behind the gear — quality, fit, full
          screen, runtime maintenance, and the session evidence — because the
          desktop itself is the product here, not the toolbar. */}
      <header className={styles.strip} data-state={state}>
        <span className={styles.stripStatus} aria-hidden="true">
          {state === "connected" ? (
            <ShieldCheck size={13} color="var(--success, #33c978)" />
          ) : state === "connecting" || state === "preparing" || state === "reconnecting" ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Monitor size={13} />
          )}
        </span>
        {/* One short word on screen, and the explanation as a real element
            beside it. The message is not decoration: when a desktop fails to
            open, that sentence is the whole diagnosis, so it must stay both
            readable and findable. It is clamped to one line rather than
            dropped, which keeps the strip short without withholding the
            reason. */}
        <span className={styles.stripLabel}>{STATE_LABELS[state]}</span>
        <span className={styles.stripMessage} role="status" title={message}>
          {message}
        </span>
        <span className={styles.stripSpacer} />
        {state === "connected" ? (
          <label className={styles.stripField}>
            <span className={styles.stripFieldLabel}>Quality</span>
            <select
              aria-label="Desktop quality"
              value={streamMode}
              onChange={(event) => chooseStreamMode(event.target.value as StreamMode)}
              className={`mono ${styles.stripSelect}`}
            >
              {DESKTOP_STREAMING_MODES.map((mode) => (
                <option key={mode} value={mode} title={DESKTOP_STREAMING_MODE_DETAILS[mode].status}>
                  {DESKTOP_STREAMING_MODE_DETAILS[mode].label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {/* The recovery action is the only thing allowed to sit outside the
            menu: when the desktop fails, the fix must be one click. */}
        {state === "desktop-upgrade-required" ? (
          <button type="button" onClick={() => void prepareDesktop()} className={styles.stripAction}>
            Update desktop <RefreshCw size={11} />
          </button>
        ) : state === "unavailable" && !allowAutomaticPrepareRef.current ? (
          // An automatic reconnect whose runtime proof failed must not leave
          // the user without the Reconnect they had before it ran.
          <button type="button" onClick={() => connectByUser()} className={styles.stripAction}>
            Reconnect <RefreshCw size={11} />
          </button>
        ) : state === "unavailable" && autoPrepareAttemptedRef.current ? (
          <button type="button" onClick={() => void retryDesktop()} className={styles.stripAction}>
            Retry <RefreshCw size={11} />
          </button>
        ) : state === "prepare-failed" || state === "prepare-pending" ? (
          <button type="button" onClick={() => void retryDesktop()} className={styles.stripAction}>
            Retry <RefreshCw size={11} />
          </button>
        ) : state === "failed" && controllerConflict ? (
          <button type="button" onClick={() => connectByUser({ allowPrepare: false, ownerHandoff: true })} className={styles.stripAction}>
            Take over here <RefreshCw size={11} />
          </button>
        ) : state === "failed" || state === "disconnected" || state === "reconnecting" ? (
          <button type="button" onClick={() => connectByUser()} className={styles.stripAction}>
            {state === "failed" ? "Try again" : "Reconnect"} <RefreshCw size={11} />
          </button>
        ) : null}
        {state === "connected" || expanded ? (
          <button
            type="button"
            onClick={() => void enterFullscreen()}
            aria-label={expanded ? "Exit full screen" : "Full screen"}
            title={expanded ? "Exit full screen" : "Full screen"}
            className={styles.stripIcon}
          >
            {immersive ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
        ) : null}
        {state === "connected" ? (
          <details ref={menuRef} open={menuOpen} onToggle={(event) => setMenuOpen(event.currentTarget.open)} className={styles.stripDetails}>
            <summary aria-label="Desktop settings" title="Desktop settings" className={styles.stripIcon}>
              <Settings2 size={13} />
            </summary>
            <div ref={menuPanelRef} role="region" aria-label="Desktop options" className={styles.stripMenu}>
              <label className={styles.stripToggle}>
                <input
                  type="checkbox"
                  checked={fitDesktop}
                  onChange={(event) => setFitDesktop(event.target.checked)}
                />
                <span>
                  Fit desktop to window
                  <small>Off shows it at exact size — larger text, scrolls.</small>
                </span>
              </label>
              <button type="button" onClick={() => void prepareDesktop()} className={styles.stripMenuAction}>
                <RefreshCw size={12} /> Update runtime
              </button>
              <p className={styles.stripMenuNote}>
                Optional maintenance. Updating the runtime interrupts this stream.
              </p>
              <div className={styles.stripEvidence} aria-label="Session performance evidence">
                <p><span>Transport</span><strong>WebSocket + WebCodecs</strong></p>
                <p><span>Setup</span><strong>{secureSetupMs == null ? "Measuring…" : formatDuration(secureSetupMs)}</strong></p>
                <p><span>Profile</span><strong>{DESKTOP_STREAMING_MODE_DETAILS[streamMode].label} · {DESKTOP_STREAMING_MODE_DETAILS[streamMode].bitrateKbps / 1000} Mbps · 60 fps</strong></p>
                {/* The old "Secure preview" badge rendered a label with no value
                    — it never showed the time it was supposedly about. The
                    session's real expiry belongs here, where it is a fact. */}
                {expiresAt ? (
                  <p title={expiresAt}>
                    <span>Session expires</span>
                    <strong>{formatExpiry(expiresAt)}</strong>
                  </p>
                ) : null}
                <p title="Browser telemetry records every started trusted input measurement: the first decoded changed video frame or a visible 2-second timeout. Percentiles use the latest 200 samples; total and stall counts cover the full current session. It is not physical input-to-photon proof; that still requires the optical campaign.">
                  <span>Input→frame</span>
                  <strong>{browserTimingLabel}</strong>
                </p>
              </div>
            </div>
          </details>
        ) : null}
      </header>
      {brokerOrigin && handoffListenerReady ? (
        <HivraDesktopViewport
          fit={fitDesktop}
          targetWidth={DESKTOP_STREAMING_MODE_DETAILS[streamMode].width}
          targetHeight={DESKTOP_STREAMING_MODE_DETAILS[streamMode].height}
        >
          <iframe
            ref={frameRef}
            title={`${name} remote desktop`}
            src={`${brokerOrigin}/desktop/handoff`}
            sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-downloads"
            allow={`clipboard-read ${brokerOrigin}; clipboard-write ${brokerOrigin}; fullscreen ${brokerOrigin}`}
            referrerPolicy="no-referrer"
            style={{ display: "block", height: "100%", width: "100%", border: 0, background: "#090909" }}
          />
        </HivraDesktopViewport>
      ) : state === "connecting" || state === "preparing" ? (
        <LoadingState dark label="Opening your computer…" detail={message} />
      ) : (
        <div role="status" style={{ flex: 1, display: "grid", placeItems: "center", padding: 24, textAlign: "center", color: "var(--text-muted)" }}>
          <div style={{ maxWidth: 520 }}>
            <Monitor size={24} style={{ margin: "0 auto 14px" }} />
            <h2 className="serif" style={{ color: "var(--ink-black)", fontWeight: 400, fontSize: 24, marginBottom: 8 }}>
              {state === "disconnected" || state === "reconnecting" ? "Stream disconnected"
                  : state === "prepare-paused" ? "Desktop couldn’t open right now"
                    : state === "prepare-pending" ? "Desktop is still opening"
                    : state === "prepare-failed" ? "Desktop couldn’t open"
                    : state === "desktop-upgrade-required" ? "This desktop needs an update"
                  : state === "upgrade-required"
                    ? "This computer needs a current launch"
                    : "Remote desktop isn’t ready on this computer"}
            </h2>
            <p style={{ fontSize: 13, lineHeight: 1.65, margin: 0 }}>
              {/* The heading already says the stream disconnected. */}
              {state === "disconnected" || state === "reconnecting" ? message.replace(/^Stream disconnected\. /, "") : message}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
