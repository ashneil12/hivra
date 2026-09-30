"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { LoadingState } from "@/components/ui/LoadingState";
import { Loader2, Maximize2, Minimize2, Monitor, RefreshCw, Settings2, ShieldCheck } from "lucide-react";

import styles from "./HivraRemoteDesktop.module.css";
import { useWorkspaceModalLayer } from "@/components/workspace/WorkspaceModalLayerContext";
import { clientLog } from "@/lib/client/logger";

import { HivraDesktopViewport } from "./HivraDesktopViewport";
import {
  desktopIssueAnswered,
  desktopIssueSent,
  desktopProofSuccesses,
  refreshDesktopCapability,
  runDesktopIssue,
  unansweredDesktopIssues,
} from "@/lib/remote-computers/desktop-session-lane";
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
// A re-sent revoke normally answers in well under a second. On a link that
// hangs it, the open goes ahead after this and the conflict wait covers it.
const UNRELEASED_REVOKE_WAIT_MS = 5_000;
// The handoff document says it is ready as its only script runs, before its
// load event. While it is still loading it is waited for this long, so a slow
// first connect is not ended on a timing boundary: a Canary first connect
// exchanged about 30 s after its document was mounted, and which step was slow
// is not known yet. Its session lasts four minutes, well past this plus the
// exchange below.
const HANDOFF_DOCUMENT_TIMEOUT_MS = 90_000;
// A document that finished loading without saying it is ready (an error page
// from a gateway, a document built for another control origin) will not say
// it later; this only covers message delivery racing the load event.
const HANDOFF_READY_AFTER_LOAD_MS = 5_000;
// Past this, a still-loading document is reported as slow while it is waited for.
const HANDOFF_SLOW_NOTICE_MS = 20_000;
// Once it has the handoff, the document reports its own outcome: its exchange
// takes at most about 18 s (three tries with 5 s control-plane timeouts and
// 1 s and 2 s pauses) before it reports failure; it then loads the stream
// page through the computer's broker, which drops an upstream that stays
// idle for 30 s, and reports stream-unavailable 30 s after that page's load
// event. That is about 80 s in the slowest case it still reports. A stream
// page that keeps loading longer gives no signal, so this backstop ends it.
const STREAM_OPEN_AFTER_HANDOFF_TIMEOUT_MS = 120_000;
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
/**
 * Runtime-proof failures that a restarting desktop gateway produces for a few
 * seconds (its broker and chat units restart on their own), as opposed to a
 * blocked computer, a required update or a rate limit. Server errors count too.
 */
const TRANSIENT_PROOF_FAILURE_CODES: ReadonlySet<string> = new Set([
  "capability_refresh_failed",
  "provider_desktop_unverified",
]);

type StreamRecovery = {
  armed: boolean;
  immediate: boolean;
  attempts: number;
  /** When the pending attempt is due, so a re-render or nudge keeps its place. */
  dueAt: number | null;
  connectedAt: number | null;
  dropReason: string | null;
};

/** A stream that stayed up for a minute earns a fresh reconnect budget. */
function settleRecoveryBudget(recovery: StreamRecovery): void {
  if (recovery.connectedAt !== null && Date.now() - recovery.connectedAt >= STREAM_RECONNECT_STABLE_MS) {
    recovery.attempts = 0;
  }
  recovery.connectedAt = null;
}

/**
 * Update and repair re-run desktop preparation ({ action: "prepare" }). When
 * that reinstalls the desktop, the installer restarts the desktop container
 * (closing its apps) and the agent's chat service, which interrupts a reply in
 * flight on computers whose chat runs are not yet detached. ~/Hivra is a
 * mounted folder and is kept. A healthy desktop may only be re-proved, hence
 * "can".
 */
