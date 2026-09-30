/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render } from "@testing-library/react";
import Gloss from "../Gloss";

const TIP = "Computers that live in a company's data centre instead of on your desk.";

const tip = () => document.getElementById("gloss-tip");
const shown = () => Boolean(tip() && !tip()!.hidden);
const box = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

function pointer(target: Element, type: string, init: { pointerType?: string; x?: number; y?: number; related?: Element | null } = {}) {
  const event = new MouseEvent(type, {
    bubbles: true,
    clientX: init.x ?? 0,
    clientY: init.y ?? 0,
    relatedTarget: init.related ?? null,
  });
  Object.defineProperty(event, "pointerType", { value: init.pointerType ?? "mouse" });
  target.dispatchEvent(event);
}

const press = (target: Element, key: string) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));

function setup(rects = [box(300, 400, 80, 20)]) {
  const view = render(
    <main>
      <p>
        Plain text, <Gloss tip={TIP}>the cloud</Gloss> and <Gloss tip="A second meaning.">a second term</Gloss>.
      </p>
      <aside id="elsewhere">Elsewhere</aside>
    </main>,
  );
  const [term, second] = [...view.container.querySelectorAll<HTMLElement>("[data-gloss]")];
  (term as unknown as { getClientRects: () => DOMRect[] }).getClientRects = () => rects;
  (second as unknown as { getClientRects: () => DOMRect[] }).getClientRects = () => [box(600, 400, 80, 20)];
  return { ...view, term, second, elsewhere: view.container.querySelector("#elsewhere")! };
}

beforeEach(() => {
  jest.useFakeTimers();
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.id === "gloss-tip" ? 80 : 0;
    },
  });
  // jsdom has no :focus-visible; a focused element counts as a keyboard focus.
  const matches = Element.prototype.matches;
  jest.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector: string) {
    return selector === ":focus-visible" ? document.activeElement === this : matches.call(this, selector);
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe("Gloss tooltip", () => {
  it("stays a tab stop and keeps the meaning out of the page text", () => {
    const { term, container } = setup();
    expect(term).toHaveAttribute("tabindex", "0");
    expect(term).toHaveAttribute("data-tip", TIP);
    expect(container.textContent).not.toContain("data centre");
    expect(tip()).toBeNull();
  });

  it("draws one bubble on the page body, so no card can clip it", () => {
    const { term } = setup();
    pointer(term, "pointerover");
    expect(tip()!.parentElement).toBe(document.body);
    expect(term.contains(tip())).toBe(false);
    expect(tip()).toHaveAttribute("role", "tooltip");
    expect(tip()).toHaveTextContent(TIP);
    expect(term).toHaveAttribute("aria-describedby", "gloss-tip");
  });

  it("places the bubble beside the line the pointer is on when a term wraps", () => {
    const { term } = setup([box(900, 400, 100, 20), box(40, 430, 60, 20)]);
    pointer(term, "pointerover", { x: 60, y: 440 });
    expect(parseFloat(tip()!.style.left)).toBeLessThan(200);
  });

  it("closes on Escape when only hovered, and stays closed until the pointer leaves", () => {
    const { term, elsewhere } = setup();
    pointer(term, "pointerover");
    expect(shown()).toBe(true);
    press(document.body, "Escape");
    expect(shown()).toBe(false);
    pointer(term, "pointerover");
    expect(shown()).toBe(false);
    pointer(elsewhere, "pointerover");
    jest.advanceTimersByTime(300);
    pointer(term, "pointerover");
    expect(shown()).toBe(true);
  });

  it("closes on Escape when focused, without moving focus", () => {
    const { term } = setup();
    term.focus();
    expect(shown()).toBe(true);
    press(term, "Escape");
    expect(shown()).toBe(false);
    expect(document.activeElement).toBe(term);
  });

  it("stays open while the pointer moves from the word onto the bubble", () => {
    const { term, elsewhere } = setup();
    pointer(term, "pointerover");
    pointer(elsewhere, "pointerover");
    jest.advanceTimersByTime(100);
    pointer(tip()!, "pointerover");
    jest.advanceTimersByTime(1000);
    expect(shown()).toBe(true);
    pointer(elsewhere, "pointerover");
    jest.advanceTimersByTime(300);
    expect(shown()).toBe(false);
  });

  it("opens and closes with Enter", () => {
    const { term } = setup();
    term.focus();
    expect(shown()).toBe(true);
    press(term, "Enter");
    expect(shown()).toBe(false);
    press(term, "Enter");
    expect(shown()).toBe(true);
  });

  it("opens on a tap and closes on a tap elsewhere", () => {
    const { term, elsewhere } = setup();
    pointer(term, "pointerover", { pointerType: "touch" });
    expect(shown()).toBe(false);
    pointer(term, "pointerdown", { pointerType: "touch" });
    fireEvent.click(term);
    expect(shown()).toBe(true);
    pointer(elsewhere, "pointerdown", { pointerType: "touch" });
    expect(shown()).toBe(false);
  });

  it("opens on a tap that sends no click, as on iOS Safari", () => {
    const { term } = setup();
    pointer(term, "pointerdown", { pointerType: "touch" });
    pointer(term, "pointerup", { pointerType: "touch" });
    expect(shown()).toBe(true);
    // The click that some browsers add is the same tap, not a second one.
    fireEvent.click(term);
    expect(shown()).toBe(true);
    pointer(term, "pointerdown", { pointerType: "touch" });
    pointer(term, "pointerup", { pointerType: "touch" });
    expect(shown()).toBe(false);
  });

  it("does not open when a touch turns into a scroll", () => {
    const { term } = setup();
    pointer(term, "pointerdown", { pointerType: "touch" });
    pointer(term, "pointercancel", { pointerType: "touch" });
    expect(shown()).toBe(false);
  });

  it("opens on a click that no pointer came before, as a screen reader sends it", () => {
    const { term } = setup();
    fireEvent.click(term);
    expect(shown()).toBe(true);
  });

  it("leaves a mouse click to hover", () => {
    const { term } = setup();
    pointer(term, "pointerover");
    pointer(term, "pointerdown");
    fireEvent.click(term, { detail: 1 });
    expect(shown()).toBe(true);
  });

  it("shows one bubble at a time", () => {
    const { term, second } = setup();
    pointer(term, "pointerover");
    pointer(second, "pointerover");
    expect(document.querySelectorAll("#gloss-tip")).toHaveLength(1);
    expect(tip()).toHaveTextContent("A second meaning.");
    expect(term).not.toHaveAttribute("aria-describedby");
  });

  it("flips under the word when there is no room above it", () => {
    const { term } = setup([box(300, 20, 80, 20)]);
    pointer(term, "pointerover");
    expect(tip()!.dataset.side).toBe("below");
  });

  it("removes its bubble and listeners when the last term leaves the page", () => {
    const { term, unmount } = setup();
    pointer(term, "pointerover");
    expect(tip()).not.toBeNull();
    unmount();
    expect(tip()).toBeNull();
    // A later hover on a stray term must not bring it back.
    const stray = document.createElement("span");
    stray.setAttribute("data-gloss", "");
    stray.dataset.tip = "Stray";
    document.body.append(stray);
    pointer(stray, "pointerover");
    expect(tip()).toBeNull();
    stray.remove();
  });
});
