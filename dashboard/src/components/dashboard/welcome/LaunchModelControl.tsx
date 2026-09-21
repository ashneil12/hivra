"use client";

import { KeyRound, Loader2 } from "lucide-react";
import type { useModelLaunch } from "./useModelLaunch";
import styles from "./LaunchModelControl.module.css";

export type LaunchModelDraft = { mode: "native" | "byok" | "managed"; apiKey: string; model: string; walletType: "card" | "hermesos" };
export function LaunchModelControl({ draft, onChange, launch, disabled, supported, allowManaged = true, onOpen, onReview }: {
  draft: LaunchModelDraft; onChange: (draft: LaunchModelDraft) => void;
  launch: ReturnType<typeof useModelLaunch>; disabled: boolean; supported: boolean;
  allowManaged?: boolean;
  onOpen: (id: string) => void;
  onReview: () => void;
}) {
  const selection = launch.editing ? null : launch.saved?.intent.llm;
  const mode = selection?.mode ?? draft.mode;
  const locked = disabled || (Boolean(launch.saved) && !launch.editing);
  return <section className={styles.panel} aria-label="Model connection">
    <div className={styles.intro}><KeyRound size={18} aria-hidden="true" /><div>
      <h4>How should Codex connect?</h4>
      <p>Your model account and your computer are separate choices.</p>
    </div></div>
    {launch.saved ? <div className={styles.recovery}>
      <h4>{launch.agent ? launch.agent.status === "deleted" ? "Original computer removed" : "Your original computer is saved" : "Keep this launch together"}</h4>
      <p>{launch.agent?.name ?? launch.saved.intent.name} · {launch.agent
        ? `${launch.agent.cpu} CPU / ${launch.agent.ram} GB`
        : launch.saved.intent.deployment.mode === "self-managed" ? "Using your selected infrastructure" : `${launch.saved.intent.cpu} CPU / ${launch.saved.intent.ram} GB`}</p>
      <p>{launch.agent ? "Checking this request never starts another computer. Start another only when you want a separate launch."
        : "A lost response is not a failed launch. Check the original first; retrying keeps the same request and choices. Your API key is not saved in this browser."}</p>
      <code className={styles.requestId}>Request {launch.saved.requestId}</code>
      <div className={styles.actions}>
        <button type="button" disabled={disabled || launch.busy} onClick={() => void launch.check()}>
          {launch.busy && <Loader2 size={14} className={styles.spinner} aria-hidden="true" />} Check saved launch
        </button>
        {!launch.agent && !launch.editing && <button type="button" disabled={disabled || launch.busy} onClick={onReview}>Review launch choices</button>}
        {launch.agent && <>
          {launch.agent.status !== "deleted" && <button type="button" disabled={disabled || launch.busy} onClick={() => onOpen(launch.agent!.id)}>Open original computer</button>}
          <button type="button" disabled={disabled || launch.busy} onClick={() => { launch.startAnother(); onChange({ ...draft, mode: "native", apiKey: "" }); }}>Start another computer</button>
        </>}
      </div>
      {launch.editing && <p>Review where this runs before retrying. Changes keep this request ID; if an earlier attempt was accepted, open that original computer instead. Native sign-in cannot replace an unconfirmed model launch.</p>}
    </div> : null}
    {(!launch.saved || launch.editing) && <div className={styles.choices} aria-label="Model authentication options">
      {([["native", "Native sign-in", "ChatGPT or OpenAI API key after launch"],
        ["byok", "My Venice API key", "Model usage billed by Venice"],
        ...(allowManaged ? [["managed", "Hivra model credits", "Venice models through your Hivra wallet"]] as const : [])] as const).map(([value, label, help]) =>
        <button key={value} type="button" aria-pressed={mode === value} disabled={locked || (Boolean(launch.saved) && value === "native")}
          onClick={() => onChange({ ...draft, mode: value, apiKey: "" })}>
          <strong>{label}</strong><span>{help}</span>
        </button>)}
    </div>}
    {mode === "native" ? <p className={styles.help}>Use the normal Codex sign-in inside its terminal. No model key is needed here.</p> : <>
      {!launch.agent && mode === "byok" && <label className={styles.field}>
        {launch.saved ? "Re-enter your Venice API key to retry" : "Venice API key"}
        <input type="password" autoComplete="off" spellCheck={false} maxLength={256} value={draft.apiKey}
          disabled={disabled || launch.busy} onChange={event => onChange({ ...draft, apiKey: event.target.value })}
          placeholder="Paste your Venice key" data-ph-no-capture="true" className="ph-no-capture" />
        <span className={styles.help}>Encrypted on the server, then delivered to this computer after it is ready. Never stored in browser storage or sent to the infrastructure installer.</span>
      </label>}
      <label className={styles.field}>Venice model ID
        <input value={selection?.model ?? draft.model} disabled={locked} maxLength={64} autoComplete="off" spellCheck={false}
          onChange={event => onChange({ ...draft, model: event.target.value })} placeholder="deepseek-v4-pro" />
      </label>
      {mode === "managed" && <label className={styles.field}>Model usage wallet
        <select disabled={locked} value={selection?.mode === "managed" ? selection.walletType : draft.walletType}
          onChange={event => onChange({ ...draft, walletType: event.target.value as "card" | "hermesos" })}>
          <option value="card">Card-funded credits</option><option value="hermesos">Hivra token credits</option>
        </select>
        <span className={styles.help}>Have credits in this wallet before using the model. Model usage is separate from hosting; this button does not purchase credits.</span>
      </label>}
      {!supported && (!launch.saved || launch.editing) && <p role="alert" className={styles.notice}>This host has not advertised secure model-key setup. Prepare its current runtime in Infrastructure or choose a compatible host.</p>}
      <p className={styles.help}>After launch, Settings on the original computer shows setup and any action needed. A saved key is not proof that the model is connected.</p>
    </>}
    {launch.error && <p role="alert" className={styles.notice}>{launch.error}</p>}
  </section>;
}
