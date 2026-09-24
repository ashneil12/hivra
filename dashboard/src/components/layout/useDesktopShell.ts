"use client";

import { useSyncExternalStore } from "react";
import { isDesktopShell } from "@/lib/desktop-shell";

// The signal is fixed for the document's lifetime: the marker is non-writable
// and the user agent never changes, so there is nothing to subscribe to.
const subscribe = () => () => {};
const serverSnapshot = () => false;

/**
 * True inside a desktop app, after hydration. The first client render matches
 * the server (false); CSS keyed on html[data-shell="desktop"] already hides the
 * chrome before then. Presentation only: never gate data or trust on it.
 */
export function useDesktopShell(): boolean {
  return useSyncExternalStore(subscribe, isDesktopShell, serverSnapshot);
}
