"use client";

// Motion for the homepage: one provider, one preference, shared tokens.
//
// - LazyMotion with domAnimation keeps framer-motion's cost to what we use.
// - Motion is off when the visitor asks the OS for reduced motion, or turns it
//   off with the page's own switch (stored as "hivra-motion", read in a
//   try/catch so the page still renders when storage is blocked).
// - Every scene renders its finished state when motion is off, so nothing is
//   ever hidden behind an animation.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { LazyMotion, domAnimation, transform, useAnimationControls, useTransform, type MotionValue, type TargetAndTransition, type Transition } from "framer-motion";

export const EASE_OUT = [0.16, 1, 0.3, 1] as const;
export const EASE_IN_OUT = [0.65, 0, 0.35, 1] as const;

const STORAGE_KEY = "hivra-motion";
const MOTION_EVENT = "hivra-motion-change";

interface MotionPref {
  /** True when animations should not run. */
  off: boolean;
  /** True once the client has read the visitor's preferences. */
  ready: boolean;
  setUserOff: (off: boolean) => void;
}

const MotionPrefContext = createContext<MotionPref>({ off: false, ready: false, setUserOff: () => {} });

// Browser state is read through useSyncExternalStore: the server snapshot is
// used while hydrating, so the first client render always matches the HTML,
// and React re-renders with the real value straight after.

const noopSubscribe = () => () => {};

/** False on the server and while hydrating, true afterwards. */
export function useHydrated(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}

function subscribeMedia(query: string) {
  return (onChange: () => void) => {
    if (typeof window.matchMedia !== "function") return () => {};
    const mq = window.matchMedia(query);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  };
}

/** A media query's current answer; `fallback` on the server and while hydrating. */
export function useMediaQuery(query: string, fallback = false): boolean {
  const subscribe = useMemo(() => subscribeMedia(query), [query]);
  return useSyncExternalStore(
    subscribe,
    () => (typeof window.matchMedia === "function" ? window.matchMedia(query).matches : fallback),
    () => fallback,
  );
}

function readStoredOff(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "off";
  } catch {
    return false;
  }
}

function subscribeStoredOff(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(MOTION_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(MOTION_EVENT, onChange);
  };
}

export function HomeMotion({ children }: { children: ReactNode }) {
  const systemReduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const userOff = useSyncExternalStore(subscribeStoredOff, readStoredOff, () => false);
  const ready = useHydrated();

  const setUserOff = useCallback((next: boolean) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "off" : "on");
    } catch {
      /* storage blocked: nothing to remember it in */
    }
    window.dispatchEvent(new Event(MOTION_EVENT));
  }, []);

  const off = systemReduced || userOff;
  const value = useMemo(() => ({ off, ready, setUserOff }), [off, ready, setUserOff]);

  return (
    <LazyMotion features={domAnimation} strict>
      <MotionPrefContext.Provider value={value}>
        <div data-home-motion={off ? "off" : "on"} style={{ display: "contents" }}>
          {children}
        </div>
      </MotionPrefContext.Provider>
    </LazyMotion>
  );
}

export function useMotionPref(): MotionPref {
  return useContext(MotionPrefContext);
}

/**
 * True when the element is at least `amount` visible. Pass `key` when the ref
 * can move to a different element (a layout that swaps), so it re-attaches.
 * Without IntersectionObserver (tests, old browsers) it reports visible.
 */
export function useVisible(
  ref: RefObject<Element | null>,
  { amount = 0.25, once = false, key }: { amount?: number; once?: boolean; key?: unknown } = {},
): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      const id = window.setTimeout(() => setVisible(true), 0);
      return () => window.clearTimeout(id);
    }
    let seen = false;
    const observer = new IntersectionObserver(
      ([entry]) => {
        const next = entry.isIntersecting && entry.intersectionRatio >= amount * 0.999;
        if (once && seen) return;
        if (next) seen = true;
        setVisible(next);
        if (once && next) observer.disconnect();
      },
      { threshold: [0, amount, 1] },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, amount, once, key]);
  return visible;
}

