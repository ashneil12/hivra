"use client";

import { useState } from "react";
import { AlertTriangle, Copy, Check } from "lucide-react";
import { captureClientOpsEvent } from "@/lib/client/ops-events";
import { getLastRequestId } from "@/lib/client/request-id-tracker";
import { getBreadcrumbs } from "@/lib/client/breadcrumbs";
import type { ClientErrorDetail } from "@/lib/client/error-summary";

export interface ErrorBannerContext {
  source?: string;
  route?: string;
  instanceId?: string;
  conversationId?: string;
  profileName?: string;
  metadata?: Record<string, unknown>;
}

/** Agent-supplied structured error metadata. When present, the banner
 *  renders a richer block: a short headline derived from the error code
 *  (so the user sees "Couldn't reach api.openai.com" instead of
 *  "stream not found"), the agent's hint, and the raw error as a small
 *  expandable detail. Absent for stream-level errors that originated in
 *  the SW or Vercel layer rather than the agent. */
export interface AgentErrorDetail {
  code?: string;
  hint?: string;
  upstream?: string;
}

interface ErrorBannerProps {
  error: string | null | undefined;
  context?: ErrorBannerContext;
  agentError?: AgentErrorDetail;
  /**
   * Structured detail about the underlying error, captured at the catch
   * site via summarizeClientError. Surfaces error class / network code /
   * HTTP status / parsed response body (errStage / errClass / errCode /
   * failureType) in the "Copy report" payload so support no longer has to
   * grep server logs to disambiguate the failure.
   */
  errorDetail?: ClientErrorDetail | null;
}

interface RuntimeSnapshot {
  online?: boolean;
  visibility?: string;
  language?: string;
  viewport?: { w: number; h: number };
}

function captureRuntimeSnapshot(): RuntimeSnapshot {
  const snapshot: RuntimeSnapshot = {};
  if (typeof navigator !== "undefined") {
    if (typeof navigator.onLine === "boolean") snapshot.online = navigator.onLine;
    if (typeof navigator.language === "string") snapshot.language = navigator.language;
  }
  if (typeof document !== "undefined" && typeof document.visibilityState === "string") {
    snapshot.visibility = document.visibilityState;
  }
  if (typeof window !== "undefined") {
    snapshot.viewport = { w: window.innerWidth, h: window.innerHeight };
  }
  return snapshot;
}

function buildReportPayload(
  error: string,
  context: ErrorBannerContext | undefined,
  agentError: AgentErrorDetail | undefined,
  errorDetail: ClientErrorDetail | null | undefined,
) {
  const breadcrumbs = getBreadcrumbs();
  return {
    error,
    ...(agentError?.code ? { errorCode: agentError.code } : {}),
    ...(agentError?.upstream ? { errorUpstream: agentError.upstream } : {}),
    ...(errorDetail ? { errorDetail } : {}),
    requestId: getLastRequestId(),
    route: context?.route,
    instanceId: context?.instanceId,
    conversationId: context?.conversationId,
    profileName: context?.profileName,
    url: typeof window !== "undefined" ? window.location.pathname : undefined,
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
    ts: new Date().toISOString(),
    runtime: captureRuntimeSnapshot(),
    ...(breadcrumbs.length > 0 ? { breadcrumbs } : {}),
    ...(context?.metadata ? { metadata: context.metadata } : {}),
  };
}

// Maps an agent error code to a human headline. Anything not in this map
// just shows the raw error string — the goal is to upgrade common cases
// (DNS, auth, quota) without locking in a closed list. Keep in sync with
// hermes-webui/api/streaming.py classifications (_err_type / _exc_type).
const AGENT_CODE_HEADLINES: Record<string, (upstream?: string) => string> = {
  agent_outbound_unreachable: (upstream) =>
    upstream
      ? `Agent couldn't reach ${upstream}`
      : "Agent couldn't reach the model API",
  quota_exhausted: () => "Out of credits",
  auth_mismatch: () => "Authentication failed",
  rate_limit: () => "Rate limit reached",
  model_not_found: () => "Model not found",
  no_response: () => "No response from model",
};

function headlineForAgentError(detail: AgentErrorDetail | undefined): string | null {
  if (!detail?.code) return null;
  const fn = AGENT_CODE_HEADLINES[detail.code];
  return fn ? fn(detail.upstream) : null;
}

export function ErrorBanner({ error, context, agentError, errorDetail }: ErrorBannerProps) {
  const [copied, setCopied] = useState(false);

  if (!error) return null;

  const headline = headlineForAgentError(agentError);

  const handleCopy = async () => {
    const payload = buildReportPayload(error, context, agentError, errorDetail);
    const text = JSON.stringify(payload, null, 2);

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
    } catch {
      // Clipboard can fail under permissions / non-secure context.
      // Server-side capture below still runs so support has the data.
    }

    setCopied(true);
    setTimeout(() => setCopied(false), 1500);

    void captureClientOpsEvent({
      source: context?.source || "client.diagnostic",
      severity: "error",
      title: "User-reported error (Copy report clicked)",
      message: error,
      route: context?.route,
      instanceId: context?.instanceId,
      conversationId: context?.conversationId,
      profileName: context?.profileName,
      metadata: { ...payload, ...(agentError ? { agentError } : {}) },
    });
  };

  return (
    <div
      style={{
        backgroundColor: "rgba(239,68,68,0.08)",
        border: "1px solid rgba(239,68,68,0.25)",
        padding: "12px 16px",
        borderRadius: 0,
        display: "flex",
        flexWrap: "wrap",
        gap: 10,
        color: "var(--red)",
        alignItems: "flex-start",
      }}
    >
      <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
      {/* The button wraps below the message on narrow screens instead of
          squeezing it into a sliver beside it. */}
      <div style={{ fontSize: 13, lineHeight: 1.5, flex: "1 1 220px", minWidth: 0, wordBreak: "break-word" }}>
        {headline ? (
          <>
            <div style={{ fontWeight: 600 }}>{headline}</div>
            {agentError?.hint && (
              <div style={{ marginTop: 4, opacity: 0.85 }}>{agentError.hint}</div>
            )}
            <details style={{ fontSize: 11, opacity: 0.7 }}>
              {/* Default list-item display keeps the disclosure marker; padding makes a 40px target. */}
              <summary style={{ cursor: "pointer", padding: "12px 0" }}>Details</summary>
              <div style={{ marginTop: 4, fontFamily: "var(--font-mono), monospace" }}>
                {error}
                {agentError?.code && (
                  <div style={{ marginTop: 2 }}>code: {agentError.code}</div>
                )}
              </div>
            </details>
          </>
        ) : (
          <span>{error}</span>
        )}
      </div>
      <button
        type="button"
        onClick={handleCopy}
        title="Copy a diagnostic report you can paste to support"
        style={{
          flexShrink: 0,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          minHeight: 40,
          marginLeft: "auto",
          padding: "8px 12px",
          fontSize: 11,
          fontFamily: "var(--font-mono), monospace",
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          fontWeight: 700,
          color: "var(--red)",
          background: "transparent",
          border: "1px solid rgba(239,68,68,0.4)",
          cursor: "pointer",
          borderRadius: 0,
        }}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
        {copied ? "Copied" : "Copy report for support"}
      </button>
    </div>
  );
}
