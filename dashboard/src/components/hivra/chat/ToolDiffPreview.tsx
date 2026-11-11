"use client";

// Adapted from MonoCode (MIT License, Copyright (c) 2026 Nick); see THIRD_PARTY_LICENSES/monocode.txt.
//
// A quiet file chip that reveals the tool's own edit, independent of git:
// hover or focus (or a tap) opens a small popover with the lines the tool
// removed and added. MonoCode draws the popover body with its file preview;
// here the lines come straight from the Edit, MultiEdit or Write input.

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { FileText, X } from "lucide-react";
import { Popover } from "./Popover";
import { baseName, type DiffPreview } from "./toolInput";
import styles from "./chat.module.css";

export function DiffBody({ preview }: { preview: DiffPreview }) {
  return (
    <div className={styles.diff} role="group" aria-label={`Changes to ${baseName(preview.path)}`}>
      {preview.lines.map((line, index) => (
        <div key={index} className={`${styles.diffLine} ${line.kind === "add" ? styles.diffAdd : line.kind === "remove" ? styles.diffRemove : ""}`} data-diff={line.kind}>
          <span className={styles.diffMark} aria-hidden>{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : ""}</span>
          <span className={styles.diffText}>{line.text || " "}</span>
        </div>
      ))}
      {preview.truncated ? <div className={styles.diffMore}>More lines changed than are shown</div> : null}
    </div>
  );
}

export function ToolDiffPreview({ preview, failed = false, children }: { preview: DiffPreview; failed?: boolean; children?: ReactNode }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hovered = useRef(false);
  const [open, setOpen] = useState(false);
  const label = baseName(preview.path);

  const clearTimer = () => clearTimeout(timer.current);
  useEffect(() => () => clearTimeout(timer.current), []);

  const dismiss = (restoreFocus = false) => {
    clearTimer();
    // Restore before closing so focus does not reopen the preview.
    if (restoreFocus && surface.current?.contains(document.activeElement)) trigger.current?.focus();
    hovered.current = false;
    setOpen(false);
  };
  const scheduleClose = () => {
    clearTimer();
    timer.current = setTimeout(() => {
      if (!hovered.current && document.activeElement !== trigger.current && !surface.current?.contains(document.activeElement)) setOpen(false);
    }, 180);
  };

  const description = failed ? "Attempted changes, the tool did not complete" : preview.contentOnly ? "Written content, previous contents unavailable" : "Change preview";

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={styles.fileChip}
        title={preview.path}
        aria-label={`Preview ${preview.contentOnly ? "written content" : "changes"}: ${label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onPointerEnter={(event) => {
          if (event.pointerType === "touch") return;
          hovered.current = true;
          clearTimer();
          timer.current = setTimeout(() => setOpen(true), 300);
        }}
        onPointerLeave={() => {
          hovered.current = false;
          scheduleClose();
        }}
        onFocus={() => {
          clearTimer();
          setOpen(true);
        }}
        onBlur={scheduleClose}
        onClick={() => {
          clearTimer();
          setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Tab" && !event.shiftKey && open) {
            const first = surface.current?.querySelector<HTMLElement>("button, [tabindex='0']");
            if (first) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <FileText size={12} aria-hidden className={styles.fileChipIcon} />
        <span className={styles.fileChipName}>{children ?? label}</span>
        {!preview.contentOnly && (preview.added || preview.removed) ? (
          <span className={styles.fileChipStat} aria-hidden>
            {preview.added ? <span className={styles.statAdd}>+{preview.added}</span> : null}
            {preview.removed ? <span className={styles.statRemove}>−{preview.removed}</span> : null}
          </span>
        ) : null}
      </button>
      {open ? (
        <Popover
          ref={surface}
          anchor={trigger}
          id={id}
          role="dialog"
          aria-label={`${description}: ${label}`}
          tabIndex={-1}
          width={460}
          maxHeight={300}
          className={styles.diffPop}
          onDismiss={(reason) => dismiss(reason === "escape")}
          onPointerEnter={() => {
            hovered.current = true;
            clearTimer();
          }}
          onPointerLeave={() => {
            hovered.current = false;
            scheduleClose();
          }}
          onFocus={() => clearTimer()}
          onBlur={scheduleClose}
        >
          <div className={styles.diffHead}>
            <span className={styles.diffHeadText}>{description}</span>
            <button type="button" aria-label="Close preview" className={styles.diffClose} onClick={() => dismiss(true)}>
              <X size={12} aria-hidden />
            </button>
          </div>
          <DiffBody preview={preview} />
        </Popover>
      ) : null}
    </>
  );
}
