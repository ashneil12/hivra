/** @jest-environment jsdom */
/**
 * The litepaper is a static page, so its script is tested the way a reader meets
 * it: the generated page is loaded into its own window, docs/litepaper/litepaper.js
 * runs against it, and the test clicks, hovers and presses keys. jsdom has no
 * layout, animation or observers, so each test gives that window the few it needs:
 *  - a fixed layout for the lab, so probes have somewhere to fly;
 *  - Web Animations that finish on the fake clock, are cancellable, and (like a
 *    real browser) still finish when their element has been removed;
 *  - observers the test can fire;
 *  - a stand-in for GSAP, which only drives scroll scenes.
 */
import fs from "node:fs";
import path from "node:path";

const DIR = path.resolve(__dirname, "../../docs/litepaper");
const PAGE = fs.readFileSync(path.join(DIR, "index.html"), "utf8");
const SCRIPT = fs.readFileSync(path.join(DIR, "litepaper.js"), "utf8");

type Box = { left: number; top: number; width: number; height: number };
const domRect = ({ left, top, width, height }: Box): DOMRect =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

class FakeResizeObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
}

class FakeObserver {
  static instances: FakeObserver[] = [];
  targets: Element[] = [];
  constructor(public callback: (entries: Array<{ isIntersecting: boolean; target: Element }>) => void) {
    FakeObserver.instances.push(this);
  }
  observe(target: Element) {
    this.targets.push(target);
  }
  disconnect() {
    this.targets = [];
  }
  unobserve() {}
}

type FakeAnimation = { onfinish: null | (() => void); cancel(): void };

// A stand-in for GSAP: every call does nothing and returns itself.
const inert: unknown = new Proxy(function () {}, {
  get: (_target, property) => (property === "then" ? undefined : inert),
  apply: () => inert,
});

/** Lab layout: the agent on the right, the gate in the middle, five resources on the left. */
function layout(element: Element): Box {
  const classes = element.classList;
  if (classes.contains("boundary-lab")) return { left: 0, top: 0, width: 900, height: 500 };
  if (classes.contains("agent-core")) return { left: 650, top: 200, width: 100, height: 100 };
  if (classes.contains("boundary-gate")) return { left: 450, top: 50, width: 4, height: 400 };
  if (classes.contains("lab-item")) {
    const index = [...element.parentElement!.querySelectorAll(".lab-item")].indexOf(element);
    return { left: 100, top: 80 + index * 70, width: 200, height: 40 };
  }
  return { left: 0, top: 0, width: 0, height: 0 };
}

// A hidden tab pauses animation while timers still run. Tests set this to mimic it.
let animationsPaused = false;

type PageWindow = Window & typeof globalThis & Record<string, unknown>;

function installBrowser(win: PageWindow, reducedMotion: boolean) {
  FakeObserver.instances = [];
  // The page's own timers run on the test's fake clock.
  win.setTimeout = globalThis.setTimeout;
  win.clearTimeout = globalThis.clearTimeout;
  win.requestAnimationFrame = globalThis.requestAnimationFrame;
  win.cancelAnimationFrame = globalThis.cancelAnimationFrame;
  Object.defineProperty(win, "performance", { configurable: true, value: globalThis.performance });
  win.matchMedia = ((query: string) => ({
    matches: reducedMotion && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  })) as never;
  win.IntersectionObserver = FakeObserver as never;
  win.ResizeObserver = FakeResizeObserver as never;
  win.gsap = inert;
  win.ScrollTrigger = inert;
  win.HTMLCanvasElement.prototype.getContext = (() => null) as never;
  win.Element.prototype.getBoundingClientRect = function (this: Element) {
    return domRect(layout(this));
  };
  Object.defineProperty(win.HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("gloss-tip") ? 80 : 0;
    },
  });
  // jsdom has no :focus-visible; a focused element counts as a keyboard focus.
  const matches = win.Element.prototype.matches;
  win.Element.prototype.matches = function (this: Element, selector: string) {
    return selector === ":focus-visible" ? this.ownerDocument.activeElement === this : matches.call(this, selector);
  };
  win.Element.prototype.getAnimations = () => [];
  win.Element.prototype.animate = function (_frames: unknown, options?: KeyframeAnimationOptions) {
    const animation: FakeAnimation = {
      onfinish: null,
      cancel() {
        animation.onfinish = null;
        clearTimeout(timer);
      },
    };
    const timer = animationsPaused
      ? undefined
      : setTimeout(() => animation.onfinish?.(), Number(options?.duration ?? 0) + Number(options?.delay ?? 0));
    return animation as unknown as Animation;
  };
}

