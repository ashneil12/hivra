"use client";

import { useEffect, useRef, useSyncExternalStore, type CSSProperties } from "react";
import { ThinkingOrb as TunedOrb, type OrbState } from "thinking-orbs";
import { MODE_FRAMES, paintFrame, resolvePreset } from "thinking-orbs/engine";

/**
 * Hivra's activity mark: a dotted "thinking orb" (thinking-orbs, MIT, by Jakub
 * Antalik). Monochrome ink that follows the page theme, so it sits on the glass
 * like any other text.
 *
 * Sizes 20, 32 and 64 use the library's hand-tuned presets. Any other size
 * (the homepage hero, empty states) draws the same frame at that size from the
 * 64 px preset, since the frame functions themselves are resolution-free.
 *
 * Which state to use:
 * - `working`: an agent or job is running (default)
 * - `connecting`: provisioning, connecting a server, waking a computer
 * - `searching`: loading a list or looking something up
 * - `composing`: an agent is writing a reply
 * - `breathing`: idle, waiting, empty state
 */
export type HivraOrbState = OrbState;

type Props = {
  state?: HivraOrbState;
  size?: number;
  /** Pin the ink. `auto` follows the `dark` class on <html>. */
  theme?: "auto" | "dark" | "light";
  speed?: number;
  label?: string;
  className?: string;
  style?: CSSProperties;
};

const TUNED_SIZES = new Set([20, 32, 64]);

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", onChange);
  return () => {
    observer.disconnect();
    media.removeEventListener("change", onChange);
  };
}

function readDocumentDark() {
  const root = document.documentElement;
  return root.classList.contains("dark")
    || (!root.classList.contains("light") && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

function useDocumentDark(theme: "auto" | "dark" | "light") {
  const documentDark = useSyncExternalStore(subscribeTheme, readDocumentDark, () => false);
  return theme === "auto" ? documentDark : theme === "dark";
}

function subscribeReducedMotion(onChange: () => void) {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function useReducedMotion() {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
}

function FreeSizeOrb({ state, size, theme, speed, label, className, style }: Required<Pick<Props, "state" | "size" | "theme" | "speed">> & Pick<Props, "label" | "className" | "style">) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dark = useDocumentDark(theme);
  const reduced = useReducedMotion();

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { mode, speed: baseSpeed, opts } = resolvePreset(state, 64);
    const frameFn = MODE_FRAMES[mode];
    const paint = (t: number) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      paintFrame(ctx, frameFn(size, t, opts), dark);
    };
    if (reduced) {
      paint(0.6);
      return;
    }
    let raf = 0;
    let running = false;
    const loop = () => {
      paint((performance.now() / 1000) * baseSpeed * speed);
      if (running) raf = requestAnimationFrame(loop);
    };
    const start = () => {
      if (running) return;
      running = true;
      raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };
    paint((performance.now() / 1000) * baseSpeed * speed);
    let visible = true;
    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible && document.visibilityState !== "hidden") start();
      else stop();
    });
    io.observe(canvas);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") stop();
      else if (visible) start();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [state, size, dark, speed, reduced]);

  return (
    <canvas
      ref={ref}
      role="img"
      aria-label={label ?? "Working"}
      className={className}
      style={{ width: size, height: size, display: "block", ...style }}
    />
  );
}

export function ThinkingOrb({
  state = "working",
  size = 32,
  theme = "auto",
  speed = 1,
  label,
  className,
  style,
}: Props) {
  if (TUNED_SIZES.has(size)) {
    return (
      <TunedOrb
        state={state}
        size={size as 20 | 32 | 64}
        theme={theme}
        speed={speed}
        aria-label={label}
        className={className}
        style={style}
      />
    );
  }
  return <FreeSizeOrb state={state} size={size} theme={theme} speed={speed} label={label} className={className} style={style} />;
}
