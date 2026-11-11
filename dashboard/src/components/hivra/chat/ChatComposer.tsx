"use client";

// Adapted from MonoCode (MIT License, Copyright (c) 2026 Nick); see THIRD_PARTY_LICENSES/monocode.txt.
//
// The composer, after MonoCode's: a thin model line above, a rounded glass
// input with the send button inside it (a stop square while the agent works),
// and a row of quiet icon buttons below it (attach, think). No footer hint and
// no words on the buttons; every control keeps its accessible name.

import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { ArrowUp, Brain, Paperclip, Plus, Square, X } from "lucide-react";
import { ThinkingOrb } from "@/components/ui/ThinkingOrb";
import styles from "./chat.module.css";

export const MAX_ATTACHMENTS = 5;

interface ChatComposerProps {
  agentName: string;
  input: string;
  onInputChange: (value: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  busy: boolean;
  /** Touch keyboards have no Shift+Enter, so there Return inserts a newline. */
  coarsePointer: boolean;
  /** The textarea grows with its text up to this many pixels. */
  composerCap: number;
  /** The model the agent runs, shown muted above the input. */
  modelLabel: string;
  think: boolean;
  onToggleThink: () => void;
  /** Without a token the box takes no uploads, so attach and paste are off. */
  canUpload: boolean;
  attachments: { name: string; path: string }[];
  onRemoveAttachment: (path: string) => void;
  uploading: boolean;
  attachError: string | null;
  onUploadFile: (file: File) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  dockRef: RefObject<HTMLDivElement | null>;
  /** Rows above the model line: Retry, "Return to latest". */
  children?: ReactNode;
}

export function ChatComposer({
  agentName, input, onInputChange, onSend, onStop, busy, coarsePointer, composerCap, modelLabel, think, onToggleThink,
  canUpload, attachments, onRemoveAttachment, uploading, attachError, onUploadFile, textareaRef, dockRef, children,
}: ChatComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  // The box grows with what is typed, up to its cap, and shrinks back.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.max(44, Math.min(textarea.scrollHeight, composerCap))}px`;
    textarea.style.overflowY = textarea.scrollHeight > composerCap ? "auto" : "hidden";
  }, [input, composerCap, textareaRef]);

  return (
    <div ref={dockRef} className={styles.dock}>
      {children}
      <div className={styles.composer}>
        <div className={styles.modelRow}>
          <span className={styles.modelRule} aria-hidden />
          <span className={styles.modelName} title="The model this agent is currently running">{modelLabel}</span>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSend(input);
          }}
          className={styles.box}
        >
          {attachments.length > 0 ? (
            <div className={styles.chips}>
              {attachments.map((a) => (
                <span key={a.path} className={styles.chip2}>
                  <Paperclip size={11} aria-hidden className={styles.chipIcon} />
                  <span className={styles.chipLabel}>{a.name}</span>
                  <button type="button" aria-label={`Remove ${a.name}`} onClick={() => onRemoveAttachment(a.path)} className={styles.chipRemove}>
                    <X size={11} aria-hidden />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <div className={styles.field}>
            <textarea
              ref={textareaRef}
              aria-label={`Message ${agentName}`}
              value={input}
              onChange={(e) => onInputChange(e.target.value)}
              onKeyDown={(e) => {
                if (coarsePointer) return;
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  onSend(input);
                }
              }}
              onPaste={(e) => {
                if (!canUpload) return;
                const item = Array.from(e.clipboardData?.items || []).find((i) => i.type.startsWith("image/"));
                const f = item?.getAsFile();
                if (f) { e.preventDefault(); onUploadFile(f); }
              }}
              rows={1}
              placeholder={`Message ${agentName}`}
              enterKeyHint={coarsePointer ? "enter" : "send"}
              autoCapitalize="sentences"
              className={`hivra-chat-composer ${styles.textarea}`}
              style={{ maxHeight: composerCap }}
            />
            {busy ? (
              <button type="button" onClick={onStop} aria-label="Stop response" title="Stop" className={`${styles.send} ${styles.sendStop}`}>
                <Square size={11} fill="currentColor" strokeWidth={0} aria-hidden />
              </button>
            ) : (
              <button type="submit" disabled={!input.trim()} aria-label="Send message" title="Send" className={styles.send}>
                <ArrowUp size={15} strokeWidth={2.25} aria-hidden />
              </button>
            )}
          </div>
        </form>
        <div className={styles.tools}>
          {canUpload ? (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,.txt,.md,.csv,.json,.log"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onUploadFile(f);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                aria-label="Attach a file"
                title="Attach an image or text file (the agent reads it on the box)"
                disabled={busy || uploading || attachments.length >= MAX_ATTACHMENTS}
                onClick={() => fileInputRef.current?.click()}
                className={styles.toolButton}
              >
                {uploading ? <ThinkingOrb size={20} state="working" label="Uploading" /> : <Plus size={16} aria-hidden />}
              </button>
            </>
          ) : null}
          {/* Hidden below md until the box confirms it reads the reasoning flag. */}
          <button
            type="button"
            role="switch"
            aria-checked={think}
            aria-label="Toggle extended reasoning"
            title="Think: let the agent reason for longer before answering"
            onClick={onToggleThink}
            className={`${styles.toolButton} ${styles.thinkButton} ${think ? styles.toolOn : ""}`}
          >
            <Brain size={15} aria-hidden fill={think ? "currentColor" : "none"} fillOpacity={think ? 0.28 : 0} />
          </button>
        </div>
        {attachError ? (
          <p role="alert" className={styles.attachError}>{attachError}</p>
        ) : null}
      </div>
    </div>
  );
}
