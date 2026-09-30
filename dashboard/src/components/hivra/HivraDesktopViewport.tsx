"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";

// At 200% guest UI scaling a 432 CSS-pixel viewport is still only 432
// logical pixels tall. Give desktop menus usable room, then fit that entire
// viewport uniformly instead of cropping it or changing guest preferences.
const MIN_LOGICAL_WIDTH = 1024;
const MIN_LOGICAL_HEIGHT = 640;
// Phones and touch screens cap the preset budget at 4x the panel's own pixels,
// so fitting never shrinks the guest below half scale (unreadable, untappable).
const COMPACT_VIEWPORT_QUERY = "(max-width: 767px), (pointer: coarse)";
const COMPACT_MAX_PIXEL_RATIO = 4;

function compactViewport(): boolean {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia(COMPACT_VIEWPORT_QUERY).matches;
  } catch {
    return false;
  }
}

export function HivraDesktopViewport({ fit, targetWidth, targetHeight, children }: {
  fit: boolean;
  targetWidth?: number;
  targetHeight?: number;
  children: ReactNode;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [canvas, setCanvas] = useState<{ width: number; height: number; scale: number } | null>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () => {
      if (!fit) {
        setCanvas(null);
        return;
      }
      const { clientWidth: width, clientHeight: height } = viewport;
      // Hidden retained tabs have zero dimensions. Preserve the last canvas
      // until the real viewport returns instead of calculating an invalid ratio.
      if (width <= 0 || height <= 0) return;
      let logicalWidth = Math.max(width, targetWidth ?? MIN_LOGICAL_WIDTH);
      let logicalHeight = Math.max(height, targetHeight ?? MIN_LOGICAL_HEIGHT);
      const aspect = width / height;
      if (targetWidth && targetHeight && aspect >= 0.25 && aspect <= 4) {
        // Resolution presets are a quality pixel budget, not a fixed 16:9
        // letterbox. Give the guest the panel's aspect so it fills both axes.
        // Preserve bounded sizing during transient very thin window resizes.
        const budget = compactViewport()
          ? Math.min(targetWidth * targetHeight, width * height * COMPACT_MAX_PIXEL_RATIO)
          : targetWidth * targetHeight;
        const pixels = Math.max(width * height, budget);
        logicalWidth = Math.sqrt(pixels * aspect);
        logicalHeight = logicalWidth / aspect;
      }
      const scale = Math.min(width / logicalWidth, height / logicalHeight);
      // Bound each logical axis independently. Inverse-percentage sizing would
      // request an enormous guest display while a window is briefly very thin.
      setCanvas(current => current?.width === logicalWidth && current.height === logicalHeight && current.scale === scale
        ? current : { width: logicalWidth, height: logicalHeight, scale });
    };
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(viewport);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [fit, targetHeight, targetWidth]);

  return (
    <div ref={viewportRef} role="group" aria-label="Desktop viewport" style={{ position: "relative", flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden" }}>
      <div style={{
        position: "absolute",
        top: canvas ? `calc(50% - ${canvas.height * canvas.scale / 2}px)` : 0,
        left: canvas ? `calc(50% - ${canvas.width * canvas.scale / 2}px)` : 0,
        width: canvas ? `${canvas.width}px` : "100%",
        height: canvas ? `${canvas.height}px` : "100%",
        transform: !canvas || canvas.scale === 1 ? "none" : `scale(${canvas.scale})`,
        transformOrigin: "top left",
      }}>
        {children}
      </div>
    </div>
  );
}