const frames: HTMLIFrameElement[] = [];

/** Load a fresh copy of the page into its own window and run the real script against it. */
function loadPage({ reducedMotion = false } = {}): Document {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  frames.push(frame);
  const win = frame.contentWindow as PageWindow;
  const doc = frame.contentDocument as Document;
  doc.open();
  doc.write(PAGE);
  doc.close();
  installBrowser(win, reducedMotion);
  (win as unknown as { eval(code: string): void }).eval(SCRIPT);
  return doc;
}

const win = (doc: Document) => doc.defaultView as PageWindow;
const lab = (doc: Document) => doc.querySelector(".boundary-lab") as HTMLElement;
const meter = (doc: Document) => doc.querySelector(".meter-count")!.textContent;
const verdict = (doc: Document) => doc.querySelector(".attack-verdict")!.textContent;
const readout = (doc: Document) => doc.querySelector(".lab-readout")!.textContent;
const replay = (doc: Document) => doc.querySelector(".lab-replay") as HTMLButtonElement;
const items = (doc: Document) => [...doc.querySelectorAll<HTMLElement>(".lab-item")];
const stamps = (doc: Document) => items(doc).map((item) => item.querySelector(".item-stamp")!.textContent);
const states = (doc: Document) => items(doc).map((item) => item.dataset.state);
const pick = (doc: Document, mode: string) => doc.querySelector<HTMLElement>(`[data-boundary="${mode}"]`)!.click();
const resource = (doc: Document, name: string) => doc.querySelector<HTMLElement>(`[data-resource="${name}"]`)!;
const elapse = (ms: number) => jest.advanceTimersByTime(ms);
// An attack is about 4.9 s (typing, five probes, the verdict).
const SETTLED = 6000;
const firstView = (doc: Document) => {
  const observer = FakeObserver.instances.find((candidate) => candidate.targets.includes(lab(doc)));
  observer!.callback([{ isIntersecting: true, target: lab(doc) }]);
};

beforeEach(() => {
  jest.useFakeTimers();
  animationsPaused = false;
});
afterEach(() => {
  jest.useRealTimers();
  frames.splice(0).forEach((frame) => frame.remove());
});

