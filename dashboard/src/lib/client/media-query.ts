// Media queries as React state. Browser state is read through useSyncExternalStore: the
// fallback is the server answer and the answer while hydrating, so the first client
// render matches the HTML and React re-renders with the real value straight after.
// Client-only: nothing here touches the server.

import { useMemo, useSyncExternalStore } from "react";

/** Calls `onChange` when a media query's answer changes. A no-op where matchMedia is missing. */
export function subscribeMedia(query: string) {
  return (onChange: () => void): (() => void) => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
    const list = window.matchMedia(query);
    list.addEventListener?.("change", onChange);
    return () => list.removeEventListener?.("change", onChange);
  };
}

/** A media query's answer right now; false where matchMedia is missing or there is no window. */
export function matchesMedia(query: string): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

/** A media query's current answer; `fallback` on the server and while hydrating. */
export function useMediaQuery(query: string, fallback = false): boolean {
  const subscribe = useMemo(() => subscribeMedia(query), [query]);
  return useSyncExternalStore(
    subscribe,
    () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : fallback),
    () => fallback,
  );
}
