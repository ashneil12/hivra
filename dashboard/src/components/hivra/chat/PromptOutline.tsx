"use client";

// Adapted from MonoCode (MIT License, Copyright (c) 2026 Nick); see THIRD_PARTY_LICENSES/monocode.txt.
//
// A rail of thin bars down the right edge, one per message the owner sent. The
// bar for the prompt you are reading is lit; hovering the rail lifts the bars
// near the pointer and shows a card with the prompt and the start of its reply;
// a click scrolls there. It shows once there are two prompts and the pane is
// wide enough. MonoCode's virtualised "reveal the turn" step is not needed:
// every turn of the open conversation is in the page.

import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { Popover } from "./Popover";
import { activePromptId, barLift, barWindow, promptLabel, promptMessages, promptPreview, RIPPLE_SPAN, NEAR_END_PX, type OutlineAnchor } from "./promptOutline";
import type { ChatMessage } from "./types";
import styles from "./chat.module.css";

const OPEN_DELAY_MS = 25;
const SCROLL_INSET_PX = 8;
const MIN_PROMPTS = 2;
const BAR_HEIGHT_PX = 2;
const BAR_WIDTH_PX = 11;
const BAR_WIDTH_LIFTED_PX = 24;
const BAR_OPACITY_IDLE = 0.15;
const BAR_OPACITY_LIT = 0.85;
const RIPPLE_STEP_MS = 18;
const BAR_GAP_PX = 10;
const BAR_GAP_MIN_PX = 1;
const BAR_STACK_MAX_PX = 330;
const BAR_STACK_PANE_SHARE = 0.75;
const ANCHOR = "[data-prompt-anchor]";

/** One bar per prompt while the bars fit the budget. The gap shrinks first. Past that, a window slides. */
function barStack(count: number, activeIndex: number | null, budget: number) {
  const fit = Math.max(1, Math.floor((budget + BAR_GAP_MIN_PX) / (BAR_HEIGHT_PX + BAR_GAP_MIN_PX)));
  const window_ = barWindow(count, activeIndex, fit);
  const shown = window_.end - window_.start;
  const gap = shown > 1 ? Math.min(BAR_GAP_PX, Math.max(BAR_GAP_MIN_PX, Math.floor((budget - shown * BAR_HEIGHT_PX) / (shown - 1)))) : 0;
  return { ...window_, gap };
}

