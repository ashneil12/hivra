// One confirm for every delete Ash can do from the sidebar and the rail (r30d; Critiquito, 22 Oct): a session, a chat (a
// Mono's 1:1, a team's sub-chat) and a room. It names what goes ("Delete Example: tidy the README?"), says it can't be
// undone, and offers Cancel and a red Delete. Cancel has the focus, so Enter (or Escape, or a click outside) cancels:
// nothing is deleted by a stray key. Callers that need more (an unused worktree to clear too) put it in `children`.
import { plainTitle } from "../text/plainTitle";
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { Modal } from "./Modal";

/**
 * Cancel's focus ring (r30e, Critiquito): shown whenever it has focus, from the moment the dialog opens and after a
 * mouse click too (`focus:`, not `focus-visible:`), so Ash can see Enter is the safe key. The app's accent ring, set off
 * by a solid ring of the dialog's own surface so it never sits on bare glass. In the light theme the accent alone is
 * under 3:1 (2.69:1), so `confirm-cancel-ring` (index.css) mixes it toward the text colour there (r30f).
 */
export const CANCEL_FOCUS_RING =
  "confirm-cancel-ring focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-background-base";

/**
 * The red Delete (r30g): the app's danger style, a red tint with red text. Dark is as it was (red-400 on red-500/20).
 * In the light theme red-400 on that tint measured 2.02:1, so there it is red-700 on a lighter tint (red-500/10),
 * over 4.5:1 (`dark:` here means "not the light theme", index.css).
 */
export const DELETE_DANGER =
  "bg-red-500/10 text-red-700 hover:bg-red-500/15 dark:bg-red-500/20 dark:text-red-400 dark:hover:bg-red-500/30";

/**
 * The name as the confirm title shows it (Alfred's r50 blind run, 22 Oct): a chat's title is often its first message, so
 * it can hold markdown ("The current branch is **pm/pages-live**...") or end in its own punctuation ("…changed."), which
 * read as "Delete The current branch is **pm/pages-live**...?" and "…changed.?". Plain text only: markdown marks dropped,
 * one line, trailing punctuation trimmed, and cut at a word near 60 characters with an ellipsis. The title quotes it
 * (Critiquito), so a cut name reads “build…”? rather than build...?
 */
export function confirmTitleName(raw: string, max = 60): string {
  let s = plainTitle(raw);
  let cut = false;
  if (s.length > max) {
    const at = s.lastIndexOf(" ", max);
    s = s.slice(0, at > max * 0.6 ? at : max);
    cut = true;
  }
  // A title that arrives already cut ("…from the MonoCode…" or "...") keeps its cut mark, so it doesn't read as a sentence.
  if (/(\u2026|\.{3})\s*$/u.test(s)) cut = true;
  s = s.replace(/[\s.,;:!?\u2026-]+$/u, "");
  if (!s) return "this";
  return cut ? `${s}\u2026` : s;
}

export function ConfirmDelete({
  name,
  detail,
  children,
  deleteLabel = "Delete",
  onCancel,
  onDelete,
}: {
  /** What is deleted, as Ash knows it: a session's or chat's title, a room's name. */
  name: string;
  /** Said before "This can't be undone.", e.g. what else goes with a Mono. */
  detail?: string;
  children?: ReactNode;
  deleteLabel?: string;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancel.current?.focus();
  }, []);
  return (
    <Modal title={`Delete “${confirmTitleName(name)}”?`} size="sm" hideClose onClose={onCancel} scrimClassName="confirm-scrim">
      <div className="flex flex-col gap-4 px-4 pb-4 pt-2 text-[12px]" data-confirm-delete={name}>
        <p className="text-content/80">{detail ? `${detail} ` : ""}This can't be undone.</p>
        {children}
        <div className="flex justify-end gap-2">
          <button
            ref={cancel}
            type="button"
            data-confirm-delete-cancel
            onClick={onCancel}
            className={`rounded-md px-3 py-1.5 text-content/85 hover:bg-content/8 active:scale-[0.97] ${CANCEL_FOCUS_RING}`}
          >
            Cancel
          </button>
          <button
            type="button"
            data-confirm-delete-ok
            onClick={onDelete}
            className={`rounded-md px-3 py-1.5 font-medium ring-red-400/50 focus-visible:outline-none focus-visible:ring-2 active:scale-[0.97] ${DELETE_DANGER}`}
          >
            {deleteLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---- asked from anywhere: `await confirmDelete("Example: tidy the README")` -------------------------------------------

type Ask = { name: string; detail?: string; resolve: (ok: boolean) => void };
let current: Ask | undefined;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

/** Ask Ash to confirm deleting `name`; true only when he picked Delete. One question at a time: a second waits as no. */
export function confirmDelete(name: string, detail?: string): Promise<boolean> {
  if (current) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    current = { name: name.trim() || "this", detail, resolve };
    emit();
  });
}

function answer(ok: boolean): void {
  const ask = current;
  current = undefined;
  emit();
  ask?.resolve(ok);
}

/** Tests: drop a question left open. */
export function resetConfirmDelete(): void {
  if (current) answer(false);
}

/** Where `confirmDelete` shows: mounted once in the app's window. */
export function ConfirmDeleteHost() {
  const ask = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => current,
  );
  if (!ask) return null;
  return <ConfirmDelete key={ask.name} name={ask.name} detail={ask.detail} onCancel={() => answer(false)} onDelete={() => answer(true)} />;
}
