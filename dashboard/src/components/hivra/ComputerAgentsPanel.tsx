"use client";

// Computer page → Manage: "Agents on this computer" (design 5.8). Add an
// agent through its own access gate and Review ("Add Codex to this computer"),
// follow the install by observed receipts only, and change what it may use or
// remove it, each with its own review and button. What Codex knows about this
// computer shows with who confirmed it: root's read-back is "checked by Hivra".
//
// The UI shows observed state only: nothing reads as done before its receipt,
// nothing is bought, and a limit is stated, never worked around.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Bot, Loader2, MessageSquareText, Plus, RefreshCw, Trash2 } from "lucide-react";

import {
  ATTACH_RUNTIME_NAME,
  DEFAULT_ATTACH_GRANTS,
  attachAccessChangeReview,
  attachAccessRows,
  attachProgressSteps,
  attachRemoveReview,
  attachPairLine,
  attachReview,
  type AttachGrants,
} from "@/lib/agent-computers/attach-plan";
import { announceAttachedAgentsChanged } from "@/lib/agent-computers/attached-agent-surface";
import {
  addAgentToComputer,
  changeAttachedAgentAccess,
  fetchAttachGate,
  removeAttachedAgent,
  type AttachGate,
  type AttachGateAttachment,
} from "@/lib/agent-computers/attach-client";
import { ATTACHED_CODEX_VERSION, contractAppliesTo, contractAppliesToLabel } from "@/lib/agent-computers/contract-resume-evidence";
import { ComputerAgentSlot, formatContractTime } from "@/components/hivra/ComputerContractPanel";

import styles from "./ComputerAgentsPanel.module.css";

/** While a step is open, read its receipts again this often. */
export const ATTACH_POLL_MS = 5_000;
/** A step with no new receipt for this long says it couldn't be confirmed yet. */
export const ATTACH_UNCONFIRMED_AFTER_MS = 12 * 60_000;

type View =
  | { step: "idle" }
  | { step: "gate"; grants: AttachGrants }
  | { step: "review"; grants: AttachGrants; requestId: string }
  | { step: "access"; attachment: AttachGateAttachment; requestId: string }
  | { step: "remove"; attachment: AttachGateAttachment; requestId: string };

/** A random v4 request id: one per review, reused when that review is sent again. */
function newRequestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const ACCESS_STATE: Record<string, string> = {
  on: "On", off: "Off", "locked-on": "On · locked", "always-off": "Off · always", "not-available": "Not available yet",
  never: "Never offered", shown: "",
};

function live(attachment: AttachGateAttachment): boolean {
  return attachment.phase === "claimed" || attachment.phase === "dispatched";
}

function openOperation(attachment: AttachGateAttachment) {
  const operation = attachment.operation;
  return operation && (operation.phase === "claimed" || operation.phase === "dispatched") ? operation : null;
}

function endedLine(attachment: AttachGateAttachment): string | null {
  if (attachment.phase === "detached") {
    return attachment.endReason === "computer_deleted" ? null : `${ATTACH_RUNTIME_NAME} was removed. Your files in ~/Hivra were kept.`;
  }
  if (attachment.phase === "failed") {
    // A precondition refusal: nothing was installed, and it says why.
    if (attachment.endReason === "computer_not_running") {
      return `${ATTACH_RUNTIME_NAME} wasn't added: this computer wasn't running. Nothing was installed. Start it, then add ${ATTACH_RUNTIME_NAME} again.`;
    }
    if (attachment.endReason === "computer_not_ready") {
      return `${ATTACH_RUNTIME_NAME} wasn't added: this computer wasn't ready and didn't answer Hivra. Nothing was installed. Add ${ATTACH_RUNTIME_NAME} again once it has finished starting.`;
    }
    return `Adding ${ATTACH_RUNTIME_NAME} didn't finish. Hivra removed what it had installed; your files in ~/Hivra were not touched.`;
  }
  if (attachment.phase === "cancelled") {
    return attachment.endReason === "plan_agent_limit"
      ? `Adding ${ATTACH_RUNTIME_NAME} stopped because your plan's agent limit was reached. Nothing was installed.`
      : `Adding ${ATTACH_RUNTIME_NAME} was stopped before anything was installed.`;
  }
  return null;
}