/**
 * An entrance that never hides server-rendered content: the element renders
 * visible, and only once the script runs and it is still out of view does it
 * drop to `hidden`, ready to play `shown` when it arrives.
 */
export function useArmedEntrance(inView: boolean, hidden: TargetAndTransition, shown: TargetAndTransition, transition: Transition) {
  const controls = useAnimationControls();
  const { off } = useMotionPref();
  const armed = useRef(false);
  const played = useRef(false);
  useEffect(() => {
    if (off) {
      controls.set(shown);
      return;
    }
    if (!armed.current) {
      armed.current = true;
      if (!inView) controls.set(hidden);
    }
    if (inView && !played.current) {
      played.current = true;
      void controls.start({ ...shown, transition });
    }
    // The targets are constants at each call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inView, off, controls]);
  return controls;
}

/**
 * Maps a scroll-linked value through ranges, like useTransform(value, input,
 * output), but always on the main thread. Given plain ranges, framer-motion
 * hands scroll values to the browser's native scroll timelines, and those
 * measure a tall pinned section's range differently from useScroll, so the
 * page would show one thing while the scene believes another.
 */
export function useRange(value: MotionValue<number>, input: number[], output: number[]): MotionValue<number>;
export function useRange(value: MotionValue<number>, input: number[], output: string[]): MotionValue<string>;
export function useRange(value: MotionValue<number>, input: number[], output: number[] | string[]): MotionValue<number> | MotionValue<string> {
  const key = JSON.stringify([input, output]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const map = useMemo(() => transform(input, output as number[]) as (v: number) => number, [key]);
  return useTransform(value, (v: number) => map(v));
}

/** True on wide screens, where the pinned scroll scenes run. */
export function useWideScreen(query = "(min-width: 1000px)"): boolean {
  return useMediaQuery(query);
}

function subscribeVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

/** False while the tab is hidden, so nothing animates unseen. */
export function usePageVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, () => document.visibilityState !== "hidden", () => true);
}

/**
 * Reveals `lines` one at a time, typing each, while `running`. Returns the
 * number of fully shown lines and the partial text of the line being typed.
 * With motion off it returns everything at once.
 */
export function useTypedLines(lines: readonly string[], running: boolean, { cps = 48, pause = 380, startDelay = 250 } = {}) {
  const { off } = useMotionPref();
  const [state, setState] = useState({ done: 0, partial: "" });
  const [run, setRun] = useState(0);
  // Where typing stopped, so pausing (running=false) and resuming carry on.
  const progress = useRef({ line: 0, chars: 0 });
  // Keyed by content, not array identity, so an inline array cannot restart it.
  const key = lines.join("\n");

  useEffect(() => {
    if (off || !running) return;
    const list = key.split("\n");
    const show = (done: number, partial: string) =>
      setState(prev => (prev.done === done && prev.partial === partial ? prev : { done, partial }));
    let timer: number | null = null;
    const tick = () => {
      const p = progress.current;
      if (p.line >= list.length) return;
      const text = list[p.line];
      if (p.chars < text.length) {
        p.chars = Math.min(text.length, p.chars + Math.max(1, Math.round(cps / 30)));
        show(p.line, text.slice(0, p.chars));
        timer = window.setTimeout(tick, 1000 / 30);
      } else {
        p.line += 1;
        p.chars = 0;
        show(p.line, "");
        timer = window.setTimeout(tick, pause);
      }
    };
    const fresh = progress.current.line === 0 && progress.current.chars === 0;
    timer = window.setTimeout(tick, fresh ? startDelay : 60);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [running, off, key, cps, pause, startDelay, run]);

  const restart = useCallback(() => {
    progress.current = { line: 0, chars: 0 };
    setState({ done: 0, partial: "" });
    setRun(value => value + 1);
  }, []);
  // With motion off everything is shown at once, derived rather than stored.
  if (off) return { done: lines.length, partial: "", finished: true, restart };
  return { ...state, finished: state.done >= lines.length, restart };
}