type InstallKind = "update-runtime" | "update-desktop" | "repair";
const INSTALL_CONFIRMATIONS: Record<InstallKind, { label: string; action: string; note: string }> = {
  "update-runtime": {
    label: "Confirm update",
    action: "Update",
    note: "Updating ends this stream and can restart the desktop and the agent’s chat service. That closes the desktop’s open apps and can interrupt a chat reply the agent is writing. Files in ~/Hivra are kept.",
  },
  "update-desktop": {
    label: "Confirm update",
    action: "Update",
    note: "Updating can restart the desktop and the agent’s chat service. That closes the desktop’s open apps and can interrupt a chat reply the agent is writing. Files in ~/Hivra are kept.",
  },
  repair: {
    label: "Confirm repair",
    action: "Repair",
    note: "Repairing can reinstall the desktop and restart the agent’s chat service. That closes the desktop’s open apps and can interrupt a chat reply the agent is writing. Files in ~/Hivra are kept.",
  },
};
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

/**
 * Revoke one owner session. True once the server has answered for it; false
 * when the request never arrived or hit a rate limit or server error, so that
 * sending it again can still help.
 */
async function revokeSession(sessionId: string): Promise<boolean> {
  try {
    const response = await fetch(`/api/remote-desktop/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      credentials: "same-origin",
      keepalive: true,
    });
    return response.status < 500 && response.status !== 429;
  } catch {
    // The guest broker also terminates and releases input when its media lane
    // closes. Owner revocation is an eager second fence, not the only cleanup.
    return false;
  }
}

/**
 * Revoke a session this page ended, remembering it in `unreleased` until the
 * server has answered. A stream that drops while the device is offline cannot
 * send its revoke, and the guest broker keeps renewing that controller lease
 * until it notices the dead socket, so the next open would wait on this page's
 * own old stream and end on "Take over here". Every issue sends these again
 * first; the server then treats the old lease as releasing and the open waits
 * for it instead.
 */
async function releaseSession(sessionId: string, unreleased: Set<string>): Promise<void> {
  if (await revokeSession(sessionId)) unreleased.delete(sessionId);
  else unreleased.add(sessionId);
}

/** Wait for `work`, but never longer than `milliseconds`. */
async function atMost(work: Promise<unknown>, milliseconds: number): Promise<void> {
  let wait = 0;
  await Promise.race([work, new Promise<void>(resolve => { wait = window.setTimeout(resolve, milliseconds); })]);
  window.clearTimeout(wait);
}

/** An open this page replaced while its session request waited or ran. */
class ReplacedOpen extends Error {
  constructor() { super("replaced_open"); }
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
  // Every click that can run the installer asks first: it can restart the
  // desktop, closing its apps, and the agent's chat service.
  const [confirmInstall, setConfirmInstall] = useState<InstallKind | null>(null);
  if (!menuOpen && confirmInstall === "update-runtime") setConfirmInstall(null);
  const confirmCancelRef = useRef<HTMLButtonElement>(null);
  const updateRuntimeRef = useRef<HTMLButtonElement>(null);
  const updateDesktopRef = useRef<HTMLButtonElement>(null);
  const repairDesktopRef = useRef<HTMLButtonElement>(null);
  const cancelledInstallRef = useRef<InstallKind | null>(null);
  // Keyboard focus follows the question: onto Cancel when it opens, and back
  // to the control that asked when it is cancelled.
  useEffect(() => {
    if (confirmInstall) {
      confirmCancelRef.current?.focus();
      return;
    }
    const cancelled = cancelledInstallRef.current;
    cancelledInstallRef.current = null;
    const trigger = cancelled === "update-runtime" ? updateRuntimeRef
      : cancelled === "update-desktop" ? updateDesktopRef
        : cancelled === "repair" ? repairDesktopRef : null;
    trigger?.current?.focus();
  }, [confirmInstall]);
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
  const autoPrepareAttemptedRef = useRef(false);
  const repairableUnavailableRef = useRef(false);
  const lastTelemetrySequenceRef = useRef(0);
  const conflictWaitRef = useRef<{ timeout: number; finish: () => void } | null>(null);
  const handoffDocumentLoadedRef = useRef<(() => void) | null>(null);
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
  const recoveryRef = useRef<StreamRecovery>({
    armed: false, immediate: false, attempts: 0, dueAt: null, connectedAt: null, dropReason: null,
  });
  const [recoveryTick, setRecoveryTick] = useState(0);
  // Whether the last runtime-proof failure may pass on a retry seconds later,
  // and the last failure's code, for the automatic reconnect's decisions and logs.
  const transientProofFailureRef = useRef(false);
  const lastFailureRef = useRef<{ code: string | null; status: number | null }>({ code: null, status: null });
  const unreleasedSessionsRef = useRef<Set<string>>(new Set());
  // Once this page has shown the desktop, it has told the user the desktop and
  // its apps keep running when the stream drops.
  const desktopShownRef = useRef(false);
  /** The user's own action (or a repair) replaces any pending automatic reconnect. */
  const cancelStreamRecovery = useCallback(() => {
    const recovery = recoveryRef.current;
    recovery.armed = false;
    recovery.immediate = false;
    recovery.attempts = 0;
    recovery.dueAt = null;
  }, []);

  /**
   * `allowPrepare: false` never installs or repairs anything. Such an open
   * also proves the runtime before asking for authority unless `proveFirst`
   * is false: the automatic reconnect proves first, the user's Reconnect after
   * a drop goes straight to the session like any other click.
   */
  const connect = useCallback(async (options: { allowPrepare?: boolean; proveFirst?: boolean; ownerHandoff?: boolean } = {}) => {
    allowAutomaticPrepareRef.current = options.allowPrepare !== false;
    if (options.allowPrepare !== false) hiddenEpisodeRef.current = null;
    const attempt = ++attemptRef.current;
    transientProofFailureRef.current = false;
    lastFailureRef.current = { code: null, status: null };
    const fail = (code: string | null | undefined, status?: number) => {
      lastFailureRef.current = { code: code ?? null, status: status ?? null };
    };
    const unreleased = unreleasedSessionsRef.current;
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
    if (previous) void releaseSession(previous, unreleased);
    // Speculative warm of a known chat/broker origin in parallel with issue.
    // The iframe still mounts only after the message listener is ready.
    warmHandoffOrigin(handoffWarmOrigin);

    try {
      if (!("VideoDecoder" in window)) throw new Error("webcodecs_unavailable");
      if (options.allowPrepare === false && options.proveFirst !== false) {
        // A foreground recovery proves current owner/runtime readiness BEFORE
        // requesting any new authority. It never installs or resumes a repair.
        // A proof already running in this tab is joined, never run twice.
        const { ok, status, payload: proof } = await refreshDesktopCapability(computerId);
        if (attempt !== attemptRef.current) return;
        if (!ok || !proof?.success || proof.data?.prepared !== true) {
          const blocked = isLifecycleBlocked(proof?.code);
          fail(proof?.code, status);
          transientProofFailureRef.current = !blocked
            && (status >= 500 || TRANSIENT_PROOF_FAILURE_CODES.has(proof?.code ?? ""));
          setState(blocked ? "blocked" : "unavailable");
          setMessage(scrubDesktopUserMessage(proof?.error || "The desktop's current runtime proof could not be verified."));
          return;
        }
      }
      // Replacing an active controller requires an explicit action here. Normal
      // opening, retries and foreground recovery must never revoke another tab.
      let ownerHandoff = options.ownerHandoff === true;
      // One session request per computer at a time in this tab (see
      // runDesktopIssue). An open this page replaced asks for nothing once its
      // turn comes, and gives back a session it was granted before the next
      // ask, which would otherwise meet it as another controller.
      const issue = () => runDesktopIssue(computerId, async () => {
        if (attempt !== attemptRef.current) throw new ReplacedOpen();
        // Leases this page ended but could not revoke go first (see releaseSession).
        if (unreleased.size) {
          await atMost(Promise.all([...unreleased].map(id => releaseSession(id, unreleased))), UNRELEASED_REVOKE_WAIT_MS);
        }
        const requestOwnerHandoff = ownerHandoff;
        ownerHandoff = false;
        const { verifier, challenge } = await newPkce();
        if (attempt !== attemptRef.current) throw new ReplacedOpen();
        // A proof that succeeds after this point may have landed after the
        // server read this computer's capability for the request below.
        const proofSuccesses = desktopProofSuccesses(computerId);
        // Earlier requests whose answers never arrived may each have left a
        // lease only their lost answer could use (see desktop-session-lane).
        const unansweredPkceChallenges = unansweredDesktopIssues(computerId, challenge);
        desktopIssueSent(computerId, challenge);
        const response = await fetch("/api/remote-desktop/sessions", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            computerKind: "hivra-agent",
            ownerHandoff: requestOwnerHandoff,
            ...(unansweredPkceChallenges.length ? { unansweredPkceChallenges } : {}),
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
        // Only an answer the server gave after deciding says what this request
        // left behind: a grant names its lease and a refusal made none. A
        // server error or an unreadable body may follow a lease that was made
        // (and capability_changed is a lease the server made but withheld).
        if (payload && typeof payload.success === "boolean" && response.status < 500
          && payload.code !== "capability_changed") {
          desktopIssueAnswered(computerId, challenge);
        }
        const grantedId = payload?.data?.id;
        if (attempt !== attemptRef.current) {
          if (grantedId) await atMost(releaseSession(grantedId, unreleased), UNRELEASED_REVOKE_WAIT_MS);
          throw new ReplacedOpen();
        }
        return { response, payload, verifier, proofSuccesses };
      });

      let issued = await issue();
      if (attempt !== attemptRef.current) {
        if (issued.payload?.data?.id) void releaseSession(issued.payload.data.id, unreleased);
        return;
      }
      if (isLifecycleBlocked(issued.payload?.code)) {
        fail(issued.payload?.code, issued.response.status);
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
          if (issued.payload?.data?.id) await releaseSession(issued.payload.data.id, unreleased);
          return;
        }
        conflictDelay = CONTROLLER_CONFLICT_RETRY_INTERVAL_MS;
      }
      let unavailableMessage = "This computer has not proved a current remote-desktop runtime yet. Its agent, chat, terminal, and files are unchanged.";
      // Once per open: the proof ran out (it lasts eight minutes). The page's
      // own prefetch is usually proving it already; join that proof, or use
      // one that landed while the request above was on its way, rather than
      // running the guest inspection a second time.
      if (issued.response.status === 409 && issued.payload?.code === "capability_unavailable") {
        setMessage("Rechecking this computer’s installed desktop runtime…");
        const refresh = await refreshDesktopCapability(computerId, { reuseSuccessAfter: issued.proofSuccesses });
        const refreshPayload = refresh.payload;
        if (attempt !== attemptRef.current) return;
        const refreshed = refresh.ok && refreshPayload?.success && refreshPayload.data?.prepared === true;
        if (!refreshed) fail(refreshPayload?.code, refresh.status);
        if (refreshed) {
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
              const bridgeRefresh = await refreshDesktopCapability(computerId);
              const bridgePayload = bridgeRefresh.payload;
              if (attempt !== attemptRef.current) return;
              if (bridgeRefresh.ok && bridgePayload?.success && bridgePayload.data?.prepared === true) {
                prepareOk = true;
                preparePayload = { success: true, data: { prepared: true } };
                break;
              }
              setMessage("Repairing desktop runtime…");
            }
            if (!prepareOk) {
              fail(preparePayload?.code);
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
            fail("prepare_request_failed");
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
        if (payload?.data?.id) void releaseSession(payload.data.id, unreleased);
        return;
      }
      if (!response.ok || !payload?.success || !payload.data) {
        fail(payload?.code, response.status);
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
        if (CANONICAL_UUID.test(session.id)) void releaseSession(session.id, unreleased);
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
      fail(error instanceof Error
        && ["webcodecs_unavailable", "secure_browser_required", "invalid_handoff"].includes(error.message)
        ? error.message : "request_failed");
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
      if (sessionId) void releaseSession(sessionId, unreleasedSessionsRef.current);
      setHandoffListenerReady(false);
    };
    const closePersistedPage = (event: PageTransitionEvent) => {
      const wasStreaming = stateRef.current === "connected";
      const recovery = recoveryRef.current;
      if (event.persisted && wasStreaming) {
        hiddenEpisodeRef.current ??= { startedAt: Date.now(), ended: false, consumed: false };
        hiddenEpisodeRef.current.ended = true;
        // The return from the back-forward cache reconnects this stream, with
        // the budget a drop here would have had.
        settleRecoveryBudget(recovery);
        recovery.dropReason = "page-hidden";
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
        recovery.dueAt = null;
        recovery.attempts = Math.min(recovery.attempts, STREAM_RECONNECT_DELAYS_MS.length - 1);
        setRecoveryTick(tick => tick + 1);
      } else if (stateRef.current === "connected" && !episode.refreshed && Date.now() - episode.startedAt >= CAPABILITY_REFRESH_INTERVAL_MS) {
        episode.refreshed = true;
        // Still-live authority needs only a fresh proof, not another session.
        void refreshDesktopCapability(computerId).catch(() => undefined);
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
      // The attempt keeps the time it was first due. A nudge or re-render
      // (an `online` event mid-wait, say) must not restart its backoff, and a
      // wait that ran out while the page was hidden or offline is over.
      recovery.dueAt ??= Date.now() + (recovery.immediate ? 0 : STREAM_RECONNECT_DELAYS_MS[recovery.attempts] ?? 0);
      const timer = window.setTimeout(() => {
        if (!recovery.armed) return;
        recovery.immediate = false;
        recovery.dueAt = null;
        recovery.attempts += 1;
        // The same read-only foreground proof as a return from a hidden tab:
        // it never installs or repairs, and never displaces another controller.
        void connect({ allowPrepare: false });
      }, Math.max(0, recovery.dueAt - Date.now()));
      return () => window.clearTimeout(timer);
    }
    // An attempt is in flight until it settles into one of the states below.
    if (state === "connecting" || state === "preparing" || state === "connected") return;
    // A proof that failed while the desktop's services restart is retried;
    // a blocked computer, a required update, a rate limit or another tab's
    // live controller is not.
    const retryable = state === "disconnected"
      || (state === "failed" && !controllerConflict)
      || (state === "unavailable" && transientProofFailureRef.current);
    if (!retryable || recovery.attempts >= STREAM_RECONNECT_DELAYS_MS.length) {
      recovery.armed = false;
      recovery.immediate = false;
      recovery.dueAt = null;
      if (state === "disconnected") setMessage(`${STREAM_DROPPED_MESSAGE} Reconnect when you are ready.`);
      // Drops themselves are routine and stay in the console. A recovery that
      // ends without a stream is reported once, with why it ended.
      clientLog.warn(retryable
        ? "remote desktop stream did not reconnect automatically"
        : "remote desktop automatic reconnect stopped", {
        source: "hivra-remote-desktop",
        failureType: retryable ? "hivra_remote_desktop_reconnect_exhausted" : "hivra_remote_desktop_reconnect_stopped",
        computerId,
        attempts: recovery.attempts,
        finalState: state,
        code: lastFailureRef.current.code,
        httpStatus: lastFailureRef.current.status,
        dropReason: recovery.dropReason,
      });
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
    let slowNotice = 0;
    let documentReady = false;
    const liveHandoff = () => {
      const sessionId = sessionIdRef.current;
      const handoff = handoffRef.current;
      return sessionId && handoff?.sessionId === sessionId ? { sessionId, handoff } : null;
    };
    const endSession = (nextState: "unavailable" | "failed" | "disconnected", nextMessage: string, reason: string) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;
      if (nextState === "disconnected" && hiddenEpisodeRef.current && !hiddenEpisodeRef.current.consumed) hiddenEpisodeRef.current.ended = true;
      lastFailureRef.current = { code: reason, status: null };
      settleRecoveryBudget(recoveryRef.current);
      window.clearTimeout(timeout);
      window.clearTimeout(slowNotice);
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
      void releaseSession(sessionId, unreleasedSessionsRef.current);
    };
    const openTimedOut = (reason: "stream-open-timeout" | "handoff-not-ready") => {
      if (!liveHandoff()) return;
      endSession("failed", reason === "handoff-not-ready"
        ? "The computer answered, but its desktop did not start opening."
        : "The computer answered, but its desktop stream did not finish opening.", reason);
    };
    timeout = window.setTimeout(() => openTimedOut("stream-open-timeout"), HANDOFF_DOCUMENT_TIMEOUT_MS);
    slowNotice = window.setTimeout(() => {
      if (!documentReady && liveHandoff()) setMessage("This computer’s desktop is taking longer than usual to answer. Still opening…");
    }, HANDOFF_SLOW_NOTICE_MS);
    // The document's load event (see the iframe's onLoad). Only a document
    // from the broker's origin counts: the initial about:blank is this page's.
    handoffDocumentLoadedRef.current = () => {
      if (documentReady || !liveHandoff()) return;
      window.clearTimeout(timeout);
      timeout = window.setTimeout(() => openTimedOut("handoff-not-ready"), HANDOFF_READY_AFTER_LOAD_MS);
    };
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
        documentReady = true;
        // The handoff document is alive and now exchanges the session. Give
        // that and the first frame their own time rather than what is left of
        // the document's: a slow document must not have its just-exchanged
        // session revoked moments later.
        window.clearTimeout(slowNotice);
        window.clearTimeout(timeout);
        timeout = window.setTimeout(() => openTimedOut("stream-open-timeout"), STREAM_OPEN_AFTER_HANDOFF_TIMEOUT_MS);
        setMessage("Opening the low-latency desktop stream…");
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
        recovery.dueAt = null;
        recovery.dropReason = null;
        recovery.connectedAt = Date.now();
        desktopShownRef.current = true;
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
          recovery.armed = true;
          recovery.dueAt = null;
          recovery.dropReason = reason;
        }
        clientLog.info("remote desktop stream ended", {
          source: "hivra-remote-desktop",
          reason,
          wasStreaming: streamDropped,
          reconnecting: recovery.armed,
        });
        // endSession also refills the budget of a stream that stayed up a minute.
        endSession("disconnected", streamDropped || recovery.armed
          ? STREAM_DROPPED_MESSAGE
          : "The desktop stream stopped before it finished opening. Reconnect when you are ready.", reason);
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
            failure.reason,
          );
        } else {
          endSession("failed", "The secure desktop handoff was rejected.", failure.reason);
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
      window.clearTimeout(slowNotice);
      handoffDocumentLoadedRef.current = null;
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
        const { ok, payload } = await refreshDesktopCapability(computerId);
        if (!stopped && !ok) {
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
    if (previous) void releaseSession(previous, unreleasedSessionsRef.current);

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
        const bridgeRefresh = await refreshDesktopCapability(computerId);
        const bridgePayload = bridgeRefresh.payload;
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
      await connect();
    } catch {
      if (attempt !== attemptRef.current) return;
      setState("prepare-failed");
      setMessage("Desktop couldn’t open. Retry to repair the runtime and try again.");
    }
  }, [cancelStreamRecovery, computerId, connect]);

  /** Every connect the user asks for supersedes an automatic one. */
  const connectByUser = (options?: { allowPrepare?: boolean; proveFirst?: boolean; ownerHandoff?: boolean }) => {
    cancelStreamRecovery();
    hiddenEpisodeRef.current = null;
    void connect(options);
  };
  // After a drop the page has said the desktop and its apps are still running.
  // A click from there, or after an automatic reconnect failed, reconnects to
  // that desktop and never reinstalls it; repair is its own, confirmed, choice.
  const reconnectKeepingDesktop = () => connectByUser({ allowPrepare: false, proveFirst: false });
  const readOnlyUnavailable = state === "unavailable" && !allowAutomaticPrepareRef.current;
  if (confirmInstall === "update-desktop" && state !== "desktop-upgrade-required") setConfirmInstall(null);
  if (confirmInstall === "repair" && !readOnlyUnavailable) setConfirmInstall(null);
  const askToInstall = (kind: InstallKind) => setConfirmInstall(kind);
  const cancelInstall = () => {
    cancelledInstallRef.current = confirmInstall;
    setConfirmInstall(null);
  };

  const retryDesktop = useCallback(() => {
    autoPrepareAttemptedRef.current = false;
    repairableUnavailableRef.current = false;
    void prepareDesktop();
  }, [prepareDesktop]);

  useEffect(() => {
    autoPrepareAttemptedRef.current = false;
    repairableUnavailableRef.current = false;
    desktopShownRef.current = false;
  }, [computerId]);

  useEffect(() => {
    if (!active || !allowAutomaticPrepareRef.current || state !== "unavailable" || autoPrepareAttemptedRef.current) return;
    // Default: missing-capability unavailable auto-repairs when the Desktop tab is active.
    // autoPrepare still covers other unavailable paths (e.g. control-unreachable).
    if (!autoPrepare && !repairableUnavailableRef.current) return;
    autoPrepareAttemptedRef.current = true;
    void prepareDesktop();
  }, [active, autoPrepare, prepareDesktop, state]);

  const runInstall = (kind: InstallKind) => {
    setConfirmInstall(null);
    if (kind === "update-runtime") setMenuOpen(false);
    if (kind === "repair") retryDesktop();
    else void prepareDesktop();
  };
  const renderInstallConfirm = (kind: InstallKind, className: string) => {
    const copy = INSTALL_CONFIRMATIONS[kind];
    return (
      <div role="group" aria-label={copy.label} className={className}>
        <p className={styles.stripMenuNote}>{copy.note}</p>
        <div className={styles.stripMenuConfirmActions}>
          <button type="button" onClick={() => runInstall(kind)} className={styles.stripMenuAction}>
            <RefreshCw size={12} /> {copy.action}
          </button>
          <button ref={confirmCancelRef} type="button" onClick={cancelInstall} className={styles.stripMenuAction}>
            Cancel
          </button>
        </div>
      </div>
    );
  };

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
          <button
            ref={updateDesktopRef}
            type="button"
            onClick={() => askToInstall("update-desktop")}
            aria-expanded={confirmInstall === "update-desktop"}
            className={styles.stripAction}
          >
            Update desktop… <RefreshCw size={11} />
          </button>
        ) : readOnlyUnavailable ? (
          // An automatic reconnect whose runtime proof failed must not leave
          // the user without the Reconnect they had before it ran. Repair,
          // which can close the desktop's apps, sits below the message.
          <button type="button" onClick={reconnectKeepingDesktop} className={styles.stripAction}>
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
        ) : state === "failed" ? (
          <button
            type="button"
            onClick={() => allowAutomaticPrepareRef.current ? connectByUser() : reconnectKeepingDesktop()}
            className={styles.stripAction}
          >
            Try again <RefreshCw size={11} />
          </button>
        ) : state === "disconnected" || state === "reconnecting" ? (
          <button
            type="button"
            onClick={() => desktopShownRef.current ? reconnectKeepingDesktop() : connectByUser()}
            className={styles.stripAction}
          >
            Reconnect <RefreshCw size={11} />
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
              {confirmInstall === "update-runtime" ? renderInstallConfirm("update-runtime", styles.stripMenuConfirm) : (
                <>
                  <button ref={updateRuntimeRef} type="button" onClick={() => askToInstall("update-runtime")} className={styles.stripMenuAction}>
                    <RefreshCw size={12} /> Update runtime…
                  </button>
                  <p className={styles.stripMenuNote}>
                    Optional maintenance. Updating the runtime interrupts this stream.
                  </p>
                </>
              )}
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
            // A cross-origin document hides its own; the initial about:blank does not.
            onLoad={event => { if (event.currentTarget.contentDocument === null) handoffDocumentLoadedRef.current?.(); }}
            style={{ display: "block", height: "100%", width: "100%", border: 0, background: "#090909" }}
          />
        </HivraDesktopViewport>
      ) : state === "connecting" || state === "preparing" ? (
        <LoadingState dark label="Opening your computer…" detail={message} />
      ) : (
        <div style={{ flex: 1, display: "grid", placeItems: "center", padding: 24, textAlign: "center", color: "var(--text-muted)" }}>
          <div style={{ maxWidth: 520 }}>
            <div role="status">
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
            {/* Outside the live region: the question and its buttons are not
                status to announce. */}
            {confirmInstall === "update-desktop" || confirmInstall === "repair" ? (
              renderInstallConfirm(confirmInstall, styles.panelConfirm)
            ) : readOnlyUnavailable ? (
              <button ref={repairDesktopRef} type="button" onClick={() => askToInstall("repair")} className={`${styles.stripMenuAction} ${styles.panelAction}`}>
                <RefreshCw size={12} /> Repair desktop…
              </button>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
