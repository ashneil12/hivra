"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { KeyRound, Loader2, RefreshCw } from "lucide-react";
import type { AgentLlmInput } from "@/lib/hivra/agent-api";
import { AgentModelSettingsError, cancelAgentLaunchModel, continueAgentLaunchModel, getAgentModelSettings, resumeAgentModelSettings, setAgentModelSettings,
  type AgentModelSettings as Settings } from "@/lib/hivra/agent-model-settings-api";
import styles from "./AgentModelSettings.module.css";
import { isLocalAuthMode } from "@/lib/self-host/config";

import type { ManageFeedback } from "./ManageLayout";

function description(config: Settings["llm"]) {
  if (!config) return "Native sign-in";
  return `Venice · ${config.mode === "byok" ? "your API key" : "managed gateway"}${config.model ? ` · ${config.model}` : ""}${config.mode === "managed" && config.keyPrefix ? ` · ${config.keyPrefix}…` : ""}`;
}

/** Key this component by agent ID: drafts and in-flight response handlers must
 * never move between computers when the owner switches selection. */
export function AgentModelSettings({ agentId, agentName, ready, disabled, onChanged, onBusyChange, onFeedbackChange }: {
  agentId: string; agentName: string; ready: boolean; disabled: boolean; onChanged: () => void;
  onBusyChange: (busy: boolean) => void;
  onFeedbackChange?: (feedback: ManageFeedback) => void;
}) {
  const allowManaged = !isLocalAuthMode();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeIsError, setNoticeIsError] = useState(false);
  const [upgradeRequired, setUpgradeRequired] = useState(false);
  const [mode, setMode] = useState<"byok" | "managed">("byok");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [wallet, setWallet] = useState<"hermesos" | "card">("hermesos");
  const lifetime = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const refreshEpoch = useRef(0);
  const previousReady = useRef(ready);
  const automaticallyAttempted = useRef(new Set<string>());

  const refresh = useCallback(async (signal: AbortSignal) => {
    const epoch = ++refreshEpoch.current;
    setLoading(true);
    try {
      const value = await getAgentModelSettings(agentId, { signal });
      if (!signal.aborted && epoch === refreshEpoch.current) { setSettings(value); setError(null); }
      return value;
    } catch (cause) {
      if (!signal.aborted && epoch === refreshEpoch.current) { setSettings(null); setError((cause as Error).message); }
      return null;
    } finally { if (!signal.aborted && epoch === refreshEpoch.current) setLoading(false); }
  }, [agentId]);

  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    void refresh(controller.signal);
    return () => { controller.abort(); if (busyRef.current) onBusyChange(false); };
  }, [refresh, onBusyChange]);

  useEffect(() => {
    if (previousReady.current === ready || acting || busyRef.current) return;
    previousReady.current = ready;
    const signal = lifetime.current?.signal;
    if (signal && !signal.aborted) void refresh(signal);
  }, [ready, acting, refresh]);

  const launchAction = useCallback(async (action: "continue" | "cancel", automatic = false) => {
    const signal = lifetime.current?.signal, launch = settings?.launch;
    if (!signal || signal.aborted || busyRef.current || disabled || loading || !launch || settings.pending
      || (action === "continue" && !ready)) return;
    if (automatic) {
      if (launch.state !== "ready_to_apply" || automaticallyAttempted.current.has(launch.requestId)) return;
      // Never replay an uncertain automatic POST, even if a stale read still
      // says ready_to_apply. The server also durably permits only one attempt.
      automaticallyAttempted.current.add(launch.requestId);
    }
    busyRef.current = true; setActing(true); onBusyChange(true); setError(null); setNotice(null); setNoticeIsError(false);
    let message: string | null = null;
    try {
      if (action === "cancel") {
        await cancelAgentLaunchModel(agentId, launch.requestId, { signal });
        message = "Saved launch connection removed. Your computer is kept; use native sign-in when it is ready.";
      } else {
        const result = await continueAgentLaunchModel(agentId, launch.requestId, launch.operationId, automatic, { signal });
        message = result.status === "applied" ? "Setting confirmed on this computer. It applies to new messages."
          : "Setup is not yet confirmed. The saved state below shows what you can do next.";
      }
    } catch (cause) {
      if (!signal.aborted) {
        message = (cause as Error).message;
        setNoticeIsError(true);
        if (cause instanceof AgentModelSettingsError && cause.code === "guest_upgrade_required") setUpgradeRequired(true);
      }
    } finally {
      if (!signal.aborted) {
        setApiKey("");
        await refresh(signal);
        if (!signal.aborted) { setNotice(message); setActing(false); onBusyChange(false); onChanged(); }
      }
      busyRef.current = false;
    }
  }, [agentId, disabled, loading, onBusyChange, onChanged, ready, refresh, settings]);

  useEffect(() => {
    if (ready && !disabled && !loading && !acting && !upgradeRequired && settings?.launch?.state === "ready_to_apply") {
      void launchAction("continue", true);
    }
  }, [ready, disabled, loading, acting, upgradeRequired, settings, launchAction]);

  const change = async (selection: AgentLlmInput | null, resumeId?: string) => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || busyRef.current || disabled || !ready || !settings || loading) return;
    if ((settings.pending || settings.launch) && !resumeId) return;
    busyRef.current = true; setActing(true); onBusyChange(true); setError(null); setNotice(null); setNoticeIsError(false);
    let message: string | null = null;
    try {
      const result = resumeId ? await resumeAgentModelSettings(agentId, resumeId, { signal })
        : await setAgentModelSettings(agentId, crypto.randomUUID(), selection, { signal });
      message = result.status === "applied" ? "Setting confirmed on this computer. It applies to new messages."
        : "The request returned without confirmation. The latest saved state is shown below.";
    } catch (cause) {
      if (!signal.aborted) {
        message = (cause as Error).message;
        setNoticeIsError(true);
        if (cause instanceof AgentModelSettingsError && cause.code === "guest_upgrade_required") setUpgradeRequired(true);
      }
    } finally {
      // Never keep a submitted credential after either success or uncertainty.
      if (!signal.aborted) {
        setApiKey("");
        await refresh(signal);
        if (!signal.aborted) { setNotice(message); setActing(false); onBusyChange(false); onChanged(); }
      }
      busyRef.current = false;
    }
  };

  const pendingModel = Boolean(settings?.pending || settings?.launch);
  useEffect(() => {
    onFeedbackChange?.(error ? { kind: "alert", message: error }
      : acting ? { kind: "status", message: "Applying model settings…" }
        : notice ? { kind: noticeIsError ? "alert" : "status", message: notice }
          : pendingModel ? { kind: "status", message: "A model connection is pending. Review its saved state in Agent settings." } : null);
  }, [error, acting, notice, noticeIsError, pendingModel, onFeedbackChange]);

  const blocked = disabled || !ready || loading || acting || !settings || !!settings.pending || !!settings.launch || upgradeRequired;
  const launch = settings?.launch;
  return <section id="model-settings" className={styles.section} aria-label="Inference settings">
    <h3 className={styles.heading}>Inference</h3>
    <div className={styles.panel}>
      <div className={styles.intro}>
        <KeyRound size={17} aria-hidden="true" />
        <div><h4>Choose how {agentName} connects</h4><p>{allowManaged
          ? "Keep native sign-in, use your own Venice API key, or select Hivra’s metered gateway."
          : "Keep native sign-in or use your own Venice API key."}</p></div>
      </div>
      <div className={styles.current}>
        <div><span className={styles.label}>Saved setting</span><p>{settings ? launch && !settings.llm ? "Launch connection not applied yet" : description(settings.llm) : loading ? "Checking saved settings…" : "Not available"}</p>
          <p className={styles.help}>Hivra’s saved record, not a live inference check.</p></div>
        <button type="button" className={styles.quiet} disabled={loading || acting} onClick={() => {
          const signal = lifetime.current?.signal;
          if (signal && !signal.aborted) { setNotice(null); setUpgradeRequired(false); void refresh(signal); }
        }} aria-label="Refresh model settings"><RefreshCw size={14} aria-hidden="true" />Refresh</button>
      </div>
      {error ? <p role="alert" className={styles.warning}>{error}</p> : null}
      {notice ? <p role="status" className={styles.notice}>{notice}</p> : null}
      <p className={styles.help}>These settings connect Hivra Chat. The native {agentName} interface keeps its own sign-in and configuration.</p>
      {!ready && !launch ? <p className={styles.notice}>Start this computer and let its current operation finish before changing model settings.</p> : null}
      {upgradeRequired ? <p className={styles.warning}>This guest needs the model-settings update. Your current settings and native sign-in have been kept. Updating the dashboard alone does not update an existing computer.</p> : null}
      {launch ? <div className={styles.launch} aria-label="Launch connection">
        <div><span className={styles.label}>Connection chosen at launch</span>
          <p>Venice · {launch.requested.mode === "byok" ? "your API key" : "managed gateway"} · {launch.requested.model}</p>
          {launch.requested.mode === "managed" ? <p className={styles.help}>Pay from: {launch.requested.walletType === "card" ? "card balance" : "token wallet"}.</p> : null}
          <p className={styles.help}>{launch.state === "waiting_for_computer"
            ? "Your choice is saved. Setup can continue when this computer is running. You do not need to launch another computer."
            : launch.state === "setup_requested"
              ? "Setup has been requested, but is not confirmed yet. Refresh to check before continuing."
              : launch.state === "needs_attention"
                ? "The first attempt was not confirmed. Continue the original request using its saved connection."
                : "The computer is ready to apply your saved connection."}</p></div>
        <div className={styles.actions}>
          <button type="button" className={styles.primary}
            disabled={disabled || !ready || acting || loading || upgradeRequired || !!settings.pending || launch.state === "setup_requested"}
            onClick={() => void launchAction("continue")}>
            {acting ? <Loader2 size={14} className={styles.spinner} aria-hidden="true" /> : null}Continue setup
          </button>
          <button type="button" className={styles.quiet} disabled={disabled || acting || loading || !!settings.pending}
            onClick={() => void launchAction("cancel")}>Use native sign-in instead</button>
        </div>
        <p className={styles.help}>Native sign-in removes only this pending model connection. It does not delete the computer.</p>
      </div> : null}
      {settings?.pending ? <div className={styles.pending}>
        <div><span className={styles.label}>Pending change</span><p>{description(settings.pending.requested)}</p>
          <p className={styles.help}>The change has not been fully confirmed. Resuming checks this request and reuses its saved key.</p></div>
        <button type="button" className={styles.primary} disabled={disabled || !ready || acting || loading}
          onClick={() => void change(null, settings.pending!.operationId)}>
          {acting ? <Loader2 size={14} className={styles.spinner} aria-hidden="true" /> : null}Resume change
        </button>
      </div> : null}
      {!launch ? <fieldset disabled={blocked} className={styles.form}>
        <legend className={styles.label}>{settings?.llm ? "Replace your connection" : "Connect a provider"}</legend>
        <div className={styles.choices}>
          <button type="button" aria-pressed={mode === "byok"} onClick={() => setMode("byok")}>My Venice key</button>
          {allowManaged ? <button type="button" aria-pressed={mode === "managed"} onClick={() => { setMode("managed"); setApiKey(""); }}>Managed gateway</button> : null}
        </div>
        {mode === "byok" ? <label className={styles.field}>Venice API key
          <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} autoComplete="off" spellCheck={false}
            maxLength={256} placeholder="Paste your API key" />
        </label> : <label className={styles.field}>Pay from
          <select value={wallet} onChange={e => setWallet(e.target.value as "hermesos" | "card")}>
            <option value="hermesos">Token wallet</option><option value="card">Card balance</option>
          </select>
        </label>}
        <label className={styles.field}><span>Model <span className={styles.help}>(optional)</span></span>
          <input value={model} onChange={e => setModel(e.target.value)} maxLength={64} placeholder="Default: deepseek-v4-pro" spellCheck={false} />
        </label>
        <p className={styles.help}>{mode === "byok"
          ? "Stored encrypted and delivered by Hivra directly to this computer. Your infrastructure key and model API key are separate."
          : `Usage is charged to your ${wallet === "card" ? "card balance" : "token wallet"}. Requests pause when funds run out; we do not switch wallets automatically.`}</p>
        <div className={styles.actions}>
          <button type="button" className={styles.primary} disabled={blocked || (mode === "byok" && !/^[\x21-\x7e]{8,256}$/.test(apiKey.trim()))}
            onClick={() => void change(mode === "byok"
              ? { provider: "venice", mode, apiKey: apiKey.trim(), ...(model.trim() ? { model: model.trim() } : {}) }
              : { provider: "venice", mode, walletType: wallet, ...(model.trim() ? { model: model.trim() } : {}) })}>
            {acting ? <Loader2 size={14} className={styles.spinner} aria-hidden="true" /> : null}Save connection
          </button>
          {settings?.llm ? <button type="button" className={styles.quiet} onClick={() => void change(null)}>Use native sign-in</button> : null}
        </div>
      </fieldset> : null}
    </div>
  </section>;
}