describe("the boundary lab", () => {
  it("starts on the shared machine, with everything within reach", () => {
    const doc = loadPage();
    expect(lab(doc).dataset.mode).toBe("shared");
    expect(lab(doc).dataset.state).toBe("breach");
    expect(meter(doc)).toBe("5 / 5");
  });

  it("ignores probes from a setup the reader has already left (CR-03)", () => {
    const doc = loadPage();
    pick(doc, "shared");
    elapse(3100);
    expect(meter(doc)).toBe("2 / 5");
    pick(doc, "separate");
    elapse(700);
    // The old probes land here. They must not stamp or count anything.
    expect(meter(doc)).toBe("0 / 5");
    expect(states(doc)).not.toContain("breached");
    elapse(SETTLED);
    expect(lab(doc).dataset.state).toBe("held");
    expect(meter(doc)).toBe("0 / 5");
    expect(states(doc)).toEqual(["held", "held", "held", "held", "held"]);
  });

  it("does not leave a stale meter when a shared folder replaces a running attack (CR-03)", () => {
    const doc = loadPage();
    pick(doc, "project");
    elapse(3100);
    pick(doc, "separate");
    elapse(SETTLED + 2000);
    expect(meter(doc)).toBe("0 / 5");
    expect(lab(doc).dataset.state).toBe("held");
  });

  it("settles on the setup's own meter whatever happened on the way (CR-03)", () => {
    const doc = loadPage();
    pick(doc, "project");
    elapse(SETTLED + 2000);
    expect(meter(doc)).toBe("1 / 5");
    expect(lab(doc).dataset.state).toBe("scoped");
  });

  it("ends on the setup's full result even if no probe ever landed (CR-03)", () => {
    const doc = loadPage();
    animationsPaused = true;
    pick(doc, "shared");
    elapse(SETTLED);
    expect(meter(doc)).toBe("5 / 5");
    expect(stamps(doc)).toEqual(Array(5).fill("Reached"));
    expect(lab(doc).dataset.state).toBe("breach");
    pick(doc, "separate");
    elapse(SETTLED);
    expect(meter(doc)).toBe("0 / 5");
    expect(stamps(doc)).toEqual(Array(5).fill("Kept out"));
  });

  it("keeps the replay button focusable while the attack runs (CR-06)", () => {
    const doc = loadPage();
    elapse(SETTLED);
    const button = replay(doc);
    button.focus();
    button.click();
    // A disabled button drops keyboard focus in real browsers, so it stays enabled
    // and says it is busy instead.
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(doc.activeElement).toBe(button);
    elapse(SETTLED);
    expect(button.hasAttribute("aria-disabled")).toBe(false);
    expect(doc.activeElement).toBe(button);
  });

  it("does not restart the attack when replay is pressed while one is running (CR-06)", () => {
    const doc = loadPage();
    pick(doc, "shared");
    elapse(3100);
    expect(meter(doc)).toBe("2 / 5");
    replay(doc).click();
    elapse(50);
    // Still counting up from 2. A restart would have cleared the meter.
    expect(meter(doc)).toBe("2 / 5");
  });

  describe("the first-view walk-through", () => {
    it("walks through the three setups for a reader who has not touched anything", () => {
      const doc = loadPage();
      firstView(doc);
      elapse(SETTLED);
      expect(lab(doc).dataset.mode).toBe("shared");
      elapse(2500);
      expect(lab(doc).dataset.mode).toBe("separate");
      elapse(8000);
      expect(lab(doc).dataset.mode).toBe("project");
    });

    it("never overrides a setup the reader already chose (CR-07)", () => {
      const doc = loadPage();
      pick(doc, "separate");
      elapse(SETTLED);
      firstView(doc);
      elapse(30000);
      expect(lab(doc).dataset.mode).toBe("separate");
      expect(lab(doc).dataset.state).toBe("held");
      expect(stamps(doc)).toEqual(Array(5).fill("Kept out"));
      expect(meter(doc)).toBe("0 / 5");
      expect(doc.querySelector('[data-boundary="separate"]')!.getAttribute("aria-pressed")).toBe("true");
    });

    it("stops as soon as the reader presses a setup (CR-07)", () => {
      const doc = loadPage();
      firstView(doc);
      elapse(3000);
      pick(doc, "project");
      elapse(30000);
      expect(lab(doc).dataset.mode).toBe("project");
    });

    it("stops when keyboard focus or a pointer reaches the lab (CR-07)", () => {
      const doc = loadPage();
      firstView(doc);
      elapse(3000);
      doc.querySelector<HTMLElement>('[data-boundary="shared"]')!.focus();
      elapse(30000);
      expect(lab(doc).dataset.mode).toBe("shared");
    });

    it("stops when a pointer is pressed on a control, even before the click (CR-07)", () => {
      const doc = loadPage();
      firstView(doc);
      elapse(3000);
      const button = doc.querySelector<HTMLElement>('[data-boundary="shared"]')!;
      button.dispatchEvent(new (win(doc).MouseEvent)("pointerdown", { bubbles: true }));
      elapse(30000);
      expect(lab(doc).dataset.mode).toBe("shared");
    });

    it("keeps going when the reader only drags the page past the picture (CR-07)", () => {
      const doc = loadPage();
      // A finger that starts a scroll on the picture has not chosen anything.
      doc
        .querySelector(".reach-map")!
        .dispatchEvent(new (win(doc).MouseEvent)("pointerdown", { bubbles: true }));
      firstView(doc);
      elapse(SETTLED);
      elapse(2500);
      expect(lab(doc).dataset.mode).toBe("separate");
      elapse(8000);
      expect(lab(doc).dataset.mode).toBe("project");
    });

    it("is not started by a reader who touched a resource first (CR-07)", () => {
      const doc = loadPage();
      resource(doc, "files").click();
      firstView(doc);
      elapse(30000);
      expect(lab(doc).dataset.mode).toBe("shared");
      expect(lab(doc).dataset.state).toBe("breach");
    });
  });

  describe("without motion", () => {
    it("shows the end state at once, with no idle second (CR-08)", () => {
      const doc = loadPage({ reducedMotion: true });
      pick(doc, "separate");
      expect(lab(doc).dataset.state).toBe("held");
      expect(meter(doc)).toBe("0 / 5");
      expect(stamps(doc)).toEqual(Array(5).fill("Kept out"));
      expect(verdict(doc)).toMatch(/hits a wall/);
      pick(doc, "project");
      expect(lab(doc).dataset.state).toBe("scoped");
      expect(meter(doc)).toBe("1 / 5");
    });
  });

  describe("the spoken readout", () => {
    it("says nothing until the reader has used the lab (CR-08)", () => {
      const doc = loadPage();
      // The live region is empty on first paint, and stays empty through the
      // first-view walk-through, which is not the reader's doing.
      expect(readout(doc)).toBe("");
      firstView(doc);
      elapse(30000);
      expect(lab(doc).dataset.mode).toBe("project");
      expect(readout(doc)).toBe("");
      // The first press is what it speaks for.
      pick(doc, "separate");
      elapse(SETTLED + 2000);
      expect(readout(doc)).toMatch(/hits a wall/);
    });

    it("keeps the pressed resource's line next to the verdict (CR-08)", () => {
      const doc = loadPage({ reducedMotion: true });
      resource(doc, "files").click();
      expect(readout(doc)).toBe("Files: Beside the agent.");
      pick(doc, "separate");
      elapse(1100);
      expect(resource(doc, "files").getAttribute("aria-pressed")).toBe("true");
      expect(verdict(doc)).toMatch(/hits a wall/);
      expect(readout(doc)).toContain(verdict(doc)!);
      expect(readout(doc)).toContain("Files: Outside its computer.");
    });

    it("does not keep the last setup's verdict while the next attack runs (CR-08)", () => {
      const doc = loadPage();
      pick(doc, "shared");
      elapse(SETTLED + 2000);
      expect(readout(doc)).toMatch(/reaches everything/);
      pick(doc, "separate");
      elapse(1500);
      // Mid-attack: nothing left over from the shared machine, and nothing new yet.
      expect(readout(doc)).toBe("");
      elapse(SETTLED);
      expect(readout(doc)).toMatch(/hits a wall/);
      // A pressed resource still speaks for itself while the attack runs.
      resource(doc, "files").click();
      pick(doc, "project");
      elapse(1500);
      expect(readout(doc)).toBe("Files: Outside its computer.");
    });

    it("does the same after the animated attack settles (CR-08)", () => {
      const doc = loadPage();
      resource(doc, "files").click();
      pick(doc, "separate");
      elapse(SETTLED + 2000);
      expect(readout(doc)).toContain("hits a wall");
      expect(readout(doc)).toContain("Files: Outside its computer.");
    });
  });

  describe("what it claims", () => {
    it("says what happened in the picture, not that the reader is safe (F-22)", () => {
      const doc = loadPage({ reducedMotion: true });
      pick(doc, "separate");
      const words = `${verdict(doc)} ${stamps(doc).join(" ")}`;
      expect(words).not.toMatch(/\bsafe\b/i);
      expect(words).not.toMatch(/nothing of yours/i);
      expect(stamps(doc)).toEqual(Array(5).fill("Kept out"));
      // The verdict carries the caveat the caption below it gives.
      expect(verdict(doc)).toMatch(/as long as the two computers stay apart/);
    });

    it("carries the approved caveat in its note, without the old jargon (F-21)", () => {
      const doc = loadPage();
      const note = doc.querySelector(".diagram-note")!.textContent!;
      expect(note).toBe(
        "An illustration of the idea. Real protection depends on how the computer, network and accounts are actually set up.",
      );
      expect(note).not.toMatch(/credentials|design principle/i);
    });
  });
});

