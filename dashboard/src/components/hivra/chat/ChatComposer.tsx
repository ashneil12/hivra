"use client";

// Adapted from MonoCode (MIT License, Copyright (c) 2026 Nick); see THIRD_PARTY_LICENSES/monocode.txt.
//
// The composer, after MonoCode's: a queue card above it, a rounded glass box
// holding the input, its attachments and one toolbar row (attach, the model
// and effort pill, the access pill, the context ring, and send), where send is
// a stop square while the agent works with nothing typed and queues what is
// typed. No footer hint and no words on the buttons; every control keeps its
// accessible name. Files dropped on the chat attach here (see useFileDrop).

import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { ArrowUp, FileText, Plus, Square, X } from "lucide-react";
import { ThinkingOrb } from "@/components/ui/ThinkingOrb";
import { AccessPicker } from "./AccessPicker";
import { ContextMeter } from "./ContextMeter";
import type { ContextUsage } from "./contextUsage";
import { MessageQueue, type QueuedMessage } from "./MessageQueue";
import { ModelPicker } from "./ModelPicker";
import type { BoxChatControls } from "./useBoxChatControls";
import styles from "./chat.module.css";

export const MAX_ATTACHMENTS = 5;

export interface ComposerAttachment {
  name: string;
  path: string;
  /** An object URL for an image, to show it as a small picture. */
  preview?: string;
}

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
  /** The model the agent runs, shown muted when the pickers have nothing to change. */
  modelLabel: string;
  /** The model, effort and access the computer lets the owner change. */
  controls?: BoxChatControls;
  /** How full the model's context is, once the stream has said. */
  context?: ContextUsage;
  /** What was sent while the agent was working, and goes out when it is done. */
  queued?: readonly QueuedMessage[];
  queuePaused?: boolean;
  onQueueDelete?: (id: string) => void;
  onQueueEdit?: (id: string, text: string) => void;
  onQueueResume?: () => void;
  /** A file is being dragged over the chat. */
  fileDrag?: boolean;
  /** Without a token the box takes no uploads, so attach and paste are off. */
  canUpload: boolean;
  attachments: ComposerAttachment[];
  onRemoveAttachment: (path: string) => void;
  uploading: boolean;
  attachError: string | null;
  onUploadFile: (file: File) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  dockRef: RefObject<HTMLDivElement | null>;
  /** Rows above the composer: Retry, "Return to latest". */
  children?: ReactNode;
}

export function ChatComposer({
  agentName, input, onInputChange, onSend, onStop, busy, coarsePointer, composerCap, modelLabel, controls, context,
  queued = [], queuePaused = false, onQueueDelete, onQueueEdit, onQueueResume, fileDrag = false,
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

  const hasValue = Boolean(input.trim());
  const pickerShown = Boolean(controls && (controls.models.length > 0 || controls.effortLevels.length > 0));
  const focusInput = () => textareaRef.current?.focus();

  return (
    <div ref={dockRef} className={styles.dock}>
      {children}
      <div className={styles.composer} data-composer>
        <MessageQueue
          messages={queued}
          paused={queuePaused}
          onDelete={(id) => onQueueDelete?.(id)}
          onEdit={(id, text) => onQueueEdit?.(id, text)}
          onResume={() => onQueueResume?.()}
        />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSend(input);
          }}
          className={`${styles.box} ${fileDrag ? styles.boxDrop : ""}`}
          data-composer-box
        >
          {fileDrag ? <div className={styles.dropHint}>Drop files to attach</div> : null}
          {attachments.length > 0 ? (
            <div className={styles.chips}>
              {attachments.map((a) => (a.preview ? (
                <span key={a.path} className={styles.thumb} title={a.name}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={a.preview} alt="" draggable={false} className={styles.thumbImage} />
                  <button type="button" aria-label={`Remove ${a.name}`} onClick={() => onRemoveAttachment(a.path)} className={styles.thumbRemove}>
                    <X size={11} strokeWidth={2} aria-hidden />
                  </button>
                </span>
              ) : (
                <span key={a.path} className={styles.chip2} title={a.name}>
                  <FileText size={12} aria-hidden className={styles.chipIcon} />
                  <span className={styles.chipLabel}>{a.name}</span>
                  <button type="button" aria-label={`Remove ${a.name}`} onClick={() => onRemoveAttachment(a.path)} className={styles.chipRemove}>
                    <X size={11} aria-hidden />
                  </button>
                </span>
              )))}
            </div>
          ) : null}
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
          <div className={styles.toolbar}>
            {canUpload ? (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*,.txt,.md,.csv,.json,.log"
                  multiple
                  style={{ display: "none" }}
                  onChange={(e) => {
                    for (const f of Array.from(e.target.files ?? [])) onUploadFile(f);
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  aria-label="Attach a file"
                  title="Attach an image or text file (the agent reads it on its computer)"
                  disabled={uploading || attachments.length >= MAX_ATTACHMENTS}
                  onClick={() => fileInputRef.current?.click()}
                  className={styles.toolButton}
                >
                  {uploading ? <ThinkingOrb size={20} state="working" label="Uploading" /> : <Plus size={14} strokeWidth={1.5} aria-hidden />}
                </button>
              </>
            ) : null}
            <div className={styles.pills}>
              {controls && pickerShown ? (
                <ModelPicker
                  modelName={controls.modelName}
                  model={controls.model}
                  models={controls.models}
                  onModelChange={controls.changeModel}
                  effortLevels={controls.effortLevels}
                  effort={controls.effort}
                  onEffortChange={controls.changeEffort}
                  pending={controls.pending}
                  busy={busy}
                  onClose={focusInput}
                />
              ) : (
                <span className={styles.modelStatic} title="The model this agent is currently running">{modelLabel}</span>
              )}
              {controls && controls.restrict !== null ? (
                <AccessPicker value={controls.restrict} onChange={controls.changeRestrict} busy={busy} agentKind={controls.agentKind} onClose={focusInput} />
              ) : null}
            </div>
            <span className={styles.toolbarSpacer} />
            <ContextMeter usage={context} />
            {busy && !hasValue ? (
              <button type="button" onClick={onStop} aria-label="Stop response" title="Stop" className={`${styles.send} ${styles.sendStop}`}>
                <Square size={11} fill="currentColor" strokeWidth={0} aria-hidden />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!hasValue}
                aria-label={busy ? "Queue message" : "Send message"}
                title={busy ? "Queue: it goes out when this reply is done" : "Send"}
                className={styles.send}
              >
                <ArrowUp size={15} strokeWidth={2.25} aria-hidden />
              </button>
            )}
          </div>
        </form>
        {attachError || controls?.error ? (
          <p role="alert" className={styles.attachError}>{attachError || controls?.error}</p>
        ) : null}
      </div>
    </div>
  );
}
