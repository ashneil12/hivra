"use client";

import { useCallback, useRef, useSyncExternalStore } from "react";

const HEIGHT_PROPERTY = "--workspace-viewport-height";
const NO_KEYBOARD = () => null;

function hasKeyboardFocus(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element instanceof HTMLIFrameElement) return true;
  if (element instanceof HTMLTextAreaElement) return !element.readOnly && !element.disabled;
  if (element instanceof HTMLInputElement) {
    return !element.readOnly && !element.disabled
      && ["text", "search", "email", "password", "number", "tel", "url"].includes(element.type);
  }
  const editable = element.closest("[contenteditable]");
  return Boolean(editable && editable.getAttribute("contenteditable") !== "false");
}

/** Uses observed viewport occlusion, never focus alone, to reclaim keyboard space. */
export function useWorkspaceViewport() {
  const height = useRef<number | null>(null);
  const getSnapshot = useCallback(() => height.current, []);
  const subscribe = useCallback((notify: () => void) => {
    const viewport = window.visualViewport;
    if (!viewport) return () => {};
    const style = document.documentElement.style;
    const previousHeight = style.getPropertyValue(HEIGHT_PROPERTY);
    const previousPriority = style.getPropertyPriority(HEIGHT_PROPERTY);
    const layoutHeight = () => Math.max(window.innerHeight, document.documentElement.clientHeight);
    let unobscuredHeight = layoutHeight();
    let layoutWidth = window.innerWidth;

    const restoreHeight = () => {
      if (previousHeight) style.setProperty(HEIGHT_PROPERTY, previousHeight, previousPriority);
      else style.removeProperty(HEIGHT_PROPERTY);
    };
    const update = (focused: Element | null) => {
      const currentLayoutHeight = layoutHeight();
      if (window.innerWidth !== layoutWidth) {
        layoutWidth = window.innerWidth;
        unobscuredHeight = currentLayoutHeight;
      }
      const touchLayout = window.innerWidth <= 767 || window.matchMedia?.("(any-pointer: coarse)").matches;
      const eligible = touchLayout && Math.abs(viewport.scale - 1) <= 0.05
        && hasKeyboardFocus(focused);
      const occluded = eligible && Number.isFinite(viewport.height) && viewport.height > 0
        && Math.max(currentLayoutHeight, unobscuredHeight) - viewport.height > 150;
      const nextHeight = occluded ? Math.round(viewport.height) : null;
      if (!occluded) unobscuredHeight = currentLayoutHeight;
      if (nextHeight === null) restoreHeight();
      else style.setProperty(HEIGHT_PROPERTY, `${nextHeight}px`);
      if (height.current !== nextHeight) {
        height.current = nextHeight;
        notify();
      }
    };
    const onViewportChange = () => update(document.activeElement);
    const onFocusOut = (event: FocusEvent) => update(event.relatedTarget instanceof Element ? event.relatedTarget : null);
    viewport.addEventListener("resize", onViewportChange);
    viewport.addEventListener("scroll", onViewportChange);
    window.addEventListener("resize", onViewportChange);
    document.addEventListener("focusin", onViewportChange);
    document.addEventListener("focusout", onFocusOut);
    onViewportChange();
    return () => {
      viewport.removeEventListener("resize", onViewportChange);
      viewport.removeEventListener("scroll", onViewportChange);
      window.removeEventListener("resize", onViewportChange);
      document.removeEventListener("focusin", onViewportChange);
      document.removeEventListener("focusout", onFocusOut);
      height.current = null;
      restoreHeight();
    };
  }, []);
  const viewportHeight = useSyncExternalStore(subscribe, getSnapshot, NO_KEYBOARD);
  return { keyboardOpen: viewportHeight !== null };
}
