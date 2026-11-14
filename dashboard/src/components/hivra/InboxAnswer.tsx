"use client";

import Link from "next/link";
import { useState } from "react";

import type { ApprovalChoice, InboxPrompt } from "@/lib/agent-inbox/types";

const LABEL: Record<ApprovalChoice, string> = {
  once: "Allowed once",
  session: "Allowed for this chat",
  always: "Always allowed",
  deny: "Not allowed",
};

const button =
  "inline-flex min-h-[32px] pointer-coarse:min-h-[44px] items-center rounded-[10px] border border-[var(--etched-border)] px-3 text-[12.5px] font-semibold text-[var(--ink-black)] outline-none hover:bg-[var(--bg-elevated)] focus-visible:ring-2 focus-visible:ring-[var(--hivra-red)] disabled:opacity-50";
const primary =
  "inline-flex min-h-[32px] pointer-coarse:min-h-[44px] items-center rounded-[10px] border border-[var(--ink-black)] bg-[var(--ink-black)] px-3 text-[12.5px] font-semibold text-[var(--hg-on-accent)] outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-[var(--hivra-red)] focus-visible:ring-offset-1 disabled:opacity-50";
const quiet =
  "text-[12px] text-[var(--text-muted)] underline underline-offset-[3px] outline-none hover:text-[var(--ink-black)] focus-visible:ring-2 focus-visible:ring-[var(--hivra-red)]";

function minutesLeft(expiresAt: string, now: number): string | null {
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms)) return null;
  if (ms <= 60_000) return "Less than a minute left";
  const minutes = Math.round(ms / 60_000);
  return minutes >= 60 ? "Waiting for you" : `${minutes} min left`;
}

export async function sendInboxAnswer(agentId: string, promptId: string, choice: ApprovalChoice, text?: string): Promise<void> {
  const response = await fetch(
    `/api/hivra/agents/${encodeURIComponent(agentId)}/prompts/${encodeURIComponent(promptId)}/answer`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(text ? { choice, text } : { choice }),
    },
  );
  if (response.ok) return;
  let message = "Hivra could not send your answer. Try again, or answer in the chat.";
  try {
    const body = (await response.json()) as { error?: unknown; message?: unknown };
    const candidate = typeof body.error === "string" ? body.error : typeof body.message === "string" ? body.message : null;
    if (candidate) message = candidate;
  } catch {
    /* keep the plain message */
  }
  throw new Error(message);
}

/**
 * Answer what an agent is waiting on, right in Needs you. Approvals are
 * answered here; a question shows its text and opens the chat to answer.
 * A command too long to show in full can only be refused here, the same rule
 * Hermes uses for its own chat-app buttons.
 */
