"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LoadingState } from "@/components/ui/LoadingState";
import { Loader2, Maximize2, MonitorUp, RefreshCw, ShieldCheck } from "lucide-react";
import styles from "./HivraRemoteDesktop.module.css";

import {
  activateNativeOmarchyDesktop,
  browserNativeDesktopDependencies,
  focusNativeDesktopProcess,
  inspectNativeDesktopProcess,
  renewNativeOmarchyDesktop,
  stopNativeOmarchyDesktop,
} from "@/lib/remote-computers/native-desktop-handoff";
import {
  DESKTOP_STREAMING_MODE_DETAILS,
  DESKTOP_STREAMING_MODES,
  readStreamModePreference,
  writeStreamModePreference,
  type DesktopStreamingMode,
} from "@/lib/remote-computers/streaming-mode-preference";

type State = "connecting" | "connected" | "disconnected" | "failed";
type PreparedProfile = "omarchy" | "windows";
type StreamMode = DesktopStreamingMode;
type NativeState = "unavailable" | "idle" | "opening" | "opened" | "switching" | "stopping" | "stopped" | "failed" | "stop-failed";
type WindowsPreparationState = "idle" | "preparing" | "prepared" | "pending" | "failed";
type WindowsLaunchState = "idle" | "opening" | "failed";
type NativeActivation = { sessionId: string; activationId: string; processIdentifier: number;
  expiresAt: string; streamingMode: StreamMode };
type ConsoleConnection = {
  disconnect(): void;
  focus(): void;
  qualityLevel: number;
  compressionLevel: number;
};
const NATIVE_ACTIVATION_STORAGE_PREFIX = "hivra.desktop.native-activation.v1:";
const NATIVE_RENEWAL_LEAD_MS = 180_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STREAM_MODE_DETAILS = DESKTOP_STREAMING_MODE_DETAILS;

function nativeActivationStorageKey(computerId: string): string {
  return `${NATIVE_ACTIVATION_STORAGE_PREFIX}${computerId.toLowerCase()}`;
}

function readStoredNativeActivation(computerId: string): NativeActivation | null {
  try {
    const raw = window.localStorage.getItem(nativeActivationStorageKey(computerId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Record<string, unknown>;
    const keys = Object.keys(value).sort();
    if (keys.join(",") !== ["activationId", "expiresAt", "processIdentifier", "sessionId", "streamingMode"].sort().join(",")
      || typeof value.sessionId !== "string" || !UUID.test(value.sessionId)
      || typeof value.activationId !== "string" || !UUID.test(value.activationId)
      || !Number.isSafeInteger(value.processIdentifier) || Number(value.processIdentifier) <= 0
      || !DESKTOP_STREAMING_MODES.includes(value.streamingMode as StreamMode)
      || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))) return null;
    return {
      sessionId: value.sessionId,
      activationId: value.activationId,
      processIdentifier: Number(value.processIdentifier),
      expiresAt: value.expiresAt,
      streamingMode: value.streamingMode as StreamMode,
    };
  } catch {
    return null;
  }
}

function writeStoredNativeActivation(computerId: string, activation: NativeActivation | null): void {
  try {
    const key = nativeActivationStorageKey(computerId);
    if (activation) window.localStorage.setItem(key, JSON.stringify(activation));
    else window.localStorage.removeItem(key);
  } catch {
    // Native process ownership remains authoritative when browser storage is unavailable.
  }
}

export function consoleEncodingFor(profile: PreparedProfile | undefined, mode: StreamMode = "hq") {
  // QEMU's framebuffer is a recovery transport, so prioritize interactive
  // latency even in HQ mode. Performance retains the established WAN presets;
  // HQ trades bandwidth for clearer text without using maximum compression.
  if (mode === "hq") {
    return profile === "windows"
      ? { qualityLevel: 8, compressionLevel: 2 }
      : { qualityLevel: 9, compressionLevel: 2 };
  }
  return profile === "windows"
    ? { qualityLevel: 5, compressionLevel: 6 }
    : { qualityLevel: 6, compressionLevel: 4 };
}

function nativeFailureMessage(code: string): string {
  switch (code) {
  case "native_relay_unavailable": return "Native relay is not available yet.";
  case "capability_unavailable": return "This computer is not ready for native streaming.";
  case "native_moonlight_launch_failed": return "Moonlight could not be opened by the Hivra app.";
  default: return "Native desktop could not be opened safely. Try opening it again.";
  }
}

