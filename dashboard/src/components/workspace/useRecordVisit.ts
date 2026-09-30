"use client";

import { useEffect, useLayoutEffect, useRef } from "react";

import type { AgentSurfaceId } from "@/lib/agent-computers/agent-surfaces";
import { recordVisit } from "@/lib/workspace/recents";

/** Quick hops between surfaces settle before the one you stay on is written. */
export const VISIT_DEBOUNCE_MS = 400;

interface Shown {
  uid: string;
  tab: AgentSurfaceId;
}

/**
 * Remembers that `uid` is in use on `tab`, for Home's "Pick up where you left
 * off" and the switchers' Recent group, which list what you used last first.
 *
 * Opening a resource is recorded at once, so leaving it straight away still
 * leaves it in Recent. Moving between its surfaces is debounced. It is recorded
 * again, on the surface on screen, when it is left (this view closes or moves
 * to another resource), when its browser tab is hidden or shown, and when the
 * page is closed. Recording only on open put a resource open in one browser tab
 * for hours behind one opened and closed in another, so Home offered the wrong
 * one. Pass null while the resource is not open (still loading, not found):
 * nothing is recorded.
 */
export function useRecordVisit(uid: string | null, tab: AgentSurfaceId | null): void {
  const shown = useRef<Shown | null>(null);

  useEffect(() => {
    const previous = shown.current;
    if (!uid || !tab) {
      // No longer on screen, such as the next resource still loading here.
      shown.current = null;
      if (previous) recordVisit(previous.uid, previous.tab);
      return;
    }
    shown.current = { uid, tab };
    if (previous?.uid === uid) {
      const timer = window.setTimeout(() => recordVisit(uid, tab), VISIT_DEBOUNCE_MS);
      return () => window.clearTimeout(timer);
    }
    // Leaving one resource for another in the same view: the first was in use
    // until now, and the second is the most recent.
    if (previous) recordVisit(previous.uid, previous.tab);
    recordVisit(uid, tab);
  }, [uid, tab]);

  // A layout clean-up, so leaving is written before the next page's first
  // layout pass (Home reads the order there) rather than after it paints.
  useLayoutEffect(() => {
    const recordShown = () => {
      const current = shown.current;
      if (current) recordVisit(current.uid, current.tab);
    };
    window.addEventListener("pagehide", recordShown);
    document.addEventListener("visibilitychange", recordShown);
    return () => {
      window.removeEventListener("pagehide", recordShown);
      document.removeEventListener("visibilitychange", recordShown);
      recordShown();
    };
  }, []);
}
