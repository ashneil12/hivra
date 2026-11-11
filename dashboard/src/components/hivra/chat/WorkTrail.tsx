"use client";

// Adapted from MonoCode (MIT License, Copyright (c) 2026 Nick); see THIRD_PARTY_LICENSES/monocode.txt.
//
// The agent's work, as one quiet line above the reply. While it works the line
// is an orb and the live step in plain words; once it is done it folds into a
// muted "Used 3 tools" that opens onto MonoCode's tool rows: a plain action
// word and its target, a file chip for a file (an edit's chip opens its diff),
// the agent's reasoning as a muted line that opens onto the full text.
// Failures show inside the rows and as a muted "· 1 failed", never as a headline.

import { useId, useState } from "react";
import { Check, ChevronRight, Globe, Minus, Pencil, Search, Terminal, Wrench, X } from "lucide-react";
import { ThinkingOrb } from "@/components/ui/ThinkingOrb";
import { AssistantMarkdown } from "./AgentMarkdown";
import { Shimmer } from "./Shimmer";
import { liveStepLabel, trailRows, usedToolsLabel } from "./liveStep";
import { ToolDiffPreview } from "./ToolDiffPreview";
import { baseName, diffFromToolInput } from "./toolInput";
import type { ChatMessage, ToolChip } from "./types";
import styles from "./chat.module.css";

function toolIcon(name: string) {
  const props = { size: 13, "aria-hidden": true, className: styles.toolIcon } as const;
  if (/^(?:bash|shell|exec|command|run)/i.test(name)) return <Terminal {...props} />;
  if (/browser|cdp|harness|navigate|screenshot|web/i.test(name)) return <Globe {...props} />;
  if (/write|edit|notebook|patch/i.test(name)) return <Pencil {...props} />;
  if (/read|grep|glob|search|find/i.test(name)) return <Search {...props} />;
  return <Wrench {...props} />;
}

function statusOf(tool: ToolChip, streaming: boolean, interrupted: boolean) {
  const unconfirmed = tool.status === "unknown" || (!streaming && tool.status === "running");
  const label = unconfirmed ? (interrupted ? "Interrupted" : "Unconfirmed") : tool.status === "running" ? "Running" : tool.status === "error" ? "Failed" : "Completed";
  return { unconfirmed, label };
}

function StatusMark({ tool, unconfirmed, label }: { tool: ToolChip; unconfirmed: boolean; label: string }) {
  return (
    <span className={styles.toolStatus} aria-hidden>
      {unconfirmed ? (
        <span className={styles.toolStatusText}>{label}</span>
      ) : tool.status === "running" ? (
        <span className={`${styles.toolStatusText} ${styles.toolRunning}`}>Running</span>
      ) : tool.status === "error" ? (
        <X size={13} className={styles.toolFailed} />
      ) : (
        <Check size={13} className={styles.toolDone} />
      )}
    </span>
  );
}