export function HivraConsoleDesktop({ computerId, name, profile, active = true, autoOpenFast = false }: {
  computerId: string;
  name: string;
  profile?: PreparedProfile;
  active?: boolean;
  autoOpenFast?: boolean;
}) {
  const nativeFirst = profile === "omarchy" && browserNativeDesktopDependencies() !== null;
  const fastProfile = profile === "omarchy" || profile === "windows";
  const viewportRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const connectionRef = useRef<ConsoleConnection | null>(null);
  const profileRef = useRef<PreparedProfile | undefined>(undefined);
  const attemptRef = useRef(0);
  const [state, setState] = useState<State>("connecting");
  const [streamMode, setStreamMode] = useState<StreamMode>(() => readStreamModePreference(computerId));
  const streamModeRef = useRef(streamMode);
  const [message, setMessage] = useState("Opening this computer’s secure recovery console…");
  const [nativeState, setNativeState] = useState<NativeState>("unavailable");
  const [nativeMessage, setNativeMessage] = useState("");
  const [nativeActivation, setNativeActivation] = useState<NativeActivation | null>(null);
  const [windowsPreparationState, setWindowsPreparationState] = useState<WindowsPreparationState>("idle");
  const [windowsPreparationMessage, setWindowsPreparationMessage] = useState("");
  const [windowsLaunchState, setWindowsLaunchState] = useState<WindowsLaunchState>("idle");
  const [windowsLaunchUrl, setWindowsLaunchUrl] = useState<string | null>(null);
  const [windowsLaunchMode, setWindowsLaunchMode] = useState<StreamMode | null>(null);
  const [windowsFrameLoaded, setWindowsFrameLoaded] = useState(false);
  const [windowsFrameRevision, setWindowsFrameRevision] = useState(0);
  const [windowsFrameLoading, setWindowsFrameLoading] = useState(false);
  const windowsFrameRef = useRef<HTMLIFrameElement>(null);
  const windowsAttemptRef = useRef(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const renewalIdRef = useRef<string | null>(null);
  const automaticReleaseInFlightRef = useRef(false);
  const windowsFastOpenButtonRef = useRef<HTMLButtonElement>(null);
  const nativeOpenButtonRef = useRef<HTMLButtonElement>(null);
  const automaticWindowsOpenAttemptedRef = useRef(false);

  useEffect(() => {
    windowsAttemptRef.current += 1;
    setWindowsLaunchUrl(null);
    setWindowsLaunchMode(null);
    setWindowsFrameLoaded(false);
    setWindowsFrameLoading(false);
    setWindowsLaunchState("idle");
    setWindowsPreparationState("idle");
    setWindowsPreparationMessage("");
    automaticWindowsOpenAttemptedRef.current = false;
    return () => { windowsAttemptRef.current += 1; };
  }, [computerId, profile]);

  useEffect(() => {
    const changed = () => setIsFullscreen(document.fullscreenElement === shellRef.current);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);

  useEffect(() => {
    const preferred = readStreamModePreference(computerId);
    streamModeRef.current = preferred;
    setStreamMode(preferred);
  }, [computerId]);

  useEffect(() => {
    if (profile !== "omarchy") return;
    setNativeState(browserNativeDesktopDependencies() ? "idle" : "unavailable");
  }, [profile]);

  useEffect(() => {
    if (profile !== "omarchy" || !browserNativeDesktopDependencies()) return;
    const stored = readStoredNativeActivation(computerId);
    if (!stored) {
      writeStoredNativeActivation(computerId, null);
      return;
    }
    let cancelled = false;
    setNativeState("opening");
    setNativeMessage("Reconnecting to the active Moonlight stream…");
    void inspectNativeDesktopProcess({
      sessionId: stored.sessionId,
      processIdentifier: stored.processIdentifier,
    }).then(async status => {
      if (cancelled) return;
      if (!status.ok) {
        setNativeActivation(stored);
        setNativeState("stop-failed");
        setNativeMessage("The saved Moonlight process could not be re-proved. Retry stop to release it safely.");
        return;
      }
      if (!status.running) {
        setNativeMessage("Moonlight is closed. Releasing its saved desktop controller…");
        const released = await stopNativeOmarchyDesktop({
          computerId,
          sessionId: stored.sessionId,
          activationId: stored.activationId,
          processIdentifier: stored.processIdentifier,
        });
        if (cancelled) return;
        if (!released.ok) {
          if (released.code === "stop_denied" && Date.parse(stored.expiresAt) <= Date.now()) {
            writeStoredNativeActivation(computerId, null);
            setNativeState("idle");
            setNativeMessage("Closed expired Moonlight session was already released.");
            return;
          }
          setNativeActivation(stored);
          setNativeState("stop-failed");
          setNativeMessage("Moonlight is closed, but its saved controller release could not be proven. Retry stop.");
          return;
        }
        writeStoredNativeActivation(computerId, null);
        setNativeState("idle");
        setNativeMessage("Closed Moonlight session released.");
        return;
      }
      if (Date.parse(stored.expiresAt) <= Date.now()) {
        setNativeMessage("Saved native stream expired. Closing Moonlight and releasing its controller…");
        const released = await stopNativeOmarchyDesktop({
          computerId,
          sessionId: stored.sessionId,
          activationId: stored.activationId,
          processIdentifier: stored.processIdentifier,
        });
        if (cancelled) return;
        if (!released.ok) {
          setNativeActivation(stored);
          setNativeState("stop-failed");
          setNativeMessage("The expired native stream could not be fully released. Retry stop once.");
          return;
        }
        writeStoredNativeActivation(computerId, null);
        setNativeState("stopped");
        setNativeMessage("Expired native stream closed and its controller was released.");
        return;
      }
      streamModeRef.current = stored.streamingMode;
      setStreamMode(stored.streamingMode);
      setNativeActivation(stored);
      setNativeState("opened");
      setNativeMessage(`Native ${STREAM_MODE_DETAILS[stored.streamingMode].label}: ${STREAM_MODE_DETAILS[stored.streamingMode].status}. Reconnected to Moonlight.`);
    });
    return () => { cancelled = true; };
  }, [computerId, profile]);

  const connect = useCallback(async () => {
    const attempt = ++attemptRef.current;
    connectionRef.current?.disconnect();
    connectionRef.current = null;
    setState("connecting");
    setMessage("Opening this computer’s secure recovery console…");
    const target = viewportRef.current;
    if (!target) return;
    target.replaceChildren();
    try {
      const response = await fetch(`/api/hivra/agents/${encodeURIComponent(computerId)}/console`, {
        method: "POST", credentials: "same-origin", cache: "no-store",
      });
      const payload = await response.json() as { success?: boolean; error?: string; data?: { websocketUrl?: string; password?: string; profile?: PreparedProfile } };
      if (!response.ok || payload.success !== true || !payload.data?.websocketUrl || !payload.data.password) {
        throw new Error(payload.error || "The recovery console is unavailable.");
      }
      const parsed = new URL(payload.data.websocketUrl);
      if (parsed.protocol !== "wss:" || parsed.hostname !== "console-canary.hermesos.cloud") throw new Error("The console handoff was invalid.");
      const { default: RFB } = await import("@novnc/novnc");
      if (attempt !== attemptRef.current || !viewportRef.current) return;
      const rfb = new RFB(viewportRef.current, parsed.toString(), { credentials: { password: payload.data.password } });
      rfb.scaleViewport = true;
      rfb.resizeSession = true;
      rfb.clipViewport = false;
      rfb.viewOnly = false;
      rfb.focusOnClick = true;
      // Proxmox's VNC console can publish a fully transparent cursor and paint
      // the guest pointer into delayed framebuffer updates instead. In that
      // case noVNC normally hides the browser cursor, so pointer movement feels
      // one network/frame round trip behind. Keep noVNC's local dot fallback
      // enabled; it is used only while the server has no visible cursor shape.
      rfb.showDotCursor = true;
      profileRef.current = payload.data.profile;
      const encoding = consoleEncodingFor(payload.data.profile, streamModeRef.current);
      rfb.qualityLevel = encoding.qualityLevel;
      rfb.compressionLevel = encoding.compressionLevel;
      rfb.addEventListener("connect", () => {
        if (attempt !== attemptRef.current) return;
        setState("connected");
        setMessage("Recovery console connected");
        rfb.focus();
      });
      rfb.addEventListener("disconnect", event => {
        if (attempt !== attemptRef.current) return;
        const clean = event.detail?.clean === true;
        setState(clean ? "disconnected" : "failed");
        setMessage(clean ? "Desktop disconnected" : event.detail?.reason || "The desktop connection closed.");
      });
      rfb.addEventListener("securityfailure", () => {
        if (attempt !== attemptRef.current) return;
        setState("failed");
        setMessage("The one-time console handoff was rejected. Reconnect to request a fresh one.");
      });
      connectionRef.current = rfb;
    } catch (error) {
      if (attempt !== attemptRef.current) return;
      setState("failed");
      setMessage(error instanceof Error ? error.message : "The recovery console is unavailable.");
    }
  }, [computerId]);

  useEffect(() => {
    if (!active) {
      attemptRef.current += 1;
      connectionRef.current?.disconnect();
      connectionRef.current = null;
      return;
    }
    if (fastProfile) {
      attemptRef.current += 1;
      connectionRef.current?.disconnect();
      connectionRef.current = null;
      setState("disconnected");
      setMessage(profile === "windows"
        ? "Windows opens through the fast RDP gateway"
        : nativeFirst
          ? "Omarchy opens in a managed desktop window"
          : "Omarchy browser streaming is not available yet");
      return;
    }
    void connect();
    return () => {
      attemptRef.current += 1;
      connectionRef.current?.disconnect();
      connectionRef.current = null;
    };
  }, [active, connect, fastProfile, nativeFirst, profile]);

  const fullscreen = async () => {
    const shell = shellRef.current;
    if (!shell) return;
    try {
      if (document.fullscreenElement === shell) {
        await document.exitFullscreen();
      } else if (typeof shell.requestFullscreen === "function") {
        // Fullscreen the existing surface, never navigate or replace its RDP frame.
        await shell.requestFullscreen();
        windowsFrameRef.current?.focus();
      } else {
        setMessage("Fullscreen is unavailable. The desktop stays here.");
      }
    } catch {
      setMessage("Fullscreen could not change. The desktop stays here.");
    }
  };

  const applyStreamMode = (mode: StreamMode) => {
    streamModeRef.current = mode;
    setStreamMode(mode);
    writeStreamModePreference(computerId, mode);
    const connection = connectionRef.current;
    if (!connection) return;
    const encoding = consoleEncodingFor(profileRef.current, mode);
    connection.qualityLevel = encoding.qualityLevel;
    connection.compressionLevel = encoding.compressionLevel;
  };

  const launchNativeDesktop = async (mode: StreamMode, switching = false) => {
    setNativeState("opening");
    setNativeMessage(`${switching ? "Opening" : "Preparing"} ${STREAM_MODE_DETAILS[mode].label} native streaming…`);
    let result = await activateNativeOmarchyDesktop({
      computerId,
      udp: "direct",
      streamingMode: mode,
    });
    if (!result.ok && (result.code === "capability_unavailable" || result.code === "computer_not_ready")
      && !result.profileReleasePending && !result.sessionReleasePending && !switching) {
      setNativeMessage("Preparing this Omarchy computer for native streaming…");
      try {
        const response = await fetch(`/api/hivra/agents/${encodeURIComponent(computerId)}/remote-desktop`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "prepare" }),
        });
        const payload = await response.json().catch(() => null) as {
          success?: boolean;
          code?: string;
          error?: string;
          data?: { prepared?: boolean };
        } | null;
        if (!response.ok || payload?.success !== true || payload.data?.prepared !== true) {
          setNativeState("failed");
          setNativeMessage(payload?.error || "This Omarchy computer could not be prepared for native streaming.");
          return false;
        }
      } catch {
        setNativeState("failed");
        setNativeMessage("Omarchy native preparation could not be confirmed. Try opening it again after the computer is ready.");
        return false;
      }
      setNativeMessage(`Opening ${STREAM_MODE_DETAILS[mode].label} native streaming…`);
      result = await activateNativeOmarchyDesktop({
        computerId,
        udp: "direct",
        streamingMode: mode,
      });
    }
    if (result.ok) {
      setNativeState("opened");
      const activation = {
        sessionId: result.handoff.sessionId,
        activationId: result.activationId,
        processIdentifier: result.processIdentifier,
        expiresAt: result.handoff.expiresAt,
        streamingMode: result.handoff.streamingMode,
      };
      setNativeActivation(activation);
      writeStoredNativeActivation(computerId, activation);
      setNativeMessage(`Native ${STREAM_MODE_DETAILS[result.handoff.streamingMode].label}: ${STREAM_MODE_DETAILS[result.handoff.streamingMode].status}. Opened in Moonlight.`);
      return true;
    }
    setNativeState("failed");
    setNativeMessage(nativeFailureMessage(result.code));
    return false;
  };

  const switchNativeStreamMode = async (mode: StreamMode) => {
    if (profile !== "omarchy" || !nativeActivation || mode === nativeActivation.streamingMode
      || nativeState === "opening" || nativeState === "switching" || nativeState === "stopping"
      || automaticReleaseInFlightRef.current) return;
    setNativeState("switching");
    setNativeMessage(`Switching to ${STREAM_MODE_DETAILS[mode].status}. Stopping the current stream safely…`);
    const current = nativeActivation;
    const stopped = await stopNativeOmarchyDesktop({
      computerId, sessionId: current.sessionId, activationId: current.activationId,
      processIdentifier: current.processIdentifier,
    });
    if (!stopped.ok) {
      setNativeState("stop-failed");
      setNativeMessage(`Could not prove the current ${STREAM_MODE_DETAILS[current.streamingMode].label} stream stopped. It remains held; retry the switch or stop it.`);
      return;
    }
    renewalIdRef.current = null;
    setNativeActivation(null);
    writeStoredNativeActivation(computerId, null);
    applyStreamMode(mode);
    await launchNativeDesktop(mode, true);
  };

  const chooseStreamMode = (mode: StreamMode) => {
    if (mode === streamModeRef.current) return;
    if (nativeActivation) {
      void switchNativeStreamMode(mode);
      return;
    }
    applyStreamMode(mode);
  };

  const openNativeDesktop = async () => {
    if (profile !== "omarchy" || nativeActivation || nativeState === "opening") return;
    await launchNativeDesktop(streamModeRef.current);
  };

  const returnToNativeDesktop = async () => {
    if (!nativeActivation) return;
    setNativeMessage("Returning to the active Omarchy desktop…");
    const result = await focusNativeDesktopProcess({
      sessionId: nativeActivation.sessionId,
      processIdentifier: nativeActivation.processIdentifier,
    });
    setNativeMessage(result.ok
      ? `Native ${STREAM_MODE_DETAILS[nativeActivation.streamingMode].label}: ${STREAM_MODE_DETAILS[nativeActivation.streamingMode].status}. Active in Moonlight.`
      : "Moonlight could not be brought forward. Reopen the native desktop once.");
  };

  useEffect(() => {
    if (!nativeActivation || nativeState !== "opened") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (milliseconds: number) => {
      timer = setTimeout(() => void attempt(), Math.max(1_000, milliseconds));
    };
    const attempt = async () => {
      if (cancelled) return;
      const processStatus = await inspectNativeDesktopProcess({
        sessionId: nativeActivation.sessionId,
        processIdentifier: nativeActivation.processIdentifier,
      });
      if (cancelled) return;
      if (processStatus.ok && !processStatus.running) {
        automaticReleaseInFlightRef.current = true;
        setNativeMessage("Moonlight closed. Releasing its native desktop controller…");
        const released = await stopNativeOmarchyDesktop({
          computerId, sessionId: nativeActivation.sessionId,
          activationId: nativeActivation.activationId,
          processIdentifier: nativeActivation.processIdentifier,
        });
        automaticReleaseInFlightRef.current = false;
        if (cancelled) return;
        renewalIdRef.current = null;
        if (released.ok) {
          writeStoredNativeActivation(computerId, null);
          setNativeActivation(null);
          setNativeState("stopped");
          setNativeMessage("Moonlight closed and its controller was released.");
        } else {
          setNativeState("stop-failed");
          setNativeMessage("Moonlight closed, but controller release could not be proven. The safe deadline remains active.");
        }
        return;
      }
      if (!processStatus.ok) {
        const remaining = Date.parse(nativeActivation.expiresAt) - Date.now();
        if (remaining > 35_000) {
          setNativeMessage("Checking the local Moonlight process before renewing…");
          schedule(Math.min(5_000, remaining - 30_000));
        } else {
          setNativeMessage("Moonlight process state could not be proven. The stream will close at the current safe deadline.");
        }
        return;
      }
      if (Date.parse(nativeActivation.expiresAt) <= Date.now()) {
        automaticReleaseInFlightRef.current = true;
        setNativeMessage("Native stream lease expired. Closing Moonlight and releasing its controller…");
        const released = await stopNativeOmarchyDesktop({
          computerId, sessionId: nativeActivation.sessionId,
          activationId: nativeActivation.activationId,
          processIdentifier: nativeActivation.processIdentifier,
        });
        automaticReleaseInFlightRef.current = false;
        if (cancelled) return;
        renewalIdRef.current = null;
        if (released.ok) {
          writeStoredNativeActivation(computerId, null);
          setNativeActivation(null);
          setNativeState("stopped");
          setNativeMessage("Expired native stream closed and its controller was released.");
        } else {
          setNativeState("stop-failed");
          setNativeMessage("The expired native stream could not be fully released. Retry stop once.");
        }
        return;
      }
      const untilRenewal = Date.parse(nativeActivation.expiresAt) - Date.now() - NATIVE_RENEWAL_LEAD_MS;
      if (untilRenewal > 0) {
        schedule(Math.min(5_000, untilRenewal));
        return;
      }
      const renewalId = renewalIdRef.current ?? window.crypto.randomUUID().toLowerCase();
      renewalIdRef.current = renewalId;
      const result = await renewNativeOmarchyDesktop({
        computerId, sessionId: nativeActivation.sessionId,
        activationId: nativeActivation.activationId, renewalId,
      });
      if (cancelled) return;
      if (result.ok) {
        renewalIdRef.current = null;
        setNativeActivation(current => {
          if (!current || current.sessionId !== result.sessionId) return current;
          const renewed = { ...current, expiresAt: result.expiresAt };
          writeStoredNativeActivation(computerId, renewed);
          return renewed;
        });
        setNativeMessage(`Native ${STREAM_MODE_DETAILS[nativeActivation.streamingMode].label}: ${STREAM_MODE_DETAILS[nativeActivation.streamingMode].status}. Active in Moonlight.`);
        return;
      }
      const remaining = Date.parse(nativeActivation.expiresAt) - Date.now();
      if (remaining > 35_000) {
        setNativeMessage("Native stream renewal is retrying; the current lease remains active.");
        schedule(Math.min(5_000, remaining - 30_000));
      } else {
        setNativeMessage("Native stream renewal could not be proven. Moonlight will close at the current safe deadline.");
        schedule(Math.max(1_000, remaining + 1_000));
      }
    };
    schedule(Math.min(5_000, Date.parse(nativeActivation.expiresAt) - Date.now() - NATIVE_RENEWAL_LEAD_MS));
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [computerId, nativeActivation, nativeState]);

  const stopNativeDesktop = async () => {
    if (profile !== "omarchy" || !nativeActivation || nativeState === "stopping"
      || automaticReleaseInFlightRef.current) return;
    setNativeState("stopping");
    setNativeMessage("Stopping the native desktop and releasing its controller…");
    const { sessionId, activationId, processIdentifier } = nativeActivation;
    const result = await stopNativeOmarchyDesktop({ computerId, sessionId, activationId, processIdentifier });
    if (result.ok) {
      setNativeState("stopped");
      setNativeActivation(null);
      writeStoredNativeActivation(computerId, null);
      renewalIdRef.current = null;
      setNativeMessage(result.localProcessStopped
        ? "Native desktop stopped and controller released."
        : "Native controller released. Moonlight will disconnect from the stopped server.");
      return;
    }
    setNativeState("stop-failed");
    setNativeMessage("Native stop could not be fully proven. The activation remains held for safe recovery.");
  };

  const prepareWindowsDesktop = async (attempt: number) => {
    if (attempt !== windowsAttemptRef.current || profile !== "windows" || windowsPreparationState === "preparing") return false;
    if (windowsPreparationState === "prepared") return true;
    setWindowsPreparationState("preparing");
    setWindowsPreparationMessage("Preparing Windows Remote Desktop and verifying its guest firewall boundary…");
    try {
      const response = await fetch(`/api/hivra/agents/${encodeURIComponent(computerId)}/remote-desktop`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "prepare" }),
      });
      const payload = await response.json().catch(() => null) as {
        success?: boolean;
        code?: string;
        error?: string;
        data?: { prepared?: boolean };
      } | null;
      if (attempt !== windowsAttemptRef.current) return false;
      if (response.ok && payload?.success && payload.data?.prepared === true) {
        setWindowsPreparationState("prepared");
        setWindowsPreparationMessage("Windows Remote Desktop is prepared and verified. Opening the fast desktop…");
        return true;
      }
      const pending = payload?.code === "desktop_prepare_pending";
      setWindowsPreparationState(pending ? "pending" : "failed");
      setWindowsPreparationMessage(payload?.error || (pending
        ? "Windows setup is still unconfirmed. Check it once to inspect the retained operation."
          : "Windows Remote Desktop setup could not be verified."));
      return false;
    } catch {
      if (attempt !== windowsAttemptRef.current) return false;
      setWindowsPreparationState("pending");
      setWindowsPreparationMessage("Windows setup could not be confirmed. Check it once before starting another preparation.");
      return false;
    }
  };

  const requestWindowsDesktop = async (attempt: number): Promise<"opened" | "prepare_required" | "failed"> => {
    const requestedMode = streamModeRef.current;
    const panel = viewportRef.current;
    const viewport = panel && panel.clientWidth > 0 && panel.clientHeight > 0
      ? { width: panel.clientWidth, height: panel.clientHeight } : undefined;
    const response = await fetch(`/api/hivra/agents/${encodeURIComponent(computerId)}/windows-desktop`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ streamingMode: requestedMode, viewport }),
    });
    const payload = await response.json().catch(() => null) as {
      success?: boolean;
      code?: string;
      error?: string;
      data?: { launchUrl?: string };
    } | null;
    if (attempt !== windowsAttemptRef.current) return "failed";
    if (!response.ok || payload?.success !== true || typeof payload.data?.launchUrl !== "string") {
      setWindowsPreparationMessage(payload?.error || "The fast Windows desktop could not be opened.");
      return response.status === 409
        && (payload?.code === "windows_prepare_required" || payload?.code === "windows_prepare_resume_required")
        ? "prepare_required" : "failed";
    }
    const launchUrl = new URL(payload.data.launchUrl);
    if (launchUrl.origin !== "https://windows-canary.hermesos.cloud" || launchUrl.username || launchUrl.password) {
      setWindowsPreparationMessage("The Windows desktop handoff was invalid.");
      return "failed";
    }
    // Keep the authenticated handoff only in memory. The same frame survives
    // tab changes and browser fullscreen exit without reconnecting the guest.
    setWindowsFrameLoading(true);
    setWindowsLaunchUrl(launchUrl.toString());
    // An explicit reconnect must reload even if the gateway reissues the same
    // URL. Ordinary tab/fullscreen changes retain this frame revision.
    setWindowsFrameRevision(revision => revision + 1);
    setWindowsLaunchMode(requestedMode);
    setWindowsFrameLoaded(false);
    setWindowsLaunchState("idle");
    setMessage("Windows desktop is opening inline");
    setWindowsPreparationMessage("");
    return "opened";
  };

  const openWindowsDesktop = async () => {
    if (profile !== "windows" || windowsLaunchState === "opening") return;
    const attempt = ++windowsAttemptRef.current;
    setWindowsLaunchState("opening");
    setWindowsPreparationMessage(`Opening ${STREAM_MODE_DETAILS[streamModeRef.current].status} over the fast Windows connection…`);
    try {
      const handoff = await requestWindowsDesktop(attempt);
      if (attempt !== windowsAttemptRef.current) return;
      if (handoff === "opened") return;
      // A gateway/auth/lifecycle failure is not permission to mutate guest
      // settings. Prepare only when the owner-bound API explicitly requests it.
      if (handoff === "prepare_required") {
        setWindowsPreparationMessage("Checking Windows Remote Desktop before one retry…");
        if (await prepareWindowsDesktop(attempt) && attempt === windowsAttemptRef.current
          && await requestWindowsDesktop(attempt) === "opened") return;
      }
      if (attempt !== windowsAttemptRef.current) return;
      setWindowsLaunchState("failed");
    } catch {
      if (attempt !== windowsAttemptRef.current) return;
      setWindowsLaunchState("failed");
      setWindowsPreparationMessage("The fast Windows desktop could not be opened.");
    }
  };

  useEffect(() => {
    if (!active || profile !== "windows" || !autoOpenFast || automaticWindowsOpenAttemptedRef.current) return;
    automaticWindowsOpenAttemptedRef.current = true;
    const current = new URL(window.location.href);
    current.searchParams.delete("open");
    window.history.replaceState(window.history.state, "", `${current.pathname}${current.search}${current.hash}`);
    windowsFastOpenButtonRef.current?.click();
  }, [active, autoOpenFast, profile]);

  const windowsBusy = windowsLaunchState === "opening" || windowsPreparationState === "preparing";
  const windowsQualityChanged = windowsLaunchUrl !== null && windowsLaunchMode !== streamMode;
  const windowsStatus = windowsBusy ? "Opening" : windowsLaunchState === "failed" ? "Couldn’t open"
    : windowsLaunchUrl ? windowsFrameLoaded ? "Open" : "Opening" : "Ready";
  const windowsDiagnostic = windowsPreparationMessage || (windowsLaunchState === "failed" ? message
    : windowsQualityChanged ? "Reconnect to apply the selected quality."
    : windowsLaunchUrl ? windowsFrameLoaded ? "Windows desktop gateway loaded · Full screen is optional" : "Windows desktop is opening inline"
    : "Open your Windows desktop here.");

  return (
    <div ref={shellRef} hidden={!active} style={{ height: "100%", minHeight: 0, display: active ? "flex" : "none", flexDirection: "column", background: "#090909" }}>
      {profile === "windows" ? (
        <header className={styles.strip}>
          <span className={styles.stripStatus} aria-hidden="true">
            {windowsStatus === "Opening" ? <Loader2 size={13} className="animate-spin" /> : <MonitorUp size={13} />}
          </span>
          <span className={styles.stripLabel}>{windowsStatus}</span>
          <span className={styles.stripMessage} role="status" title={windowsDiagnostic}>{windowsDiagnostic}</span>
          <span className={styles.stripSpacer} />
          <label className={styles.stripField}>
            <span className={styles.stripFieldLabel}>Quality</span>
            <select aria-label="Desktop quality" value={streamMode} disabled={windowsBusy}
              onChange={event => chooseStreamMode(event.target.value as StreamMode)}
              className={`mono ${styles.stripSelect}`}>
              {DESKTOP_STREAMING_MODES.map(mode => (
                <option key={mode} value={mode} title={STREAM_MODE_DETAILS[mode].status}>{STREAM_MODE_DETAILS[mode].label}</option>
              ))}
            </select>
          </label>
          <button ref={windowsFastOpenButtonRef} type="button" onClick={() => void openWindowsDesktop()}
            disabled={windowsBusy} className={styles.stripAction}
            aria-label={windowsLaunchState === "failed" ? "Try again" : windowsLaunchUrl ? "Reconnect Windows desktop" : "Open fast Windows desktop"}
            title={windowsQualityChanged ? "Reconnect to apply the selected quality" : "Open Windows over the verified private RDP gateway"}>
            {windowsBusy ? "Opening" : windowsLaunchState === "failed" ? "Try again" : windowsLaunchUrl ? "Reconnect" : "Open"}
            {windowsLaunchUrl || windowsLaunchState === "failed" ? <RefreshCw size={11} /> : <MonitorUp size={11} />}
          </button>
          <button type="button" onClick={() => void fullscreen()} className={styles.stripIcon}
            aria-label={isFullscreen ? "Exit full screen" : "Full screen"}
            title={isFullscreen ? "Return to inline desktop" : "Expand desktop; Escape returns here"}><Maximize2 size={13} /></button>
        </header>
      ) : (
      <div style={{ minHeight: 46, display: "flex", alignItems: "center", gap: 10, padding: "0 16px", borderBottom: "1px solid rgba(255,255,255,.12)", color: "#eee" }}>
        {state === "connecting" ? <Loader2 size={15} className="spin" /> : <ShieldCheck size={15} color={state === "connected" ? "#63d49b" : "#aaa"} />}
        <strong style={{ fontSize: 12 }}>{message}</strong>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "#999" }}>{name}</span>
        <div role="group" aria-label="Desktop streaming mode" style={{ display: "inline-flex", border: "1px solid #333" }}>
          {DESKTOP_STREAMING_MODES.map((mode, index) => (
            <button
              key={mode}
              type="button"
              aria-pressed={streamMode === mode}
              disabled={nativeState === "opening" || nativeState === "switching" || nativeState === "stopping"}
              onClick={() => chooseStreamMode(mode)}
              title={nativeActivation && nativeActivation.streamingMode !== mode
                ? `Safely restart this native desktop in ${STREAM_MODE_DETAILS[mode].status}`
                : `${STREAM_MODE_DETAILS[mode].status}. Fast desktop quality.`}
              style={{ border: 0, borderRight: index < DESKTOP_STREAMING_MODES.length - 1 ? "1px solid #333" : 0, background: streamMode === mode ? "#eee" : "transparent", color: streamMode === mode ? "#111" : "#bbb", padding: "7px 8px", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.06em", cursor: nativeState === "opening" || nativeState === "switching" || nativeState === "stopping" ? "wait" : "pointer", opacity: nativeState === "opening" || nativeState === "switching" || nativeState === "stopping" ? 0.75 : 1, whiteSpace: "nowrap" }}
            >
              {STREAM_MODE_DETAILS[mode].label} <span style={{ opacity: 0.64 }}>{STREAM_MODE_DETAILS[mode].resolution}</span>
            </button>
          ))}
        </div>
        {nativeState !== "unavailable" && !nativeActivation ? (
          <button ref={nativeOpenButtonRef} type="button"
            onClick={() => void openNativeDesktop()}
            disabled={nativeState === "opening" || nativeState === "switching" || nativeState === "stopping"}
            aria-label="Open native Omarchy desktop"
            title="Open this Omarchy desktop in the signed Moonlight app"
            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 9px", color: "inherit", background: "transparent", border: "1px solid #333", opacity: nativeState === "opening" || nativeState === "switching" || nativeState === "stopping" ? 0.7 : 1 }}>
            {nativeState === "opening" || nativeState === "switching" || nativeState === "stopping" ? <Loader2 size={14} className="spin" /> : <MonitorUp size={14} />}
            {nativeState === "switching" ? "Switching" : nativeState === "stopping" ? "Stopping" : nativeState === "stop-failed" ? "Retry stop" : "Open native"}
          </button>
        ) : null}
        {nativeActivation ? <>
          <button type="button" onClick={() => void returnToNativeDesktop()}
            aria-label="Return to Omarchy desktop" title="Bring the active Moonlight desktop back to the foreground"
            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 9px", color: "#111", background: "#eee", border: "1px solid #eee" }}>
            <MonitorUp size={14} /> Return to Omarchy
          </button>
          <button type="button" onClick={() => void stopNativeDesktop()}
            disabled={nativeState === "stopping"} aria-label="Stop native Omarchy desktop"
            title="Stop Moonlight and release this controller"
            style={{ display: "inline-flex", alignItems: "center", padding: "7px 9px", color: "inherit", background: "transparent", border: "1px solid #333", opacity: nativeState === "stopping" ? 0.7 : 1 }}>
            {nativeState === "stopping" ? "Stopping" : nativeState === "stop-failed" ? "Retry stop" : "Stop native"}
          </button>
        </> : null}
        {!fastProfile ? <button type="button" onClick={() => void connect()}
          aria-label="Reconnect desktop" title="Reconnect desktop"
          style={{ padding: 7, color: "inherit", background: "transparent", border: "1px solid #333" }}><RefreshCw size={14} /></button> : null}
        <button type="button" onClick={() => void fullscreen()} aria-label={isFullscreen ? "Exit full screen" : "Full screen"} title={isFullscreen ? "Return to inline desktop" : "Expand desktop; Escape returns here"} style={{ padding: 7, color: "inherit", background: "transparent", border: "1px solid #333" }}><Maximize2 size={14} /></button>
      </div>
      )}
      {nativeMessage ? (
        <div role="status" style={{ padding: "8px 16px", borderBottom: "1px solid rgba(255,255,255,.12)", color: nativeState === "failed" ? "#f0b7b7" : "#bbb", fontSize: 11 }}>
          {nativeMessage}
        </div>
      ) : null}
      <div ref={viewportRef} aria-label={`${name} interactive desktop`} style={{ flex: 1, minHeight: 0, overflow: "hidden", background: "#000", position: "relative" }}>
        {profile === "windows" ? windowsLaunchUrl ? (
          <iframe key={windowsFrameRevision} ref={windowsFrameRef} title={`${name} Windows desktop`} src={windowsLaunchUrl}
            sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-downloads"
            allow="clipboard-read https://windows-canary.hermesos.cloud; clipboard-write https://windows-canary.hermesos.cloud"
            referrerPolicy="no-referrer"
            onLoad={() => { setWindowsFrameLoading(false); setWindowsFrameLoaded(true); setMessage("Windows desktop gateway loaded · Full screen is optional"); windowsFrameRef.current?.focus(); }}
            onErrorCapture={() => { setWindowsFrameLoading(false); setWindowsFrameLoaded(false); setWindowsLaunchState("failed"); setMessage("Windows desktop could not load. Reconnect Windows to request a fresh session."); }}
            style={{ display: "block", width: "100%", height: "100%", border: 0, background: "#000" }} />
        ) : windowsLaunchState === "opening" ? (
          <LoadingState dark label={windowsPreparationState === "preparing" ? "Preparing Windows…" : "Opening Windows…"} detail={name} />
        ) : (
          <div style={{ height: "100%", display: "grid", placeItems: "center", padding: 32, textAlign: "center", color: "#eee" }}>
            <div style={{ maxWidth: 520 }}>
              <MonitorUp size={34} style={{ margin: "0 auto 16px" }} />
              <h2 style={{ margin: "0 0 8px", fontSize: 22 }}>Open Windows desktop here</h2>
              <p style={{ margin: 0, color: "#aaa", lineHeight: 1.5 }}>Select Open to connect. Full screen is optional; exiting it keeps your desktop here.</p>
            </div>
          </div>
        ) : null}
        {profile === "windows" && windowsLaunchUrl && (windowsFrameLoading || windowsLaunchState === "opening") ? (
          <div style={{ position: "absolute", inset: 0 }}><LoadingState dark label="Opening Windows…" detail={name} /></div>
        ) : null}
        {profile === "omarchy" && (nativeState === "opening" || nativeState === "switching") ? (
          <LoadingState dark label={nativeState === "switching" ? "Switching desktop quality…" : "Opening Omarchy…"} detail={name} />
        ) : profile === "omarchy" ? (
          <div style={{ height: "100%", display: "grid", placeItems: "center", padding: 32, textAlign: "center", color: "#eee" }}>
            <div style={{ maxWidth: 520 }}>
              <MonitorUp size={34} style={{ margin: "0 auto 16px" }} />
              <h2 style={{ margin: "0 0 8px", fontSize: 22 }}>{nativeFirst ? "Open Omarchy desktop" : "Omarchy needs the Hivra Mac app"}</h2>
              <p style={{ margin: 0, color: "#aaa", lineHeight: 1.5 }}>
                {nativeFirst
                  ? "Launch the managed desktop window from the button above. You can minimise it normally, return to it, or stop it from Hivra."
                  : "The current Selkies release cannot capture Omarchy’s existing Hyprland session, so Hivra does not substitute a slow VNC console or a different desktop."}
              </p>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
