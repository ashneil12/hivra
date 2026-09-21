"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import {
  confirmProviderResize,
  getProviderResizeState,
  ProviderResizeApiError,
  reviewProviderResize,
  type HivraAgent,
} from "@/lib/hivra/agent-api";
import {
  type ProviderResizeCatalog,
  type ProviderResizeOperationView,
  type ProviderResizeQuote,
} from "@/lib/hivra/provider-agent-resize-contract";

import type { ManageFeedback } from "./ManageLayout";

const label: React.CSSProperties = {
  fontFamily: "var(--font-mono), monospace", fontSize: 10, fontWeight: 700,
  textTransform: "uppercase", letterSpacing: "0.16em", color: "var(--text-muted)",
};
const card: React.CSSProperties = {
  border: "1px solid var(--etched-border)", background: "rgba(255,255,255,0.035)",
  padding: 18, display: "grid", gap: 14, boxSizing: "border-box", minWidth: 0,
  gridTemplateColumns: "minmax(0, 1fr)", marginBottom: 20,
};
const button: React.CSSProperties = {
  border: "1px solid var(--ink-black)", background: "var(--ink-black)", color: "var(--bg-surface)",
  fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 800,
  padding: "9px 14px", display: "inline-flex", alignItems: "center", gap: 7,
};
const ghost: React.CSSProperties = { ...button, border: "1px solid var(--etched-border)", background: "transparent", color: "var(--ink-black)" };

function compactPrice(value: string): string {
  const [whole, fraction = ""] = value.split(".");
  // Remove provider padding only: preserve every meaningful quoted digit.
  return `${whole}.${fraction.replace(/0+$/, "").padEnd(2, "0")}`;
}

function serverPlanPrice(size: ProviderResizeQuote["source"]): string {
  return `${size.price.currency} ${compactPrice(size.price.monthlyGross)}/month · ${size.price.currency} ${compactPrice(size.price.hourlyGross)}/hour`;
}

function operationNeedsObservation(operation: ProviderResizeOperationView): boolean {
  return ["request_uncertain", "action_pending", "provider_pending"].includes(operation.stage);
}

