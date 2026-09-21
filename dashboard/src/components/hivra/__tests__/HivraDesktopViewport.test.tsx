/** @jest-environment jsdom */

import { act, render, screen } from "@testing-library/react";

import { HivraDesktopViewport } from "../HivraDesktopViewport";

describe("HivraDesktopViewport", () => {
  const originalResizeObserver = globalThis.ResizeObserver;
  let width = 904;
  let height = 432;
  let changed: ResizeObserverCallback;
  const disconnect = jest.fn();

  beforeEach(() => {
    width = 904;
    height = 432;
    disconnect.mockClear();
    jest.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
    jest.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => height);
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) { changed = callback; }
      observe() {}
      unobserve() {}
      disconnect = disconnect;
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
    globalThis.ResizeObserver = originalResizeObserver;
  });

  function resize(nextWidth: number, nextHeight: number) {
    width = nextWidth;
    height = nextHeight;
    act(() => changed([], {} as ResizeObserver));
  }

  it("fits a usable logical desktop into a short viewport without changing its aspect ratio", () => {
    render(<HivraDesktopViewport fit><iframe title="Desktop" /></HivraDesktopViewport>);
    const frame = screen.getByTitle("Desktop");
    const canvas = frame.parentElement!;
    expect(canvas.style.transform).toBe("scale(0.675)");
    expect(canvas.style.width).toBe("1024px");
    expect(canvas.style.height).toBe("640px");
    expect(canvas.style.left).toBe("calc(50% - 345.6px)");
    expect(canvas.style.top).toBe("calc(50% - 216px)");
    expect(canvas.style.transformOrigin).toBe("top left");
    expect(height / 0.675).toBe(640);
  });

  it("resizes in both directions and retains the exact iframe browsing context", () => {
    const rendered = render(<HivraDesktopViewport fit><iframe title="Desktop" /></HivraDesktopViewport>);
    const frame = screen.getByTitle("Desktop") as HTMLIFrameElement;
    const contentWindow = frame.contentWindow;
    const canvas = frame.parentElement!;
    resize(1512, 820);
    expect(canvas.style.transform).toBe("none");
    expect(canvas.style.width).toBe("1512px");
    resize(904, 432);
    expect(canvas.style.transform).toBe("scale(0.675)");
    resize(0, 0); // Switching to Files must not shrink the retained desktop to zero.
    expect(canvas.style.transform).toBe("scale(0.675)");
    resize(768, 800);
    expect(canvas.style.transform).toBe("scale(0.75)");
    expect(screen.getByTitle("Desktop")).toBe(frame);
    expect(frame.contentWindow).toBe(contentWindow);
    rendered.unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("bounds both logical axes while a resizing window is briefly very thin", () => {
    render(<HivraDesktopViewport fit><iframe title="Desktop" /></HivraDesktopViewport>);
    const canvas = screen.getByTitle("Desktop").parentElement!;
    resize(1512, 1);
    expect(canvas.style.width).toBe("1512px");
    expect(canvas.style.height).toBe("640px");
    resize(1, 432);
    expect(canvas.style.width).toBe("1024px");
    expect(canvas.style.height).toBe("640px");
    resize(904, 32);
    expect(canvas.style.width).toBe("1024px");
    expect(canvas.style.height).toBe("640px");
    expect(canvas.style.transform).toBe("scale(0.05)");
  });

  it("offers exact size without replacing the iframe and refits when enabled again", () => {
    const rendered = render(<HivraDesktopViewport fit><iframe title="Desktop" /></HivraDesktopViewport>);
    const frame = screen.getByTitle("Desktop") as HTMLIFrameElement;
    const contentWindow = frame.contentWindow;
    rendered.rerender(<HivraDesktopViewport fit={false}><iframe title="Desktop" /></HivraDesktopViewport>);
    expect(frame.parentElement!.style.transform).toBe("none");
    expect(frame.parentElement!.style.height).toBe("100%");
    rendered.rerender(<HivraDesktopViewport fit><iframe title="Desktop" /></HivraDesktopViewport>);
    expect(frame.parentElement!.style.transform).toBe("scale(0.675)");
    expect(screen.getByTitle("Desktop")).toBe(frame);
    expect(frame.contentWindow).toBe(contentWindow);
  });

  it("uses the selected quality pixel budget at the panel aspect without letterboxing or replacing the iframe", () => {
    const rendered = render(
      <HivraDesktopViewport fit targetWidth={3840} targetHeight={2160}><iframe title="Desktop" /></HivraDesktopViewport>,
    );
    const frame = screen.getByTitle("Desktop") as HTMLIFrameElement;
    const contentWindow = frame.contentWindow;
    const canvas = frame.parentElement!;
    const logicalWidth = Number.parseFloat(canvas.style.width);
    const logicalHeight = Number.parseFloat(canvas.style.height);
    const scale = Number(canvas.style.transform.match(/scale\(([^)]+)\)/)![1]);
    expect(logicalWidth * logicalHeight).toBeCloseTo(3840 * 2160);
    expect(logicalWidth * scale).toBeCloseTo(width);
    expect(logicalHeight * scale).toBeCloseTo(height);

    rendered.rerender(
      <HivraDesktopViewport fit targetWidth={2560} targetHeight={1440}><iframe title="Desktop" /></HivraDesktopViewport>,
    );
    expect(Number.parseFloat(canvas.style.width) * Number.parseFloat(canvas.style.height)).toBeCloseTo(2560 * 1440);
    resize(768, 800);
    expect(Number.parseFloat(canvas.style.width) / Number.parseFloat(canvas.style.height)).toBeCloseTo(768 / 800);
    expect(Number.parseFloat(canvas.style.width) * Number.parseFloat(canvas.style.height)).toBeCloseTo(2560 * 1440);
    resize(1, 432);
    expect(canvas.style.width).toBe("2560px");
    expect(canvas.style.height).toBe("1440px");
    resize(0, 0);
    expect(canvas.style.width).toBe("2560px");
    expect(screen.getByTitle("Desktop")).toBe(frame);
    expect(frame.contentWindow).toBe(contentWindow);
  });
});
