"use client";

// Chat for a DigitalOcean Managed Agents session. DigitalOcean keeps one
// continuous session per agent; Hivra relays its canonical event stream,
// forwards messages, and turns approval requests into buttons, so the owner
// never needs doctl or a terminal. Everything shown is folded from events
// DigitalOcean reported — nothing here marks a run done on its own.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertTriangle, Check, Loader2, Pause, Play, Send, ShieldQuestion, Trash2, X } from "lucide-react";

import { CodeBlock } from "@/components/markdown/CodeBlock";
import {
  answerManagedSessionApproval,
  changeManagedSession,
  getManagedSession,
  isManagedSessionCredentialProblem,
  managedSessionEventsUrl,
  parseManagedSessionStreamEvent,
  readManagedSessionHistory,
  sendManagedSessionMessage,
  type ManagedSessionApiError,
} from "@/lib/hivra/managed-session-client";
import {
  DIGITALOCEAN_HARNESS_LABELS,
  managedSessionPauseCopy,
  type ManagedSessionDto,
} from "@/lib/hivra/managed-session-contracts";
import {
  addManagedPrompt,
  applyManagedSessionEvent,
  emptyManagedTranscript,
  type ManagedTranscript,
  type ManagedTranscriptRun,
} from "@/lib/hivra/managed-session-transcript";

import styles from "./ManagedSessionChat.module.css";

const MD_COMPONENTS = {
  code(props: { className?: string; children?: React.ReactNode }) {
    const text = String(props.children ?? "").replace(/\n$/, "");
    const lang = /language-(\w+)/.exec(props.className || "")?.[1];
    if (lang || text.includes("\n")) return <CodeBlock language={lang || "text"} value={text} />;
    return <code>{text}</code>;
  },
};

type StreamState = "idle" | "connecting" | "live" | "reconnecting" | "stopped";

function statusCopy(session: ManagedSessionDto, transcript: ManagedTranscript): { label: string; dot: string } {
  const liveStatus = transcript.sessionStatus?.toUpperCase().replace(/^SESSION_STATUS_/, "");
  if (session.status === "deleting") return { label: "Deleting in DigitalOcean", dot: styles.dotBusy };
  if (session.status === "provisioning") return { label: "Starting on DigitalOcean", dot: styles.dotBusy };
  if (session.status === "error") return { label: "Needs attention", dot: styles.dotError };
  if (liveStatus === "PAUSED" || session.status === "paused") return { label: "Paused", dot: styles.dotPaused };
  return { label: "Ready", dot: styles.dotReady };
}

function RunView({
  run,
  submitting,
  onAnswer,
}: {
  run: ManagedTranscriptRun;
  submitting: Record<string, "approve" | "reject">;
  onAnswer: (requestId: string, outcome: "approve" | "reject") => void;
}) {
  const hasOutput = run.text || run.tools.length || run.approvals.length || run.reasoning;
  return (
    <>
      {run.prompt ? <div className={styles.userBubble}>{run.prompt}</div> : null}
      <div className={styles.assistant}>
        {run.reasoning ? (
          <details className={styles.reasoning}>
            <summary>Reasoning</summary>
            {run.reasoning}
          </details>
        ) : null}
        {run.tools.length ? (
          <div className={styles.tools}>
            {run.tools.map((tool) => (
              <div key={tool.id} className={styles.tool}>
                {tool.status === "running"
                  ? <Loader2 size={13} className={styles.spin} aria-label="Running" />
                  : tool.status === "done" ? <Check size={13} aria-label="Done" /> : <X size={13} aria-label="Failed" />}
                <span className={styles.toolLabel}>
                  {tool.label}
                  {tool.summary ? <span className={styles.toolSummary}>{tool.summary}</span> : null}
                </span>
              </div>
            ))}
          </div>
        ) : null}
        {run.approvals.map((approval) => (
          <div key={approval.requestId} className={styles.approval} role={approval.state === "pending" ? "alert" : undefined}>
            <span className={styles.approvalTitle}><ShieldQuestion size={12} aria-hidden /> Approval requested</span>
            <span className={styles.approvalSummary}>{approval.summary}</span>
            {approval.state === "pending" ? (
              submitting[approval.requestId] ? (
                <span className={styles.approvalResolved}>
                  <Loader2 size={11} className={styles.spin} aria-hidden /> Sent {submitting[approval.requestId] === "approve" ? "approval" : "rejection"} — waiting for DigitalOcean to confirm
                </span>
              ) : (
                <div className={styles.approvalActions}>
                  <button type="button" className={styles.primaryButton} onClick={() => onAnswer(approval.requestId, "approve")}>
                    <Check size={12} aria-hidden /> Approve
                  </button>
                  <button type="button" className={styles.dangerButton} onClick={() => onAnswer(approval.requestId, "reject")}>
                    <X size={12} aria-hidden /> Reject
                  </button>
                </div>
              )
            ) : (
              <span className={styles.approvalResolved}>
                {approval.state === "approved" ? "Approved" : approval.state === "rejected" ? "Rejected" : "Deferred"}
              </span>
            )}
          </div>
        ))}
        {run.text ? <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{run.text}</ReactMarkdown> : null}
        {!hasOutput && run.state === "running" ? <Loader2 size={15} className={styles.spin} aria-label="Working" /> : null}
        {run.error ? <div className={styles.runError}>⚠ {run.error}</div> : null}
        {run.state === "completed" && (run.tokensIn || run.tokensOut) ? (
          <div className={styles.runMeta}>
            {run.tokensIn ?? 0} in / {run.tokensOut ?? 0} out tokens
            {run.costMicros ? ` · $${(run.costMicros / 1_000_000).toFixed(4)}` : ""}
          </div>
        ) : null}
        {run.state === "paused" ? <div className={styles.runMeta}>Run paused</div> : null}
      </div>
    </>
  );
}

