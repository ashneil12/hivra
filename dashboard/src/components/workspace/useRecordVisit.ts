"use client";

import { useEffect, useRef } from "react";

import type { AgentSurfaceId } from "@/lib/agent-computers/agent-surfaces";
import { recordVisit } from "@/lib/workspace/recents";

/** Quick hops between surfaces settle before the one you stay on is written. */
export const VISIT_DEBOUNCE_MS = 400;

/**
 * Remembers that `uid` is open on `tab`, for Home's "Pick up where you left
 * off" and the switchers' Recent group.
 *
 * Opening a resource is recorded at once, so leaving it straight away still
 * leaves it in Recent. Moving between its surfaces is debounced, and a move
 * not yet written when the resource closes is written then. Pass null while
 * the resource is not open (still loading, not found): nothing is recorded.
 */
export function useRecordVisit(uid: string | null, tab: AgentSurfaceId | null): void {
  const opened = useRef<string | null>(null);
  const pending = useRef<{ uid: string; tab: AgentSurfaceId } | null>(null);

  useEffect(() => {
    if (!uid || !tab) return;
    if (opened.current !== uid) {
      const previous = pending.current;
      if (previous) recordVisit(previous.uid, previous.tab);
      opened.current = uid;
      pending.current = null;
      recordVisit(uid, tab);
      return;
    }
    pending.current = { uid, tab };
    const timer = window.setTimeout(() => {
      pending.current = null;
      recordVisit(uid, tab);
    }, VISIT_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [uid, tab]);

  useEffect(() => () => {
    const last = pending.current;
    if (last) recordVisit(last.uid, last.tab);
  }, []);
}
