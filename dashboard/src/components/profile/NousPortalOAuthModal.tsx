import { useCallback, useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import posthog from "posthog-js";
import { X, Sparkles, Loader2, ExternalLink, Copy, CheckCircle2, AlertTriangle } from "lucide-react";
import { SafePortal } from "@/components/ui/SafePortal";
import { copyTextToClipboard } from "@/lib/client/clipboard";
import { verifyNousPortalConnection } from "@/lib/nous-oauth";
import {
  buildHermesOverlayVariants,
  buildHermesSurfaceSpring,
  buildHermesSurfaceVariants,
} from "@/components/ui/motion";

// Defensive cap on device-code polling. The Nous Portal sets its own
// expiry via session.expires_in, but if that's missing or excessively
// large we still want a hard ceiling so a forgotten tab doesn't poll
// forever. Matches the Codex modal's 12-min cap.
const NOUS_OAUTH_POLL_TIMEOUT_MS = 12 * 60 * 1000;

const nousAttemptByInstanceId = new Map<string, number>();

function captureOauthEvent(
  event: "provider_oauth_started" | "provider_oauth_completed" | "provider_oauth_failed",
  properties: Record<string, unknown>,
): void {
  try {
    posthog.capture(event, properties);
  } catch {
    // never let telemetry break the OAuth flow
  }
}

const nousOauthBaseProperties = (instanceId: string) => ({
  provider: "nous",
  instance_id: instanceId,
  flow_type: "device_code",
});

function classifyNousProviderFailure(message?: string | null): "cancelled" | "provider_error" {
  const normalized = (message || "").toLowerCase();
  if (
    normalized.includes("access_denied") ||
    normalized.includes("cancel") ||
    normalized.includes("denied")
  ) {
    return "cancelled";
  }
  return "provider_error";
}

type DeviceCodeSession = {
  session_id: string;
  user_code: string;
  verification_url: string;
  poll_interval?: number;
  expires_in?: number;
};

interface NousPortalOAuthModalProps {
  instanceId: string;
  onClose: () => void;
  onSuccess?: () => void;
  autoStart?: boolean;
}

type ConnectStep = "idle" | "starting" | "waiting" | "finalizing" | "success" | "error";

export function NousPortalOAuthModal({
  instanceId,
  onClose,
  onSuccess,
  autoStart = false,
}: NousPortalOAuthModalProps) {
  const [connectStep, setConnectStep] = useState<ConnectStep>("idle");
  const [connectError, setConnectError] = useState("");
  const [session, setSession] = useState<DeviceCodeSession | null>(null);
  const [urlCopied, setUrlCopied] = useState(false);
  const [openFallbackVisible, setOpenFallbackVisible] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const expiryRef = useRef<number | null>(null);
  const successTimerRef = useRef<number | null>(null);
  const urlCopyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollRequestInFlightRef = useRef(false);
  const finalizingRef = useRef(false);
  const oauthStartedAtRef = useRef<number | null>(null);
  const reduceMotion = useReducedMotion();
  const overlayVariants = buildHermesOverlayVariants(Boolean(reduceMotion));
  const modalVariants = buildHermesSurfaceVariants(Boolean(reduceMotion), {
    offset: 18,
    scale: 0.985,
    spring: "panel",
  });
  const buttonSpring = buildHermesSurfaceSpring(Boolean(reduceMotion), "dock");
  const tapScale = reduceMotion ? undefined : { scale: 0.97 };

  const clearPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const clearExpiry = useCallback(() => {
    if (expiryRef.current !== null) {
      window.clearTimeout(expiryRef.current);
      expiryRef.current = null;
    }
  }, []);

  const clearSuccessTimer = useCallback(() => {
    if (successTimerRef.current !== null) {
      window.clearTimeout(successTimerRef.current);
      successTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearPolling();
      clearExpiry();
      clearSuccessTimer();
      if (urlCopyResetTimerRef.current) clearTimeout(urlCopyResetTimerRef.current);
    };
  }, [clearExpiry, clearPolling, clearSuccessTimer]);

  const handleClose = useCallback(() => {
    clearSuccessTimer();
    onClose();
  }, [clearSuccessTimer, onClose]);

  const handleUrlCopy = useCallback(async () => {
    if (!session?.verification_url) return;
    const didCopy = await copyTextToClipboard(session.verification_url);
    if (!didCopy) return;
    setUrlCopied(true);
    if (urlCopyResetTimerRef.current) clearTimeout(urlCopyResetTimerRef.current);
    urlCopyResetTimerRef.current = setTimeout(() => {
      setUrlCopied(false);
      urlCopyResetTimerRef.current = null;
    }, 2000);
  }, [session?.verification_url]);

  const handleOpenInNewTab = useCallback(() => {
    if (!session?.verification_url) return;
    const win = typeof window !== "undefined"
      ? window.open(session.verification_url, "_blank", "noopener,noreferrer")
      : null;
    // With noopener/noreferrer, some browsers return null even when they
    // successfully opened the tab. Treat null as "unknown" and show a neutral
    // copy fallback instead of counting a false provider_oauth_failed event.
    setOpenFallbackVisible(!win);
  }, [session?.verification_url]);

  const pollSession = useCallback(
    (sessionId: string, intervalSeconds: number) => {
      clearPolling();
      const pollStartedAt = Date.now();
      pollRef.current = setInterval(async () => {
        if (pollRequestInFlightRef.current || finalizingRef.current) {
          return;
        }

        // 12-min defensive cap, in case session.expires_in was missing or
        // larger than the user's patience. Matches the Codex modal.
        if (Date.now() - pollStartedAt > NOUS_OAUTH_POLL_TIMEOUT_MS) {
          clearPolling();
          clearExpiry();
          finalizingRef.current = false;
          setConnectStep("error");
          setSession(null);
          setConnectError("Nous Portal authorization code expired — try starting again.");
          captureOauthEvent("provider_oauth_failed", {
            ...nousOauthBaseProperties(instanceId),
            failure_reason: "code_expired",
            failure_stage: "poll",
            failure_category: "cancelled",
            retryable: true,
          });
          return;
        }

        pollRequestInFlightRef.current = true;

        try {
          const response = await fetch(
            `/api/instances/${instanceId}/oauth/providers/nous/poll/${encodeURIComponent(sessionId)}`
          );
          const payload = await response.json();
          if (!response.ok || !payload.success) {
            throw new Error(payload.error || "Failed to poll Nous Portal login");
          }

          const data = payload.data as { status?: string; error_message?: string | null };
          if (data?.status === "approved") {
            finalizingRef.current = true;
            clearPolling();
            setConnectStep("finalizing");
            await verifyNousPortalConnection({
              readProviderCatalog: async () => {
                const providerResponse = await fetch(`/api/instances/${instanceId}/oauth/providers`);
                const providerPayload = await providerResponse.json();
                return {
                  ok: providerResponse.ok,
                  payload: providerPayload,
                };
              },
              readSavedSessionStatus: async () => {
                const statusResponse = await fetch(`/api/instances/${instanceId}/oauth/providers/nous/status`);
                const statusPayload = await statusResponse.json();
                return {
                  ok: statusResponse.ok,
                  payload: statusPayload,
                };
              },
            });
            clearExpiry();
            finalizingRef.current = false;
            setConnectStep("success");
            setSession(null);
            captureOauthEvent("provider_oauth_completed", {
              ...nousOauthBaseProperties(instanceId),
              time_to_complete_ms: oauthStartedAtRef.current
                ? Date.now() - oauthStartedAtRef.current
                : null,
            });
            clearSuccessTimer();
            successTimerRef.current = window.setTimeout(() => {
              successTimerRef.current = null;
              if (onSuccess) onSuccess();
              onClose();
            }, 2500);
          } else if (data?.status === "error") {
            clearPolling();
            clearExpiry();
            finalizingRef.current = false;
            setConnectStep("error");
            setSession(null);
            setConnectError(data.error_message || "Nous Portal login failed");
            captureOauthEvent("provider_oauth_failed", {
              ...nousOauthBaseProperties(instanceId),
              failure_reason: "device_status_error",
              failure_stage: "provider_callback",
              failure_category: classifyNousProviderFailure(data.error_message),
              provider_status: "error",
              retryable: true,
            });
          }
        } catch (error) {
          const wasFinalizing = finalizingRef.current;
          clearPolling();
          clearExpiry();
          finalizingRef.current = false;
          setConnectStep("error");
          setSession(null);
          setConnectError(error instanceof Error ? error.message : String(error));
          captureOauthEvent("provider_oauth_failed", {
            ...nousOauthBaseProperties(instanceId),
            failure_reason: "poll_exception",
            failure_stage: wasFinalizing ? "verify" : "poll",
            failure_category: wasFinalizing ? "app_error" : "callback_error",
            retryable: true,
          });
        } finally {
          pollRequestInFlightRef.current = false;
        }
      }, Math.max(3000, intervalSeconds * 1000));
    },
    [clearExpiry, clearPolling, clearSuccessTimer, instanceId, onClose, onSuccess]
  );

  const handleStart = useCallback(async () => {
    clearPolling();
    clearExpiry();
    pollRequestInFlightRef.current = false;
    finalizingRef.current = false;
    setConnectStep("starting");
    setConnectError("");
    setOpenFallbackVisible(false);

    const previousAttempts = nousAttemptByInstanceId.get(instanceId) ?? 0;
    const attemptNumber = previousAttempts + 1;
    nousAttemptByInstanceId.set(instanceId, attemptNumber);
    oauthStartedAtRef.current = Date.now();
    captureOauthEvent("provider_oauth_started", {
      ...nousOauthBaseProperties(instanceId),
      attempt_number: attemptNumber,
    });

    try {
      const response = await fetch(`/api/instances/${instanceId}/oauth/providers/nous/start`, {
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || "Failed to start Nous Portal login");
      }

      const data = payload.data as DeviceCodeSession;
      setSession(data);
      setConnectStep("waiting");
      if (data.expires_in && data.expires_in > 0) {
        expiryRef.current = window.setTimeout(() => {
          clearPolling();
          clearExpiry();
          setSession(null);
          setConnectStep("error");
          setConnectError("Nous Portal login expired. Start a new login session.");
          captureOauthEvent("provider_oauth_failed", {
            ...nousOauthBaseProperties(instanceId),
            failure_reason: "session_expired",
            failure_stage: "poll",
            failure_category: "cancelled",
            retryable: true,
          });
        }, data.expires_in * 1000);
      }
      pollSession(data.session_id, data.poll_interval || 5);
    } catch (error) {
      clearExpiry();
      setConnectStep("error");
      setSession(null);
      setConnectError(error instanceof Error ? error.message : String(error));
      captureOauthEvent("provider_oauth_failed", {
        ...nousOauthBaseProperties(instanceId),
        failure_reason: "start_exception",
        failure_stage: "start",
        failure_category: "app_error",
        retryable: true,
      });
    }
  }, [clearExpiry, clearPolling, instanceId, pollSession]);

  useEffect(() => {
    if (autoStart && connectStep === "idle" && !session && !connectError) {
      void handleStart();
    }
  }, [autoStart, connectError, connectStep, handleStart, session]);

  const modalContent = (
    <motion.div
      initial="hidden"
      animate="visible"
      exit="exit"
      variants={overlayVariants}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.4)",
        backdropFilter: "blur(4px)",
        padding: 20,
      }}
    >
      <motion.div
        initial="hidden"
        animate="visible"
        exit="exit"
        variants={modalVariants}
        style={{
          width: "100%",
          maxWidth: 560,
          background: "var(--bg-surface)",
          border: "1px solid var(--ink-black)",
          borderRadius: 0,
          boxShadow: "8px 8px 0px var(--ink-black)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 20px",
            borderBottom: "1px solid var(--etched-border)",
            background: "var(--vellum-bg)",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Sparkles size={18} style={{ color: "var(--ink-black)" }} />
            <h2 style={{ fontSize: 15, fontWeight: 700, color: "var(--ink-black)", margin: 0 }}>
              Connect Nous Portal
            </h2>
          </div>
          <motion.button
            onClick={handleClose}
            style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--text-muted)" }}
            whileTap={tapScale}
            transition={buttonSpring}
          >
            <X size={18} />
          </motion.button>
        </div>

        <div style={{ padding: "24px", display: "flex", flexDirection: "column", gap: 16 }}>
          {connectStep === "idle" && (
            <>
              <div
                style={{
                  padding: "16px",
                  background: "var(--vellum-bg)",
                  border: "1px solid var(--etched-border)",
                  fontSize: 13,
                  color: "var(--text-secondary)",
                  lineHeight: 1.55,
                }}
              >
                <strong style={{ color: "var(--ink-black)", display: "block", marginBottom: 6 }}>
                  Finish enabling your Nous-backed tools
                </strong>
                This agent already has the Tool Gateway flags you selected during deploy. Connect your paid Nous Portal
                session now to activate web, browser, image generation, or TTS routing without separate vendor keys,
                while saving a reusable encrypted session into Vault for later Nous deployments.
              </div>
              <motion.button
                onClick={handleStart}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  padding: "10px 18px",
                  background: "var(--ink-black)",
                  border: "none",
                  borderRadius: 0,
                  color: "var(--bg-surface)",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                  width: "100%",
                }}
                whileTap={tapScale}
                transition={buttonSpring}
              >
                <Sparkles size={14} /> Connect Nous Portal
              </motion.button>
            </>
          )}

          {connectStep === "starting" && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "24px 0" }}>
              <Loader2 size={28} style={{ animation: "spin 1s linear infinite", color: "var(--ink-black)" }} />
              <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0, textAlign: "center" }}>
                Connecting to the live agent to begin Nous Portal login…
              </p>
            </div>
          )}

          {connectStep === "waiting" && session && (
            <>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                  padding: "16px",
                  background: "var(--vellum-bg)",
                  border: "1px solid var(--etched-border)",
                }}
              >
                <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0, lineHeight: 1.6 }}>
                  Finish the sign-in in your browser. Hermes will keep watching and connect the tool gateway
                  automatically as soon as Nous Portal approves it.
                </p>
                {/* Both buttons visible from t=0 — no delays, no disclosure. */}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <motion.button
                    onClick={handleOpenInNewTab}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "10px 16px",
                      background: "var(--ink-black)",
                      border: "none",
                      color: "var(--bg-surface)",
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                    whileTap={tapScale}
                    transition={buttonSpring}
                  >
                    <ExternalLink size={14} /> Open Nous Portal
                  </motion.button>
                  <motion.button
                    onClick={handleUrlCopy}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "10px 16px",
                      background: "transparent",
                      border: "1px solid var(--ink-black)",
                      color: urlCopied ? "var(--green)" : "var(--ink-black)",
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                    whileTap={tapScale}
                    transition={buttonSpring}
                  >
                    <Copy size={14} /> {urlCopied ? "Copied!" : "Copy URL"}
                  </motion.button>
                </div>
                {openFallbackVisible && (
                  <div style={{ padding: "8px 10px", background: "rgba(0,0,0,0.02)", border: "1px solid var(--etched-border)", color: "var(--text-secondary)", fontSize: 12, lineHeight: 1.5 }}>
                    If the Nous Portal page did not open, use <strong>Copy URL</strong> and paste it into a new tab.
                  </div>
                )}
                <code style={{ display: "block", fontSize: 11, color: "var(--text-secondary)", wordBreak: "break-all", fontFamily: "var(--font-mono), monospace", userSelect: "all" }}>
                  {session.verification_url}
                </code>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "10px 12px",
                    background: "rgba(0,0,0,0.02)",
                    border: "1px solid var(--etched-border)",
                    fontSize: 12,
                    color: "var(--text-muted)",
                  }}
                >
                  <Loader2 size={13} style={{ animation: "spin 1s linear infinite", flexShrink: 0 }} />
                  Waiting for approval…
                </div>
                <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
                  The portal usually pre-fills the code for you. If it asks for one manually, use{" "}
                  <span style={{ fontFamily: "var(--font-mono), monospace", fontWeight: 700, color: "var(--ink-black)" }}>
                    {session.user_code}
                  </span>
                  .
                </p>
              </div>
            </>
          )}

          {connectStep === "finalizing" && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "24px 0" }}>
              <Loader2 size={28} style={{ animation: "spin 1s linear infinite", color: "var(--ink-black)" }} />
              <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0, textAlign: "center", maxWidth: 360 }}>
                Nous Portal approved the login. Hermes is saving your reusable session and verifying the connection…
              </p>
            </div>
          )}

          {connectStep === "success" && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "24px 0" }}>
              <CheckCircle2 size={40} style={{ color: "var(--green)" }} />
              <div style={{ fontSize: 15, fontWeight: 600, color: "var(--ink-black)" }}>Nous Portal Connected</div>
              <p style={{ fontSize: 13, color: "var(--text-secondary)", textAlign: "center", maxWidth: 340, margin: 0 }}>
                Hermes accepted your Nous Portal login and your gateway-backed tools are ready to use.
              </p>
            </div>
          )}

          {connectStep === "error" && (
            <>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "10px 12px",
                  background: "rgba(239,68,68,0.05)",
                  border: "1px solid rgba(239,68,68,0.25)",
                  color: "var(--red)",
                  fontSize: 13,
                }}
              >
                <AlertTriangle size={14} style={{ flexShrink: 0 }} />
                <span>{connectError}</span>
              </div>
              <motion.button
                onClick={() => {
                  setConnectStep("idle");
                  setConnectError("");
                }}
                style={{
                  padding: "8px 16px",
                  background: "transparent",
                  border: "1px solid var(--ink-black)",
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: "pointer",
                  color: "var(--ink-black)",
                }}
                whileTap={tapScale}
                transition={buttonSpring}
              >
                Try Again
              </motion.button>
            </>
          )}
        </div>
      </motion.div>
    </motion.div>
  );

  return <SafePortal>{modalContent}</SafePortal>;
}