export function ManagedSessionChat({
  initialSession,
  onDeleted,
  onCredentialProblem,
}: {
  initialSession: ManagedSessionDto;
  onDeleted?: () => void;
  /** Called when a request fails because Hivra's DigitalOcean token cannot manage this agent. */
  onCredentialProblem?: (error: ManagedSessionApiError) => void;
}) {
  const agentId = initialSession.agentId;
  const [session, setSession] = useState(initialSession);
  const [transcript, setTranscript] = useState<ManagedTranscript>(emptyManagedTranscript);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [streamState, setStreamState] = useState<StreamState>("idle");
  const [notice, setNotice] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [orphanPrompts, setOrphanPrompts] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState<Record<string, "approve" | "reject">>({});
  const [lifecycleBusy, setLifecycleBusy] = useState<"pause" | "resume" | "delete" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastEventIdRef = useRef<string | null>(null);
  const onDeletedRef = useRef(onDeleted);
  useEffect(() => { onDeletedRef.current = onDeleted; }, [onDeleted]);
  const onCredentialProblemRef = useRef(onCredentialProblem);
  useEffect(() => { onCredentialProblemRef.current = onCredentialProblem; }, [onCredentialProblem]);
  const noteFailure = useCallback((error: unknown) => {
    if (isManagedSessionCredentialProblem(error)) onCredentialProblemRef.current?.(error);
  }, []);
  const streamable = Boolean(session.sessionId) && session.status !== "deleted" && session.status !== "deleting";

  useEffect(() => { lastEventIdRef.current = transcript.lastEventId; }, [transcript.lastEventId]);

  // A starting session is reconciled against DigitalOcean until it settles.
  useEffect(() => {
    if (session.status !== "provisioning" && session.status !== "deleting") return;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      void getManagedSession(agentId, { reconcile: true, signal: controller.signal })
        .then((next) => {
          setSession(next);
          if (next.status === "deleted") onDeletedRef.current?.();
        })
        .catch(() => undefined);
    }, 2_500);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [agentId, session.status]);

  // Stored history first, then the live tail from the last event it held.
  useEffect(() => {
    if (!streamable || historyLoaded) return;
    const controller = new AbortController();
    readManagedSessionHistory(agentId, controller.signal)
      .then(({ events, prompts }) => {
        let next = emptyManagedTranscript();
        for (const event of events) next = applyManagedSessionEvent(next, event);
        for (const prompt of prompts) next = addManagedPrompt(next, prompt.runId, prompt.text);
        setTranscript(next);
        setHistoryLoaded(true);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        noteFailure(error);
        setNotice({ tone: "error", text: error instanceof Error ? error.message : "The conversation history could not be loaded." });
        setHistoryLoaded(true);
      });
    return () => controller.abort();
  }, [agentId, historyLoaded, noteFailure, streamable]);

  useEffect(() => {
    if (!streamable || !historyLoaded) return;
    setStreamState("connecting");
    const source = new EventSource(managedSessionEventsUrl(agentId, lastEventIdRef.current));
    source.onopen = () => setStreamState("live");
    source.onmessage = (message) => {
      const event = parseManagedSessionStreamEvent(message.data);
      if (event) setTranscript((current) => applyManagedSessionEvent(current, event));
    };
    source.addEventListener("relay-error", (message) => {
      try {
        const payload = JSON.parse((message as MessageEvent).data) as { message?: string };
        setNotice({ tone: "error", text: payload.message ?? "The DigitalOcean event stream stopped." });
      } catch {
        setNotice({ tone: "error", text: "The DigitalOcean event stream stopped." });
      }
    });
    source.onerror = () => {
      // EventSource retries on its own while it can; CLOSED means the relay
      // refused the stream (for example, the session is no longer available).
      setStreamState(source.readyState === EventSource.CLOSED ? "stopped" : "reconnecting");
    };
    return () => source.close();
  }, [agentId, historyLoaded, streamable]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript, orphanPrompts]);

  const activeRun = useMemo(() => {
    const last = transcript.runs.at(-1);
    return last && (last.state === "running" || last.state === "awaiting_approval") ? last : null;
  }, [transcript.runs]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setNotice(null);
    try {
      const { runId } = await sendManagedSessionMessage(agentId, text);
      setDraft("");
      if (runId) setTranscript((current) => addManagedPrompt(current, runId, text));
      else setOrphanPrompts((current) => [...current, text]);
      if (session.status === "paused") setSession((current) => ({ ...current, status: "ready" }));
    } catch (error) {
      noteFailure(error);
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "The message was not delivered." });
    } finally {
      setSending(false);
    }
  }, [agentId, draft, noteFailure, sending, session.status]);

  const answer = useCallback(async (requestId: string, outcome: "approve" | "reject") => {
    setSubmitting((current) => ({ ...current, [requestId]: outcome }));
    try {
      await answerManagedSessionApproval(agentId, requestId, outcome);
    } catch (error) {
      setSubmitting((current) => {
        const next = { ...current };
        delete next[requestId];
        return next;
      });
      noteFailure(error);
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "The decision was not delivered." });
    }
  }, [agentId, noteFailure]);

  const lifecycle = useCallback(async (action: "pause" | "resume" | "delete") => {
    setLifecycleBusy(action);
    setNotice(null);
    try {
      const next = await changeManagedSession(agentId, action);
      setSession(next);
      if (next.status === "deleted") onDeletedRef.current?.();
    } catch (error) {
      noteFailure(error);
      setNotice({ tone: "error", text: error instanceof Error ? error.message : `The ${action} was not confirmed.` });
    } finally {
      setLifecycleBusy(null);
      setConfirmDelete(false);
    }
  }, [agentId, noteFailure]);

  const status = statusCopy(session, transcript);
  const paused = status.label === "Paused";
  const harness = DIGITALOCEAN_HARNESS_LABELS[session.harness];
  const canSend = streamable && session.status !== "error" && !sending;

  return (
    <section className={styles.root} aria-label={`${session.name} on DigitalOcean`}>
      <div className={styles.statusBar}>
        <span className={`${styles.statusDot} ${status.dot}`} aria-hidden />
        <span className={styles.statusText}>{status.label}</span>
        <span>{harness.name} · {session.size.replace(/^mars-/, "")} · DigitalOcean Managed Agents</span>
        {streamState === "reconnecting" ? <span>· reconnecting</span> : null}
        <div className={styles.statusActions}>
          {session.status === "ready" || session.status === "paused" ? (
            paused ? (
              <button type="button" className={styles.ghostButton} disabled={lifecycleBusy !== null} onClick={() => void lifecycle("resume")}>
                {lifecycleBusy === "resume" ? <Loader2 size={12} className={styles.spin} aria-hidden /> : <Play size={12} aria-hidden />} Resume
              </button>
            ) : (
              <button type="button" className={styles.ghostButton} disabled={lifecycleBusy !== null} onClick={() => void lifecycle("pause")}>
                {lifecycleBusy === "pause" ? <Loader2 size={12} className={styles.spin} aria-hidden /> : <Pause size={12} aria-hidden />} Pause
              </button>
            )
          ) : null}
          {session.status !== "deleted" && session.status !== "deleting" ? (
            confirmDelete ? (
              <>
                <button type="button" className={styles.dangerButton} disabled={lifecycleBusy !== null} onClick={() => void lifecycle("delete")}>
                  {lifecycleBusy === "delete" ? <Loader2 size={12} className={styles.spin} aria-hidden /> : <Trash2 size={12} aria-hidden />} Delete session and workspace
                </button>
                <button type="button" className={styles.ghostButton} disabled={lifecycleBusy !== null} onClick={() => setConfirmDelete(false)}>Keep</button>
              </>
            ) : (
              <button type="button" className={styles.ghostButton} onClick={() => setConfirmDelete(true)}>
                <Trash2 size={12} aria-hidden /> Delete
              </button>
            )
          ) : null}
        </div>
      </div>

      {session.status === "error" && session.error ? (
        <div className={`${styles.notice} ${styles.noticeError}`} role="alert"><AlertTriangle size={15} aria-hidden /> {session.error}</div>
      ) : null}
      {paused ? <div className={styles.notice}>{managedSessionPauseCopy(transcript.pauseReason ?? session.pauseReason)}</div> : null}
      {streamState === "stopped" ? (
        <div className={`${styles.notice} ${styles.noticeError}`} role="alert">
          <AlertTriangle size={15} aria-hidden /> Live updates stopped.
          <button type="button" className={styles.ghostButton} onClick={() => { setHistoryLoaded(false); setStreamState("idle"); }}>Reconnect</button>
        </div>
      ) : null}
      {notice ? (
        <div className={`${styles.notice} ${notice.tone === "error" ? styles.noticeError : ""}`} role={notice.tone === "error" ? "alert" : "status"}>
          {notice.tone === "error" ? <AlertTriangle size={15} aria-hidden /> : null} {notice.text}
        </div>
      ) : null}

      <div ref={scrollRef} className={styles.transcript} aria-live="polite">
        <div className={styles.inner}>
          {session.status === "provisioning" ? (
            <div className={styles.empty}>
              <Loader2 size={18} className={styles.spin} aria-hidden /><br />
              DigitalOcean is starting this session’s microVM.
            </div>
          ) : transcript.runs.length === 0 && orphanPrompts.length === 0 ? (
            <div className={styles.empty}>
              {historyLoaded || !streamable
                ? `Send ${session.name} a task. ${harness.name} runs in its own DigitalOcean sandbox, and anything consequential waits for your approval here.`
                : "Loading the conversation…"}
            </div>
          ) : null}
          {transcript.runs.map((run) => (
            <RunView key={run.runId} run={run} submitting={submitting} onAnswer={(id, outcome) => void answer(id, outcome)} />
          ))}
          {orphanPrompts.map((prompt, index) => <div key={`orphan-${index}`} className={styles.userBubble}>{prompt}</div>)}
        </div>
      </div>

      <form
        className={styles.composer}
        onSubmit={(event) => { event.preventDefault(); void send(); }}
      >
        <div className={styles.composerInner}>
          <label className={styles.srOnly} htmlFor={`managed-session-input-${agentId}`}>Message {session.name}</label>
          <textarea
            id={`managed-session-input-${agentId}`}
            className={styles.textarea}
            rows={2}
            value={draft}
            placeholder={paused ? "Send a message to resume the session…" : `Message ${session.name}…`}
            disabled={!streamable || session.status === "error"}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <button type="submit" className={styles.sendButton} disabled={!canSend || !draft.trim()} aria-label="Send">
            {sending ? <Loader2 size={16} className={styles.spin} aria-hidden /> : <Send size={16} aria-hidden />}
          </button>
        </div>
        {activeRun ? (
          <p className={styles.composerHint}>
            {activeRun.state === "awaiting_approval" ? "Waiting for your approval above." : "The agent is working."}
          </p>
        ) : null}
      </form>
    </section>
  );
}