export function ComputerAgentsPanel({ computerId, computerName, autoOpenAdd }: {
  computerId: string;
  computerName: string;
  /** Open "Add an agent" once. Defaults to the page's ?addAgent=1 (Launch's
   * "Put an agent on a computer I already have"). */
  autoOpenAdd?: boolean;
}) {
  const [gate, setGate] = useState<{ state: "loading" } | { state: "not_offered" } | { state: "unavailable"; message: string }
    | { state: "ready"; gate: AttachGate }>({ state: "loading" });
  const [view, setView] = useState<View>({ step: "idle" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showContract, setShowContract] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const autoOpened = useRef(false);
  const lastPhase = useRef<string | null>(null);

  const load = useCallback(async () => {
    const result = await fetchAttachGate(computerId);
    setGate(result);
    setNow(Date.now());
    return result;
  }, [computerId]);

  useEffect(() => {
    let alive = true;
    void fetchAttachGate(computerId).then((result) => {
      if (!alive) return;
      setGate(result);
      setNow(Date.now());
    });
    return () => { alive = false; };
  }, [computerId]);

  const ready = gate.state === "ready" ? gate.gate : null;
  const current = ready?.attachments.find((attachment) => attachment.phase === "attached" || live(attachment)) ?? null;
  const ended = !current ? ready?.attachments[0] ?? null : null;
  const pending = Boolean(current && (live(current) || openOperation(current)));

  // Follow an open step by its receipts.
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => { void load(); }, ATTACH_POLL_MS);
    return () => window.clearInterval(timer);
  }, [pending, load]);

  // Tell the page when something finished, so its tabs follow (Chat appears or goes).
  // The first read is where things stand, not a change.
  useEffect(() => {
    if (!ready) return;
    const phase = current ? `${current.id}:${current.phase}:${current.operation?.id ?? ""}:${current.operation?.phase ?? ""}` : "none";
    if (lastPhase.current !== null && lastPhase.current !== phase) announceAttachedAgentsChanged();
    lastPhase.current = phase;
  }, [ready, current]);

  useEffect(() => {
    if (autoOpened.current || !ready?.available || current) return;
    let wanted = autoOpenAdd;
    if (wanted === undefined) {
      try { wanted = new URLSearchParams(window.location.search).get("addAgent") === "1"; } catch { wanted = false; }
    }
    if (!wanted) return;
    autoOpened.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- A deep link opens the gate once, after the first read.
    setView({ step: "gate", grants: { ...DEFAULT_ATTACH_GRANTS } });
  }, [autoOpenAdd, ready, current]);

  const facts = ready ? { name: ready.computer.name || computerName, cpu: ready.computer.cpu, ramGb: ready.computer.ramGb,
    deploymentMode: ready.computer.deploymentMode } : null;

  async function submitAdd(grants: AttachGrants, requestId: string) {
    if (!ready?.reviews) return;
    setBusy(true); setError(null);
    const result = await addAgentToComputer(computerId, { grants, requestId,
      reviewSha256: grants.workspace ? ready.reviews.workspaceOn : ready.reviews.workspaceOff });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      if (result.reason === "review_changed" || result.status === 403) { setView({ step: "idle" }); void load(); }
      return;
    }
    setView({ step: "idle" });
    void load();
  }

  async function submitAccess(attachment: AttachGateAttachment, requestId: string) {
    if (!attachment.reviews || !attachment.grants) return;
    setBusy(true); setError(null);
    const result = await changeAttachedAgentAccess(computerId, attachment.id, { requestId,
      grants: { workspace: !attachment.grants.workspace }, reviewSha256: attachment.reviews.accessChange });
    setBusy(false);
    if (!result.ok) { setError(result.message); return; }
    setView({ step: "idle" });
    void load();
  }

  async function submitRemove(attachment: AttachGateAttachment, requestId: string) {
    if (!attachment.reviews) return;
    setBusy(true); setError(null);
    const result = await removeAttachedAgent(computerId, attachment.id, { requestId, reviewSha256: attachment.reviews.remove });
    setBusy(false);
    if (!result.ok) { setError(result.message); return; }
    setView({ step: "idle" });
    void load();
  }

  const heading = <h3 id={`computer-agents-${computerId}`} className={styles.heading}>Agents on this computer</h3>;
  if (gate.state === "loading") {
    return <section className={styles.section} aria-labelledby={`computer-agents-${computerId}`}>{heading}
      <div className={styles.panel}><p className={styles.body}><Loader2 size={13} className={styles.spinner} aria-hidden /> Checking this computer…</p></div>
    </section>;
  }
  // Where attach is not offered (production), the honest slot as before.
  if (gate.state === "not_offered") return <ComputerAgentSlot />;
  if (gate.state === "unavailable") {
    return <section className={styles.section} aria-labelledby={`computer-agents-${computerId}`}>{heading}
      <div className={styles.panel}>
        <p className={styles.error} role="alert"><AlertTriangle size={12} aria-hidden /> {gate.message}</p>
        <div className={styles.actions}><button type="button" className={styles.button} onClick={() => void load()}>
          <RefreshCw size={13} aria-hidden /> Check again</button></div>
      </div>
    </section>;
  }

  const gateView = ready!;
  let content: React.ReactNode;

  if (view.step === "gate" && facts) {
    const rows = attachAccessRows(view.grants, facts);
    const title = `What can ${ATTACH_RUNTIME_NAME} use on ${JSON.stringify(facts.name)}?`;
    content = <div className={styles.flow} role="group" aria-labelledby={`attach-gate-${computerId}`}>
      <h4 id={`attach-gate-${computerId}`} className={styles.title}>{title}</h4>
      <p className={styles.body}>{attachPairLine(facts.name)}</p>
      <ul className={styles.rows}>
        {rows.map((row) => <li key={row.id} className={styles.row} data-state={row.state}>
          <div className={styles.rowHead}>
            <strong>{row.label}</strong>
            {row.toggle ? <label className={styles.toggle}>
              <input type="checkbox" checked={view.grants.workspace}
                onChange={(event) => setView({ step: "gate", grants: { workspace: event.target.checked } })} />
              <span>{view.grants.workspace ? "On" : "Off"}</span>
            </label> : ACCESS_STATE[row.state] ? <span className={styles.rowState}>{ACCESS_STATE[row.state]}</span> : null}
          </div>
          {row.copy && row.id !== "personalHome" ? <p className={styles.body}>{row.copy}</p> : null}
        </li>)}
      </ul>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} onClick={() => setView({ step: "review", grants: view.grants, requestId: newRequestId() })}>
          Continue to review</button>
        <button type="button" className={styles.button} onClick={() => setView({ step: "idle" })}>Cancel</button>
      </div>
    </div>;
  } else if (view.step === "review" && facts) {
    const review = attachReview({ computerName: facts.name, grants: view.grants, deploymentMode: facts.deploymentMode,
      servicePolicySha256: gateView.policy.servicePolicySha256 });
    content = <div className={styles.flow} role="group" aria-labelledby={`attach-review-${computerId}`}>
      <h4 id={`attach-review-${computerId}`} className={styles.title}>{review.title}</h4>
      <ul className={styles.lines}>
        {review.lines.map((line) => <li key={line}>{line}</li>)}
        <li><strong>{review.isolation}</strong></li>
      </ul>
      <details className={styles.details}>
        <summary>Technical details</summary>
        <p>Isolation class: {review.technical.isolationClass}. Service policy: {review.technical.servicePolicySha256}. Installer: {review.technical.installerSha256}.</p>
      </details>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} disabled={busy} onClick={() => void submitAdd(view.grants, view.requestId)}>
          {busy ? <Loader2 size={13} className={styles.spinner} aria-hidden /> : <Plus size={13} aria-hidden />} {review.button}</button>
        <button type="button" className={styles.button} disabled={busy} onClick={() => setView({ step: "gate", grants: view.grants })}>Back</button>
      </div>
    </div>;
  } else if (view.step === "access" && view.attachment.grants && facts) {
    const to = { workspace: !view.attachment.grants.workspace };
    const review = attachAccessChangeReview({ computerName: facts.name, from: view.attachment.grants, to });
    content = <div className={styles.flow} role="group" aria-labelledby={`attach-access-${computerId}`}>
      <h4 id={`attach-access-${computerId}`} className={styles.title}>{review.title}</h4>
      <ul className={styles.lines}>{review.lines.map((line) => <li key={line}>{line}</li>)}</ul>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} disabled={busy} onClick={() => void submitAccess(view.attachment, view.requestId)}>
          {busy ? <Loader2 size={13} className={styles.spinner} aria-hidden /> : null} {review.button}</button>
        <button type="button" className={styles.button} disabled={busy} onClick={() => setView({ step: "idle" })}>Cancel</button>
      </div>
    </div>;
  } else if (view.step === "remove" && facts) {
    const review = attachRemoveReview({ computerName: facts.name, deploymentMode: facts.deploymentMode });
    content = <div className={styles.flow} role="group" aria-labelledby={`attach-remove-${computerId}`}>
      <h4 id={`attach-remove-${computerId}`} className={styles.title}>{review.title}</h4>
      <ul className={styles.lines}>{review.lines.map((line) => <li key={line}>{line}</li>)}</ul>
      <div className={styles.actions}>
        <button type="button" className={styles.danger} disabled={busy} onClick={() => void submitRemove(view.attachment, view.requestId)}>
          {busy ? <Loader2 size={13} className={styles.spinner} aria-hidden /> : <Trash2 size={13} aria-hidden />} {review.button}</button>
        <button type="button" className={styles.button} disabled={busy} onClick={() => setView({ step: "idle" })}>Cancel</button>
      </div>
    </div>;
  } else if (current && live(current)) {
    const steps = attachProgressSteps(current.receipts);
    const latest = [...steps].reverse().find((step) => step.at)?.at ?? current.createdAt;
    const stale = now - Date.parse(latest) > ATTACH_UNCONFIRMED_AFTER_MS;
    content = <div className={styles.flow} aria-live="polite">
      <h4 className={styles.title}>Adding {ATTACH_RUNTIME_NAME}</h4>
      <ol className={styles.progress}>
        {steps.map((step) => <li key={step.id} data-done={Boolean(step.at)}>
          <span>{step.label}</span>{step.at ? <time dateTime={step.at}>{formatContractTime(step.at)}</time> : null}
        </li>)}
      </ol>
      {stale ? <p className={styles.body}>We couldn&apos;t confirm this step yet. Check again. This won&apos;t install a second copy.</p> : null}
      <div className={styles.actions}><button type="button" className={styles.button} onClick={() => void load()}>
        <RefreshCw size={13} aria-hidden /> Check again</button></div>
    </div>;
  } else if (current) {
    const operation = openOperation(current);
    const contract = current.contract;
    const applies = contractAppliesToLabel(contractAppliesTo({ runtime: "codex", version: ATTACHED_CODEX_VERSION, surface: "attached" }));
    const delivered = contract?.deliveredAt ?? null;
    content = <div className={styles.flow}>
      <div className={styles.agentRow}>
        <Bot size={16} aria-hidden />
        <div>
          <strong>{current.agentName || ATTACH_RUNTIME_NAME}</strong>
          <p className={styles.body}>{current.grants?.workspace
            ? "Can read and write ~/Hivra, use its own terminal and reach the internet."
            : "Can use its own terminal and reach the internet. It has no shared folder."}</p>
        </div>
      </div>
      {operation ? <p className={styles.body} aria-live="polite"><Loader2 size={12} className={styles.spinner} aria-hidden /> {operation.kind === "detach"
        ? `Removing ${ATTACH_RUNTIME_NAME}. Your files in ~/Hivra stay.`
        : `Changing what ${ATTACH_RUNTIME_NAME} can use. It is stopped while its access changes.`}
        {operation.phase === "dispatched" && now - Date.parse(operation.dispatchedAt ?? operation.createdAt) > ATTACH_UNCONFIRMED_AFTER_MS
          ? " We couldn't confirm this step yet. Check again." : null}</p> : null}
      {current.operation?.phase === "failed" && current.operation.kind === "access_change" ? <p className={styles.body}>
        The last change of access didn&apos;t finish, and {ATTACH_RUNTIME_NAME} was put back as it was.</p> : null}
      <div className={styles.contract}>
        <h4 className={styles.title}>What {ATTACH_RUNTIME_NAME} knows about this computer</h4>
        {contract ? <div className={styles.meta}>
          <span>rev {contract.revision}</span><span aria-hidden>·</span>
          {delivered ? <span className={styles.state} data-state="delivered">Delivered {formatContractTime(delivered)} · checked by Hivra · {applies}</span>
            : <span className={styles.state} data-state="pending">Update pending</span>}
        </div> : <div className={styles.meta}><span className={styles.state} data-state="pending">Update pending</span></div>}
        {contract && !delivered && contract.lastDelivered ? <p className={styles.body}>
          Last delivered: rev {contract.lastDelivered.revision} at {formatContractTime(contract.lastDelivered.deliveredAt)}.</p> : null}
        {delivered ? <details className={styles.details}>
          <summary>Who confirmed this</summary>
          <p>Hivra read the file back as the computer&apos;s administrator, on the computer and inside {ATTACH_RUNTIME_NAME}&apos;s own sandbox. {ATTACH_RUNTIME_NAME} can&apos;t change or hide that file. This shows the text is there, not that {ATTACH_RUNTIME_NAME} read it.</p>
        </details> : null}
        {contract ? <button type="button" className={styles.button} aria-expanded={showContract} onClick={() => setShowContract((value) => !value)}>
          {showContract ? "Hide text" : "Show text"}</button> : null}
        {contract && showContract ? <pre className={styles.text} aria-label={`Text Hivra gives ${ATTACH_RUNTIME_NAME}`}>{contract.content}</pre> : null}
      </div>
      <div className={styles.actions}>
        {operation ? null : <Link className={styles.primary} href={`/dashboard/agent/${encodeURIComponent(computerId)}?tab=chat`}>
          <MessageSquareText size={13} aria-hidden /> Open chat</Link>}
        <button type="button" className={styles.button} disabled={Boolean(operation)}
          onClick={() => setView({ step: "access", attachment: current, requestId: newRequestId() })}>Change access</button>
        <button type="button" className={styles.button} disabled={Boolean(operation)}
          onClick={() => setView({ step: "remove", attachment: current, requestId: newRequestId() })}>Remove</button>
      </div>
      <p className={styles.note}>Snapshots of this computer include {ATTACH_RUNTIME_NAME}&apos;s private home and its sign-in. Restoring is unavailable while {ATTACH_RUNTIME_NAME} is on this computer: remove {ATTACH_RUNTIME_NAME} first.</p>
    </div>;
  } else if (gateView.reason === "unsupported_computer") {
    content = <div className={styles.flow}>
      <p className={styles.body}>No agent works on this computer. {gateView.message}. An agent you launch gets its own computer.</p>
      <div className={styles.actions}><Link className={styles.button} href="/dashboard/launch?kind=agent&start=1">Launch an agent</Link></div>
    </div>;
  } else {
    const endedCopy = ended ? endedLine(ended) : null;
    content = <div className={styles.flow}>
      <p className={styles.body}>No agent is on this computer. You can add {ATTACH_RUNTIME_NAME} as a separate user that works in your Hivra folder. Nothing is bought.</p>
      {endedCopy ? <p className={styles.body}>{endedCopy}</p> : null}
      {gateView.available ? <div className={styles.actions}>
        <button type="button" className={styles.primary} onClick={() => setView({ step: "gate", grants: { ...DEFAULT_ATTACH_GRANTS } })}>
          <Plus size={13} aria-hidden /> Add an agent</button>
      </div> : <>
        <p className={styles.body} role="status">{gateView.message}</p>
        {gateView.billingHref ? <div className={styles.actions}><Link className={styles.button} href={gateView.billingHref}>Billing</Link></div> : null}
      </>}
    </div>;
  }

  return (
    <section className={styles.section} aria-labelledby={`computer-agents-${computerId}`}>
      {heading}
      <div className={styles.panel}>
        {content}
        {error ? <p className={styles.error} role="alert"><AlertTriangle size={12} aria-hidden /> {error}</p> : null}
      </div>
    </section>
  );
}
