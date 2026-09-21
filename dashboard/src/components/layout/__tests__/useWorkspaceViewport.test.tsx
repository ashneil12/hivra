/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, renderHook } from "@testing-library/react";
import { useWorkspaceViewport } from "../useWorkspaceViewport";

const heightProperty = "--workspace-viewport-height";
class TestViewport extends EventTarget {
  height = 780;
  scale = 1;
}
let viewport: TestViewport;
let input: HTMLInputElement;
let coarsePointer = false;

beforeEach(() => {
  viewport = new TestViewport();
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 780 });
  coarsePointer = false;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: jest.fn((query: string) => ({ matches: query === "(any-pointer: coarse)" && coarsePointer })),
  });
  input = document.createElement("input");
  document.body.append(input);
});

afterEach(() => {
  input.remove();
  document.documentElement.style.removeProperty(heightProperty);
  Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 768 });
});

function resize(height: number, scale = 1) {
  act(() => {
    viewport.height = height;
    viewport.scale = scale;
    viewport.dispatchEvent(new Event("resize"));
  });
}

it("shrinks only for observed mobile keyboard occlusion and restores on viewport recovery", () => {
  const { result } = renderHook(useWorkspaceViewport);
  act(() => input.focus());
  expect(result.current.keyboardOpen).toBe(false);
  resize(430);
  expect(result.current.keyboardOpen).toBe(true);
  expect(document.documentElement.style.getPropertyValue(heightProperty)).toBe("430px");
  resize(410);
  expect(document.documentElement.style.getPropertyValue(heightProperty)).toBe("410px");
  resize(780);
  expect(result.current.keyboardOpen).toBe(false);
  expect(document.documentElement.style.getPropertyValue(heightProperty)).toBe("");
});

it("does not mistake browser bars, pinch zoom, or an unfocused viewport for a keyboard", () => {
  const { result } = renderHook(useWorkspaceViewport);
  resize(430);
  expect(result.current.keyboardOpen).toBe(false);
  resize(780);
  act(() => input.focus());
  resize(650);
  expect(result.current.keyboardOpen).toBe(false);
  resize(430);
  expect(result.current.keyboardOpen).toBe(true);
  resize(390, 2);
  expect(result.current.keyboardOpen).toBe(false);
  expect(document.documentElement.style.getPropertyValue(heightProperty)).toBe("");
});

it.each([820, 1024])("supports a coarse pointer at %ipx while retaining focus and zoom checks", (width) => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  coarsePointer = true;
  const { result } = renderHook(useWorkspaceViewport);
  resize(430);
  expect(result.current.keyboardOpen).toBe(false);
  act(() => input.focus());
  expect(result.current.keyboardOpen).toBe(true);
  expect(window.matchMedia).toHaveBeenCalledWith("(any-pointer: coarse)");
  expect(document.documentElement.style.getPropertyValue(heightProperty)).toBe("430px");
  resize(390, 2);
  expect(result.current.keyboardOpen).toBe(false);
  expect(document.documentElement.style.getPropertyValue(heightProperty)).toBe("");
  resize(430);
  expect(result.current.keyboardOpen).toBe(true);
  act(() => input.blur());
  expect(result.current.keyboardOpen).toBe(false);
});

it("ignores a wide fine-pointer viewport even with editor focus and substantial occlusion", () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  const { result } = renderHook(useWorkspaceViewport);
  act(() => input.focus());
  resize(430);
  expect(window.matchMedia).toHaveBeenCalledWith("(any-pointer: coarse)");
  expect(result.current.keyboardOpen).toBe(false);
  expect(document.documentElement.style.getPropertyValue(heightProperty)).toBe("");
});

it("clears active keyboard sizing when focus leaves the editor or the layout becomes desktop", () => {
  const { result } = renderHook(useWorkspaceViewport);
  act(() => input.focus());
  resize(430);
  act(() => input.blur());
  expect(result.current.keyboardOpen).toBe(false);
  expect(document.documentElement.style.getPropertyValue(heightProperty)).toBe("");
  act(() => input.focus());
  expect(result.current.keyboardOpen).toBe(true);
  act(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    window.dispatchEvent(new Event("resize"));
  });
  expect(result.current.keyboardOpen).toBe(false);
  expect(document.documentElement.style.getPropertyValue(heightProperty)).toBe("");
});

it("keeps the unobscured baseline when the browser also resizes its layout for the keyboard", () => {
  const { result } = renderHook(useWorkspaceViewport);
  act(() => input.focus());
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 430 });
  resize(430);
  expect(result.current.keyboardOpen).toBe(true);
  expect(document.documentElement.style.getPropertyValue(heightProperty)).toBe("430px");
});

it.each(["iframe", "contenteditable"])("supports %s focus without reading a guest document", (kind) => {
  const editor = document.createElement(kind === "iframe" ? "iframe" : "div");
  editor.tabIndex = 0;
  if (kind === "contenteditable") editor.setAttribute("contenteditable", "true");
  document.body.append(editor);
  try {
    const { result, unmount } = renderHook(useWorkspaceViewport);
    act(() => editor.focus());
    resize(430);
    expect(result.current.keyboardOpen).toBe(true);
    unmount();
  } finally { editor.remove(); }
});

it("does not activate for readonly fields or non-text input controls", () => {
  const { result } = renderHook(useWorkspaceViewport);
  input.readOnly = true;
  act(() => input.focus());
  resize(430);
  expect(result.current.keyboardOpen).toBe(false);
  input.readOnly = false;
  input.type = "checkbox";
  resize(420);
  expect(result.current.keyboardOpen).toBe(false);
});

it("removes every listener and restores any prior CSS value on unmount", () => {
  document.documentElement.style.setProperty(heightProperty, "700px", "important");
  const addViewport = jest.spyOn(viewport, "addEventListener");
  const removeViewport = jest.spyOn(viewport, "removeEventListener");
  const addWindow = jest.spyOn(window, "addEventListener");
  const removeWindow = jest.spyOn(window, "removeEventListener");
  const addDocument = jest.spyOn(document, "addEventListener");
  const removeDocument = jest.spyOn(document, "removeEventListener");
  try {
    const { unmount } = renderHook(useWorkspaceViewport);
    act(() => input.focus());
    resize(430);
    unmount();
    expect(document.documentElement.style.getPropertyValue(heightProperty)).toBe("700px");
    expect(document.documentElement.style.getPropertyPriority(heightProperty)).toBe("important");
    for (const type of ["resize", "scroll"]) {
      expect(removeViewport).toHaveBeenCalledWith(type, addViewport.mock.calls.find(call => call[0] === type)![1]);
    }
    expect(removeWindow).toHaveBeenCalledWith("resize", addWindow.mock.calls.find(call => call[0] === "resize")![1]);
    for (const type of ["focusin", "focusout"]) {
      expect(removeDocument).toHaveBeenCalledWith(type, addDocument.mock.calls.find(call => call[0] === type)![1]);
    }
    resize(400);
    expect(document.documentElement.style.getPropertyValue(heightProperty)).toBe("700px");
  } finally { jest.restoreAllMocks(); }
});

it("keeps the ordinary viewport fallback when VisualViewport is unavailable", () => {
  Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined });
  const { result } = renderHook(useWorkspaceViewport);
  act(() => input.focus());
  expect(result.current.keyboardOpen).toBe(false);
  expect(document.documentElement.style.getPropertyValue(heightProperty)).toBe("");
});
