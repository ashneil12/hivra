"use client";

import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      !element.hidden &&
      element.getAttribute("aria-hidden") !== "true" &&
      !element.closest("[inert]"),
  );
}

/**
 * Keeps an infrastructure modal isolated from the dashboard underneath it.
 * The dialog components remain responsible for choosing their initial focus
 * because that choice changes with each operation phase.
 */
export function useInfrastructureDialog({
  onClose,
  closeOnEscape = true,
  initialFocusRef,
  returnFocusRef,
}: {
  onClose: () => void;
  closeOnEscape?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
}): RefObject<HTMLElement | null> {
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const closeOnEscapeRef = useRef(closeOnEscape);
  const returnFocusRefRef = useRef(returnFocusRef);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    closeOnEscapeRef.current = closeOnEscape;
  }, [closeOnEscape]);

  useEffect(() => {
    returnFocusRefRef.current = returnFocusRef;
  }, [returnFocusRef]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const backgroundElements: Element[] = [];
    let activeBranch: Element | null = dialog;
    while (activeBranch?.parentElement) {
      const ancestor: HTMLElement = activeBranch.parentElement;
      backgroundElements.push(
        ...Array.from(ancestor.children).filter((element) => element !== activeBranch),
      );
      if (ancestor === document.body) break;
      activeBranch = ancestor;
    }
    const inertState = backgroundElements.map((element) => ({
      element,
      wasInert: element.hasAttribute("inert"),
    }));
    for (const { element } of inertState) element.setAttribute("inert", "");

    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    (initialFocusRef?.current ?? focusableElements(dialog)[0] ?? dialog).focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (closeOnEscapeRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = focusableElements(dialog);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousBodyOverflow;
      for (const { element, wasInert } of inertState) {
        if (!wasInert) element.removeAttribute("inert");
      }
      const returnTarget = previouslyFocused?.isConnected
        && previouslyFocused !== document.body
        && previouslyFocused !== document.documentElement
        ? previouslyFocused
        : returnFocusRefRef.current?.current?.isConnected
          ? returnFocusRefRef.current.current
          : null;
      returnTarget?.focus();
    };
  }, [initialFocusRef]);

  return dialogRef;
}
