"use client";

import { useEffect, useRef, useState } from "react";
import { copyTextToClipboard } from "@/lib/client/clipboard";
import { desktopClipboardCopy, desktopClipboardPaste, desktopClipboardSet } from "@/lib/hivra/agent-api";
import styles from "./ClaudeAppSwitch.module.css";

const NOTE_MS = 4_000;

/**
 * The owner's clipboard switch for the desktop, in the Desktop strip.
 *
 * Off by default. The stream itself never syncs the clipboard: with the switch
 * on, text moves only when the owner presses Paste in (their clipboard into the
 * desktop's) or Copy out (the desktop's clipboard into theirs). When the browser
 * will not hand over its clipboard, a small box takes the text instead.
 */
export function DesktopClipboard({ boxUrl, token, enabled, onChanged }: {
  boxUrl: string;
  token?: string | null;
  enabled: boolean;
  onChanged: (enabled: boolean) => void;
}) {
  const [busy, setBusy] = useState<null | "switch" | "paste" | "copy">(null);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const [manual, setManual] = useState<null | { kind: "paste"; text: string } | { kind: "copy"; text: string }>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const manualRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => () => { if (noteTimer.current) clearTimeout(noteTimer.current); }, []);
  useEffect(() => {
    if (!manual || !manualRef.current) return;
    manualRef.current.focus();
    if (manual.kind === "copy") manualRef.current.select();
  }, [manual]);

  function say(text: string, error = false) {
    if (noteTimer.current) clearTimeout(noteTimer.current);
    setNote({ text, error });
    noteTimer.current = setTimeout(() => setNote(null), error ? NOTE_MS * 2 : NOTE_MS);
  }

  async function toggle() {
    if (busy) return;
    setBusy("switch"); setManual(null);
    const result = await desktopClipboardSet(boxUrl, !enabled, token);
    setBusy(null);
    if (!result.ok) { say(result.error || "The clipboard could not be switched.", true); return; }
    onChanged(result.clipboard === true);
    say(result.clipboard ? "Clipboard on. Use Paste in and Copy out." : "Clipboard off.");
  }

  async function sendIn(text: string) {
    setBusy("paste");
    const result = await desktopClipboardPaste(boxUrl, text, token);
    setBusy(null);
    if (!result.ok) { say(result.error || "The text could not be pasted into the desktop.", true); return false; }
    say("Ready. Press Ctrl+V in the desktop.");
    return true;
  }

  async function pasteIn() {
    if (busy) return;
    let text: string | null = null;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.readText) text = await navigator.clipboard.readText();
    } catch {
      text = null;
    }
    // The browser said no (or has nothing to read): let the owner paste it here instead.
    if (text === null || text === "") { setManual({ kind: "paste", text: "" }); return; }
    setManual(null);
    await sendIn(text);
  }

  async function copyOut() {
    if (busy) return;
    setBusy("copy"); setManual(null);
    const result = await desktopClipboardCopy(boxUrl, token);
    setBusy(null);
    if (!result.ok) { say(result.error || "The desktop clipboard could not be read.", true); return; }
    const text = result.text ?? "";
    if (!text) { say("The desktop clipboard is empty."); return; }
    if (await copyTextToClipboard(text)) { say("Copied to your clipboard."); return; }
    setManual({ kind: "copy", text });
  }

  return (
    <>
      <span className={styles.segment}>
        <button
          type="button"
          className={styles.option}
          aria-pressed={enabled}
          data-selected={enabled ? "true" : undefined}
          disabled={busy === "switch"}
          title={enabled ? "Turn the desktop clipboard off" : "Turn the desktop clipboard on for this computer"}
          onClick={() => void toggle()}
        >
          {enabled ? "Clipboard on" : "Clipboard off"}
        </button>
      </span>
      {enabled ? (
        <>
          <button type="button" className={styles.action} disabled={busy !== null} onClick={() => void pasteIn()}
            title="Put your clipboard on the desktop's clipboard">
            Paste in
          </button>
          <button type="button" className={styles.action} disabled={busy !== null} onClick={() => void copyOut()}
            title="Put the desktop's clipboard on yours">
            Copy out
          </button>
        </>
      ) : null}
      {note ? <span className={note.error ? styles.error : styles.progress} role={note.error ? "alert" : "status"}>{note.text}</span> : null}
      {manual ? (
        <div className={styles.panel} role="dialog" aria-label={manual.kind === "paste" ? "Paste into the desktop" : "Copy from the desktop"}>
          <p className={styles.panelTitle}>{manual.kind === "paste" ? "Paste into the desktop" : "Copy from the desktop"}</p>
          <p>
            {manual.kind === "paste"
              ? "Your browser did not share its clipboard. Paste the text here and send it."
              : "Your browser blocked copying. The text is selected: press Ctrl+C (or ⌘C)."}
          </p>
          <textarea
            ref={manualRef}
            className={styles.clipboardText}
            aria-label={manual.kind === "paste" ? "Text to paste into the desktop" : "Text from the desktop"}
            value={manual.text}
            readOnly={manual.kind === "copy"}
            rows={4}
            onChange={(event) => setManual({ kind: "paste", text: event.target.value })}
          />
          <div className={styles.panelActions}>
            {manual.kind === "paste" ? (
              <button type="button" className={styles.primary} disabled={!manual.text || busy !== null}
                onClick={async () => { if (await sendIn(manual.text)) setManual(null); }}>
                Send to desktop
              </button>
            ) : null}
            <button type="button" className={styles.action} onClick={() => setManual(null)}>Close</button>
          </div>
        </div>
      ) : null}
    </>
  );
}