export function InboxAnswer({
  agentId,
  agentName,
  chatHref,
  prompt,
  onAnswered,
  now = Date.now(),
}: {
  agentId: string;
  agentName: string;
  chatHref: string;
  prompt: InboxPrompt;
  onAnswered?: () => void;
  now?: number;
}) {
  const [sent, setSent] = useState<ApprovalChoice | null>(prompt.answeredChoice);
  const [busy, setBusy] = useState<ApprovalChoice | null>(null);
  const [step, setStep] = useState<"choose" | "deny" | "always">("choose");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const left = minutesLeft(prompt.expiresAt, now);

  const answer = async (choice: ApprovalChoice) => {
    setBusy(choice);
    setError(null);
    try {
      await sendInboxAnswer(agentId, prompt.promptId, choice, choice === "deny" ? reason.trim() || undefined : undefined);
      setSent(choice);
      onAnswered?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Hivra could not send your answer.");
    } finally {
      setBusy(null);
    }
  };

  if (sent) {
    return (
      <div data-testid="inbox-answer-sent" role="status" className="flex items-start gap-2 text-[12.5px] leading-[1.45] text-[var(--text-secondary)]">
        <span aria-hidden="true" className={`mt-[1px] inline-grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full text-[10px] font-bold text-white ${sent === "deny" ? "bg-[var(--text-muted)]" : "bg-[var(--hg-ok)]"}`}>
          {sent === "deny" ? "–" : "✓"}
        </span>
        <span>
          <strong className="font-semibold text-[var(--ink-black)]">{LABEL[sent]}.</strong>{" "}
          {sent === "deny" ? `${agentName} will stop and try another way.` : `${agentName} carries on in a few seconds.`}
        </span>
      </div>
    );
  }

  const disabled = busy !== null;
  const allow = prompt.commandComplete;
  return (
    <div data-testid="inbox-answer" className="flex flex-col gap-2.5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] font-medium leading-[1.45] text-[var(--ink-black)] [overflow-wrap:anywhere]">
          {prompt.kind === "clarify"
            ? prompt.summary || `${agentName} has a question for you.`
            : prompt.summary || `${agentName} wants to run a command.`}
        </p>
        {left ? <span className="mono shrink-0 rounded-full border border-[var(--etched-border)] px-2 py-[1px] text-[10.5px] text-[var(--text-muted)]">{left}</span> : null}
      </div>
      {prompt.command ? (
        <pre className="max-h-[180px] overflow-auto whitespace-pre-wrap rounded-[10px] border border-[var(--etched-border)] bg-[var(--bg-elevated)] px-3 py-2 font-mono text-[12px] leading-[1.5] text-[var(--ink-black)] [overflow-wrap:anywhere]">
          {prompt.command}
        </pre>
      ) : null}

      {prompt.kind === "clarify" || !prompt.answerable ? (
        <div className="flex flex-wrap items-center gap-2">
          <Link href={chatHref} className={primary}>Open chat to answer</Link>
        </div>
      ) : step === "deny" ? (
        <div className="flex flex-col gap-2">
          <label htmlFor={`inbox-reason-${prompt.promptId}`} className="text-[12px] text-[var(--text-muted)]">
            Tell it why, or what to do instead (optional)
          </label>
          <input
            id={`inbox-reason-${prompt.promptId}`}
            type="text"
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className="min-h-[34px] rounded-[10px] border border-[var(--etched-border)] bg-transparent px-3 text-[13px] text-[var(--ink-black)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--hivra-red)]"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={primary} disabled={disabled} onClick={() => void answer("deny")}>
              {busy === "deny" ? "Sending…" : "Send no"}
            </button>
            <button type="button" className={button} disabled={disabled} onClick={() => setStep("choose")}>Back</button>
          </div>
        </div>
      ) : step === "always" ? (
        <div className="flex flex-col gap-2 rounded-[10px] bg-[var(--bg-elevated)] px-3 py-2.5 text-[12.5px] leading-[1.45] text-[var(--text-secondary)]">
          <p>{agentName} will stop asking for commands like this, in every chat. You can undo it in Hermes&apos;s own settings.</p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={primary} disabled={disabled} onClick={() => void answer("always")}>
              {busy === "always" ? "Sending…" : "Always allow"}
            </button>
            <button type="button" className={button} disabled={disabled} onClick={() => setStep("choose")}>Back</button>
          </div>
        </div>
      ) : (
        <>
          {!allow ? (
            <p className="text-[12px] leading-[1.45] text-[var(--text-muted)]">
              Only part of this command fits here, so you can allow it only from the chat. You can still say no here.
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {allow ? (
              <>
                <button type="button" className={primary} disabled={disabled} onClick={() => void answer("once")}>
                  {busy === "once" ? "Sending…" : "Allow once"}
                </button>
                {prompt.choices.includes("session") ? (
                  <button type="button" className={button} disabled={disabled} onClick={() => void answer("session")}>
                    {busy === "session" ? "Sending…" : "Allow for this chat"}
                  </button>
                ) : null}
              </>
            ) : (
              <Link href={chatHref} className={primary}>Open chat to review</Link>
            )}
            <button type="button" className={`${button} text-[var(--hg-bad)]`} disabled={disabled} onClick={() => setStep("deny")}>
              Don&apos;t allow
            </button>
            {allow ? <Link href={chatHref} className={`${quiet} ml-auto`}>Open chat</Link> : null}
          </div>
          {allow && prompt.choices.includes("always") ? (
            <button type="button" className={`${quiet} w-fit`} disabled={disabled} onClick={() => setStep("always")}>
              Always allow commands like this…
            </button>
          ) : null}
        </>
      )}
      {error ? <p role="alert" className="text-[12px] text-[var(--hg-bad)]">{error}</p> : null}
    </div>
  );
}