export function PromptOutline({ messages, scrollRef, onJump }: {
  messages: readonly ChatMessage[];
  /** The transcript's scroller, which holds the prompts' anchors. */
  scrollRef: RefObject<HTMLElement | null>;
  /** A jump to a prompt: the chat lets go of following the stream to the bottom. */
  onJump?: () => void;
}) {
  const prompts = useMemo(() => promptMessages(messages), [messages]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [stackBudget, setStackBudget] = useState(BAR_STACK_MAX_PX);
  const [hover, setHover] = useState<{ id: string; el: HTMLElement } | null>(null);
  const [open, setOpen] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const rail = useRef<HTMLDivElement>(null);
  const frame = useRef<number | null>(null);
  const openTimer = useRef<number | null>(null);
  const pointerInside = useRef(false);
  const lastPromptId = useRef<string | null>(null);
  useEffect(() => {
    lastPromptId.current = prompts[prompts.length - 1]?.id ?? null;
  }, [prompts]);

  const measure = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return setActiveId(null);
    const viewport = scroller.getBoundingClientRect();
    if (viewport.height === 0) return;
    setStackBudget(Math.min(BAR_STACK_MAX_PX, Math.floor(viewport.height * BAR_STACK_PANE_SHARE)));
    const distanceToEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (distanceToEnd <= NEAR_END_PX) return setActiveId(lastPromptId.current);
    const anchors: OutlineAnchor[] = [];
    for (const el of scroller.querySelectorAll<HTMLElement>(ANCHOR)) {
      const id = el.dataset.promptAnchor;
      if (!id) continue;
      const box = el.getBoundingClientRect();
      anchors.push({ id, top: box.top, bottom: box.bottom });
    }
    setActiveId(activePromptId({ top: viewport.top, bottom: viewport.bottom }, anchors, distanceToEnd));
  }, [scrollRef]);

  const schedule = useCallback(() => {
    // Nothing to measure until the owner has sent a prompt.
    if (frame.current != null || lastPromptId.current === null) return;
    frame.current = window.requestAnimationFrame(() => {
      frame.current = null;
      measure();
    });
  }, [measure]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    scroller.addEventListener("scroll", schedule, { passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    observer?.observe(scroller);
    if (scroller.firstElementChild) observer?.observe(scroller.firstElementChild);
    schedule();
    return () => {
      scroller.removeEventListener("scroll", schedule);
      observer?.disconnect();
      if (frame.current != null) window.cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [scrollRef, schedule]);
  useEffect(() => schedule(), [schedule, messages]);

  const cancelOpen = () => {
    if (openTimer.current == null) return;
    window.clearTimeout(openTimer.current);
    openTimer.current = null;
  };
  useEffect(() => cancelOpen, []);

  /** The ripple follows the pointer at once. The card waits out a pass-through. */
  const hoverBar = (id: string, el: HTMLElement) => {
    setHover({ id, el });
    if (open || openTimer.current != null) return;
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null;
      setOpen(true);
    }, OPEN_DELAY_MS);
  };
  const close = () => {
    cancelOpen();
    setHover(null);
    setOpen(false);
  };
  const leaveRail = () => {
    pointerInside.current = false;
    // Keyboard focus holds the card open after the pointer moves away.
    const el = document.activeElement;
    if (el instanceof HTMLElement && rail.current?.contains(el) && el.matches(":focus-visible")) return;
    close();
  };
  const blurRail = (event: ReactFocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget) || pointerInside.current) return;
    close();
  };

  const preview = useMemo(() => {
    const prompt = hover ? prompts.find((p) => p.id === hover.id) : undefined;
    return prompt ? promptPreview(prompt) : null;
  }, [hover, prompts]);

  const jumpTo = (id: string) => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    // The transcript follows the stream to the bottom until a scroll up; let go of it so the jump stays.
    onJump?.();
    const anchor = scroller.querySelector<HTMLElement>(`[data-prompt-anchor="${CSS.escape(id)}"]`);
    if (!anchor) {
      scroller.scrollTop = 0;
      return;
    }
    const align = () => {
      const delta = anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top - SCROLL_INSET_PX;
      if (Math.abs(delta) > 2) scroller.scrollTop += delta;
    };
    align();
    window.requestAnimationFrame(align);
  };

  if (prompts.length < MIN_PROMPTS) return null;

  const activeIndex = prompts.findIndex((prompt) => prompt.id === activeId);
  const stack = barStack(prompts.length, activeIndex >= 0 ? activeIndex : null, stackBudget);
  const bars = prompts.slice(stack.start, stack.end);
  const hoverIndex = hover ? bars.findIndex((bar) => bar.id === hover.id) : -1;
  // One tab stop for the whole rail. Arrow keys walk it from there.
  const tabId = [focusId, activeId].find((id) => bars.some((bar) => bar.id === id)) ?? bars[0].id;

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const from = bars.findIndex((bar) => bar.id === tabId);
    const next = bars[from + step];
    if (!next) return;
    setFocusId(next.id);
    rail.current?.querySelector<HTMLElement>(`[data-prompt-bar="${CSS.escape(next.id)}"]`)?.focus();
  };

  return (
    <div className={styles.outline}>
      <div
        ref={rail}
        role="toolbar"
        aria-label="Prompts"
        aria-orientation="vertical"
        style={{ width: BAR_WIDTH_LIFTED_PX }}
        onMouseEnter={() => { pointerInside.current = true; }}
        onMouseLeave={leaveRail}
        onBlur={blurRail}
        onKeyDown={onKeyDown}
        className={styles.outlineRail}
      >
        {bars.map((prompt, index) => {
          const lift = barLift(index, hoverIndex);
          const distance = hoverIndex < 0 ? 0 : Math.abs(index - hoverIndex);
          // The pointer owns the fill while it is on the rail. Off the rail, the fill marks the scroll position.
          const lit = hoverIndex >= 0 ? index === hoverIndex : prompt.id === activeId;
          return (
            <button
              key={prompt.id}
              type="button"
              data-prompt-bar={prompt.id}
              tabIndex={prompt.id === tabId ? 0 : -1}
              aria-label={promptLabel(prompt)}
              aria-current={prompt.id === activeId ? "true" : undefined}
              onMouseEnter={(event) => hoverBar(prompt.id, event.currentTarget)}
              onFocus={(event) => {
                setFocusId(prompt.id);
                // A click focuses the bar too, and the pointer already opened the card.
                if (event.currentTarget.matches(":focus-visible")) {
                  cancelOpen();
                  setHover({ id: prompt.id, el: event.currentTarget });
                  setOpen(true);
                }
              }}
              onClick={() => jumpTo(prompt.id)}
              style={{ height: BAR_HEIGHT_PX + stack.gap }}
              className={styles.outlineBarButton}
            >
              <span
                aria-hidden="true"
                style={{
                  height: BAR_HEIGHT_PX,
                  width: BAR_WIDTH_PX + (BAR_WIDTH_LIFTED_PX - BAR_WIDTH_PX) * lift,
                  opacity: lit ? BAR_OPACITY_LIT : BAR_OPACITY_IDLE,
                  // The wave reaches the outer bars a beat after the hovered one.
                  transitionDelay: `${Math.min(distance, RIPPLE_SPAN) * RIPPLE_STEP_MS}ms`,
                }}
                className={styles.outlineBar}
              />
            </button>
          );
        })}
        {open && preview && hoverIndex >= 0 ? (
          <Popover anchor={hover?.el ?? null} side="left" align="center" gap={10} width={288} onDismiss={close} aria-label="Prompt preview" className={styles.outlineCard}>
            <p className={styles.outlineTitle}>{preview.title}</p>
            {preview.reply ? <p className={styles.outlineReply}>{preview.reply}</p> : null}
          </Popover>
        ) : null}
      </div>
    </div>
  );
}