describe("the page's plain-English terms", () => {
  const term = (doc: Document, index = 0) => doc.querySelectorAll<HTMLElement>(".gloss")[index];
  const bubble = (doc: Document) => doc.getElementById("gloss-tip");
  const shown = (doc: Document) => {
    const tip = bubble(doc);
    return Boolean(tip && !tip.hidden);
  };
  const pointer = (target: Element, type: string, init: { pointerType?: string; x?: number; y?: number; related?: Element | null } = {}) => {
    const event = new (win(target.ownerDocument).MouseEvent)(type, {
      bubbles: true,
      clientX: init.x ?? 0,
      clientY: init.y ?? 0,
      relatedTarget: init.related ?? null,
    });
    Object.defineProperty(event, "pointerType", { value: init.pointerType ?? "mouse" });
    target.dispatchEvent(event);
  };
  const key = (target: Element, pressed: string) =>
    target.dispatchEvent(new (win(target.ownerDocument).KeyboardEvent)("keydown", { key: pressed, bubbles: true, cancelable: true }));
  const focus = (target: HTMLElement) => target.focus();
  const blur = (target: HTMLElement) => target.blur();
  const rectsFor = (target: HTMLElement, boxes: Box[]) => {
    (target as unknown as { getClientRects: () => DOMRect[] }).getClientRects = () => boxes.map(domRect);
  };

  it("keeps the meaning out of the page text until a reader asks for it", () => {
    const doc = loadPage();
    expect(bubble(doc)).toBeNull();
    expect(term(doc).dataset.tip).toBeTruthy();
  });

  it("draws one bubble on the page body, so no card can clip it (CR-09)", () => {
    const doc = loadPage();
    const word = term(doc);
    rectsFor(word, [{ left: 300, top: 400, width: 80, height: 20 }]);
    pointer(word, "pointerover");
    const tip = bubble(doc)!;
    expect(tip.parentElement).toBe(doc.body);
    expect(word.contains(tip)).toBe(false);
    expect(tip.getAttribute("role")).toBe("tooltip");
    expect(tip.textContent).toBe(word.dataset.tip);
    expect(word.getAttribute("aria-describedby")).toBe(tip.id);
  });

  it("puts the bubble beside the line the pointer is on when a term wraps (CR-09)", () => {
    const doc = loadPage();
    const word = term(doc);
    rectsFor(word, [
      { left: 900, top: 400, width: 100, height: 20 },
      { left: 40, top: 430, width: 60, height: 20 },
    ]);
    pointer(word, "pointerover", { x: 60, y: 440 });
    const tip = bubble(doc)!;
    // Centred on the second line (x 70), kept inside the viewport, above that line.
    expect(parseFloat(tip.style.left)).toBeLessThan(200);
    expect(parseFloat(tip.style.left)).toBeGreaterThanOrEqual(16);
  });

  it("closes on Escape when only hovered, and stays closed until the pointer leaves (CR-09)", () => {
    const doc = loadPage();
    const word = term(doc);
    rectsFor(word, [{ left: 300, top: 400, width: 80, height: 20 }]);
    pointer(word, "pointerover");
    expect(shown(doc)).toBe(true);
    key(doc.body, "Escape");
    expect(shown(doc)).toBe(false);
    expect(word.hasAttribute("aria-describedby")).toBe(false);
    // Small pointer movements over the word do not bring it back.
    pointer(word, "pointerover");
    expect(shown(doc)).toBe(false);
    // Leaving and coming back does.
    pointer(doc.body, "pointerover");
    elapse(300);
    pointer(word, "pointerover");
    expect(shown(doc)).toBe(true);
  });

  it("closes on Escape when focused, without moving focus (CR-09)", () => {
    const doc = loadPage();
    const word = term(doc);
    rectsFor(word, [{ left: 300, top: 400, width: 80, height: 20 }]);
    focus(word);
    expect(shown(doc)).toBe(true);
    key(word, "Escape");
    expect(shown(doc)).toBe(false);
    expect(doc.activeElement).toBe(word);
    blur(word);
    focus(word);
    expect(shown(doc)).toBe(true);
  });

  it("stays open while the pointer moves from the word onto the bubble (CR-09)", () => {
    const doc = loadPage();
    const word = term(doc);
    rectsFor(word, [{ left: 300, top: 400, width: 80, height: 20 }]);
    pointer(word, "pointerover");
    const tip = bubble(doc)!;
    // Across the gap: the pointer is over nothing for a moment.
    pointer(doc.body, "pointerover");
    elapse(100);
    pointer(tip, "pointerover");
    elapse(1000);
    expect(shown(doc)).toBe(true);
    // Off the bubble, it closes.
    pointer(doc.body, "pointerover");
    elapse(300);
    expect(shown(doc)).toBe(false);
  });

  it("closes when the pointer leaves the window (CR-09)", () => {
    const doc = loadPage();
    const word = term(doc);
    rectsFor(word, [{ left: 300, top: 400, width: 80, height: 20 }]);
    pointer(word, "pointerover");
    expect(shown(doc)).toBe(true);
    pointer(word, "pointerout", { related: null });
    elapse(300);
    expect(shown(doc)).toBe(false);
  });

  it("opens and closes with Enter for a keyboard reader (CR-09)", () => {
    const doc = loadPage();
    const word = term(doc);
    rectsFor(word, [{ left: 300, top: 400, width: 80, height: 20 }]);
    focus(word);
    expect(shown(doc)).toBe(true);
    key(word, "Enter");
    expect(shown(doc)).toBe(false);
    key(word, "Enter");
    expect(shown(doc)).toBe(true);
    key(word, " ");
    expect(shown(doc)).toBe(false);
  });

  it("opens on a tap and closes on a tap elsewhere (CR-09)", () => {
    const doc = loadPage();
    const word = term(doc);
    rectsFor(word, [{ left: 300, top: 400, width: 80, height: 20 }]);
    pointer(word, "pointerover", { pointerType: "touch" });
    expect(shown(doc)).toBe(false);
    pointer(word, "pointerdown", { pointerType: "touch" });
    word.click();
    expect(shown(doc)).toBe(true);
    pointer(doc.body, "pointerdown", { pointerType: "touch" });
    expect(shown(doc)).toBe(false);
  });

  it("opens on a tap that sends no click, as on iOS Safari (CR-09)", () => {
    const doc = loadPage();
    const word = term(doc);
    rectsFor(word, [{ left: 300, top: 400, width: 80, height: 20 }]);
    pointer(word, "pointerdown", { pointerType: "touch" });
    pointer(word, "pointerup", { pointerType: "touch" });
    expect(shown(doc)).toBe(true);
    // The click that some browsers add is the same tap, not a second one.
    word.click();
    expect(shown(doc)).toBe(true);
    // A second tap on the word closes it.
    pointer(word, "pointerdown", { pointerType: "touch" });
    pointer(word, "pointerup", { pointerType: "touch" });
    expect(shown(doc)).toBe(false);
  });

  it("does not open when a touch turns into a scroll (CR-09)", () => {
    const doc = loadPage();
    const word = term(doc);
    rectsFor(word, [{ left: 300, top: 400, width: 80, height: 20 }]);
    pointer(word, "pointerdown", { pointerType: "touch" });
    pointer(word, "pointercancel", { pointerType: "touch" });
    expect(shown(doc)).toBe(false);
  });

  it("opens on a click that no pointer came before, as a screen reader sends it (CR-09)", () => {
    const doc = loadPage();
    const word = term(doc);
    rectsFor(word, [{ left: 300, top: 400, width: 80, height: 20 }]);
    word.click();
    expect(shown(doc)).toBe(true);
  });

  it("leaves a mouse click to hover (CR-09)", () => {
    const doc = loadPage();
    const word = term(doc);
    rectsFor(word, [{ left: 300, top: 400, width: 80, height: 20 }]);
    pointer(word, "pointerover");
    pointer(word, "pointerdown");
    word.dispatchEvent(new (win(doc).MouseEvent)("click", { bubbles: true, detail: 1 }));
    // Still open: the click did not toggle it shut.
    expect(shown(doc)).toBe(true);
  });

  it("shows one bubble at a time", () => {
    const doc = loadPage();
    const first = term(doc, 0);
    const second = term(doc, 1);
    rectsFor(first, [{ left: 100, top: 300, width: 60, height: 20 }]);
    rectsFor(second, [{ left: 500, top: 300, width: 60, height: 20 }]);
    pointer(first, "pointerover");
    pointer(second, "pointerover");
    expect(doc.querySelectorAll("#gloss-tip").length).toBe(1);
    expect(bubble(doc)!.textContent).toBe(second.dataset.tip);
    expect(first.hasAttribute("aria-describedby")).toBe(false);
  });

  it("flips under the word when there is no room above it", () => {
    const doc = loadPage();
    const word = term(doc);
    rectsFor(word, [{ left: 300, top: 20, width: 80, height: 20 }]);
    pointer(word, "pointerover");
    expect(bubble(doc)!.dataset.side).toBe("below");
    expect(parseFloat(bubble(doc)!.style.top)).toBeGreaterThan(40);
  });
});