export function ProviderResizePanel({ agent, onChanged, onFeedbackChange }: { agent: HivraAgent; onChanged: () => void; onFeedbackChange?: (feedback: ManageFeedback) => void }) {
  const [catalog, setCatalog] = useState<ProviderResizeCatalog | null>(null);
  const [operation, setOperation] = useState<ProviderResizeOperationView | null>(null);
  const [quote, setQuote] = useState<ProviderResizeQuote | null>(null);
  const [target, setTarget] = useState("");
  const [requestId, setRequestId] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const completed = useRef<string | null>(null);
  const shutdownContinuation = useRef<string | null>(null);
  const targetRef = useRef("");

  const load = useCallback(async () => {
    try {
      const state = await getProviderResizeState(agent.id);
      setCatalog(state.catalog);
      setOperation(state.operation);
      setUnsupported(false);
      setError(null);
      if (state.operation?.shutdownRequired && shutdownContinuation.current !== state.operation.operationId) {
        // Resume only this persisted, already-confirmed operation. A failed
        // response is not automatically retried, and the server owns dispatch.
        shutdownContinuation.current = state.operation.operationId;
        setBusy(true);
        try {
          const continued = await confirmProviderResize({ agentId: agent.id,
            operationId: state.operation.operationId,
            quoteFingerprint: state.operation.quote.quoteFingerprint });
          setOperation(continued);
          if (continued.shutdownReadinessWaiting === true) {
            // The server explicitly confirms no shutdown marker was consumed.
            // A later ready observation may continue; unknown POSTs never retry.
            shutdownContinuation.current = null;
          }
          if (continued.stage === "succeeded") onChanged();
        } finally { setBusy(false); }
      }
      if (state.catalog) {
        const nextTarget = state.catalog.offers.some((offer) => offer.serverType === targetRef.current)
          ? targetRef.current
          : state.catalog.offers[0]?.serverType ?? "";
        if (nextTarget !== targetRef.current) {
          targetRef.current = nextTarget;
          setTarget(nextTarget);
          setQuote(null);
          setRequestId(null);
          setConfirmed(false);
        }
      }
      if (state.operation?.stage === "succeeded" && completed.current !== state.operation.operationId) {
        completed.current = state.operation.operationId;
        onChanged();
      }
    } catch (cause) {
      if (cause instanceof ProviderResizeApiError && ["not_found", "not_supported"].includes(String(cause.code))) {
        setUnsupported(true);
        setCatalog(null);
        setOperation(null);
        return;
      }
      setError(cause instanceof Error ? cause.message : "Could not check Hetzner resize options.");
    } finally {
      setLoading(false);
    }
  }, [agent.id, onChanged]);

  useEffect(() => {
    void load();
  }, [load, agent.status, agent.resize_stage]);

  useEffect(() => {
    if (!operation || !operationNeedsObservation(operation)) return;
    const timer = window.setTimeout(() => void load(), 4_000);
    return () => window.clearTimeout(timer);
  }, [operation, load]);

  useEffect(() => {
    if (!quote) return;
    let timer: number | undefined;
    const expireAt = Date.parse(quote.expiresAt);
    const checkExpiry = () => {
      const remaining = expireAt - Date.now();
      if (remaining <= 0) {
        setQuote((current) => current?.operationId === quote.operationId ? null : current);
        setRequestId((current) => current === quote.operationId ? null : current);
        setConfirmed(false);
        setError("That Hetzner server-plan price review expired. Review the current price and downtime again.");
        return;
      }
      timer = window.setTimeout(checkExpiry, Math.min(remaining + 25, 30_000));
    };
    checkExpiry();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [quote]);

  const selectTarget = (value: string) => {
    targetRef.current = value;
    setTarget(value);
    setQuote(null);
    setRequestId(null);
    setConfirmed(false);
    setError(null);
  };

  const review = async () => {
    if (!target || busy) return;
    const stableId = requestId ?? crypto.randomUUID();
    setRequestId(stableId);
    setBusy(true);
    setError(null);
    try {
      const reviewed = await reviewProviderResize({ agentId: agent.id, operationId: stableId, targetServerType: target });
      if (Date.now() >= Date.parse(reviewed.expiresAt)) {
        setRequestId(null);
        setQuote(null);
        setError("That Hetzner server-plan price review expired. Review the current price and downtime again.");
        return;
      }
      setQuote(reviewed);
      setConfirmed(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not review this Hetzner resize.");
    } finally { setBusy(false); }
  };

  const apply = async (saved: ProviderResizeQuote) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await confirmProviderResize({
        agentId: agent.id,
        operationId: saved.operationId,
        quoteFingerprint: saved.quoteFingerprint,
      });
      setOperation(result);
      setCatalog(null);
      setQuote(null);
      // Refresh the parent lifecycle immediately, including the active lease:
      // a saved resize must not leave a stale Stopped header/Start control.
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The saved Hetzner resize could not be confirmed.");
    } finally { setBusy(false); }
  };

  const feedbackStage = operation?.stage;
  const feedbackMessage = operation?.message;
  useEffect(() => {
    onFeedbackChange?.(unsupported ? null : error ? { kind: "alert", message: error }
      : busy ? { kind: "status", message: "Checking the saved server-plan change…" }
        : feedbackStage && feedbackMessage ? { kind: ["failed", "manual_attention", "request_uncertain"].includes(feedbackStage) ? "alert" : "status", message: feedbackMessage } : null);
  }, [unsupported, error, busy, feedbackStage, feedbackMessage, onFeedbackChange]);

  if (loading || unsupported) return null;

  return (
    <>
      <div className="mono" style={{ ...label, marginBottom: 10 }}>Resize</div>
      <div style={card} data-testid="provider-resize-panel">
        {error ? <div role="alert" style={{ border: "1px solid #c0392b", padding: "10px 12px", fontSize: 12, lineHeight: 1.5 }}>{error}</div> : null}
        {operation ? (
          <>
            <div>
              <div className="serif" style={{ fontSize: 17 }}>Hetzner resize</div>
              <div role={["failed", "manual_attention", "request_uncertain"].includes(operation.stage) ? "alert" : "status"}
                style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6, marginTop: 5 }}>
                {operation.message}
              </div>
            </div>
            <div className="mono" style={{ fontSize: 11 }}>
              {operation.quote.source.serverType} → {operation.quote.target.serverType} · existing {operation.quote.existingDiskGb} GB disk retained
            </div>
            {operation.stage === "dispatch_pending" || operation.shutdownRequired ? (
              <button type="button" disabled={busy} onClick={() => void apply(operation.quote)} style={{ ...button, width: "fit-content", opacity: busy ? 0.6 : 1 }}>
                {busy ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> : null} Continue saved resize
              </button>
            ) : null}
            {["manual_attention", "request_uncertain", "action_pending", "provider_pending"].includes(operation.stage) ? (
              <button type="button" disabled={busy} onClick={() => void load()} style={{ ...ghost, width: "fit-content", opacity: busy ? 0.6 : 1 }}>
                <RefreshCw size={13} /> Check Hetzner status
              </button>
            ) : null}
            {["succeeded", "failed", "cancelled"].includes(operation.stage) ? (
              <button type="button" disabled={busy} onClick={() => void load()} style={{ ...ghost, width: "fit-content" }}>
                <RefreshCw size={13} /> Review current server
              </button>
            ) : null}
          </>
        ) : catalog ? (
          <>
            <div>
              <div className="serif" style={{ fontSize: 17 }}>Current Hetzner server</div>
              <div className="mono" style={{ fontSize: 11.5, marginTop: 5 }}>
                {catalog.current.serverType} · {catalog.current.cores} CPU · {catalog.current.memoryGb} GB RAM · {catalog.existingDiskGb} GB existing disk
              </div>
            </div>
            {catalog.providerPowerState !== "off" || agent.status !== "stopped" ? (
              <div role="status" style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
                Stop this computer first. Hetzner requires downtime for a server-type resize, and Hivra leaves it stopped afterward for review. Provider billing continues while it is powered off.
              </div>
            ) : catalog.providerLocked ? (
              <div role="alert" style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
                Hetzner currently reports this server as locked. No resize request can be sent until that clears.
              </div>
            ) : catalog.offers.length === 0 ? (
              <div role="status" style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
                Hetzner has no compatible same-architecture server type available in {catalog.location} right now.
              </div>
            ) : (
              <>
                <label style={{ display: "grid", gap: 6, fontSize: 11 }}>
                  <span className="mono" style={label}>Server type</span>
                  <select value={target} onChange={(event) => selectTarget(event.target.value)}
                    style={{ padding: "9px 10px", border: "1px solid var(--etched-border)", background: "var(--bg-surface)", color: "var(--ink-black)" }}>
                    {catalog.offers.map((offer) => <option value={offer.serverType} key={offer.serverType}>
                      {offer.serverType} · {offer.cores} CPU · {offer.memoryGb} GB · {offer.price.currency} {compactPrice(offer.price.monthlyGross)}/month server plan
                    </option>)}
                  </select>
                </label>
                {!quote ? <button type="button" disabled={!target || busy} onClick={() => void review()} style={{ ...button, width: "fit-content", opacity: busy ? 0.6 : 1 }}>
                  {busy ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> : null} Review price &amp; downtime
                </button> : (
                  <div style={{ border: "1px solid var(--etched-border)", padding: 14, display: "grid", gap: 11 }}>
                    <div className="serif" style={{ fontSize: 16 }}>Review Hetzner billing and downtime</div>
                    <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                      <div>Current server-plan price: {quote.source.serverType} · {serverPlanPrice(quote.source)}</div>
                      <div>New server-plan price: {quote.target.serverType} · {serverPlanPrice(quote.target)}</div>
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
                      These figures are for the server plan only. Your existing IPv4 and other separately billed Hetzner resources are excluded here and keep their separate charges. Confirming changes your Hetzner server-plan billing. The computer stays powered off during the change and remains stopped afterward. Its existing {quote.existingDiskGb} GB disk is retained exactly as-is; Hivra does not enlarge it, so a later compatible downgrade remains possible.
                    </div>
                    <label style={{ display: "flex", gap: 9, alignItems: "flex-start", fontSize: 12, lineHeight: 1.5 }}>
                      <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
                      I accept the new Hetzner billing and required downtime for this exact server type.
                    </label>
                    <button type="button" disabled={!confirmed || busy}
                      onClick={() => void apply(quote)} style={{ ...button, width: "fit-content", opacity: !confirmed || busy ? 0.5 : 1 }}>
                      {busy ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> : null} Resize on Hetzner
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        ) : null}
      </div>
    </>
  );
}