// The agent's reasoning: a muted line that opens onto the whole text. While
// the turn runs it stays "Thinking"; the text shows once the turn has settled.
function ThinkingRow({ tool, streaming }: { tool: ToolChip; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  const bodyId = `thinking-${useId().replace(/:/g, "")}`;
  const hidden = streaming;
  const full = (tool.result || "").trim();
  const text = (!hidden && tool.detail) || "Thinking";
  if (hidden || !full) {
    return (
      <div className={styles.thinkingRow} aria-label={hidden ? "Thinking" : `Thinking: ${text}`}>
        <Minus size={13} aria-hidden className={styles.toolIcon} />
        <span className={styles.thinkingText}>{text}</span>
      </div>
    );
  }
  return (
    <div className={styles.toolRow}>
      <button type="button" className={`${styles.thinkingRow} ${styles.thinkingButton}`} aria-expanded={open} aria-controls={bodyId} aria-label={open ? "Hide thinking" : `Show thinking: ${text}`} onClick={() => setOpen((v) => !v)}>
        <Minus size={13} aria-hidden className={styles.toolIcon} />
        <span className={styles.thinkingText}>{open ? "Thinking" : text}</span>
      </button>
      <div id={bodyId} hidden={!open}>
        {open ? <div className={styles.thinkingBody}><AssistantMarkdown text={full} /></div> : null}
      </div>
    </div>
  );
}

// A single tool row. Collapsed by default: icon, name and its detail in mono,
// then its status; click to open the output when there is one. An Edit or
// Write with its input shows the file as a chip that opens the change.
function ToolRow({ tool, streaming, interrupted }: { tool: ToolChip; streaming: boolean; interrupted: boolean }) {
  const [open, setOpen] = useState(false);
  const hasResult = Boolean(tool.result);
  const disclosureId = `tool-result-${useId().replace(/:/g, "")}`;
  const { unconfirmed, label: statusLabel } = statusOf(tool, streaming, interrupted);
  const diff = diffFromToolInput(tool.name, tool.input);
  const failed = tool.status === "error";
  const output = hasResult ? (
    <div id={disclosureId} hidden={!open}>
      <div className={`${styles.toolOutput} ${failed ? styles.toolOutputError : ""}`}>{tool.result}</div>
    </div>
  ) : null;

  if (diff) {
    return (
      <div className={styles.toolRow}>
        <div className={styles.toolRowButton} role="group" aria-label={`${tool.name} · ${baseName(diff.path)} — ${statusLabel}`}>
          {toolIcon(tool.name)}
          <span className={styles.toolName}>{tool.name}</span>
          <ToolDiffPreview preview={diff} failed={failed} />
          <span className={styles.toolSpacer} />
          {failed && hasResult ? (
            <button type="button" className={styles.toolMore} aria-label={open ? "Hide error details" : "Show error details"} aria-expanded={open} aria-controls={disclosureId} onClick={() => setOpen((o) => !o)}>
              <ChevronRight size={13} aria-hidden className={`${styles.trailChevron} ${open ? styles.trailChevronOpen : ""}`} />
            </button>
          ) : null}
          <StatusMark tool={tool} unconfirmed={unconfirmed} label={statusLabel} />
        </div>
        {failed ? output : null}
      </div>
    );
  }

  return (
    <div className={styles.toolRow}>
      <button
        type="button"
        className={styles.toolRowButton}
        aria-label={`${tool.name}${tool.detail ? ` · ${tool.detail}` : ""} — ${statusLabel}`}
        disabled={!hasResult}
        aria-expanded={hasResult ? open : undefined}
        aria-controls={hasResult ? disclosureId : undefined}
        onClick={() => hasResult && setOpen((o) => !o)}
      >
        {toolIcon(tool.name)}
        <span className={styles.toolName}>{tool.name}</span>
        {tool.detail ? <span className={styles.toolDetail}>{tool.detail}</span> : <span className={styles.toolSpacer} />}
        <StatusMark tool={tool} unconfirmed={unconfirmed} label={statusLabel} />
      </button>
      {output}
    </div>
  );
}

export function WorkTrail({ tools, streaming, outcome, hasText }: { tools: ToolChip[]; streaming?: boolean; outcome?: ChatMessage["outcome"]; hasText: boolean }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const live = Boolean(streaming);
  const rows = trailRows(tools);
  if (!live && rows.length === 0) return null;
  const list = (
    <div id={listId} hidden={!open}>
      <div className={`hivra-chat-trail-rows ${styles.trailRows}`}>
        {rows.map((tool, i) => (tool.kind === "thinking"
          ? <ThinkingRow key={tool.id || i} tool={tool} streaming={live} />
          : <ToolRow key={tool.id || i} tool={tool} streaming={live} interrupted={outcome === "stopped"} />))}
      </div>
    </div>
  );
  if (live) {
    return (
      <div className={`hivra-chat-trail ${styles.trail}`}>
        <div className={styles.trailLine}>
          <div className={styles.trailLive} role="status" aria-live="polite" aria-atomic="true">
            <span className={styles.trailOrb} aria-hidden>
              <ThinkingOrb size={20} state="working" />
            </span>
            <Shimmer className={styles.trailStep}>{liveStepLabel(tools, hasText)}</Shimmer>
          </div>
          {rows.length > 0 ? (
            <button type="button" className={styles.trailToggle} aria-expanded={open} aria-controls={listId} aria-label={open ? "Hide activity" : "Show activity"} onClick={() => setOpen((v) => !v)}>
              <ChevronRight size={12} aria-hidden className={`${styles.trailChevron} ${open ? styles.trailChevronOpen : ""}`} />
            </button>
          ) : null}
        </div>
        {list}
      </div>
    );
  }
  const { used, failed } = usedToolsLabel(tools);
  return (
    <div className={`hivra-chat-trail ${styles.trail}`}>
      <button type="button" className={styles.trailToggle} aria-expanded={open} aria-controls={listId} aria-label={failed ? `${used} · ${failed}` : used} onClick={() => setOpen((v) => !v)}>
        <span>{used}</span>
        {failed ? <span className={styles.trailFailed}>· {failed}</span> : null}
        <ChevronRight size={12} aria-hidden className={`${styles.trailChevron} ${open ? styles.trailChevronOpen : ""}`} />
      </button>
      {list}
    </div>
  );
}
