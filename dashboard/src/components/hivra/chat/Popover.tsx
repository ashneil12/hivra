"use client";

// Adapted from MonoCode (MIT License, Copyright (c) 2026 Nick); see THIRD_PARTY_LICENSES/monocode.txt.
//
// MonoCode's Popover: a menu or flyout portalled to the body so no pane clips
// it, placed against its anchor with viewport flipping, and grown in from the
// anchored edge. It closes on an outside press or Escape. Kept to the web
// surface: MonoCode's native-popup host and dialog layering are not needed.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef, type CSSProperties, type Ref } from "react";
import { createPortal } from "react-dom";
import { placePopover, type AnchorRect, type PopoverAlign, type PopoverPosition, type PopoverSide } from "./popoverPlacement";
import styles from "./chat.module.css";

export type PopoverAnchor = HTMLElement | { current: HTMLElement | null } | null;
export type PopoverDismissReason = "outside" | "escape";

type Props = Omit<ComponentPropsWithoutRef<"div">, "style"> & {
  anchor: PopoverAnchor;
  side?: PopoverSide;
  align?: PopoverAlign;
  gap?: number;
  width?: number;
  maxHeight?: number;
  style?: CSSProperties;
  autoFocus?: boolean;
  onDismiss?: (reason: PopoverDismissReason) => void;
  /** A press inside anything matching this selector is not an outside press. */
  ignore?: string;
  ref?: Ref<HTMLDivElement>;
};

function anchorElement(anchor: PopoverAnchor): HTMLElement | null {
  if (!anchor) return null;
  if (anchor instanceof HTMLElement) return anchor;
  return anchor.current;
}

function anchorRect(anchor: PopoverAnchor): AnchorRect | null {
  const el = anchorElement(anchor);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
}

function samePosition(a: PopoverPosition | null, b: PopoverPosition): boolean {
  return a != null && a.side === b.side && a.left === b.left && a.top === b.top && a.bottom === b.bottom && a.width === b.width && a.maxHeight === b.maxHeight;
}

function origin(side: PopoverSide, align: PopoverAlign): string {
  const near = align === "start" ? "0%" : align === "end" ? "100%" : "50%";
  if (side === "bottom") return `${near} 0%`;
  if (side === "top") return `${near} 100%`;
  return side === "right" ? `0% ${near}` : `100% ${near}`;
}

export function Popover({ anchor, side = "bottom", align = "start", gap, width, maxHeight, className, style, autoFocus = false, onDismiss, ignore, ref, children, ...rest }: Props) {
  const frame = useRef<HTMLDivElement | null>(null);
  const surface = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const anchorRef = useRef(anchor);
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    anchorRef.current = anchor;
    dismissRef.current = onDismiss;
  });

  const place = useCallback(() => {
    const el = frame.current;
    const rect = anchorRect(anchorRef.current);
    if (!el || !rect) return;
    const next = placePopover(rect, { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, { side, align, gap, width, maxHeight });
    setPosition((prev) => (samePosition(prev, next) ? prev : next));
  }, [side, align, gap, width, maxHeight]);

  useLayoutEffect(() => {
    place();
    // Content that lands after open resizes the surface; a top-anchored menu
    // is measured again so it sits above its trigger rather than over it.
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
    if (frame.current) observer?.observe(frame.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [place]);

  useEffect(() => {
    if (autoFocus) surface.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  useEffect(() => {
    if (!onDismiss) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (frame.current?.contains(target)) return;
      if (anchorElement(anchorRef.current)?.contains(target)) return;
      const el = target instanceof Element ? target : target.parentElement;
      if (ignore && el?.closest(ignore)) return;
      dismissRef.current?.("outside");
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      dismissRef.current?.("escape");
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onDismiss, ignore]);

  // The first pass measures the surface off to the side; the layout effect
  // lands it before the browser paints.
  const placed: CSSProperties = position
    ? { position: "fixed", left: position.left, top: position.top, bottom: position.bottom, width: position.width, maxHeight: position.maxHeight }
    : { position: "fixed", left: 0, top: 0, width, maxHeight: maxHeight ?? "calc(100vh - 16px)", visibility: "hidden" };

  return createPortal(
    <div ref={frame} data-popover-side={position?.side ?? side} style={placed} className={styles.popoverFrame}>
      <div
        {...rest}
        ref={(el) => {
          surface.current = el;
          if (typeof ref === "function") ref(el);
          else if (ref) ref.current = el;
        }}
        data-popover-side={position?.side ?? side}
        style={{ maxHeight: position ? Math.max(0, position.maxHeight - 2) : undefined, transformOrigin: origin(position?.side ?? side, align), ...style }}
        className={`${position ? styles.popoverOpen : ""} ${styles.popoverSurface} ${className ?? ""}`}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
