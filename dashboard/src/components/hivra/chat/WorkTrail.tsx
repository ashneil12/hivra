"use client";

// The agent's work, as one quiet line above the reply. While it works the line
// is an orb and the live step in plain words; once it is done it folds into a
// muted "Used 3 tools" that opens onto compact tool rows. Failures show inside
// the rows and as a muted "· 1 failed", never as a headline.

import { useId, useState } from "react";
import { Check, ChevronRight, Globe, Pencil, Search, Terminal, Wrench, X } from "lucide-react";
import { ThinkingOrb } from "@/components/ui/ThinkingOrb";
import { Shimmer } from "./Shimmer";
import { liveStepLabel, usedToolsLabel } from "./liveStep";
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

// A single tool row. Collapsed by default: icon, name and its detail in mono,
// then its status; click to open the output when there is one.
function ToolRow({ tool, streaming, interrupted }: { tool: ToolChip; streaming: boolean; interrupted: boolean }) {
  const [open, setOpen] = useState(false);
  const hasResult = Boolean(tool.result);
  const disclosureId = `tool-result-${useId().replace(/:/g, "")}`;
  const unconfirmed = tool.status === "unknown" || (!streaming && tool.status === "running");
  const statusLabel = unconfirmed ? (interrupted ? "Interrupted" : "Unconfirmed") : tool.status === "running" ? "Running" : tool.status === "error" ? "Failed" : "Completed";
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
        <span className={styles.toolStatus} aria-hidden>
          {unconfirmed ? (
            <span className={styles.toolStatusText}>{statusLabel}</span>
          ) : tool.status === "running" ? (
            <span className={`${styles.toolStatusText} ${styles.toolRunning}`}>Running</span>
          ) : tool.status === "error" ? (
            <X size={13} className={styles.toolFailed} />
          ) : (
            <Check size={13} className={styles.toolDone} />
          )}
        </span>
      </button>
      {hasResult ? (
        <div id={disclosureId} hidden={!open}>
          <div className={`${styles.toolOutput} ${tool.status === "error" ? styles.toolOutputError : ""}`}>{tool.result}</div>
        </div>
      ) : null}
    </div>
  );
}

export function WorkTrail({ tools, streaming, outcome, hasText }: { tools: ToolChip[]; streaming?: boolean; outcome?: ChatMessage["outcome"]; hasText: boolean }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const live = Boolean(streaming);
  if (!live && tools.length === 0) return null;
  const rows = (
    <div id={listId} hidden={!open}>
      <div className={`hivra-chat-trail-rows ${styles.trailRows}`}>
        {tools.map((tool, i) => <ToolRow key={tool.id || i} tool={tool} streaming={live} interrupted={outcome === "stopped"} />)}
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
          {tools.length > 0 ? (
            <button type="button" className={styles.trailToggle} aria-expanded={open} aria-controls={listId} aria-label={open ? "Hide activity" : "Show activity"} onClick={() => setOpen((v) => !v)}>
              <ChevronRight size={12} aria-hidden className={`${styles.trailChevron} ${open ? styles.trailChevronOpen : ""}`} />
            </button>
          ) : null}
        </div>
        {rows}
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
      {rows}
    </div>
  );
}
