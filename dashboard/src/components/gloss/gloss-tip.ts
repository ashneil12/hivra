import styles from "./gloss.module.css";

/**
 * The tooltip for a glossary term. One shared bubble sits on <body>, so no
 * card's overflow can cut it off, and it is placed from the word's own line
 * boxes, so a term that wraps still gets a bubble beside it. The bubble stays
 * while the pointer is on the word or on the bubble itself. Escape closes it
 * without moving focus, and a tap or Enter opens and closes it on touch screens
 * and keyboards. The meaning stays in data-tip, so it is never page text.
 *
 * The litepaper page has the same behaviour in docs/litepaper/litepaper.js,
 * because that page is static and cannot import this module. Keep them alike.
 */
export const GLOSS_TIP_ID = "gloss-tip";

const TERM = "[data-gloss]";
const GAP = 10;
const EDGE = 16;
const CLOSE_DELAY = 200;

function find(node: EventTarget | null): HTMLElement | null {
  return node instanceof Element ? node.closest<HTMLElement>(TERM) : null;
}

function focusVisible(term: HTMLElement): boolean {
  try {
    return term.matches(":focus-visible");
  } catch {
    return true;
  }
}

function fragmentAt(term: HTMLElement, x: number, y: number): number {
  const index = [...term.getClientRects()].findIndex(
    (box) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom,
  );
  return Math.max(0, index);
}

function mount(): () => void {
  let tip: HTMLDivElement | null = null;
  let active: HTMLElement | null = null;
  let hover = false;
  let focus = false;
  let pinned = false;
  let dismissed = false;
  let pointerKind: "mouse" | "touch" = "mouse";
  let fragment = 0;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let frame = 0;

  const inTip = (node: EventTarget | null) => Boolean(tip && node instanceof Node && tip.contains(node));
  const isOpen = () => Boolean(active && !dismissed && (hover || focus || pinned));

  function bubble(): HTMLDivElement {
    if (tip) return tip;
    tip = document.createElement("div");
    tip.id = GLOSS_TIP_ID;
    tip.className = styles.tip ?? "";
    tip.setAttribute("role", "tooltip");
    tip.hidden = true;
    document.body.append(tip);
    return tip;
  }

  function place() {
    if (!active || !tip) return;
    const boxes = active.getClientRects();
    const box = boxes[Math.min(fragment, boxes.length - 1)];
    if (!box || box.bottom < 0 || box.top > window.innerHeight) {
      tip.hidden = true;
      return;
    }
    tip.hidden = false;
    const width = Math.min(300, window.innerWidth - 2 * EDGE);
    tip.style.width = `${width}px`;
    const height = tip.offsetHeight;
    const roomBelow = window.innerHeight - box.bottom;
    const fitsAbove = box.top - GAP - height >= 8;
    const fitsBelow = roomBelow - GAP - height >= 8;
    const below = fitsAbove ? false : fitsBelow ? true : box.top < roomBelow;
    const top = below ? box.bottom + GAP : box.top - GAP - height;
    const left = box.left + box.width / 2 - width / 2;
    tip.style.left = `${Math.max(EDGE, Math.min(left, window.innerWidth - EDGE - width))}px`;
    tip.style.top = `${Math.max(8, Math.min(top, window.innerHeight - 8 - height))}px`;
    tip.dataset.side = below ? "below" : "above";
  }

  function render() {
    if (!active) return;
    if (isOpen()) {
      const shown = bubble();
      shown.textContent = active.dataset.tip ?? "";
      active.setAttribute("aria-describedby", shown.id);
      place();
      return;
    }
    active.removeAttribute("aria-describedby");
    if (tip) {
      tip.hidden = true;
      tip.textContent = "";
    }
    // Once pointer, focus and touch have all left, the word may open again.
    if (!hover && !focus && !pinned) dismissed = false;
  }

  function activate(term: HTMLElement) {
    if (active === term) return;
    if (active) {
      hover = focus = pinned = dismissed = false;
      render();
    }
    active = term;
    fragment = 0;
  }

  function toggle() {
    if (isOpen()) dismissed = true;
    else {
      dismissed = false;
      pinned = true;
    }
    render();
  }

  function leave() {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      hover = false;
      render();
    }, CLOSE_DELAY);
  }

  const onPointerOver = (event: Event) => {
    const pointer = event as PointerEvent;
    if (pointer.pointerType === "touch") return;
    const term = find(pointer.target);
    if (term) {
      clearTimeout(closeTimer);
      activate(term);
      if (!hover) fragment = fragmentAt(term, pointer.clientX, pointer.clientY);
      hover = true;
      render();
    } else if (inTip(pointer.target)) {
      clearTimeout(closeTimer);
    } else if (hover) {
      leave();
    }
  };
  const onPointerOut = (event: Event) => {
    if (!(event as PointerEvent).relatedTarget && hover) leave();
  };
  const onPointerDown = (event: Event) => {
    pointerKind = (event as PointerEvent).pointerType === "touch" ? "touch" : "mouse";
    if (pinned && !find(event.target) && !inTip(event.target)) {
      pinned = false;
      render();
    }
  };
  const onClick = (event: Event) => {
    const term = find(event.target);
    if (!term || pointerKind !== "touch") return;
    activate(term);
    toggle();
  };
  const onFocusIn = (event: Event) => {
    const term = find(event.target);
    if (!term) return;
    activate(term);
    focus = focusVisible(term);
    render();
  };
  const onFocusOut = (event: Event) => {
    if (!active || find(event.target) !== active) return;
    focus = false;
    pinned = false;
    render();
  };
  const onKeyDown = (event: Event) => {
    const key = (event as KeyboardEvent).key;
    if (key === "Escape") {
      if (isOpen()) {
        dismissed = true;
        render();
      }
      return;
    }
    const term = find(event.target);
    if (term && (key === "Enter" || key === " ")) {
      event.preventDefault();
      activate(term);
      toggle();
    }
  };
  const onScroll = () => {
    if (pinned && pointerKind === "touch" && !focus) {
      pinned = false;
      render();
      return;
    }
    if (frame || !isOpen()) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (isOpen()) place();
    });
  };
  const onResize = () => {
    if (isOpen()) place();
  };

  document.addEventListener("pointerover", onPointerOver);
  document.addEventListener("pointerout", onPointerOut);
  document.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("click", onClick);
  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("focusout", onFocusOut);
  document.addEventListener("keydown", onKeyDown);
  window.addEventListener("scroll", onScroll, { passive: true, capture: true });
  window.addEventListener("resize", onResize);

  return () => {
    document.removeEventListener("pointerover", onPointerOver);
    document.removeEventListener("pointerout", onPointerOut);
    document.removeEventListener("pointerdown", onPointerDown);
    document.removeEventListener("click", onClick);
    document.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("focusout", onFocusOut);
    document.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("scroll", onScroll, { capture: true });
    window.removeEventListener("resize", onResize);
    clearTimeout(closeTimer);
    cancelAnimationFrame(frame);
    active?.removeAttribute("aria-describedby");
    tip?.remove();
  };
}

let retained = 0;
let unmount: (() => void) | null = null;

/** Turn the tooltips on while at least one glossary term is on the page. */
export function retainGlossTips(): () => void {
  if (retained === 0) unmount = mount();
  retained += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    retained -= 1;
    if (retained === 0) {
      unmount?.();
      unmount = null;
    }
  };
}
